#!/usr/bin/env bash
# serve-glm-vllm.sh — Serve full GLM-5.2 on vLLM, OpenAI-compatible.
#
# CONFIRMED (June 2026, from Z.ai's official vLLM recipe + HF model card):
#   - GLM-5.2 = ~743B total / ~39B active MoE (glm_moe_dsa: MoE + sparse attention
#     + IndexShare), MIT license, native 1,048,576 (1M) token context.
#   - Official FP8 weights: zai-org/GLM-5.2-FP8 (BF16: zai-org/GLM-5.2).
#   - Standard single-node deployment: 8x H200 (or 8x H20), FP8, TP=8.
#     Full 1M context needs 8x B200; on 8x H200 cap context (128-256K).
#   - Required engine: vLLM 0.23.0 (stable).
#   - Reasoning is separated into `reasoning_content` by --reasoning-parser glm45,
#     so Nalu's visible answer (content) stays clean — no code change needed.
#
# Also supports a 16-GPU / 2-node BF16 path via Ray (set MODE=multinode).
#
# n4lu.ai is on Vercel (cloud) and CANNOT reach localhost. After this server is
# up, expose it with scripts/tunnel-cloudflared.sh and point NALU_GENERAL_* at
# the public https URL. The naludesktop app can hit http://localhost:PORT/v1.
# ALSO raise the Vercel function maxDuration (vercel.json) or long SSE replies
# truncate — see docs/self-host-glm-5.2.md §4.0.
#
# Install:  pip install -U "vllm==0.23.0"   (the glm_moe_dsa arch needs >= 0.23.0)
# Run `vllm serve --help` on your build to confirm flag names before launching.
set -euo pipefail

# ----------------------------------------------------------------------------
# Config (override via environment, e.g. `MAX_MODEL_LEN=262144 PORT=8001 ./serve-glm-vllm.sh`)
# ----------------------------------------------------------------------------
# Local checkpoint dir OR HF repo id (downloads on first run; ~743 GB FP8).
MODEL_PATH="${MODEL_PATH:-zai-org/GLM-5.2-FP8}"
# Model names clients may send. NALU_GENERAL_MODEL must == one of these.
SERVED_NAMES=(${SERVED_NAMES:-glm-5.2-fp8 glm-5.2 nalu-general})
TP_SIZE="${TP_SIZE:-8}"                          # tensor-parallel = GPUs in one node
# Native max is 1M (1048576) but full 1M KV needs 8x B200. On 8x H200, cap it.
MAX_MODEL_LEN="${MAX_MODEL_LEN:-131072}"         # 128K; raise toward 1M only on B200
MAX_NUM_SEQS="${MAX_NUM_SEQS:-32}"               # concurrency; vLLM pages/queues, won't OOM
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.92}"             # lower to 0.85 if OOM at startup
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
# Quantization: EMPTY — the native FP8 checkpoint is auto-detected; do NOT force a flag.
# Set QUANTIZATION=fp8 ONLY to runtime-quantize a BF16 checkpoint (loads full BF16
# first → needs the 16-GPU footprint, NOT 8). See docs §3.2.
QUANTIZATION="${QUANTIZATION:-}"
# FP8 KV cache: ON (fp8_e4m3) per Z.ai's official recipe — needed for the huge
# long-context KV. Set KV_CACHE_DTYPE=auto to disable.
KV_CACHE_DTYPE="${KV_CACHE_DTYPE:-fp8_e4m3}"
# Multi-Token Prediction speculative decoding (5 draft tokens) — official, boosts throughput.
ENABLE_MTP="${ENABLE_MTP:-1}"                    # 0 to disable
NUM_SPEC_TOKENS="${NUM_SPEC_TOKENS:-5}"
# Tool-call + reasoning parsers (confirmed names for GLM-5.2).
TOOL_CALL_PARSER="${TOOL_CALL_PARSER:-glm47}"
REASONING_PARSER="${REASONING_PARSER:-glm45}"
ENABLE_EP="${ENABLE_EP:-0}"                      # 1 = --enable-expert-parallel. NOT additive (re-shards
                                                # experts across the SAME 8 GPUs). Official recipe is TP-only.
MODE="${MODE:-single}"                           # single | multinode

# Auth: bearer required on every request. MUST match Vercel NALU_GENERAL_API_KEY.
# Generate once: export NALU_GENERAL_API_KEY="$(openssl rand -hex 32)"
if [[ -z "${NALU_GENERAL_API_KEY:-}" ]]; then
  echo "ERROR: NALU_GENERAL_API_KEY is not set. Run: export NALU_GENERAL_API_KEY=\"\$(openssl rand -hex 32)\"" >&2
  exit 1
fi

# Multi-node (BF16, 16 GPUs) only:
PP_SIZE="${PP_SIZE:-2}"                           # pipeline-parallel across nodes (TP*PP = total GPUs)
RAY_HEAD_ADDR="${RAY_HEAD_ADDR:-}"               # e.g. 10.0.0.1:6379 — start Ray yourself (see docs §3.3)

# ----------------------------------------------------------------------------
echo ">> vLLM serving GLM-5.2 (vLLM 0.23.0+)"
echo "   model        : ${MODEL_PATH}"
echo "   served names : ${SERVED_NAMES[*]}"
echo "   mode         : ${MODE}  (TP=${TP_SIZE}$( [[ "$MODE" == multinode ]] && echo " PP=${PP_SIZE}" ))"
echo "   kv-cache     : ${KV_CACHE_DTYPE}   max-len: ${MAX_MODEL_LEN}   MTP: ${ENABLE_MTP}"
echo "   listen       : http://${HOST}:${PORT}/v1"

ARGS=(
  "${MODEL_PATH}"
  --served-model-name "${SERVED_NAMES[@]}"
  --tensor-parallel-size "${TP_SIZE}"
  --max-model-len "${MAX_MODEL_LEN}"
  --max-num-seqs "${MAX_NUM_SEQS}"
  --gpu-memory-utilization "${GPU_MEM_UTIL}"
  --trust-remote-code              # GLM ships custom modeling/tokenizer
  --host "${HOST}" --port "${PORT}"
  --api-key "${NALU_GENERAL_API_KEY}"
)

# Reasoning parser → puts chain-of-thought in reasoning_content (keeps content clean).
[[ -n "${REASONING_PARSER}" ]] && ARGS+=( --reasoning-parser "${REASONING_PARSER}" )
# Tool calling.
[[ -n "${TOOL_CALL_PARSER}" ]] && ARGS+=( --enable-auto-tool-choice --tool-call-parser "${TOOL_CALL_PARSER}" )
# Multi-Token Prediction speculative decoding.
[[ "${ENABLE_MTP}" == "1" ]] && ARGS+=( --speculative-config.method mtp --speculative-config.num_speculative_tokens "${NUM_SPEC_TOKENS}" )
# Optional expert parallelism (off by default; official recipe is TP-only).
[[ "${ENABLE_EP}" == "1" ]] && ARGS+=( --enable-expert-parallel )
# Quantization: only append if explicitly set (native FP8 → auto-detect, no flag).
[[ -n "${QUANTIZATION}" ]] && ARGS+=( --quantization "${QUANTIZATION}" )
# KV cache dtype: append unless 'auto'.
[[ "${KV_CACHE_DTYPE}" != "auto" ]] && ARGS+=( --kv-cache-dtype "${KV_CACHE_DTYPE}" )
# Optional chat-template override (GLM-5.2's template ships in the repo; override only if needed).
[[ -n "${CHAT_TEMPLATE:-}" ]] && ARGS+=( --chat-template "${CHAT_TEMPLATE}" )

if [[ "${MODE}" != "single" ]]; then
  # BF16 16-GPU / 2-node path. Start Ray BEFORE running this (see docs §3.3):
  #   head:   ray start --head --port=6379
  #   worker: ray start --address=<head-ip>:6379
  # EP is intentionally NOT forced here — EP all-to-all across the slow PP node
  # boundary is a throughput trap. Keep the cross-node boundary PP only.
  if [[ -z "${RAY_HEAD_ADDR}" ]]; then
    echo "NOTE: MODE=multinode — ensure a Ray cluster with ${TP_SIZE}x${PP_SIZE} GPUs is up." >&2
  fi
  ARGS+=(
    --pipeline-parallel-size "${PP_SIZE}"
    --dtype bfloat16
    --distributed-executor-backend ray
  )
fi

exec vllm serve "${ARGS[@]}"
