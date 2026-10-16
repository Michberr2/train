import type { BrandArt } from './StudioCards'

type BrandSection = { title: string; paragraphs: string[]; bullets?: boolean }

// Both handoff formats include the same supplied rules. The palette has its own
// swatch rendering; no generated replacement copy or unrelated saved brand kit.
function sections(art: BrandArt): BrandSection[] {
  const typography = art.typography || {}, heading = typography.heading || {}, body = typography.body || {}
  const logo = art.logo || {}, spacing = art.spacing || {}
  const result: BrandSection[] = [{ title: 'Typography', paragraphs: [
    `Heading: ${heading.family || 'Inter'} (${heading.weights?.join(', ') || '700'})`,
    ...(heading.usage ? [heading.usage] : []),
    `Body: ${body.family || 'Inter'} (${body.weights?.join(', ') || '400'})`,
    ...(body.usage ? [body.usage] : []),
    ...(typography.scale?.length ? ['Type scale: ' + typography.scale.join(' · ') + ' px'] : []),
  ] }]
  if (logo.direction || logo.clearspace || logo.minSize) result.push({ title: 'Logo', paragraphs: [
    ...(logo.direction ? [logo.direction] : []),
    ...(logo.clearspace ? ['Clearspace: ' + logo.clearspace] : []),
    ...(logo.minSize ? ['Minimum size: ' + logo.minSize] : []),
  ] })
  if (art.dos?.length) result.push({ title: 'Do', paragraphs: art.dos, bullets: true })
  if (art.donts?.length) result.push({ title: "Don't", paragraphs: art.donts, bullets: true })
  if (spacing.base != null || spacing.scale?.length) result.push({ title: 'Spacing', paragraphs: [
    ...(spacing.base != null ? [`Base: ${spacing.base} px`] : []),
    ...(spacing.scale?.length ? ['Spacing scale: ' + spacing.scale.join(' · ') + ' px'] : []),
  ] })
  return result
}

function hex(value: string): string {
  const color = value.replace(/^#/, '')
  return /^[\da-f]{3}$/i.test(color) ? color.split('').map(c => c + c).join('').toUpperCase()
    : /^[\da-f]{6}$/i.test(color) ? color.toUpperCase() : '808080'
}

function swatchInk(fill: string): string {
  const values = [0, 2, 4].map(offset => parseInt(fill.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2] > .179 ? '000000' : 'FFFFFF'
}

/** Selectable, paginated PDF preserving all structured brand guidance. */
export async function buildBrandPdf(art: BrandArt): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
  const width = pdf.internal.pageSize.getWidth(), height = pdf.internal.pageSize.getHeight()
  const margin = 48, contentWidth = width - margin * 2, bottom = height - margin
  let y = margin
  const background = () => { pdf.setFillColor(11, 14, 22); pdf.rect(0, 0, width, height, 'F') }
  background()
  const ensure = (space: number) => {
    if (y + space <= bottom || y === margin) return
    pdf.addPage(); background(); y = margin
  }
  const paragraph = (value: string, options: { size?: number; bold?: boolean; color?: string; after?: number; bullet?: boolean } = {}) => {
    const size = options.size || 11, leading = size * 1.4, indent = options.bullet ? 13 : 0
    pdf.setFont('helvetica', options.bold ? 'bold' : 'normal'); pdf.setFontSize(size)
    const lines = pdf.splitTextToSize(value, contentWidth - indent) as string[]
    ensure(Math.min(2, lines.length) * leading)
    for (let i = 0; i < lines.length; i++) {
      // Keep the final two lines together when a paragraph spans pages.
      ensure((lines.length - i === 2 ? 2 : 1) * leading)
      pdf.setTextColor(options.color || '#D2D2D2')
      if (options.bullet && i === 0) pdf.text('•', margin, y + size)
      pdf.text(lines[i], margin + indent, y + size)
      y += leading
    }
    y += options.after ?? 8
  }
  const section = (title: string) => {
    ensure(18 + 15 * 1.4 + 8 + 2 * 11 * 1.4)
    y += 18
    paragraph(title, { size: 15, bold: true, color: title === 'Do' ? '#6EE7B7' : title === "Don't" ? '#FCA5A5' : '#FFFFFF' })
  }
  const brand = art.brand || {}
  paragraph(brand.name || 'Brand Guidelines', { size: 30, bold: true, color: '#FFFFFF', after: 12 })
  if (brand.tagline) paragraph(brand.tagline, { size: 13, color: '#9FB3FF', after: 12 })
  if (brand.mission) paragraph(brand.mission)
  if (brand.voice?.length) paragraph('Voice: ' + brand.voice.join(' · '), { size: 10, color: '#96A0B4' })
  const palette = (art.palette || []).filter(c => c && c.hex)
  if (palette.length) {
    section('Color Palette')
    for (const color of palette) {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11)
      const label = [color.role, color.name, '#' + hex(color.hex)].filter(Boolean).join(' · ')
      const labelHeight = (pdf.splitTextToSize(label, contentWidth) as string[]).length * 15.4
      ensure(24 + labelHeight + (color.usage ? 2 * 15.4 : 0) + 16)
      pdf.setFillColor('#' + hex(color.hex)); pdf.rect(margin, y, 64, 16, 'F'); y += 24
      paragraph(label, { bold: true, color: '#FFFFFF', after: color.usage ? 4 : 8 })
      if (color.usage) paragraph(color.usage)
    }
  }
  for (const item of sections(art)) {
    section(item.title)
    for (const text of item.paragraphs) paragraph(text, { bullet: item.bullets })
  }
  const count = pdf.getNumberOfPages()
  for (let i = 1; i <= count; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor('#96A0B4')
    pdf.text(`${i} / ${count}`, width - margin, height - 24, { align: 'right' })
  }
  return pdf.output('blob')
}

/** Editable Word handoff, including logo, typography, color and spacing rules. */
export async function buildBrandDocx(art: BrandArt): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, HeadingLevel } = await import('docx')
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []
  const brand = art.brand || {}
  const paragraph = (text: string, options: { bold?: boolean; italics?: boolean; bullet?: boolean } = {}) => new Paragraph({
    ...(options.bullet ? { bullet: { level: 0 } } : {}),
    widowControl: true,
    children: [new TextRun({ text, bold: options.bold, italics: options.italics })],
  })
  const section = (text: string) => children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, children: [new TextRun(text)] }))
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, keepNext: true, children: [new TextRun(brand.name || 'Brand Guidelines')] }))
  if (brand.tagline) children.push(paragraph(brand.tagline, { italics: true }))
  if (brand.mission) children.push(paragraph(brand.mission))
  if (brand.voice?.length) children.push(paragraph('Voice: ' + brand.voice.join(', '), { bold: true }))
  const palette = (art.palette || []).filter(c => c && c.hex)
  if (palette.length) {
    section('Color Palette')
    const widths = [1600, 1600, 1400, 5386]
    const cell = (text: string, index: number, fill?: string, header = false) => new TableCell({
      width: { size: widths[index], type: WidthType.DXA },
      ...(fill ? { shading: { fill, color: 'auto', type: 'clear' as const } } : {}),
      children: [new Paragraph({ children: [new TextRun({ text, bold: header, ...(fill ? { color: swatchInk(fill) } : {}) })] })],
    })
    children.push(new Table({
      width: { size: 9986, type: WidthType.DXA }, columnWidths: widths,
      rows: [new TableRow({ tableHeader: true, children: ['Role', 'Name', 'Hex', 'Usage'].map((value, i) => cell(value, i, 'E8ECF2', true)) }),
        ...palette.map(c => new TableRow({ children: [cell(c.role || '', 0), cell(c.name || '', 1), cell('#' + hex(c.hex), 2, hex(c.hex)), cell(c.usage || '', 3)] })),
      ],
    }))
  }
  for (const item of sections(art)) {
    section(item.title)
    for (const text of item.paragraphs) children.push(paragraph(text, { bullet: item.bullets }))
  }
  return Packer.toBlob(new Document({
    styles: { default: {
      document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { before: 0, after: 160, line: 276 } } },
      title: { run: { font: 'Calibri', size: 56, bold: true, color: '182825' }, paragraph: { spacing: { after: 240 }, keepNext: true } },
      heading1: { run: { font: 'Calibri', size: 30, bold: true, color: '182825' }, paragraph: { spacing: { before: 280, after: 140 }, keepNext: true } },
    } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 960, bottom: 960, left: 960, right: 960 } } }, children }],
  }))
}
