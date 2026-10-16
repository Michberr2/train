import type { Cell } from './formulaEval'

export type SheetData = { name?: string; columns?: string[]; rows?: Cell[][] }
export type SheetDoc = { title?: string; sheets?: SheetData[] }

function text(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '' }
  }
  return String(value)
}

function cell(value: unknown): Cell {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? value : text(value)
  if (typeof value === 'boolean') return value
  return text(value)
}

function sheetName(value: unknown, used: Set<string>, index: number): string {
  const stem = (text(value).replace(/[\\/?*[\]:\u0000-\u001f]/g, ' ').trim().replace(/^'+|'+$/g, '').trim() || `Sheet${index + 1}`).slice(0, 31)
  let name = stem
  let suffix = 2
  while (used.has(name.toLowerCase()) || name.toLowerCase() === 'history') {
    const tail = ` (${suffix++})`
    name = stem.slice(0, 31 - tail.length) + tail
  }
  used.add(name.toLowerCase())
  return name
}

// Preserve cross-tab references when Excel requires a name to be shortened or
// cleaned. String literals (including escaped quotes) must remain untouched.
function rewriteReferences(formula: string, names: Map<string, string>): string {
  return formula.replace(/"(?:[^"]|"")*"|('(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!/g, (match, sheet: string | undefined) => {
    if (!sheet) return match
    const raw = sheet.startsWith("'") ? sheet.slice(1, -1).replace(/''/g, "'") : sheet
    const replacement = names.get(raw.toLowerCase())
    return replacement && replacement !== raw ? `'${replacement.replace(/'/g, "''")}'!` : match
  })
}

// One canonical workbook for the preview, evaluator, PDF and Excel exports.
// A malformed row must not preview correctly and then crash on download.
export function normalizeWorkbook(raw: SheetDoc): SheetDoc {
  const used = new Set<string>()
  const names = new Map<string, string>()
  const source = (Array.isArray(raw?.sheets) ? raw.sheets : []).filter((s) => s && typeof s === 'object')
  const sheets = source.map((s, index) => {
    const original = text(s.name)
    const name = sheetName(original, used, index)
    if (original && !names.has(original.toLowerCase())) names.set(original.toLowerCase(), name)
    const columns = Array.isArray(s.columns) ? s.columns.map(text) : []
    const rows = (Array.isArray(s.rows) ? s.rows : []).map((r) => {
      // Object rows follow header order, independent of JSON property order.
      const values = Array.isArray(r) ? r : r && typeof r === 'object'
        ? columns.length && columns.some((key) => key in r) ? columns.map((key) => (r as Record<string, unknown>)[key]) : Object.values(r)
        : [r]
      return values.map(cell)
    })
    const width = rows.reduce((max, row) => Math.max(max, row.length), columns.length)
    while (columns.length < width) columns.push(`Column ${columns.length + 1}`)
    return { ...s, name, columns, rows }
  })
  for (const sheet of sheets) {
    sheet.rows = sheet.rows.map((row) => row.map((value) => typeof value === 'string' && value.trimStart().startsWith('=') ? rewriteReferences(value.trimStart(), names) : value))
  }
  return { ...raw, title: text(raw?.title), sheets }
}
