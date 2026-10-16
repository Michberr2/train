// Shared, deterministic server-side validators for Nalu Studio JSON artifacts.
//
// The system prompts ASK the model to emit raw numbers and well-formed shapes,
// but a mid-tier model doesn't always comply — and one bad value silently breaks
// a chart, a formula, or a whole table. These helpers ENFORCE the contract before
// anything reaches the client/export. Underscore-prefixed → bundled, not a route.

/** Coerce a cell/value to a finite number, stripping $, €, £, commas, % (→/100). */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  const pct = /%\s*$/.test(s)
  const cleaned = s.replace(/[^0-9.\-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = parseFloat(cleaned)
  if (!Number.isFinite(n)) return null
  return pct ? n / 100 : n
}

interface ChartSeries { name?: string; values?: unknown[] }
interface Chart { type?: string; title?: string; unit?: string; takeaway?: string; labels?: unknown[]; series?: ChartSeries[] }

/**
 * Normalize a chart spec so it ALWAYS renders: clamp type, coerce every value to
 * a finite number, align each series to the label count, and collapse a pie to a
 * single series. Returns null if there's no usable data left (caller drops it).
 */
export function normalizeChart(chart: unknown): Chart | null {
  if (!chart || typeof chart !== 'object') return null
  const c = chart as Chart
  const labels = Array.isArray(c.labels) ? c.labels.map((l) => String(l)) : []
  if (!labels.length) return null
  let type = String(c.type || 'bar').toLowerCase()
  if (!['bar', 'line', 'pie'].includes(type)) type = 'bar'

  let series = Array.isArray(c.series) ? c.series : []
  series = series
    .map((s) => {
      const nums = (Array.isArray(s?.values) ? s.values : []).map(toNumber)
      // Align to label count: pad missing with 0, trim extras.
      const aligned = labels.map((_, i) => (nums[i] == null ? 0 : (nums[i] as number)))
      const hasReal = nums.some((n) => n != null)
      return hasReal ? { name: typeof s?.name === 'string' ? s.name : '', values: aligned } : null
    })
    .filter(Boolean) as ChartSeries[]

  if (!series.length) return null
  // A pie chart only renders one series.
  if (type === 'pie') series = [series[0]]

  return {
    type,
    title: typeof c.title === 'string' ? c.title : '',
    unit: typeof c.unit === 'string' ? c.unit.slice(0, 4) : '',
    takeaway: typeof c.takeaway === 'string' ? c.takeaway.slice(0, 160) : '',
    labels,
    series,
  }
}

/** True if a value is a string that's purely a formatted number (no formula). */
function isNumericString(v: unknown): boolean {
  return typeof v === 'string' && /^\s*-?[$€£]?\s*[\d,]+(\.\d+)?\s*%?\s*$/.test(v) && /\d/.test(v)
}

/** Guard EVERY formula so a #DIV/0!, #N/A, #VALUE!, #REF! or #NAME? error can
 *  never surface to the user — wrap it in IFERROR(...,0). 0 is the right neutral
 *  for the numeric models these formulas drive; genuine text/labels aren't
 *  formulas and never reach here. Also strips a stray leading '+' or doubled '='
 *  that models sometimes emit (which Excel would flag as a broken formula). */
export function guardFormula(cell: string): string {
  let inner = cell.trim().replace(/^=+/, '').replace(/^\s*\+/, '').trim()
  if (!inner) return '0'
  if (/^IFERROR\s*\(/i.test(inner)) return `=${inner}` // already guarded
  return `=IFERROR(${inner},0)`
}

/**
 * Normalize a spreadsheet model: coerce numeric-looking string cells to raw
 * numbers (so formulas referencing them compute), make every row rectangular,
 * and sanitize + de-duplicate worksheet names (Excel: ≤31 chars, no \ / ? * [ ] :).
 */
export function normalizeSheets(sheets: unknown[]): Array<{ name: string; columns: string[]; rows: unknown[][] }> {
  const used = new Set<string>()
  const out: Array<{ name: string; columns: string[]; rows: unknown[][] }> = []
  let idx = 0
  for (const raw of sheets) {
    idx++
    if (!raw || typeof raw !== 'object') continue
    const s = raw as { name?: unknown; columns?: unknown; rows?: unknown }
    const columns = Array.isArray(s.columns) ? s.columns.map((c) => String(c)) : []
    if (!columns.length) continue
    const width = columns.length
    const rawRows = Array.isArray(s.rows) ? s.rows : []
    const rows = rawRows
      .filter((r) => Array.isArray(r))
      .map((r) => {
        const row = (r as unknown[]).map((cell) => {
          // Formulas: guard against errors (IFERROR); coerce numeric strings to real numbers.
          if (typeof cell === 'string' && cell.trim().startsWith('=')) {
            if (/[{}@]/.test(cell)) return 0 // leftover template token / unresolved @driver → not valid
            return guardFormula(cell)
          }
          if (isNumericString(cell)) {
            const n = toNumber(cell)
            return n == null ? cell : n
          }
          return cell
        })
        // Rectangular: pad short rows, trim long ones.
        if (row.length < width) return [...row, ...Array(width - row.length).fill('')]
        return row.slice(0, width)
      })

    // Sanitize + dedupe the sheet name.
    let name = String((typeof s.name === 'string' && s.name.trim()) || `Sheet ${idx}`)
      .replace(/[\\/?*[\]:]/g, ' ')
      .trim()
      .slice(0, 31) || `Sheet ${idx}`
    if (used.has(name.toLowerCase())) {
      const stem = name.slice(0, 27)
      let n = 2
      while (used.has(`${stem} (${n})`.toLowerCase())) n++
      name = `${stem} (${n})`
    }
    used.add(name.toLowerCase())
    out.push({ name, columns, rows })
  }

  // Quote cross-sheet references to any tab whose name isn't a bare identifier
  // (spaces, &, (), %, …). Excel REQUIRES 'Sheet Name'!A1 for those; models write
  // them UNQUOTED, which breaks the formula in Excel and the preview alike.
  const special = out.map((s) => s.name).filter((n) => /[^A-Za-z0-9_.]/.test(n)).sort((a, b) => b.length - a.length)
  if (special.length) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const quote = (f: string): string => {
      let r = f
      for (const nm of special) r = r.replace(new RegExp(`(^|[^'A-Za-z0-9_])(${esc(nm)})!`, 'g'), "$1'$2'!")
      return r
    }
    for (const s of out) for (let i = 0; i < s.rows.length; i++)
      s.rows[i] = s.rows[i].map((c) => (typeof c === 'string' && c.startsWith('=')) ? quote(c) : c)
  }
  return out
}
