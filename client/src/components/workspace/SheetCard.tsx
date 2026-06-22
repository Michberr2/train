import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { FileSpreadsheet, Download } from 'lucide-react'
import { getBrand, toRgb, type BrandKit } from './brandKit'

export type SheetData = {
  name?: string
  columns?: string[]
  rows?: (string | number)[][]
}
export type SheetDoc = {
  title?: string
  sheets?: SheetData[]
}

// Build a real .xlsx workbook with exceljs — live formulas ("=..." strings),
// PLUS the active brand applied (header fill = brand primary, brand heading/body
// fonts) so the Excel file matches the design on screen. Lazy-imported so it
// only loads when the user downloads.
async function downloadWorkbook(doc: SheetDoc, fileName: string, brand: BrandKit | null): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const headArgb = 'FF' + (brand?.primary || '0F1B2D')
  const headFont = brand?.headingFont || 'Calibri'
  const bodyFont = brand?.bodyFont || 'Calibri'
  const sheets = doc.sheets && doc.sheets.length ? doc.sheets : [{ name: 'Sheet1', columns: [], rows: [] }]
  sheets.forEach((s, i) => {
    const ws = wb.addWorksheet((s.name || `Sheet${i + 1}`).slice(0, 31))
    const cols = s.columns || []
    if (cols.length) {
      const hr = ws.addRow(cols)
      hr.height = 18
      hr.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headArgb } }
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: headFont, size: 11 }
        cell.alignment = { vertical: 'middle' }
      })
    }
    for (const r of s.rows || []) {
      const row = ws.addRow(
        r.map((c) => (typeof c === 'string' && c.startsWith('=') ? { formula: c.slice(1) } : c)),
      )
      row.eachCell((cell) => {
        cell.font = { name: bodyFont, size: 10 }
      })
    }
    cols.forEach((_, c) => {
      const lens = [String(cols[c] || '').length, ...(s.rows || []).map((r) => String(r[c] ?? '').length)]
      ws.getColumn(c + 1).width = Math.min(42, Math.max(10, ...lens) + 2)
    })
    if (cols.length) ws.views = [{ state: 'frozen', ySplit: 1 }]
  })
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
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
  const sheets = data.sheets && data.sheets.length ? data.sheets : []
  const first = sheets[0]
  const title = (data.title || 'nalu-spreadsheet').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-spreadsheet'
  // On-brand if a Nalu Studio palette/brand is active, else Nalu defaults.
  const brand = getBrand()
  const headBg = '#' + (brand?.primary || '0F1B2D')

  const downloadXlsx = () => void downloadWorkbook(data, `${title}.xlsx`, brand)

  const downloadPdf = () => {
    const [hr, hg, hb] = toRgb(brand?.primary || '0F1B2D')
    const [ar, ag, ab] = toRgb(brand?.accent || 'AF8C56')
    const pdf = new jsPDF({ orientation: 'landscape' })
    sheets.forEach((s, i) => {
      if (i > 0) pdf.addPage()
      pdf.setFontSize(13)
      pdf.setTextColor(ar, ag, ab)
      pdf.text(`${title}${s.name ? ` — ${s.name}` : ''}`, 14, 15)
      pdf.setTextColor(0, 0, 0)
      autoTable(pdf, {
        head: [s.columns || []],
        body: (s.rows || []).map((r) => r.map((c) => String(c ?? ''))),
        startY: 20,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [hr, hg, hb] },
      })
    })
    pdf.save(`${title}.pdf`)
  }

  const previewRows = (first?.rows || []).slice(0, 8)

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-white/[0.16] bg-white/[0.04]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.12] px-4 py-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
          <FileSpreadsheet size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[#ededed]">{title}</div>
          <div className="text-xs text-[#8e8e8e]">
            {sheets.length} sheet{sheets.length === 1 ? '' : 's'}
            {first?.rows ? ` · ${first.rows.length} rows` : ''}
          </div>
        </div>
        <button
          onClick={downloadXlsx}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-500/20 px-2.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/30"
        >
          <Download size={13} /> Excel
        </button>
        <button
          onClick={downloadPdf}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs font-medium text-[#ededed] hover:bg-white/[0.12]"
        >
          <Download size={13} /> PDF
        </button>
      </div>
      {first && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {(first.columns || []).map((c, i) => (
                  <th
                    key={i}
                    className="border-b border-white/[0.12] px-3 py-1.5 text-left font-semibold text-white"
                    style={{ backgroundColor: headBg }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r, ri) => (
                <tr key={ri}>
                  {(first.columns || []).map((_, ci) => (
                    <td key={ci} className="border-b border-white/[0.06] px-3 py-1.5 text-[#cfcfcf]">
                      {String(r[ci] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {(first.rows || []).length > previewRows.length && (
            <div className="px-3 py-1.5 text-xs text-[#8e8e8e]">
              +{(first.rows || []).length - previewRows.length} more rows — download for the full file
            </div>
          )}
        </div>
      )}
    </div>
  )
}
