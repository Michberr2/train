#!/usr/bin/env bash
# tunnel-cloudflared.sh — Expose the local GLM-5.2 /v1 endpoint to the public
# internet (so Vercel/n4lu.ai can reach it) via Cloudflare Tunnel.
#
# Vercel serverless functions run in the cloud and CANNOT reach localhost or a
# LAN IP. This makes an OUTBOUND connection to Cloudflare's edge; no inbound
# ports are opened on your router, and TLS is terminated by Cloudflare. SSE
# streams proxy fine through cloudflared.
#
# TWO TIMEOUTS can still truncate a long reply even when the tunnel works:
#   1. Vercel function maxDuration — set vercel.json {"functions":{"api/chat.ts":
#      {"maxDuration":300}}} (needs Pro + Fluid Compute) and redeploy. See docs §4.0.
#   2. Cloudflare edge read-timeout (~100s on free plans) — a longer generation
#      can be cut with a 524. Keep total generation under it, lower the general
#      route max_tokens, or front with a proxy whose read-timeout you control. §4.2.
#
# Two modes:
#   MODE=quick  -> ephemeral https://<random>.trycloudflare.com (testing only)
#   MODE=named  -> stable hostname (production); requires a CF account + domain.
#
# After it prints the https url, set on Vercel (value MUST end in /v1):
#   NALU_GENERAL_BASE_URL = https://<host>/v1
#   NALU_GENERAL_API_KEY  = <same bearer passed to the inference server>
#   NALU_GENERAL_MODEL    = glm-5.2   (must match --served-model-name)
# then run ./deploy.sh. See docs/self-host-glm-5.2.md §4-§5.
set -euo pipefail

LOCAL_PORT="${LOCAL_PORT:-8000}"            # 8000 for vLLM, 30000 for SGLang
LOCAL_URL="${LOCAL_URL:-http://localhost:${LOCAL_PORT}}"
MODE="${MODE:-quick}"                        # quick | named
TUNNEL_NAME="${TUNNEL_NAME:-nalu-glm}"       # named mode: the cloudflared tunnel name
HOSTNAME_FQDN="${HOSTNAME_FQDN:-glm.n4lu.ai}" # named mode: public hostname to route

command -v cloudflared >/dev/null 2>&1 || {
  echo "ERROR: cloudflared not found." >&2
  echo "  macOS: brew install cloudflared" >&2
  echo "  Linux: curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i cloudflared.deb" >&2
  exit 1
}

if [[ "${MODE}" == "quick" ]]; then
  echo ">> Quick tunnel (ephemeral, testing only) -> ${LOCAL_URL}"
  echo "   Copy the printed https://<random>.trycloudflare.com URL and append /v1."
  echo "   Do NOT use this URL in production env (it rotates on restart)."
  exec cloudflared tunnel --url "${LOCAL_URL}"
fi

# ---- Named tunnel (stable, production) ----
# One-time setup (run these by hand the first time, then re-run this script):
#   cloudflared tunnel login
#   cloudflared tunnel create ${TUNNEL_NAME}
#   cloudflared tunnel route dns ${TUNNEL_NAME} ${HOSTNAME_FQDN}
# and write ~/.cloudflared/config.yml (raise originRequest timeouts so a slow
# SSE generation isn't severed by the edge read-timeout):
#   tunnel: ${TUNNEL_NAME}
#   credentials-file: <path-to>/<TUNNEL-UUID>.json
#   ingress:
#     - hostname: ${HOSTNAME_FQDN}
#       service: ${LOCAL_URL}
#       originRequest:
#         connectTimeout: 30s
#     - service: http_status:404
echo ">> Named tunnel '${TUNNEL_NAME}' -> ${LOCAL_URL}"
echo "   Public base URL will be: https://${HOSTNAME_FQDN}/v1"
echo "   Reminder: set vercel.json maxDuration AND mind the CF ~100s read-timeout (docs §4)."
if ! cloudflared tunnel list 2>/dev/null | grep -q "${TUNNEL_NAME}"; then
  echo "ERROR: tunnel '${TUNNEL_NAME}' not found. Run the one-time setup in this script's comments first." >&2
  exit 1
fi
exec cloudflared tunnel run "${TUNNEL_NAME}"
