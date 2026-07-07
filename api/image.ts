// Nalu image generation — Vercel Node serverless function.
// Returns a generated image for a prompt. Branded "Nalu Image"; provider hidden.
//
// Two backends, in priority order:
//  1. A configured OpenAI-compatible endpoint (your self-hosted Z-Image-Turbo,
//     or any /images/generations provider) — set:
//        NALU_IMAGE_BASE_URL  e.g. https://<your-tunnel>/v1
//        NALU_IMAGE_API_KEY   the server bearer
//        NALU_IMAGE_MODEL     e.g. z-image-turbo   (falls back to ZAI_*)
//  2. Free zero-config fallback (no key) so image gen works out of the box.
//     Override the free endpoint with NALU_IMAGE_FALLBACK_BASE if desired.

import { cors } from './_cors'
import { chatComplete } from './_llm'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const CFG_BASE = (env('NALU_IMAGE_BASE_URL') || env('ZAI_BASE_URL') || '').replace(/\/+$/, '')
const CFG_KEY = env('NALU_IMAGE_API_KEY') || env('ZAI_API_KEY') || ''
const CFG_MODEL = env('NALU_IMAGE_MODEL') || env('ZAI_IMAGE_MODEL') || 'z-image-turbo'
// Free, keyless fallback (FLUX-based). Used when no endpoint is configured.
const FREE_BASE = (env('NALU_IMAGE_FALLBACK_BASE') || 'https://image.pollinations.ai').replace(/\/+$/, '')
const FREE_MODEL = env('NALU_IMAGE_FALLBACK_MODEL') || 'flux'

// PRIMARY backend: Google Gemini image ("Nano Banana" / Nano Banana Pro) — SOTA
// quality, and we already hold the key for Veo video. Best photorealism + prompt
// adherence + legible in-image text, far above the free FLUX fallback.
const GEMINI_KEY = env('GEMINI_API_KEY') || env('GOOGLE_AI_API_KEY') || env('GOOGLE_GENAI_API_KEY') || ''
const GEMINI_IMAGE_MODELS = (env('NALU_IMAGE_GEMINI_MODELS') || 'gemini-3-pro-image-preview,gemini-2.5-flash-image')
  .split(',').map((m) => m.trim()).filter(Boolean)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// Map pixel dims to the nearest aspect ratio Gemini accepts.
function aspectRatio(w: number, h: number): string {
  const r = w / h
  const opts: Array<[string, number]> = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3]]
  return opts.reduce((best, o) => (Math.abs(o[1] - r) < Math.abs(best[1] - r) ? o : best), opts[0])[0]
}

// Generate with Gemini → data URL (base64), or null to fall through.
async function geminiImage(prompt: string, w: number, h: number): Promise<string | null> {
  if (!GEMINI_KEY) return null
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspectRatio(w, h) } },
  }
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => { try { ac.abort() } catch { /* */ } }, 55000)
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
      }).finally(() => clearTimeout(timer))
      if (!r.ok) continue
      const d = (await r.json().catch(() => null)) as
        | { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }> } }> }
        | null
      const parts = d?.candidates?.[0]?.content?.parts || []
      for (const p of parts) {
        const inl = p.inlineData || p.inline_data
        const data = inl?.data
        const mime = (inl as { mimeType?: string; mime_type?: string })?.mimeType || (inl as { mime_type?: string })?.mime_type || 'image/png'
        if (data && data.length > 1000) return `data:${mime};base64,${data}`
      }
    } catch { /* try next model / fall through */ }
  }
  return null
}

// Fetch a generated image URL and inline it as a data URL (retries) so the client
// ALWAYS gets a stable image instead of a flaky generate-on-load link.
async function bakeUrl(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => { try { ac.abort() } catch { /* */ } }, 40000)
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal }).finally(() => clearTimeout(timer))
      const ct = r.headers.get('content-type') || ''
      if (r.ok && ct.startsWith('image/')) {
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 2000) return `data:${ct};base64,${buf.toString('base64')}`
      }
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)))
  }
  return null
}

function parseSize(s: unknown): { w: number; h: number } {
  if (typeof s === 'string') {
    const m = s.toLowerCase().split('x')
    const w = parseInt(m[0], 10)
    const h = parseInt(m[1], 10)
    if (w > 0 && h > 0) return { w, h }
  }
  return { w: 1024, h: 1024 }
}

// Prompt enrichment: before drawing, expand the request into ONE vivid prompt in
// the STYLE the user actually wants (photo, vector, logo, anime, 3D, watercolor…)
// — not photoreal forced onto everything — and accurately describe any specific
// named thing. Falls back to a style-neutral suffix if the LLM is unavailable.
const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_IMAGE_PROMPT_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

// Heuristic: does the request explicitly ask for a non-photographic medium?
const NON_PHOTO = /\b(logo|icon|vector|flat|illustrat|anime|manga|cartoon|pixel|sketch|drawing|doodle|watercolou?r|oil painting|gouache|line art|low ?poly|3d render|isometric|comic|sticker|emoji|wireframe|blueprint|infographic|poster art|minimalist|abstract)\b/i

function realism(p: string): string {
  if (NON_PHOTO.test(p)) return `${p}, clean, high quality, crisp, well-composed, high detail`
  return `${p}, photorealistic, ultra-detailed, natural lighting, realistic skin and textures, shallow depth of field, sharp focus, 8k`
}

async function enrichPrompt(prompt: string): Promise<string> {
  if (!LLM_KEY) return realism(prompt)
  try {
    const out = (
      await chatComplete(
        [
          {
            role: 'system',
            content:
              "Turn the user's image request into ONE vivid text-to-image prompt. FIRST infer the intended MEDIUM/STYLE: if they ask for a logo, icon, vector, flat/line illustration, anime, cartoon, pixel art, 3D render, oil/watercolor painting, sketch, or any named art style, HONOR that style and describe it richly — do NOT add photographic terms (no 'DSLR', 'photorealistic', 'skin texture'). ONLY when the subject is clearly a real photo (a person, place, animal, product) or no style is given, add photoreal cues: natural lighting, realistic textures, depth of field, sharp focus, high detail. If it names a specific real thing (a dog breed, a landmark, a product), describe its real appearance accurately so the image is correct. Output ONLY the final prompt — no preamble, no quotes, under 90 words.",
          },
          { role: 'user', content: prompt },
        ],
        { model: LLM_MODEL, maxTokens: 320, timeoutMs: 20000, temperature: 0.7 },
      )
    )
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .trim()
    return out || realism(prompt)
  } catch {
    return realism(prompt)
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
  const { w, h } = parseSize(body.size)
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }

  try {
    // Understand the subject + render it in the right style before generating.
    const finalPrompt = await enrichPrompt(prompt)

    // 1) PRIMARY — Google Gemini image ("Nano Banana"): SOTA quality. Returns a
    //    baked data URL so it always loads. Falls through on any failure.
    const gem = await geminiImage(finalPrompt, w, h)
    if (gem) {
      res.status(200).json({ url: gem, name: 'Nalu Image' })
      return
    }

    // 2) Configured OpenAI-compatible endpoint (e.g. self-hosted Z-Image-Turbo).
    //    On ANY failure, fall THROUGH to the free fallback instead of 502'ing —
    //    a configured-provider blip should never block image generation.
    if (CFG_BASE && CFG_KEY) {
      try {
        const ac = new AbortController()
        const timer = setTimeout(() => { try { ac.abort() } catch { /* noop */ } }, 45000)
        const upstream = await fetch(`${CFG_BASE}/images/generations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CFG_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: CFG_MODEL, prompt: finalPrompt, size: `${w}x${h}` }),
          signal: ac.signal,
        }).finally(() => clearTimeout(timer))
        if (upstream.ok) {
          const data = (await upstream.json().catch(() => ({}))) as { data?: Array<{ url?: string; b64_json?: string }> }
          const first = data?.data?.[0]
          const url = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '')
          if (url) {
            res.status(200).json({ url, name: 'Nalu Image' })
            return
          }
        }
      } catch {
        /* fall through to the free fallback */
      }
    }

    // 3) Free zero-config fallback (FLUX). Try to BAKE it into a data URL so it
    //    reliably loads; if baking fails, return the generate-on-load URL as a
    //    last resort (better a slow image than none).
    const seed = Math.floor(Math.random() * 1e9)
    const url =
      `${FREE_BASE}/prompt/${encodeURIComponent(finalPrompt)}` +
      `?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(FREE_MODEL)}&seed=${seed}`
    const baked = await bakeUrl(url)
    res.status(200).json({ url: baked || url, name: 'Nalu Image' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'image error' })
  }
}
