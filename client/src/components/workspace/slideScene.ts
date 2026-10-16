import type { Deck, Slide } from './SlidesCard'
import { chartDataUrl, hasChartData, type ChartSpec } from './chartRender'
import { primarySlideFontFace, slideFontCss } from './slideFonts'

// One artboard, one set of measured text lines, shared by the screen and exports.
// Units are points: 960 × 540 is the same 16:9 canvas in every format.
export type TextNode = { type: 'text'; x: number; y: number; w: number; h: number; fontSize: number; fontFace: string; fontFamily?: string; bold?: boolean; italic?: boolean; color: string; align?: 'left' | 'center' | 'right'; lines: string[]; lineHeight: number }
export type SceneNode = TextNode
  | { type: 'rect'; x: number; y: number; w: number; h: number; fill: string; radius?: number; stroke?: string; strokeWidth?: number; opacity?: number }
  | { type: 'image'; x: number; y: number; w: number; h: number; src: string; fit?: 'cover' | 'contain' }
  | { type: 'line'; x: number; y: number; w: number; h: number; color: string; width: number }
  | { type: 'chart'; x: number; y: number; w: number; h: number; src: string; spec: ChartSpec; colors: string[] }
export type SlideScene = { width: 960; height: 540; background: string; nodes: SceneNode[]; notes?: string; title: string; issues: string[] }
export type SceneStyle = { head: string; body: string; dark: string; onDark: string; subtle: string; coverAccent: string; ink: string; gold: string; muted: string; paper: string; surface: string; label: string; radius: number }
export type SceneAssets = { photos?: Record<string, string>; logoCover?: string; logoHead?: string; logoRatio?: number }
const color = (v: string) => v.startsWith('#') ? v : '#' + v
function readable(foreground: string, background: string, ratio = 4.5): string {
  const channels = (value: string) => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16))
  const luminance = (values: number[]) => values.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const bg = luminance(channels(background)), original = channels(foreground)
  const contrast = (values: number[]) => { const fg = luminance(values); return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) }
  if (contrast(original) >= ratio) return foreground
  const target = contrast([0, 0, 0]) >= contrast([255, 255, 255]) ? 0 : 255
  for (let step = 1; step <= 20; step++) {
    const mixed = original.map(v => Math.round(v + (target - v) * step / 20))
    if (contrast(mixed) >= ratio) return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('')
  }
  return target === 0 ? '#000000' : '#ffffff'
}

let measureContext: CanvasRenderingContext2D | null | undefined
function measure(text: string, size: number, face: string, bold = false, italic = false) {
  if (measureContext === undefined) measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (measureContext) {
    measureContext.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${size}px ${slideFontCss(face)}`
    return measureContext.measureText(text).width
  }
  // Server-side callers can still export without a DOM. Use a conservative
  // fallback; browsers always use actual font metrics once fonts are ready.
  return Array.from(text).reduce((sum, c) => sum + (/\s/.test(c) ? .3 : /[ilI.,':;!|]/.test(c) ? .3 : /[MW@#%]/.test(c) ? .92 : c.codePointAt(0)! > 0x2fff ? 1 : .59), 0) * size
}

export function wrapSlideText(text: string, w: number, size: number, face: string, bold = false, italic = false): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (measure(line ? `${line} ${word}` : word, size, face, bold, italic) <= w) { line = line ? `${line} ${word}` : word; continue }
      if (line) { lines.push(line); line = '' }
      // Split long URLs/identifiers without deleting a character.
      for (const char of Array.from(word)) {
        if (line && measure(line + char, size, face, bold, italic) > w) { lines.push(line); line = '' }
        line += char
      }
    }
    lines.push(line)
  }
  return lines
}

export function makeDeckScenes(deck: Deck, style: SceneStyle, assets: SceneAssets = {}): SlideScene[] {
  const s = Object.fromEntries(Object.entries(style).map(([k, v]) => [k, typeof v === 'string' && ['dark', 'onDark', 'subtle', 'coverAccent', 'ink', 'gold', 'muted', 'paper', 'surface'].includes(k) ? color(v) : v])) as SceneStyle
  s.ink = readable(s.ink, s.paper)
  s.muted = readable(s.muted, s.paper)
  s.gold = readable(s.gold, s.paper)
  s.onDark = readable(s.onDark, s.dark)
  s.subtle = readable(s.subtle, s.dark)
  s.coverAccent = readable(s.coverAccent, s.dark, 3)
  const scene = (title: string, background: string, notes?: string): SlideScene => ({ width: 960, height: 540, title, background, nodes: [], issues: [], notes })
  const rect = (p: SlideScene, x: number, y: number, w: number, h: number, fill: string, radius = 0, opacity?: number) => p.nodes.push({ type: 'rect', x, y, w, h, fill, radius, opacity })
  const text = (p: SlideScene, value: string | undefined, x: number, y: number, w: number, h: number, fontSize = 22, opts: Partial<TextNode> = {}, minSize = 13) => {
    if (!value) return
    const fontFace = opts.fontFace || s.body
    let size = fontSize
    let lines = wrapSlideText(value, w, size, fontFace, opts.bold, opts.italic)
    while (size > minSize && lines.length * size * 1.22 > h) { size -= .5; lines = wrapSlideText(value, w, size, fontFace, opts.bold, opts.italic) }
    if (lines.length * size * 1.22 > h + .5) p.issues.push(`“${value.slice(0, 48)}” needs more space. Shorten it or divide it across slides.`)
    p.nodes.push({ type: 'text', x, y, w, h, fontSize: size, color: s.ink, ...opts, fontFace: primarySlideFontFace(fontFace), fontFamily: slideFontCss(fontFace), lines, lineHeight: size * 1.22 })
  }
  const image = (p: SlideScene, src: string | undefined, x: number, y: number, w: number, h: number, fit: 'contain' | 'cover' = 'cover') => { if (src) p.nodes.push({ type: 'image', src, x, y, w, h, fit }) }
  const logo = (p: SlideScene, cover = false) => image(p, cover ? assets.logoCover : assets.logoHead, 60, 32, Math.min(190, 28 * (assets.logoRatio || 4)), 28, 'contain')
  const slides = deck.slides || []
  const cover = scene(deck.title || 'Presentation', s.dark)
  image(cover, assets.photos?.cover, 0, 0, 960, 540)
  if (assets.photos?.cover) rect(cover, 0, 0, 960, 540, s.dark, 0, .84)
  rect(cover, 900, 0, 60, 540, s.coverAccent)
  rect(cover, 60, 124, 56, 5, s.coverAccent)
  logo(cover, true)
  if (!assets.logoCover) text(cover, s.label, 60, 80, 750, 22, 12, { color: s.subtle, bold: true })
  text(cover, deck.title || 'Presentation', 60, 163, 785, 215, 68, { color: s.onDark, fontFace: s.head, bold: true }, 28)
  text(cover, deck.subtitle, 60, 397, 730, 66, 22, { color: s.subtle }, 15)
  text(cover, '01', 60, 496, 60, 18, 11, { color: s.subtle })
  const result = [cover]

  for (const [i, sl] of slides.entries()) {
    const p = scene(sl.title || `Slide ${i + 2}`, s.paper, sl.notes)
    result.push(p)
    if (assets.logoHead) logo(p)
    else { rect(p, 60, 40, 8, 8, s.gold, 4); text(p, s.label, 80, 36, 710, 20, 12, { bold: true }) }
    text(p, `${String(i + 2).padStart(2, '0')} / ${String(slides.length + 1).padStart(2, '0')}`, 800, 36, 100, 20, 11, { color: s.muted, align: 'right' })
    text(p, sl.title || `Slide ${i + 2}`, 60, 86, 840, 76, 34, { fontFace: s.head, bold: true }, 23)
    rect(p, 60, 494, 840, 1, s.surface)
    text(p, s.label || 'Presentation', 60, 508, 770, 18, 10, { color: s.muted }, 9)
    const lo = resolveSlideLayout(sl)
    const primaryFields = (['stat', 'kpis', 'columns', 'chart', 'quote', 'table'] as const).filter(field => {
      if (field === 'stat') return !!sl.stat?.value
      if (field === 'kpis') return !!sl.kpis?.length
      if (field === 'columns') return !!sl.columns?.length
      if (field === 'chart') return hasChartData(sl.chart)
      if (field === 'quote') return !!sl.quote?.text
      return !!sl.table?.rows?.length
    })
    const hiddenFields = primaryFields.filter(field => field !== lo)
    if (hiddenFields.length) p.issues.push(`This ${lo} slide also contains ${hiddenFields.join(', ')} content. Ask Nalu to combine or separate it before exporting so nothing is omitted.`)
    const photo = ['bullets', 'stat', 'quote'].includes(lo) ? assets.photos?.[String(i)] : undefined
    const supplemental = !['bullets', 'stat'].includes(lo) ? sl.bullets || [] : []
    const extraH = supplemental.length ? Math.min(120, supplemental.length * 28 + 16) : 0
    const bx = 60, by = 182, bw = photo ? 522 : 840, bh = 292 - extraH
    if (photo) image(p, photo, 620, by, 280, 292)
    const bullets = (items: string[], x: number, y: number, w: number, h: number, grid = false) => {
      if (!items.length) return
      const ncols = grid && items.length > 1 ? 2 : 1
      const rows = Math.ceil(items.length / ncols), gap = 22
      const cw = (w - gap * (ncols - 1)) / ncols
      const ch = (h - gap * (rows - 1)) / rows
      items.forEach((value, n) => {
        const xx = x + (n % ncols) * (cw + gap), yy = y + Math.floor(n / ncols) * (ch + gap)
        text(p, String(n + 1).padStart(2, '0'), xx, yy + 2, 32, 20, 12, { color: s.gold, bold: true })
        text(p, value, xx + 40, yy, cw - 40, ch, 23, {}, 13)
      })
    }
    if (lo === 'stat' && sl.stat) {
      const hasBullets = !!sl.bullets?.length
      text(p, sl.stat.value, bx, by, bw, hasBullets ? 96 : 118, hasBullets ? 78 : 92, { color: s.gold, bold: true, fontFace: s.head }, 30)
      text(p, sl.stat.label, bx, by + (hasBullets ? 106 : 130), bw, 40, 24, { bold: true }, 16)
      text(p, sl.stat.sub, bx, by + (hasBullets ? 154 : 179), bw, hasBullets ? 34 : 80, 18, { color: s.muted }, 13)
      if (hasBullets) bullets(sl.bullets!, bx, by + 202, bw, 90)
    } else if (lo === 'kpis' && sl.kpis?.length) {
      const cols = sl.kpis.length <= 3 ? sl.kpis.length : Math.ceil(sl.kpis.length / 2), rows = Math.ceil(sl.kpis.length / cols)
      const gap = 18, w = (bw - gap * (cols - 1)) / cols, h = (bh - gap * (rows - 1)) / rows
      sl.kpis.forEach((k, j) => {
        const x = bx + (j % cols) * (w + gap), y = by + Math.floor(j / cols) * (h + gap)
        rect(p, x, y, w, h, s.surface, Math.min(14, s.radius))
        rect(p, x + 22, y + (rows === 1 ? 28 : 10), 30, 3, s.gold)
        text(p, k.value, x + 22, y + h * .23, w - 44, h * .32, rows === 1 ? 56 : 30, { fontFace: s.head, color: s.gold, bold: true }, 18)
        text(p, k.label, x + 22, y + h * .60, w - 44, h * .20, rows === 1 ? 20 : 15, { bold: true }, 11)
        text(p, k.delta, x + 22, y + h * .86, w - 44, h * .12, rows === 1 ? 15 : 12, { color: s.muted }, 9)
      })
    } else if (lo === 'columns' && sl.columns?.length) {
      const gap = 24, w = (bw - gap * (sl.columns.length - 1)) / sl.columns.length
      sl.columns.forEach((col, j) => {
        const x = bx + j * (w + gap)
        rect(p, x, by, w, bh, col.accent ? s.surface : s.paper, Math.min(12, s.radius))
        rect(p, x, by, w, 4, s.gold)
        text(p, col.heading, x + 18, by + 24, w - 36, 62, 24, { fontFace: s.head, bold: true }, 16)
        bullets(col.items, x + 18, by + 102, w - 36, bh - 116)
      })
    } else if (lo === 'quote' && sl.quote) {
      rect(p, bx, by + 8, 5, bh - 16, s.gold)
      text(p, `“${sl.quote.text}”`, bx + 30, by + 18, bw - 38, bh - 86, 36, { fontFace: s.head, italic: true }, 19)
      text(p, sl.quote.attribution, bx + 30, by + bh - 49, bw - 38, 46, 17, { color: s.muted, bold: true }, 13)
    } else if (lo === 'table' && sl.table) {
      const t = sl.table, cols = Math.max(1, t.headers.length, ...t.rows.map(r => r.length)), w = bw / cols
      const allRows = t.headers.length ? [t.headers, ...t.rows] : t.rows
      let size = 18
      const rowSizes = (sz: number) => allRows.map((row, ri) => Math.max(1, ...row.map((cell, ci) => wrapSlideText(cell, w - 24, sz, s.body, (t.headers.length > 0 && ri === 0) || ci === t.highlightCol).length)) * sz * 1.22 + 20)
      let heights = rowSizes(size)
      while (size > 11 && heights.reduce((a, b) => a + b, 0) > bh) { size -= .5; heights = rowSizes(size) }
      if (heights.reduce((a, b) => a + b, 0) > bh) p.issues.push('This table needs more space. Split it across slides or shorten its cells.')
      let y = by
      allRows.forEach((row, ri) => {
        const header = t.headers.length > 0 && ri === 0, h = heights[ri]
        rect(p, bx, y, bw, h, header ? s.ink : ri % 2 ? s.surface : s.paper)
        if (!header && t.highlightCol != null && t.highlightCol >= 0 && t.highlightCol < cols) rect(p, bx + t.highlightCol * w, y, w, h, s.surface)
        row.forEach((cell, ci) => text(p, cell, bx + ci * w + 12, y + 10, w - 24, h - 18, size, { color: header ? s.paper : s.ink, bold: header || ci === t.highlightCol }, size))
        y += h
      })
    } else if (lo === 'chart' && sl.chart) {
      const takeaway = sl.chart.takeaway
      const h = takeaway ? bh - 56 : bh
      const unitLabel = sl.chart.unit && !['$', '%', 'x'].includes(sl.chart.unit) ? sl.chart.unit : ''
      const spec = { ...sl.chart, takeaway: undefined }
      if (unitLabel) text(p, unitLabel, bx, by - 17, bw, 15, 11, { color: s.muted }, 9)
      const src = chartDataUrl(spec, bw, h, { paper: s.paper, primary: s.ink, accent: s.gold, ink: s.ink }) || ''
      p.nodes.push({ type: 'chart', x: bx, y: by, w: bw, h, src, spec, colors: [s.ink, s.gold, '#1B3A53', '#8A9EA7', '#C9B891', '#5A6B7A'] })
      if (takeaway) { rect(p, bx, by + h + 17, 24, 3, s.gold); text(p, takeaway, bx + 36, by + h + 10, bw - 36, 42, 18, { bold: true }, 13) }
    } else bullets(sl.bullets || [], bx, by + 12, bw, bh - 20, !photo)
    if (supplemental.length) text(p, supplemental.join('\n'), bx, by + bh + 16, bw, extraH - 16, 17, { color: s.muted }, 11)
  }
  return result
}

export function resolveSlideLayout(sl: Slide) {
  const valid = (lo?: string) => lo === 'stat' ? !!sl.stat?.value : lo === 'kpis' ? !!sl.kpis?.length : lo === 'columns' ? !!sl.columns?.length : lo === 'chart' ? hasChartData(sl.chart) : lo === 'quote' ? !!sl.quote?.text : lo === 'table' ? !!sl.table?.rows?.length : lo === 'bullets'
  if (valid(sl.layout)) return sl.layout!
  return (['stat', 'kpis', 'chart', 'table', 'columns', 'quote'] as const).find(valid) || 'bullets'
}
