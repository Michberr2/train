// Aesthetic statistic charts rendered to a canvas → data URL, for embedding in
// docs (docx/pdf) and the deck PDF/preview. Quiet-luxury styling (navy + gold +
// linen). pptx decks use native pptxgenjs charts instead (editable); this is for
// raster contexts. Supports bar, line, and pie.

export type ChartSpec = {
  type?: 'bar' | 'line' | 'pie'
  title?: string
  takeaway?: string // one-line conclusion, baked as a caption in the raster
  unit?: string // '$' | '%' | 'x' | '' — formats axis ticks + data labels
  labels?: string[]
  series?: { name?: string; values?: number[] }[]
}

// Format a value for an axis tick or data label honoring the chart's unit; big
// numbers auto-compact to k/M/B so a chart reads "$41B" / "82%" / "12.9x".
function fmt(v: number, unit?: string): string {
  const decimal = (n: number) => String(n !== 0 && Math.abs(n) < 0.01 ? Number(n.toPrecision(3)) : Math.round(n * 100) / 100)
  const compact = (n: number) => {
    const a = Math.abs(n)
    if (a >= 1e9) return (n / 1e9).toFixed(a % 1e9 ? 1 : 0) + 'B'
    if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'M'
    if (a >= 1e3) return (n / 1e3).toFixed(a % 1e3 ? 1 : 0) + 'k'
    return decimal(n)
  }
  if (unit === '%') return `${decimal(v)}%`
  if (unit === 'x') return `${decimal(v)}x`
  if (unit === '$') return `$${compact(v)}`
  return compact(v)
}

type Palette = { primary: string; accent: string; ink: string; paper: string; grid: string }

const DEFAULT_PAL: Palette = {
  primary: '#0F1B2D',
  accent: '#AF8C56',
  ink: '#2A2A2A',
  paper: '#FFFFFF',
  grid: '#E4DED2',
}

// A small on-brand series palette (navy → gold → harbor → stone …).
function seriesColors(pal: Palette): string[] {
  return [pal.primary, pal.accent, '#1B3A53', '#8A9EA7', '#C9B891', '#5A6B7A']
}

/** Shared with editable exports: include zero and every finite observation.
 * Missing/nonfinite observations remain gaps, never invented zero values. */
export function chartValueDomain(chart: ChartSpec): { min: number; max: number; ticks: number[] } {
  let min = 0, max = 0
  for (const series of chart.series || []) for (const value of series.values || []) {
    if (!Number.isFinite(value)) continue
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  if (min === max) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }
  // Normalize before subtracting so even large signed finite values do not
  // overflow when determining the interval or positioning observations.
  const magnitude = Math.max(Math.abs(min), Math.abs(max))
  const scale = Math.pow(10, Math.floor(Math.log10(magnitude))) || magnitude
  const rawStep = (max / scale - min / scale) / 4
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const fraction = rawStep / power
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power
  const first = Math.floor(min / scale / step), last = Math.ceil(max / scale / step)
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => Number(((first + i) * step * scale).toPrecision(12)))
  if (ticks.some((value) => !Number.isFinite(value))) return { min, max, ticks: [...new Set([min, 0, max])] }
  return { min: Math.min(min, ticks[0]), max: Math.max(max, ticks[ticks.length - 1]), ticks: [...new Set(ticks)] }
}

export function drawChart(ctx: CanvasRenderingContext2D, chart: ChartSpec, w: number, h: number, palette?: Partial<Palette>) {
  const pal = { ...DEFAULT_PAL, ...(palette || {}) }
  const type = chart.type || 'bar'
  const labels = chart.labels || []
  const series = (chart.series || []).map((s) => ({ name: s.name || '', values: Array.from(s.values || []) }))
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = pal.paper
  ctx.fillRect(0, 0, w, h)

  const hasTakeaway = !!(chart.takeaway && chart.takeaway.trim())
  const padL = 62 // room for "$"/"M" ticks
  const padR = 18
  const padT = chart.title ? 40 : 18
  const padB = 46 + (series.length > 1 ? 22 : 0) + (hasTakeaway ? 34 : 0)
  const plotW = w - padL - padR
  const plotH = h - padT - padB
  const colors = seriesColors(pal)
  // Baked takeaway caption — a short accent rule + the one-line conclusion, so the
  // chart reads "complete" wherever it renders as an image (preview + PDF).
  const drawTakeaway = () => {
    if (!hasTakeaway) return
    const cy = h - 14
    ctx.textAlign = 'center'
    ctx.fillStyle = pal.accent
    ctx.fillRect(w / 2 - 14, cy - 20, 28, 2)
    ctx.fillStyle = pal.ink
    ctx.font = 'italic 600 13px Georgia, serif'
    const cap = String(chart.takeaway).slice(0, 120)
    // clip to width (single line)
    let txt = cap
    while (txt.length > 8 && ctx.measureText(txt).width > w - 40) txt = txt.slice(0, -2)
    ctx.fillText(txt + (txt.length < cap.length ? '…' : ''), w / 2, cy)
    ctx.textAlign = 'left'
  }

  ctx.textBaseline = 'alphabetic'
  if (chart.title) {
    ctx.fillStyle = pal.primary
    ctx.font = '600 17px Georgia, serif'
    ctx.fillText(chart.title, padL, 26)
  }

  if (type === 'pie') {
    const vals = (series[0]?.values || []).map((v) => Number.isFinite(v) ? Math.max(0, v) : 0)
    const total = vals.reduce((a, b) => a + b, 0) || 1
    const cx = padL + plotW * 0.42
    const cy = padT + plotH / 2
    const r = Math.min(plotW * 0.42, plotH / 2) - 6
    let a0 = -Math.PI / 2
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, r, a0, a1)
      ctx.closePath()
      ctx.fillStyle = colors[i % colors.length]
      ctx.fill()
      ctx.strokeStyle = pal.paper
      ctx.lineWidth = 2
      ctx.stroke()
      a0 = a1
    })
    // legend
    ctx.font = '13px Helvetica, Arial, sans-serif'
    labels.forEach((lb, i) => {
      const ly = padT + 8 + i * 22
      ctx.fillStyle = colors[i % colors.length]
      ctx.fillRect(cx + r + 24, ly - 11, 13, 13)
      ctx.fillStyle = pal.ink
      const pct = Math.round(((vals[i] || 0) / total) * 100)
      // Don't duplicate the percent when the label already ends with one ("Reserve 5%").
      const label = /\d\s*%\s*$/.test(String(lb)) ? String(lb) : `${lb} · ${pct}%`
      ctx.fillText(label, cx + r + 44, ly)
    })
    drawTakeaway()
    return
  }

  // bar / line — shared axes
  const domain = chartValueDomain(chart)
  const x0 = padL
  const bottom = padT + plotH
  const magnitude = Math.max(Math.abs(domain.min), Math.abs(domain.max))
  const normalizedRange = domain.max / magnitude - domain.min / magnitude
  const yFor = (value: number) => padT + ((domain.max / magnitude - value / magnitude) / normalizedRange) * plotH
  const zero = yFor(0)
  // gridlines + y labels
  ctx.strokeStyle = pal.grid
  ctx.fillStyle = '#8A8A8A'
  ctx.font = '11px Helvetica, Arial, sans-serif'
  ctx.lineWidth = 1
  for (const value of domain.ticks) {
    const y = yFor(value)
    ctx.strokeStyle = value === 0 ? pal.ink : pal.grid
    ctx.lineWidth = value === 0 ? 1.25 : 1
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x0 + plotW, y)
    ctx.stroke()
    ctx.fillText(fmt(value, chart.unit), 6, y + 4)
  }
  const n = Math.max(labels.length, ...series.map((s) => s.values.length), 1)
  const slot = plotW / n

  if (type === 'line') {
    series.forEach((s, si) => {
      ctx.strokeStyle = colors[si % colors.length]
      ctx.lineWidth = 2.5
      ctx.beginPath()
      let connected = false
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) { connected = false; return }
        const x = x0 + slot * (i + 0.5)
        const y = yFor(v)
        if (!connected) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        connected = true
      })
      ctx.stroke()
      ctx.fillStyle = colors[si % colors.length]
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return
        const x = x0 + slot * (i + 0.5)
        const y = yFor(v)
        ctx.beginPath()
        ctx.arc(x, y, 3.5, 0, Math.PI * 2)
        ctx.fill()
      })
      // value labels above each node (single-series lines only, to avoid clutter)
      if (series.length === 1) {
        ctx.fillStyle = pal.ink
        ctx.font = '600 11px Helvetica, Arial, sans-serif'
        ctx.textAlign = 'center'
        s.values.forEach((v, i) => {
          if (!Number.isFinite(v)) return
          const x = x0 + slot * (i + 0.5)
          const y = yFor(v)
          ctx.fillText(fmt(v, chart.unit), x, v < 0 ? y + 14 : y - 9)
        })
        ctx.textAlign = 'left'
      }
    })
  } else {
    // grouped bars
    const ns = series.length || 1
    const groupW = slot * 0.7
    const barW = groupW / ns
    series.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length]
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return
        const x = x0 + slot * i + (slot - groupW) / 2 + si * barW
        const y = yFor(v)
        ctx.fillRect(x, Math.min(y, zero), Math.max(0.5, barW - 2), Math.abs(zero - y))
      })
    })
    // value label centered above each bar (single-series, so it stays legible)
    if (series.length === 1) {
      ctx.fillStyle = pal.ink
      ctx.font = '600 11px Helvetica, Arial, sans-serif'
      ctx.textAlign = 'center'
      series[0].values.forEach((v, i) => {
        if (!Number.isFinite(v)) return
        const x = x0 + slot * i + (slot - groupW) / 2 + barW / 2
        const y = yFor(v)
        ctx.fillText(fmt(v, chart.unit), x, v < 0 ? y + 14 : y - 5)
      })
      ctx.textAlign = 'left'
    }
  }

  // x labels
  ctx.fillStyle = pal.ink
  ctx.font = '12px Helvetica, Arial, sans-serif'
  ctx.textAlign = 'center'
  labels.forEach((lb, i) => {
    ctx.fillText(String(lb).slice(0, 14), x0 + slot * (i + 0.5), bottom + 32)
  })
  ctx.textAlign = 'left'

  // legend (multi-series)
  if (series.length > 1) {
    let lx = x0
    const ly = h - 14 - (hasTakeaway ? 34 : 0)
    ctx.font = '12px Helvetica, Arial, sans-serif'
    series.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length]
      ctx.fillRect(lx, ly - 10, 13, 13)
      ctx.fillStyle = pal.ink
      ctx.fillText(s.name || `Series ${si + 1}`, lx + 18, ly)
      lx += 30 + ctx.measureText(s.name || `Series ${si + 1}`).width
    })
  }
  drawTakeaway()
}

export function chartDataUrl(chart: ChartSpec, w = 1200, h = 720, palette?: Partial<Palette>): string | null {
  try {
    const canvas = document.createElement('canvas')
    const scale = 2
    canvas.width = w * scale
    canvas.height = h * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(scale, scale)
    drawChart(ctx, chart, w, h, palette)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export function hasChartData(chart?: ChartSpec | null): boolean {
  return !!chart?.series?.some((s) => s.values?.some((value) => Number.isFinite(value)))
}
