// Nalu Slides — Vercel Node serverless function.
// Turns a request ("a pitch deck for X") into a structured slide deck, which the
// client previews inline and exports to .pptx (PowerPoint) / .pdf. "Nalu Slides".

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_SLIDES_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class presentation designer and storyteller (think YC pitch decks).
Build exactly the deck the user asks for — compelling narrative, crisp, investor/audience-ready.

IDENTITY: If the deck is about "Nalu" — or about the assistant/company itself, or no company is named — the company is **Nalu** (brand "Nalu AI", website n4lu.ai). Use the name Nalu / Nalu AI consistently. NEVER invent or substitute a different company name (e.g. never "Nexus", "Nexus AI", "Acme", etc.). Only use a different company name if the USER explicitly names one. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title": string, "subtitle": string, "cover": string, "slides": [ {"title": string, "bullets": [string], "notes": string, "image": string, "chart": {"type":"bar|line|pie","title":string,"labels":[string],"series":[{"name":string,"values":[number]}]}} ]}

Rules:
DEPTH — make a complete, investor-ready deck, not a skeleton:
- 10–13 slides with a real narrative arc. For a pitch deck: Title, Vision/Mission, Problem, Why Now, Solution, Product (how it works), Market (TAM/SAM/SOM with real numbers), Business Model & Pricing, Go-to-Market, Traction/Metrics, Competition (positioning), Team, Financials/Projections, The Ask & Use of Funds, Roadmap, Closing.
- Each slide: a punchy title and 3–5 concise, high-impact bullets carrying SPECIFIC facts — real figures, percentages, dollar amounts, dates, named comparables. No vague filler, no lorem ipsum.
- Include concrete numbers throughout (market sizes, growth rates, unit economics, milestones, funding amount).
- "notes" = 1–3 sentences of genuinely useful speaker notes per slide (what to say / the point to land).
- "subtitle" is the deck's one-line tagline.
- "cover" = a vivid one-line PHOTO description for the title slide's full-bleed background image (a real, specific, photogenic scene tied to the topic — e.g. "modern glass office tower at dusk, golden light" — NOT a logo or chart). The app generates the photo from this.
- "image" (per slide) = a one-line photo description for slides that benefit from a supporting photo (product, market, team, vision, closing, problem) — a real photogenic scene, no text/charts. Lean toward INCLUDING a photo on most narrative slides; use "" for pure data/financial slides that carry a chart instead.
- "chart" (per slide) = real statistics visualized, for slides about numbers (market size, growth, revenue, traction, unit economics, funding use, financial projections). "type" bar/line/pie; "labels" the x-axis or pie categories; "series" one or more named data series of numbers aligned to labels. Use REAL, specific, internally-consistent figures. Include a chart on AT LEAST 3–5 data slides. Omit "chart" (or use empty) on slides that are purely narrative.
- A slide may have a photo OR a chart (not both). Prefer charts on data slides, photos on story slides.
- Adapt the arc to whatever presentation is asked, but keep the depth and specificity bar high.`

function repairJson(s: string): string {
  let inStr = false
  let esc = false
  const stack: string[] = []
  let lastSafe = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') { inStr = false; lastSafe = i + 1 }
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') { stack.pop(); lastSafe = i + 1 }
    else if (ch === ',') lastSafe = i + 1
  }
  let out = s.slice(0, lastSafe).replace(/[\s,]+$/, '')
  out = out.replace(/,?\s*"(?:\\.|[^"\\])*"\s*:\s*[^,{}[\]]*$/, '')
  out = out.replace(/[\s,]+$/, '')
  while (stack.length) out += stack.pop()
  return out
}

function extractJson(text: string): unknown | null {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const i = t.indexOf('{')
  if (i === -1) return null
  const j = t.lastIndexOf('}')
  if (j > i) {
    try { return JSON.parse(t.slice(i, j + 1)) } catch { /* repair */ }
  }
  try { return JSON.parse(repairJson(t.slice(i))) } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  if (!LLM_KEY) {
    res.status(500).json({ error: 'Nalu engine is not configured.' })
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
    const upstream = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        max_tokens: 7000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '')
      res.status(502).json({ error: `Slides upstream ${upstream.status}: ${t.slice(0, 200)}` })
      return
    }
    const d = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const parsed = extractJson(d?.choices?.[0]?.message?.content || '') as
      | { title?: string; subtitle?: string; cover?: string; slides?: unknown[] }
      | null
    if (!parsed || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      res.status(502).json({ error: 'Could not build the deck. Try rephrasing.' })
      return
    }
    res.status(200).json({
      title: parsed.title || 'Presentation',
      subtitle: parsed.subtitle || '',
      cover: typeof parsed.cover === 'string' ? parsed.cover : '',
      slides: parsed.slides,
      name: 'Nalu Slides',
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'slides error' })
  }
}
