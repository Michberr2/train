import { useMemo, useRef, useState } from 'react'
import { FileSpreadsheet, Download } from 'lucide-react'
import { useBrand, toRgb, type BrandKit } from './brandKit'
import { rasterizeLogo, type RasterLogo } from './logoRaster'
import { buildEvaluator, type Cell } from './formulaEval'
import { normalizeWorkbook, type SheetDoc } from './sheetModel'

export type { SheetData, SheetDoc } from './sheetModel'

// Infer a sensible number format from a column header (currency / percent / count)
// so exports look like a finished model, not raw data — and provide a matching
// on-screen display formatter for computed values.
function colFormat(header: string): { numFmt?: string; display: (v: Cell) => string } {
  const h = (header || '').toLowerCase()
  const isPct = /%|margin|\brate\b|growth|share\b|yield|roi|cagr|conversion|churn|utilization/.test(h)
  const isMoney = /\$|revenue|cost|price|cash|amount|balance|sales|profit|income|expense|budget|valuation|salary|wage|fee|payment|spend|value\b/.test(h)
  const isCount = /\bqty\b|quantity|units|count|#|year|month|age|headcount|employees/.test(h)
  if (isPct) return { numFmt: '0.0%', display: (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : String(v ?? '')) }
  if (isMoney) return { numFmt: '$#,##0.00;[Red]-$#,##0.00', display: (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }) : String(v ?? '')) }
  if (isCount) return { numFmt: '#,##0', display: (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(v ?? '')) }
  return { display: (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? '')) }
}

// Build a real .xlsx workbook with exceljs — live formulas WITH their computed
// result (so Numbers/Sheets/preview show values before recalc), per-column number
// formatting, and the active brand applied. Lazy-imported.
/** Build the styled .xlsx as a Blob (shared with the Agents output nodes). */
export async function buildWorkbookBlob(doc: SheetDoc, brand: BrandKit | null): Promise<Blob> {
  doc = normalizeWorkbook(doc)
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.calcProperties.fullCalcOnLoad = true
  // Brand logo → floating image top-right of the first sheet. Floating (not a cell
  // value) so it never shifts rows or breaks the formula references.
  let logo: RasterLogo | null = null
  const logoSrc = brand?.logo || brand?.logoMark
  if (logoSrc) {
    try { logo = await rasterizeLogo(logoSrc, { height: 96, bgDark: false }) } catch { /* optional */ }
  }
  const headArgb = 'FF' + (brand?.primary || '0F1B2D')
  const headFont = brand?.headingFont || 'Georgia'
  const bodyFont = brand?.bodyFont || 'Calibri'
  const sheets = doc.sheets && doc.sheets.length ? doc.sheets : [{ name: 'Sheet1', columns: [], rows: [] }]
  // Never let a bad formula crash the export — fall back to the raw cell value.
  const ev = (() => { try { return buildEvaluator(sheets) } catch { return { value: (): Cell => '' } } })()
  const evVal = (si: number, ri: number, ci: number): Cell => { try { return ev.value(si, ri, ci) as Cell } catch { return '' } }
  sheets.forEach((s, si) => {
    const ws = wb.addWorksheet(s.name || `Sheet${si + 1}`)
    const cols = s.columns || []
    const fmts = cols.map((c) => colFormat(c))
    if (cols.length) {
      const hr = ws.addRow(cols)
      hr.height = 18
      hr.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headArgb } }
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: headFont, size: 11 }
        cell.alignment = { vertical: 'middle' }
      })
    }
    ;(s.rows || []).forEach((r, ri) => {
      const row = ws.addRow(
        r.map((c, ci) => {
          if (typeof c === 'string' && c.startsWith('=')) {
            const result = evVal(si, ri, ci)
            return (typeof result === 'number' || typeof result === 'string') && result !== c ? { formula: c.slice(1), result } : { formula: c.slice(1) }
          }
          return c
        }),
      )
      row.eachCell((cell, cn) => {
        cell.font = { name: bodyFont, size: 10 }
        const nf = fmts[cn - 1]?.numFmt
        if (nf && (typeof cell.value === 'number' || (cell.value && typeof cell.value === 'object'))) cell.numFmt = nf
      })
    })
    cols.forEach((_, c) => {
      const width = (s.rows || []).reduce((max, row) => Math.max(max, Math.min(40, String(row[c] ?? '').length)), Math.max(10, String(cols[c] || '').length))
      ws.getColumn(c + 1).width = Math.min(42, width + 2)
    })
    if (cols.length) ws.views = [{ state: 'frozen', ySplit: 1 }]
    // Logo floats over empty space just past the last column of the FIRST sheet.
    if (logo && si === 0) {
      try {
        const imgId = wb.addImage({ base64: logo.base64, extension: 'png' })
        const dispH = 34
        const dispW = Math.round((dispH * logo.w) / logo.h)
        const anchorCol = Math.max(cols.length, 1) + 0.3
        ws.addImage(imgId, { tl: { col: anchorCol, row: 0.15 }, ext: { width: dispW, height: dispH }, editAs: 'oneCell' })
      } catch {
        /* logo optional */
      }
    }
  })
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

async function downloadWorkbook(doc: SheetDoc, fileName: string, brand: BrandKit | null): Promise<void> {
  const blob = await buildWorkbookBlob(doc, brand)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

export default function SheetCard({ data }: { data: SheetDoc }) {
  const normalized = useMemo(() => normalizeWorkbook(data), [data])
  const sheets = normalized.sheets!
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null)
  const [error, setError] = useState('')
  const exportLock = useRef(false)
  const sheet = sheets[Math.min(active, sheets.length - 1)]
  const title = (normalized.title || 'nalu-spreadsheet').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-spreadsheet'
  const brand = useBrand()
  const headBg = '#' + (brand?.primary || '0F1B2D')

  // Evaluate formulas so the preview + PDF show real values, not "=SUM(...)".
  // NEVER let a bad/recursive formula crash the whole card — fall back to the raw
  // cell so the spreadsheet ALWAYS renders.
  const ev = useMemo(() => {
    try { return buildEvaluator(sheets) }
    catch { return { value: (si: number, ri: number, ci: number): Cell => (sheets[si]?.rows?.[ri]?.[ci] ?? '') as Cell } }
  }, [sheets])
  const cellValue = (si: number, ri: number, ci: number): Cell => {
    try { return ev.value(si, ri, ci) as Cell } catch { return (sheets[si]?.rows?.[ri]?.[ci] ?? '') as Cell }
  }
  const fmts = useMemo(() => (sheet?.columns || []).map((c) => colFormat(c)), [sheet])

  const runExport = async (kind: 'xlsx' | 'pdf', work: () => Promise<void>) => {
    if (exportLock.current) return
    exportLock.current = true
    setBusy(kind)
    setError('')
    try { await work() }
    catch (e) { setError(`Export failed: ${e instanceof Error ? e.message : 'Please try again.'}`) }
    finally { exportLock.current = false; setBusy(null) }
  }

  const downloadXlsx = () => runExport('xlsx', () => downloadWorkbook(normalized, `${title}.xlsx`, brand))

  const downloadPdf = () => runExport('pdf', async () => {
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
      const [hr, hg, hb] = toRgb(brand?.primary || '0F1B2D')
      const [ar, ag, ab] = toRgb(brand?.accent || 'AF8C56')
      const pdf = new jsPDF({ orientation: 'landscape' })
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      sheets.forEach((s, si) => {
        if (si > 0) pdf.addPage()
        const sf = (s.columns || []).map((c) => colFormat(c))
        pdf.setFontSize(13)
        pdf.setTextColor(ar, ag, ab)
        pdf.text(`${title}${s.name ? ` — ${s.name}` : ''}`, 14, 15)
        pdf.setTextColor(0, 0, 0)
        autoTable(pdf, {
          head: [s.columns || []],
          body: (s.rows || []).map((r, ri) => r.map((_, ci) => { try { return (sf[ci] || { display: (x: Cell) => String(x ?? '') }).display(cellValue(si, ri, ci)) } catch { return String(r[ci] ?? '') } })),
          startY: 20,
          margin: { bottom: 16 },
          styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
          headStyles: { fillColor: [hr, hg, hb] },
          didDrawPage: () => {
            const n = pdf.getNumberOfPages()
            pdf.setFontSize(8)
            pdf.setTextColor(150)
            pdf.text(`${title} · page ${n}`, pageW / 2, pageH - 8, { align: 'center' })
            pdf.setTextColor(0)
          },
        })
      })
      pdf.save(`${title}.pdf`)
  })

  // The FULL workbook renders in the chat — every tab, every row, formulas
  // evaluated — in a flat minimal frame (hairlines, quiet meta row).
  return (
    <div className="my-4 border-y border-glass/[0.12]">
      <div className="flex items-baseline gap-3 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">Spreadsheet</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {title}
          <span className="ml-2 text-xs font-normal text-dim">
            {sheets.length} tab{sheets.length === 1 ? '' : 's'}{sheet?.rows ? ` · ${sheet.rows.length} rows` : ''}
          </span>
        </span>
        <button onClick={() => void downloadXlsx()} disabled={busy !== null} className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">{busy === 'xlsx' ? 'Exporting…' : 'Excel'}</button>
        <span className="text-xs text-dim">·</span>
        <button onClick={() => void downloadPdf()} disabled={busy !== null} className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">{busy === 'pdf' ? 'Exporting…' : 'PDF'}</button>
      </div>
      {error && <p role="alert" className="px-1 pb-2 text-xs text-red-400">{error}</p>}

      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-3 border-b border-glass/[0.08] px-1 pb-1.5">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`border-b-2 pb-0.5 text-[11.5px] transition-colors ${
                i === Math.min(active, sheets.length - 1) ? 'border-accent text-gold' : 'border-transparent text-dim hover:text-ink'
              }`}
            >
              {s.name || `Sheet ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      {sheet && (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0">
              <tr>
                {(sheet.columns || []).map((c, i) => (
                  <th
                    key={i}
                    className="border-b border-glass/[0.12] px-3 py-1.5 text-left font-semibold text-white"
                    style={{ backgroundColor: headBg }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(sheet.rows || []).map((r, ri) => (
                <tr key={ri}>
                  {(sheet.columns || []).map((_, ci) => {
                    const v = cellValue(Math.min(active, sheets.length - 1), ri, ci)
                    const isFormula = typeof r[ci] === 'string' && (r[ci] as string).startsWith('=')
                    return (
                      <td
                        key={ci}
                        className="border-b border-glass/[0.06] px-3 py-1.5 text-ink"
                        title={isFormula ? String(r[ci]) : undefined}
                      >
                        {fmts[ci] ? fmts[ci].display(v) : String(v ?? '')}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
