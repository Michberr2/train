// Nalu Slides — Vercel Node serverless function.
// Turns a request ("a pitch deck for X") into a structured slide deck, which the
// client previews inline and exports to .pptx (PowerPoint) / .pdf. "Nalu Slides".

import { cors } from './_cors'
import { groundFromPrompt } from './_grounding'
import { providerChain } from './_llm'
import { generateStudioJson } from './_studioGeneration'
import { STUDIO_FIDELITY } from './_studioInstructions'
import { studioMediaPreference, studioMediaInstruction } from './_studioMedia'
import { identityForRequest, identityBlock } from './_db'
import { SLIDE_DATA_CONTRACT, requestedContentSlides, validateGeneratedSlides } from './_slideValidation'
import { reserveStudioQuota, studioLimitMessage } from './_limits'
import { pickDesign, designDirective, designPayload, designById } from './_design'
import { SPECIALISTS } from './_specialists'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_MODEL = env('NALU_SLIDES_MODEL') || 'thinkingmachines/Inkling'

const SYSTEM = `You are a world-class presentation designer and storyteller (think YC pitch decks).
Build exactly the deck the user asks for — compelling narrative, crisp, investor/audience-ready.

HOUSE STYLE — confident and MINIMAL, lots of whitespace, plain-spoken authority. Keep the LANGUAGE TIGHT — short, punchy lines, not paragraphs; let each slide breathe (a great slide is a headline + 2–4 crisp lines, not a wall of text). Every "cover" / "image" description must be a REAL, specific, ON-TOPIC scene that fits THAT slide's subject AND the design language named below (a fintech deck → a clean trading-desk / product shot; a coffee brand → roasted beans, a café at golden hour; a healthcare deck → a modern clinic) — modern and photogenic, never a generic or cheap stock cliché.

IDENTITY: Write about "Nalu" (brand "Nalu AI", n4lu.ai) ONLY when the user's request is explicitly about Nalu, this assistant, or this app itself. For EVERY OTHER deck, build it GENERICALLY around the exact subject the user gave and do NOT insert "Nalu" anywhere — a generic request must never be branded "Nalu". If the deck needs a company / firm / author name the user did NOT provide, refer to it generically ("the company", "our team") or use a clear placeholder like "[Company Name]" — do NOT invent a name (never "Nexus", "Nexus AI", "Acme", etc.) and do NOT substitute "Nalu". Only use a specific company name the USER explicitly named. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title":string,"subtitle":string,"cover":string,"slides":[{"title":string,"layout":"bullets|stat|kpis|columns|chart|quote|table","bullets":[string],"stat":{"value":string,"label":string,"sub":string},"kpis":[{"value":string,"label":string,"delta":string}],"columns":[{"heading":string,"items":[string],"accent":boolean}],"quote":{"text":string,"attribution":string},"table":{"headers":[string],"rows":[[string]],"highlightCol":number},"chart":{"type":"bar|line|pie","title":string,"unit":string,"takeaway":string,"labels":[string],"series":[{"name":string,"values":[number]}]},"notes":string,"image":string}]}
Every slide sets "title", "layout", and "notes"; then fill ONLY that layout's field (plus optional "image"). Omit fields you don't use — never emit an empty layout field.

Rules:
DEPTH — make a complete, well-structured deck for the EXACT kind the user asked for, not a skeleton:
- Build the deck TYPE requested. When the user leaves the structure open, a pitch can cover vision, problem, solution, product, market, business model, traction, competition, team, financials, funding needs and milestones. Select the sections that fit the requested length and available material. Financial sections use supported figures or identify missing inputs; forecasts require an explicit request and labeled assumptions. Other deck types use their own structure, such as objectives/concepts/exercises for training or progress/blockers/next steps for a status update.
- Honor the requested slide count and whether the user includes the cover in that count. The top-level title/subtitle describe the separate cover; the slides array contains the content slides. If no length is specified, a quick deck can have 6–9 lean slides; an in-depth deck 12–18. Keep each slide uncluttered.
- Use each user-supplied slide title VERBATIM. Only when titles are not supplied, write a concise takeaway headline supported by the material. Use the requested bullet count; otherwise prefer 2–4 short lines and put supporting explanation in speaker notes.
- Include concrete details supported by the supplied material. Metrics, dates and owners belong only where provided or responsibly derived from that material. Generic training or advice can remain qualitative; a topic does not justify inventing company figures or assignments.
- USE THE ATTACHED SOURCE DEEPLY — when the request includes a document, data, memo, prior deck, or pasted context, BUILD FROM ITS REAL FIGURES. Use its actual names, metrics, dates and requests in the appropriate layouts. Never replace or contradict a source figure. If a needed figure is absent, omit it or mark it as unavailable; generate estimates only when requested and label them explicitly.
- "notes" = 1–3 sentences of genuinely useful speaker notes per slide (what to say / the point to land).
- "subtitle" is the deck's one-line tagline.
- "cover" = a vivid one-line PHOTO description for the title slide's full-bleed background image (a real, specific, photogenic scene tied to the topic — e.g. "modern glass office tower at dusk, golden light" — NOT a logo or chart). The app generates the photo from this.
- "image" (per slide) = a one-line photo description for slides that benefit from a supporting photo (product, market, team, vision, closing, problem) — a real photogenic scene, no text/charts. Lean toward INCLUDING a photo on most narrative slides; use "" for pure data/financial slides that carry a chart instead.
CHOOSE A LAYOUT PER SLIDE — honor any layout the user requests, including a consistent bullet format. Otherwise choose the layout that makes each point clear and vary layouts where the content benefits:
- "stat"    → the slide is really ONE number (a market inflection, a headline metric, the raise amount). Fill "stat" (huge value + short label + optional "sub" basis). You MAY add ≤2 supporting "bullets". Never bury a hero number in a bullet.
- "kpis"    → 3–4 numbers that belong together — UNIT ECONOMICS (CAC, LTV, LTV/CAC, payback, gross margin) or TRACTION (ARR, growth %, logos, net retention). 2–4 metric cards. This REPLACES listing metrics as bullets.
- "columns" → a contrast or pairing — Problem vs Solution, Before vs After, Us vs Them, GTM phases. 2–3 columns; mark the winning / "ours" column accent:true.
- "chart"   → a trend or distribution supported by available values (growth curve, market build-up, use-of-funds split). See PITCH CHARTS below.
- "table"   → a matrix — competitive comparison, pricing tiers, 3-year P&L. ≤5 columns, ≤6 rows; set highlightCol to our column.
- "quote"   → a single customer/partner testimonial or one-line thesis.
- "bullets" → ONLY for genuinely narrative slides (vision, product, team, roadmap): 2–4 short lines. This is now the EXCEPTION, not the default. Add an "image" on most of these.
Do NOT put a bullet list on a slide that is really a number, a comparison, or a trend.

PITCH CHARTS — when the source supplies the relevant figures and the requested length allows, investor decks benefit from charts on their own slides with layout:"chart". Choose those that support the request; no chart count is mandatory and missing figures must not be invented. Useful options:
  1. MARKET (TAM/SAM/SOM) → a bar chart only when the source supports the market values and their basis.
  2. TRACTION / GROWTH → a line chart of supplied ARR/MRR observations; derive growth only from those observations.
  3. UNIT ECONOMICS → a chart of supported CAC/LTV or other metrics. FINANCIAL PROJECTIONS are optional: include them only when requested, with assumptions and forecast periods explicitly labeled.
  4. THE ASK / USE OF FUNDS → a pie only when a raise amount and allocation are supplied or the user explicitly asks for a proposed allocation, clearly labeled as proposed.
Every chart includes "chart.takeaway" supported by its plotted values and "chart.unit" matching those values. Never substitute numeric placeholders for missing data. Instead name the missing inputs in a short list or table without fabricated values. Illustrative numbers and scenarios require an explicit request and clear labels.
Where the necessary figures are available, reconcile related values across the deck: TAM ≥ SAM ≥ SOM, ARR with the customer and contract basis, LTV/CAC with its inputs, traction with the growth series, and use-of-funds allocations with the raise amount. Do not force unsupported calculations just to populate a template.
For non-pitch decks, use charts only where a data relationship genuinely clarifies the point.

KEVIN HALE'S THREE LAWS (YC, "how to design a better pitch deck"):
- LEGIBLE — big bold type, high contrast, the point near the top. If a partner can't read it from the back of the room in 3 seconds, it's too small or too dense.
- SIMPLE — one main idea per slide. Keep the requested slide count and use concise organization rather than adding slides to enforce a style preference.
- OBVIOUS — make the point clear in the supporting content. Preserve supplied titles exactly; only choose takeaway titles when the user has left the titles open.
- A slide shows a photo OR a data layout, never both; kpis/columns/table/chart own the canvas.
- Adapt the arc to whatever presentation is asked, but keep the depth, specificity, and visual-variety bar high.`

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

// Escape literal control chars inside string values — the #1 reason model JSON fails.
function escapeCtrlInStrings(s: string): string {
  let out = '', inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) { out += ch; esc = false; continue }
      if (ch === '\\') { out += ch; esc = true; continue }
      if (ch === '"') { out += ch; inStr = false; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      out += ch; continue
    }
    if (ch === '"') inStr = true
    out += ch
  }
  return out
}
function extractJson(text: string): unknown | null {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const i = t.indexOf('{')
  if (i === -1) return null
  const j = t.lastIndexOf('}')
  const body = j > i ? t.slice(i, j + 1) : t.slice(i)
  const candidates = [body, repairJson(body), escapeCtrlInStrings(body), escapeCtrlInStrings(repairJson(body)), repairJson(escapeCtrlInStrings(body))]
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch { /* next */ }
  }
  return null
}

// Compress a specialist's long system prompt to its lead guidance (1–2 sentences).
function coreGuidance(p: string): string {
  const s = (p || '').replace(/\s+/g, ' ').trim()
  const cut = s.slice(0, 280)
  const dot = cut.lastIndexOf('. ')
  return (dot > 90 ? cut.slice(0, dot + 1) : cut).trim()
}

// Convene the RIGHT Nalu specialist models for this deck — the same domain experts
// the chat routes to (api/_specialists). Every pitch/investor/business deck ALWAYS
// gets Nalu Financial (a pitch lives or dies on its numbers); the deck's topic pulls
// in its own specialists too (Nalu Product, Nalu Marketing, Nalu CRE, …). Their real
// prompts — vocabulary, frameworks, metrics — are layered in so a "bunch of models"
// genuinely shape the content, not one generic voice.
function deckExperts(prompt: string): string {
  const p = prompt.toLowerCase()
  const kinds: string[] = []
  const isPitch = /\b(pitch|investor|fundrais\w*|raise|seed round|series\s*[a-e]\b|\bvc\b|venture|valuation|cap ?table|start-?up|business plan|go.?to.?market|\bgtm\b)\b/.test(p)
  if (isPitch) kinds.push('finance') // Nalu Financial — always in the room for a pitch
  for (const s of SPECIALISTS) {
    if (kinds.includes(s.kind) || !s.match) continue
    if (s.match.test(prompt)) kinds.push(s.kind)
    if (kinds.length >= 4) break
  }
  const chosen = kinds.slice(0, 3).map((k) => SPECIALISTS.find((s) => s.kind === k)).filter(Boolean) as { name: string; prompt: string }[]
  if (!chosen.length) return ''
  const panel = chosen.map((s) => `• ${s.name}: ${coreGuidance(s.prompt)}`).join('\n')
  const fin = isPitch
    ? "\n\nFINANCIAL REVIEW (Nalu Financial): within the requested structure, assess the financial questions relevant to this pitch: market sizing and basis, business model and pricing, unit economics, traction, cash needs, runway, and the funding request. Use only figures supplied by the user, supported by the source, or transparently derived from those inputs, retaining units and period labels. If inputs are missing, name what is needed (for example customer counts, contract values, acquisition spend, or cash balances) without fabricating values. Forecasts, proposed funding allocations and illustrative assumptions belong only when explicitly requested; label each as forecast, proposed or illustrative and state its basis. Supported metrics can use kpis, trends can use charts, and comparisons can use tables; missing inputs can remain a concise list. Reconcile figures wherever the necessary inputs exist. Financial rigor does not require adding unrequested slides or invented data."
    : ''
  return `\n\nEXPERT PANEL — write each section as the RIGHT specialist below, using their real vocabulary, frameworks and metrics (never generic filler):\n${panel}${fin}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const deadlineMs = Date.now() + 250000
  if (cors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  if (!providerChain(LLM_MODEL).length) {
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
  const mediaPreference = studioMediaPreference(prompt)
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
    const idBlock = identityBlock(await identityForRequest(req).catch(() => null))
    // Resolve ONE design language for this deck; it drives the render (client) AND the
    // copy + image art-direction (the directive below), so the deck is cohesively that
    // language instead of a generic template. On a revision, KEEP the prior deck's
    // language so an edit never restyles the whole deck.
    let prevDesignId = ''
    let previousSlides: unknown[] = []
    if (prevDeck) { try {
      const previous = JSON.parse(prevDeck)
      prevDesignId = previous?.design?.id || ''
      previousSlides = Array.isArray(previous?.slides) ? previous.slides : []
    } catch { /* ignore */ } }
    const design = (prevDesignId && designById(prevDesignId)) || pickDesign(prompt, 'deck')
    let validationIssues: string[] = []
    // JSON retries and provider failover share the original request deadline.
    const nudges = [
      '',
      '\n\nIMPORTANT: ensure the JSON is COMPLETE and valid — do not get cut off.',
      '\n\nCRITICAL — VALID JSON ONLY: output ONLY the minified JSON object. Inside every string value use \\n for line breaks and \\" for a quote — NEVER a literal newline or an unescaped double-quote. Ensure the JSON is complete and every bracket closes.',
    ]
    const parsed = await generateStudioJson({
      model: LLM_MODEL, deadlineMs, maxTokens: 16000, temperature: 0.55,
      messages: (attempt) => [
        { role: 'system', content: `${SYSTEM}\n\nToday is ${today}. Use it only for a requested current date; preserve supplied dates and never invent deadlines, timelines, or current figures.` + idBlock + deckExperts(prompt) + designDirective(design, 'deck') + nudges[attempt] + studioMediaInstruction(mediaPreference) + SLIDE_DATA_CONTRACT + (validationIssues.length ? '\n\nCORRECT THE PREVIOUS DECK: Return the complete JSON, preserving the source facts and requested content.\n' + validationIssues.slice(0, 5).join('\n') : '') + STUDIO_FIDELITY },
        { role: 'user', content: grounded + prompt + (prevDeck ? `\n\n----\nCURRENT DECK JSON (apply the change above to THIS deck; keep every other slide identical; output the complete updated JSON):\n${prevDeck}` : '') },
      ],
      parse: (content) => {
        const result = extractJson(content) as { title?: string; subtitle?: string; cover?: string; slides?: unknown[] } | null
        if (!result || !Array.isArray(result.slides) || (!result.slides.length && requestedContentSlides(prompt) !== 0)) return null
        const validated = validateGeneratedSlides(result.slides, prompt, previousSlides)
        validationIssues = validated.issues
        return validationIssues.length ? null : { ...result, slides: validated.slides }
      },
    })
    if (!parsed || !Array.isArray(parsed.slides)) {
      res.status(502).json({ error: validationIssues.length ? 'Could not produce a complete deck with consistent slide data and layout. Please retry or simplify the requested layout.' : 'Could not build the deck. Try rephrasing.' })
      return
    }
    // Apply the explicit media preference after lossless data validation.
    const slides = parsed.slides.map((slide) => {
      if (!mediaPreference.omitGenerated) return slide
      slide.image = '' // prompt compliance alone cannot guarantee a media opt-out
      if (/image|photo|picture|cover/i.test(String(slide.layout || ''))) {
        slide.layout = ['stat', 'kpis', 'columns', 'chart', 'quote', 'table'].find((kind) => slide[kind]) || 'bullets'
      }
      return slide
    })
    res.status(200).json({
      title: parsed.title || 'Presentation',
      subtitle: parsed.subtitle || '',
      cover: !mediaPreference.omitGenerated && typeof parsed.cover === 'string' ? parsed.cover : '',
      slides,
      design: designPayload(design),
      name: 'Nalu Slides',
    })
    succeeded = true
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'slides error' })
  } finally {
    if (!succeeded) await quota.release()
  }
}
