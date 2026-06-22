// Nalu video generation — Vercel Node serverless function.
// Three backends, in priority order:
//   1. fal.ai (FAL_KEY)            — no GPU, hosted, WITH synced AUDIO (Wan2.5/Veo3/Sora2)
//   2. self-hosted (NALU_VIDEO_*)  — your own LTX-2 box, WITH AUDIO
//   3. free HF Space (default)     — anonymous, no key, no GPU, but SILENT + best-effort
// So video WORKS out of the box (free, silent); add FAL_KEY or self-host for audio.

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const FAL_KEY = env('FAL_KEY') || env('FAL_API_KEY') || ''
const FAL_MODEL = env('FAL_VIDEO_MODEL') || 'fal-ai/wan-2.5/text-to-video'

const V_BASE = (env('NALU_VIDEO_BASE_URL') || '').replace(/\/+$/, '')
const V_KEY = env('NALU_VIDEO_API_KEY') || ''
const V_MODEL = env('NALU_VIDEO_MODEL') || 'ltx-2.3'

// Free, keyless fallback: a public LTX-Video Space (silent, ZeroGPU, best-effort).
const HF_SPACE = (env('NALU_VIDEO_FREE_SPACE') || 'https://lightricks-ltx-video-distilled.hf.space').replace(
  /\/+$/,
  '',
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Motion-aware prompt enrichment so "a wolf running" actually RUNS (the raw
// models often render a static subject). Reuses the Tinker LLM.
const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_VIDEO_PROMPT_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

async function enrichVideoPrompt(prompt: string): Promise<string> {
  const fallback = `${prompt}, strong dynamic motion, subject actively moving, smooth camera tracking, cinematic, ultra-detailed 4k`
  if (!LLM_KEY) return fallback
  try {
    const r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              "Rewrite the user's request into ONE vivid text-to-VIDEO prompt that emphasizes clear, continuous MOTION and action — state explicitly WHAT is moving and HOW (e.g. running at full speed, legs pumping, snow kicking up), plus camera movement and cinematic, ultra-detailed 4k look. If a subject should run/move, make the motion energetic and obvious. Output ONLY the final prompt, no preamble, under 60 words.",
          },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!r.ok) return fallback
    const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let out = d?.choices?.[0]?.message?.content
    if (typeof out !== 'string' || !out.trim()) return fallback
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
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

// ---- 1) fal.ai (audio) ----
async function falVideo(prompt: string): Promise<{ url?: string; error?: string }> {
  const submit = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      duration: 5,
      aspect_ratio: '16:9',
      generate_audio: true,
      resolution: env('FAL_VIDEO_RESOLUTION') || '1080p', // set 4k on a 4K-capable model
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
    await sleep(3000)
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
    body: JSON.stringify({ model: V_MODEL, prompt }),
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

async function freeSpaceOnce(prompt: string): Promise<{ url?: string; busy?: boolean; error?: string }> {
  // duration 4s (was 2s) so running/motion actually reads; keep distilled-friendly
  // guidance (1) + proven resolution; negative prompt discourages a static/walking subject.
  const payload = {
    data: [prompt, 'static, still, motionless, frozen, standing, walking slowly, low quality, blurry, distorted', null, null, 512, 704, 'text-to-video', 4, 9, 42, true, 1, true],
  }
  const sub = await fetch(`${HF_SPACE}/gradio_api/call/text_to_video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!sub.ok) return { busy: true, error: `submit ${sub.status}` }
  const { event_id } = (await sub.json().catch(() => ({}))) as { event_id?: string }
  if (!event_id) return { busy: true, error: 'no job id' }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 140000)
  try {
    const stream = await fetch(`${HF_SPACE}/gradio_api/call/text_to_video/${event_id}`, { signal: ctrl.signal })
    if (!stream.ok) return { busy: true, error: `poll ${stream.status}` }
    const url = extractHfVideo(await stream.text())
    return url ? { url } : { busy: true, error: 'empty result' }
  } catch {
    return { busy: true, error: 'stream timeout' }
  } finally {
    clearTimeout(t)
  }
}

async function freeSpaceVideo(prompt: string): Promise<{ url?: string; error?: string }> {
  // The free space is a shared ZeroGPU pool — retry a couple times on transient busy.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(5000)
    const r = await freeSpaceOnce(prompt)
    if (r.url) return { url: r.url }
  }
  return {
    error:
      'Free video is busy right now (shared community GPU has limited quota). Wait a minute and try again — or add a free FAL_KEY for instant, unlimited video with audio.',
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
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

  try {
    const out = FAL_KEY
      ? await falVideo(prompt)
      : V_BASE && V_KEY
        ? await customVideo(prompt)
        : await freeSpaceVideo(prompt)
    if (out.url) {
      res.status(200).json({ url: out.url, name: 'Nalu Video' })
    } else {
      res.status(502).json({ error: out.error || 'no video returned' })
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'video error' })
  }
}
