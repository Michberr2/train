#!/usr/bin/env python3
# serve-image-zimage.py — OpenAI-compatible image endpoint for Z-Image-Turbo.
#
# Z-Image-Turbo: Apache-2.0, ~6B, fits ~16 GB VRAM, ~9 steps, sub-second on
# H-class GPUs. #1 open-source text-to-image model (Artificial Analysis, 2026).
# Runs on a single consumer GPU — or one spare GPU of your GLM-5.2 box for ~free.
#
# Serves the exact shape Nalu's api/image.ts expects:
#   POST /v1/images/generations  {"model": "...", "prompt": "...", "size": "1024x1024", "n": 1}
#   -> {"data": [{"b64_json": "<base64 png>"}]}
#
# --- Install ---------------------------------------------------------------
#   python -m venv ~/zimg && source ~/zimg/bin/activate
#   pip install -U "fastapi" "uvicorn[standard]" torch pillow accelerate
#   pip install -U "git+https://github.com/huggingface/diffusers"   # ZImagePipeline
#
# --- Run -------------------------------------------------------------------
#   export NALU_IMAGE_API_KEY="$(openssl rand -hex 32)"   # bearer (match Vercel)
#   python scripts/serve-image-zimage.py                  # listens on :8800
#
# --- Wire into Nalu --------------------------------------------------------
#   Expose with the same Cloudflare tunnel pattern as GLM (scripts/tunnel-cloudflared.sh
#   pointed at localhost:8800), then set on Vercel (production) and ./deploy.sh:
#     NALU_IMAGE_BASE_URL=https://<your-tunnel>/v1
#     NALU_IMAGE_API_KEY=<the bearer above>
#     NALU_IMAGE_MODEL=z-image-turbo
#   The naludesktop app can use http://localhost:8800/v1 directly (no tunnel).

import base64
import io
import os

import torch
import uvicorn
from diffusers import ZImagePipeline
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("ZIMAGE_MODEL_ID", "Tongyi-MAI/Z-Image-Turbo")
API_KEY = os.environ.get("NALU_IMAGE_API_KEY", "")
STEPS = int(os.environ.get("ZIMAGE_STEPS", "9"))      # Turbo: ~9 (8 DiT passes)
PORT = int(os.environ.get("PORT", "8800"))
DEVICE = os.environ.get("ZIMAGE_DEVICE", "cuda")

print(f">> loading {MODEL_ID} (bf16) on {DEVICE} ...")
pipe = ZImagePipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
pipe.to(DEVICE)
print(">> ready")

app = FastAPI()


class ImageReq(BaseModel):
    prompt: str
    model: str | None = None
    size: str | None = "1024x1024"
    n: int | None = 1


def parse_size(s: str | None) -> tuple[int, int]:
    try:
        w, h = (s or "1024x1024").lower().split("x")
        return int(w), int(h)
    except Exception:
        return 1024, 1024


@app.get("/v1/models")
def models():
    return {"data": [{"id": "z-image-turbo", "object": "model"}]}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/images/generations")
def generate(req: ImageReq, authorization: str = Header(default="")):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="bad api key")
    if not req.prompt or not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt required")
    width, height = parse_size(req.size)
    count = max(1, min(req.n or 1, 4))
    data = []
    for i in range(count):
        image = pipe(
            prompt=req.prompt,
            height=height,
            width=width,
            num_inference_steps=STEPS,
            guidance_scale=0.0,  # required for Turbo
            generator=torch.Generator(DEVICE).manual_seed(1234 + i),
        ).images[0]
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        data.append({"b64_json": base64.b64encode(buf.getvalue()).decode("ascii")})
    return {"data": data}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
