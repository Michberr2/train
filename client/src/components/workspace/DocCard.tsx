import { useState } from 'react'
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  ImageRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from 'docx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { FileText, Download, Loader2 } from 'lucide-react'
import { getBrand, useBrand, toRgb } from './brandKit'
import { coverImageDataUrl, coverImageBuffer } from './coverImage'
import { chartDataUrl, hasChartData, type ChartSpec } from './chartRender'

export type DocBlock =
  | { type: 'heading'; level?: number; text?: string }
  | { type: 'paragraph'; text?: string }
  | { type: 'bullets'; items?: string[] }
  | { type: 'table'; columns?: string[]; rows?: string[][] }
  | { type: 'chart'; chart?: ChartSpec }
  // A user-attached image (screenshot/photo) embedded into the doc. `src` is a
  // data URL; `w`/`h` are the natural pixel dims (for correct aspect on export).
  | { type: 'image'; src?: string; caption?: string; w?: number; h?: number }

export type DocDoc = {
  title?: string
  subtitle?: string
  cover?: string
  blocks?: DocBlock[]
}

const HEAD = '0F1B2D' // Nalu midnight navy — readable heading color (luxury baseline)
const RULE = 'AF8C56' // muted gold — hairlines / small accents only

// The model's JSON is imperfect in the wild: text as nested objects, items as a
// string, rows as objects. NORMALIZE everything up front so the card and the
// Word/PDF exports can never throw ("The document couldn't render here").
function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.text != null) return asText(o.text)
    if (o.value != null) return asText(o.value)
    try { return JSON.stringify(v) } catch { return '' }
  }
  return ''
}
export function normalizeDoc(raw: DocDoc): DocDoc {
  const blocks = (Array.isArray(raw?.blocks) ? raw.blocks : [])
    .filter((b) => b && typeof b === 'object')
    .map((b) => {
      const t = String((b as { type?: unknown }).type || 'paragraph')
      if (t === 'bullets') {
        const it = (b as { items?: unknown }).items
        const items = Array.isArray(it) ? it.map(asText).filter(Boolean) : asText(it).split(/\n+/).filter(Boolean)
        return { type: 'bullets' as const, items }
      }
      if (t === 'table') {
        const cols = Array.isArray((b as { columns?: unknown }).columns) ? ((b as { columns: unknown[] }).columns).map(asText) : []
        const rawRows = Array.isArray((b as { rows?: unknown }).rows) ? ((b as { rows: unknown[] }).rows) : []
        const rows = rawRows.map((r) => (Array.isArray(r) ? r.map(asText) : r && typeof r === 'object' ? Object.values(r as object).map(asText) : [asText(r)]))
        return { type: 'table' as const, columns: cols, rows }
      }
      if (t === 'heading') {
        const lv = Number((b as { level?: unknown }).level)
        return { type: 'heading' as const, level: lv >= 1 && lv <= 4 ? lv : 2, text: asText((b as { text?: unknown }).text) }
      }
      if (t === 'chart') return b
      if (t === 'image') return { type: 'image' as const, src: asText((b as { src?: unknown }).src), caption: asText((b as { caption?: unknown }).caption) }
      return { type: 'paragraph' as const, text: asText((b as { text?: unknown }).text ?? b) }
    })
    .filter((b) => (b.type === 'bullets' ? (b.items || []).length : b.type === 'table' ? ((b as { columns?: string[] }).columns || []).length : b.type === 'chart' || b.type === 'image' ? true : ((b as { text?: string }).text || '').trim().length))
  return { ...raw, title: asText(raw?.title), subtitle: asText(raw?.subtitle), cover: asText(raw?.cover) || undefined, blocks: blocks as DocDoc['blocks'] }
}

function cleanName(t?: string): string {
  return (t || 'nalu-document').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-document'
}

// ---- Word (.docx) ----------------------------------------------------------
function buildDocx(doc: DocDoc, coverImg?: ArrayBuffer | null): Document {
  // On-brand if a Nalu Studio palette/brand is active, else Nalu defaults.
  const brand = getBrand()
  // Headings use the brand PRIMARY (deep, readable) — never the gold accent,
  // which is reserved for thin rules. Gold text on white is unreadable.
  const accent = brand?.primary || HEAD
  const rule = brand?.accent || RULE
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
        children: [new TextRun({ text: doc.title || 'Document', bold: true, size: 60, color: accent, font: brand?.headingFont || 'Georgia' })],
      }),
      ...(doc.subtitle
        ? [new Paragraph({ children: [new TextRun({ text: doc.subtitle, italics: true, size: 28, color: '666666' })] })]
        : []),
    )
  }
  const bodyFont = brand?.bodyFont || 'Calibri'
  // Elegant serif headings (Four Seasons / Hillpointe house style); clean sans body.
  const titleFont = brand?.headingFont || 'Georgia'
  const children: (Paragraph | Table)[] = []
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

  for (const b of doc.blocks || []) {
    if (b.type === 'heading') {
      const lvl = b.level === 3 ? HeadingLevel.HEADING_3 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1
      children.push(
        new Paragraph({
          heading: lvl,
          spacing: { before: 240, after: 120 },
          children: [new TextRun({ text: b.text || '', bold: true, color: accent, font: titleFont })],
        }),
      )
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ children: [new TextRun({ text: b.text || '', size: 22, font: bodyFont })], spacing: { after: 160 } }))
    } else if (b.type === 'bullets') {
      for (const it of b.items || []) {
        children.push(
          new Paragraph({ text: it, bullet: { level: 0 }, spacing: { after: 60 }, children: [] as TextRun[] }),
        )
      }
    } else if (b.type === 'table') {
      const cols = b.columns || []
      const head = new TableRow({
        tableHeader: true, // repeat the header row across page breaks
        children: cols.map(
          (c) =>
            new TableCell({
              shading: { fill: accent, color: 'auto', type: 'clear' as never } as never,
              children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, color: 'FFFFFF', font: bodyFont })] })],
            }),
        ),
      })
      const body = (b.rows || []).map(
        (r) =>
          new TableRow({
            children: cols.map(
              (_, ci) => new TableCell({ children: [new Paragraph({ text: String(r[ci] ?? '') })] }),
            ),
          }),
      )
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
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
        const w = 540
        const h = b.w && b.h ? Math.round((w * b.h) / b.w) : 360
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 160, after: b.caption ? 40 : 200 },
            children: [
              new ImageRun({
                type: docxImageType(b.src),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data: bytes as any,
                transformation: { width: w, height: h },
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
      default: { document: { run: { font: bodyFont } } },
    },
    sections: coverChildren.length
      ? [
          { properties: {}, children: coverChildren },
          { properties: {}, children },
        ]
      : [{ properties: {}, children }],
  })
}

/** Build the designed .docx as a Blob (shared with the Agents output nodes). */
export async function buildDocxBlob(doc: DocDoc, coverImg?: ArrayBuffer | null): Promise<Blob> {
  return Packer.toBlob(buildDocx(normalizeDoc(doc), coverImg))
}
/** Build the designed .pdf as a Blob (shared with the Agents output nodes). */
export async function buildPdfBlob(rawDoc: DocDoc): Promise<Blob> {
  const doc = normalizeDoc(rawDoc)
  const img = doc.cover ? await coverImageDataUrl(doc.cover) : null
  return buildPdf(doc, img).output('blob')
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
function buildPdf(doc: DocDoc, coverImg?: string | null): jsPDF {
  const brand = getBrand()
  const [ar, ag, ab] = toRgb(brand?.primary || HEAD)
  const [gr, gg, gb] = toRgb(brand?.accent || RULE)
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' })
  const margin = 56
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const maxW = pageW - margin * 2
  let y = margin

  const ensure = (need: number) => {
    if (y + need > pageH - margin) {
      pdf.addPage()
      y = margin
    }
  }

  // Cover page — full-bleed photo top, gold rule, serif title + subtitle.
  if (coverImg) {
    try {
      pdf.addImage(coverImg, 'JPEG', 0, 0, pageW, pageH * 0.52)
      pdf.setTextColor(ar, ag, ab)
      pdf.setFont('times', 'bold')
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
        pdf.setFont('times', 'italic')
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

  pdf.setTextColor(ar, ag, ab)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(22)
  for (const line of pdf.splitTextToSize(doc.title || 'Document', maxW)) {
    ensure(26)
    pdf.text(line, margin, y)
    y += 26
  }
  if (doc.subtitle) {
    pdf.setTextColor(120)
    pdf.setFont('helvetica', 'italic')
    pdf.setFontSize(12)
    for (const line of pdf.splitTextToSize(doc.subtitle, maxW)) {
      ensure(16)
      pdf.text(line, margin, y)
      y += 16
    }
  }
  y += 8

  for (const b of doc.blocks || []) {
    if (b.type === 'heading') {
      y += 8
      const size = b.level === 3 ? 12 : b.level === 2 ? 14 : 16
      pdf.setTextColor(ar, ag, ab)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(size)
      for (const line of pdf.splitTextToSize(b.text || '', maxW)) {
        ensure(size + 6)
        pdf.text(line, margin, y)
        y += size + 6
      }
      y += 2
    } else if (b.type === 'paragraph') {
      pdf.setTextColor(30)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(11)
      for (const line of pdf.splitTextToSize(b.text || '', maxW)) {
        ensure(15)
        pdf.text(line, margin, y)
        y += 15
      }
      y += 6
    } else if (b.type === 'bullets') {
      pdf.setTextColor(30)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(11)
      for (const it of b.items || []) {
        for (const [k, line] of pdf.splitTextToSize(it, maxW - 14).entries()) {
          ensure(15)
          pdf.text(k === 0 ? `•  ${line}` : `   ${line}`, margin + 4, y)
          y += 15
        }
      }
      y += 6
    } else if (b.type === 'table') {
      autoTable(pdf, {
        head: [b.columns || []],
        body: (b.rows || []).map((r) => r.map((c) => String(c ?? ''))),
        startY: y,
        margin: { left: margin, right: margin },
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [ar, ag, ab] },
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
      // Fit within the text column, capped so a tall screenshot doesn't dwarf the page.
      const cw = b.w && b.h ? Math.min(maxW, (maxW * 0.62 * b.w) / b.h) : maxW
      const ch = b.w && b.h ? (cw * b.h) / b.w : cw * 0.6
      ensure(ch + (b.caption ? 28 : 16))
      try {
        pdf.addImage(b.src, docxImageType(b.src) === 'png' ? 'PNG' : 'JPEG', margin, y, cw, ch)
      } catch {
        /* skip */
      }
      y += ch + 8
      if (b.caption) {
        pdf.setTextColor(110)
        pdf.setFont('helvetica', 'italic')
        pdf.setFontSize(9)
        for (const line of pdf.splitTextToSize(b.caption, maxW)) {
          ensure(12)
          pdf.text(line, margin, y)
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
  const data = normalizeDoc(rawData)
  const name = cleanName(data.title)
  const blocks = data.blocks || []
  const [busy, setBusy] = useState<'docx' | 'pdf' | null>(null)

  const downloadDocx = async () => {
    if (busy) return
    setBusy('docx')
    try {
      const img = data.cover ? await coverImageBuffer(data.cover) : null
      const blob = await Packer.toBlob(buildDocx(data, img))
      downloadBlob(blob, `${name}.docx`)
    } finally {
      setBusy(null)
    }
  }
  const downloadPdf = async () => {
    if (busy) return
    setBusy('pdf')
    try {
      const img = data.cover ? await coverImageDataUrl(data.cover) : null
      buildPdf(data, img).save(`${name}.pdf`)
    } finally {
      setBusy(null)
    }
  }

  // The FULL document renders in the chat — every section, real tables, real
  // charts — in a flat, minimal frame. Styled LIVE by the active Brand Kit
  // (colors + fonts from the Brand bar editor), matching the exported Word/PDF.
  const liveBrand = useBrand()
  const bPrimary = '#' + (liveBrand?.primary || '14345A')
  const bAccent = '#' + (liveBrand?.accent || 'AF8C56')
  const headFont = `'${liveBrand?.headingFont || 'Playfair Display'}', Georgia, serif`
  const bodyFont = liveBrand?.bodyFont ? `'${liveBrand.bodyFont}', Calibri, system-ui, sans-serif` : undefined
  const bText = '#' + (liveBrand?.text || '2a2a2a')
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
      <div className="max-h-[78vh] overflow-y-auto bg-[#F7F5F1] px-8 py-7 text-[13.5px] leading-relaxed" style={{ color: bText, fontFamily: bodyFont }}>
        <div style={{ fontFamily: headFont, color: bPrimary }} className="text-[24px] font-semibold leading-tight">
          {data.title || 'Document'}
        </div>
        {data.subtitle && <div className="mt-1 italic text-[#8a8175]">{data.subtitle}</div>}
        <div className="mb-5 mt-3 h-px w-16" style={{ backgroundColor: bAccent }} />
        {blocks.map((b, i) => {
          if (b.type === 'heading')
            return (
              <div
                key={i}
                style={{ fontFamily: headFont, color: bPrimary }}
                className={`mt-5 font-semibold ${b.level === 1 ? 'text-[18px]' : b.level === 3 ? 'text-[14px]' : 'text-[16px]'}`}
              >
                {b.text}
              </div>
            )
          if (b.type === 'paragraph') return <p key={i} className="mt-2">{b.text}</p>
          if (b.type === 'bullets')
            return (
              <ul key={i} className="mt-2 space-y-1 pl-1">
                {(b.items || []).map((it, j) => (
                  <li key={j} className="flex gap-2.5">
                    <span style={{ color: bAccent }}>—</span>
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
            )
          if (b.type === 'chart' && hasChartData(b.chart)) {
            const url = chartDataUrl(b.chart!, 900, 480)
            return url ? <img key={i} src={url} alt={b.chart?.title || 'chart'} className="my-4 w-full max-w-2xl bg-white" /> : null
          }
          if (b.type === 'table')
            return (
              <div key={i} className="my-3 overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      {(b.columns || []).map((c, j) => (
                        <th key={j} className="border-b-2 bg-transparent px-2.5 py-1.5 text-left font-semibold" style={{ borderColor: bPrimary, color: bPrimary }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(b.rows || []).map((r, ri) => (
                      <tr key={ri} className={ri % 2 ? 'bg-black/[0.025]' : ''}>
                        {(b.columns || []).map((_, ci) => (
                          <td key={ci} className="border-b border-black/10 px-2.5 py-1.5 align-top">{String(r[ci] ?? '')}</td>
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
