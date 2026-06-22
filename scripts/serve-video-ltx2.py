#!/usr/bin/env python3
# serve-video-ltx2.py — OpenAI-style video endpoint for LTX-2 (open, Apache-2.0,
# native synchronized AUDIO+video). Self-host on a GPU; NO third-party API key.
#
# LTX-2.3 is a ~22B audio-video DiT (github.com/Lightricks/LTX-2,
# HF: Lightricks/LTX-2.3). Use the DISTILLED checkpoint for speed/lower VRAM;
# `fp8-cast` quantization cuts memory. Recommended ~32 GB+ VRAM (24 GB is tight
# with fp8 + distilled). It can ride the SAME GPU box as GLM-5.2 / Z-Image.
#
# Serves exactly what Nalu's api/video.ts (self-hosted path) expects:
#   POST /v1/video/generations  {"prompt": "...", "num_frames": 121, ...}
#   -> {"url": "<PUBLIC_BASE>/files/<id>.mp4"}   (an mp4 WITH audio)
#
# --- Install ---------------------------------------------------------------
#   git clone https://github.com/Lightricks/LTX-2.git && cd LTX-2
#   uv sync --frozen && source .venv/bin/activate
#   pip install fastapi "uvicorn[standard]"
#   huggingface-cli download Lightricks/LTX-2.3 --local-dir /data/ltx2
#     # «VERIFY the exact file names in the model card before setting the env below»
#
# --- Configure (env) -------------------------------------------------------
#   export NALU_VIDEO_API_KEY="$(openssl rand -hex 32)"  # bearer (match Vercel)
#   export PUBLIC_BASE="https://video.n4lu.ai"           # your tunnel hostname
#   export LTX_CHECKPOINT=/data/ltx2/ltx-2.3-22b-distilled-1.1.safetensors
#   export LTX_DISTILLED_LORA=/data/ltx2/<distilled_lora>.safetensors   # «VERIFY»
#   export LTX_UPSAMPLER=/data/ltx2/<spatial_upsampler>.safetensors     # «VERIFY»
#   export LTX_GEMMA_ROOT=/data/ltx2/gemma                              # «VERIFY»
#   python scripts/serve-video-ltx2.py                   # listens on :8900
#
# --- Wire into Nalu --------------------------------------------------------
#   Tunnel localhost:8900 (scripts/tunnel-cloudflared.sh), then on Vercel:
#     NALU_VIDEO_BASE_URL=https://video.n4lu.ai/v1
#     NALU_VIDEO_API_KEY=<the bearer above>
#   ./deploy.sh   (api/video.ts POSTs <base>/video/generations and reads {url})
#
# Uses the repo's documented CLI (python -m ltx_pipelines.ti2vid_two_stages),
# the stable interface — no guessing the Python pipeline constructor.

import os
import subprocess
import uuid

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

API_KEY = os.environ.get("NALU_VIDEO_API_KEY", "")
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "http://localhost:8900").rstrip("/")
OUT_DIR = os.environ.get("LTX_OUT_DIR", "/data/ltx2-out")
PORT = int(os.environ.get("PORT", "8900"))

CKPT = os.environ.get("LTX_CHECKPOINT", "")
LORA = os.environ.get("LTX_DISTILLED_LORA", "")
LORA_W = os.environ.get("LTX_DISTILLED_LORA_WEIGHT", "0.8")
UPSAMPLER = os.environ.get("LTX_UPSAMPLER", "")
GEMMA = os.environ.get("LTX_GEMMA_ROOT", "")
QUANT = os.environ.get("LTX_QUANTIZATION", "fp8-cast")

os.makedirs(OUT_DIR, exist_ok=True)
app = FastAPI()
app.mount("/files", StaticFiles(directory=OUT_DIR), name="files")


class VideoReq(BaseModel):
    prompt: str
    model: str | None = None
    height: int | None = 512
    width: int | None = 768
    num_frames: int | None = 121  # ~5s @ 25fps; keep short — render time scales with this
    frame_rate: float | None = 25.0


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/video/generations")
def generate(req: VideoReq, authorization: str = Header(default="")):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="bad api key")
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt required")
    if not CKPT:
        raise HTTPException(status_code=500, detail="LTX_CHECKPOINT not set")

    vid = uuid.uuid4().hex
    out_path = os.path.join(OUT_DIR, f"{vid}.mp4")
    cmd = [
        "python", "-m", "ltx_pipelines.ti2vid_two_stages",
        "--quantization", QUANT,
        "--checkpoint-path", CKPT,
        "--prompt", req.prompt,
        "--height", str(req.height),
        "--width", str(req.width),
        "--num-frames", str(req.num_frames),
        "--frame-rate", str(req.frame_rate),
        "--output-path", out_path,
    ]
    if LORA:
        cmd += ["--distilled-lora", LORA, LORA_W]
    if UPSAMPLER:
        cmd += ["--spatial-upsampler-path", UPSAMPLER]
    if GEMMA:
        cmd += ["--gemma-root", GEMMA]

    env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out_path):
        raise HTTPException(status_code=502, detail=f"ltx-2 failed: {proc.stderr[-400:]}")
    return {"url": f"{PUBLIC_BASE}/files/{vid}.mp4"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
