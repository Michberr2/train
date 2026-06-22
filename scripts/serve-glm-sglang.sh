#!/usr/bin/env bash
# serve-glm-sglang.sh — Serve full GLM-5.2 (large MoE) on SGLang, OpenAI-compatible.
#
# Target: single 8x H200 (1,128 GB) node, FP8 weights (~830 GB) + TP=8 (+ optional EP).
# SGLang is often first to land correct GLM MoE support and its RadixAttention
# prefix cache helps Nalu (every request reuses a system prompt).
#
# IMPORTANT (sizing): the 8x-H200-fits-FP8 conclusion assumes ~753B total params.
# «VERIFY the real total» — GLM-4.5/4.6 were ~355B; if >~800B, FP8 may not fit one node.
#
# n4lu.ai is on Vercel (cloud) and CANNOT reach localhost. After this is up,
# expose it with scripts/tunnel-cloudflared.sh and point NALU_GENERAL_* at the
# public https url. naludesktop can hit http://localhost:PORT/v1 directly. ALSO
# raise the Vercel function maxDuration (vercel.json) or long SSE replies
# truncate — see docs/self-host-glm-5.2.md §4.0.
#
# «VERIFY» before running: HF repo id / FP8 checkpoint, min SGLang version (the
# pip floor is almost certainly too OLD — prefer git main until a release lands
# the arch), exact EP / attention-backend flag names, chat template, native max
# context. RUN `python -m sglang.launch_server --help` ON YOUR BUILD FIRST — flag
# names below are version-sensitive (e.g. --ep-size, --attention-backend).
set -euo pipefail

# ----------------------------------------------------------------------------
# Config (override via environment)
# ----------------------------------------------------------------------------
MODEL_PATH="${MODEL_PATH:-/data/models/GLM-5.2-FP8}"   # local dir or HF repo id «VERIFY»
SERVED_NAME="${SERVED_NAME:-glm-5.2}"                  # must == Vercel NALU_GENERAL_MODEL
TP_SIZE="${TP_SIZE:-8}"                                # tensor-parallel = GPUs per node
CONTEXT_LENGTH="${CONTEXT_LENGTH:-131072}"            # «VERIFY native max»; lower if KV OOMs
MEM_FRACTION_STATIC="${MEM_FRACTION_STATIC:-0.90}"     # drop to 0.85 if OOM at graph capture
CHUNKED_PREFILL_SIZE="${CHUNKED_PREFILL_SIZE:-8192}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-30000}"
# Expert parallelism. Current SGLang uses --ep-size <N> (the old --enable-ep-moe
# boolean was removed/renamed). NOT additive: on a single 8-GPU node EP re-shards
# experts across the SAME 8 GPUs. EP_SIZE empty => omit the flag (TP-only).
# Bring up TP-only first; then set EP_SIZE=8 once you've confirmed the flag via --help.
EP_SIZE="${EP_SIZE:-}"                                 # e.g. 8 ; «VERIFY exact flag for your build»
# Attention backend. There is NO --enable-flashinfer boolean. FlashInfer is
# selected via --attention-backend flashinfer and is usually already the Hopper
# default, so this can be left empty (omit the flag). «VERIFY for your build».
ATTENTION_BACKEND="${ATTENTION_BACKEND:-}"             # e.g. flashinfer ; empty => use default
# Quantization: empty => auto-detect FP8 from the checkpoint config (recommended
# for a native FP8 build). Set 'fp8' ONLY to runtime-quantize a BF16 ckpt (loads
# BF16 first → needs the 16-GPU footprint).
QUANTIZATION="${QUANTIZATION:-}"
# Multi-node (16-GPU TP across 2 nodes):
NNODES="${NNODES:-1}"
NODE_RANK="${NODE_RANK:-0}"
DIST_INIT_ADDR="${DIST_INIT_ADDR:-}"                  # e.g. 10.0.0.1:5000 on the head node

if [[ -z "${NALU_GENERAL_API_KEY:-}" ]]; then
  echo "ERROR: NALU_GENERAL_API_KEY is not set. Run: export NALU_GENERAL_API_KEY=\"\$(openssl rand -hex 32)\"" >&2
  exit 1
fi

# ----------------------------------------------------------------------------
echo ">> SGLang serving GLM-5.2"
echo "   model        : ${MODEL_PATH}"
echo "   served name  : ${SERVED_NAME}"
echo "   parallelism  : TP=${TP_SIZE}$( [[ -n "${EP_SIZE}" ]] && echo " EP=${EP_SIZE}" )  nnodes=${NNODES} rank=${NODE_RANK}"
echo "   quantization : ${QUANTIZATION:-<auto-detect from checkpoint>}"
echo "   attn backend : ${ATTENTION_BACKEND:-<engine default>}"
echo "   listen       : http://${HOST}:${PORT}/v1"

ARGS=(
  --model-path "${MODEL_PATH}"
  --served-model-name "${SERVED_NAME}"
  --tp-size "${TP_SIZE}"
  --tokenizer-mode auto
  --trust-remote-code            # GLM ships a custom chat template / tokenizer
  --context-length "${CONTEXT_LENGTH}"
  --mem-fraction-static "${MEM_FRACTION_STATIC}"
  --chunked-prefill-size "${CHUNKED_PREFILL_SIZE}"
  --host "${HOST}" --port "${PORT}"
  --api-key "${NALU_GENERAL_API_KEY}"
  --log-level info
)

# Expert parallelism — only if explicitly set. «VERIFY exact flag for your SGLang version».
[[ -n "${EP_SIZE}" ]] && ARGS+=( --ep-size "${EP_SIZE}" )
# Attention backend — only if explicitly set (default is usually fine/FlashInfer on Hopper).
[[ -n "${ATTENTION_BACKEND}" ]] && ARGS+=( --attention-backend "${ATTENTION_BACKEND}" )
# Quantization — only if explicitly set (native FP8 → auto-detect, no flag).
[[ -n "${QUANTIZATION}" ]] && ARGS+=( --quantization "${QUANTIZATION}" )

# Multi-node TP (e.g. 16 GPUs = 2 nodes): set NNODES=2, DIST_INIT_ADDR=<head:port>,
# and run with NODE_RANK=0 on the head and NODE_RANK=1 on the worker.
if [[ "${NNODES}" -gt 1 ]]; then
  [[ -z "${DIST_INIT_ADDR}" ]] && { echo "ERROR: NNODES>1 requires DIST_INIT_ADDR (e.g. 10.0.0.1:5000)" >&2; exit 1; }
  ARGS+=( --nnodes "${NNODES}" --node-rank "${NODE_RANK}" --dist-init-addr "${DIST_INIT_ADDR}" )
fi

# Optional chat-template override — only if turns/tool-calls render wrong. «VERIFY».
[[ -n "${CHAT_TEMPLATE:-}" ]] && ARGS+=( --chat-template "${CHAT_TEMPLATE}" )

exec python -m sglang.launch_server "${ARGS[@]}"
