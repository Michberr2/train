// Nalu Slides — Vercel Node serverless function.
// Turns a request ("a pitch deck for X") into a structured slide deck, which the
// client previews inline and exports to .pptx (PowerPoint) / .pdf. "Nalu Slides".

import { cors } from './_cors'
import { groundFromPrompt } from './_grounding'
import { chatCompleteContinued } from './_llm'
import { identityForRequest, identityBlock } from './_db'
import { normalizeChart } from './_validate'
import { reserveStudioQuota, studioLimitMessage } from './_limits'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_SLIDES_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class presentation designer and storyteller (think YC pitch decks).
Build exactly the deck the user asks for — compelling narrative, crisp, investor/audience-ready.

HOUSE STYLE — quiet, timeless luxury (think Four Seasons / Hillpointe): refined, calm, confident; elegant restraint over flashy. Crisp editorial copy. Every "cover" / "image" description must be premium and cinematic (serene, architectural, aspirational — e.g. "modern residential community at golden hour, calm and luxurious"), never a busy or cheap stock scene.

IDENTITY: If the deck is about "Nalu" — or about the assistant/company itself, or no company is named — the company is **Nalu** (brand "Nalu AI", website n4lu.ai). Use the name Nalu / Nalu AI consistently. NEVER invent or substitute a different company name (e.g. never "Nexus", "Nexus AI", "Acme", etc.). Only use a different company name if the USER explicitly names one. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title": string, "subtitle": string, "cover": string, "slides": [ {"title": string, "bullets": [string], "notes": string, "image": string, "chart": {"type":"bar|line|pie","title":string,"labels":[string],"series":[{"name":string,"values":[number]}]}} ]}

Rules:
DEPTH — make a complete, well-structured deck for the EXACT kind the user asked for, not a skeleton:
- Build the deck TYPE requested and use the section structure that fits it — do NOT force a pitch-deck arc onto everything. For a PITCH deck: Title, Vision/Mission, Problem, Why Now, Solution, Product, Market (TAM/SAM/SOM with real numbers), Business Model & Pricing, Go-to-Market, Traction/Metrics, Competition, Team, Financials/Projections, The Ask & Use of Funds, Roadmap, Closing. For OTHER deck types use their natural structure instead — e.g. a TRAINING/lesson deck (objectives → concepts → examples → exercises → summary), a SALES deck, a PROJECT/status update, a RESEARCH or report deck, a webinar/keynote, a course, a product launch, a board update, etc. Match the user's topic and purpose.
- 8–14 slides with a real narrative arc appropriate to that deck type.
- Each slide title should be a MESSAGE — the takeaway, not a label. Use "Revenue tripled to $4.2M in 18 months", not "Revenue". 3–5 tight bullets, each a concrete claim with a real figure, percentage, date, or named example — never an abstract category ("Scalability", "Synergies") and never lorem ipsum. Every bullet should make the audience think "that's a specific, real point," not a placeholder.
- Include concrete, specific details and numbers WHERE THEY FIT the topic (for a pitch: market sizes, growth, unit economics, funding; for a lesson: examples, steps, data; for a status update: metrics, dates, owners). Don't shoehorn startup/funding numbers into a deck that isn't about that.
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
  if (cors(req, res)) return
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
  const prevDeck = typeof body.prevDeck === 'string' && body.prevDeck.length > 50 ? body.prevDeck.slice(0, 90000) : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }
  const grounded = await groundFromPrompt(prompt)
  const today = new Date().toISOString().slice(0, 10)
  const quota = await reserveStudioQuota(req, 'slides')
  if (!quota.ok) {
    res.status(429).json({ error: studioLimitMessage('deck', quota) })
    return
  }
  let succeeded = false
  try {
    // Robust: timeout + provider failover + truncation continuation (so the closing
    // slides never vanish). JSON mode + a moderate temperature for crisp, valid output.
    const { content } = await chatCompleteContinued(
      [
        { role: 'system', content: `${SYSTEM}\n\nToday is ${today}; use it for any dates, timelines, or "current" figures.` + identityBlock(await identityForRequest(req).catch(() => null)) },
        { role: 'user', content: grounded + prompt + (prevDeck ? `\n\n----\nCURRENT DECK JSON (apply the change above to THIS deck; keep every other slide identical; output the complete updated JSON):\n${prevDeck}` : '') },
      ],
      { model: LLM_MODEL, maxTokens: 10000, timeoutMs: 90000, retryPrimary: false, temperature: 0.55, json: true },
    )
    const parsed = extractJson(content) as
      | { title?: string; subtitle?: string; cover?: string; slides?: unknown[] }
      | null
    if (!parsed || !Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      res.status(502).json({ error: 'Could not build the deck. Try rephrasing.' })
      return
    }
    // Coerce every chart's values to finite numbers + normalize shape, so a
    // string like "$4.2M" never renders a blank chart. Drop unusable charts.
    const slides = parsed.slides.map((s) => {
      if (s && typeof s === 'object' && 'chart' in s && (s as { chart?: unknown }).chart) {
        const nc = normalizeChart((s as { chart?: unknown }).chart)
        const { chart: _omit, ...rest } = s as Record<string, unknown>
        return nc ? { ...rest, chart: nc } : rest
      }
      return s
    })
    res.status(200).json({
      title: parsed.title || 'Presentation',
      subtitle: parsed.subtitle || '',
      cover: typeof parsed.cover === 'string' ? parsed.cover : '',
      slides,
      name: 'Nalu Slides',
    })
    succeeded = true
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'slides error' })
  } finally {
    if (!succeeded) await quota.release()
  }
}
