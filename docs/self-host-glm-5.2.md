# Self-Hosting Full GLM-5.2 Locally and Wiring It to "Nalu General"

## ✅ Confirmed specs (verified June 2026 — supersedes the «VERIFY» assumptions below)

From Z.ai's official vLLM recipe + the Hugging Face model card:

- **Model:** GLM-5.2 — **~743B total / ~39B active** MoE (`glm_moe_dsa` = MoE + DeepSeek-style sparse attention + IndexShare). **MIT** license. Released June 13, 2026.
- **Weights:** official FP8 build **`zai-org/GLM-5.2-FP8`** (~743 GB) and BF16 **`zai-org/GLM-5.2`**. No self-quantizing needed.
- **Hardware:** **8×H200 (or 8×H20), FP8, TP=8** is Z.ai's *stated standard single-node deployment* ✅ — exactly this plan. The full **1M-token** context (1,048,576) needs **8×B200**; on 8×H200 cap context to ~128–256K.
- **Engine:** **vLLM 0.23.0** (stable). Official command:
  ```bash
  vllm serve zai-org/GLM-5.2-FP8 \
    --kv-cache-dtype fp8_e4m3 \
    --tensor-parallel-size 8 \
    --speculative-config.method mtp \
    --speculative-config.num_speculative_tokens 5 \
    --tool-call-parser glm47 \
    --reasoning-parser glm45 \
    --enable-auto-tool-choice \
    --served-model-name glm-5.2-fp8
  ```
- **Reasoning leak — SOLVED:** `--reasoning-parser glm45` makes vLLM put the chain-of-thought in a separate `reasoning_content` field, so the `content` Nalu shows stays clean. **No `gated` code change needed.** Thinking is on by default (Max effort); disable per request with `enable_thinking: false`, or set `reasoning_effort: "high"` for balanced mode.
- **`NALU_GENERAL_MODEL`** = `glm-5.2-fp8` (must equal a `--served-model-name`).

`scripts/serve-glm-vllm.sh` now defaults to all of the above. The detailed sections below keep their general reasoning; where a «VERIFY» note conflicts with this block, **this block wins**.

---

> **Goal:** Run the full, open-weights **GLM-5.2** (a large MoE; total parameter count **«VERIFY: GLM-5.2 total parameter count — ~753B assumed below; GLM-4.5/4.6 were ~355B total, so 753B is an unconfirmed assumption that drives every VRAM number»**, license **«VERIFY: MIT assumed per GLM-4.5/4.6»**, from Z.ai/Zhipu, org **«VERIFY: likely `zai-org`»**) on your own GPUs and make it the brain behind Nalu's **general** route (`Nalu Catalina`, `kind: general` in `api/chat.ts`).
>
> **The one constraint that shapes everything:** `n4lu.ai` runs on **Vercel (cloud)**. A GPU box at `localhost` is **not reachable** from Vercel's serverless functions. The web app therefore requires a **public HTTPS endpoint + bearer token** (Cloudflare Tunnel recommended). The local `naludesktop` app *can* hit `localhost` directly.
>
> **Two things that silently break a working stack** even when the tunnel and GPU box are fine: (1) the **Vercel function timeout** — `api/chat.ts` streams SSE for the *entire* generation, so a short `maxDuration` truncates long replies (see §4.0); (2) the **Cloudflare edge read-timeout** (~100s on free plans) cutting a slow stream. Both must exceed total generation time.
>
> Values that are GLM-5.2-specific and must be confirmed are marked **«VERIFY»** throughout and collected at the end. The single most load-bearing unverified value is the **total parameter count** — if it exceeds ~800B, the "FP8 fits one 8×H200 node" conclusion can flip (see §1.3).

---

## 0. TL;DR decision tree

1. **Just validating?** Point `NALU_GENERAL_*` at **Z.ai's hosted API** (zero capex), redeploy, ship. Self-host later.
2. **Need to self-host?** Target **8× H200 (1 node, 1,128 GB) running FP8** — the full model, all experts, near-lossless, single box, *if the confirmed total param count is ≲800B*. **Rent before you own.**
3. **Serving engine:** Start with **SGLang** (typically earliest correct GLM MoE support + RadixAttention prefix caching, which Nalu benefits from since every request reuses a system prompt). Keep **vLLM** as the battle-tested fallback. Benchmark both on your prompt mix.
4. **Expose** the `/v1` endpoint via **Cloudflare Tunnel** with a bearer key, **raise the Vercel `maxDuration`** (§4.0), set 3 Vercel env vars, run `./deploy.sh`.

---

## 1. Hardware sizing — the VRAM math drives everything

The dominant cost is just **holding the parameters resident**. For an MoE, what matters is **total** params (all experts must be in VRAM), *not* active params. The smaller active-param count «VERIFY: GLM-5.2 active count — GLM-4.5/4.6 were ~32B active» only affects compute/throughput per token.

> **All numbers below assume ~753B total params. This is «VERIFY» (GLM-4.5/4.6 were ~355B). Re-run the math against the confirmed figure before buying/renting — a ~15% miss (e.g. 850B) can flip the single-node-FP8 conclusion.**

### 1.1 Weight memory floor

| Precision | Bytes/param | Raw weights (~753B «VERIFY») | + ~10–20% runtime overhead* |
|-----------|-------------|---------------------|------------------------------|
| **BF16/FP16** | 2.0 | 753B × 2 = **1,506 GB** | **~1,650–1,800 GB** |
| **FP8** (E4M3) | 1.0 | 753B × 1 = **753 GB** | **~830–950 GB** |
| **INT4 / FP4** (lossy) | 0.5 | 753B × 0.5 = **377 GB** | **~415–520 GB** |

\* Overhead = CUDA context, activation buffers, NCCL comm buffers, fragmentation, CUDA graphs, and the non-quantized parts (embeddings, LM head, layernorms; FP8 builds typically keep router/attention in BF16). Planning numbers, not exact.

### 1.2 GPUs just for weights

Budget ~5–6 GB/GPU for CUDA context + activations (so ~74 GB usable on an 80 GB card, ~134 GB on an H200):

| GPU | VRAM | BF16 (~1,506 GB) | FP8 (~753 GB) |
|-----|------|------------------|----------------|
| **H100 80GB** | 80 | ⌈1506/74⌉ = **21** → 3 nodes (24) | ⌈753/74⌉ = **11** → 2 nodes (16) |
| **H200 141GB** | 141 | ⌈1506/134⌉ = **12** → 2 nodes (16) | ⌈753/134⌉ = **6** → **fits in 1 node (8)** |
| **B200 ~180GB** | ~180 | ⌈1506/172⌉ = **9** → 2 nodes | ⌈753/172⌉ = **5** → 1 node |

Round up to full nodes / powers of 2 (TP degree must divide attention heads; you also need KV headroom). Realistic floors:
- **BF16:** 16× H200 (2 nodes) or 24× H100 (3 nodes).
- **FP8:** **8× H200 (1 node)** or 16× H100 (2 nodes).

### 1.3 The single-node question: 8×H200 = 1,128 GB

This is the deciding number — **and it depends entirely on the «VERIFY» total param count**:

- **FP8 weights ~830 GB** on **1,128 GB** → **~298 GB left** (minus ~40 GB for 8 CUDA contexts → **~258 GB for KV**). **Comfortably fits — at ~753B.** ✅
- **BF16 weights ~1,650 GB** > **1,128 GB** → **does not fit**; need 16× H200 (2,256 GB). ❌
- **⚠️ Sensitivity:** at ~753B total, FP8 leaves comfortable headroom. **If the confirmed total exceeds ~800B, FP8 weights + overhead climb toward/past ~950 GB–1 TB and the single-8×H200-node margin shrinks or disappears** — re-run §1.1/§1.3 against the verified number before committing hardware.

So: **FP8 is a single-node (8×H200) deployment; BF16 forces two nodes — assuming ~753B.** That single fact is the biggest driver of cost and operational complexity — single-node avoids slow inter-node interconnect entirely.

> **8× H100 (80GB = 640 GB)**: FP8 weights (~753 GB) **do NOT fit**. On 8×H100 you must run **INT4** (fits with KV room) or go **2-node (16×H100)** for FP8. **8× H100 NVL (94GB = 752 GB)** ≈ FP8 weights with **no** KV room — not viable single-node.

### 1.4 KV-cache memory vs context and concurrency

KV cache is allocated **per token, per concurrent sequence**, and scales with the attention config, not total params. GLM uses **GQA** «VERIFY», so `num_kv_heads` is small, keeping KV modest relative to the giant weights.

```
kv_bytes/token = 2 (K and V) × num_layers × num_kv_heads × head_dim × bytes_per_elem
```

«VERIFY: GLM-5.2 `num_layers`, `num_kv_heads`, `head_dim`, and max context length — the 0.35 MB/token midpoint below is an estimate built on assumed values.»

Worked brackets (FP16 KV):
- **Modest** (~80 layers, 8 KV heads, head_dim 128): `2 × 80 × 8 × 128 × 2 = 327,680 B ≈ 0.31 MB/token`
- **Larger** (~96 layers, 8 KV heads, head_dim 128): `2 × 96 × 8 × 128 × 2 = 393,216 B ≈ 0.375 MB/token`

Using **0.35 MB/token** as a planning midpoint:

| Scenario | Tokens | KV memory |
|----------|--------|-----------|
| 1 seq × 8K ctx | 8,192 | ~2.8 GB |
| 1 seq × 128K ctx | 131,072 | ~46 GB |
| 32 seqs × 8K | 262,144 | ~92 GB |
| 64 seqs × 8K | 524,288 | ~184 GB |
| 16 seqs × 32K | 524,288 | ~184 GB |
| 64 seqs × 32K | 2,097,152 | **~735 GB** (won't fit 1 node) |
| 16 seqs × 128K | 2,097,152 | **~735 GB** (won't fit 1 node) |

Takeaways:
- On the **8×H200 FP8** node with ~258 GB for KV: **~64 concurrent sessions only at ~8K average context**. At the configured **32K** max, that same budget supports roughly **~16 concurrent sessions** — concurrency and per-session context trade off directly. vLLM **pages KV and preempts/queues** rather than OOMing at startup, so over-setting `--max-num-seqs` won't crash on boot; it just means the advertised concurrency only holds at short context. Size `--max-num-seqs` × `--max-model-len` to the budget you actually have.
- **FP8 KV cache** (`--kv-cache-dtype fp8` in vLLM) **halves** these numbers → doubles effective concurrency/context, at a small accuracy cost. **Opt-in, not default** — see §3.2 (E4M3 FP8 KV generally wants kv-scale calibration or `--calculate-kv-scales`, and should be accuracy-tested before use on a flagship route).
- **Long context is the KV killer**: one 128K session ≈ 46 GB. Cap `--max-model-len` / `--context-length` to what you actually need.

### 1.5 Why FP8 is the practical "full model"

- **FP8 (E4M3) is near-lossless** for large MoE models — all params, all experts, just in 8-bit, with sensitive parts (router, embeddings, layernorms, often attention) kept in BF16. This is **not** lossy 4-bit compression; degradation is typically within benchmark noise.
- **FP8 needs Hopper/Blackwell** (H100/H200/B200) hardware FP8 tensor cores. On H200 it turns a 2-node job into a **1-node** job — the biggest operational win.
- **BF16** is the bit-exact reference — use only for eval/research or exact-numerics needs. Costs 2× the GPUs, forces multi-node.
- **INT4/FP4** (377 GB, fits 4×H200) is real quantization with measurable loss on hard reasoning/code/math — a cheap *fallback*, **not** the flagship brain.

«VERIFY: whether Z.ai ships an **official FP8 checkpoint** for GLM-5.2 (GLM-4.5/4.6 shipped official `...-FP8` builds under `zai-org`). If yes, prefer it over self-quantizing. Native FP8 builds are typically `compressed-tensors`/`llm-compressor`-tagged and auto-detected by the engine — do **not** force a `--quantization fp8` flag over them (see §3.2).»

### 1.6 MoE parallelism: TP vs EP vs PP

- **Tensor Parallel (TP):** splits every weight matrix across GPUs; all GPUs work on every token. All-reduce every layer → needs **NVLink/NVSwitch within a node**. Keep **TP ≤ 8** (one box). TP degree must divide attention head count.
- **Expert Parallel (EP):** distributes the MoE **experts** across GPUs; tokens are routed (all-to-all) to the GPU holding their expert. Natural fit for MoE.
  - **Critical clarification — EP does NOT add GPUs or multiply the parallel degree.** On a single 8-GPU node the **world size is 8**. Enabling EP **re-shards the experts** as expert-parallel across those *same* 8 GPUs (EP=8 by default), while attention/dense layers stay tensor-parallel (TP=8). So "TP=8 + EP" is **a choice of how to shard the experts on a fixed 8-GPU world** (expert-sharded vs tensor-sharded), **not** TP=8 *plus* 8 more GPUs. Whether EP beats pure-TP for this specific MoE is **workload-dependent — benchmark it**; EP is not unconditionally better.
  - vLLM: `--enable-expert-parallel`. SGLang: `--ep-size <N>` «VERIFY exact flag for your build».
- **Pipeline Parallel (PP):** splits by **layers** across nodes; only point-to-point activations cross the boundary, so it **tolerates slower inter-node links**. Use **PP across nodes**, TP/EP within each node.

**Rule of thumb:** TP (+ optionally EP) inside a node (over NVLink); PP across nodes (over InfiniBand/RoCE). **Do not run EP across a slow inter-node boundary** — its all-to-all expert routing over a slow link is a throughput trap (see §3.3). Single-node FP8 avoids PP entirely.

### 1.7 Recommended configs

| Goal | Precision | Hardware | Parallelism | KV headroom | Notes |
|------|-----------|----------|-------------|-------------|-------|
| **Recommended — Nalu General** | **FP8** | **8× H200 (1 node, 1,128 GB)** | TP=8 (experts EP-sharded on the same 8 GPUs, optional) | ~258 GB → ~64×8K *or* ~16×32K sessions | Single box, NVLink only, near-lossless. Best $/perf. Assumes ~753B «VERIFY». |
| Single-node alt | FP8 | 16× H100 (2 nodes) | TP=8 × PP=2 | similar | If no H200; crosses nodes via PP (keep EP within-node). |
| Max concurrency / long ctx | FP8 + FP8 KV (opt-in) | 8× H200 | TP=8, FP8 KV (accuracy-test first) | ~2× effective | Doubles sessions or context; needs kv-scale calibration. |
| No-compromise / eval | BF16 | 16× H200 (2 nodes) | TP=8 × PP=2 (EP within-node only) | ~500–530 GB | Bit-exact; 2× cost. |
| BF16 on H100 | BF16 | 24× H100 (3 nodes) | TP=8 × PP=3 | tight | Most expensive; avoid. |
| Cheap fallback (not flagship) | INT4/FP4 | 4× H200 | TP=4 | large | Measurable quality loss. |

---

## 2. Hardware procurement — own vs rent vs API

### 2.1 Own an 8×H200 node

- **What you buy:** an HGX H200 server — 8 SXM GPUs on a baseboard with NVLink/NVSwitch (required for fast TP=8; PCIe-only boxes are much slower).
- **Capex (mid-2026, rough):** a complete OEM HGX H200 system (GPUs + dual CPUs + ~2 TB RAM + NVMe + NICs + chassis) realistically **~$250k–$400k** all-in. «VERIFY live pricing».
- **Power/facilities:** each H200 SXM ~700 W → 8 GPUs ≈ **5.6 kW**; a loaded node draws **~8–10 kW** at the wall. Needs **dual 208–240 V high-amp circuits** (not a 120 V/15 A office circuit), serious cooling (real server room / colo), redundant PSUs. At 10 kW continuous and ~$0.15/kWh → **~$1,080/mo** power (~$1,800/mo at $0.25/kWh). **Colo** a single node commonly **~$1.5k–$3k/mo**.
- **Realities:** multi-month lead times, depreciation as Blackwell ships, full ops burden. Pencils out only at **sustained 24/7 utilization**.

### 2.2 Rent by the hour

Indicative on-demand ranges (mid-2026; reserved/committed is cheaper; **«VERIFY live $/hr»**):

| Provider | 8×H200 ($/hr) | 8×H100 ($/hr) | Notes |
|----------|---------------|---------------|-------|
| **Vast.ai** | ~$15–$25 | ~$10–$18 | Cheapest marketplace; vet host, SXM-vs-PCIe varies |
| **Runpod** | ~$25–$32 | ~$18–$28 | Easy DX, Secure vs Community tiers |
| **Lambda** | ~$25–$30 | ~$20–$28 | Clean instances, solid for serving |
| **CoreWeave** | ~$30–$40 | ~$25–$35 | Enterprise/k8s, reserved-oriented |

**Always-on monthly (730 hrs)** — the number that matters for a website backend:

| Rate | Monthly (24/7) |
|------|----------------|
| $15/hr | **~$11,000/mo** |
| $25/hr | **~$18,000/mo** |
| $32/hr | **~$23,000/mo** |
| $40/hr | **~$29,000/mo** |

A public site's "General brain" must be reachable 24/7 → budget always-on, not spot. Spot saves ~50–70% but a node that vanishes mid-request is a poor user-facing fit without failover.

> **Networking gotcha (applies to rented cloud GPUs too):** a Runpod/Lambda box is *not* automatically reachable from your Vercel functions. You still expose `/v1` over **public HTTPS + bearer** (§4) and set the env vars. `localhost` only works for `naludesktop`.

### 2.3 vs. just using Z.ai's API

| | Self-host (own/rent) | Z.ai API |
|---|---|---|
| Fixed monthly | $11k–$29k/mo always-on (rent), or $250k+ capex + ~$1–3k/mo ops (own) | **$0 idle**, pay per token |
| Ops burden | You own serving/scaling/uptime/upgrades/quant | None |
| Availability | Always-warm if always-on; autoscale on you | Managed |
| Data/privacy/control | Full — weights on your hardware | Data leaves to Z.ai |
| Customization/fine-tune | Full | Provider-bounded |

**Break-even:** Z.ai's API is **dramatically cheaper** than $11k–29k/mo until you push very high sustained token volume. Self-host earlier for **data control, privacy, no provider dependency, and customization** — not raw cost. «VERIFY: Z.ai `/v1` base URL, model id string, key provisioning.»

**Pragmatic path:** **API now → rent 8×H200 FP8 when you genuinely need self-host → own only at proven steady 24/7 scale.**

---

## 3. Serving GLM-5.2 — vLLM and SGLang recipes

Both serve an **OpenAI-compatible** API (`/v1/chat/completions`, `/v1/models`), enforce a bearer with `--api-key`, and accept `--served-model-name`. Use the ready-made scripts in `scripts/` (covered in §6); the inline commands below are the canonical reference.

> **Before launching: read `--help` on your pinned build.** The exact EP / attention-backend flag names below are version-sensitive and several have been renamed across releases. Confirm with `vllm serve --help` and `python -m sglang.launch_server --help` on the build you actually install.

### 3.0 Download the weights first

```bash
export HF_TOKEN=hf_xxx                  # needed if the repo is gated
export HF_HOME=/data/hf                 # big, fast NVMe — need ~800 GB (FP8) to ~1.5 TB (BF16) free
pip install -U "huggingface_hub[cli]"

# «VERIFY: exact repo id. org, repo name, AND the "-FP8" suffix are all UNCONFIRMED
#  placeholders. Likely org "zai-org" (per GLM-4.5/4.6). Confirm whether an OFFICIAL
#  FP8 build exists before relying on this command — it may 404.»
hf download zai-org/GLM-5.2-FP8 \
  --local-dir /data/models/GLM-5.2-FP8 \
  --exclude "*.pth" "original/*"
```

- FP8 ≈ **~750 GB**; BF16 ≈ **~1.5 TB**. Use a wired link; the CLI resumes on failure.
- If no official FP8 exists: download BF16 (`zai-org/GLM-5.2` «VERIFY») and either (a) run BF16 on 16 GPUs, or (b) quantize **offline** with `llm-compressor` to FP8, then serve the resulting FP8 checkpoint on 8. **Online `--quantization fp8` of a BF16 checkpoint still loads the full BF16 weights first**, so it does *not* save you the 16-GPU memory at load time — you need a **pre-quantized** FP8 checkpoint to fit on 8 GPUs.

### 3.1 vLLM — install

```bash
python -m venv ~/vllm-env && source ~/vllm-env/bin/activate
pip install -U pip
# «VERIFY: install the FIRST vLLM release whose changelog lists GLM-5.2 support.
#  The floor below is a PLACEHOLDER and is almost certainly TOO OLD for a 2026
#  753B MoE arch — you likely need a much newer release or git main.»
pip install -U "vllm"                   # consider: pip install "vllm @ git+https://github.com/vllm-project/vllm.git"
# «VERIFY: min transformers that contains the GLM-5.2 architecture — 4.46 is stale.»
pip install -U "transformers"
pip install -U "huggingface_hub[cli]"
```

Docker alternative (pins CUDA/NCCL):
```bash
docker run --gpus all -it --rm --ipc=host --shm-size=16g -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface -e HF_TOKEN=$HF_TOKEN \
  vllm/vllm-openai:latest  # «VERIFY tag supports GLM-5.2»; then pass the `vllm serve` args below
```
`--ipc=host` / `--shm-size` are required — NCCL TP needs large shared memory or you get hangs.

### 3.2 vLLM — launch (8× GPU, FP8, single node)

For a **native FP8 checkpoint** (the recommended `GLM-5.2-FP8` target), **do NOT pass `--quantization`** — vLLM auto-detects the quant method from the checkpoint's `config.json`/`quantization_config` (typically `compressed-tensors`). Forcing `--quantization fp8` over a `compressed-tensors`-tagged checkpoint can **conflict and fail to load**.

```bash
vllm serve /data/models/GLM-5.2-FP8 \
  --served-model-name glm-5.2 nalu-general \
  --tensor-parallel-size 8 \
  --enable-expert-parallel \           # OPTIONAL: re-shards experts as EP across the SAME 8 GPUs.
  `# Not additive — world size stays 8. Benchmark EP vs pure-TP; «VERIFY EP support for GLM-5.2 in your vLLM».` \
  --max-model-len 32768 \              # raise only as far as KV budget allows; «VERIFY native max»
  --gpu-memory-utilization 0.92 \      # lower to 0.85 if OOM at startup
  --trust-remote-code \                # GLM ships custom modeling/tokenizer
  --enable-chunked-prefill \
  --max-num-seqs 32 \                  # 64 only safe at ~8K avg ctx; ~16 at 32K max. vLLM pages/queues, won't OOM.
  --host 0.0.0.0 --port 8000 \
  --api-key "$NALU_GENERAL_API_KEY"
  # NOTE: no --quantization for a native FP8 checkpoint (auto-detected).
  # NOTE: --kv-cache-dtype is intentionally OMITTED (defaults to auto/off). See FP8-KV note below.
```

Key points:
- `--served-model-name glm-5.2 nalu-general` — the first is canonical; both are valid `model` strings. Set `NALU_GENERAL_MODEL` to one of these.
- **Quantization flag rule (authoritative):** **native FP8 checkpoint → no `--quantization` flag** (auto-detect). **Only** pass `--quantization fp8` when you are *runtime-quantizing a BF16 checkpoint* — and that path **loads full BF16 first, so it needs 16 GPUs at load time, not 8**. Do not pass `--quantization fp8` on the 8×H200 single-node FP8 target.
- **FP8 KV cache is opt-in, not default.** `--kv-cache-dtype fp8` halves KV but E4M3 FP8 KV generally wants kv-scale calibration (a checkpoint with kv scales, or `--calculate-kv-scales` on builds that support it) or it falls back to a default scale with measurable accuracy loss. **Don't enable it on a flagship route until you've accuracy-tested.** Add it (with calibration) only when you specifically need the extra concurrency/context.
- `--max-model-len` × `--max-num-seqs` sets the KV ceiling. Start 32k / 32 seqs; vLLM pages KV and **preempts/queues** rather than OOMing, but advertised concurrency only holds at short context. Never exceed the model's trained length. «VERIFY native max ctx (GLM-4.6 was 200k-class).»
- Override the chat template only if turns/tool-calls render wrong: `--chat-template /path/template.jinja`, `--enable-auto-tool-choice --tool-call-parser ...`, `--reasoning-parser ...`. «VERIFY GLM-5.2 template + parser names; GLM has historically used `[gMASK]<sop>` + `<|user|>/<|assistant|>` turn tokens — unconfirmed for 5.2; the template almost always ships in the repo.»

### 3.3 vLLM — BF16 multi-node with Ray (only if you skip FP8)

~1.5 TB needs **16× 80 GB = two 8-GPU nodes**, parallelized with **Ray**. KV headroom: 2,256 GB − ~1,650 GB BF16 weights − ~80 GB (16 CUDA contexts) ≈ **~500–530 GB**.

```bash
# Head node:
ray start --head --port=6379      # note head IP, e.g. 10.0.0.1
# Worker node:
ray start --address=10.0.0.1:6379 # confirm `ray status` shows 16 GPUs
```
```bash
# From the head node:
vllm serve /data/models/GLM-5.2 \
  --served-model-name glm-5.2 nalu-general \
  --tensor-parallel-size 8 --pipeline-parallel-size 2 \
  --dtype bfloat16 \
  --max-model-len 32768 --gpu-memory-utilization 0.92 \
  --distributed-executor-backend ray --trust-remote-code \
  --host 0.0.0.0 --port 8000 --api-key "$NALU_GENERAL_API_KEY"
  # NOTE: --enable-expert-parallel is intentionally OMITTED here.
  # EP's all-to-all expert routing across the slow PP node boundary is a throughput trap;
  # keep the cross-node boundary PP (point-to-point) only. EP, if used, stays within a node.
```
TP=8 within each node; PP=2 across the two nodes; total = 16 GPUs. Both nodes need **identical** vLLM/CUDA/NCCL, the model at the same path (or shared storage), and a **fast interconnect** (InfiniBand/100GbE — NCCL over slow ethernet crawls). **Prefer the FP8 single-node path** unless you specifically need BF16 fidelity.

### 3.4 SGLang — install

```bash
python -m venv ~/sglang-venv && source ~/sglang-venv/bin/activate
pip install --upgrade pip
# «VERIFY: first SGLang release whose changelog lists GLM-5.2. The version is a
#  PLACEHOLDER and is almost certainly TOO OLD — prefer git main until a release lands it.»
pip install "sglang[all]"
# If a release doesn't recognize GLM-5.2 yet:
# pip install "sglang[all] @ git+https://github.com/sgl-project/sglang.git"
# FlashInfer (Hopper throughput; usually already the default attention backend on recent builds):
pip install flashinfer -i https://flashinfer.ai/whl/cu124/torch2.5/   # «VERIFY index/torch/cuda tags for your build»
```

### 3.5 SGLang — launch (8-GPU TP, FP8)

```bash
python -m sglang.launch_server \
  --model-path /data/models/GLM-5.2-FP8 \
  --served-model-name nalu-general \
  --tp-size 8 \
  --ep-size 8 \                        # expert-parallel degree (= TP for single node). «VERIFY exact flag for your build».
  --tokenizer-mode auto \
  --trust-remote-code \
  --context-length 131072 \            # «VERIFY native max; lower if KV OOMs»
  --mem-fraction-static 0.90 \         # drop to 0.85 if OOM during CUDA-graph capture
  --chunked-prefill-size 8192 \
  --attention-backend flashinfer \     # «VERIFY»: usually the Hopper default; may be omitted entirely
  --host 0.0.0.0 --port 30000 \
  --api-key "$NALU_GENERAL_API_KEY" \
  --log-level info
  # NOTE: no --quantization for a native FP8 checkpoint (auto-detected from config).
```
- **Flag names are version-sensitive — run `python -m sglang.launch_server --help` on your pinned build first.** Expert parallelism is `--ep-size <N>` in current SGLang; the older `--enable-ep-moe` boolean was removed/renamed in the EP rework. There is **no `--enable-flashinfer` boolean** — FlashInfer is selected via `--attention-backend flashinfer`, and it is typically already the Hopper default, so the flag can often be **omitted**. **During bring-up, drop both `--ep-size` and `--attention-backend` first** (get a baseline TP-only launch working), then add them back once you've confirmed the flag names — an unknown argument aborts startup.
- FP8 is **auto-detected from an FP8 checkpoint's config** — no quant flag needed. For runtime FP8 from a BF16 checkpoint add `--quantization fp8` (loads BF16 first → needs the 16-GPU footprint; some loss vs a native FP8 build).
- Routes at `/v1/chat/completions`, `/v1/completions`, `/v1/models`; health at `/health`.
- Multi-node fallback (16-GPU TP across 2 nodes): node 0 with `--tp-size 16 --nnodes 2 --node-rank 0 --dist-init-addr 10.0.0.1:5000`, node 1 same with `--node-rank 1`. Needs InfiniBand/RoCE or token latency is poor.

### 3.6 vLLM vs SGLang — which to pick

| Dimension | SGLang | vLLM |
|---|---|---|
| GLM MoE support | Often **first/fastest** to land GLM with correct templates + EP | Solid; new GLM variants sometimes land a bit later |
| MoE / expert parallelism | Mature EP (`--ep-size`), DP-attention | Good EP too (`--enable-expert-parallel`); both fine at TP=8 |
| High-concurrency throughput | **RadixAttention** prefix cache shines when every call reuses a system prompt (Nalu does) | Excellent raw throughput; very mature batching |
| Ops maturity | Very good, moves fast on bleeding-edge | **Most battle-tested**, predictable |

**Recommendation: start with SGLang** (earliest correct GLM templates → lower «VERIFY» risk; RadixAttention directly benefits Nalu's repeated system prompt; strong EP for a large MoE). **Keep vLLM as the conservative fallback.** Same env wiring + tunnel work for both. Benchmark both (and EP-vs-pure-TP) on your real prompt mix before committing.

### 3.7 Smoke test (either engine — adjust port)

```bash
# Replace PORT: vLLM=8000, SGLang=30000
curl http://localhost:PORT/v1/models -H "Authorization: Bearer $NALU_GENERAL_API_KEY"

curl http://localhost:PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NALU_GENERAL_API_KEY" \
  -d '{"model":"nalu-general",
       "messages":[{"role":"system","content":"You are Nalu Catalina."},
                   {"role":"user","content":"In one sentence, what are you?"}],
       "max_tokens":128,"temperature":0.7}'
```
`401` = bad key. `404`/"model not found" = `model` field ≠ a `--served-model-name` alias.

---

## 4. Networking — expose the local server to Vercel

### 4.0 FIRST: raise the Vercel function timeout (or long replies get truncated)

`api/chat.ts` streams SSE for the **entire generation** (the loop holds the function open until upstream ends, and the general route requests up to `max_tokens: 8192`, hardcoded). A self-hosted 753B MoE has slow TTFT (cold experts, long prefill) and can take **30–120s+** to finish. **If the Vercel function times out first, the reply is cut off mid-stream even though the tunnel and GPU box are perfectly healthy.**

This repo has **no `vercel.json` `maxDuration`** today, so the function uses the plan default: **Hobby ≈ 10s (cannot stream long replies at all), Pro default 60s, max 300s with Fluid Compute.** Add an explicit timeout:

`vercel.json` (create or extend — keep any existing keys):
```json
{
  "functions": {
    "api/chat.ts": { "maxDuration": 300 }
  }
}
```
- `maxDuration: 300` requires **Pro + Fluid Compute**. **Hobby cannot stream long generations** — upgrade or keep total generation well under the plan cap.
- **`maxDuration` changes only take effect on a redeploy** (covered by `./deploy.sh` in §5.4).
- If you can't raise it enough, **lower the general route's `max_tokens`** (the hardcoded 8192 in `api/chat.ts`) so generation finishes inside the window.

### 4.1 The core constraint

`api/chat.ts` runs as a **Vercel serverless function**. The general route does (line 372):
```
fetch(`${NALU_GENERAL_BASE_URL}/chat/completions`, { headers: { Authorization: `Bearer ${NALU_GENERAL_API_KEY}` }, ... })
```
That fetch originates from **Vercel's network**. `http://localhost:8000` or any `192.168.x.x` / `10.x.x.x` LAN address is **unreachable**. You must give the server a **public HTTPS URL**. Two non-negotiables:
1. **TLS** — Vercel calls `https://...`.
2. **Auth** — a public URL is internet-reachable; without a bearer, anyone who finds it burns your GPUs. Use `--api-key` and the same value in `NALU_GENERAL_API_KEY`.

Generate the secret once:
```bash
export NALU_GENERAL_API_KEY="$(openssl rand -hex 32)"   # 64 hex chars; save it
```

### 4.2 Primary: Cloudflare Tunnel (`cloudflared`)

No inbound ports opened, free auto-TLS, stable hostname. The tunnel makes an **outbound** connection from your box to Cloudflare's edge; Vercel hits the public hostname; Cloudflare relays down the tunnel to `localhost`. Your home IP is never exposed. **SSE streams proxy fine through cloudflared** — but see the read-timeout caveat at the end of this section.

**Install:** macOS `brew install cloudflared`; Linux:
```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

**Option A — Quick tunnel (testing only):**
```bash
cloudflared tunnel --url http://localhost:8000   # prints https://<random>.trycloudflare.com
```
Ephemeral hostname (rotates each restart, no SLA). Prove the path end-to-end, then move to a named tunnel — **do not** use the quick URL in production env.

**Option B — Named tunnel (stable, production):** requires a domain on Cloudflare (a subdomain of `n4lu.ai` works).
```bash
cloudflared tunnel login
cloudflared tunnel create nalu-glm
cloudflared tunnel route dns nalu-glm glm.n4lu.ai
```
`~/.cloudflared/config.yml`:
```yaml
tunnel: nalu-glm
credentials-file: /Users/michaelberryii/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: glm.n4lu.ai
    service: http://localhost:8000      # use 30000 for SGLang
    originRequest:
      connectTimeout: 30s
      # Raise the read/idle timeout so a slow stream isn't severed by the edge.
      # The ~100s default origin read-timeout on free plans can 524 a long generation.
  - service: http_status:404
```
Run it (and install as a service so it survives reboot):
```bash
cloudflared tunnel run nalu-glm
sudo cloudflared service install     # Linux: then `sudo systemctl enable --now cloudflared`
```
Stable base URL: `https://glm.n4lu.ai/v1`.

> **Cloudflare read-timeout (the other silent stream-killer):** free plans have a **~100s edge read-timeout**; a generation that runs longer can be cut with a **524** even though Vercel's `maxDuration` is fine. The stream survives **only if BOTH** the Vercel `maxDuration` (§4.0) **and** the Cloudflare read-timeout exceed total generation time. Mitigations: keep total generation under ~100s, lower the general route `max_tokens`, raise the origin timeout (Enterprise/config), or front with a proxy whose read-timeout you control (§4.4).

**Verify it's truly public** (run from your laptop, NOT the GPU box):
```bash
curl https://glm.n4lu.ai/v1/chat/completions \
  -H "Authorization: Bearer $NALU_GENERAL_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

**Optional hardening:** Cloudflare WAF rate-limit on `glm.n4lu.ai`. Note: `chat.ts` only sends the `Authorization` bearer (no slot for extra headers), so Cloudflare Access **service tokens would require a code change** — the `--api-key` bearer is sufficient and needs none.

### 4.3 Alternative 1 — ngrok

```bash
brew install ngrok
ngrok config add-authtoken <YOUR_NGROK_TOKEN>
ngrok http 8000                              # free: random URL, rotates on restart
ngrok http 8000 --domain=glm-nalu.ngrok.app  # paid: pinned domain
```
Use the printed `https://...` + `/v1`. The `--api-key` bearer does the auth; don't add ngrok `--basic-auth` (a different `Authorization` scheme that collides with the bearer).

### 4.4 Alternative 2 — self-managed reverse proxy (Caddy/nginx + TLS)

Most control, most moving parts; you open inbound 443 and expose your IP. Needs a public DNS A record + static/DDNS IP. **You control the read-timeout here** — useful if Cloudflare's ~100s edge timeout (§4.2) is severing long streams. **Caddy** `/etc/caddy/Caddyfile`:
```
glm.n4lu.ai {
    reverse_proxy 127.0.0.1:8000 {
        # generous timeouts so long SSE generations aren't cut
        transport http {
            read_timeout 600s
        }
        flush_interval -1   # flush SSE chunks immediately, no buffering
    }
}
```
```bash
sudo caddy run --config /etc/caddy/Caddyfile   # auto Let's Encrypt cert
```
Firewall: allow only 443 inbound; keep port 8000 bound to `127.0.0.1`. `--api-key` bearer remains the auth check. Fallback only — it exposes your IP, needs open ports, and you own cert renewal + DDoS exposure.

### 4.5 The split mental model

| Caller | Where it runs | How it reaches GLM-5.2 |
|---|---|---|
| **n4lu.ai web** (`api/chat.ts`) | Vercel cloud | **Must** use the public tunnel URL (`https://glm.n4lu.ai/v1`) — and Vercel `maxDuration` + CF read-timeout must exceed generation time |
| **naludesktop** | User's machine | Direct `http://localhost:8000/v1` — no tunnel, no timeouts |

One inference server can serve both: the tunnel feeds the cloud web app; the desktop app shortcuts to localhost. The same `--api-key` bearer protects both paths. (There is **no** `naludesktop`/`server/` directory in this repo — `/Users/michaelberryii/train` is the Vercel web app only; the desktop app lives in a separate project.)

---

## 5. Wiring into Nalu — point `Nalu Catalina` (general) at GLM-5.2

### 5.1 Naming reality check

In `api/chat.ts` (lines 132–137) the general/catch-all specialist is **`Nalu Catalina`** (`kind: 'general'`), not "Nalu General." Env keys are still `NALU_GENERAL_*` because they key off `spec.kind.toUpperCase()` → `GENERAL` (lines 148–151). Expect the **route name "Nalu Catalina"** when verifying.

### 5.2 The rule that bites people: model name must match

`NALU_GENERAL_MODEL` is sent verbatim as the OpenAI `model` field (line 365). vLLM/SGLang reject any `model` they aren't serving. So **`NALU_GENERAL_MODEL` must equal a `--served-model-name` exactly.** Pin a short name (`glm-5.2`) on the server, then — **after the server and tunnel are up** — confirm the literal id:
```bash
curl -s https://glm.n4lu.ai/v1/models -H "Authorization: Bearer $NALU_GENERAL_API_KEY" | python3 -m json.tool
# the "id" you see is what NALU_GENERAL_MODEL must equal.
```

### 5.3 Set the 3 Vercel env vars (production)

`BASE_URL` **must end at `/v1`** (line 149 strips a trailing slash; line 372 appends `/chat/completions`) and **must be the public tunnel host** (not localhost). **Always `rm` before `add`** — if the var already exists, `env add` can no-op/error and silently leave the old value (a real footgun since you are changing an existing `NALU_GENERAL_*` set). Run from the repo root (already `vercel link`ed — `.vercel/` exists):
```bash
cd /Users/michaelberryii/train

for VAR in NALU_GENERAL_BASE_URL NALU_GENERAL_API_KEY NALU_GENERAL_MODEL; do
  npx -y vercel@latest env rm "$VAR" production -y 2>/dev/null || true
done
printf 'https://glm.n4lu.ai/v1'     | npx -y vercel@latest env add NALU_GENERAL_BASE_URL production
printf '%s' "$NALU_GENERAL_API_KEY" | npx -y vercel@latest env add NALU_GENERAL_API_KEY  production
printf 'glm-5.2'                    | npx -y vercel@latest env add NALU_GENERAL_MODEL     production
```
(`printf | … env add` pipes the value on stdin so the CLI skips its interactive prompt and avoids a trailing newline. The `/v1/models` served-name check in §5.2 must run **after** the server/tunnel are up so `NALU_GENERAL_MODEL` is pinned to the literal returned id.)

### 5.4 Redeploy

Env **and `vercel.json` `maxDuration`** changes take effect only on a new deployment. The repo script deploys to prod and re-aliases both domains:
```bash
cd /Users/michaelberryii/train
./deploy.sh
# -> deployed: https://nalu-<hash>-...vercel.app
# -> live: https://n4lu.ai  https://n4lu.com
```

### 5.5 Verify the general route now answers via GLM-5.2

The endpoint streams SSE; the **first** event is `route` (line 359). Send a prompt with no code/finance/etc. keywords so it falls through to general:
```bash
curl -N https://n4lu.ai/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"In one sentence, who are you and what model family powers you?"}]}'
```
- `event: route` → `{"kind":"general","name":"Nalu Catalina"}` confirms the general route (not a domain specialist).
- A stream of `event: delta` chunks = upstream reachable. An immediate `event: error` with `Upstream 401` = bad `NALU_GENERAL_API_KEY`; `Upstream 404`/"model not found" = `NALU_GENERAL_MODEL` ≠ served name.
- **Reply cut off after a partial answer** (no error) = a timeout truncation — recheck `vercel.json` `maxDuration` (§4.0) and the Cloudflare read-timeout (§4.2).

Identity probes are unreliable; the definitive proof is your **GPU server's logs** showing a request arrive the moment you curl n4lu.ai. (Prior default was `deepseek-ai/DeepSeek-V3.1`, line 39 — if a reply still says "DeepSeek," the env didn't take effect; recheck *production* scope + redeploy.) «VERIFY GLM-5.2 self-identification — GLM models typically say "GLM, trained by Zhipu AI / Z.ai".»

### 5.6 Thinking / reasoning output note

`gated` (line 152) only fires for `/nemotron|gpt-oss/i`, so `glm-5.2` is **not** gated — no answer-extraction suppression of a reasoning preamble. The gated path uses `GATE_MARKERS` (line 215) that include both `</think>` **and** `assistantfinal`. The **always-on** cleaner (lines 232–258) strips **only literal `<think>…</think>` pairs**, regardless of gating. Consequence:
- If GLM-5.2 wraps reasoning in `<think>…</think>`, it's hidden **for free**.
- **If GLM-5.2 emits a reasoning preamble with ANY other delimiter** (e.g. a harmony-style `assistantfinal` marker, or a custom tag), it **leaks verbatim** into the user-visible answer, because the non-gated path strips only `<think>` pairs and the `assistantfinal`/`</think>` gating is off for `glm`. Fix by either: **(a)** add `glm` to the `gated` regex (line 152) so the `assistantfinal`/`</think>` gating applies, **or (b)** disable thinking server-side via the chat template / `--reasoning-parser`. «VERIFY which delimiter GLM-5.2 uses and which reasoning-parser it supports.»

### 5.7 naludesktop (localhost is fine)

The desktop app runs on your machine and can hit the server directly — **no tunnel, no Vercel/Cloudflare timeouts**. Same 3 vars, plain localhost (this lives in the separate naludesktop project's `server/.env`, not this repo):
```bash
NALU_GENERAL_BASE_URL=http://localhost:8000/v1   # 30000 for SGLang
NALU_GENERAL_API_KEY=<the server --api-key>      # must be non-empty (chat.ts bails on empty, line 325)
NALU_GENERAL_MODEL=glm-5.2
```

### 5.8 Bonus — make GLM-5.2 the brain for ALL specialists

`backendFor` falls back to **globals** when a per-kind override is absent: model resolves `NALU_<KIND>_MODEL` → `NALU_DEFAULT_MODEL` → built-in; base/key fall back to `GLM_BASE_URL` / `GLM_API_KEY` (lines 32–34, 149–151). Set the three globals and every **text** specialist (Code, Financial, Crypto, Reason, Catalina, …) routes to GLM-5.2.

Caveats:
- This also redirects **Nalu Vision** (line 129) → GLM-5.2. Vision **loses image understanding** unless GLM-5.2 is multimodal «VERIFY». If text-only, keep a per-kind `NALU_VISION_*` override on a vision model.
- **The built-in `Qwen/Qwen3.5-397B-A17B` (vision, line 41) and `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` (reason, line 40) are Tinker-catalog model id strings** — valid **only** while `NALU_VISION_*`/`NALU_REASONING_*` still point at Tinker (the built-in `DEFAULT_BASE`). If you repoint those routes to another endpoint, the `model` string **must equal that endpoint's `--served-model-name`**, not the Tinker id.
- **Nalu Reason** → GLM-5.2 is no longer auto-stripped (it was gated as Nemotron) unless GLM uses `<think>…</think>` (see §5.6).

```bash
cd /Users/michaelberryii/train
GLM_TUNNEL='https://glm.n4lu.ai/v1'; GLM_KEY="$NALU_GENERAL_API_KEY"; GLM_MODEL='glm-5.2'
for VAR in GLM_BASE_URL GLM_API_KEY NALU_DEFAULT_MODEL; do
  npx -y vercel@latest env rm "$VAR" production -y 2>/dev/null || true
done
printf '%s' "$GLM_TUNNEL" | npx -y vercel@latest env add GLM_BASE_URL       production
printf '%s' "$GLM_KEY"    | npx -y vercel@latest env add GLM_API_KEY        production
printf '%s' "$GLM_MODEL"  | npx -y vercel@latest env add NALU_DEFAULT_MODEL production
# Keep a real vision model for the image route (valid only while NALU_VISION_* points at Tinker):
# printf 'Qwen/Qwen3.5-397B-A17B' | npx -y vercel@latest env add NALU_VISION_MODEL production
./deploy.sh
```

---

## 6. Artifact files (in this repo)

| File | Purpose |
|------|---------|
| `scripts/serve-glm-vllm.sh` | Launch GLM-5.2 on vLLM (FP8 single-node + optional 16-GPU Ray multi-node), env-configurable |
| `scripts/serve-glm-sglang.sh` | Launch GLM-5.2 on SGLang (FP8 single-node + optional multi-node), env-configurable |
| `scripts/tunnel-cloudflared.sh` | Expose the local `/v1` over a Cloudflare Tunnel (quick or named) |
| `docs/self-host-glm-5.2.md` | This runbook |

All scripts use `set -euo pipefail`, configurable env vars at the top, inline comments, and **default to the safe single-node FP8 path: no forced `--quantization` (auto-detect), KV cache off (`auto`), EP/attention-backend flags gated behind env toggles so an unknown flag doesn't kill bring-up.** Source secrets from the environment (never hard-code the bearer). Make them executable: `chmod +x scripts/*.sh`.

---

## 7. Final checklist

- [ ] **Confirm GLM-5.2 total parameter count** (~753B *assumed*; GLM-4.5/4.6 were ~355B). **If >~800B, re-run §1.1/§1.3 — FP8 may no longer fit one 8×H200 node.** Confirm license (MIT assumed).
- [ ] Confirm GLM-5.2 HF repo id + whether an **official FP8** checkpoint exists (`zai-org/...`, `-FP8` suffix). The download command is a placeholder until confirmed.
- [ ] Confirm active params, native max context, RoPE config, `num_layers`/`num_kv_heads`/`head_dim`/GQA (recompute KV/token; 0.35 MB is an estimate).
- [ ] Confirm the **FIRST** vLLM/SGLang/transformers release whose changelog lists GLM-5.2 (the version floors are stale placeholders — likely need a much newer release or git main). Confirm exact EP flags (`--enable-expert-parallel` / `--ep-size`) and attention-backend flag (`--attention-backend flashinfer`) via `--help` on the pinned build.
- [ ] Confirm chat template / `--tool-call-parser` / `--reasoning-parser` quirks and the reasoning delimiter; decide how to handle the thinking preamble (§5.6 — leaks if not `<think>`).
- [ ] **Native FP8 checkpoint → NO `--quantization` flag** (auto-detect). `--quantization fp8` only for runtime-quantizing BF16, which needs 16 GPUs at load.
- [ ] **FP8 KV cache (`--kv-cache-dtype fp8`) stays OFF** until accuracy-tested (needs kv-scale calibration / `--calculate-kv-scales`).
- [ ] Set `--max-num-seqs` × `--max-model-len` to the KV budget: ~64 seqs only at ~8K ctx, ~16 at 32K. vLLM pages/queues, won't OOM at boot.
- [ ] Provision GPUs: **8× H200 FP8** (target, if ≲800B), validated by **renting** first. Verify SXM/NVLink, not PCIe.
- [ ] Download weights to fast NVMe (~800 GB FP8). Launch with `scripts/serve-glm-{vllm,sglang}.sh`; **bring up TP-only first**, then add EP/attention flags once confirmed; smoke-test `/v1/models` + a chat completion locally.
- [ ] `export NALU_GENERAL_API_KEY="$(openssl rand -hex 32)"`; pass it as `--api-key`.
- [ ] Expose via `scripts/tunnel-cloudflared.sh` (named tunnel for prod). Verify publicly from a different machine.
- [ ] **Add `vercel.json` `{"functions":{"api/chat.ts":{"maxDuration":300}}}` (needs Pro + Fluid Compute)** and confirm the Cloudflare edge read-timeout (~100s free) exceeds total generation time — else long replies truncate (§4.0/§4.2).
- [ ] **`rm` then `add`** Vercel `NALU_GENERAL_BASE_URL` (ends in `/v1`), `NALU_GENERAL_API_KEY`, `NALU_GENERAL_MODEL` (== served name) in **production**; run `./deploy.sh` (also applies `maxDuration`).
- [ ] Hit `https://n4lu.ai/api/chat`; confirm `event: route` = `{"kind":"general","name":"Nalu Catalina"}` and a full `delta` stream (not truncated); confirm the request lands in the GPU server logs.
- [ ] (Optional) Set `GLM_BASE_URL`/`GLM_API_KEY`/`NALU_DEFAULT_MODEL` globals to make GLM-5.2 the default for all text specialists; keep a `NALU_VISION_*` override (Tinker id valid only while that route points at Tinker) if GLM-5.2 isn't multimodal.

**Bottom line:** *Assuming the «VERIFY» ~753B total holds*, FP8 at ~830 GB fits on **one 8×H200 node** with ~258 GB for KV — the sweet-spot "full model" deployment for the Nalu Catalina/General brain. If the confirmed count exceeds ~800B, recheck single-node fit. BF16 (~1,650 GB) doubles you to 2 nodes (~500–530 GB KV). Avoid 4-bit for the flagship. On the serving side: native FP8 → no quant flag, KV-fp8 off until tested, EP is a sharding *choice* on the same 8 GPUs (benchmark it), and confirm flag names via `--help`. On the wiring side: **raise the Vercel `maxDuration` and watch the Cloudflare read-timeout** or long replies truncate. Rent before you own; start on Z.ai's API while validating.