// Lightweight Excel-formula evaluator for Nalu Sheets previews + exports.
//
// The model emits real "=..." formulas; without evaluating them the preview and
// PDF show literal "=SUM(B2:B25)" text and the .xlsx ships uncomputed. This
// evaluates the formulas the model actually produces — arithmetic, cell/range
// refs (incl. $absolute and Sheet!ref), and the common functions — so users see
// VALUES. It is intentionally conservative: anything it can't evaluate returns
// null and the caller falls back to showing the raw formula (never crashes).
//
// We deliberately avoid HyperFormula (GPL/commercial-licensed) — this stays
// dependency-free and proprietary-safe.

export type Cell = string | number
export interface EvalSheet {
  name?: string
  columns?: string[]
  rows?: Cell[][]
}

const isFormula = (c: unknown): c is string => typeof c === 'string' && c.trim().startsWith('=')

// "$B$3" / "AA12" → { col: 0-based, row: 1-based Excel row }
function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim())
  if (!m) return null
  let col = 0
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: parseInt(m[2], 10) }
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s || s.startsWith('=')) return null
    const pct = /%$/.test(s)
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ''))
    if (!Number.isFinite(n)) return null
    return pct ? n / 100 : n
  }
  return null
}

type Tok = { t: string; v: string }
function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  const patterns: Array<[string, RegExp]> = [
    ['ws', /^\s+/],
    ['num', /^\d+(\.\d+)?/],
    ['cmp', /^(<=|>=|<>|=|<|>)/],
    ['op', /^[+\-*/^&]/],
    ['lp', /^\(/],
    ['rp', /^\)/],
    ['comma', /^,/],
    ['colon', /^:/],
    ['str', /^"[^"]*"/],
    // Sheet!ref (sheet name bare or 'quoted')
    ['sref', /^(?:'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d+/],
    ['ref', /^\$?[A-Za-z]{1,3}\$?\d+/],
    ['ident', /^[A-Za-z_][A-Za-z0-9_.]*/],
  ]
  while (i < src.length) {
    let matched = false
    for (const [t, re] of patterns) {
      const m = re.exec(src.slice(i))
      if (m) {
        if (t !== 'ws') out.push({ t, v: m[0] })
        i += m[0].length
        matched = true
        break
      }
    }
    if (!matched) return null
  }
  return out
}

/**
 * Build an evaluator over a set of sheets. `value(sheetIdx, dataRowIdx, colIdx)`
 * returns the computed value for the cell at `rows[dataRowIdx][colIdx]` — a
 * number when a formula evaluates, the raw value otherwise.
 */
export function buildEvaluator(sheets: EvalSheet[]) {
  const byName = new Map<string, EvalSheet>()
  sheets.forEach((s) => { if (s.name) byName.set(s.name.toLowerCase(), s) })
  const cache = new Map<string, number | null>()
  const visiting = new Set<string>()

  // Raw cell value for a given sheet at Excel (1-based) row + 0-based col.
  // Excel row 1 = header (columns); row 2 = rows[0]; row N = rows[N-2].
  function rawAt(sheet: EvalSheet, excelRow: number, col: number): Cell | undefined {
    if (excelRow === 1) return sheet.columns?.[col]
    return sheet.rows?.[excelRow - 2]?.[col]
  }

  function evalRef(sheet: EvalSheet, excelRow: number, col: number): number | null {
    const key = `${sheet.name || ''}|${excelRow}|${col}`
    if (cache.has(key)) return cache.get(key)!
    if (visiting.has(key)) return null // cycle
    const raw = rawAt(sheet, excelRow, col)
    let result: number | null
    if (isFormula(raw)) {
      visiting.add(key)
      result = evalFormula(raw, sheet)
      visiting.delete(key)
    } else {
      result = num(raw)
    }
    cache.set(key, result)
    return result
  }

  // Resolve a token ('sref' or 'ref') to its sheet + position.
  function locate(tok: Tok, ctx: EvalSheet): { sheet: EvalSheet; row: number; col: number } | null {
    let refStr = tok.v
    let sheet = ctx
    if (tok.t === 'sref') {
      const bang = tok.v.indexOf('!')
      let sn = tok.v.slice(0, bang)
      if (sn.startsWith("'") && sn.endsWith("'")) sn = sn.slice(1, -1)
      const found = byName.get(sn.toLowerCase())
      if (!found) return null
      sheet = found
      refStr = tok.v.slice(bang + 1)
    }
    const p = parseRef(refStr)
    if (!p) return null
    return { sheet, row: p.row, col: p.col }
  }

  function rangeValues(a: Tok, b: Tok, ctx: EvalSheet): { nums: number[]; rawCells: Array<Cell | undefined> } {
    const la = locate(a, ctx)
    const lb = locate(b, ctx)
    const nums: number[] = []
    const rawCells: Array<Cell | undefined> = []
    if (!la || !lb || la.sheet !== lb.sheet) return { nums, rawCells }
    const r1 = Math.min(la.row, lb.row), r2 = Math.max(la.row, lb.row)
    const c1 = Math.min(la.col, lb.col), c2 = Math.max(la.col, lb.col)
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        rawCells.push(rawAt(la.sheet, r, c))
        const v = evalRef(la.sheet, r, c)
        if (v != null) nums.push(v)
      }
    return { nums, rawCells }
  }

  // Recursive-descent expression parser over tokens.
  function evalFormula(formula: string, ctx: EvalSheet): number | null {
    const toks = tokenize(formula.replace(/^=/, ''))
    if (!toks) return null
    let pos = 0
    const peek = () => toks[pos]
    const eat = () => toks[pos++]

    function args(): Array<{ kind: 'num'; n: number | null } | { kind: 'range'; nums: number[]; rawCells: Array<Cell | undefined> }> {
      const list: Array<{ kind: 'num'; n: number | null } | { kind: 'range'; nums: number[]; rawCells: Array<Cell | undefined> }> = []
      if (peek()?.t === 'rp') return list
      for (;;) {
        // range?  ref ':' ref
        if ((peek()?.t === 'ref' || peek()?.t === 'sref') && toks![pos + 1]?.t === 'colon') {
          const a = eat(); eat(); const b = eat()
          list.push({ kind: 'range', ...rangeValues(a, b, ctx) })
        } else {
          list.push({ kind: 'num', n: expr() })
        }
        if (peek()?.t === 'comma') { eat(); continue }
        break
      }
      return list
    }

    function callFn(name: string): number | null {
      eat() // '('
      const a = args()
      if (peek()?.t === 'rp') eat()
      const flat = (): number[] => a.flatMap((x) => (x.kind === 'range' ? x.nums : x.n != null ? [x.n] : []))
      const fn = name.toUpperCase()
      const nums = flat()
      switch (fn) {
        case 'SUM': return nums.reduce((s, n) => s + n, 0)
        case 'PRODUCT': return nums.reduce((s, n) => s * n, 1)
        case 'AVERAGE': case 'AVG': case 'MEAN': return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null
        case 'MIN': return nums.length ? Math.min(...nums) : null
        case 'MAX': return nums.length ? Math.max(...nums) : null
        case 'COUNT': return nums.length
        case 'COUNTA': return a.reduce((s, x) => s + (x.kind === 'range' ? x.rawCells.filter((c) => c !== undefined && c !== '').length : x.n != null ? 1 : 0), 0)
        case 'ABS': return nums.length ? Math.abs(nums[0]) : null
        case 'ROUND': return nums.length ? Number(nums[0].toFixed(Math.max(0, nums[1] ?? 0))) : null
        case 'SQRT': return nums.length ? Math.sqrt(nums[0]) : null
        case 'INT': return nums.length ? Math.floor(nums[0]) : null
        case 'IF': return a[0] && a[0].kind === 'num' && a[0].n ? (a[1]?.kind === 'num' ? a[1].n : null) : a[2]?.kind === 'num' ? a[2].n : 0
        default: return null
      }
    }

    function primary(): number | null {
      const tk = peek()
      if (!tk) return null
      if (tk.t === 'num') { eat(); return parseFloat(tk.v) }
      if (tk.t === 'op' && tk.v === '-') { eat(); const v = primary(); return v == null ? null : -v }
      if (tk.t === 'op' && tk.v === '+') { eat(); return primary() }
      if (tk.t === 'lp') { eat(); const v = expr(); if (peek()?.t === 'rp') eat(); return v }
      if (tk.t === 'ident') { eat(); if (peek()?.t === 'lp') return callFn(tk.v); return null }
      if (tk.t === 'ref' || tk.t === 'sref') { eat(); const loc = locate(tk, ctx); return loc ? evalRef(loc.sheet, loc.row, loc.col) : null }
      if (tk.t === 'str') { eat(); return null }
      return null
    }

    function power(): number | null {
      let base = primary()
      while (peek()?.t === 'op' && peek()?.v === '^') { eat(); const e = primary(); base = base == null || e == null ? null : base ** e }
      return base
    }
    function term(): number | null {
      let v = power()
      while (peek()?.t === 'op' && (peek()?.v === '*' || peek()?.v === '/')) {
        const op = eat().v; const r = power()
        if (v == null || r == null) v = null
        else v = op === '*' ? v * r : r === 0 ? null : v / r
      }
      return v
    }
    function add(): number | null {
      let v = term()
      while (peek()?.t === 'op' && (peek()?.v === '+' || peek()?.v === '-')) {
        const op = eat().v; const r = term()
        if (v == null || r == null) v = null
        else v = op === '+' ? v + r : v - r
      }
      return v
    }
    function expr(): number | null {
      const v = add()
      const c = peek()
      if (c?.t === 'cmp') {
        eat(); const r = add()
        if (v == null || r == null) return null
        switch (c.v) {
          case '=': return v === r ? 1 : 0
          case '<>': return v !== r ? 1 : 0
          case '<': return v < r ? 1 : 0
          case '>': return v > r ? 1 : 0
          case '<=': return v <= r ? 1 : 0
          case '>=': return v >= r ? 1 : 0
        }
      }
      return v
    }

    try {
      return expr()
    } catch {
      return null
    }
  }

  return {
    /** Computed display value for rows[dataRowIdx][colIdx]. */
    value(sheetIdx: number, dataRowIdx: number, colIdx: number): Cell {
      const sheet = sheets[sheetIdx]
      const raw = sheet?.rows?.[dataRowIdx]?.[colIdx]
      if (!isFormula(raw)) return raw ?? ''
      const v = evalFormula(raw, sheet)
      return v == null ? raw : v // fall back to showing the formula if uncomputable
    },
  }
}
