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

function parseSize(s: unknown): { w: number; h: number } {
  if (typeof s === 'string') {
    const m = s.toLowerCase().split('x')
    const w = parseInt(m[0], 10)
    const h = parseInt(m[1], 10)
    if (w > 0 && h > 0) return { w, h }
  }
  return { w: 1024, h: 1024 }
}

// Prompt enrichment: before drawing, have the LLM expand the request into a
// detailed, PHOTOREALISTIC prompt — and accurately describe any specific named
// thing it knows (e.g. a "Blue Bay Shepherd") so the image is correct, not a
// guess. Falls back to a realism suffix if the LLM is unavailable.
const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_IMAGE_PROMPT_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

function realism(p: string): string {
  return `${p}, photorealistic, ultra-detailed, natural lighting, realistic skin and textures, shallow depth of field, sharp focus, shot on a DSLR, 8k`
}

async function enrichPrompt(prompt: string): Promise<string> {
  if (!LLM_KEY) return realism(prompt)
  try {
    const r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              "Turn the user's image request into ONE vivid, photorealistic text-to-image prompt. If it names a specific real thing (a dog breed like a Blue Bay Shepherd, a landmark, a person, a product), accurately describe its real visual appearance from your knowledge so the image is correct. Emphasize photorealism: natural lighting, realistic textures and skin, depth of field, high detail, DSLR look. Output ONLY the final prompt — no preamble, no quotes, under 90 words.",
          },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!r.ok) return realism(prompt)
    const d = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let out = d?.choices?.[0]?.message?.content
    if (typeof out !== 'string' || !out.trim()) return realism(prompt)
    out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return out || realism(prompt)
  } catch {
    return realism(prompt)
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
  const { w, h } = parseSize(body.size)
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }

  try {
    // Understand the subject + make it photorealistic before generating.
    const finalPrompt = await enrichPrompt(prompt)

    // 1) Configured OpenAI-compatible endpoint (e.g. self-hosted Z-Image-Turbo).
    if (CFG_BASE && CFG_KEY) {
      const upstream = await fetch(`${CFG_BASE}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CFG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CFG_MODEL, prompt: finalPrompt, size: `${w}x${h}` }),
      })
      const text = await upstream.text()
      if (!upstream.ok) {
        res.status(502).json({ error: `Image upstream ${upstream.status}: ${text.slice(0, 300)}` })
        return
      }
      let data: { data?: Array<{ url?: string; b64_json?: string }> } = {}
      try {
        data = JSON.parse(text)
      } catch {
        res.status(502).json({ error: 'bad image response' })
        return
      }
      const first = data?.data?.[0]
      const url = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '')
      if (!url) {
        res.status(502).json({ error: 'no image returned' })
        return
      }
      res.status(200).json({ url, name: 'Nalu Image' })
      return
    }

    // 2) Free zero-config fallback — the image is generated on load of this URL.
    const seed = Math.floor(Math.random() * 1e9)
    const url =
      `${FREE_BASE}/prompt/${encodeURIComponent(finalPrompt)}` +
      `?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(FREE_MODEL)}&seed=${seed}`
    res.status(200).json({ url, name: 'Nalu Image' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'image error' })
  }
}
