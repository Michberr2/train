#!/usr/bin/env bash
# Start the Nalu LTX-2.3 video server (loads the 22B model, keeps it warm) and,
# if cloudflared is present, open a public HTTPS tunnel so Vercel can reach it.
#
#   bash run.sh
#
# Reads ./.env (see .env.example). Stop with Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
LTX_DIR="${LTX_DIR:-$ROOT/LTX-2}"

[ -f .env ] && set -a && . ./.env && set +a
export LTX_WEIGHTS_DIR LTX_OUTPUT_DIR LTX_GEMMA_ROOT NALU_VIDEO_API_KEY \
       PUBLIC_BASE_URL LTX_QUANTIZATION LTX_HEIGHT LTX_WIDTH LTX_NUM_FRAMES \
       LTX_FRAME_RATE LTX_STEPS LTX_CHECKPOINT LTX_DISTILLED_LORA \
       LTX_SPATIAL_UPSAMPLER LTX_USER_LORA PORT
PORT="${PORT:-8000}"

# Optional public tunnel (so n4lu on Vercel can call this box without port-forwarding).
if command -v cloudflared >/dev/null 2>&1 && [ -z "${PUBLIC_BASE_URL:-}" ]; then
  echo "==> Starting Cloudflare quick tunnel…"
  cloudflared tunnel --url "http://localhost:${PORT}" > /tmp/cf-tunnel.log 2>&1 &
  CF_PID=$!
  trap 'kill $CF_PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf-tunnel.log | head -1 || true)
    [ -n "$URL" ] && break
    sleep 1
  done
  if [ -n "${URL:-}" ]; then
    export PUBLIC_BASE_URL="$URL"
    echo "==> Public URL: $URL"
    echo "    Set these in Vercel (n4lu):"
    echo "      NALU_VIDEO_BASE_URL = $URL"
    echo "      NALU_VIDEO_API_KEY  = (your .env value)"
    echo "      NALU_VIDEO_MODEL    = ltx-2.3"
  fi
fi

echo "==> Launching LTX-2 server on :$PORT (PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-<none>})"
exec "$LTX_DIR/.venv/bin/python" serve.py
