import { useState } from 'react'
import pptxgen from 'pptxgenjs'
import { jsPDF } from 'jspdf'
import { getBrand, toRgb } from './brandKit'
import { coverImageDataUrl, coverImageUrl } from './coverImage'
import { chartDataUrl, hasChartData, type ChartSpec } from './chartRender'

export type Slide = { title?: string; bullets?: string[]; notes?: string; image?: string; chart?: ChartSpec }
export type Deck = { title?: string; subtitle?: string; cover?: string; slides?: Slide[] }

const PAPER = 'F7F5F0' // warm linen for content slides (quiet-luxury baseline)

function cleanName(t?: string): string {
  return (t || 'nalu-deck').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-deck'
}

// Quiet-luxury deck palette (Four Seasons / Hillpointe) — from the active brand,
// with refined defaults. Headings use an elegant serif that's installed in
// PowerPoint everywhere (Georgia) unless the brand sets its own.
function deckStyle() {
  const b = getBrand()
  return {
    navy: b?.primary || '0F1B2D',
    dark: b?.dark || '0F1B2D',
    gold: b?.accent || 'AF8C56',
    ink: b?.text || '2A2A2A',
    onDark: b?.onDark || 'FFFFFF',
    subtle: b?.subtle || 'C9B891',
    paper: PAPER,
    head: b?.headingFont || 'Georgia',
    body: b?.bodyFont || 'Calibri',
    label: (b?.name || 'Nalu').toUpperCase(),
  }
}

// Fetch the cover + per-slide photos (no key) in parallel, robustly. Returns a
// map index→dataURL ('cover' for the title slide). Missing/failed images are
// simply absent, so the deck still renders on a solid brand color.
async function fetchDeckPhotos(data: Deck, slides: Slide[]): Promise<Record<string, string>> {
  const jobs: Promise<void>[] = []
  const out: Record<string, string> = {}
  if (data.cover && data.cover.trim())
    jobs.push(coverImageDataUrl(data.cover, 1600, 900).then((u) => { if (u) out.cover = u }))
  slides.forEach((sl, i) => {
    if (sl.image && sl.image.trim())
      jobs.push(coverImageDataUrl(sl.image, 1100, 1300).then((u) => { if (u) out[String(i)] = u }))
  })
  await Promise.all(jobs)
  return out
}

/** Build the branded .pptx as a Blob (shared with the Agents output nodes). */
export async function buildPptxBlob(data: Deck): Promise<{ blob: Blob; filename: string }> {
  const slides = data.slides && data.slides.length ? data.slides : []
  const name = cleanName(data.title)
  const s = deckStyle()
  let photos: Record<string, string> = {}
  try {
    photos = await fetchDeckPhotos(data, slides)
  } catch {
    /* no photos — fall back to solid covers */
  }
  const pptx = new pptxgen()
    pptx.layout = 'LAYOUT_WIDE' // 13.333 x 7.5 in
    const W = 13.333
    const H = 7.5
    const num = (i: number) => String(i + 1).padStart(2, '0')

    // Cover — full-bleed photo (if any) under a navy scrim, gold eyebrow,
    // elegant serif title, gold rule.
    const t0 = pptx.addSlide()
    t0.background = { color: s.dark }
    if (photos.cover) {
      t0.addImage({ data: photos.cover, x: 0, y: 0, w: W, h: H, sizing: { type: 'cover', w: W, h: H } })
      // Lighter scrim so the photo's colors come through; a darker band only
      // behind the title text for legibility.
      t0.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: s.dark, transparency: 52 } })
      t0.addShape(pptx.ShapeType.rect, { x: 0, y: 2.1, w: W, h: 2.7, fill: { color: s.dark, transparency: 30 } })
    }
    t0.addText(s.label, {
      x: 0.9, y: 2.35, w: 11, h: 0.4, fontSize: 12, color: s.gold, fontFace: s.body, charSpacing: 6, bold: true,
    })
    t0.addText(data.title || 'Presentation', {
      x: 0.88, y: 2.75, w: 11.5, h: 1.6, fontSize: 46, color: 'FFFFFF', fontFace: s.head, italic: false, fit: 'shrink',
    })
    t0.addShape(pptx.ShapeType.line, { x: 0.95, y: 4.5, w: 2.2, h: 0, line: { color: s.gold, width: 1.5 } })
    if (data.subtitle)
      t0.addText(data.subtitle, {
        x: 0.9, y: 4.7, w: 10.5, h: 0.9, fontSize: 18, color: s.subtle, fontFace: s.head, italic: true,
      })
    t0.addText('n4lu.ai', { x: 0.9, y: 6.7, w: 4, h: 0.3, fontSize: 11, color: s.subtle, fontFace: s.body, charSpacing: 3 })

    // Content slides — linen, gold slide-number, serif navy heading, gold rule,
    // gold-dash bullets, hairline footer. With a photo → bullets left, photo right.
    const chartType = (t?: string) =>
      t === 'line' ? pptx.ChartType.line : t === 'pie' ? pptx.ChartType.pie : pptx.ChartType.bar
    slides.forEach((sl, i) => {
      const slide = pptx.addSlide()
      slide.background = { color: s.paper }
      // A data slide's CHART wins over a decorative photo (charts were vanishing
      // when the model added an image to a chart slide). Photo only when no chart.
      const chart = hasChartData(sl.chart) ? sl.chart! : null
      const img = chart ? undefined : photos[String(i)]
      const textW = img ? 6.7 : chart ? 5.7 : 11.4
      if (img) {
        // full-height photo band on the right
        slide.addImage({ data: img, x: 8.0, y: 0, w: 5.333, h: H, sizing: { type: 'cover', w: 5.333, h: H } })
      }
      slide.addText(num(i), {
        x: 0.9, y: 0.55, w: 2, h: 0.4, fontSize: 13, color: s.gold, fontFace: s.body, charSpacing: 4, bold: true,
      })
      slide.addText(sl.title || '', {
        x: 0.88, y: 0.95, w: img ? textW : 11.4, h: 1.0, fontSize: 30, color: s.navy, fontFace: s.head,
        fit: 'shrink', // message-titles are full sentences — shrink instead of clipping
      })
      slide.addShape(pptx.ShapeType.line, { x: 0.95, y: 1.95, w: 1.6, h: 0, line: { color: s.gold, width: 1.5 } })
      const runs: { text: string; options: Record<string, unknown> }[] = []
      ;(sl.bullets || []).forEach((b) => {
        runs.push({ text: '—   ', options: { color: s.gold, fontFace: s.head, bold: true } })
        runs.push({ text: b, options: { color: s.ink, fontFace: s.body, breakLine: true } })
      })
      if (runs.length)
        slide.addText(runs as unknown as Parameters<typeof slide.addText>[0], {
          x: 0.95, y: 2.3, w: textW, h: 4.2, fontSize: 17, lineSpacingMultiple: 1.5, valign: 'top', paraSpaceAfter: 10,
        })
      if (chart) {
        // Native, editable PowerPoint chart on the right.
        const cdata = (chart.series || []).map((se) => ({
          name: se.name || 'Series',
          labels: chart.labels || [],
          values: se.values || [],
        }))
        slide.addChart(chartType(chart.type), cdata, {
          x: 6.7, y: 2.2, w: 6.0, h: 4.3,
          chartColors: ['0F1B2D', 'AF8C56', '1B3A53', '8A9EA7', 'C9B891', '5A6B7A'],
          showLegend: (chart.series || []).length > 1,
          legendPos: 'b',
          showTitle: !!chart.title,
          title: chart.title || '',
          titleColor: '0F1B2D',
          titleFontFace: s.head,
          titleFontSize: 13,
          showValue: chart.type === 'pie',
          showPercent: chart.type === 'pie',
          dataLabelColor: chart.type === 'pie' ? 'FFFFFF' : '2A2A2A',
          catAxisLabelColor: '6E6E6E',
          valAxisLabelColor: '6E6E6E',
        })
      }
      // footer — kept within the text column when a photo/chart occupies the right
      const footW = img ? 6.7 : chart ? 5.7 : W - 1.8
      slide.addShape(pptx.ShapeType.line, { x: 0.9, y: 6.95, w: footW, h: 0, line: { color: 'D9D3C7', width: 0.75 } })
      slide.addText(s.label, { x: 0.9, y: 7.0, w: 4, h: 0.3, fontSize: 9, color: '9A8E78', fontFace: s.body, charSpacing: 3 })
      slide.addText(num(i), { x: 0.9 + footW - 1, y: 7.0, w: 1, h: 0.3, fontSize: 9, color: '9A8E78', fontFace: s.body, align: 'right' })
      if (sl.notes) slide.addNotes(sl.notes)
    })
  const blob = (await pptx.write({ outputType: 'blob' })) as Blob
  return { blob, filename: `${name}.pptx` }
}

export default function SlidesCard({ data }: { data: Deck }) {
  // harden against imperfect model JSON: bullets must be an array of strings
  const slides = (Array.isArray(data.slides) ? data.slides : [])
    .filter((sl) => sl && typeof sl === 'object')
    .map((sl) => ({
      ...sl,
      title: typeof sl.title === 'string' ? sl.title : String(sl.title ?? ''),
      bullets: Array.isArray(sl.bullets) ? sl.bullets.map((b) => (typeof b === 'string' ? b : String(b ?? ''))) : typeof sl.bullets === 'string' ? [sl.bullets] : [],
    }))
  const name = cleanName(data.title)
  const [busy, setBusy] = useState<'pptx' | 'pdf' | null>(null)
  const s = deckStyle()

  // ---- PowerPoint (.pptx) --------------------------------------------------
  const downloadPptx = async () => {
    if (busy) return
    setBusy('pptx')
    try {
      const { blob, filename } = await buildPptxBlob(data)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
    } finally {
      setBusy(null)
    }
  }
  // photos for the export are fetched inside buildPptxBlob; the PDF path below
  // still fetches its own set.
  const fetchPhotos = () => fetchDeckPhotos(data, slides)

  // ---- PDF -----------------------------------------------------------------
  const downloadPdf = async () => {
    if (busy) return
    setBusy('pdf')
    let photos: Record<string, string> = {}
    try {
      photos = await fetchPhotos()
    } catch {
      /* no photos */
    }
    const navy = toRgb(s.navy)
    const gold = toRgb(s.gold)
    const ink = toRgb(s.ink)
    const onDark = toRgb(s.onDark)
    const subtle = toRgb(s.subtle)
    const dark = toRgb(s.dark)
    const paper = toRgb(s.paper)
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' })
    const W = pdf.internal.pageSize.getWidth()
    const H = pdf.internal.pageSize.getHeight()
    const M = 54
    const num = (i: number) => String(i + 1).padStart(2, '0')

    // Cover — full-bleed photo (if any) under a navy scrim
    pdf.setFillColor(dark[0], dark[1], dark[2])
    pdf.rect(0, 0, W, H, 'F')
    if (photos.cover) {
      try {
        pdf.addImage(photos.cover, 'JPEG', 0, 0, W, H)
        pdf.setFillColor(dark[0], dark[1], dark[2])
        pdf.setGState(pdf.GState({ opacity: 0.4 }))
        pdf.rect(0, 0, W, H, 'F')
        pdf.setGState(pdf.GState({ opacity: 1 }))
      } catch {
        /* keep solid cover */
      }
    }
    pdf.setTextColor(gold[0], gold[1], gold[2])
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(11)
    pdf.text(s.label.split('').join(' '), M, H / 2 - 54)
    pdf.setTextColor(onDark[0], onDark[1], onDark[2])
    pdf.setFont('times', 'normal')
    pdf.setFontSize(38)
    pdf.text(pdf.splitTextToSize(data.title || 'Presentation', W - M * 2), M, H / 2 - 8)
    pdf.setDrawColor(gold[0], gold[1], gold[2])
    pdf.setLineWidth(1.5)
    pdf.line(M, H / 2 + 14, M + 120, H / 2 + 14)
    if (data.subtitle) {
      pdf.setTextColor(subtle[0], subtle[1], subtle[2])
      pdf.setFont('times', 'italic')
      pdf.setFontSize(16)
      pdf.text(pdf.splitTextToSize(data.subtitle, W - M * 2), M, H / 2 + 40)
    }

    slides.forEach((sl, i) => {
      pdf.addPage()
      pdf.setFillColor(paper[0], paper[1], paper[2])
      pdf.rect(0, 0, W, H, 'F')
      const img = photos[String(i)]
      const chart = !img && hasChartData(sl.chart) ? sl.chart! : null
      const textR = img ? W * 0.6 : chart ? W * 0.5 : W - M
      if (img) {
        try {
          pdf.addImage(img, 'JPEG', W * 0.62, 0, W * 0.38, H)
        } catch {
          /* skip */
        }
      } else if (chart) {
        const url = chartDataUrl(chart, 1100, 760, { paper: '#F7F5F0' })
        if (url) {
          try {
            pdf.addImage(url, 'PNG', W * 0.52, H * 0.22, W * 0.43, H * 0.56)
          } catch {
            /* skip */
          }
        }
      }
      // slide number
      pdf.setTextColor(gold[0], gold[1], gold[2])
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(12)
      pdf.text(num(i), M, 60)
      // heading (serif)
      pdf.setTextColor(navy[0], navy[1], navy[2])
      pdf.setFont('times', 'normal')
      pdf.setFontSize(26)
      let y = 92
      for (const line of pdf.splitTextToSize(sl.title || '', textR - M)) {
        pdf.text(line, M, y)
        y += 32
      }
      // gold rule
      pdf.setDrawColor(gold[0], gold[1], gold[2])
      pdf.setLineWidth(1.5)
      pdf.line(M, y - 8, M + 90, y - 8)
      y += 22
      // bullets — gold dash + ink text. Guard against overrunning the footer:
      // stop once the next bullet wouldn't fit above the footer rule.
      pdf.setFontSize(14)
      const bulletFloor = H - 58
      for (const b of sl.bullets || []) {
        const lines = pdf.splitTextToSize(b, textR - M - 26)
        if (y + lines.length * 20 > bulletFloor) break // out of room — don't draw past the footer
        pdf.setTextColor(gold[0], gold[1], gold[2])
        pdf.setFont('times', 'bold')
        pdf.text('—', M, y)
        pdf.setTextColor(ink[0], ink[1], ink[2])
        pdf.setFont('helvetica', 'normal')
        lines.forEach((line: string, k: number) => {
          pdf.text(line, M + 26, y + k * 20)
        })
        y += lines.length * 20 + 12
      }
      // footer
      pdf.setDrawColor(217, 211, 199)
      pdf.setLineWidth(0.75)
      pdf.line(M, H - 44, textR, H - 44)
      pdf.setTextColor(154, 142, 120)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(9)
      pdf.text(s.label.split('').join(' '), M, H - 30)
      pdf.text(num(i), textR, H - 30, { align: 'right' })
    })
    try {
      pdf.save(`${name}.pdf`)
    } finally {
      setBusy(null)
    }
  }

  const gold = '#' + s.gold
  const navy = '#' + s.navy

  // The FULL deck renders in the chat — every slide, photos and charts —
  // in a flat minimal frame that matches the export styling.
  return (
    <div className="my-4 border-y border-glass/[0.12]">
      <div className="flex items-baseline gap-3 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">PowerPoint</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {data.title || 'Presentation'}
          <span className="ml-2 text-xs font-normal text-dim">{slides.length} slides</span>
        </span>
        <button onClick={() => void downloadPptx()} disabled={busy !== null}
          className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">
          {busy === 'pptx' ? 'Designing…' : 'PowerPoint'}
        </button>
        <span className="text-xs text-dim">·</span>
        <button onClick={() => void downloadPdf()} disabled={busy !== null}
          className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">
          {busy === 'pdf' ? 'Designing…' : 'PDF'}
        </button>
      </div>

      {/* every slide, stacked — the whole deck is visible right here */}
      <div className="max-h-[78vh] space-y-4 overflow-y-auto py-3">
        <div className="mx-auto flex aspect-[16/9] w-full max-w-2xl flex-col justify-center p-8" style={{ backgroundColor: '#' + s.dark }}>
          <div className="text-[10px] font-bold uppercase" style={{ color: gold, letterSpacing: '0.3em' }}>{s.label}</div>
          <div className="mt-2 text-3xl leading-tight text-white" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>{data.title || 'Presentation'}</div>
          <div className="mt-3 h-px w-16" style={{ backgroundColor: gold }} />
          {data.subtitle && <div className="mt-3 text-sm italic" style={{ color: '#C9B891' }}>{data.subtitle}</div>}
        </div>
        {slides.map((sl, i) => (
          <div key={i} className="mx-auto flex aspect-[16/9] w-full max-w-2xl flex-col p-7" style={{ backgroundColor: '#' + PAPER }}>
            <div className="mb-1 text-[11px] font-semibold uppercase" style={{ color: gold, letterSpacing: '0.18em' }}>{String(i + 1).padStart(2, '0')}</div>
            <div className="mb-2 text-2xl leading-tight" style={{ color: navy, fontFamily: 'Georgia, "Times New Roman", serif' }}>{sl.title || `Slide ${i + 1}`}</div>
            <div className="mb-3 h-px w-12" style={{ backgroundColor: gold }} />
            {hasChartData(sl.chart) ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                <img src={chartDataUrl(sl.chart!, 900, 560, { paper: '#F7F5F0' }) || ''} alt="chart" className="max-h-full max-w-full object-contain" />
              </div>
            ) : sl.image && sl.image.trim() ? (
              <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
                <ul className="min-w-0 flex-1 space-y-2 overflow-hidden">
                  {(sl.bullets || []).map((b, j) => (
                    <li key={j} className="flex gap-2.5 text-sm" style={{ color: '#2A2A2A' }}>
                      <span style={{ color: gold }}>—</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <img src={coverImageUrl(sl.image, 550, 650)} alt="" loading="lazy"
                  className="h-full w-[38%] shrink-0 object-cover" style={{ backgroundColor: '#E4DED2' }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
              </div>
            ) : (
              <ul className="space-y-2 overflow-hidden">
                {(sl.bullets || []).map((b, j) => (
                  <li key={j} className="flex gap-2.5 text-sm" style={{ color: '#2A2A2A' }}>
                    <span style={{ color: gold }}>—</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto flex items-center justify-between pt-3 text-[9px] uppercase" style={{ color: '#9A8E78', letterSpacing: '0.15em', borderTop: '1px solid #E4DED2' }}>
              <span>{s.label}</span>
              <span>{String(i + 1).padStart(2, '0')}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
