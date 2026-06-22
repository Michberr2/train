import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { FileSpreadsheet, Download } from 'lucide-react'
import { getBrand, toRgb } from './brandKit'

export type SheetData = {
  name?: string
  columns?: string[]
  rows?: (string | number)[][]
}
export type SheetDoc = {
  title?: string
  sheets?: SheetData[]
}

// Build a real .xlsx workbook, turning "=..." strings into live Excel formulas.
function buildWorkbook(doc: SheetDoc): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const sheets = doc.sheets && doc.sheets.length ? doc.sheets : [{ name: 'Sheet1', columns: [], rows: [] }]
  sheets.forEach((s, i) => {
    const aoa: (string | number)[][] = [s.columns || [], ...(s.rows || [])]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const ref = ws['!ref']
    if (ref) {
      const range = XLSX.utils.decode_range(ref)
      for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C })
          const cell = ws[addr] as XLSX.CellObject | undefined
          if (cell && typeof cell.v === 'string' && cell.v.startsWith('=')) {
            ws[addr] = { t: 'n', f: cell.v.slice(1) } as XLSX.CellObject
          }
        }
      }
    }
    // sensible column widths
    const widths = (s.columns || []).map((_, c) => {
      const lens = [String((s.columns || [])[c] || '').length, ...(s.rows || []).map((r) => String(r[c] ?? '').length)]
      return { wch: Math.min(40, Math.max(10, ...lens) + 2) }
    })
    if (widths.length) ws['!cols'] = widths
    XLSX.utils.book_append_sheet(wb, ws, (s.name || `Sheet${i + 1}`).slice(0, 31))
  })
  return wb
}

export default function SheetCard({ data }: { data: SheetDoc }) {
  const sheets = data.sheets && data.sheets.length ? data.sheets : []
  const first = sheets[0]
  const title = (data.title || 'nalu-spreadsheet').replace(/[\\/:*?"<>|]+/g, '').trim() || 'nalu-spreadsheet'
  // On-brand if a Nalu Studio palette/brand is active, else Nalu defaults.
  const brand = getBrand()
  const headBg = '#' + (brand?.primary || '0F1B2D')

  const downloadXlsx = () => XLSX.writeFile(buildWorkbook(data), `${title}.xlsx`)

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
