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
import { getBrand, toRgb } from './brandKit'
import { coverImageDataUrl, coverImageBuffer } from './coverImage'
import { chartDataUrl, hasChartData, type ChartSpec } from './chartRender'

export type DocBlock =
  | { type: 'heading'; level?: number; text?: string }
  | { type: 'paragraph'; text?: string }
  | { type: 'bullets'; items?: string[] }
  | { type: 'table'; columns?: string[]; rows?: string[][] }
  | { type: 'chart'; chart?: ChartSpec }

export type DocDoc = {
  title?: string
  subtitle?: string
  cover?: string
  blocks?: DocBlock[]
}

const HEAD = '0F1B2D' // Nalu midnight navy — readable heading color (luxury baseline)
const RULE = 'AF8C56' // muted gold — hairlines / small accents only

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
        children: [new TextRun({ text: doc.title || 'Document', bold: true, size: 60, color: accent, font: brand?.headingFont || 'Calibri' })],
      }),
      ...(doc.subtitle
        ? [new Paragraph({ children: [new TextRun({ text: doc.subtitle, italics: true, size: 28, color: '666666' })] })]
        : []),
    )
  }
  const bodyFont = brand?.bodyFont || 'Calibri'
  const titleFont = brand?.headingFont || brand?.bodyFont || 'Calibri'
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
    }
  }
  return pdf
}

export default function DocCard({ data }: { data: DocDoc }) {
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

  const preview = blocks.slice(0, 6)

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-white/[0.16] bg-white/[0.04]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.12] px-4 py-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/15 text-blue-300">
          <FileText size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[#ededed]">{data.title || 'Document'}</div>
          <div className="text-xs text-[#8e8e8e]">{blocks.length} sections · Word &amp; PDF ready</div>
        </div>
        <button
          onClick={() => void downloadDocx()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg bg-blue-500/20 px-2.5 py-1.5 text-xs font-medium text-blue-200 hover:bg-blue-500/30 disabled:opacity-50"
        >
          {busy === 'docx' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{' '}
          {busy === 'docx' ? 'Designing…' : 'Word'}
        </button>
        <button
          onClick={() => void downloadPdf()}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs font-medium text-[#ededed] hover:bg-white/[0.12] disabled:opacity-50"
        >
          {busy === 'pdf' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{' '}
          {busy === 'pdf' ? 'Designing…' : 'PDF'}
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed text-[#cfcfcf]">
        {data.subtitle && <div className="mb-2 italic text-[#9a9a9a]">{data.subtitle}</div>}
        {preview.map((b, i) => {
          if (b.type === 'heading')
            return (
              <div key={i} className="mt-2 font-semibold text-[#ededed]">
                {b.text}
              </div>
            )
          if (b.type === 'paragraph')
            return (
              <p key={i} className="mt-1 line-clamp-3">
                {b.text}
              </p>
            )
          if (b.type === 'bullets')
            return (
              <ul key={i} className="mt-1 list-inside list-disc">
                {(b.items || []).slice(0, 4).map((it, j) => (
                  <li key={j} className="truncate">
                    {it}
                  </li>
                ))}
              </ul>
            )
          if (b.type === 'chart' && hasChartData(b.chart)) {
            const url = chartDataUrl(b.chart!, 760, 420)
            return url ? (
              <img key={i} src={url} alt="chart" className="my-2 w-full max-w-md rounded-md border border-white/10 bg-white" />
            ) : null
          }
          if (b.type === 'table')
            return (
              <div key={i} className="mt-1 text-[#8e8e8e]">
                [table: {(b.columns || []).join(', ')}]
              </div>
            )
          return null
        })}
        {blocks.length > preview.length && (
          <div className="mt-2 text-xs text-[#8e8e8e]">
            +{blocks.length - preview.length} more sections — download for the full document
          </div>
        )}
      </div>
    </div>
  )
}
