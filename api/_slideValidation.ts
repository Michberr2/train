type ObjectValue = Record<string, unknown>
type Issue = { kind: 'data' | 'density'; message: string }
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
// Keep literal wording and finite scalar values. Layout must never change the
// underlying metric, remove a qualifier, or turn a comparison's false into blank.
const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? String(value) : ''
const nonempty = (value: unknown): boolean => !!text(value).trim()
const layouts = ['bullets', 'stat', 'kpis', 'columns', 'chart', 'quote', 'table']

function chartNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // Bare numeric strings are losslessly recoverable. Currency symbols, percent
  // signs, K/M/B suffixes, ranges and unknowns need a new model answer with an
  // explicit numeric basis; stripping their characters can change the amount.
  if (typeof value !== 'string' || !/^[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(value.trim())) return null
  const number = Number(value.trim().replace(/,/g, ''))
  return Number.isFinite(number) ? number : null
}

export function normalizeGeneratedSlide(raw: unknown): { slide: ObjectValue; issues: Issue[] } {
  const input = object(raw)
  if (!input) return { slide: {}, issues: [{ kind: 'data', message: 'Each slide must be an object with a title and meaningful content.' }] }
  const slide: ObjectValue = { ...input, title: text(input.title), notes: text(input.notes), image: text(input.image) }
  const issues: Issue[] = []
  const issue = (message: string, kind: Issue['kind'] = 'data') => issues.push({ kind, message })
  const scalarFields = (value: ObjectValue, fields: string[]) => fields.forEach((field) => {
    if (value[field] != null && (typeof value[field] === 'object' || typeof value[field] === 'number' && !Number.isFinite(value[field]))) issue(`${field} must be readable scalar content; do not discard nested or invalid values.`)
  })
  scalarFields(input, ['title', 'notes', 'image'])
  const strings = (value: unknown, field: string): string[] => {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
    if (value != null && !Array.isArray(value) && typeof value !== 'string') issue(`${field} must be a list of text or scalar values.`)
    if (values.some((item) => item != null && !nonempty(item))) issue(`${field} contains an unreadable value.`)
    return values.map(text).filter((item) => item.trim())
  }
  if (!nonempty(slide.title)) issue('Every content slide needs its requested title.')
  slide.bullets = strings(input.bullets, 'bullets')

  const stat = object(input.stat)
  if (stat && nonempty(stat.value)) {
    scalarFields(stat, ['value', 'label', 'sub'])
    if (!nonempty(stat.label)) issue('A hero metric needs a label that identifies the value.')
    slide.stat = { ...stat, value: text(stat.value), label: text(stat.label), sub: text(stat.sub) }
  }
  else delete slide.stat
  if (input.stat != null && !stat) issue('stat must contain a scalar value and label.')

  for (const field of ['kpis', 'columns'] as const) {
    const entries = input[field]
    if (entries != null && !Array.isArray(entries)) { issue(`${field} must be an array.`); delete slide[field]; continue }
    if (!Array.isArray(entries) || !entries.length) { delete slide[field]; continue }
    slide[field] = entries.map((entry) => {
      const item = object(entry)
      if (!item) { issue(`${field} contains a malformed item.`); return entry }
      if (field === 'kpis') {
        scalarFields(item, ['value', 'label', 'delta'])
        if (!nonempty(item.value) || !nonempty(item.label)) issue('Each KPI needs its actual value and identifying label.')
        return { ...item, value: text(item.value), label: text(item.label), delta: text(item.delta) }
      }
      const items = strings(item.items, 'column items')
      scalarFields(item, ['heading'])
      if (!nonempty(item.heading) && !items.length) issue('A comparison column cannot be empty.')
      return { ...item, heading: text(item.heading), items, accent: item.accent === true }
    })
  }

  const quote = object(input.quote)
  if (quote) scalarFields(quote, ['text', 'attribution'])
  if (quote && nonempty(quote.text)) slide.quote = { ...quote, text: text(quote.text), attribution: text(quote.attribution) }
  else delete slide.quote
  if (input.quote != null && !quote) issue('quote must contain the supplied quotation and attribution.')

  const table = object(input.table)
  if (table) {
    const headers = Array.isArray(table.headers) ? table.headers.map(text) : []
    if (!Array.isArray(table.headers) || table.headers.some((header) => header != null && typeof header === 'object')) issue('Table headers must be an array of scalar labels.')
    const rows = Array.isArray(table.rows) ? table.rows.map((row) => {
      if (!Array.isArray(row)) { issue('Every table row must be an array.'); return row }
      if (row.some((cell) => cell != null && typeof cell === 'object')) issue('Table cells must contain scalar values, not nested objects.')
      if (row.length !== headers.length) issue('Table rows must align with all headers; do not omit cells or invent values to fill gaps.')
      return row.map(text)
    }) : []
    if (table.rows != null && !Array.isArray(table.rows)) issue('table.rows must be an array.')
    if (rows.length && !headers.length) issue('A data table needs headers that identify its columns and units.')
    if (rows.length) slide.table = { ...table, headers, rows, highlightCol: Number.isInteger(table.highlightCol) && Number(table.highlightCol) >= 0 && Number(table.highlightCol) < headers.length ? table.highlightCol : -1 }
    else delete slide.table
  } else {
    delete slide.table
    if (input.table != null) issue('table must be an object with headers and rows.')
  }

  if (input.chart != null) {
    const chart = object(input.chart)
    if (!chart) { issue('chart must be an object.'); delete slide.chart }
    else {
      scalarFields(chart, ['title', 'unit', 'takeaway'])
      const labels = strings(chart.labels, 'chart labels')
      const type = typeof chart.type === 'string' ? chart.type.toLowerCase() : 'bar'
      const series = Array.isArray(chart.series) ? chart.series.map((rawSeries) => {
        const series = object(rawSeries)
        const values = series && Array.isArray(series.values) ? series.values : []
        if (!series || values.length !== labels.length) issue('Each chart series must have exactly one supplied numeric observation per label; unknowns are not zero.')
        const numbers = values.map(chartNumber)
        if (numbers.some((number) => number === null)) issue('Chart values must be finite numbers in the declared unit; do not strip currency, %, magnitude suffixes, ranges or missing-data labels.')
        return { ...series, name: text(series?.name), values: numbers.some((number) => number === null) ? values : numbers }
      }) : []
      if (!['bar', 'line', 'pie'].includes(type)) issue('Chart type must be bar, line or pie; choose a supported type without changing the data.')
      if (!labels.length || !series.length) issue('A chart needs labeled observations and at least one series.')
      if (type === 'pie' && (series.length !== 1 || series.some((s) => s.values.some((v) => typeof v === 'number' && v < 0)))) issue('A pie requires one nonnegative series; use a bar/line/table to retain multiple series or negative values.')
      if (type === 'pie' && series.length === 1 && series[0].values.every((v) => v === 0)) issue('A zero-total allocation cannot be shown as a pie; retain the zero values in a table or another suitable layout.')
      slide.chart = { ...chart, type, title: text(chart.title), unit: text(chart.unit), takeaway: text(chart.takeaway), labels, series }
    }
  }

  const has = (layout: string): boolean => layout === 'bullets' ? !!(slide.bullets as string[]).length : !!slide[layout]
  const declaredLayout = typeof input.layout === 'string' && layouts.includes(input.layout) ? input.layout : ''
  slide.layout = declaredLayout || ['stat', 'kpis', 'columns', 'chart', 'quote', 'table', 'bullets'].find(has) || 'bullets'
  if (!has(String(slide.layout))) issue(`The ${slide.layout} layout has no usable content; supply its data or choose a layout that preserves the point.`)
  const primary = ['stat', 'kpis', 'columns', 'chart', 'table', 'quote'].filter(has)
  if (primary.length > 1) issue(`A slide supports one primary structured layout, but contains ${primary.join(', ')}. Preserve all supplied facts using one primary layout plus supporting bullets or notes; do not discard content or add unrequested slides.`)
  else if (primary.length === 1 && primary[0] !== slide.layout) issue(`The ${slide.layout} layout would hide the supplied ${primary[0]} content. Select its matching primary layout with supporting bullets, or represent every supplied fact in the requested layout.`)

  // Flag density instead of slicing persisted data. The retry can move supporting
  // detail to notes or choose a suitable layout while retaining requested facts,
  // headings and counts. Existing unchanged revision slides keep their content.
  const limit = (value: unknown, max: number, field: string) => { if (text(value).length > max) issue(`${field} is too long for its slide role; preserve its wording/data using an appropriate layout or speaker notes.`, 'density') }
  limit(slide.title, 240, 'Slide title')
  const bullets = slide.bullets as string[]
  if (bullets.length > 8) issue('More than eight bullets need a clearer layout; retain every requested point.', 'density')
  bullets.forEach((bullet) => limit(bullet, 480, 'Bullet'))
  if (Array.isArray(slide.kpis) && slide.kpis.length > 6) issue('More than six KPI cards need a comparison/table or supporting notes; retain every metric.', 'density')
  if (Array.isArray(slide.columns) && slide.columns.length > 4) issue('More than four comparison columns need a more legible layout; retain every comparison.', 'density')
  if (Array.isArray(slide.kpis)) slide.kpis.forEach((entry) => {
    const metric = object(entry)
    if (metric) { limit(metric.value, 120, 'KPI value'); limit(metric.label, 240, 'KPI label'); limit(metric.delta, 240, 'KPI comparison') }
  })
  if (Array.isArray(slide.columns)) slide.columns.forEach((entry) => {
    const column = object(entry)
    if (column) {
      limit(column.heading, 240, 'Column heading')
      if (Array.isArray(column.items)) {
        if (column.items.length > 8) issue('An overloaded comparison column needs supporting notes or a clearer layout; retain its points.', 'density')
        column.items.forEach((item) => limit(item, 480, 'Comparison item'))
      }
    }
  })
  const normalizedTable = object(slide.table)
  if (normalizedTable && ((normalizedTable.headers as string[]).length > 8 || (normalizedTable.rows as unknown[]).length > 10)) issue('The table exceeds a legible slide grid; retain its data in a suitable layout or supporting notes without adding unrequested slides.', 'density')
  const normalizedStat = object(slide.stat)
  if (normalizedStat) { limit(normalizedStat.value, 120, 'Hero metric'); limit(normalizedStat.label, 240, 'Metric label') }
  if (quote) { limit(quote.text, 900, 'Quotation'); limit(quote.attribution, 240, 'Attribution') }
  return { slide, issues }
}

const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
/** Enforce only explicit cover/content semantics; a plain "ten-slide deck" is
 * ambiguous and remains the model's formatting decision. */
export function requestedContentSlides(prompt: string): number | null {
  const number = '(\\d+|' + Object.keys(counts).join('|') + ')'
  const pattern = new RegExp(`\\b${number}[\\s-]+(content[\\s-]+)?slides?\\b`, 'gi')
  let result: number | null = null
  for (const match of prompt.matchAll(pattern)) {
    const prefix = prompt.slice(Math.max(0, match.index! - 80), match.index).split(/[.!?\n]/).pop() || ''
    // Bounds, approximations, ranges and prohibitions are not exact counts.
    if (/\b(?:at least|at most|up to|no more than|no fewer than|minimum|maximum|between|about|around|roughly|approximately|do not|don't|never|avoid)\b/i.test(prefix) || /(?:[~≈]|\d+\s*[-–]|\bto)\s*$/.test(prefix)) continue
    const count = counts[match[1].toLowerCase()] ?? Number(match[1])
    if (!Number.isInteger(count) || count < 1 || count > 100) continue
    if (match[2]) { result = count; continue }
    const tail = prompt.slice(match.index! + match[0].length, match.index! + match[0].length + 90).replace(/^\s+(?:(?:pitch|investor|training|status)\s+)?(?:deck|presentation)\b/i, '')
    if (/^[\s,(:-]*(?:in total[\s,(:-]*)?(?:including|inclusive of|with)\s+(?:the\s+|a\s+)?(?:cover|title slide)\b/i.test(tail)) result = count - 1
    else if (/^[\s,(:-]*(?:excluding|not including|plus)\s+(?:the\s+|a\s+)?(?:cover|title slide)\b/i.test(tail)) result = count
  }
  return result
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}

export function validateGeneratedSlides(raw: unknown[], prompt: string, previous: unknown[] = []): { slides: ObjectValue[]; issues: string[] } {
  const oldSlides = new Set(previous.map((slide) => stable(normalizeGeneratedSlide(slide).slide)))
  const normalized = raw.map(normalizeGeneratedSlide)
  const issues = normalized.flatMap(({ slide, issues }, i) => issues.filter((issue) => issue.kind !== 'density' || !oldSlides.has(stable(slide))).map((issue) => `Slide ${i + 1}: ${issue.message}`))
  const expected = requestedContentSlides(prompt)
  if (expected !== null && raw.length !== expected) issues.push(`The request requires ${expected} content slides plus the separate cover, but the slides array contains ${raw.length}. Preserve the requested titles and count.`)
  return { slides: normalized.map(({ slide }) => slide), issues }
}

export const SLIDE_DATA_CONTRACT = `

SLIDE DATA CONTRACT:
- Persist complete values, metric labels, table cells, quotations and source qualifications. Never shorten a numeric value, unit, attribution or quoted passage by cutting characters. Keep supporting detail in speaker notes when needed for legibility, preserving requested on-slide content and counts.
- Numeric chart values must be raw finite JSON numbers in one explicit unit/basis. For unit "%", 60 means 60 percent, not 0.60. For "USD millions", 4.2 means USD 4.2 million; for "$", use 4200000. Preserve full unit and period labels.
- A missing observation is unknown, not zero. Do not pad a series, drop an extra series/label, or guess a range midpoint. Where values are unavailable, use a labeled table/list instead of inventing a chart. A pie needs exactly one nonnegative, nonzero-total series; negative P&L values belong in a bar/line/table.
- Use one primary structured payload per slide (stat, kpis, columns, chart, table or quote), matching its layout. Supporting bullets are allowed with every primary layout. Multiple primary payloads would hide information; combine their supplied facts in one representation or supporting bullets/notes without dropping qualifications or adding unrequested slides.
- Supply meaningful data for the selected layout. If a layout is too dense, choose a clearer representation or speaker notes; do not silently delete source facts or add unrequested slides.`
