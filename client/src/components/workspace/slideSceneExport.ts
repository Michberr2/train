import pptxgen from 'pptxgenjs'
import { jsPDF } from 'jspdf'
import type { SlideScene, SceneNode } from './slideScene'
import { chartValueDomain } from './chartRender'
import { loadSlideFont, primarySlideFontFace, resolveSlideFont, SLIDE_FONT_FACE, slideFontStyle, type SlideFontStyle } from './slideFonts'
import { embedPowerpointFonts } from './pptxFonts'

const hex = (value: string) => value.replace(/^#/, '')
const rgb = (value: string): [number, number, number] => {
  const color = hex(value)
  return [parseInt(color.slice(0, 2), 16), parseInt(color.slice(2, 4), 16), parseInt(color.slice(4, 6), 16)]
}
const opacity = (value?: number) => Math.max(0, Math.min(1, value ?? 1))
const baseline = (node: Extract<SceneNode, { type: 'text' }>, index: number) => node.y + node.fontSize * 0.82 + index * node.lineHeight

/** Optional decimal placeholders leave a visible trailing separator in native
 * PowerPoint. General retains mixed fractional/integer observations without
 * rounding them or turning percentages into Excel's scaled percentage values. */
export function nativeChartNumberFormat(values: number[], unit?: string): string {
  const number = values.filter(Number.isFinite).every(Number.isInteger) ? '#,##0' : 'General'
  return unit === '$' ? `"$"${number}` : unit === '%' || unit === 'x' ? `${number}"${unit}"` : number
}

function validateScenes(scenes: SlideScene[]): void {
  if (!scenes.length) throw new Error('There are no slides to export.')
  for (const scene of scenes) {
    if (!(scene.width > 0 && scene.height > 0) || scene.width !== scenes[0].width || scene.height !== scenes[0].height) throw new Error('All presentation pages must have the same valid dimensions.')
    if (scene.issues?.length) throw new Error(scene.issues[0])
    for (const node of scene.nodes) {
      if (![node.x, node.y, node.w, node.h].every(Number.isFinite) || node.w < 0 || node.h < 0) throw new Error('A slide has invalid element dimensions. Please revise it before exporting.')
    }
  }
}

/** Rasterize only image objects, retaining crop/contain geometry in both file
 * formats. Text, shapes and PowerPoint charts remain native editable objects. */
async function fittedImage(src: string, w: number, h: number, fit: 'cover' | 'contain' = 'contain'): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    let settled = false
    const timer = setTimeout(() => finish(new Error('A presentation image timed out. Please retry the export.')), 15000)
    const finish = (error?: Error, result?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      if (error) { image.src = ''; reject(error) }
      else resolve(result!)
    }
    image.onerror = () => finish(new Error('A presentation image could not be loaded. Please retry the export.'))
    image.onload = () => {
      try {
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Invalid image dimensions')
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(w * 2))
        canvas.height = Math.max(1, Math.ceil(h * 2))
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas unavailable')
        const ratio = (fit === 'cover' ? Math.max : Math.min)(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
        const iw = image.naturalWidth * ratio, ih = image.naturalHeight * ratio
        context.drawImage(image, (canvas.width - iw) / 2, (canvas.height - ih) / 2, iw, ih)
        finish(undefined, canvas.toDataURL('image/png'))
      } catch { finish(new Error('A presentation image could not be embedded. Please retry the export.')) }
    }
    image.src = src
  })
}

function imageCache() {
  const cached = new Map<string, Promise<string>>()
  return (node: Extract<SceneNode, { type: 'image' | 'chart' }>) => {
    const fit = node.type === 'image' ? node.fit : 'contain'
    const key = JSON.stringify([node.src, node.w, node.h, fit])
    let result = cached.get(key)
    if (!result) { result = fittedImage(node.src, node.w, node.h, fit); cached.set(key, result) }
    return result
  }
}

export async function exportPptxScenes(scenes: SlideScene[], title: string): Promise<Blob> {
  validateScenes(scenes)
  const pptx = new pptxgen()
  pptx.defineLayout({ name: 'SCENE', width: scenes[0].width / 72, height: scenes[0].height / 72 })
  pptx.layout = 'SCENE'
  pptx.title = title
  pptx.author = 'Nalu'
  pptx.subject = title
  pptx.theme = { headFontFace: SLIDE_FONT_FACE, bodyFontFace: SLIDE_FONT_FACE }
  const image = imageCache()
  const fontFamilies = new Set<string>()
  for (const scene of scenes) {
    const slide = pptx.addSlide()
    slide.background = { color: hex(scene.background) }
    for (const node of scene.nodes) {
      const box = { x: node.x / 72, y: node.y / 72, w: node.w / 72, h: node.h / 72 }
      if (node.type === 'text') {
        const requested = primarySlideFontFace(node.fontFace), resolved = resolveSlideFont(requested)
        const fontFace = resolved.exact ? resolved.effective : requested
        if (resolved.exact && node.lines.some(Boolean)) fontFamilies.add(fontFace)
        node.lines.forEach((line, index) => {
          if (!line) return
          slide.addText(line, {
            ...box, y: (node.y + index * node.lineHeight) / 72, h: node.lineHeight / 72,
            fontSize: node.fontSize, fontFace, color: hex(node.color), bold: node.bold, italic: node.italic,
            align: node.align || 'left', valign: 'top', margin: 0, breakLine: false, fit: 'none', wrap: false,
            paraSpaceAfter: 0, paraSpaceBefore: 0, lineSpacingMultiple: 1,
          })
        })
      } else if (node.type === 'rect') {
        slide.addShape(node.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
          ...box, ...(node.radius ? { rectRadius: Math.min(1, node.radius / 72) } : {}),
          fill: { color: hex(node.fill), transparency: (1 - opacity(node.opacity)) * 100 },
          line: node.stroke ? { color: hex(node.stroke), width: node.strokeWidth ?? 1 } : { transparency: 100 },
        })
      } else if (node.type === 'line') {
        slide.addShape(pptx.ShapeType.line, { ...box, line: { color: hex(node.color), width: node.width } })
      } else if (node.type === 'image') {
        slide.addImage({ ...box, data: await image(node) })
      } else if (node.type === 'chart') {
        fontFamilies.add(SLIDE_FONT_FACE)
        const spec = node.spec
        const chartType = spec.type === 'line' ? pptx.ChartType.line : spec.type === 'pie' ? pptx.ChartType.pie : pptx.ChartType.bar
        // pptxgenjs 4's worksheet writer uses value || '', which erases numeric
        // zero on chart edit. A numeric XML string preserves that zero in both
        // the workbook and chart cache. Missing observations remain blank.
        const values = (spec.series || []).map((series) => ({ name: series.name || 'Series', labels: spec.labels || [], values: (series.values || []).map((value) => Number.isFinite(value) ? value === 0 ? '0' : value : null) as number[] }))
        const format = nativeChartNumberFormat((spec.series || []).flatMap(series => series.values || []), spec.unit)
        const domain = chartValueDomain(spec)
        const externalUnit = scene.nodes.some(other => other.type === 'text' && other.lines.join(' ').trim() === spec.unit && (other.y + other.h <= node.y || other.y >= node.y + node.h))
        slide.addChart(chartType, values, {
          ...box, h: (node.h - (spec.takeaway ? 24 : 0)) / 72,
          chartColors: (spec.type !== 'pie' && values.length === 1 ? node.colors.slice(0, 1) : node.colors).map(hex),
          showLegend: spec.type === 'pie' || values.length > 1, legendPos: 'b', legendFontFace: SLIDE_FONT_FACE,
          showTitle: !!spec.title, title: spec.title || '', titleFontFace: SLIDE_FONT_FACE, titleFontSize: 14,
          showValue: spec.type !== 'pie', showPercent: spec.type === 'pie',
          dataLabelFormatCode: format, dataLabelColor: '303030', dataLabelFontFace: SLIDE_FONT_FACE, dataLabelFontSize: 10,
          displayBlanksAs: 'gap',
          catAxisLabelFontFace: SLIDE_FONT_FACE, valAxisLabelFontFace: SLIDE_FONT_FACE,
          valAxisLabelFormatCode: nativeChartNumberFormat(domain.ticks, spec.unit),
          showValAxisTitle: !!spec.unit && !['$', '%', 'x'].includes(spec.unit) && !externalUnit,
          valAxisTitle: spec.unit || '', valAxisTitleFontFace: SLIDE_FONT_FACE, valAxisTitleFontSize: 11,
          ...(spec.type === 'pie' ? {} : { valAxisMinVal: domain.min, valAxisMaxVal: domain.max, valAxisMajorUnit: domain.ticks[1] - domain.ticks[0] }),
        })
        if (spec.takeaway) slide.addText(spec.takeaway, {
          x: box.x, y: (node.y + node.h - 20) / 72, w: box.w, h: 20 / 72,
          fontSize: 12, fontFace: SLIDE_FONT_FACE, italic: true, color: '303030', align: 'center', margin: 0,
        })
      }
    }
    if (scene.notes) slide.addNotes(scene.notes)
  }
  return embedPowerpointFonts(await pptx.write({ outputType: 'blob' }) as Blob, [...fontFamilies])
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

export async function exportPdfScenes(scenes: SlideScene[], title: string): Promise<Blob> {
  validateScenes(scenes)
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [scenes[0].width, scenes[0].height], compress: true, putOnlyUsedFonts: true })
  pdf.setProperties({ title, creator: 'Nalu' })
  const fonts = new Map<string, { family: string; style: SlideFontStyle }>()
  const familyFor = (node: Extract<SceneNode, { type: 'text' }>) => resolveSlideFont(node.fontFamily || node.fontFace).pdfFamily
  for (const scene of scenes) for (const node of scene.nodes) if (node.type === 'text') {
    const family = familyFor(node), style = slideFontStyle(node.bold, node.italic)
    fonts.set(`${family}/${style}`, { family, style })
  }
  await Promise.all([...fonts.values()].map(async ({ family, style }) => {
    const filename = `slide-${family.replace(/\s/g, '-')}-${style}.ttf`
    pdf.addFileToVFS(filename, base64(await loadSlideFont(family, style)))
    pdf.addFont(filename, family, style)
  }))
  // Reject missing glyphs before creating an incomplete file. Embedded fonts
  // support Latin, Greek and Cyrillic; unsupported scripts remain intact in
  // the saved scene and PowerPoint export, where the reader can supply fonts.
  for (const scene of scenes) for (const node of scene.nodes) if (node.type === 'text') {
    const family = familyFor(node)
    pdf.setFont(family, slideFontStyle(node.bold, node.italic))
    const metadata = pdf.getFont().metadata
    if (typeof metadata.characterToGlyph !== 'function') throw new Error('The presentation font could not be embedded. Please retry the PDF export.')
    for (const line of node.lines) for (const character of line) {
      const code = character.codePointAt(0)!
      if (code > 0xffff || (code > 32 && !metadata.characterToGlyph(code))) {
        throw new Error(`PDF cannot display “${character}” with ${family}. Choose a font that supports this text, or download PowerPoint to preserve it.`)
      }
    }
  }
  const image = imageCache()
  for (const [index, scene] of scenes.entries()) {
    if (index) pdf.addPage([scene.width, scene.height], 'landscape')
    pdf.setFillColor(...rgb(scene.background))
    pdf.rect(0, 0, scene.width, scene.height, 'F')
    for (const node of scene.nodes) {
      if (node.type === 'text') {
        pdf.setFont(familyFor(node), slideFontStyle(node.bold, node.italic))
        pdf.setFontSize(node.fontSize)
        pdf.setTextColor(...rgb(node.color))
        // Keep every measured line even when a brand font is substituted in
        // PDF. A wider fallback must fit its assigned box, never clip text.
        const measuredWidth = Math.max(0, ...node.lines.map((line) => pdf.getTextWidth(line)))
        const fontSize = measuredWidth > node.w && measuredWidth > 0 ? node.fontSize * node.w / measuredWidth : node.fontSize
        pdf.setFontSize(fontSize)
        const x = node.align === 'center' ? node.x + node.w / 2 : node.align === 'right' ? node.x + node.w : node.x
        node.lines.forEach((line, lineIndex) => pdf.text(line, x, baseline({ ...node, fontSize }, lineIndex), { align: node.align || 'left' }))
      } else if (node.type === 'rect') {
        pdf.saveGraphicsState()
        pdf.setGState(pdf.GState({ opacity: opacity(node.opacity), 'stroke-opacity': opacity(node.opacity) }))
        pdf.setFillColor(...rgb(node.fill))
        if (node.stroke) { pdf.setDrawColor(...rgb(node.stroke)); pdf.setLineWidth(node.strokeWidth ?? 1) }
        if (node.radius) pdf.roundedRect(node.x, node.y, node.w, node.h, node.radius, node.radius, node.stroke ? 'FD' : 'F')
        else pdf.rect(node.x, node.y, node.w, node.h, node.stroke ? 'FD' : 'F')
        pdf.restoreGraphicsState()
      } else if (node.type === 'line') {
        pdf.setDrawColor(...rgb(node.color)); pdf.setLineWidth(node.width)
        pdf.line(node.x, node.y, node.x + node.w, node.y + node.h)
      } else {
        pdf.addImage(await image(node), 'PNG', node.x, node.y, node.w, node.h)
      }
    }
  }
  return pdf.output('blob')
}
