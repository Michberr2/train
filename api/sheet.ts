// Nalu spreadsheet builder — Vercel Node serverless function.
// Turns a natural-language request into a structured workbook (sheets, columns,
// rows, and real Excel formulas), which the client renders + exports to
// .xlsx / .pdf. Branded "Nalu Sheets"; provider hidden.

import { cors } from './_cors'
import { groundFromPrompt } from './_grounding'
import { chatCompleteContinued } from './_llm'
import { identityForRequest, identityBlock } from './_db'
import { normalizeSheets } from './_validate'
import { reserveStudioQuota, studioLimitMessage } from './_limits'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_SHEET_MODEL') || 'deepseek-ai/DeepSeek-V3.1'

const SYSTEM = `You are a world-class spreadsheet engineer — better than anyone at Excel.
Build exactly the spreadsheet the user asks for, with realistic, correct, useful data.

IDENTITY: If the spreadsheet is about "Nalu" — or about the assistant/company itself, or no company is named — the company is **Nalu** (brand "Nalu AI", website n4lu.ai). NEVER invent or substitute a different company name (e.g. never "Nexus", "Nexus AI", "Acme"). Only use a different company name if the USER explicitly names one. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

Output ONLY valid minified JSON (no markdown fences, no prose) of this exact shape:
{"title": string, "sheets": [{"name": string, "columns": [string], "rows": [[cell]]}]}

CELL COORDINATES — get this exactly right or every formula breaks: the "columns" array is the header and becomes Excel ROW 1. The FIRST inner array in "rows" is Excel ROW 2, the next is ROW 3, and so on. The first column is A, second B, third C, etc. Write every "=" formula's A1 references to match THAT mapping: a formula on the first data row that multiplies its own B and C is "=B2*C2"; a column total under 24 data rows (rows 2–25) is "=SUM(B2:B25)". Data starts at row 2 — never reference row 1 as data, and never be off by one.
RAW VALUES — numeric cells must be RAW numbers (1200, 0.08, -45000), NEVER strings with currency symbols, commas, or percent signs ("$1,200", "8%", "1,200"). A quoted number breaks every formula that references it; display formatting is applied separately. Only genuine text labels are strings; dates as ISO strings ("2026-01-31").

DEPTH — this is critical. Build a real, multi-tab MODEL, not a toy table:
- Produce MULTIPLE sheets when the topic warrants it (it usually does). E.g. a financial model = "Assumptions", "Revenue", "Expenses", "P&L", "Cash Flow", "Summary/Dashboard". A budget = "Assumptions", "Monthly Detail" (12 months), "Summary". A plan = inputs + calc + output tabs.
- Make tables WIDE and DEEP: typically 8–16 columns and 20–60 data rows of realistic, specific values (real categories, names, dates, amounts) — not 3 placeholder rows. Anything "monthly" gets ALL 12 months; a budget's detail tab lists 15–30 real line items across categories (housing, utilities, groceries, transport, insurance, subscriptions, dining, savings…) — never a handful.
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
  const prevSheet = typeof body.prevSheet === 'string' && body.prevSheet.length > 50 ? body.prevSheet.slice(0, 90000) : ''
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }
  const grounded = await groundFromPrompt(prompt)
  const today = new Date().toISOString().slice(0, 10)

  const quota = await reserveStudioQuota(req, 'sheet')
  if (!quota.ok) {
    res.status(429).json({ error: studioLimitMessage('spreadsheet', quota) })
    return
  }
  let succeeded = false
  try {
    // Robust: timeout + provider failover + truncation continuation. Low temp +
    // JSON mode for deterministic, valid output (formulas/numbers must be exact).
    const { content } = await chatCompleteContinued(
      [
        { role: 'system', content: `${SYSTEM}\n\nToday is ${today}. Use it for any month/quarter/year labels, projections, or "next 12 months" ranges.` + identityBlock(await identityForRequest(req).catch(() => null)) },
        { role: 'user', content: grounded + prompt + (prevSheet ? `\n\n----\nCURRENT SPREADSHEET JSON (apply the change above to THIS workbook; keep all other tabs/rows/formulas identical; output the complete updated JSON):\n${prevSheet}` : '') },
      ],
      { model: LLM_MODEL, maxTokens: 16000, timeoutMs: 110000, retryPrimary: false, temperature: 0.2, json: true },
    )
    const parsed = extractJson(content) as { title?: string; sheets?: unknown[] } | null
    if (!parsed || !Array.isArray(parsed.sheets) || parsed.sheets.length === 0) {
      res.status(502).json({ error: 'Could not build the spreadsheet. Try rephrasing.' })
      return
    }
    // Enforce the contract: coerce "$1,200"/"8%" → raw numbers (so formulas
    // compute), make rows rectangular, sanitize + dedupe worksheet names.
    const sheets = normalizeSheets(parsed.sheets)
    if (!sheets.length) {
      res.status(502).json({ error: 'Could not build the spreadsheet. Try rephrasing.' })
      return
    }
    res.status(200).json({ title: parsed.title || 'Spreadsheet', sheets, name: 'Nalu Sheets' })
    succeeded = true
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'sheet error' })
  } finally {
    if (!succeeded) await quota.release()
  }
}
