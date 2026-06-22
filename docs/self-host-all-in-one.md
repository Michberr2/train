# Self-Host All of Nalu's Heavy Compute (one setup, three services)

Everything that needs a GPU — **GLM-5.2** (chat), **Z-Image-Turbo** (images), **LTX-2** (video+audio) — wired to n4lu.ai/n4lu.com with **no third-party API keys** and **no per-use cost** (after hardware). One Cloudflare tunnel exposes all three; a handful of Vercel env vars switch them on.

> **The web app (n4lu.ai) is on Vercel and can't reach `localhost`.** Each service is exposed via a public HTTPS hostname (Cloudflare Tunnel) + a bearer token *you invent*. The `naludesktop` app can hit `localhost` directly.

---

## 0. Pick your hardware tier

You do **not** need everything at once. Two sensible tiers:

| Tier | Box | Runs | Rough cost | Unlocks |
|------|-----|------|-----------|---------|
| **A — Media first (cheap)** | **1× 48 GB GPU** (L40S / A6000 / A100-40 is tight) | Z-Image + LTX-2 | ~$0.80–$1.50/hr rented | **free realistic images + video w/ audio** |
| **B — Full (adds GLM-5.2)** | **8× H200 node** (+ the media box, or spare GPUs) | GLM-5.2 + Z-Image + LTX-2 | ~$11–18k/mo always-on | everything self-hosted |

- **GLM-5.2 FP8 needs all 8 H200s (TP=8)** — see `docs/self-host-glm-5.2.md`. Don't try to cram Z-Image/LTX-2 onto those same GPUs while vLLM holds them; run media on a **separate single GPU** (Tier A box) or a couple of dedicated GPUs.
- **Z-Image** needs ~16 GB; **LTX-2** ~32 GB (24 GB tight with fp8+distilled). A single **48 GB** GPU comfortably runs **both**.
- **Start with Tier A** (cheap, unlocks images+video today). Add the 8×H200 for GLM-5.2 when ready.

Rent from Runpod / Lambda / Vast.ai (per-second billing — start/stop as needed).

---

## 1. Bring up the services

SSH into the box, then run each service (see the script headers for full install steps). Pick a shared bearer per service — reuse one secret for all three if you like:

```bash
export NALU_KEY="$(openssl rand -hex 32)"   # one bearer for all three (or use three)

# (Tier B only) GLM-5.2 chat — 8× H200, port 8000
export NALU_GENERAL_API_KEY="$NALU_KEY"
./scripts/serve-glm-vllm.sh            # serves /v1, model name: glm-5.2-fp8

# Images — Z-Image-Turbo, port 8800
export NALU_IMAGE_API_KEY="$NALU_KEY"
python scripts/serve-image-zimage.py   # serves /v1, model: z-image-turbo

# Video+audio — LTX-2, port 8900  (set LTX_CHECKPOINT etc first — see script header)
export NALU_VIDEO_API_KEY="$NALU_KEY"
export PUBLIC_BASE="https://vid.n4lu.ai"
python scripts/serve-video-ltx2.py     # serves /v1/video/generations -> {url}
```

Smoke-test each locally:
```bash
curl -s localhost:8000/v1/models  -H "Authorization: Bearer $NALU_KEY"   # GLM
curl -s localhost:8800/v1/models  -H "Authorization: Bearer $NALU_KEY"   # Z-Image
curl -s localhost:8900/health                                            # LTX-2
```

---

## 2. Expose all three through ONE Cloudflare tunnel

Requires a domain on Cloudflare (a subdomain of `n4lu.ai` is perfect). Install `cloudflared` (see `scripts/tunnel-cloudflared.sh`), then:

```bash
cloudflared tunnel login
cloudflared tunnel create nalu
cloudflared tunnel route dns nalu glm.n4lu.ai
cloudflared tunnel route dns nalu img.n4lu.ai
cloudflared tunnel route dns nalu vid.n4lu.ai
```

`~/.cloudflared/config.yml` — one tunnel, three hostnames:
```yaml
tunnel: nalu
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: glm.n4lu.ai
    service: http://localhost:8000
  - hostname: img.n4lu.ai
    service: http://localhost:8800
  - hostname: vid.n4lu.ai
    service: http://localhost:8900
    originRequest:
      connectTimeout: 30s        # video renders take a while; keep generous
  - service: http_status:404
```

Run it (and install as a service so it survives reboot):
```bash
cloudflared tunnel run nalu
sudo cloudflared service install
```

Verify each is public (from your laptop, not the box):
```bash
curl -s https://img.n4lu.ai/v1/models -H "Authorization: Bearer $NALU_KEY"
```

> If a service runs on a **different box** than the tunnel, point that ingress `service:` at the box's LAN IP (e.g. `http://10.0.0.5:8000`) or run a `cloudflared` on each box.

---

## 3. Wire Vercel + deploy

Set only the env vars for the services you're running. **`rm` before `add`** (env add no-ops if the var exists):

```bash
cd /Users/michaelberryii/train
set_env () { npx -y vercel@latest env rm "$1" production -y 2>/dev/null; printf '%s' "$2" | npx -y vercel@latest env add "$1" production; }

# Images (Tier A)
set_env NALU_IMAGE_BASE_URL  "https://img.n4lu.ai/v1"
set_env NALU_IMAGE_API_KEY   "$NALU_KEY"
set_env NALU_IMAGE_MODEL     "z-image-turbo"

# Video (Tier A)
set_env NALU_VIDEO_BASE_URL  "https://vid.n4lu.ai/v1"
set_env NALU_VIDEO_API_KEY   "$NALU_KEY"

# Chat / GLM-5.2 (Tier B)
set_env NALU_GENERAL_BASE_URL "https://glm.n4lu.ai/v1"
set_env NALU_GENERAL_API_KEY  "$NALU_KEY"
set_env NALU_GENERAL_MODEL    "glm-5.2-fp8"

./deploy.sh
```

`maxDuration: 300` is already set for `api/chat.ts`, `api/doc.ts`, `api/sheet.ts`, `api/video.ts` in `vercel.json`.

---

## 4. Verify on the live site

| Capability | Vercel env | Endpoint that should flip 501→200 | Test on n4lu.ai |
|---|---|---|---|
| Images (self-host) | `NALU_IMAGE_*` | `/api/image` already 200 (free fallback) → now uses Z-Image | "draw a photorealistic wolf" |
| Video + audio | `NALU_VIDEO_*` | `/api/video` 501 → 200 | "make a 5s video of a wolf in snow" |
| Chat = GLM-5.2 | `NALU_GENERAL_*` | `/api/chat` route `Nalu Catalina` now on GLM | "who are you?" → confirm in GLM box logs |

```bash
curl -N https://n4lu.ai/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"in one sentence, who are you?"}]}'
# event: route -> {"name":"Nalu Catalina"} ; request shows up in the GLM server logs
```

---

## 5. Checklist

- [ ] Provision GPU(s): Tier A = 1× 48 GB (images+video) · Tier B = 8× H200 (GLM-5.2) — rent first.
- [ ] Download weights: `zai-org/GLM-5.2-FP8` (~743 GB), `Tongyi-MAI/Z-Image-Turbo` (~16 GB), `Lightricks/LTX-2.3`.
- [ ] `export NALU_KEY=...`; start the services; smoke-test `/v1/models` + `/health` locally.
- [ ] One Cloudflare tunnel, three hostnames (`glm`/`img`/`vid`.n4lu.ai); verify public.
- [ ] Set the matching `NALU_*` Vercel env vars (rm→add, production); `./deploy.sh`.
- [ ] Confirm on n4lu.ai: image (Z-Image), `/api/video` 200 with audio, chat on GLM.
- [ ] (LTX-2) confirm the `«VERIFY»` lora/upsampler/gemma file names from the model card.

**Bottom line:** one cheap 48 GB GPU box gets you **free realistic images + free video with audio** today; the 8×H200 adds **GLM-5.2 chat**. All open-source, all self-hosted, no third-party keys, no per-use cost — exposed through one tunnel and a few env vars.
