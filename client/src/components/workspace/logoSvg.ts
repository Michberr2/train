/** Give a viewBox-only logo the namespace and dimensions standalone SVG needs. */
export function prepareLogoSvg(svg: string, size?: number): { svg: string; width: number; height: number } {
  // Read only the outer SVG: nested symbols may have unrelated coordinate grids.
  const rootPattern = /<svg\b((?:"[^"]*"|'[^']*'|[^'">])*)>/i
  const source = rootPattern.test(svg) ? svg : `<svg viewBox="0 0 100 100">${svg}</svg>`
  const attrs = source.match(rootPattern)![1]
  const attribute = (name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2]
  const vb = attribute('viewBox')
  const p = vb ? vb.trim().split(/[\s,]+/).map(Number) : []
  const hasViewBox = p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0
  const length = (value?: string) => {
    const match = value?.trim().match(/^(\d*\.?\d+(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q)?$/i)
    if (!match) return undefined
    const units: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 }
    const result = Number(match[1]) * units[(match[2] || 'px').toLowerCase()]
    return Number.isFinite(result) && result > 0 ? result : undefined
  }
  const intrinsicWidth = length(attribute('width')) || (hasViewBox ? p[2] : 300)
  const intrinsicHeight = length(attribute('height')) || (hasViewBox ? p[3] : 150)
  const ratio = hasViewBox ? p[2] / p[3] : intrinsicWidth / intrinsicHeight
  const width = size == null ? intrinsicWidth : ratio >= 1 ? size : Math.max(1, Math.round(size * ratio))
  const height = size == null ? intrinsicHeight : ratio >= 1 ? Math.max(1, Math.round(size / ratio)) : size
  const doc = source.replace(rootPattern, () => {
    let a = attrs
    if (attribute('xmlns') == null) a = ` xmlns="http://www.w3.org/2000/svg"${a}`
    if (size != null) {
      a = a.replace(/\s(?:width|height)\s*=\s*(["']).*?\1/gi, '')
      // Width/height-only legacy artwork needs its original coordinate system
      // retained when rasterized at a different size, not merely a new viewport.
      if (!hasViewBox) a = a.replace(/\sviewBox\s*=\s*(["']).*?\1/i, '') + ` viewBox="0 0 ${intrinsicWidth} ${intrinsicHeight}"`
    }
    if (size != null || attribute('width') == null) a += ` width="${width}"`
    if (size != null || attribute('height') == null) a += ` height="${height}"`
    return `<svg${a}>`
  })
  return { svg: doc, width, height }
}

/** SVG is untrusted document code. Image decoding is the browser's security
 * boundary: scripts, handlers, foreignObject scripts, external resource loads
 * and navigation are disabled. Never insert this source into the application DOM. */
export function logoImageUrl(svg: string, color = '#000000'): string {
  const prepared = prepareLogoSvg(svg.replace(/currentColor/gi, color))
  return 'data:image/svg+xml,' + encodeURIComponent(prepared.svg)
}

/** Retain vector rendering in exported SVG while keeping all supplied markup
 * inside image decoding, even when someone opens the export as a document. */
export function isolatedLogoSvg(svg: string, color = '#000000'): string {
  const { width, height } = prepareLogoSvg(svg)
  // Encoding apostrophes too makes the URL safe in either attribute quote style.
  const source = logoImageUrl(svg, color).replace(/'/g, '%27').replace(/"/g, '%22')
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="${source}" xlink:href="${source}"/></svg>`
}
