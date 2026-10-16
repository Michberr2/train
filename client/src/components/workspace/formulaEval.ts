// Excel-formula evaluator for Nalu Sheets previews + exports.
//
// The model emits real "=..." formulas; without evaluating them the preview and
// PDF show literal "=SUM(B2:B25)" text and the .xlsx ships uncomputed. This is a
// real (dependency-free) engine: an AST parser + a function registry covering
// the formulas Nalu actually generates — arithmetic, comparisons, cell/range
// refs (incl. $absolute and Sheet!ref), IF/IFERROR/IFS, aggregates, lookups
// (VLOOKUP/HLOOKUP/XLOOKUP/INDEX/MATCH/OFFSET), the *IF/*IFS family, and more —
// so users see VALUES, never raw formulas or #errors. Anything it genuinely
// cannot resolve returns null; because the backend wraps every formula in
// IFERROR(...,0), that surfaces as the fallback (0), never a broken cell.
//
// We deliberately avoid HyperFormula (GPL/commercial) — dependency-free + safe.

export type Cell = string | number | boolean
export interface EvalSheet {
  name?: string
  columns?: string[]
  rows?: Cell[][]
}
type Value = number | string | boolean | null

const isFormula = (c: unknown): c is string => typeof c === 'string' && c.trim().startsWith('=')

function colToIdx(letters: string): number {
  let col = 0
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return col - 1
}
// "$B$3" / "AA12" → { col: 0-based, row: 1-based Excel row }
function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim())
  if (!m) return null
  return { col: colToIdx(m[1]), row: parseInt(m[2], 10) }
}

// Coerce any value to a number (Excel-ish): numbers pass; numeric strings parse
// (stripping $ , and % → /100); booleans → 1/0; everything else → null.
function toNum(v: Value): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
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
const truthy = (v: Value): boolean => {
  if (typeof v === 'boolean') return v
  const n = toNum(v)
  if (n != null) return n !== 0
  return !!v
}

type Tok = { t: string; v: string }
function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  const patterns: Array<[string, RegExp]> = [
    ['ws', /^\s+/],
    ['num', /^\d+(\.\d+)?([eE][+-]?\d+)?/],
    ['cmp', /^(<=|>=|<>|=|<|>)/],
    ['op', /^[+\-*/^&%]/],
    ['lp', /^\(/],
    ['rp', /^\)/],
    ['comma', /^,/],
    ['colon', /^:/],
    ['str', /^"(?:[^"]|"")*"/],
    // whole-column ranges: Sheet!A:C or A:C  (must come before sref/ref/ident)
    ['scolref', /^(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![A-Za-z0-9])/],
    ['colref', /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![A-Za-z0-9])/],
    // Sheet!ref  (sheet name bare or 'quoted')
    ['sref', /^(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Za-z]{1,3}\$?\d+/],
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

// ---- AST -------------------------------------------------------------------
type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; sheet?: string; col: number; row: number }
  | { k: 'range'; sheet?: string; c1: number; r1: number; c2: number; r2: number }
  | { k: 'colrange'; sheet?: string; c1: number; c2: number }
  | { k: 'neg'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'cmp'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] }

function refOf(tok: Tok): { sheet?: string; col: number; row: number } | null {
  let refStr = tok.v
  let sheet: string | undefined
  if (tok.t === 'sref') {
    const bang = tok.v.lastIndexOf('!')
    let sn = tok.v.slice(0, bang)
    if (sn.startsWith("'") && sn.endsWith("'")) sn = sn.slice(1, -1).replace(/''/g, "'")
    sheet = sn
    refStr = tok.v.slice(bang + 1)
  }
  const p = parseRef(refStr)
  return p ? { sheet, col: p.col, row: p.row } : null
}

// "Sheet!A:C" / "A:C" → { sheet?, c1, c2 } (a whole-column range)
function colOf(tok: Tok): { sheet?: string; c1: number; c2: number } | null {
  let s = tok.v
  let sheet: string | undefined
  if (tok.t === 'scolref') {
    const bang = s.lastIndexOf('!')
    let sn = s.slice(0, bang)
    if (sn.startsWith("'") && sn.endsWith("'")) sn = sn.slice(1, -1).replace(/''/g, "'")
    sheet = sn
    s = s.slice(bang + 1)
  }
  const m = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(s)
  if (!m) return null
  return { sheet, c1: colToIdx(m[1]), c2: colToIdx(m[2]) }
}

function parse(toks: Tok[]): Node | null {
  let pos = 0
  const peek = () => toks[pos]
  const eat = () => toks[pos++]

  function primary(): Node | null {
    const tk = peek()
    if (!tk) return null
    if (tk.t === 'num') { eat(); return { k: 'num', v: parseFloat(tk.v) } }
    if (tk.t === 'str') { eat(); return { k: 'str', v: tk.v.slice(1, -1).replace(/""/g, '"') } }
    if (tk.t === 'op' && tk.v === '-') { eat(); const e = primary(); return e ? { k: 'neg', e } : null }
    if (tk.t === 'op' && tk.v === '+') { eat(); return primary() }
    if (tk.t === 'lp') { eat(); const e = expr(); if (peek()?.t === 'rp') eat(); return e }
    if (tk.t === 'ident') {
      eat()
      if (peek()?.t === 'lp') { eat(); const args = argList(); if (peek()?.t === 'rp') eat(); return { k: 'call', name: tk.v.toUpperCase(), args } }
      // bare identifier: TRUE/FALSE, else unknown → null literal
      const up = tk.v.toUpperCase()
      if (up === 'TRUE') return { k: 'num', v: 1 }
      if (up === 'FALSE') return { k: 'num', v: 0 }
      return { k: 'str', v: tk.v }
    }
    if (tk.t === 'colref' || tk.t === 'scolref') {
      eat()
      const cr = colOf(tk)
      return cr ? { k: 'colrange', sheet: cr.sheet, c1: Math.min(cr.c1, cr.c2), c2: Math.max(cr.c1, cr.c2) } : null
    }
    if (tk.t === 'ref' || tk.t === 'sref') {
      eat()
      const a = refOf(tk)
      if (!a) return null
      if (peek()?.t === 'colon') {
        eat()
        const bTok = peek()
        if (bTok && (bTok.t === 'ref' || bTok.t === 'sref')) {
          eat()
          const b = refOf(bTok)
          if (b) return { k: 'range', sheet: a.sheet, c1: a.col, r1: a.row, c2: b.col, r2: b.row }
        }
      }
      return { k: 'ref', sheet: a.sheet, col: a.col, row: a.row }
    }
    return null
  }
  function argList(): Node[] {
    const list: Node[] = []
    if (peek()?.t === 'rp') return list
    for (;;) {
      const e = expr()
      list.push(e ?? { k: 'str', v: '' })
      if (peek()?.t === 'comma') { eat(); continue }
      break
    }
    return list
  }
  function power(): Node | null {
    let base = primary()
    while (peek()?.t === 'op' && peek()?.v === '^') { eat(); const e = primary(); base = base && e ? { k: 'bin', op: '^', l: base, r: e } : base }
    return base
  }
  function term(): Node | null {
    let v = power()
    while (peek()?.t === 'op' && (peek()?.v === '*' || peek()?.v === '/')) { const op = eat().v; const r = power(); v = v && r ? { k: 'bin', op, l: v, r } : v }
    return v
  }
  function concat(): Node | null {
    let v = term()
    while (peek()?.t === 'op' && (peek()?.v === '+' || peek()?.v === '-' || peek()?.v === '&')) { const op = eat().v; const r = term(); v = v && r ? { k: 'bin', op, l: v, r } : v }
    return v
  }
  function expr(): Node | null {
    const v = concat()
    const c = peek()
    if (c?.t === 'cmp') { eat(); const r = concat(); return v && r ? { k: 'cmp', op: c.v, l: v, r } : v }
    return v
  }
  const ast = expr()
  return pos === toks.length ? ast : ast // tolerate trailing tokens
}

export function buildEvaluator(sheets: EvalSheet[]) {
  const byName = new Map<string, EvalSheet>()
  const sheetIds = new Map<EvalSheet, number>()
  sheets.forEach((s, index) => {
    sheetIds.set(s, index)
    if (s.name && !byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s)
  })
  const cache = new Map<string, Value>()
  const visiting = new Set<string>()

  function rawAt(sheet: EvalSheet, excelRow: number, col: number): Cell | undefined {
    if (excelRow === 1) return sheet.columns?.[col]
    return sheet.rows?.[excelRow - 2]?.[col]
  }
  function sheetFor(name: string | undefined, ctx: EvalSheet): EvalSheet | null {
    if (!name) return ctx
    return byName.get(name.toLowerCase()) ?? null
  }
  function evalCell(sheet: EvalSheet, excelRow: number, col: number): Value {
    const key = `${sheetIds.get(sheet)}|${excelRow}|${col}`
    if (cache.has(key)) return cache.get(key)!
    if (visiting.has(key)) return null // cycle guard
    const raw = rawAt(sheet, excelRow, col)
    let result: Value
    if (isFormula(raw)) {
      visiting.add(key)
      result = run(raw as string, sheet)
      visiting.delete(key)
    } else {
      result = raw == null ? null : (raw as Value)
    }
    cache.set(key, result)
    return result
  }

  // A rectangle of cells resolved to a sheet + bounds (for aggregates + lookups).
  interface Rect { sheet: EvalSheet; r1: number; c1: number; r2: number; c2: number }
  function rectOf(node: Node, ctx: EvalSheet): Rect | null {
    if (node.k === 'range') {
      const sh = sheetFor(node.sheet, ctx); if (!sh) return null
      return { sheet: sh, r1: Math.min(node.r1, node.r2), c1: Math.min(node.c1, node.c2), r2: Math.max(node.r1, node.r2), c2: Math.max(node.c1, node.c2) }
    }
    if (node.k === 'ref') {
      const sh = sheetFor(node.sheet, ctx); if (!sh) return null
      return { sheet: sh, r1: node.row, c1: node.col, r2: node.row, c2: node.col }
    }
    if (node.k === 'colrange') {
      const sh = sheetFor(node.sheet, ctx); if (!sh) return null
      const last = (sh.rows?.length ?? 0) + 1 // last data Excel row (header is row 1)
      return { sheet: sh, r1: 1, c1: Math.min(node.c1, node.c2), r2: Math.max(1, last), c2: Math.max(node.c1, node.c2) }
    }
    if (node.k === 'call' && node.name === 'OFFSET') return offsetRect(node.args, ctx)
    return null
  }
  function offsetRect(args: Node[], ctx: EvalSheet): Rect | null {
    const base = rectOf(args[0], ctx); if (!base) return null
    const dr = toNum(evalNode(args[1], ctx)) ?? 0
    const dc = toNum(evalNode(args[2], ctx)) ?? 0
    const h = args[3] != null ? (toNum(evalNode(args[3], ctx)) ?? 1) : (base.r2 - base.r1 + 1)
    const w = args[4] != null ? (toNum(evalNode(args[4], ctx)) ?? 1) : (base.c2 - base.c1 + 1)
    const r1 = base.r1 + dr, c1 = base.c1 + dc
    return { sheet: base.sheet, r1, c1, r2: r1 + h - 1, c2: c1 + w - 1 }
  }
  function cellsOf(rect: Rect): Value[] {
    const vals: Value[] = []
    for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) vals.push(evalCell(rect.sheet, r, c))
    return vals
  }
  function numsOf(rect: Rect): number[] {
    const out: number[] = []
    for (const v of cellsOf(rect)) { const n = toNum(v); if (n != null) out.push(n) }
    return out
  }
  // Flatten a set of arg nodes into numbers (ranges expanded, scalars coerced).
  function argNums(args: Node[], ctx: EvalSheet): number[] {
    const out: number[] = []
    for (const a of args) {
      const rect = rectOf(a, ctx)
      if (rect) out.push(...numsOf(rect))
      else { const n = toNum(evalNode(a, ctx)); if (n != null) out.push(n) }
    }
    return out
  }
  // Does `value` satisfy an Excel *IF criterion (">100", "<>0", "Active", 42)?
  function matches(value: Value, crit: Value): boolean {
    if (typeof crit === 'string') {
      const m = /^\s*(<=|>=|<>|=|<|>)\s*(.*)$/.exec(crit)
      if (m) {
        const rhs = m[2]
        const rn = toNum(rhs), vn = toNum(value)
        if (rn != null && vn != null) {
          switch (m[1]) { case '=': return vn === rn; case '<>': return vn !== rn; case '<': return vn < rn; case '>': return vn > rn; case '<=': return vn <= rn; case '>=': return vn >= rn }
        }
        const vs = String(value ?? '')
        switch (m[1]) { case '=': return vs === rhs; case '<>': return vs !== rhs }
      }
    }
    const cn = toNum(crit), vn2 = toNum(value)
    if (cn != null && vn2 != null) return cn === vn2
    return String(value ?? '').toLowerCase() === String(crit ?? '').toLowerCase()
  }

  function callFn(name: string, args: Node[], ctx: EvalSheet): Value {
    const N = (i: number) => toNum(evalNode(args[i], ctx))
    switch (name) {
      // --- error / logic (lazy) ---
      case 'IFERROR': case 'IFNA': { const v = evalNode(args[0], ctx); return v == null ? evalNode(args[1], ctx) : v }
      case 'IF': return truthy(evalNode(args[0], ctx)) ? evalNode(args[1], ctx) : (args[2] != null ? evalNode(args[2], ctx) : false)
      case 'IFS': { for (let i = 0; i + 1 < args.length; i += 2) if (truthy(evalNode(args[i], ctx))) return evalNode(args[i + 1], ctx); return null }
      case 'AND': return args.every((a) => truthy(evalNode(a, ctx)))
      case 'OR': return args.some((a) => truthy(evalNode(a, ctx)))
      case 'NOT': return !truthy(evalNode(args[0], ctx))
      case 'TRUE': return true
      case 'FALSE': return false
      // --- aggregates ---
      case 'SUM': return argNums(args, ctx).reduce((s, n) => s + n, 0)
      case 'PRODUCT': { const a = argNums(args, ctx); return a.length ? a.reduce((s, n) => s * n, 1) : 0 }
      case 'AVERAGE': case 'AVG': case 'MEAN': { const a = argNums(args, ctx); return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null }
      case 'MIN': { const a = argNums(args, ctx); return a.length ? Math.min(...a) : 0 }
      case 'MAX': { const a = argNums(args, ctx); return a.length ? Math.max(...a) : 0 }
      case 'MEDIAN': { const a = argNums(args, ctx).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 }
      case 'COUNT': return argNums(args, ctx).length
      case 'COUNTA': { let c = 0; for (const a of args) { const rect = rectOf(a, ctx); if (rect) c += cellsOf(rect).filter((v) => v !== null && v !== '').length; else if (evalNode(a, ctx) != null && evalNode(a, ctx) !== '') c++ } return c }
      case 'SUMPRODUCT': { const rects = args.map((a) => rectOf(a, ctx)); if (!rects[0]) return 0; const cols = rects.map((r) => r ? cellsOf(r).map((v) => toNum(v) ?? 0) : []); const len = cols[0].length; let s = 0; for (let i = 0; i < len; i++) { let p = 1; for (const c of cols) p *= c[i] ?? 0; s += p } return s }
      // --- conditional aggregates ---
      case 'SUMIF': case 'COUNTIF': case 'AVERAGEIF': {
        const rng = rectOf(args[0], ctx); if (!rng) return name === 'COUNTIF' ? 0 : 0
        const crit = evalNode(args[1], ctx)
        const cells = cellsOf(rng)
        const sumRect = name === 'SUMIF' && args[2] ? rectOf(args[2], ctx) : (name === 'AVERAGEIF' && args[2] ? rectOf(args[2], ctx) : rng)
        const sumCells = sumRect ? cellsOf(sumRect) : cells
        let sum = 0, count = 0
        for (let i = 0; i < cells.length; i++) if (matches(cells[i], crit)) { count++; const n = toNum(sumCells[i]); if (n != null) sum += n }
        if (name === 'COUNTIF') return count
        if (name === 'AVERAGEIF') return count ? sum / count : null
        return sum
      }
      case 'SUMIFS': case 'COUNTIFS': case 'AVERAGEIFS': {
        const isCount = name === 'COUNTIFS'
        const sumRect = isCount ? null : rectOf(args[0], ctx)
        const start = isCount ? 0 : 1
        const pairs: Array<{ cells: Value[]; crit: Value }> = []
        for (let i = start; i + 1 < args.length; i += 2) { const rc = rectOf(args[i], ctx); if (rc) pairs.push({ cells: cellsOf(rc), crit: evalNode(args[i + 1], ctx) }) }
        const sumCells = sumRect ? cellsOf(sumRect) : []
        const len = pairs[0]?.cells.length ?? 0
        let sum = 0, count = 0
        for (let i = 0; i < len; i++) if (pairs.every((p) => matches(p.cells[i], p.crit))) { count++; if (!isCount) { const n = toNum(sumCells[i]); if (n != null) sum += n } }
        if (isCount) return count
        if (name === 'AVERAGEIFS') return count ? sum / count : null
        return sum
      }
      // --- math ---
      case 'ABS': { const n = N(0); return n == null ? null : Math.abs(n) }
      case 'ROUND': { const n = N(0), d = N(1) ?? 0; return n == null ? null : Math.round(n * 10 ** d) / 10 ** d }
      case 'ROUNDUP': { const n = N(0), d = N(1) ?? 0; return n == null ? null : Math.ceil(Math.abs(n) * 10 ** d) / 10 ** d * Math.sign(n) }
      case 'ROUNDDOWN': case 'TRUNC': { const n = N(0), d = N(1) ?? 0; return n == null ? null : Math.floor(Math.abs(n) * 10 ** d) / 10 ** d * Math.sign(n) }
      case 'CEILING': { const n = N(0), s = N(1) ?? 1; return n == null ? null : Math.ceil(n / s) * s }
      case 'FLOOR': { const n = N(0), s = N(1) ?? 1; return n == null ? null : Math.floor(n / s) * s }
      case 'SQRT': { const n = N(0); return n == null ? null : Math.sqrt(n) }
      case 'INT': { const n = N(0); return n == null ? null : Math.floor(n) }
      case 'MOD': { const a = N(0), b = N(1); return a == null || !b ? null : a - b * Math.floor(a / b) }
      case 'POWER': { const a = N(0), b = N(1); return a == null || b == null ? null : a ** b }
      case 'EXP': { const n = N(0); return n == null ? null : Math.exp(n) }
      case 'LN': { const n = N(0); return n == null || n <= 0 ? null : Math.log(n) }
      case 'LOG': { const n = N(0), b = N(1) ?? 10; return n == null || n <= 0 ? null : Math.log(n) / Math.log(b) }
      case 'SIGN': { const n = N(0); return n == null ? null : Math.sign(n) }
      case 'SUMSQ': return argNums(args, ctx).reduce((s, n) => s + n * n, 0)
      // --- lookups ---
      case 'VLOOKUP': case 'HLOOKUP': {
        const key = evalNode(args[0], ctx); const rect = rectOf(args[1], ctx); const idx = N(2) ?? 1
        const exact = args[3] != null ? !truthy(evalNode(args[3], ctx)) : false
        if (!rect) return null
        const horiz = name === 'HLOOKUP'
        const lines = horiz ? rect.r2 - rect.r1 + 1 : rect.c2 - rect.c1 + 1
        void lines
        const count = horiz ? rect.c2 - rect.c1 + 1 : rect.r2 - rect.r1 + 1
        let best = -1
        for (let i = 0; i < count; i++) {
          const cellVal = horiz ? evalCell(rect.sheet, rect.r1, rect.c1 + i) : evalCell(rect.sheet, rect.r1 + i, rect.c1)
          if (exact) { if (matchEq(cellVal, key)) { best = i; break } }
          else { const cn = toNum(cellVal), kn = toNum(key); if (cn != null && kn != null && cn <= kn) best = i; else if (cn != null && kn != null && cn > kn) break }
        }
        if (best < 0) return null
        return horiz ? evalCell(rect.sheet, rect.r1 + idx - 1, rect.c1 + best) : evalCell(rect.sheet, rect.r1 + best, rect.c1 + idx - 1)
      }
      case 'XLOOKUP': {
        const key = evalNode(args[0], ctx); const look = rectOf(args[1], ctx); const ret = rectOf(args[2], ctx)
        if (!look || !ret) return args[3] != null ? evalNode(args[3], ctx) : null
        const lv = cellsOf(look)
        for (let i = 0; i < lv.length; i++) if (matchEq(lv[i], key)) return cellsOf(ret)[i] ?? null
        return args[3] != null ? evalNode(args[3], ctx) : null
      }
      case 'MATCH': {
        const key = evalNode(args[0], ctx); const rect = rectOf(args[1], ctx); const type = args[2] != null ? (N(2) ?? 1) : 1
        if (!rect) return null
        const arr = cellsOf(rect)
        if (type === 0) { for (let i = 0; i < arr.length; i++) if (matchEq(arr[i], key)) return i + 1; return null }
        let best = -1; const kn = toNum(key)
        for (let i = 0; i < arr.length; i++) { const n = toNum(arr[i]); if (n == null || kn == null) continue; if (type === 1 && n <= kn) best = i; else if (type === -1 && n >= kn) best = i }
        return best >= 0 ? best + 1 : null
      }
      case 'INDEX': {
        const rect = rectOf(args[0], ctx); if (!rect) return null
        const rr = N(1) ?? 0; const cc = args[2] != null ? (N(2) ?? 0) : 0
        const rows = rect.r2 - rect.r1 + 1, cols = rect.c2 - rect.c1 + 1
        const r = rows === 1 ? rect.r1 : rect.r1 + (rr - 1)
        const c = cols === 1 ? rect.c1 : rect.c1 + ((cc || rr) - 1)
        return evalCell(rect.sheet, r, c)
      }
      case 'OFFSET': { const rect = offsetRect(args, ctx); if (!rect) return null; if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return evalCell(rect.sheet, rect.r1, rect.c1); const a = numsOf(rect); return a.length ? a.reduce((s, n) => s + n, 0) : null }
      // --- text / misc ---
      case 'CONCATENATE': case 'CONCAT': return args.map((a) => { const v = evalNode(a, ctx); return v == null ? '' : String(v) }).join('')
      case 'LEN': { const v = evalNode(args[0], ctx); return v == null ? 0 : String(v).length }
      case 'YEAR': { const n = N(0); return n == null ? null : new Date((n - 25569) * 86400000).getUTCFullYear() }
      default: return null
    }
  }
  const matchEq = (a: Value, b: Value): boolean => {
    const an = toNum(a), bn = toNum(b)
    if (an != null && bn != null) return an === bn
    return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
  }

  function evalNode(node: Node | null, ctx: EvalSheet): Value {
    if (!node) return null
    switch (node.k) {
      case 'num': return node.v
      case 'str': return node.v
      case 'neg': { const v = toNum(evalNode(node.e, ctx)); return v == null ? null : -v }
      case 'ref': { const sh = sheetFor(node.sheet, ctx); return sh ? evalCell(sh, node.row, node.col) : null }
      case 'range': case 'colrange': { const rect = rectOf(node, ctx); if (!rect) return null; return evalCell(rect.sheet, rect.r1, rect.c1) } // bare range → top-left
      case 'call': return callFn(node.name, node.args, ctx)
      case 'bin': {
        if (node.op === '&') { const l = evalNode(node.l, ctx), r = evalNode(node.r, ctx); return `${l == null ? '' : l}${r == null ? '' : r}` }
        const l = toNum(evalNode(node.l, ctx)), r = toNum(evalNode(node.r, ctx))
        if (l == null || r == null) return null
        switch (node.op) { case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return r === 0 ? null : l / r; case '^': return l ** r }
        return null
      }
      case 'cmp': {
        const l = evalNode(node.l, ctx), r = evalNode(node.r, ctx)
        const ln = toNum(l), rn = toNum(r)
        const useNum = ln != null && rn != null
        const a: number | string = useNum ? ln! : String(l ?? '')
        const b: number | string = useNum ? rn! : String(r ?? '')
        switch (node.op) { case '=': return a === b; case '<>': return a !== b; case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b }
        return null
      }
    }
  }

  function run(formula: string, ctx: EvalSheet): Value {
    try {
      const toks = tokenize(formula.trimStart().replace(/^=/, ''))
      if (!toks) return null
      const ast = parse(toks)
      return evalNode(ast, ctx)
    } catch {
      return null
    }
  }

  return {
    /** Computed display value for rows[dataRowIdx][colIdx]. */
    value(sheetIdx: number, dataRowIdx: number, colIdx: number): Cell {
      const sheet = sheets[sheetIdx]
      const raw = sheet?.rows?.[dataRowIdx]?.[colIdx]
      if (!isFormula(raw)) return (raw as Cell) ?? ''
      const v = evalCell(sheet, dataRowIdx + 2, colIdx)
      if (v == null) return raw as string // uncomputable → show formula (rare; backend wraps in IFERROR)
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
      return v
    },
  }
}
