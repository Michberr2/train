// Nalu spreadsheet builder — Vercel Node serverless function.
// Turns a natural-language request into a structured workbook (sheets, columns,
// rows, and real Excel formulas), which the client renders + exports to
// .xlsx / .pdf. Branded "Nalu Sheets"; provider hidden.

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_BASE = (
  env('GLM_BASE_URL') || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
).replace(/\/+$/, '')
const LLM_KEY = env('GLM_API_KEY') || ''
const LLM_MODEL = env('NALU_SHEET_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class spreadsheet engineer — better than anyone at Excel.
Build exactly the spreadsheet the user asks for, with realistic, correct, useful data.

IDENTITY: If the spreadsheet is about "Nalu" — or about the assistant/company itself, or no company is named — the company is **Nalu** (brand "Nalu AI", website n4lu.ai). NEVER invent or substitute a different company name (e.g. never "Nexus", "Nexus AI", "Acme"). Only use a different company name if the USER explicitly names one. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title": string, "sheets": [{"name": string, "columns": [string], "rows": [[cell]]}]}

DEPTH — this is critical. Build a real, multi-tab MODEL, not a toy table:
- Produce MULTIPLE sheets when the topic warrants it (it usually does). E.g. a financial model = "Assumptions", "Revenue", "Expenses", "P&L", "Cash Flow", "Summary/Dashboard". A budget = "Assumptions", "Monthly Detail" (12 months), "Summary". A plan = inputs + calc + output tabs.
- Make tables WIDE and DEEP: typically 8–16 columns and 20–60 data rows of realistic, specific values (real categories, names, dates, amounts) — not 3 placeholder rows.
- Use REAL Excel formulas heavily, as strings starting with "=" with correct A1 references: arithmetic ("=B2*C2"), aggregates ("=SUM(B2:B25)","=AVERAGE(...)","=MAX(...)"), growth ("=B2*(1+$B$3)"), conditionals ("=IF(...)","=SUMIF(...)","=COUNTIF(...)"), look-ups ("=VLOOKUP(...)"/"=XLOOKUP(...)"), and percentages/margins. Totals rows AND derived columns should be formulas, not hardcoded.
- Use absolute refs ($B$3) for assumptions referenced across rows. Reference other sheets where natural ("=Assumptions!B4") to wire the model together.
- Add a total/summary row and, where useful, a small KPI/dashboard sheet.
- Be precise, internally consistent, and genuinely useful — this should look like a model a finance professional built.`

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
      res.status(502).json({ error: `Sheet upstream ${upstream.status}: ${t.slice(0, 200)}` })
      return
    }
    const d = (await upstream.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = d?.choices?.[0]?.message?.content || ''
    const parsed = extractJson(content) as { title?: string; sheets?: unknown[] } | null
    if (!parsed || !Array.isArray(parsed.sheets) || parsed.sheets.length === 0) {
      res.status(502).json({ error: 'Could not build the spreadsheet. Try rephrasing.' })
      return
    }
    res.status(200).json({ title: parsed.title || 'Spreadsheet', sheets: parsed.sheets, name: 'Nalu Sheets' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'sheet error' })
  }
}
