# Nalu LTX-2.3 video server

Run **LTX-2.3** (Lightricks' open 22B audio+video model — the newest; there is no
"2.5") on **your own GPU box** and have n4lu.ai/n4lu.com use it for every video,
with synced audio. This folder is the glue: a thin server that wraps the official
[`Lightricks/LTX-2`](https://github.com/Lightricks/LTX-2) package and speaks the
exact HTTP contract `api/video.ts` already calls.

```
 browser (n4lu)  ──►  Vercel  api/video.ts  ──►  POST /video/generations  ──►  YOUR GPU BOX
                                   ▲                                              │ LTX-2.3 (warm)
                                   └──────────  { video.url }  ◄── /files/x.mp4 ──┘
```

`api/video.ts` already prefers the self-hosted box: set `NALU_VIDEO_BASE_URL` +
`NALU_VIDEO_API_KEY` in Vercel and it fully replaces the old (fal/free) paths.

---

## 0. What you need

- **Linux + NVIDIA GPU, CUDA 13+.** (Won't run on Mac or on Vercel.)
- VRAM: **80GB+** (H100/H200) for full bf16; **~48GB** works with `LTX_QUANTIZATION=fp8-cast` (the default here). LoRA training wants **80GB+**.
- ~150GB disk for the weights.
- `git`, `curl`. (`uv` and `cloudflared` are auto-installed / optional.)

Copy this `ltx-server/` folder onto the GPU box (or `git clone` your repo there).

## 1. Install + download weights (one time)

```bash
cd ltx-server
bash setup.sh
```

This clones `Lightricks/LTX-2`, runs `uv sync`, installs the server deps into the
**same** venv, and downloads the exact weights:

| File | Role |
|---|---|
| `ltx-2.3-22b-dev.safetensors` | stage-1 checkpoint |
| `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` | stage-2 distilled LoRA |
| `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | spatial upscaler |
| `ltx-2.3-temporal-upscaler-x2-1.0.safetensors` | temporal upscaler |
| `google/gemma-3-12b-it-qat-q4_0-unquantized` → `weights/gemma/` | text encoder |

> Gemma is gated on HF — run `hf auth login` first if the download 401s.

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32     # paste into NALU_VIDEO_API_KEY in .env
```

Leave `PUBLIC_BASE_URL` blank to use a Cloudflare quick-tunnel (next step prints
the URL), or set it to your own HTTPS domain if the box is already public.

## 3. Run

```bash
bash run.sh
```

It loads the model **once** (keeps it warm), starts the API on `:8000`, and — if
`cloudflared` is installed and `PUBLIC_BASE_URL` is blank — opens a public HTTPS
tunnel and prints the URL. Smoke-test:

```bash
curl -s localhost:8000/health
curl -s -X POST localhost:8000/video/generations \
  -H "Authorization: Bearer $NALU_VIDEO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a wolf running through snow at dawn, cinematic"}' | jq
```

You should get back `{"video":{"url":"https://…/files/….mp4"}}` with audio.

> For a long-lived service install `cloudflared` as a named tunnel (stable
> hostname) or put the box behind your own reverse proxy, then set
> `PUBLIC_BASE_URL` to that domain and run `serve.py` under systemd/pm2.

## 4. Wire n4lu (Vercel)

From the `train` repo root, with the URL from step 3:

```bash
printf '%s' "https://<your-tunnel-or-domain>" | npx vercel@latest env add NALU_VIDEO_BASE_URL production
printf '%s' "<the NALU_VIDEO_API_KEY from .env>" | npx vercel@latest env add NALU_VIDEO_API_KEY production
printf '%s' "ltx-2.3"                            | npx vercel@latest env add NALU_VIDEO_MODEL production
./deploy.sh
```

Now any "make a video of …" prompt on n4lu routes to your LTX-2.3 box. (Tell me
the URL + key and I'll run these for you.)

---

## 5. Train a LoRA

The official package ships a full trainer (`packages/ltx-trainer`). The manual flow is:

```bash
cd LTX-2/packages/ltx-trainer

# a) Prepare a captioned dataset -> dataset/dataset.json
#    Columns by mode (T2V needs: video, caption; audio auto-extracted from video):
#      dataset/videos/1.mp4 + a caption per clip. Long clips: scripts/split_scenes.py first.
uv run python scripts/process_dataset.py   # see docs/

# b) Edit a config (start from configs/t2v_lora.yaml). For <80GB use:
#      configs/t2v_lora_low_vram.yaml   (INT8 + memory optimizations)

# c) Train
uv run python scripts/train.py configs/t2v_lora.yaml
#   multi-GPU:
#   CUDA_VISIBLE_DEVICES=0,1 uv run accelerate launch \
#     --config_file configs/accelerate/ddp.yaml scripts/train.py configs/t2v_lora.yaml
```

Checkpoints land at `checkpoints/lora_weights_step_NNNNN.safetensors`.

**Use your trained LoRA in the server** — point `.env` at it and restart:

```bash
LTX_USER_LORA=/abs/path/to/checkpoints/lora_weights_step_01000.safetensors:1.0
```

`serve.py` passes it through as `--lora <path> <strength>`, so every generation
from n4lu uses your fine-tune.

---

## Files in this folder

| File | What it is |
|---|---|
| `serve.py` | FastAPI server; loads LTX-2.3 once, serves `/video/generations` + `/files`. Wiring mirrors `ltx_pipelines.ti2vid_two_stages.main()`. |
| `setup.sh` | Clone + `uv sync` + download weights. |
| `run.sh` | Load env, open tunnel, launch server. |
| `.env.example` | All knobs (auth, public URL, resolution, fp8, custom LoRA). |

## Notes / gotchas

- `num_frames` must be **8k+1** (97, 105, 113, 121…); the server snaps to the nearest.
- `fp8-cast` roughly halves VRAM with a small quality cost — drop it (empty
  `LTX_QUANTIZATION`) on an 80GB+ card for max fidelity.
- One GPU = one generation at a time (the server serializes requests).
- `serve.py` imports `ltx_pipelines`/`ltx_core`, so it must run with the LTX-2
  venv python (`run.sh` uses `LTX-2/.venv/bin/python`).
