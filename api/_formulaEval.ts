// Bounded, dependency-free Excel formula evaluation shared by previews and XLSX.
// Unsupported syntax/functions are NOT numeric zero, even inside IFERROR: Excel
// may support them, but we cannot truthfully cache a result until it recalculates.
export type Cell = string | number | boolean
export interface EvalSheet { name?: string; columns?: string[]; rows?: Cell[][] }
type Value = Cell | null
export type FormulaErrorCode = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#NULL!'
export type Evaluation = { status: 'value'; value: Value } | { status: 'error'; error: FormulaErrorCode; message: string } | { status: 'unsupported'; error: FormulaErrorCode; message: string }
class Fault extends Error {
  constructor(readonly code: FormulaErrorCode, message: string, readonly unsupported = false) { super(message) }
}
const fail = (code: FormulaErrorCode, message: string = code, unsupported = false): never => { throw new Fault(code, message, unsupported) }
const finite = (n: number): number => Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : fail('#NUM!')
const formula = (v: unknown): v is string => typeof v === 'string' && v.trimStart().startsWith('=')
const colIndex = (s: string) => [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
function numeric(v: Value): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return finite(v)
  if (typeof v === 'boolean') return +v
  // Never turn text such as "FY2026" or "1,2,3" into a factual number.
  const s = v.trim()
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d*)?)%?$/.test(s)) return null
  return finite(Number(s.replace(/[% ,]/g, '')) / (s.endsWith('%') ? 100 : 1))
}
const number = (v: Value): number => v == null || v === '' ? 0 : numeric(v) ?? fail('#VALUE!')
const truth = (v: Value): boolean => {
  if (typeof v === 'boolean') return v
  if (v == null || v === '') return false
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return /^true$/i.test(v)
  return (numeric(v) ?? fail('#VALUE!')) !== 0
}
function roundDecimal(n: number, digits: number, mode: 'nearest' | 'up' | 'down' = 'nearest'): number {
  digits = Math.trunc(digits)
  if (digits > 308) return n
  if (digits < -308) return 0
  // Decimal shifting avoids the common ROUND(1.005,2) binary-float error and
  // handles midpoint negatives away from zero, as Excel does.
  const shift = (v: number, d: number) => { const [m, e = '0'] = String(v).split('e'); return Number(`${m}e${Number(e) + d}`) }
  const shifted = shift(Math.abs(n), digits)
  if (!Number.isFinite(shifted)) return n
  const rounded = mode === 'up' ? Math.ceil(shifted) : mode === 'down' ? Math.floor(shifted) : Math.round(shifted)
  return finite(Math.sign(n) * shift(rounded, -digits))
}

type Tok = { type: string; text: string }
type Node = { kind: 'literal'; value: Value } | { kind: 'error'; code: FormulaErrorCode } |
  { kind: 'ref'; sheet?: string; r1: number; r2: number; c1: number; c2: number; whole?: boolean } |
  { kind: 'unary'; op: string; node: Node } | { kind: 'binary'; op: string; left: Node; right: Node } |
  { kind: 'call'; name: string; args: Node[] }
function parse(source: string): Node {
  if (source.length > 20000) return fail('#VALUE!', 'Formula exceeds the preview calculation limit.', true)
  const patterns: [string, RegExp][] = [
    ['space', /^\s+/], ['string', /^"(?:[^"]|"")*"/],
    ['error', /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|NULL!)/i],
    ['number', /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/],
    ['sheet', /^(?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*)!/],
    ['ref', /^\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_(])/],
    ['word', /^\$?[A-Za-z_][A-Za-z0-9_.]*/], ['op', /^(?:<=|>=|<>|[+\-*/^&%=<>():,])/],
  ]
  const tokens: Tok[] = []
  let remaining = source.trimStart().replace(/^=/, '')
  while (remaining) {
    const found = patterns.map(([type, regex]) => ({ type, match: regex.exec(remaining) })).find(({ match }) => match)
    if (!found?.match) return fail('#NAME?', 'Formula syntax is not supported in the preview.', true)
    if (found.type !== 'space') tokens.push({ type: found.type, text: found.match[0] })
    remaining = remaining.slice(found.match[0].length)
  }
  let at = 0, depth = 0
  const peek = (text: string) => tokens[at]?.text === text
  const take = (text: string) => { if (!peek(text)) fail('#VALUE!', `Expected ${text} in formula.`); at++ }
  function reference(sheet?: string): Node {
    const t = tokens[at++]
    if (!t) return fail('#REF!')
    const cell = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(t.text)
    const column = /^\$?([A-Za-z]{1,3})$/.exec(t.text)
    if (!cell && !column) return fail('#REF!')
    const c1 = colIndex((cell || column)![1]), r1 = cell ? Number(cell[2]) : 1
    let c2 = c1, r2 = r1
    if (peek(':')) {
      at++
      const next = tokens[at++]
      const end = next && (cell ? /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(next.text) : /^\$?([A-Za-z]{1,3})$/.exec(next.text))
      if (!end) return fail('#REF!')
      c2 = colIndex(end[1]); r2 = cell ? Number(end[2]) : 1048576
    } else if (!cell) return fail('#NAME?', 'Named ranges are not supported in the preview.', true)
    if (c1 > 16383 || c2 > 16383 || r1 < 1 || r2 < 1 || r1 > 1048576 || r2 > 1048576) return fail('#REF!')
    return { kind: 'ref', sheet, r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2), whole: !cell }
  }
  function primary(): Node {
    if (++depth > 128) return fail('#VALUE!', 'Formula nesting exceeds the preview calculation limit.', true)
    try {
      const t = tokens[at]
      if (!t) return fail('#VALUE!', 'Incomplete formula.')
      if (t.text === '+' || t.text === '-') { at++; return { kind: 'unary', op: t.text, node: primary() } }
      if (t.text === '(') { at++; const value = expr(0); take(')'); return value }
      if (t.type === 'number') { at++; return { kind: 'literal', value: finite(Number(t.text)) } }
      if (t.type === 'string') { at++; return { kind: 'literal', value: t.text.slice(1, -1).replace(/""/g, '"') } }
      if (t.type === 'error') { at++; return { kind: 'error', code: t.text.toUpperCase() as FormulaErrorCode } }
      if (t.type === 'sheet') {
        at++; let name = t.text.slice(0, -1)
        if (name.startsWith("'")) name = name.slice(1, -1).replace(/''/g, "'")
        return reference(name)
      }
      if (t.type === 'ref') return reference()
      if (t.type === 'word') {
        if (tokens[at + 1]?.text === ':') return reference()
        at++
        if (peek('(')) {
          at++; const args: Node[] = []
          if (!peek(')')) for (;;) {
            args.push(peek(',') || peek(')') ? { kind: 'literal', value: null } : expr(0))
            if (!peek(',')) break
            at++
          }
          take(')')
          return { kind: 'call', name: t.text.toUpperCase(), args }
        }
        if (/^(true|false)$/i.test(t.text)) return { kind: 'literal', value: /^true$/i.test(t.text) }
        return fail('#NAME?', `Named value ${t.text} is not supported in the preview.`, true)
      }
      return fail('#VALUE!', 'Malformed formula.')
    } finally { depth-- }
  }
  const precedence: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }
  function expr(min: number): Node {
    let left = primary()
    for (;;) {
      if (peek('%')) { at++; left = { kind: 'unary', op: '%', node: left }; continue }
      const op = tokens[at]?.text, p = precedence[op]
      if (p == null || p < min) return left
      at++; left = { kind: 'binary', op, left, right: expr(p + 1) }
    }
  }
  const node = expr(0)
  if (at !== tokens.length) return fail('#VALUE!', 'Unexpected trailing formula content.')
  return node
}

// Inclusive arity bounds keep omitted/extra arguments from silently changing a
// function's meaning. Optional empty arguments are represented as blank values.
const arities: Record<string, [number, number]> = {
  IF: [2, 3], IFERROR: [2, 2], IFNA: [2, 2], IFS: [2, 254], AND: [1, 255], OR: [1, 255], NOT: [1, 1], TRUE: [0, 0], FALSE: [0, 0],
  SUM: [1, 255], PRODUCT: [1, 255], AVERAGE: [1, 255], MIN: [1, 255], MAX: [1, 255], MEDIAN: [1, 255], COUNT: [1, 255], COUNTA: [1, 255], SUMSQ: [1, 255], SUMPRODUCT: [1, 255],
  SUMIF: [2, 3], COUNTIF: [2, 2], AVERAGEIF: [2, 3], SUMIFS: [3, 255], COUNTIFS: [2, 254], AVERAGEIFS: [3, 255],
  ABS: [1, 1], ROUND: [2, 2], ROUNDUP: [2, 2], ROUNDDOWN: [2, 2], TRUNC: [1, 2], CEILING: [2, 2], FLOOR: [2, 2], SQRT: [1, 1], INT: [1, 1], MOD: [2, 2], POWER: [2, 2], EXP: [1, 1], LN: [1, 1], LOG: [1, 2], SIGN: [1, 1],
  VLOOKUP: [3, 4], HLOOKUP: [3, 4], XLOOKUP: [3, 6], INDEX: [2, 3], MATCH: [2, 3], OFFSET: [3, 5],
  CONCATENATE: [1, 255], CONCAT: [1, 255], LEN: [1, 1], YEAR: [1, 1],
  PMT: [3, 5], PV: [3, 5], FV: [3, 5], NPER: [3, 5], IPMT: [4, 6], PPMT: [4, 6], NPV: [2, 255], IRR: [1, 2], RATE: [3, 6],
}
function compare(a: Value, b: Value): number {
  // References to blank cells compare as zero against numeric values.
  if (a == null || a === '') a = typeof b === 'number' ? 0 : ''
  if (b == null || b === '') b = typeof a === 'number' ? 0 : ''
  if (typeof a !== typeof b) { const rank = (v: Value) => typeof v === 'boolean' ? 2 : typeof v === 'string' ? 1 : 0; return rank(a) - rank(b) }
  if (typeof a === 'string' && typeof b === 'string') { a = a.toLowerCase(); b = b.toLowerCase() }
  return a! < b! ? -1 : a! > b! ? 1 : 0
}
const wildcard = (pattern: string): RegExp => {
  let result = '^'
  for (let i = 0; i < pattern.length; i++) {
    let c = pattern[i]
    if (c === '~' && i + 1 < pattern.length) c = pattern[++i]
    else if (c === '*') { result += '.*'; continue }
    else if (c === '?') { result += '.'; continue }
    result += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(result + '$', 'i')
}
function criterion(v: Value, crit: Value): boolean {
  if (typeof crit !== 'string') return compare(v, crit) === 0
  const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(crit), op = m?.[1] || '=', rhs = m?.[2] ?? crit
  const n = numeric(rhs), target = n ?? rhs
  let result: number
  if (typeof target === 'number') {
    const candidate = v == null || v === '' ? 0 : typeof v === 'boolean' ? null : numeric(v)
    if (candidate == null) return op === '<>'
    result = compare(candidate, target)
  } else result = (op === '=' || op === '<>') ? ((typeof v === 'string' || target === '') && wildcard(target).test(String(v ?? '')) ? 0 : 1) : compare(v, target)
  return op === '=' ? result === 0 : op === '<>' ? result !== 0 : op === '<' ? result < 0 : op === '>' ? result > 0 : op === '<=' ? result <= 0 : result >= 0
}
function payment(rate: number, periods: number, pv: number, fv = 0, type = 0): number {
  if (periods <= 0 || rate <= -1 || (type !== 0 && type !== 1)) return fail('#NUM!')
  if (rate === 0) return -(pv + fv) / periods
  const growthMinusOne = Math.expm1(periods * Math.log1p(rate))
  return finite(-(pv * (growthMinusOne + 1) + fv) * rate / ((1 + rate * type) * growthMinusOne))
}
function future(rate: number, periods: number, pmt: number, pv = 0, type = 0): number {
  if (rate <= -1 || (type !== 0 && type !== 1)) return fail('#NUM!')
  if (rate === 0) return -(pv + pmt * periods)
  const growthMinusOne = Math.expm1(periods * Math.log1p(rate))
  return finite(-(pv * (1 + growthMinusOne) + pmt * (1 + rate * type) * growthMinusOne / rate))
}
function rootRate(fn: (rate: number) => number, guess: number, scale: number): number {
  if (guess <= -1) return fail('#NUM!')
  let rate = guess
  for (let i = 0; i < 100; i++) {
    const value = fn(rate)
    if (Number.isFinite(value) && Math.abs(value) <= 1e-10 * Math.max(1, scale)) return rate
    const h = Math.max(1e-7, Math.abs(rate) * 1e-5), lower = Math.max(-0.999999999, rate - h)
    const slope = (fn(rate + h) - fn(lower)) / (rate + h - lower)
    if (!Number.isFinite(slope) || slope === 0) break
    const next = rate - value / slope
    if (!Number.isFinite(next) || next <= -1 || Math.abs(next) > 1e10) break
    rate = next
  }
  return fail('#NUM!', 'The financial rate did not converge; change the guess or review the cash flows.')
}

export function buildEvaluator(sheets: EvalSheet[]) {
  const byName = new Map<string, number>()
  sheets.forEach((s, i) => { if (s.name && !byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), i) })
  const cache = new Map<string, Value | Fault>(), visiting = new Set<string>(), parsed = new Map<string, Node>()
  let operations = 0
  const budget = () => { if (++operations > 500000) fail('#VALUE!', 'Workbook exceeds the preview calculation limit.', true) }
  const sheetIndex = (name: string | undefined, si: number) => name ? byName.get(name.toLowerCase()) ?? fail('#REF!', `Worksheet ${name} does not exist.`) : si
  function cell(si: number, row: number, col: number): Value {
    budget()
    if (!sheets[si] || row < 1 || col < 0 || row > 1048576 || col > 16383) return fail('#REF!')
    const key = `${si}:${row}:${col}`
    if (cache.has(key)) { const v = cache.get(key)!; if (v instanceof Fault) throw v; return v }
    if (visiting.has(key)) return fail('#REF!', 'Circular cell reference.', true)
    if (visiting.size > 128) return fail('#VALUE!', 'Reference chain exceeds the preview calculation limit.', true)
    const raw = row === 1 ? sheets[si].columns?.[col] : sheets[si].rows?.[row - 2]?.[col]
    if (!formula(raw)) return raw ?? null
    visiting.add(key)
    try {
      let node = parsed.get(raw)
      if (!node) { node = parse(raw); parsed.set(raw, node) }
      const v = evaluate(node, si)
      if (typeof v === 'number') finite(v)
      cache.set(key, v); return v
    } catch (error) { const fault = error instanceof Fault ? error : new Fault('#VALUE!', 'Unable to evaluate formula.', true); cache.set(key, fault); throw fault }
    finally { visiting.delete(key) }
  }
  type Rect = { si: number; r1: number; r2: number; c1: number; c2: number }
  function rect(node: Node, si: number): Rect | null {
    if (node?.kind === 'ref') { const index = sheetIndex(node.sheet, si); return { ...node, si: index, r2: node.whole ? Math.max(1, (sheets[index].rows?.length || 0) + 1) : node.r2 } }
    if (node?.kind === 'call' && node.name === 'OFFSET') {
      const args = node.args, base = rect(args[0], si)
      if (!base) return fail('#VALUE!')
      const r1 = base.r1 + Math.trunc(number(evaluate(args[1], si))), c1 = base.c1 + Math.trunc(number(evaluate(args[2], si)))
      const h = args[3] ? Math.trunc(number(evaluate(args[3], si))) : base.r2 - base.r1 + 1, w = args[4] ? Math.trunc(number(evaluate(args[4], si))) : base.c2 - base.c1 + 1
      if (r1 < 1 || c1 < 0 || h < 1 || w < 1 || r1 + h > 1048577 || c1 + w > 16384) return fail('#REF!')
      return { si: base.si, r1, c1, r2: r1 + h - 1, c2: c1 + w - 1 }
    }
    return null
  }
  function values(r: Rect): Value[] {
    if ((r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1) > 100000) return fail('#VALUE!', 'Range exceeds the preview calculation limit.', true)
    const result: Value[] = []
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) result.push(cell(r.si, row, col))
    return result
  }
  function nums(args: Node[], si: number): number[] {
    const result: number[] = []
    for (const a of args) {
      const r = rect(a, si)
      // Excel aggregate ranges ignore text and booleans; literal arguments can
      // coerce numeric strings/booleans. SUM("123") differs from SUM(A1).
      if (r) { for (const v of values(r)) if (typeof v === 'number') result.push(v) }
      else { const v = evaluate(a, si); if (v != null) result.push(number(v)) }
    }
    return result
  }
  function call(name: string, args: Node[], si: number): Value {
    const arity = arities[name]
    if (!arity) return fail('#NAME?', `${name} is not supported in the preview. Open the workbook in Excel to calculate it.`, true)
    if (args.length < arity[0] || args.length > arity[1]) return fail('#VALUE!', `Wrong number of arguments for ${name}.`)
    const V = (i: number, fallback: Value = null) => args[i] ? evaluate(args[i], si) : fallback
    const N = (i: number, fallback = 0) => args[i] ? number(V(i)) : fallback
    const R = (i: number) => rect(args[i], si) ?? fail('#VALUE!', `${name} requires a cell range.`)
    const A = (i: number) => values(R(i))
    if (name === 'IFERROR' || name === 'IFNA') {
      try { return V(0) } catch (e) { if (e instanceof Fault && !e.unsupported && (name === 'IFERROR' || e.code === '#N/A')) return V(1); throw e }
    }
    switch (name) {
      case 'IF': return truth(V(0)) ? V(1) : V(2, false)
      case 'IFS': { if (args.length % 2) return fail('#VALUE!'); for (let i = 0; i < args.length; i += 2) if (truth(V(i))) return V(i + 1); return fail('#N/A') }
      case 'AND': case 'OR': {
        const booleans: boolean[] = []
        for (const a of args) { const r = rect(a, si); if (r) { for (const v of values(r)) if (typeof v === 'number' || typeof v === 'boolean') booleans.push(truth(v)) } else booleans.push(truth(evaluate(a, si))) }
        if (!booleans.length) return fail('#VALUE!')
        return name === 'AND' ? booleans.every(Boolean) : booleans.some(Boolean)
      }
      case 'NOT': return !truth(V(0))
      case 'TRUE': return true
      case 'FALSE': return false
      case 'SUM': return finite(nums(args, si).reduce((a, b) => a + b, 0))
      case 'PRODUCT': { const n = nums(args, si); return finite(n.length ? n.reduce((a, b) => a * b, 1) : 0) }
      case 'AVERAGE': { const n = nums(args, si); return n.length ? finite(n.reduce((a, b) => a + b, 0) / n.length) : fail('#DIV/0!') }
      case 'MIN': case 'MAX': { const n = nums(args, si); return n.length ? n.reduce((a, b) => name === 'MIN' ? Math.min(a, b) : Math.max(a, b)) : 0 }
      case 'MEDIAN': { const n = nums(args, si).sort((a, b) => a - b), mid = Math.floor(n.length / 2); return n.length ? n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2 : fail('#NUM!') }
      case 'COUNT': case 'COUNTA': {
        let count = 0
        for (const a of args) {
          const r = rect(a, si)
          if (r) { for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) { try { const v = cell(r.si, row, col); if (name === 'COUNTA' ? v != null : typeof v === 'number') count++ } catch (e) { if (e instanceof Fault && !e.unsupported) { if (name === 'COUNTA') count++ } else throw e } } }
          else { const v = V(args.indexOf(a)); if (name === 'COUNTA' ? v != null : numeric(v) != null) count++ }
        }
        return count
      }
      case 'SUMSQ': return finite(nums(args, si).reduce((s, n) => s + n * n, 0))
      case 'SUMPRODUCT': {
        const arrays = args.map((a) => { const r = rect(a, si); return r ? values(r) : [evaluate(a, si)] })
        if (arrays.some((a) => a.length !== arrays[0].length)) return fail('#VALUE!')
        return finite(arrays[0].reduce<number>((sum, _, i) => sum + arrays.reduce((product, a) => product * (typeof a[i] === 'number' ? a[i] as number : 0), 1), 0))
      }
      case 'SUMIF': case 'AVERAGEIF': case 'COUNTIF': case 'SUMIFS': case 'AVERAGEIFS': case 'COUNTIFS': {
        const plural = name.endsWith('IFS'), countOnly = name.startsWith('COUNT'), average = name.startsWith('AVERAGE')
        let rangeRects: Rect[], criteria: Value[], sumRect: Rect
        if (!plural) {
          rangeRects = [R(0)]; criteria = [V(1)]; sumRect = args[2] ? R(2) : rangeRects[0]
          // SUMIF uses the criteria range's dimensions starting at sum_range's
          // top-left cell, even when the caller supplies only that first cell.
          sumRect = { ...sumRect, r2: sumRect.r1 + rangeRects[0].r2 - rangeRects[0].r1, c2: sumRect.c1 + rangeRects[0].c2 - rangeRects[0].c1 }
        } else {
          const start = countOnly ? 0 : 1; if ((args.length - start) % 2) return fail('#VALUE!')
          rangeRects = []; criteria = []
          for (let i = start; i < args.length; i += 2) { rangeRects.push(R(i)); criteria.push(V(i + 1)) }
          sumRect = countOnly ? rangeRects[0] : R(0)
          if (rangeRects.some((r) => r.r2 - r.r1 !== sumRect.r2 - sumRect.r1 || r.c2 - r.c1 !== sumRect.c2 - sumRect.c1)) return fail('#VALUE!', 'Conditional ranges must have matching dimensions.')
        }
        const ranges = rangeRects.map(values), width = sumRect.c2 - sumRect.c1 + 1
        let total = 0, count = 0
        for (let i = 0; i < ranges[0].length; i++) if (ranges.every((r, j) => criterion(r[i], criteria[j]))) {
          if (countOnly) count++
          else {
            const value = cell(sumRect.si, sumRect.r1 + Math.floor(i / width), sumRect.c1 + i % width)
            if (typeof value === 'number') { total += value; count++ }
          }
        }
        return countOnly ? count : average ? count ? finite(total / count) : fail('#DIV/0!') : finite(total)
      }
      case 'ABS': return Math.abs(N(0))
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': case 'TRUNC': return roundDecimal(N(0), N(1), name === 'ROUND' ? 'nearest' : name === 'ROUNDUP' ? 'up' : 'down')
      case 'CEILING': case 'FLOOR': { const n = N(0), significance = N(1); if (!significance) return name === 'CEILING' ? 0 : fail('#DIV/0!'); if (n > 0 && significance < 0) return fail('#NUM!'); return finite((name === 'CEILING' ? Math.ceil(n / significance) : Math.floor(n / significance)) * significance) }
      case 'SQRT': return finite(Math.sqrt(N(0)))
      case 'INT': return Math.floor(N(0))
      case 'MOD': { const b = N(1); return b ? finite(N(0) - b * Math.floor(N(0) / b)) : fail('#DIV/0!') }
      case 'POWER': return finite(N(0) ** N(1))
      case 'EXP': return finite(Math.exp(N(0)))
      case 'LN': return finite(Math.log(N(0)))
      case 'LOG': return finite(Math.log(N(0)) / Math.log(N(1, 10)))
      case 'SIGN': return Math.sign(N(0))
      case 'PMT': return payment(N(0), N(1), N(2), N(3), N(4))
      case 'FV': return future(N(0), N(1), N(2), N(3), N(4))
      case 'PV': { const r = N(0), n = N(1), pmt = N(2), fv = N(3), type = N(4); if (r <= -1 || (type !== 0 && type !== 1)) return fail('#NUM!'); if (!r) return -(fv + pmt * n); const growth = Math.expm1(n * Math.log1p(r)); return finite(-(fv + pmt * (1 + r * type) * growth / r) / (1 + growth)) }
      case 'NPER': { const r = N(0), pmt = N(1), pv = N(2), fv = N(3), type = N(4); if (r <= -1 || (type !== 0 && type !== 1)) return fail('#NUM!'); if (!r) return pmt ? finite(-(pv + fv) / pmt) : fail('#DIV/0!'); const a = pmt * (1 + r * type); return finite(Math.log((a - fv * r) / (a + pv * r)) / Math.log1p(r)) }
      case 'IPMT': case 'PPMT': { const r = N(0), period = N(1), n = N(2), pv = N(3), fv = N(4), type = N(5); if (period < 1 || period > n) return fail('#NUM!'); const pmt = payment(r, n, pv, fv, type); const interest = !r || (type === 1 && period === 1) ? 0 : future(r, period - 1, pmt, pv, type) * r / (1 + r * type); return finite(name === 'IPMT' ? interest : pmt - interest) }
      case 'NPV': { const rate = N(0); if (rate === -1) return fail('#DIV/0!'); return finite(nums(args.slice(1), si).reduce((total, amount, i) => total + amount / (1 + rate) ** (i + 1), 0)) }
      case 'IRR': { const flows = nums([args[0]], si); if (!flows.some((n) => n < 0) || !flows.some((n) => n > 0)) return fail('#NUM!'); return rootRate((r) => flows.reduce((s, n, i) => s + n / (1 + r) ** i, 0), N(1, 0.1), Math.max(...flows.map(Math.abs))) }
      case 'RATE': { const n = N(0), pmt = N(1), pv = N(2), fv = N(3), type = N(4); if (n <= 0 || (type !== 0 && type !== 1)) return fail('#NUM!'); return rootRate((r) => { try { return future(r, n, pmt, pv, type) - fv } catch { return NaN } }, N(5, 0.1), Math.max(Math.abs(pv), Math.abs(fv), Math.abs(pmt * n))) }
      case 'VLOOKUP': case 'HLOOKUP': {
        const key = V(0), r = R(1), index = Math.trunc(N(2)), horizontal = name === 'HLOOKUP', exact = args[3] ? !truth(V(3)) : false
        const width = horizontal ? r.r2 - r.r1 + 1 : r.c2 - r.c1 + 1, length = horizontal ? r.c2 - r.c1 + 1 : r.r2 - r.r1 + 1
        if (index < 1) return fail('#VALUE!'); if (index > width) return fail('#REF!')
        let found = -1
        for (let i = 0; i < length; i++) { const v = cell(r.si, horizontal ? r.r1 : r.r1 + i, horizontal ? r.c1 + i : r.c1), c = compare(v, key); if (exact ? typeof key === 'string' ? wildcard(key).test(String(v ?? '')) : c === 0 : c <= 0) { found = i; if (exact) break } }
        if (found < 0) return fail('#N/A')
        return cell(r.si, horizontal ? r.r1 + index - 1 : r.r1 + found, horizontal ? r.c1 + found : r.c1 + index - 1)
      }
      case 'MATCH': case 'XLOOKUP': {
        const key = V(0), lookup = A(1), mode = N(name === 'MATCH' ? 2 : 4, name === 'MATCH' ? 1 : 0), search = name === 'MATCH' ? 1 : N(5, 1)
        if (![0, 1, -1, ...(name === 'XLOOKUP' ? [2] : [])].includes(mode)) return fail('#VALUE!')
        if (search !== 1 && search !== -1) return fail('#NAME?', 'Binary XLOOKUP search is not supported in the preview.', true)
        const result = name === 'XLOOKUP' ? A(2) : null
        if (result && result.length !== lookup.length) return fail('#VALUE!')
        const sequence = lookup.map((_, i) => i); if (search === -1) sequence.reverse()
        let found = -1
        for (const i of sequence) {
          const c = compare(lookup[i], key), exact = (mode === 2 || (name === 'MATCH' && mode === 0)) && typeof key === 'string' ? wildcard(key).test(String(lookup[i] ?? '')) : c === 0
          if (exact) { found = i; break }
          const direction = name === 'MATCH' ? -mode : mode
          if ((direction === -1 && c < 0) || (direction === 1 && c > 0)) if (found < 0 || (direction === -1 ? compare(lookup[i], lookup[found]) > 0 : compare(lookup[i], lookup[found]) < 0)) found = i
        }
        if (found < 0) { if (name === 'XLOOKUP' && args[3]) return V(3); return fail('#N/A') }
        return result ? result[found] : found + 1
      }
      case 'INDEX': { const r = R(0), rows = r.r2 - r.r1 + 1, cols = r.c2 - r.c1 + 1; let row = Math.trunc(N(1)), col = args[2] ? Math.trunc(N(2)) : 1; if (rows === 1 && !args[2]) { col = row; row = 1 } if (row === 0 || col === 0) return fail('#NAME?', 'Array-valued INDEX is not supported in the preview.', true); if (row < 1 || col < 1 || row > rows || col > cols) return fail('#REF!'); return cell(r.si, r.r1 + row - 1, r.c1 + col - 1) }
      case 'OFFSET': { const r = rect({ kind: 'call', name, args }, si)!; if (r.r1 !== r.r2 || r.c1 !== r.c2) return fail('#NAME?', 'Array-valued OFFSET requires an aggregate function.', true); return cell(r.si, r.r1, r.c1) }
      case 'CONCAT': case 'CONCATENATE': return args.flatMap((a) => { const r = rect(a, si); return name === 'CONCAT' && r ? values(r) : [evaluate(a, si)] }).map((v) => v == null ? '' : typeof v === 'boolean' ? v ? 'TRUE' : 'FALSE' : String(v)).join('')
      case 'LEN': return String(V(0) ?? '').length
      case 'YEAR': { const value = V(0); if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) { const d = new Date(value + 'T00:00:00Z'); if (Number.isNaN(d.getTime())) return fail('#VALUE!'); return d.getUTCFullYear() } const serial = number(value); if (serial < 0) return fail('#NUM!'); return serial < 61 ? 1900 : new Date((serial - 25569) * 86400000).getUTCFullYear() }
    }
    return fail('#NAME?', `${name} is not supported in the preview.`, true)
  }
  function evaluate(node: Node, si: number): Value {
    budget()
    switch (node.kind) {
      case 'literal': return node.value
      case 'error': return fail(node.code)
      case 'ref': { const r = rect(node, si)!; if (r.r1 !== r.r2 || r.c1 !== r.c2) return fail('#NAME?', 'Array-valued formulas require an aggregate function.', true); return cell(r.si, r.r1, r.c1) }
      case 'unary': { const v = number(evaluate(node.node, si)); return node.op === '-' ? -v : node.op === '%' ? v / 100 : v }
      case 'call': return call(node.name, node.args, si)
      case 'binary': {
        const left = evaluate(node.left, si), right = evaluate(node.right, si)
        if (node.op === '&') { const text = (v: Value) => v == null ? '' : typeof v === 'boolean' ? v ? 'TRUE' : 'FALSE' : String(v); return text(left) + text(right) }
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) { const c = compare(left, right); return node.op === '=' ? c === 0 : node.op === '<>' ? c !== 0 : node.op === '<' ? c < 0 : node.op === '>' ? c > 0 : node.op === '<=' ? c <= 0 : c >= 0 }
        const a = number(left), b = number(right)
        if (node.op === '/' && b === 0) return fail('#DIV/0!')
        return finite(node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : node.op === '/' ? a / b : a ** b)
      }
    }
  }
  function result(si: number, ri: number, ci: number): Evaluation {
    operations = 0
    try { return { status: 'value', value: cell(si, ri + 2, ci) } }
    catch (error) { const e = error instanceof Fault ? error : new Fault('#VALUE!', 'Unable to evaluate formula.', true); return { status: e.unsupported ? 'unsupported' : 'error', error: e.code, message: e.message } }
  }
  return {
    result,
    value(si: number, ri: number, ci: number): Cell { const r = result(si, ri, ci); return r.status === 'value' ? r.value ?? '' : r.status === 'unsupported' ? '#UNSUPPORTED!' : r.error },
  }
}
