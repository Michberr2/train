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

DEPTH — thorough and professional, but COMPLETE and never cut off (this matters more than length):
- 5–7 major (level-1) sections. Open with a concise Executive Summary (2–3 paragraphs).
- 1–3 substantive paragraphs per section — real analysis with specific numbers and named examples. No one-liners, no filler, no lorem ipsum.
- Include exactly 1 "chart" block (real, internally-consistent numbers) and 2–3 "table" blocks with real data (e.g. financial projections, market sizing, competitor comparison, milestones, KPIs).
- Use bullets for crisp lists; prefer rich paragraphs for analysis.
- Adapt sections to the document type. A business plan typically covers: Executive Summary, Market & Opportunity, Product/Service, Business Model & Pricing, Go-to-Market, Financial Plan, Milestones, Risks.
- "subtitle" may be an empty string.
CRITICAL: the output MUST be a single COMPLETE, valid minified JSON object — finish every block and close all brackets/quotes. If you are running long, wrap up and close the JSON rather than getting cut off. Favor a complete document over an extra section.`

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

  // Generate once; if the JSON can't be parsed (rare truncation), retry once
  // with a slightly tighter nudge — so docs don't intermittently fail.
  const gen = async (extra: string): Promise<{ title?: string; subtitle?: string; cover?: string; blocks?: unknown[] } | null> => {
    const upstream = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        max_tokens: 11000, // headroom so a full document never truncates
        messages: [
          { role: 'system', content: SYSTEM + extra },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!upstream.ok) throw new Error(`Doc upstream ${upstream.status}: ${(await upstream.text().catch(() => '')).slice(0, 200)}`)
    const d = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return extractJson(d?.choices?.[0]?.message?.content || '') as { title?: string; subtitle?: string; cover?: string; blocks?: unknown[] } | null
  }

  try {
    let parsed = await gen('')
    if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
      parsed = await gen('\n\nIMPORTANT: keep it focused (5–6 sections) and ensure the JSON is COMPLETE and valid — do not get cut off.')
    }
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
