// Letter portrait with one-inch margins, expressed in each export's units.
export const DOC_PAGE = { width: 612, height: 792, margin: 72, contentWidth: 468, widthDxa: 12240, heightDxa: 15840, marginDxa: 1440, contentDxa: 9360, contentPixels: 624 }
export const DOC_HEADING_SIZES = [16, 14, 12, 11] as const
export const DOC_IMAGE_MAX_HEIGHT = 540 // points; leaves room for a heading and caption

export function fitDocumentImage(width: number | undefined, height: number | undefined, maxWidth: number, maxHeight: number) {
  const ratio = width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 1.5
  const w = Math.min(maxWidth, maxHeight * ratio)
  return { width: w, height: w / ratio }
}

/** Favor descriptive columns without starving short metric/status columns.
 * Exact DXA totals keep Word's table/grid/cell geometry in agreement. */
export function documentColumnWidths(columns: string[], rows: string[][]): number[] {
  if (!columns.length) return []
  const weights = columns.map((label, i) => Math.sqrt(Math.min(90, rows.reduce((longest, row) => Math.max(longest, (row[i] || '').length), Math.max(4, label.length)))))
  const sum = weights.reduce((a, b) => a + b, 0)
  const widths = weights.map(weight => Math.floor(DOC_PAGE.contentDxa * weight / sum))
  widths[widths.length - 1] += DOC_PAGE.contentDxa - widths.reduce((a, b) => a + b, 0)
  return widths
}
