import { useMemo, useRef, useState } from 'react'
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  ExternalHyperlink,
  ImageRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  TableLayoutType,
  VerticalAlign,
} from 'docx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { FileText, Download, Loader2 } from 'lucide-react'
import { getBrand, useBrand, toRgb } from './brandKit'
import { chartDataUrl, hasChartData } from './chartRender'
import { BrandLogo } from './BrandLogo'
import { rasterizeLogo, type RasterLogo } from './logoRaster'
import { normalizeDoc, documentWithSources, type DocBlock, type DocDoc } from './docModel'
import { documentRuns } from './docInline'
import { DOC_PAGE, DOC_HEADING_SIZES, DOC_IMAGE_MAX_HEIGHT, fitDocumentImage, documentColumnWidths } from './docLayout'

export { normalizeDoc } from './docModel'
export type { DocBlock, DocDoc } from './docModel'

// Resolve the doc's render palette + fonts from its design language (engine) →
// brand → the luxury default. Keeps DocCard in step with SlidesCard/EmailCard.
const dhex = (v?: string, fb = '') => (typeof v === 'string' && v ? '#' + v.replace(/^#/, '') : fb)
const dserif = (name?: string, flag?: boolean) =>
  typeof flag === 'boolean' ? flag : /serif|georgia|charter|fraunces|times|source serif|garamond|playfair|iowan/i.test((name || '').split(',')[0] || '')
const dstack = (name?: string, isSerif?: boolean) =>
  name ? `"${name.replace(/["']/g, '').split(',')[0]}", ${isSerif ? `Georgia, "Times New Roman", serif` : `"Helvetica Neue", Inter, system-ui, Arial, sans-serif`}` : undefined


function InlineDocText({ text }: { text: string }) {
  return <>{documentRuns(text).map((run, i) => run.url ? <a key={i} href={run.url} target="_blank" rel="noopener noreferrer" className="underline decoration-current/40 underline-offset-2 break-words">{run.text}</a> : run.bold ? <strong key={i}>{run.text}</strong> : run.italic ? <em key={i}>{run.text}</em> : run.text)}</>
}
function wordRuns(text: string, font: string, size = 22, header = false) {
  return documentRuns(text).map(run => {
    const child = new TextRun({ text: run.text, font, size, bold: header || run.bold, italics: run.italic, ...(run.url ? { style: 'Hyperlink' } : {}), ...(header ? { color: 'FFFFFF' } : {}) })
    return run.url ? new ExternalHyperlink({ link: run.url, children: [child] }) : child
  })
}

const HEAD = '0F1B2D' // Nalu midnight navy — readable heading color (luxury baseline)
const RULE = 'AF8C56' // muted gold — hairlines / small accents only


function cleanName(t?: string): string {
  return (t || 'nalu-document').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-document'
}

// ---- Word (.docx) ----------------------------------------------------------
function buildDocx(doc: DocDoc, coverImg?: ArrayBuffer | null, logoImg?: RasterLogo | null): Document {
  // Design language (engine) → brand → Nalu defaults. Headings use the deep ink
  // color (readable); the accent is reserved for thin rules. docx colors are hex
  // WITHOUT '#'.
  const brand = getBrand()
  const dz = doc.design, dzL = dz?.light, dzF = dz?.fonts
  const bare = (v?: string) => (typeof v === 'string' && v ? v.replace(/^#/, '') : '')
  const fam = (v?: string) => (typeof v === 'string' && v ? v.replace(/["']/g, '').split(',')[0].trim() : '')
  const accent = bare(dzL?.ink) || brand?.primary || HEAD
  const rule = bare(dzL?.accent) || brand?.accent || RULE
  const titleFont = fam(dzF?.display) || brand?.headingFont || 'Georgia'
  const bodyFont = fam(dzF?.body) || brand?.bodyFont || 'Calibri'
  const blocks = doc.blocks || []
  let wordMeasure: jsPDF | undefined
  const wordTextHeight = (text: string, font: string, size: number, style: string) => {
    wordMeasure ||= new jsPDF({ unit: 'pt', format: 'letter' })
    wordMeasure.setFont(dserif(font) ? 'times' : 'helvetica', style)
    wordMeasure.setFontSize(size)
    // Word supplies the final wrapping; leave a width/height reserve for font
    // differences so an image does not make its keep-next group exceed a page.
    return wordMeasure.splitTextToSize(text, DOC_PAGE.contentWidth * .9).length * size * 1.15
  }
  // Optional cover page: a full-width photo banner + title + subtitle, then a
  // page break before the body.
  const coverChildren: Paragraph[] = []
  if (coverImg) {
    coverChildren.push(
      new Paragraph({
        spacing: { after: 360 },
        children: [
          new ImageRun({
            type: 'jpg',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: coverImg as any,
            transformation: { width: 600, height: 320 },
          }),
        ],
      }),
      new Paragraph({
        spacing: { before: 120, after: 120 },
        children: [new TextRun({ text: doc.title || 'Document', bold: true, size: 60, color: accent, font: titleFont })],
      }),
      ...(doc.subtitle
        ? [new Paragraph({ children: [new TextRun({ text: doc.subtitle, italics: true, size: 28, color: '666666' })] })]
        : []),
    )
  }
  const children: (Paragraph | Table)[] = []
  // Brand logo at the very top of the document (before the title).
  if (logoImg) {
    const logoSize = fitDocumentImage(logoImg.w, logoImg.h, DOC_PAGE.contentPixels * .4, 34)
    children.push(
      new Paragraph({
        spacing: { after: 300 },
        children: [
          new ImageRun({
            type: 'png',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: logoImg.bytes as any,
            transformation: logoSize,
          }),
        ],
      }),
    )
  }
  children.push(
    new Paragraph({
      children: [new TextRun({ text: doc.title || 'Document', bold: true, size: 52, color: accent, font: titleFont })],
      spacing: { after: doc.subtitle ? 80 : 280 },
    }),
  )
  if (doc.subtitle) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: doc.subtitle, italics: true, size: 26, color: '666666', font: bodyFont })],
        spacing: { after: 320 },
      }),
    )
  }

  for (const [blockIndex, b] of blocks.entries()) {
    if (b.type === 'heading') {
      const lvl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][(b.level || 2) - 1]
      children.push(
        new Paragraph({
          heading: lvl,
          keepNext: true,
          keepLines: true,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: b.text || '', bold: true, color: accent, font: titleFont })],
        }),
      )
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ children: wordRuns(b.text || '', bodyFont), spacing: { after: 160 } }))
    } else if (b.type === 'bullets') {
      for (const it of b.items || []) {
        children.push(
          new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: wordRuns(it, bodyFont) }),
        )
      }
    } else if (b.type === 'table') {
      const cols = b.columns || []
      const widths = documentColumnWidths(cols, b.rows || [])
      const cell = (value: string, ci: number, header = false) => new TableCell({
        width: { size: widths[ci], type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        ...(header ? { shading: { fill: accent, color: 'auto', type: 'clear' as never } } : {}),
        children: [new Paragraph({ spacing: { before: 0, after: 0, line: 240 }, children: wordRuns(value, bodyFont, 20, header) })],
      })
      const head = new TableRow({
        tableHeader: true, // repeat the header row across page breaks
        children: cols.map((value, ci) => cell(value, ci, true)),
      })
      const body = (b.rows || []).map(
        (r) =>
          new TableRow({
            cantSplit: true,
            children: cols.map((_, ci) => cell(String(r[ci] ?? ''), ci)),
          }),
      )
      children.push(
        new Table({
          width: { size: DOC_PAGE.contentDxa, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: widths,
          indent: { size: 0, type: WidthType.DXA },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
            left: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
            right: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'EEEEEE' },
            insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'EEEEEE' },
          },
          rows: [head, ...body],
        }),
      )
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }))
    } else if (b.type === 'chart' && hasChartData(b.chart)) {
      const url = chartDataUrl(b.chart!, 1100, 620)
      const bytes = url ? dataUrlToUint8(url) : null
      if (bytes) {
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 200 },
            children: [
              new ImageRun({
                type: 'png',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data: bytes as any,
                transformation: { width: 560, height: 315 },
              }),
            ],
          }),
        )
      }
    } else if (b.type === 'image' && b.src) {
      const bytes = dataUrlToUint8(b.src)
      if (bytes) {
        let headingHeight = 0
        let previous = blockIndex - 1
        for (; previous >= 0 && blocks[previous].type === 'heading'; previous--) {
          const heading = blocks[previous] as Extract<DocBlock, { type: 'heading' }>
          headingHeight += wordTextHeight(heading.text || '', titleFont, DOC_HEADING_SIZES[(heading.level || 2) - 1], 'bold') + 18
        }
        if (previous < 0) {
          headingHeight += wordTextHeight(doc.title || 'Document', titleFont, 26, 'bold') + (doc.subtitle ? 4 : 14)
          if (doc.subtitle) headingHeight += wordTextHeight(doc.subtitle, bodyFont, 13, 'italic') + 16
          if (logoImg) headingHeight += fitDocumentImage(logoImg.w, logoImg.h, DOC_PAGE.contentPixels * .4, 34).height * .75 + 15
        }
        const next = blocks[blockIndex + 1]
        const trailingReserve = next?.type === 'paragraph' && next.text ? Math.min(11 * 1.15 * 2, wordTextHeight(next.text, bodyFont, 11, 'normal')) + 8 : 0
        const available = DOC_PAGE.height - DOC_PAGE.margin * 2 - headingHeight - 40 - trailingReserve
        const captionHeight = b.caption ? Math.min(wordTextHeight(b.caption, bodyFont, 9, 'italic'), Math.max(24, available - 24)) : 0
        const imageMaxHeight = Math.max(24, Math.min(DOC_IMAGE_MAX_HEIGHT, available - captionHeight))
        const size = fitDocumentImage(b.w, b.h, DOC_PAGE.contentPixels, imageMaxHeight * 4 / 3)
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            keepNext: !!b.caption,
            spacing: { before: 160, after: b.caption ? 40 : 200 },
            children: [
              new ImageRun({
                type: docxImageType(b.src),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data: bytes as any,
                transformation: size,
              }),
            ],
          }),
        )
        if (b.caption) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 200 },
              children: [new TextRun({ text: b.caption, italics: true, size: 18, color: '666666', font: bodyFont })],
            }),
          )
        }
      }
    }
  }

  return new Document({
    styles: {
      default: {
        document: { run: { font: bodyFont, size: 22 }, paragraph: { spacing: { before: 0, after: 160, line: 276 } } },
        ...Object.fromEntries(DOC_HEADING_SIZES.map((size, i) => [`heading${i + 1}`, { run: { font: titleFont, size: size * 2, bold: true, color: accent }, paragraph: { keepNext: true, spacing: { before: 240, after: 120 } } }])),
      },
    },
    sections: coverChildren.length
      ? [
          { properties: { page: { size: { width: DOC_PAGE.widthDxa, height: DOC_PAGE.heightDxa }, margin: { top: DOC_PAGE.marginDxa, bottom: DOC_PAGE.marginDxa, left: DOC_PAGE.marginDxa, right: DOC_PAGE.marginDxa } } }, children: coverChildren },
          { properties: { page: { size: { width: DOC_PAGE.widthDxa, height: DOC_PAGE.heightDxa }, margin: { top: DOC_PAGE.marginDxa, bottom: DOC_PAGE.marginDxa, left: DOC_PAGE.marginDxa, right: DOC_PAGE.marginDxa } } }, children },
        ]
      : [{ properties: { page: { size: { width: DOC_PAGE.widthDxa, height: DOC_PAGE.heightDxa }, margin: { top: DOC_PAGE.marginDxa, bottom: DOC_PAGE.marginDxa, left: DOC_PAGE.marginDxa, right: DOC_PAGE.marginDxa } } }, children }],
  })
}

/** Build the designed .docx as a Blob (shared with the Agents output nodes). */
export async function buildDocxBlob(doc: DocDoc, coverImg?: ArrayBuffer | null): Promise<Blob> {
  const brand = getBrand()
  const src = brand?.logo || brand?.logoMark
  let logoImg: RasterLogo | null = null
  if (src) {
    try { logoImg = await rasterizeLogo(src, { height: 80, bgDark: false }) } catch { /* logo optional */ }
  }
  return Packer.toBlob(buildDocx(documentWithSources(doc), coverImg, logoImg))
}
/** Build the designed .pdf as a Blob (shared with the Agents output nodes). */
// The active brand's logo, rasterized to PNG for doc headers (light background).
async function docBrandLogo(): Promise<RasterLogo | null> {
  const brand = getBrand()
  const src = brand?.logo || brand?.logoMark
  if (!src) return null
  try { return await rasterizeLogo(src, { height: 80, bgDark: false }) } catch { return null }
}
export async function buildPdfBlob(rawDoc: DocDoc): Promise<Blob> {
  const doc = documentWithSources(rawDoc)
  // Documents never get a stock hero cover photo — clean editorial pages only.
  return buildPdf(doc, null, await docBrandLogo()).output('blob')
}
/** Clean, filesystem-safe filename for a doc title. */
export function docFilename(doc: DocDoc): string {
  return cleanName(doc.title) + '.docx'
}

function dataUrlToUint8(dataUrl: string): Uint8Array | null {
  try {
    const b64 = dataUrl.split(',')[1]
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return arr
  } catch {
    return null
  }
}

// docx's ImageRun needs the format named explicitly; infer it from the dataUrl.
function docxImageType(dataUrl: string): 'jpg' | 'png' | 'gif' | 'bmp' {
  const m = /^data:image\/([a-z+]+)/i.exec(dataUrl)
  const t = (m?.[1] || '').toLowerCase()
  if (t === 'png') return 'png'
  if (t === 'gif') return 'gif'
  if (t === 'bmp') return 'bmp'
  return 'jpg' // jpeg/webp/everything else → jpg (canvas exported jpeg)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// ---- PDF -------------------------------------------------------------------
function buildPdf(doc: DocDoc, coverImg?: string | null, logoImg?: RasterLogo | null): jsPDF {
  const brand = getBrand()
  const dz = doc.design, dzL = dz?.light, dzF = dz?.fonts
  const pick = (v?: string, fb?: string) => (typeof v === 'string' && v ? v : fb || '')
  const [ar, ag, ab] = toRgb(pick(dzL?.ink, brand?.primary || HEAD))
  const [gr, gg, gb] = toRgb(pick(dzL?.accent, brand?.accent || RULE))
  // jsPDF has only 3 core families — map the design's display/body to serif/sans.
  const isSerif = (name?: string, flag?: boolean) =>
    typeof flag === 'boolean' ? flag : /serif|georgia|charter|fraunces|times|source serif|garamond|playfair|iowan/i.test((name || '').split(',')[0] || '')
  const HEADF = isSerif(dzF?.display || brand?.headingFont || 'Georgia', dzF?.displaySerif) ? 'times' : 'helvetica'
  const BODYF = isSerif(dzF?.body || brand?.bodyFont || 'Arial', dzF?.bodySerif) ? 'times' : 'helvetica'
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const margin = DOC_PAGE.margin
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const maxW = pageW - margin * 2
  const blocks = doc.blocks || []
  let y = margin

  const ensure = (need: number) => {
    if (y > margin && y + need > pageH - margin) {
      pdf.addPage()
      y = margin
    }
  }

  const headingHeight = (block: Extract<DocBlock, { type: 'heading' }>) => {
    const size = DOC_HEADING_SIZES[(block.level || 2) - 1]
    pdf.setFont(HEADF, 'bold'); pdf.setFontSize(size)
    return 10 + pdf.splitTextToSize(block.text || '', maxW).length * (size + 6)
  }
  const imageLayouts = new Map<number, { width: number; height: number; captionLines: string[]; heightWithCaption: number }>()
  const imageLayout = (block: Extract<DocBlock, { type: 'image' }>, index: number, remaining?: number) => {
    const cached = imageLayouts.get(index)
    if (cached) return cached
    let headings = 0
    for (let previous = index - 1; previous >= 0 && blocks[previous].type === 'heading'; previous--) headings += headingHeight(blocks[previous] as Extract<DocBlock, { type: 'heading' }>)
    pdf.setFont(BODYF, 'italic')
    pdf.setFontSize(9)
    const captionLines: string[] = block.caption ? pdf.splitTextToSize(block.caption, maxW) : []
    const next = blocks[index + 1]
    let trailingReserve = 0
    if (next?.type === 'paragraph' && next.text) {
      pdf.setFont(BODYF, 'normal'); pdf.setFontSize(11)
      trailingReserve = Math.min(2, pdf.splitTextToSize(next.text, maxW).length) * 15 + 6
    }
    const available = pageH - margin * 2 - headings - 16 - trailingReserve
    // Captions that themselves span a page continue normally; retain all lines.
    const captionReserve = Math.min(captionLines.length * 12, Math.max(24, available - 24))
    let size = fitDocumentImage(block.w, block.h, maxW, Math.max(24, Math.min(DOC_IMAGE_MAX_HEIGHT, available - captionReserve)))
    const remainingImage = (remaining ?? 0) - captionReserve - 16 - trailingReserve
    // Use the current page when the figure remains legible. Otherwise move the
    // intact group to a fresh page instead of reducing it to a tiny thumbnail.
    if (remainingImage >= Math.min(300, size.height * .75)) size = fitDocumentImage(block.w, block.h, maxW, Math.min(size.height, remainingImage))
    const layout = { ...size, captionLines, heightWithCaption: size.height + 16 + captionReserve }
    imageLayouts.set(index, layout)
    return layout
  }
  // Keep headings with the following figure or first table row as Word does.
  // Measurements use the exact fonts/widths used below; text is never sliced.
  const followingContentHeight = (start: number, remaining: number): number => {
    let need = 0
    for (let index = start; index < blocks.length; index++) {
      const next = blocks[index]
      if (next.type === 'heading') {
        need += headingHeight(next)
      } else if (next.type === 'image' && next.src) return need + imageLayout(next, index, remaining - need).heightWithCaption
      else if (next.type === 'chart' && hasChartData(next.chart)) return need + maxW * (620 / 1100) + 16
      else if (next.type === 'table') {
        const widths = documentColumnWidths(next.columns || [], next.rows || []).map(width => width / 20)
        pdf.setFontSize(9)
        const rowHeight = (cells: string[], bold: boolean) => {
          pdf.setFont(BODYF, bold ? 'bold' : 'normal')
          return Math.max(1, ...cells.map((text, i) => pdf.splitTextToSize(text, Math.max(1, widths[i] - 8)).length)) * 10.35 + 8
        }
        return need + rowHeight(next.columns || [], true) + (next.rows?.length ? rowHeight(next.rows[0], false) : 0) + 2
      } else if (next.type === 'paragraph' && next.text || next.type === 'bullets' && next.items?.length) return need + 17
    }
    return need
  }

  // Cover page — full-bleed photo top, gold rule, serif title + subtitle.
  if (coverImg) {
    try {
      pdf.addImage(coverImg, 'JPEG', 0, 0, pageW, pageH * 0.52)
      pdf.setTextColor(ar, ag, ab)
      pdf.setFont(HEADF, 'bold')
      pdf.setFontSize(30)
      let cy = pageH * 0.52 + 60
      for (const line of pdf.splitTextToSize(doc.title || 'Document', maxW)) {
        pdf.text(line, margin, cy)
        cy += 36
      }
      pdf.setDrawColor(gr, gg, gb)
      pdf.setLineWidth(1.5)
      pdf.line(margin, cy - 8, margin + 90, cy - 8)
      if (doc.subtitle) {
        pdf.setTextColor(110)
        pdf.setFont(BODYF, 'italic')
        pdf.setFontSize(15)
        cy += 22
        for (const line of pdf.splitTextToSize(doc.subtitle, maxW)) {
          pdf.text(line, margin, cy)
          cy += 20
        }
      }
      pdf.addPage()
      y = margin
    } catch {
      /* fall through to text title */
    }
  }

  if (logoImg) {
    const { width: lw, height: lh } = fitDocumentImage(logoImg.w, logoImg.h, maxW * .4, 24)
    ensure(lh + 24)
    try { pdf.addImage(logoImg.dataUrl, 'PNG', margin, y, lw, lh) } catch { /* */ }
    y += lh + 24
  }
  pdf.setTextColor(ar, ag, ab)
  pdf.setFont(HEADF, 'bold')
  pdf.setFontSize(22)
  for (const line of pdf.splitTextToSize(doc.title || 'Document', maxW)) {
    ensure(26)
    pdf.text(line, margin, y)
    y += 26
  }
  if (doc.subtitle) {
    pdf.setTextColor(120)
    pdf.setFont(BODYF, 'italic')
    pdf.setFontSize(12)
    for (const line of pdf.splitTextToSize(doc.subtitle, maxW)) {
      ensure(16)
      pdf.text(line, margin, y)
      y += 16
    }
  }
  y += 8

  const richParagraph = (text: string, indent = 0, bullet = false) => {
    let x = margin + indent
    let first = true
    const newline = () => { y += 15; x = margin + indent; first = false }
    ensure(15)
    if (bullet) { pdf.setFont(BODYF, 'normal'); pdf.setFontSize(11); pdf.setTextColor(30); pdf.text('•', margin + 4, y) }
    for (const run of documentRuns(text)) {
      for (const token of run.text.split(/(\s+)/).filter(Boolean)) {
        if (token.includes('\n')) { newline(); continue }
        const style = run.bold ? 'bold' : run.italic ? 'italic' : 'normal'
        pdf.setFont(BODYF, style); pdf.setFontSize(11)
        const available = maxW - indent
        const parts = pdf.getTextWidth(token) > available ? pdf.splitTextToSize(token, available) as string[] : [token]
        for (const part of parts) {
          const width = pdf.getTextWidth(part)
          if (x + width > margin + maxW && x > margin + indent) newline()
          if (!part.trim() && x === margin + indent) continue
          ensure(15)
          pdf.setFont(BODYF, style); pdf.setFontSize(11); pdf.setTextColor(run.url ? '#2563A6' : '#1E1E1E')
          if (run.url) pdf.textWithLink(part, x, y, { url: run.url })
          else pdf.text(part, x, y)
          x += width
        }
      }
    }
    if (x > margin + indent || first) y += 15
    y += 6
  }

  for (const [blockIndex, b] of blocks.entries()) {
    if (b.type === 'heading') {
      y += 8
      const size = DOC_HEADING_SIZES[(b.level || 2) - 1]
      pdf.setTextColor(ar, ag, ab)
      pdf.setFont(HEADF, 'bold')
      pdf.setFontSize(size)
      const lines = pdf.splitTextToSize(b.text || '', maxW)
      const followingHeight = followingContentHeight(blockIndex + 1, pageH - margin - y - lines.length * (size + 6) - 2)
      pdf.setFont(HEADF, 'bold')
      pdf.setFontSize(size)
      ensure(lines.length * (size + 6) + 2 + followingHeight)
      for (const line of lines) {
        ensure(size + 6)
        pdf.text(line, margin, y)
        y += size + 6
      }
      y += 2
    } else if (b.type === 'paragraph') {
      richParagraph(b.text || '')
    } else if (b.type === 'bullets') {
      for (const item of b.items || []) richParagraph(item, 14, true)
    } else if (b.type === 'table') {
      autoTable(pdf, {
        head: [(b.columns || []).map(value => documentRuns(value).map(run => run.text).join(''))],
        body: (b.rows || []).map((r) => r.map((c) => documentRuns(String(c ?? '')).map(run => run.text).join(''))),
        startY: y,
        rowPageBreak: 'avoid',
        margin: { left: margin, right: margin, top: margin, bottom: margin },
        styles: { font: BODYF, fontSize: 9, cellPadding: 4, valign: 'middle' },
        columnStyles: Object.fromEntries(documentColumnWidths(b.columns || [], b.rows || []).map((width, i) => [i, { cellWidth: width / 20 }])),
        headStyles: { fillColor: [ar, ag, ab] },
        didDrawCell: data => {
          const original = data.section === 'head' ? b.columns?.[data.column.index] : b.rows?.[data.row.index]?.[data.column.index]
          const urls = [...new Set(documentRuns(String(original ?? '')).flatMap(run => run.url ? [run.url] : []))]
          // Preserve citation targets even when a table cell wraps over lines.
          // Multiple citations receive separate, equal-width annotation regions.
          urls.forEach((url, index) => pdf.link(data.cell.x + index * data.cell.width / urls.length, data.cell.y, data.cell.width / urls.length, data.cell.height, { url }))
        },
      })
      // @ts-expect-error lastAutoTable is attached by the plugin
      y = (pdf.lastAutoTable?.finalY || y) + 14
    } else if (b.type === 'chart' && hasChartData(b.chart)) {
      const url = chartDataUrl(b.chart!, 1100, 620)
      if (url) {
        const cw = maxW
        const ch = cw * (620 / 1100)
        ensure(ch + 16)
        try {
          pdf.addImage(url, 'PNG', margin, y, cw, ch)
        } catch {
          /* skip */
        }
        y += ch + 16
      }
    } else if (b.type === 'image' && b.src) {
      const { width: cw, height: ch, captionLines, heightWithCaption } = imageLayout(b, blockIndex, pageH - margin - y)
      ensure(heightWithCaption)
      try {
        pdf.addImage(b.src, docxImageType(b.src) === 'png' ? 'PNG' : 'JPEG', margin + (maxW - cw) / 2, y, cw, ch)
      } catch {
        /* skip */
      }
      y += ch + 8
      if (b.caption) {
        pdf.setTextColor(110)
        pdf.setFont(BODYF, 'italic')
        pdf.setFontSize(9)
        for (const line of captionLines) {
          ensure(12)
          pdf.text(line, pageW / 2, y, { align: 'center' })
          y += 12
        }
      }
      y += 8
    }
  }
  // Footer page numbers across every page (skip the cover, page 1, if present).
  const total = pdf.getNumberOfPages()
  const startPage = coverImg ? 2 : 1
  for (let p = startPage; p <= total; p++) {
    pdf.setPage(p)
    pdf.setFont('times', 'normal')
    pdf.setFontSize(9)
    pdf.setTextColor(150)
    pdf.text(`${p - startPage + 1}`, pageW / 2, pageH - 24, { align: 'center' })
  }
  pdf.setTextColor(0)
  return pdf
}

export default function DocCard({ data: rawData }: { data: DocDoc }) {
  const data = useMemo(() => normalizeDoc(rawData), [rawData])
  const name = cleanName(data.title)
  const blocks = documentWithSources(data).blocks || []
  const [busy, setBusy] = useState<'docx' | 'pdf' | null>(null)
  const [error, setError] = useState('')
  const exportLock = useRef(false)

  const downloadDocx = async () => {
    if (exportLock.current) return
    exportLock.current = true
    setBusy('docx')
    setError('')
    try {
      const blob = await buildDocxBlob(data, null) // no hero cover in docs

      downloadBlob(blob, `${name}.docx`)
    } catch (e) {
      setError(`Word export failed: ${e instanceof Error ? e.message : 'Please try again.'}`)
    } finally {
      exportLock.current = false
      setBusy(null)
    }
  }
  const downloadPdf = async () => {
    if (exportLock.current) return
    exportLock.current = true
    setBusy('pdf')
    setError('')
    try {
      downloadBlob(await buildPdfBlob(data), `${name}.pdf`)

    } catch (e) {
      setError(`PDF export failed: ${e instanceof Error ? e.message : 'Please try again.'}`)
    } finally {
      exportLock.current = false
      setBusy(null)
    }
  }

  // The FULL document renders in the chat — every section, real tables, real
  // charts — in a flat, minimal frame. Styled LIVE by the active Brand Kit
  // (colors + fonts from the Brand bar editor), matching the exported Word/PDF.
  const liveBrand = useBrand()
  const chartImages = useMemo(() => (data.blocks || []).map((block) => block.type === 'chart' && hasChartData(block.chart) ? chartDataUrl(block.chart!, 900, 480) : null), [data.blocks, liveBrand])
  // Design language (from the engine) wins; else the live Brand Kit; else luxury default.
  const dz = data.design
  const L = dz?.light || {}
  const dz_f = dz?.fonts || {}
  const paper = dhex(L.bg, '#F7F5F1')
  const bPrimary = dhex(L.ink, '#' + (liveBrand?.primary || '14345A'))
  const bAccent = dhex(L.accent, '#' + (liveBrand?.accent || 'AF8C56'))
  const bMuted = dhex(L.muted, '#8a8175')
  const bText = dhex(L.ink, '#' + (liveBrand?.text || '2a2a2a'))
  const headFont = dz
    ? dstack(dz_f.display, dserif(dz_f.display, dz_f.displaySerif))
    : `'${liveBrand?.headingFont || 'Playfair Display'}', Georgia, serif`
  const bodyFont = dz
    ? dstack(dz_f.body, dserif(dz_f.body, dz_f.bodySerif))
    : liveBrand?.bodyFont
      ? `'${liveBrand.bodyFont}', Calibri, system-ui, sans-serif`
      : undefined
  return (
    <div className="my-4 border-y border-glass/[0.12]">
      <div className="flex items-baseline gap-3 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">Document</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{data.title || 'Document'}</span>
        <button onClick={() => void downloadDocx()} disabled={busy !== null}
          className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">
          {busy === 'docx' ? 'Designing…' : 'Word'}
        </button>
        <span className="text-xs text-dim">·</span>
        <button onClick={() => void downloadPdf()} disabled={busy !== null}
          className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">
          {busy === 'pdf' ? 'Designing…' : 'PDF'}
        </button>
      </div>
      {error && <p role="alert" className="px-1 pb-2 text-xs text-red-400">{error}</p>}
      <div className="max-h-[78vh] overflow-y-auto px-8 py-7 text-[13.5px] leading-relaxed" style={{ color: bText, fontFamily: bodyFont, backgroundColor: paper }}>
        {(liveBrand?.logo || liveBrand?.logoMark) && (
          <BrandLogo
            src={(liveBrand?.logo || liveBrand?.logoMark) as string}
            dark={(() => { const [r, g, b] = toRgb(paper); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 })()}
            className="mb-6 h-8 max-w-[40%] object-contain"
            style={{ objectPosition: 'left center' }}
          />
        )}
        <div style={{ fontFamily: headFont, color: bPrimary }} className="text-[24px] font-semibold leading-tight">
          {data.title || 'Document'}
        </div>
        {data.researchStatus === 'unverified' && <p className="my-3 rounded border border-amber-700/30 bg-amber-50 p-3 text-xs text-amber-900">Current facts could not be fully verified from the web. Check the stated evidence gaps before using this document.</p>}
        {!!data.incompleteSections?.length && <p className="my-3 rounded border border-amber-700/30 bg-amber-50 p-3 text-xs text-amber-900">Incomplete: {data.incompleteSections.join(', ')} could not be generated.</p>}
        {data.subtitle && <div className="mt-1 italic" style={{ color: bMuted }}>{data.subtitle}</div>}
        <div className="mb-5 mt-3 h-px w-16" style={{ backgroundColor: bAccent }} />
        {blocks.map((b, i) => {
          if (b.type === 'heading')
            return (
              <div
                key={i}
                style={{ fontFamily: headFont, color: bPrimary }}
                role="heading" aria-level={b.level || 2}
                className={`mt-5 font-semibold ${b.level === 1 ? 'text-[18px]' : b.level === 3 ? 'text-[14px]' : b.level === 4 ? 'text-[13.5px]' : 'text-[16px]'}`}
              >
                {b.text}
              </div>
            )
          if (b.type === 'paragraph') return <p key={i} className="mt-2"><InlineDocText text={b.text || ''} /></p>
          if (b.type === 'bullets')
            return (
              <ul key={i} className="mt-2 space-y-1 pl-1">
                {(b.items || []).map((it, j) => (
                  <li key={j} className="flex gap-2.5">
                    <span style={{ color: bAccent }}>·</span>
                    <span><InlineDocText text={it} /></span>
                  </li>
                ))}
              </ul>
            )
          if (b.type === 'chart' && hasChartData(b.chart)) {
            const url = chartImages[i]
            return url ? <img key={i} src={url} alt={b.chart?.title || 'chart'} className="my-4 w-full max-w-2xl bg-white" /> : null
          }
          if (b.type === 'table')
            return (
              <div key={i} className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      {(b.columns || []).map((c, j) => (
                        <th key={j} className="border-b-2 bg-transparent px-2.5 py-1.5 text-left font-semibold" style={{ borderColor: bPrimary, color: bPrimary }}><InlineDocText text={c} /></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(b.rows || []).map((r, ri) => (
                      <tr key={ri} className={ri % 2 ? 'bg-black/[0.025]' : ''}>
                        {(b.columns || []).map((_, ci) => (
                          <td key={ci} className="border-b border-black/10 px-2.5 py-1.5 align-top"><InlineDocText text={String(r[ci] ?? '')} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          if (b.type === 'image' && b.src)
            return (
              <figure key={i} className="my-4">
                <img src={b.src} alt={b.caption || ''} className="w-full max-w-2xl" />
                {b.caption && <figcaption className="mt-1 text-xs italic text-[#8a8175]">{b.caption}</figcaption>}
              </figure>
            )
          return null
        })}
      </div>
    </div>
  )
}
