// Aesthetic statistic charts rendered to a canvas → data URL, for embedding in
// docs (docx/pdf) and the deck PDF/preview. Quiet-luxury styling (navy + gold +
// linen). pptx decks use native pptxgenjs charts instead (editable); this is for
// raster contexts. Supports bar, line, and pie.

export type ChartSpec = {
  type?: 'bar' | 'line' | 'pie'
  title?: string
  labels?: string[]
  series?: { name?: string; values?: number[] }[]
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

function niceMax(v: number): number {
  if (v <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

export function drawChart(ctx: CanvasRenderingContext2D, chart: ChartSpec, w: number, h: number, palette?: Partial<Palette>) {
  const pal = { ...DEFAULT_PAL, ...(palette || {}) }
  const type = chart.type || 'bar'
  const labels = chart.labels || []
  const series = (chart.series || []).map((s) => ({ name: s.name || '', values: s.values || [] }))
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = pal.paper
  ctx.fillRect(0, 0, w, h)

  const padL = 54
  const padR = 18
  const padT = chart.title ? 40 : 18
  const padB = 46 + (series.length > 1 ? 22 : 0)
  const plotW = w - padL - padR
  const plotH = h - padT - padB
  const colors = seriesColors(pal)

  ctx.textBaseline = 'alphabetic'
  if (chart.title) {
    ctx.fillStyle = pal.primary
    ctx.font = '600 17px Georgia, serif'
    ctx.fillText(chart.title, padL, 26)
  }

  if (type === 'pie') {
    const vals = (series[0]?.values || []).map((v) => Math.max(0, v))
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
      const pct = Math.round((vals[i] / total) * 100)
      ctx.fillText(`${lb} · ${pct}%`, cx + r + 44, ly)
    })
    return
  }

  // bar / line — shared axes
  let max = 0
  series.forEach((s) => s.values.forEach((v) => { if (v > max) max = v }))
  max = niceMax(max)
  const x0 = padL
  const y0 = padT + plotH
  // gridlines + y labels
  ctx.strokeStyle = pal.grid
  ctx.fillStyle = '#8A8A8A'
  ctx.font = '11px Helvetica, Arial, sans-serif'
  ctx.lineWidth = 1
  const ticks = 4
  for (let t = 0; t <= ticks; t++) {
    const y = y0 - (plotH * t) / ticks
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x0 + plotW, y)
    ctx.stroke()
    const val = (max * t) / ticks
    ctx.fillText(val >= 1000 ? (val / 1000).toFixed(val % 1000 ? 1 : 0) + 'k' : String(Math.round(val * 100) / 100), 6, y + 4)
  }
  const n = labels.length || Math.max(...series.map((s) => s.values.length), 1)
  const slot = plotW / n

  if (type === 'line') {
    series.forEach((s, si) => {
      ctx.strokeStyle = colors[si % colors.length]
      ctx.lineWidth = 2.5
      ctx.beginPath()
      s.values.forEach((v, i) => {
        const x = x0 + slot * (i + 0.5)
        const y = y0 - (v / max) * plotH
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.fillStyle = colors[si % colors.length]
      s.values.forEach((v, i) => {
        const x = x0 + slot * (i + 0.5)
        const y = y0 - (v / max) * plotH
        ctx.beginPath()
        ctx.arc(x, y, 3.5, 0, Math.PI * 2)
        ctx.fill()
      })
    })
  } else {
    // grouped bars
    const ns = series.length || 1
    const groupW = slot * 0.7
    const barW = groupW / ns
    series.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length]
      s.values.forEach((v, i) => {
        const x = x0 + slot * i + (slot - groupW) / 2 + si * barW
        const bh = (v / max) * plotH
        ctx.fillRect(x, y0 - bh, barW - 2, bh)
      })
    })
  }

  // x labels
  ctx.fillStyle = pal.ink
  ctx.font = '12px Helvetica, Arial, sans-serif'
  ctx.textAlign = 'center'
  labels.forEach((lb, i) => {
    ctx.fillText(String(lb).slice(0, 14), x0 + slot * (i + 0.5), y0 + 20)
  })
  ctx.textAlign = 'left'

  // legend (multi-series)
  if (series.length > 1) {
    let lx = x0
    const ly = h - 14
    ctx.font = '12px Helvetica, Arial, sans-serif'
    series.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length]
      ctx.fillRect(lx, ly - 10, 13, 13)
      ctx.fillStyle = pal.ink
      ctx.fillText(s.name || `Series ${si + 1}`, lx + 18, ly)
      lx += 30 + ctx.measureText(s.name || `Series ${si + 1}`).width
    })
  }
}

export function chartDataUrl(chart: ChartSpec, w = 1200, h = 720, palette?: Partial<Palette>): string | null {
  try {
    const canvas = document.createElement('canvas')
    const scale = 2
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    void scale
    drawChart(ctx, chart, w, h, palette)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export function hasChartData(chart?: ChartSpec | null): boolean {
  return !!(chart && (chart.series?.some((s) => (s.values || []).length) || (chart.type === 'pie' && chart.series?.[0]?.values?.length)))
}
