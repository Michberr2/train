"""
Nalu LTX-2.3 video server.

A thin FastAPI wrapper around the official Lightricks/LTX-2 two-stage pipeline.
It loads the 22B model ONCE at startup and keeps it warm, then exposes the exact
HTTP contract that n4lu's `api/video.ts` already calls:

    POST /video/generations   { "model": "...", "prompt": "..." }  (Bearer auth)
      -> { "video": { "url": "https://<public>/files/<id>.mp4" }, ... }

It must run inside the LTX-2 repo's uv venv so `ltx_pipelines` / `ltx_core`
import. See ltx-server/README.md for the full runbook.

The pipeline wiring below mirrors `ltx_pipelines.ti2vid_two_stages.main()`
verbatim (same arg parser, same guider params), so it stays correct against the
pinned LTX-2 checkout — we only swap "parse argv + generate once" for "parse
argv once at boot, then generate per request".
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
import uuid
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
from ltx_pipelines.ti2vid_two_stages import TI2VidTwoStagesPipeline
from ltx_pipelines.utils.args import (
    default_2_stage_arg_parser,
    detect_checkpoint_path,
)
from ltx_pipelines.utils.constants import detect_params
from ltx_pipelines.utils.media_io import encode_video

try:  # MultiModalGuiderParams lives in ltx_core.components.guiders
    from ltx_core.components.guiders import MultiModalGuiderParams
except Exception:  # pragma: no cover - import path guard
    from ltx_pipelines.ti2vid_two_stages import MultiModalGuiderParams  # type: ignore

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("nalu-ltx")


# --------------------------------------------------------------------------- #
# Config (all paths come from the environment — see .env.example).
# --------------------------------------------------------------------------- #
def _env(name: str, default: str = "") -> str:
    v = os.environ.get(name, "")
    return v.strip() if v and v.strip() else default


WEIGHTS = Path(_env("LTX_WEIGHTS_DIR", "./weights")).expanduser()
API_KEY = _env("NALU_VIDEO_API_KEY")
PUBLIC_BASE_URL = _env("PUBLIC_BASE_URL").rstrip("/")  # the tunnel / public https URL
OUT_DIR = Path(_env("LTX_OUTPUT_DIR", "./outputs")).expanduser()
QUANT = _env("LTX_QUANTIZATION", "fp8-cast")  # "" for full bf16, "fp8-cast" for ~half VRAM
MODEL_NAME = _env("NALU_VIDEO_MODEL", "ltx-2.3")
# Optional custom-trained LoRA produced by ltx-trainer: "path[:strength]".
USER_LORA = _env("LTX_USER_LORA")

# Default generation knobs (overridable per request). 1280x704, 121 frames @25fps
# ≈ a ~5s 720p clip with synced audio. num-frames must be 8k+1.
DEF_HEIGHT = int(_env("LTX_HEIGHT", "704"))
DEF_WIDTH = int(_env("LTX_WIDTH", "1280"))
DEF_FRAMES = int(_env("LTX_NUM_FRAMES", "121"))
DEF_FPS = float(_env("LTX_FRAME_RATE", "25"))
DEF_STEPS = int(_env("LTX_STEPS", "0"))  # 0 → use the checkpoint's default


def _resolve(*candidates: str) -> str:
    """First existing path under WEIGHTS (accepts a few common filenames)."""
    for c in candidates:
        p = WEIGHTS / c
        if p.exists():
            return str(p)
    # Fall back to the first candidate so the error message is actionable.
    return str(WEIGHTS / candidates[0])


# Required model components downloaded by setup.sh (exact HF filenames per the
# LTX-2 README's "Model Weights Download" table).
CHECKPOINT = _env("LTX_CHECKPOINT") or _resolve(
    "ltx-2.3-22b-dev.safetensors", "ltx-2.3-22b-distilled-1.1.safetensors"
)
DISTILLED_LORA = _env("LTX_DISTILLED_LORA") or _resolve(
    "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
)
SPATIAL_UPSAMPLER = _env("LTX_SPATIAL_UPSAMPLER") or _resolve(
    "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
)
GEMMA_ROOT = _env("LTX_GEMMA_ROOT") or str(WEIGHTS / "gemma")


def _build_argv() -> list[str]:
    """Construct the argv the official parser expects (mirrors main())."""
    argv = [
        "--checkpoint-path", CHECKPOINT,
        "--distilled-lora", DISTILLED_LORA, "0.8",
        "--spatial-upsampler-path", SPATIAL_UPSAMPLER,
        "--gemma-root", GEMMA_ROOT,
        "--height", str(DEF_HEIGHT),
        "--width", str(DEF_WIDTH),
        "--num-frames", str(DEF_FRAMES),
        "--frame-rate", str(DEF_FPS),
        # Placeholders — overridden per request; required by the parser.
        "--prompt", "warmup",
        "--output-path", str(OUT_DIR / "_warmup.mp4"),
    ]
    if QUANT:
        argv += ["--quantization", QUANT]
    if DEF_STEPS > 0:
        argv += ["--num-inference-steps", str(DEF_STEPS)]
    if USER_LORA:
        path, _, strength = USER_LORA.partition(":")
        argv += ["--lora", path, strength or "1.0"]
    return argv


# --------------------------------------------------------------------------- #
# Load the model once.
# --------------------------------------------------------------------------- #
log.info("Loading LTX-2 (%s, quant=%s) — this takes a minute…", MODEL_NAME, QUANT or "bf16")
OUT_DIR.mkdir(parents=True, exist_ok=True)
sys.argv = ["serve.py", *_build_argv()]
_checkpoint_path = detect_checkpoint_path()
_params = detect_params(_checkpoint_path)
_parser = default_2_stage_arg_parser(params=_params)
ARGS = _parser.parse_args()
TILING = TilingConfig.default()

PIPELINE = TI2VidTwoStagesPipeline(
    checkpoint_path=ARGS.checkpoint_path,
    distilled_lora=ARGS.distilled_lora,
    spatial_upsampler_path=ARGS.spatial_upsampler_path,
    gemma_root=ARGS.gemma_root,
    loras=tuple(ARGS.lora) if ARGS.lora else (),
    quantization=ARGS.quantization,
    compilation_config=ARGS.compile,
    offload_mode=ARGS.offload_mode,
)
log.info("LTX-2 ready. Serving on the /video/generations contract.")

# One GPU → serialize generations so two requests never OOM each other.
_gpu_lock = asyncio.Lock()


def _snap_frames(n: int) -> int:
    """num-frames must be 8k+1 (…, 97, 105, 113, 121 …)."""
    n = max(9, int(n))
    k = round((n - 1) / 8)
    return 8 * k + 1


def _generate(prompt: str, opts: dict) -> str:
    """Run the pipeline (blocking) and return the output file's basename."""
    height = int(opts.get("height", DEF_HEIGHT))
    width = int(opts.get("width", DEF_WIDTH))
    num_frames = _snap_frames(opts.get("num_frames", DEF_FRAMES))
    frame_rate = float(opts.get("frame_rate", DEF_FPS))
    steps = int(opts.get("num_inference_steps") or ARGS.num_inference_steps)
    seed = int(opts.get("seed", ARGS.seed))
    negative = str(opts.get("negative_prompt") or ARGS.negative_prompt)

    name = f"{int(time.time())}-{uuid.uuid4().hex[:8]}.mp4"
    out_path = OUT_DIR / name

    video, audio = PIPELINE(
        prompt=prompt,
        negative_prompt=negative,
        seed=seed,
        height=height,
        width=width,
        num_frames=num_frames,
        frame_rate=frame_rate,
        num_inference_steps=steps,
        video_guider_params=MultiModalGuiderParams(
            cfg_scale=ARGS.video_cfg_guidance_scale,
            stg_scale=ARGS.video_stg_guidance_scale,
            rescale_scale=ARGS.video_rescale_scale,
            modality_scale=ARGS.a2v_guidance_scale,
            skip_step=ARGS.video_skip_step,
            stg_blocks=ARGS.video_stg_blocks,
        ),
        audio_guider_params=MultiModalGuiderParams(
            cfg_scale=ARGS.audio_cfg_guidance_scale,
            stg_scale=ARGS.audio_stg_guidance_scale,
            rescale_scale=ARGS.audio_rescale_scale,
            modality_scale=ARGS.v2a_guidance_scale,
            skip_step=ARGS.audio_skip_step,
            stg_blocks=ARGS.audio_stg_blocks,
        ),
        images=[],  # pure text-to-video; n4lu sends prompt only
        tiling_config=TILING,
        max_batch_size=ARGS.max_batch_size,
    )
    encode_video(
        video=video,
        fps=frame_rate,
        audio=audio,
        output_path=str(out_path),
        video_chunks_number=get_video_chunks_number(num_frames, TILING),
    )
    return name


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
app = FastAPI(title="Nalu LTX-2 Video")
app.mount("/files", StaticFiles(directory=str(OUT_DIR)), name="files")


class GenBody(BaseModel):
    prompt: str
    model: str | None = None
    negative_prompt: str | None = None
    height: int | None = None
    width: int | None = None
    num_frames: int | None = None
    frame_rate: float | None = None
    num_inference_steps: int | None = None
    seed: int | None = None


def _check_auth(authorization: str | None) -> None:
    if not API_KEY:
        return  # auth disabled (only safe behind a private network)
    expected = f"Bearer {API_KEY}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="bad api key")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_NAME, "quant": QUANT or "bf16", "cuda": torch.cuda.is_available()}


@app.post("/video/generations")
async def generate(body: GenBody, authorization: str | None = Header(default=None)) -> JSONResponse:
    _check_auth(authorization)
    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt required")

    opts = body.model_dump(exclude_none=True)
    async with _gpu_lock:  # one generation at a time on a single GPU
        try:
            name = await asyncio.to_thread(_generate, prompt, opts)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            raise HTTPException(status_code=503, detail="GPU OOM — lower resolution/frames or use fp8")
        except Exception as e:  # noqa: BLE001
            log.exception("generation failed")
            raise HTTPException(status_code=500, detail=str(e)[:300])

    base = PUBLIC_BASE_URL or ""
    url = f"{base}/files/{name}" if base else f"/files/{name}"
    return JSONResponse({"video": {"url": url}, "video_url": url, "name": "Nalu Video", "model": MODEL_NAME})


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(_env("PORT", "8000")), log_level="info")
