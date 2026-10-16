// Nalu video generation — Vercel Node serverless function.
// Backends, in priority order:
//   1. DeepInfra (DEEPINFRA_API_KEY) — hosted LTX-2.3 (FastVideo/LTX-2.3-Distilled),
//                                      cheapest LTX-2.3 (~$0.035/s). SILENT (no audio).
//   2. self-hosted (NALU_VIDEO_*)    — your own LTX-2.3 box, WITH AUDIO (see ltx-server/)
//   3. fal.ai (FAL_KEY)              — hosted LTX-2.3, WITH synced audio (6s min ~$0.36)
//   4. free HF Space pool (default)  — anonymous, no key, SILENT + best-effort
// Pick LTX-2.3 cheaply via DeepInfra (silent) or with audio via fal.

import { cors } from './_cors'
import { reserveDailyQuota } from './_limits'
import { chatComplete } from './_llm'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

// DeepInfra hosted LTX-2.3 — the cheapest LTX-2.3 (silent). One DeepInfra key can
// also power the LLM (set TINKER_BASE_URL to another provider). Override the slug if needed.
const DEEPINFRA_KEY = env('DEEPINFRA_API_KEY') || env('DEEPINFRA_TOKEN') || ''
const DEEPINFRA_VIDEO_MODEL = env('NALU_DEEPINFRA_VIDEO_MODEL') || 'FastVideo/LTX-2.3-Distilled-Diffusers'

const FAL_KEY = env('FAL_KEY') || env('FAL_API_KEY') || ''
// LTX-2.3 (the newest 22B model) on its cheapest endpoint: the FAST text-to-video
// variant, with synced audio. Override with FAL_VIDEO_MODEL — e.g.
// 'fal-ai/ltx-2.3/text-to-video' (higher fidelity) or 'fal-ai/ltx-2.3-quality/text-to-video' (best).
const FAL_MODEL = env('FAL_VIDEO_MODEL') || 'fal-ai/ltx-2.3/text-to-video/fast'

// HF Inference Providers router — runs the FULL Wan 2.2-A14B (the best
// open-source video model, ~1400px long side, aspect-correct) using the same
// HUGGINGFACE_API_TOKEN the app already has. Queue-based fal provider.
const HF_TOKEN = env('HUGGINGFACE_API_TOKEN') || env('HF_TOKEN') || ''
const HF_WAN_I2V = env('NALU_HF_WAN_I2V') || 'fal-ai/fal-ai/wan/v2.2-a14b/image-to-video'
const HF_WAN_T2V = env('NALU_HF_WAN_T2V') || 'fal-ai/fal-ai/wan/v2.2-a14b/text-to-video'

// Google Veo via the Gemini API — the highest-fidelity video engine (native
// audio on Veo 3.x). Set GEMINI_API_KEY (or GOOGLE_AI_API_KEY) in Vercel and
// every video instantly upgrades; model override via NALU_VEO_MODEL.
const GEMINI_KEY = env('GEMINI_API_KEY') || env('GOOGLE_AI_API_KEY') || env('GOOGLE_GENAI_API_KEY') || ''
const VEO_MODELS = [env('NALU_VEO_MODEL') || 'veo-3.1-fast-generate-preview', 'veo-3.0-fast-generate-001', 'veo-2.0-generate-001']

const V_BASE = (env('NALU_VIDEO_BASE_URL') || '').replace(/\/+$/, '')
const V_KEY = env('NALU_VIDEO_API_KEY') || ''
const V_MODEL = env('NALU_VIDEO_MODEL') || 'ltx-2.3'

// Free, keyless fallback POOL: open-source LTX-Video Spaces (silent, ZeroGPU,
// best-effort). Several mirrors so when one's GPU is busy we fail over to the
// next — that's the whole reason free video felt flaky. All must expose the same
// gradio `text_to_video` fn. Override/extend with NALU_VIDEO_FREE_SPACES (CSV).
const DEFAULT_FREE_SPACES = ['https://lightricks-ltx-video-distilled.hf.space']
const FREE_SPACES = (env('NALU_VIDEO_FREE_SPACES') || env('NALU_VIDEO_FREE_SPACE') || DEFAULT_FREE_SPACES.join(','))
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// LTX-2.3 (fal) exposes a fixed DURATION enum. This is our path to clips LONGER
// than the ~4-8s every other backend is capped at: snap a requested length to
// the nearest enum value that does not exceed it (so "15s" → 14s, never over-ask).
const LTX_DURATIONS = [6, 8, 10, 12, 14, 16, 18, 20]
function snapLtxDuration(sec: number): number {
  const under = LTX_DURATIONS.filter((d) => d <= sec)
  return under.length ? under[under.length - 1] : LTX_DURATIONS[0]
}

// Longest single-shot clip we'll attempt (LTX-2.3 native max). Requests beyond
// this are clamped; true minute-long video needs segment stitching (future).
const MAX_SECONDS = 20

// Figure out how long a clip the user wants: an explicit body.duration/seconds
// wins; otherwise parse a natural-language length out of the prompt ("15 second
// clip", "20s", "half a minute", "1 minute"). Returns null when unspecified so
// callers keep their own default. Clamped to [2, MAX_SECONDS].
function requestedSeconds(prompt: string, body: Record<string, unknown>): number | null {
  const clamp = (n: number) => Math.min(MAX_SECONDS, Math.max(2, Math.round(n)))
  const fromBody = Number(body.duration ?? body.seconds)
  if (Number.isFinite(fromBody) && fromBody > 0) return clamp(fromBody)
  const half = /\bhalf\s+a?\s*min(?:ute)?\b/i.test(prompt)
  if (half) return clamp(30)
  const m = prompt.match(/(\d+(?:\.\d+)?)\s*(?:-|to|\s)?\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/i)
  if (m) {
    let n = parseFloat(m[1])
    if (/^m|min/i.test(m[2])) n *= 60
    if (Number.isFinite(n) && n > 0) return clamp(n)
  }
  return null
}

// Motion-aware prompt enrichment so "a wolf running" actually RUNS (the raw
// models often render a static subject). Reuses the Nalu LLM gateway (failover).
const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_VIDEO_PROMPT_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

// Quality negative prompt — steers the model away from common failures that make
// a clip look "wrong" (distortions, morphing, extra limbs, text/watermarks).
const VIDEO_NEGATIVE =
  'inaccurate, wrong subject, distorted, deformed, disfigured, extra limbs, extra fingers, mutated, morphing, warping, flickering, jittery, inconsistent, duplicated subject, blurry, low quality, low resolution, artifacts, glitch, watermark, text, caption, subtitles, logo, oversaturated'

// Faithful prompt enrichment: expand the user's request into a detailed
// text-to-VIDEO prompt that KEEPS every specific they gave (so the clip is
// ACCURATE), adding only consistent detail, motion, camera and lighting.
async function enrichVideoPrompt(prompt: string): Promise<string> {
  const fallback = `${prompt}. ONE continuous shot, no cuts. Natural, lifelike, continuous motion true to the description; the subject actively moves; smooth cinematic camera; realistic lighting; sharp focus; ultra-detailed; 4k.`
  if (!LLM_KEY) return fallback
  try {
    const out = (
      await chatComplete(
        [
          {
            role: 'system',
            content:
              'You turn a user request into ONE precise text-to-VIDEO prompt for an AI video model. RULES: ' +
              '(1) ACCURACY FIRST — keep EVERY specific the user gave: the exact subject(s) and how many, their colors/clothing/appearance, the setting, time of day, weather, mood, and the specific action. Never change, drop, swap, or contradict any detail, and never add unrelated subjects, objects, or scenes. ' +
              '(2) MOTION IS MANDATORY — describe the action as a CONTINUOUS sequence of movement using active verbs (e.g. "sprints, paws pounding, fur rippling"), say exactly what moves and how, and add ONE fitting camera move (slow push-in, tracking shot, pan). The subject must be actively moving, never static or merely standing. ' +
              '(3) Specify it is ONE continuous shot with no cuts/edits. ' +
              '(4) If the request is short or vague, flesh it out faithfully (do not invent a different scene). ' +
              '(5) End with brief quality cues: cinematic, sharp focus, ultra-detailed, 4k. ' +
              'Output ONLY the final prompt as plain text, 30-70 words, no preamble, no quotes, no lists.',
          },
          { role: 'user', content: prompt },
        ],
        { model: LLM_MODEL, maxTokens: 260, timeoutMs: 18000, temperature: 0.6 },
      )
    )
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .trim()
    return out || fallback
  } catch {
    return fallback
  }
}

function pickUrl(result: unknown): string {
  const r = result as {
    video?: { url?: string }
    video_url?: string
    url?: string
    videos?: Array<{ url?: string }>
  }
  return r?.video?.url || r?.video_url || r?.url || (Array.isArray(r?.videos) ? r.videos[0]?.url || '' : '')
}

// ---- 0x) Google Veo (Gemini API predictLongRunning + operation polling) ----
async function veoVideo(prompt: string, image?: string, wantVertical = false): Promise<{ url?: string; error?: string }> {
  const dims = image ? imageDims(image) : null
  const portrait = wantVertical || (!!dims && dims.h > dims.w)
  const imgPart = image ? (() => { const m = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/i); return m ? { bytesBase64Encoded: m[2], mimeType: m[1] } : null } )() : null
  let lastErr = 'veo unavailable'
  for (const model of VEO_MODELS) {
    let op: { name?: string; error?: { message?: string } } = {}
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt, ...(imgPart ? { image: imgPart } : {}) }],
          parameters: { aspectRatio: portrait ? '9:16' : '16:9', ...(portrait ? {} : { resolution: '1080p' }) },
        }),
      })
      if (r.status === 404) { lastErr = `veo model ${model} not found`; continue }
      op = (await r.json().catch(() => ({}))) as typeof op
      if (!r.ok || !op.name) { lastErr = op.error?.message || `veo ${r.status}`; continue }
    } catch { lastErr = 'veo submit failed'; continue }
    const deadline = Date.now() + 220000
    while (Date.now() < deadline) {
      await sleep(8000)
      try {
        const pr = await fetch(`https://generativelanguage.googleapis.com/v1beta/${op.name}?key=${GEMINI_KEY}`)
        const pj = (await pr.json().catch(() => ({}))) as {
          done?: boolean
          error?: { message?: string }
          response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } }
        }
        if (pj.error) return { error: `veo: ${pj.error.message || 'failed'}` }
        if (pj.done) {
          const uri = pj.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
          return uri ? { url: uri.includes('?') ? `${uri}&key=${GEMINI_KEY}` : `${uri}?key=${GEMINI_KEY}` } : { error: 'veo empty result' }
        }
      } catch { /* transient poll error */ }
    }
    return { error: 'veo timeout' }
  }
  return { error: lastErr }
}

// ---- 0a) Wan 2.2-A14B via the HF provider router (existing HF token) ----
async function hfWanVideo(prompt: string, image?: string): Promise<{ url?: string; error?: string }> {
  const path = image ? HF_WAN_I2V : HF_WAN_T2V
  const q = (u: string) => u.replace('https://queue.fal.run', 'https://router.huggingface.co/fal-ai') + '?_subdomain=queue'
  let sub: Response
  try {
    sub = await fetch(`https://router.huggingface.co/${path}?_subdomain=queue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, resolution: '720p', ...(image ? { image_url: image } : {}) }),
    })
  } catch {
    return { error: 'hf-wan submit failed' }
  }
  if (!sub.ok) return { error: `hf-wan submit ${sub.status}` }
  const j = (await sub.json().catch(() => ({}))) as { status_url?: string; response_url?: string }
  if (!j.status_url || !j.response_url) return { error: 'hf-wan no job' }
  const deadline = Date.now() + 210000
  while (Date.now() < deadline) {
    await sleep(5000)
    try {
      const st = await fetch(q(j.status_url), { headers: { Authorization: `Bearer ${HF_TOKEN}` } })
      const sj = (await st.json().catch(() => ({}))) as { status?: string }
      if (sj.status === 'COMPLETED') {
        const rr = await fetch(q(j.response_url), { headers: { Authorization: `Bearer ${HF_TOKEN}` } })
        const rj = (await rr.json().catch(() => ({}))) as { video?: { url?: string } }
        return rj.video?.url ? { url: rj.video.url } : { error: 'hf-wan empty result' }
      }
      if (sj.status === 'FAILED' || st.status >= 400) return { error: `hf-wan ${sj.status || st.status}` }
    } catch { /* transient poll error — keep waiting */ }
  }
  return { error: 'hf-wan timeout' }
}

// ---- 0) DeepInfra hosted LTX-2.3 (cheapest LTX-2.3; silent) ----
// Synchronous inference API: POST the prompt, get back { video_url }. The URL may
// be absolute, a data: URI, or a path relative to the DeepInfra host.
async function deepinfraVideo(prompt: string): Promise<{ url?: string; error?: string }> {
  const r = await fetch(`https://api.deepinfra.com/v1/inference/${DEEPINFRA_VIDEO_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `bearer ${DEEPINFRA_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, negative_prompt: VIDEO_NEGATIVE }),
  })
  const text = await r.text()
  if (!r.ok) return { error: `Video upstream ${r.status}: ${text.slice(0, 200)}` }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'bad video response' }
  }
  let url = pickUrl(data)
  if (url && !/^(https?:|data:)/i.test(url)) url = `https://api.deepinfra.com${url.startsWith('/') ? '' : '/'}${url}`
  return url ? { url } : { error: 'no video returned' }
}

// ---- 1) fal.ai (audio) ----
async function falVideo(prompt: string, seconds?: number): Promise<{ url?: string; error?: string }> {
  // LTX-2.3 is our LONG-CLIP backend: snap the requested length to its duration
  // enum (up to 20s) so "make a 15s video" actually renders 14s, not the 6s default.
  const duration = seconds ? snapLtxDuration(seconds) : Number(env('FAL_VIDEO_DURATION')) || 6
  const submit = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: VIDEO_NEGATIVE,
      // LTX-2.3 fast: duration enum {6,8,…20}s (6 = cheapest), resolution enum
      // {1080p,1440p,2160p} (1080p = cheapest; there is no 720p), audio on.
      duration,
      aspect_ratio: env('FAL_VIDEO_ASPECT') || '16:9',
      generate_audio: true,
      resolution: env('FAL_VIDEO_RESOLUTION') || '1080p',
    }),
  })
  const submitText = await submit.text()
  if (!submit.ok) return { error: `Video submit ${submit.status}: ${submitText.slice(0, 200)}` }
  let job: { status_url?: string; response_url?: string }
  try {
    job = JSON.parse(submitText)
  } catch {
    return { error: 'bad submit response' }
  }
  if (!job.status_url || !job.response_url) return { error: 'no status url from provider' }
  const deadline = Date.now() + 260000
  for (;;) {
    await sleep(2000)
    if (Date.now() > deadline) return { error: 'video timed out — try a shorter clip' }
    const s = await fetch(job.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } })
    const st = (await s.json().catch(() => ({}))) as { status?: string }
    if (st.status === 'COMPLETED') break
    if (st.status === 'FAILED' || st.status === 'ERROR') return { error: 'video generation failed' }
  }
  const out = await fetch(job.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } })
  const url = pickUrl(await out.json().catch(() => ({})))
  return url ? { url } : { error: 'no video returned' }
}

// ---- 2) self-hosted (audio) ----
async function customVideo(prompt: string): Promise<{ url?: string; error?: string }> {
  const upstream = await fetch(`${V_BASE}/video/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${V_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: V_MODEL, prompt, negative_prompt: VIDEO_NEGATIVE }),
  })
  const text = await upstream.text()
  if (!upstream.ok) return { error: `Video upstream ${upstream.status}: ${text.slice(0, 200)}` }
  try {
    const url = pickUrl(JSON.parse(text))
    return url ? { url } : { error: 'no video returned' }
  } catch {
    return { error: 'bad video response' }
  }
}

// ---- 3) free HF Space (silent) ----
function extractHfVideo(sse: string): string {
  const lines = sse.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('event: complete')) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith('data:')) {
          try {
            const arr = JSON.parse(lines[j].slice(5).trim())
            return arr?.[0]?.video?.url || ''
          } catch {
            return ''
          }
        }
      }
    }
  }
  for (const l of lines) {
    if (l.startsWith('data:')) {
      try {
        const arr = JSON.parse(l.slice(5).trim())
        const u = arr?.[0]?.video?.url
        if (u) return u
      } catch {
        /* ignore */
      }
    }
  }
  return ''
}

// Read intrinsic dimensions from a data-URL image (PNG IHDR / JPEG SOFn) so the
// video frame matches the input's aspect — a squashed start frame reads as "AI
// slop" immediately; matching aspect is the cheapest big quality win.
function imageDims(dataUrl: string): { w: number; h: number } | null {
  try {
    const b64 = dataUrl.split(',')[1] || ''
    const buf = Buffer.from(b64.slice(0, 262144), 'base64')
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } // PNG IHDR
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) } // JPEG SOFn
        }
        i += 2 + buf.readUInt16BE(i + 2)
      }
    }
  } catch { /* unknown format */ }
  return null
}

// Pick LTX-friendly output dims (multiples of 32, max side 704) that PRESERVE
// the input image's aspect ratio.
function videoDimsFor(image?: string): { w: number; h: number } {
  const d = image ? imageDims(image) : null
  if (!d || !d.w || !d.h) return { w: 704, h: 512 }
  const MAX = 704
  const scale = MAX / Math.max(d.w, d.h)
  const r32 = (v: number) => Math.max(256, Math.min(704, Math.round((v * scale) / 32) * 32))
  return { w: r32(d.w), h: r32(d.h) }
}

// Upload a data-URL image to a gradio Space; returns the FileData handle the
// space's image_to_video endpoint expects.
async function uploadToSpace(base: string, dataUrl: string): Promise<{ path: string; meta: { _type: string } } | null> {
  try {
    const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i)
    if (!m) return null
    const bytes = Buffer.from(m[2], 'base64')
    const fd = new FormData()
    fd.append('files', new Blob([bytes], { type: m[1] }), m[1].includes('png') ? 'input.png' : 'input.jpg')
    const r = await fetch(`${base}/gradio_api/upload?upload_id=nalu${Date.now()}`, { method: 'POST', body: fd })
    if (!r.ok) return null
    const arr = (await r.json()) as string[]
    return arr && arr[0] ? { path: arr[0], meta: { _type: 'gradio.FileData' } } : null
  } catch {
    return null
  }
}

async function freeSpaceOnce(base: string, prompt: string, image?: string): Promise<{ url?: string; busy?: boolean; error?: string }> {
  // duration 4s (was 2s) so running/motion actually reads; keep distilled-friendly
  // guidance (1) + proven resolution; negative prompt discourages a static/walking subject.
  let fileData: { path: string; meta: { _type: string } } | null = null
  if (image) {
    fileData = await uploadToSpace(base, image)
    if (!fileData) return { busy: true, error: 'image upload failed' }
  }
  const endpoint = fileData ? 'image_to_video' : 'text_to_video'
  const dims = videoDimsFor(image)
  const payload = {
    data: [
      prompt,
      'static, still, motionless, frozen, standing, walking slowly, low quality, blurry, distorted',
      fileData,
      null,
      fileData ? dims.h : 512,
      fileData ? dims.w : 704,
      fileData ? 'image-to-video' : 'text-to-video',
      fileData ? 5 : 4,
      9,
      42,
      true,
      1,
      true,
    ],
  }
  let sub: Response
  try {
    sub = await fetch(`${base}/gradio_api/call/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { busy: true, error: 'submit failed' }
  }
  if (!sub.ok) return { busy: true, error: `submit ${sub.status}` }
  const { event_id } = (await sub.json().catch(() => ({}))) as { event_id?: string }
  if (!event_id) return { busy: true, error: 'no job id' }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 140000)
  try {
    const stream = await fetch(`${base}/gradio_api/call/${endpoint}/${event_id}`, { signal: ctrl.signal })
    if (!stream.ok) return { busy: true, error: `poll ${stream.status}` }
    const url = extractHfVideo(await stream.text())
    return url ? { url } : { busy: true, error: 'empty result' }
  } catch {
    return { busy: true, error: 'stream timeout' }
  } finally {
    clearTimeout(t)
  }
}

// Wan 2.2 (Alibaba, Apache-2.0) — state-of-the-art OPEN-SOURCE image-to-video,
// hosted free on a ZeroGPU Space. Different engine than LTX, so when the LTX
// pool is busy or weak this one still lands the shot.
const WAN_SPACE = (env('NALU_VIDEO_WAN_SPACE') || 'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space').replace(/\/+$/, '')
async function wanSpaceVideo(prompt: string, image: string): Promise<{ url?: string; error?: string }> {
  const fileData = await uploadToSpace(WAN_SPACE, image)
  if (!fileData) return { error: 'wan upload failed' }
  let sub: Response
  try {
    sub = await fetch(`${WAN_SPACE}/gradio_api/call/generate_video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 4 steps / 2.5s is the PROVEN ZeroGPU-budget-safe config for this space
      body: JSON.stringify({ data: [fileData, prompt, 4, VIDEO_NEGATIVE, 2.5, 1, 1, 42, true] }),
    })
  } catch {
    return { error: 'wan submit failed' }
  }
  if (!sub.ok) return { error: `wan submit ${sub.status}` }
  const { event_id } = (await sub.json().catch(() => ({}))) as { event_id?: string }
  if (!event_id) return { error: 'wan no job id' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 200000)
  try {
    const stream = await fetch(`${WAN_SPACE}/gradio_api/call/generate_video/${event_id}`, { signal: ctrl.signal })
    if (!stream.ok) return { error: `wan poll ${stream.status}` }
    const url = extractHfVideo(await stream.text())
    return url ? { url } : { error: 'wan empty result' }
  } catch {
    return { error: 'wan stream timeout' }
  } finally {
    clearTimeout(t)
  }
}

async function freeSpaceVideo(prompt: string, image?: string): Promise<{ url?: string; error?: string }> {
  // Fail over across the free Space pool: each is a shared ZeroGPU, so when one is
  // busy we immediately try the next, then loop back with a short backoff. This is
  // the fix for "free video is flaky" — more GPUs to land on, no key, no cost.
  const rounds = 2
  for (let round = 0; round < rounds; round++) {
    if (round > 0) await sleep(4000)
    for (const base of FREE_SPACES) {
      const r = await freeSpaceOnce(base, prompt, image)
      if (r.url) return { url: r.url }
    }
  }
  return {
    error:
      'Free video GPUs are all busy right now (shared community pool). Give it a minute and try again — it works in bursts.',
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }

  let body: Record<string, unknown> = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }

  // Daily cap (per signed-in user, else per IP) so a traffic spike can't run up
  // a surprise GPU bill. Fails open if metering is unavailable; refunds the slot
  // if generation fails. Tune with NALU_FREE_VIDEO_PER_DAY / NALU_USER_VIDEO_PER_DAY.
  const quota = await reserveDailyQuota(req, 'video')
  if (!quota.ok) {
    res.status(429).json({
      error: quota.signedIn
        ? `You've hit today's video limit (${quota.limit}/day). It resets tomorrow.`
        : `Free video limit reached (${quota.limit}/day). Sign in for more, or try again tomorrow.`,
    })
    return
  }

  // Audio is the upgrade: a clip explicitly asked WITH sound prefers the
  // audio-capable backends first (fal, self-host); otherwise the cheap silent
  // ones lead. Either way we build an ORDERED LADDER of every configured backend
  // and try each until one returns a URL — a single backend's 5xx no longer fails
  // the whole request while other healthy backends sit unused.
  const wantAudio = body.audio === true || body.sound === true
  const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : undefined
  // social video posts are vertical 9:16 (reels/tiktok/shorts/stories or explicit)
  const wantVertical = body.vertical === true || /\b(reels?|tiktok|shorts?|vertical|story|stories|9:16)\b/i.test(prompt)
  // How long a clip? explicit body.duration/seconds or a length named in the
  // prompt ("15 second clip", "20s", "a minute"). >8s ⇒ prefer the LTX (fal)
  // backend, which is the one that natively renders past 8 seconds.
  const seconds = requestedSeconds(prompt, body)
  const longClip = (seconds || 0) > 8
  // Fast/draft mode: explicit body.fast or a "make it quick" ask. Skips the LLM
  // prompt-enrichment round-trip and leads with the fastest synchronous backend.
  const wantFast = body.fast === true || /\b(fast|quick(?:ly)?|asap|draft|rough|instantly?)\b/i.test(prompt)

  // ARCHITECTURAL MODE — the craft that makes walkthroughs read as real film:
  // from a technical drawing/blueprint → the "grow into 3D" transformation; from
  // a photo → a stabilized gimbal walkthrough. Deterministic, reference-grade
  // prompts beat generic LLM enrichment here.
  const ARCH = /walk.?through|blueprint|floor ?plan|architect\w*|interior|exterior|building|house|home\b|apartment|room|render|property|real ?estate/i
  const DRAWING = /blueprint|floor ?plan|drawing|sketch|wireframe|grow|transform|extrude|section/i
  let finalPrompt: string
  if (ARCH.test(prompt) && (image || DRAWING.test(prompt))) {
    finalPrompt = DRAWING.test(prompt)
      ? `Cinematic architectural transformation animation. ${image ? 'Start on the exact technical drawing in the input image, same framing.' : 'Start with a clean black-and-white technical architectural drawing of the space.'} The camera slowly pushes forward while the drawing gradually transforms into a photorealistic space: linework extrudes into 3D geometry, walls and ceilings gain real depth, furniture emerges from wireframe forms, materials organically appear across every surface — wood grain develops, stone and flooring become realistic, plants grow into detailed vegetation, curtains softly materialize. Natural daylight progressively fills the space: volumetric sunlight, soft shadows and reflections, subtle curtain movement, shallow depth of field. The transformation feels seamless and magical, maintaining the same camera angle throughout. Ultra realistic architectural visualization style, smooth transitions, premium cinematic look, warm lighting, highly detailed. Subject: ${prompt}`
      : `Cinematic real-estate walkthrough film of the exact space in the input image — keep its architecture, furniture, materials and lighting faithful. One continuous stabilized gimbal shot gliding slowly forward through the space, gentle parallax, no cuts. Natural volumetric daylight through the windows, soft moving shadows, photorealistic PBR materials, subtle life (curtains breathing, foliage swaying), shallow depth of field, premium architectural film look, ultra detailed, 4k. ${prompt}`
  } else if (wantFast) {
    // Fast mode: skip the LLM enrichment round-trip (saves up to ~18s) and use a
    // solid deterministic template so the clip still moves.
    finalPrompt = `${prompt}. ONE continuous shot, no cuts. Natural, lifelike, continuous motion true to the description; the subject actively moves; smooth cinematic camera; realistic lighting; sharp focus; ultra-detailed.`
  } else {
    // Expand the request into a faithful, detailed prompt FIRST so the clip
    // accurately matches what was asked (raw 1-liners render vague/wrong).
    finalPrompt = await enrichVideoPrompt(prompt)
  }

  type Backend = { name: string; run: () => Promise<{ url?: string; error?: string }> }
  const fal: Backend = { name: 'fal', run: () => falVideo(finalPrompt, seconds || undefined) }
  const deepinfra: Backend = { name: 'deepinfra', run: () => deepinfraVideo(finalPrompt) }
  const selfHost: Backend = { name: 'self-host', run: () => customVideo(finalPrompt) }
  const free: Backend = { name: 'free', run: () => freeSpaceVideo(finalPrompt, image) }
  const wan: Backend = { name: 'wan', run: () => (image ? wanSpaceVideo(finalPrompt, image) : Promise.resolve({ error: 'wan is i2v-only' })) }
  const hfWan: Backend = { name: 'hf-wan', run: () => hfWanVideo(finalPrompt, image) }
  const veo: Backend = { name: 'veo', run: () => veoVideo(finalPrompt, image, wantVertical) }

  const ladder: Backend[] = []
  const add = (b: Backend, ok: boolean) => { if (ok) ladder.push(b) }
  if (longClip) {
    // LONGER-THAN-8s: only LTX-2.3 (fal) natively renders past 8s, so it leads.
    // Veo/Wan fall in behind as ~8s fallbacks if fal is unavailable/fails.
    add(fal, !!FAL_KEY)
    add(veo, !!GEMINI_KEY)
    if (image) { add(hfWan, !!HF_TOKEN); ladder.push(free, wan) }
    else { add(hfWan, !!HF_TOKEN); add(deepinfra, !!DEEPINFRA_KEY); add(selfHost, !!(V_BASE && V_KEY)); ladder.push(free) }
  } else if (wantFast && !image) {
    // FAST: lead with the fastest SYNCHRONOUS backend (DeepInfra distilled — one
    // POST, no queue), then the free pool, then queue-based engines.
    add(deepinfra, !!DEEPINFRA_KEY)
    add(fal, !!FAL_KEY)
    ladder.push(free)
    add(hfWan, !!HF_TOKEN)
    add(veo, !!GEMINI_KEY)
  } else {
    add(veo, !!GEMINI_KEY) // highest fidelity (native audio on Veo 3.x) — always first when configured
    if (image) {
      // image-to-video, best first: full Wan 2.2-A14B (HF router, ~1400px) →
      // free LTX pool → Wan 2.2-5B ZeroGPU — three independent engines.
      add(hfWan, !!HF_TOKEN)
      ladder.push(free, wan)
    } else if (wantAudio) {
      add(fal, !!FAL_KEY) // audio
      add(selfHost, !!(V_BASE && V_KEY)) // audio
      add(deepinfra, !!DEEPINFRA_KEY) // silent
      add(hfWan, !!HF_TOKEN)
      ladder.push(free)
    } else {
      add(hfWan, !!HF_TOKEN) // best quality available with existing creds
      add(deepinfra, !!DEEPINFRA_KEY)
      add(selfHost, !!(V_BASE && V_KEY))
      add(fal, !!FAL_KEY)
      ladder.push(free)
    }
  }

  try {
    let lastErr = 'no video backend available'
    for (const b of ladder) {
      try {
        const out = await b.run()
        if (out.url) {
          // Report the clip length: fal honors the snapped request; other
          // backends are ~their native short length.
          const outSeconds = b.name === 'fal' && seconds ? snapLtxDuration(seconds) : undefined
          res.status(200).json({ url: out.url, name: 'Nalu Video', backend: b.name, ...(outSeconds ? { seconds: outSeconds } : {}) })
          return
        }
        if (out.error) lastErr = out.error
      } catch (e) {
        lastErr = e instanceof Error ? e.message : 'backend failed'
      }
    }
    await quota.release() // every backend failed — don't burn the user's daily slot
    res.status(502).json({ error: lastErr })
  } catch (err) {
    await quota.release() // error — refund the reserved daily slot
    res.status(500).json({ error: err instanceof Error ? err.message : 'video error' })
  }
}
