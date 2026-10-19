// Nalu spreadsheet builder — Vercel Node serverless function.
// Turns a natural-language request into a structured workbook (sheets, columns,
// rows, and real Excel formulas), which the client renders + exports to
// .xlsx / .pdf. Branded "Nalu Sheets"; provider hidden.

import { cors } from './_cors'
import { groundFromPrompt } from './_grounding'
import { chatCompleteContinued, primaryProvider, fallbackProvider, emergencyProvider } from './_llm'
import { identityForRequest, identityBlock } from './_db'
import { normalizeSheets } from './_validate'
import { buildEvaluator, type EvalSheet } from './_formulaEval'
import { reserveStudioQuota, studioLimitMessage } from './_limits'
import { pickDesign, designPayload } from './_design'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

const LLM_KEY = env('TINKER_API_KEY') || ''
const LLM_MODEL = env('NALU_SHEET_MODEL') || 'thinkingmachines/Inkling'

const SYSTEM = `You are a world-class spreadsheet engineer — better than anyone at Excel.
Build exactly the spreadsheet the user asks for, with realistic, correct, useful data.

IDENTITY: Write about "Nalu" (brand "Nalu AI", n4lu.ai) ONLY when the user's request is explicitly about Nalu, this assistant, or this app itself. For EVERY OTHER spreadsheet, build it GENERICALLY around the exact subject the user gave and do NOT insert "Nalu" anywhere — a generic request must never be branded "Nalu". If a company / firm / author name is needed and the user did NOT provide one, refer to it generically ("the company") or use a clear placeholder like "[Company Name]" — do NOT invent a name (never "Nexus", "Nexus AI", "Acme") and do NOT substitute "Nalu". Only use a specific company name the USER explicitly named. NEVER use emojis, emoticons, or decorative symbols (no ✅ ✓ ❌ → • ★ etc.) anywhere in the output — clean professional typography only.

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

const SPEC_SYSTEM = `You are the best financial & operational modeler in the world — elite at Excel. Design a DEEP, genuinely useful, tightly wired multi-tab workbook as a COMPACT SPEC (templates, not every cell). Output ONLY minified JSON, no prose, no code fences, of this exact shape:
{"title":string,"drivers":[Driver,...],"tabs":[Tab,...]}

DRIVERS (named assumptions) — put EVERY input number here, and reference them by NAME so you never miscount a cell:
  Driver = {"key":"logosStart","name":"New Logos - Start","value":10,"note":"Base case"}  (value is a RAW number)
  - In ANY formula, write @key to reference a driver — e.g. "=@logosStart", "=B{r}*(1+@growthRate)", "=@churnRate". CODE turns @key into the exact Assumptions cell, so an off-by-one is impossible.
  - Do NOT create your own "Assumptions" tab — it is built automatically from drivers as the first sheet. Do NOT hand-write "Assumptions!$B$4" refs; always use @key.
  - Include 10-25 drivers (growth rates, prices, churn, salaries, COGS %, starting values, tax rate, etc.).

TAB NAMES may contain spaces or "&" (e.g. "P&L", "Cash Flow & Runway"). In formulas, reference a tab by its EXACT name — the name before "!" MUST match the tab's name character-for-character (if you name it "P&L", write "P&L!D2", not "P and L!D2"). Avoid "/", "[", "]" in tab names.

BUILD REAL DEPTH — 5 to 9 INTERCONNECTED tabs wired together with cross-sheet formulas, never one flat table. Pick the tabs the ask actually needs (inputs → engine → outputs → dashboard):
- Startup / SaaS / financial model: Assumptions, Revenue, Headcount, Opex, P&L, Cash Flow & Runway, (Balance Sheet if relevant), KPIs/Metrics, Scenarios, Summary/Dashboard.
- Budget: Assumptions, Income, 12–24-month Detail (by category), Summary/Dashboard.
- Project / ops plan: Assumptions, Tasks & Timeline, Resources, Budget, Risks, Dashboard.
- Sales / CRM: Pipeline, Deals, Accounts, Activities, Forecast, Dashboard.
- Any other domain: build the equivalent inputs → calculation engine → outputs → dashboard.

Each Tab is ONE of:
  STATIC (inputs/assumptions/lists/dashboards): {"name":string,"columns":[string,...],"rows":[[cell,...],...]}
    - 8–20 rows of REAL specific data. Numeric cells are RAW numbers (1200, 0.08, -45000) — NEVER "$1,200" or "8%". Use real formulas here too (a Dashboard/KPI tab is mostly formulas pulling from other tabs).
  SERIES (time-series that AUTO-EXPANDS to N rows): {"name":string,"columns":[string,...],"periods":N,"label":{"start":"2026-01","step":"month"},"cells":[oneTemplatePerColumn,...],"total":[oneTemplatePerColumn,...]}
    - "cells" has EXACTLY ONE template per column. "step" is "month" | "quarter" | "year". Use 24–36 periods for monthly models.
    - {r} = THIS row's Excel row, {r-1} = previous row. Data starts at Excel row 2. FIRST column template = "LABEL" (the period label).
    - CRITICAL — period 1 has NO row above it (Excel row 1 is the HEADER text, not data). So for EVERY column whose formula uses {r-1}, you MUST use the "first || rest" form: the "first" part is a CONSTANT or a @driver reference (NEVER a {r-1} ref), the "rest" part is the recurring formula. Examples: "@logosStart || =B{r-1}*(1+@growthRate)" (new logos start from a driver), "0 || =E{r-1}*@churnRate" (churn starts at 0), "@startMrr || =H{r-1}*(1+@growthRate)" (MRR starts from a driver). A period-1 cell must never reference row 1.
    - "total" (OPTIONAL but encouraged) adds a TOTALS row: use {first}=first data row (2) and {last}=last data row, e.g. "=SUM(B{first}:B{last})"; put "Total" or "" in columns that shouldn't sum.
    - Wire tabs together with @drivers and other-tab refs: "=B{r}*@grossMargin", "=Revenue!L{r}", "=Headcount!F{r}".

DASHBOARD / STATIC tabs: these are NOT series — do NOT use {r}, {r-1}, {last} or {this} here (those work ONLY inside SERIES "cells"/"total"). To reference a series result, use its exact data-row range (rows 2 through periods + 1), or reference its Total row directly (periods + 2). Never sum or average an entire column that also contains a Total row: that would double count totals or bias averages. EVERY formula cell must start with "=".

MAKE IT RICH & CORRECT: heavy real Excel formulas (arithmetic, SUM/AVERAGE/MAX, IF/SUMIF/COUNTIF, VLOOKUP/XLOOKUP, growth "=x*(1+@rate)", margins, %); a Dashboard/Summary tab with 8–15 KPIs computed from the other tabs (totals, growth %, gross/operating margin, runway = cash÷burn, CAC, LTV, LTV/CAC, MoM/YoY); derived columns as formulas not hardcoded; realistic category names and numbers; internally consistent. Prefer SERIES for anything periodic. NEVER use emojis or decorative symbols. This must read like a model a top-tier finance professional built.`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expandSpec(spec: any): { title: string; sheets: Array<{ name: string; columns: string[]; rows: unknown[][] }> } | null {
  if (!spec || !Array.isArray(spec.tabs)) return null
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const labelFor = (i: number, start?: string, step?: string): string => {
    let y = 2026, m = 0
    if (typeof start === 'string') { const mm = start.match(/(\d{4})-(\d{1,2})/); if (mm) { y = +mm[1]; m = +mm[2] - 1 } }
    if (step === 'year') return String(y + i)
    if (step === 'quarter') { const q = Math.floor(m / 3) + i; return `Q${(q % 4) + 1} ${y + Math.floor(q / 4)}` }
    const t = m + i; return `${MON[((t % 12) + 12) % 12]} ${y + Math.floor(t / 12)}`
  }
  // NAMED DRIVERS — the model declares assumptions as {key,name,value,note} and
  // references them anywhere as @key; CODE resolves @key → the exact Assumptions
  // cell, so an off-by-one in a hand-written "Assumptions!$B$4" can't happen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drivers: any[] = Array.isArray(spec.drivers) ? spec.drivers.filter((d: any) => d && d.key != null) : []
  const driverRef: Record<string, string> = {}
  drivers.forEach((d, i) => { driverRef[String(d.key)] = `Assumptions!$B$${i + 2}` })
  // Replace @key by EXACT known key (longest first) so keys containing "&" or other
  // symbols (e.g. "avgSalaryG&A") still resolve — a generic \w+ regex would stop at
  // the "&" and leave a broken "@..." fragment.
  const driverKeys = Object.keys(driverRef).sort((a, b) => b.length - a.length)
  const sub = (s: unknown): unknown => {
    if (typeof s !== 'string' || !driverKeys.length) return s
    let r = s
    for (const k of driverKeys) if (r.includes('@' + k)) r = r.split('@' + k).join(driverRef[k])
    return r
  }
  const subStr = (s: string): string => sub(s) as string
  // A cell that IS a reference/expression but is missing its leading "=" (models
  // do this after a @driver substitution) would render as literal text — restore
  // the "=" so it computes. Plain numbers/text are left alone.
  const ensureFormula = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    const t = v.trim()
    if (!t || t.startsWith('=')) return v
    if (/^-?\d+(\.\d+)?$/.test(t)) return v
    if (t.includes('!') && /[A-Za-z0-9]\$?\d/.test(t)) return '=' + t
    if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(t)) return '=' + t
    if (/[A-Za-z]\$?\d+\s*[-+*/^]/.test(t) || /[-+*/^]\s*[A-Za-z]\$?\d/.test(t)) return '=' + t
    return v
  }

  const sheets: Array<{ name: string; columns: string[]; rows: unknown[][] }> = []
  if (drivers.length) {
    sheets.push({
      name: 'Assumptions',
      columns: ['Driver', 'Value', 'Notes'],
      rows: drivers.map((d) => {
        const v = d.value
        const val = typeof v === 'number' ? v : (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : String(v ?? ''))
        return [String(d.name || d.key), val, String(d.note || '')]
      }),
    })
  }
  for (const tab of spec.tabs) {
    if (!tab || typeof tab.name !== 'string' || !Array.isArray(tab.columns)) continue
    if (drivers.length && tab.name.trim().toLowerCase() === 'assumptions') continue // built from drivers above
    const columns = tab.columns.map((c: unknown) => String(c))
    if (Array.isArray(tab.rows)) {
      sheets.push({ name: tab.name, columns, rows: (tab.rows as unknown[][]).map((r) => Array.isArray(r) ? r.map((x) => ensureFormula(sub(x))) : r) })
      continue
    }
    const periods = Math.min(120, Math.max(0, Number(tab.periods) || 0))
    const cells = Array.isArray(tab.cells) ? tab.cells.map((c: unknown) => subStr(String(c))) : []
    if (!periods || !cells.length) continue
    const start = tab.label?.start, step = tab.label?.step
    const lastRow = periods + 1 // last data row in Excel terms (data starts at row 2)
    const fill = (t: string, r: number, i: number): string =>
      t.replace(/\{r-1\}/g, String(r - 1)).replace(/\{r\}/g, String(r)).replace(/\{i\}/g, String(i))
        .replace(/\{first\}/g, '2').replace(/\{last\}/g, String(lastRow))
    const rows: unknown[][] = []
    for (let i = 0; i < periods; i++) {
      const r = i + 2
      rows.push(columns.map((_: string, c: number) => {
        let t = cells[c] ?? ''
        if (t.includes('||')) { const parts = t.split('||'); t = (i === 0 ? parts[0] : parts[1]).trim() }
        if (t === 'LABEL' || t === '') return t === 'LABEL' ? labelFor(i, start, step) : ''
        // Period 1 has no row above it — a leftover {r-1} would point at the HEADER
        // (text) and break the formula. Reject the spec rather than invent an
        // opening balance of zero.
        if (i === 0 && /\{r-1\}/.test(t)) throw new Error('Series requires an explicit first-period input.')
        return ensureFormula(fill(t, r, i))
      }))
    }
    // Optional TOTALS row (rendered once, at Excel row lastRow+1).
    const total = Array.isArray(tab.total) ? tab.total.map((c: unknown) => subStr(String(c))) : []
    if (total.length && periods > 0) {
      rows.push(columns.map((_: string, c: number) => {
        const t = (total[c] ?? '').trim()
        if (t === '' ) return c === 0 ? 'Total' : ''
        if (t === 'LABEL' || t === 'Total') return 'Total'
        return ensureFormula(fill(t, lastRow + 1, periods))
      }))
    }
    sheets.push({ name: tab.name, columns, rows })
  }
  return sheets.length ? { title: String(spec.title || 'Model'), sheets } : null
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
  const candidates = [body, escapeCtrlInStrings(body)]
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object') return v } catch { /* next */ }
  }
  return null
}

// A model response is not a successful workbook unless it has real cells and
// every generated calculation is evaluable. This catches bad references,
// malformed templates and unsupported functions before they become downloads.
function validateWorkbook(title: string, sheets: ReturnType<typeof normalizeSheets>, issues: string[]) {
  if (!sheets.length || !sheets.some((s) => s.rows.length)) return null
  if (sheets.reduce((n, s) => n + s.rows.length * s.columns.length, 0) > 100000) return null
  const evaluator = buildEvaluator(sheets as EvalSheet[])
  for (let si = 0; si < sheets.length; si++) for (let ri = 0; ri < sheets[si].rows.length; ri++) for (let ci = 0; ci < sheets[si].rows[ri].length; ci++) {
    const value = sheets[si].rows[ri][ci]
    if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) return null
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    if (typeof value === 'string' && value.startsWith('=')) {
      const result = evaluator.result(si, ri, ci)
      if (result.status !== 'value') {
        if (issues.length < 12) issues.push(`${sheets[si].name} row ${ri + 2}, column ${ci + 1}: ${value} — ${result.message}`)
      }
    }
  }
  return issues.length ? null : { title, sheets }
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
  const prevSheet = typeof body.prevSheet === 'string' ? body.prevSheet : ''
  if (body.prevSheet != null) {
    try {
      const previous = JSON.parse(prevSheet)
      if (prevSheet.length > 90000 || !previous || !Array.isArray(previous.sheets) || !previous.sheets.length) throw new Error('Invalid workbook')
    } catch {
      res.status(400).json({ error: 'The existing workbook is missing, invalid, or too large to edit safely. Please send the complete workbook.', code: 'INVALID_PREVIOUS_WORKBOOK', previousWorkbookPreserved: true })
      return
    }
  }
  if (!prompt) {
    res.status(400).json({ error: 'prompt required' })
    return
  }
  const grounded = await groundFromPrompt(prompt).catch(() => '')
  const today = new Date().toISOString().slice(0, 10)

  const quota = await reserveStudioQuota(req, 'sheet')
  if (!quota.ok) {
    res.status(quota.status || 429).json({ error: studioLimitMessage('spreadsheet', quota) })
    return
  }
  let succeeded = false
  try {
    const userMsg = grounded + prompt + (prevSheet ? `\n\n----\nCURRENT SPREADSHEET JSON (apply the change above to THIS workbook; keep all other tabs/rows/formulas identical; output the complete updated JSON):\n${prevSheet}` : '')
    let formulaIssues: string[] = []
    const currentUserMessage = () => userMsg + (formulaIssues.length ? `\n\nThe previous draft failed these calculation checks. Correct the formulas and return the complete workbook; do not replace failures with invented constants or blanket IFERROR(...,0):\n${formulaIssues.join('\n')}` : '')
    const identity = identityBlock(await identityForRequest(req).catch(() => null))
    const inputFidelity = `INPUT FIDELITY: Preserve all supplied facts, amounts, names, dates and formulas unless the user asks to change them. Never present invented numbers as actual records. When actual inputs are missing, use blank input cells or clearly label any user-requested example data and every illustrative assumption in the workbook itself. Do not invent people, payroll records, sales, account balances or transactions. Separate assumptions from observed inputs. Do not wrap every formula in IFERROR(...,0); a failed calculation is not zero. Financial formulas may use PMT, PV, FV, NPER, IPMT, PPMT, NPV, IRR and RATE. Return complete JSON; never truncate an edit or remove unrelated tabs to fit a smaller response.`
    const sysFull = `${SYSTEM}\n\n${inputFidelity}\n\nToday is ${today}. Use it for any month/quarter/year labels, projections, or "next 12 months" ranges.` + identity
    // Leaner ask — a smaller request clears a busy or token-capped provider that a
    // big one 403s ("out of tokens"). Still real data + formulas, just less depth.
    const sysLean = `You are an expert spreadsheet engineer. Output ONLY valid minified JSON (no prose, no code fences) of shape {"title":string,"sheets":[{"name":string,"columns":[string],"rows":[[cell]]}]}. Build a genuinely useful workbook for the request: 1-3 sheets, 6-12 columns, 12-30 rows of REAL specific data. Numeric cells are RAW numbers (never "$1,200" or "8%"). Use real Excel formulas as strings ("=B2*C2","=SUM(B2:B20)","=IF(...)") with correct A1 refs — the header is row 1, data starts row 2. Today is ${today}.` + inputFidelity + identity

    // Tiered generation: compact specification, full-depth, then lean retry.
    // A failed generation must never replace user data with an unrelated template. `providers` lets the full attempt run PRIMARY-ONLY so a
    // slow generation gets one long window instead of two (which would blow the 300s
    // function budget); the lean attempt uses the full provider chain for failover.
    const attempt = async (system: string, maxTokens: number, timeoutMs: number, providers?: ReturnType<typeof primaryProvider>[]) => {
      const { content } = await chatCompleteContinued(
        [{ role: 'system', content: system }, { role: 'user', content: currentUserMessage() }],
        { model: LLM_MODEL, maxTokens, timeoutMs, retryPrimary: false, temperature: 0.2, json: true,
          ...(providers ? { providers: providers.filter(Boolean) as NonNullable<ReturnType<typeof primaryProvider>>[] } : {}) },
      )
      const parsed = extractJson(content) as { title?: string; sheets?: unknown[] } | null
      if (!parsed || !Array.isArray(parsed.sheets) || parsed.sheets.length === 0) return null
      const sheets = normalizeSheets(parsed.sheets)
      formulaIssues = []
      return validateWorkbook(parsed.title || 'Spreadsheet', sheets, formulaIssues)
    }
    const prim = primaryProvider(LLM_MODEL)
    // Prefer the FAST provider for the compact spec (HF router / DeepInfra serve
    // DeepSeek-V3.1 far faster than Tinker), so a rich 6-9 tab model finishes well
    // inside the function budget; fail over to primary, then emergency.
    const fast = [fallbackProvider(), prim, emergencyProvider()].filter(Boolean) as NonNullable<ReturnType<typeof primaryProvider>>[]

    // FAST PATH — compact spec the model writes in ~2-4k tokens, expanded to the
    // full deep workbook by code. This is the primary path: ~3-5x faster than
    // emitting every cell, and the formulas are exact because code writes the refs.
    const attemptSpec = async (timeoutMs: number) => {
      const { content } = await chatCompleteContinued(
        [{ role: 'system', content: `${SPEC_SYSTEM}\n\n${inputFidelity}\n\nToday is ${today}.` + identity }, { role: 'user', content: currentUserMessage() }],
        { model: LLM_MODEL, maxTokens: 7000, timeoutMs, retryPrimary: false, temperature: 0.2, json: true, ...(fast.length ? { providers: fast } : {}) },
      )
      const expanded = expandSpec(extractJson(content))
      if (!expanded) return null
      const sheets = normalizeSheets(expanded.sheets)
      formulaIssues = []
      return validateWorkbook(expanded.title, sheets, formulaIssues)
    }

    // HARD wall-clock budget: every path must finish before Vercel's 300s function
    // cap, or the gateway returns a 504. `chatCompleteContinued` can make TWO calls
    // (a continuation), so each attempt's timeout is bounded to ~half the time left.
    const CAP = Date.now() + 220000
    const left = () => CAP - Date.now()
    let result: { title: string; sheets: unknown[] } | null = null
    // 1) Fast spec path (unless this is an EDIT of an existing workbook). This is
    //    the primary path and usually succeeds in one compact generation.
    if (!prevSheet) { const t = Math.min(120000, Math.max(40000, Math.floor((left() - 20000) / 2))); try { result = await attemptSpec(t) } catch { /* fall to full */ } }
    // 2) Full model, primary-only — ONLY if the fast path didn't produce a workbook
    //    (don't run both — that's what pushed slow generations past 300s → 504).
    if (!result && left() > 45000) {
      const t = Math.min(100000, Math.max(30000, Math.floor((left() - 15000) / 2)))
      try { result = await attempt(sysFull, 7000, t, prim ? [prim] : undefined) } catch { /* fall to lean */ }
    }
    // 3) Lean retry across the full provider chain (resilient to a dead primary).
    if (!result && left() > 22000) {
      const t = Math.min(45000, Math.max(15000, Math.floor((left() - 8000) / 2)))
      try { result = await attempt(prevSheet ? sysFull : sysLean, prevSheet ? 7000 : 4000, t) } catch { /* report failure below */ }
    }
    // Failure preserves the previous saved workbook; finally refunds the quota.
    if (!result) {
      res.status(502).json({ error: prevSheet ? 'The spreadsheet edit could not be completed. Your existing workbook has not been changed. Please retry.' : 'The spreadsheet could not be generated. Please retry; no workbook was created.', code: 'SHEET_GENERATION_FAILED', retryable: true, previousWorkbookPreserved: Boolean(prevSheet) })
      return
    }
    res.status(200).json({ title: result.title, sheets: result.sheets, design: designPayload(pickDesign(prompt, 'sheet')), name: 'Nalu Sheets' })
    succeeded = true
  } catch {
    res.status(502).json({ error: prevSheet ? 'The spreadsheet edit failed. Your existing workbook has not been changed.' : 'The spreadsheet could not be generated. Please retry.', code: 'SHEET_GENERATION_FAILED', retryable: true, previousWorkbookPreserved: Boolean(prevSheet) })
  } finally {
    if (!succeeded) await quota.release()
  }
}
