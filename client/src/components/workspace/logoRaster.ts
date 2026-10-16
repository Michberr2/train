// Rasterize a brand logo (SVG data URL / raster data URL / same-origin URL) to a PNG
// for the BINARY exports: PPTX + PDF want a PNG data URL, DOCX wants image bytes, XLSX
// wants raw base64. It reads an SVG's viewBox for the true aspect ratio and auto-contrasts
// (samples the logo's luminance and flips it to white on a dark ground / black on a light
// one only when it would otherwise clash) — matching the on-screen BrandLogo behavior.

export interface RasterLogo {
  dataUrl: string // data:image/png;base64,…  (PPTX/PDF)
  base64: string // raw base64, no prefix       (XLSX)
  bytes: Uint8Array // PNG bytes                 (DOCX)
  w: number
  h: number
}

function svgViewBoxAspect(src: string): number | null {
  try {
    if (!/^data:image\/svg\+xml/i.test(src)) return null
    const svg = /;base64,/i.test(src)
      ? atob(src.replace(/^data:[^,]*,/, ''))
      : decodeURIComponent(src.replace(/^data:image\/svg\+xml,?/i, ''))
    const m = svg.match(/viewBox\s*=\s*["']\s*[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+([\d.eE+-]+)/i)
    if (m) {
      const w = parseFloat(m[1])
      const h = parseFloat(m[2])
      if (w > 0 && h > 0) return w / h
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function rasterizeLogo(src: string, opts: { height?: number; bgDark?: boolean } = {}): Promise<RasterLogo | null> {
  const height = Math.max(8, Math.round(opts.height || 120))
  const bgDark = !!opts.bgDark
  if (!src) return null
  return new Promise<RasterLogo | null>((resolve) => {
    let settled = false
    const done = (v: RasterLogo | null) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onerror = () => done(null)
      img.onload = () => {
        try {
          const ar = svgViewBoxAspect(src) || (img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 3)
          const h = height
          const w = Math.max(8, Math.round(h * ar))
          const drawTo = (mode: 'white' | 'black' | null): string => {
            const c = document.createElement('canvas')
            c.width = w
            c.height = h
            const g = c.getContext('2d', { willReadFrequently: true })
            if (!g) return ''
            if (mode === 'white') g.filter = 'brightness(0) invert(1)'
            else if (mode === 'black') g.filter = 'brightness(0)'
            g.drawImage(img, 0, 0, w, h)
            return c.toDataURL('image/png')
          }
          // Sample the logo's average (opaque) luminance to decide whether it clashes.
          let mode: 'white' | 'black' | null = null
          try {
            const c = document.createElement('canvas')
            c.width = w
            c.height = h
            const g = c.getContext('2d', { willReadFrequently: true })
            if (g) {
              g.drawImage(img, 0, 0, w, h)
              const { data } = g.getImageData(0, 0, w, h)
              let lum = 0
              let n = 0
              for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 20) continue
                lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
                n++
              }
              const avg = n ? lum / n / 255 : bgDark ? 0 : 1
              mode = bgDark ? (avg < 0.45 ? 'white' : null) : avg > 0.62 ? 'black' : null
            } else {
              mode = bgDark ? 'white' : null
            }
          } catch {
            mode = bgDark ? 'white' : null
          }
          const dataUrl = drawTo(mode)
          if (!dataUrl || !dataUrl.startsWith('data:image')) return done(null)
          const base64 = dataUrl.split(',')[1] || ''
          const bin = atob(base64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          done({ dataUrl, base64, bytes, w, h })
        } catch {
          done(null)
        }
      }
      img.src = src
    } catch {
      done(null)
    }
  })
}
