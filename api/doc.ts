// Nalu document builder — Vercel Node serverless function.
// Turns a request ("build me a business plan…") into a structured, well-organized
// document (title, headings, paragraphs, bullets, tables) that the client renders
// and exports to .docx (Word) / .pdf. Branded "Nalu Docs"; provider hidden.

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_DOC_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class business writer and document designer.
Produce exactly the document the user asks for (business plan, report, proposal, essay, letter, memo, etc.) — thorough, well-structured, and professional.

IDENTITY: If the document is about "Nalu" — or about the assistant/company itself, or no company is named — the company is **Nalu** (brand "Nalu AI", website n4lu.ai). Use the name Nalu / Nalu AI consistently. NEVER invent or substitute a different company name (e.g. never "Nexus", "Nexus AI", "Acme", etc.). Only use a different company name if the USER explicitly names one. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title": string, "subtitle": string, "cover": string, "blocks": [ Block ]}
where "cover" is a vivid one-line PHOTO description for the document's cover page background (a real, specific, photogenic scene tied to the topic — e.g. "aerial view of a modern residential development at golden hour" — NOT a logo or chart; the app generates the photo from this)
where each Block is one of:
  {"type":"heading","level":1|2|3,"text":string}
  {"type":"paragraph","text":string}
  {"type":"bullets","items":[string]}
  {"type":"table","columns":[string],"rows":[[string]]}
  {"type":"chart","chart":{"type":"bar|line|pie","title":string,"labels":[string],"series":[{"name":string,"values":[number]}]}}

DEPTH — this is critical. Produce a LONG, comprehensive, consulting-grade document, not a summary:
- Include 1–2 "chart" blocks visualizing real statistics (market sizing, growth, revenue projections, segment share, KPIs) with specific, internally-consistent numbers — place each chart near the section that discusses it.
- Aim for 6–9 major (level-1) sections, each with 1–2 sub-sections where it helps.
- Write 2–4 full, substantive paragraphs per sub-section — real analysis, specific numbers, named examples, concrete detail. NEVER one-liners, never filler, never lorem ipsum.
- Include MULTIPLE tables with real data: financial projections (3–5 year P&L), unit economics, market sizing (TAM/SAM/SOM), competitor comparison, timelines/milestones, KPIs, pricing tiers, risk register.
- Use bullets for crisp lists, but prefer rich paragraphs for analysis.
- Open with a real Executive Summary (3–5 paragraphs).
- A business plan must cover: Executive Summary, Company Overview, Problem & Opportunity, Market Analysis (with sizing), Product/Service, Business Model & Pricing, Go-to-Market & Sales, Operations, Technology, Management & Org, Competitive Landscape, Financial Plan (projections + assumptions), Funding Ask & Use of Funds, Milestones & Roadmap, Risks & Mitigations.
- Adapt the section set to whatever document type is asked (report, proposal, white paper, memo) but keep the same depth bar.
- "subtitle" may be an empty string. Be exhaustive, specific, and genuinely useful — this should read like a $25k consulting deliverable.`

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
        max_tokens: 8000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '')
      res.status(502).json({ error: `Doc upstream ${upstream.status}: ${t.slice(0, 200)}` })
      return
    }
    const d = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = d?.choices?.[0]?.message?.content || ''
    const parsed = extractJson(content) as { title?: string; subtitle?: string; cover?: string; blocks?: unknown[] } | null
    if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      res.status(502).json({ error: 'Could not build the document. Try rephrasing.' })
      return
    }
    res.status(200).json({
      title: parsed.title || 'Document',
      subtitle: parsed.subtitle || '',
      cover: typeof parsed.cover === 'string' ? parsed.cover : '',
      blocks: parsed.blocks,
      name: 'Nalu Docs',
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'doc error' })
  }
}
