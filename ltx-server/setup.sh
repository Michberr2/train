#!/usr/bin/env bash
# One-time setup for the Nalu LTX-2.3 video box (Linux + NVIDIA GPU, CUDA 13+).
# Installs the official Lightricks/LTX-2 package and downloads the model weights.
#
#   bash setup.sh            # clone + install + download distilled+dev weights
#
# Re-runnable: skips clones/downloads that already exist.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

LTX_DIR="${LTX_DIR:-$ROOT/LTX-2}"
WEIGHTS_DIR="${LTX_WEIGHTS_DIR:-$ROOT/weights}"
HF_REPO="Lightricks/LTX-2.3"
GEMMA_REPO="google/gemma-3-12b-it-qat-q4_0-unquantized"

echo "==> 1/4  Clone the official LTX-2 package"
if [ ! -d "$LTX_DIR/.git" ]; then
  git clone https://github.com/Lightricks/LTX-2.git "$LTX_DIR"
else
  echo "    already cloned at $LTX_DIR"
fi

echo "==> 2/4  Install deps with uv (creates $LTX_DIR/.venv)"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
( cd "$LTX_DIR" && uv sync --frozen )
# Server deps live in the SAME venv so `import ltx_pipelines` works in serve.py.
( cd "$LTX_DIR" && uv pip install "fastapi>=0.110" "uvicorn[standard]>=0.29" "huggingface_hub[cli]" )

echo "==> 3/4  Download model weights -> $WEIGHTS_DIR"
mkdir -p "$WEIGHTS_DIR"
HF="$LTX_DIR/.venv/bin/hf"
# Core files for the recommended two-stage pipeline (dev model + distilled LoRA).
for f in \
  ltx-2.3-22b-dev.safetensors \
  ltx-2.3-22b-distilled-1.1.safetensors \
  ltx-2.3-22b-distilled-lora-384-1.1.safetensors \
  ltx-2.3-spatial-upscaler-x2-1.1.safetensors \
  ltx-2.3-temporal-upscaler-x2-1.0.safetensors ; do
  if [ ! -f "$WEIGHTS_DIR/$f" ]; then
    echo "    fetching $f"
    "$HF" download "$HF_REPO" "$f" --local-dir "$WEIGHTS_DIR"
  fi
done

echo "==> 4/4  Download Gemma 3 text encoder -> $WEIGHTS_DIR/gemma"
if [ ! -d "$WEIGHTS_DIR/gemma/config.json" ] && [ ! -f "$WEIGHTS_DIR/gemma/config.json" ]; then
  "$HF" download "$GEMMA_REPO" --local-dir "$WEIGHTS_DIR/gemma"
fi

cat <<EOF

✅ Setup done.
   LTX-2 repo : $LTX_DIR
   Weights    : $WEIGHTS_DIR

Next:
   cp .env.example .env   # then edit NALU_VIDEO_API_KEY + PUBLIC_BASE_URL
   bash run.sh            # starts the server (+ optional Cloudflare tunnel)
EOF
