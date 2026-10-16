import { useEffect, useState, type CSSProperties } from 'react'

// A brand logo that never clashes with its background. It samples the logo's own
// luminance and, ONLY if that's too close to the background's, flips the logo to
// contrast (white on a dark ground, black on a light one) — so a dark wordmark stays
// visible on a dark cover while a logo that already contrasts keeps its real colors.
//
// `dark` = is the background dark? Defaults to a safe contrast filter immediately (so a
// dark logo on a dark cover is legible even before/if sampling fails on an SVG), then
// refines after measuring.
export function BrandLogo({
  src,
  dark,
  className,
  style,
}: {
  src: string
  dark: boolean
  className?: string
  style?: CSSProperties
}) {
  const safe = dark ? 'brightness(0) invert(1)' : undefined // pre-sample fallback
  const [filter, setFilter] = useState<string | undefined>(safe)

  useEffect(() => {
    setFilter(dark ? 'brightness(0) invert(1)' : undefined)
    let alive = true
    const img = new Image()
    img.onload = () => {
      try {
        const S = 40
        const c = document.createElement('canvas')
        c.width = S
        c.height = S
        const g = c.getContext('2d', { willReadFrequently: true })
        if (!g) return
        g.drawImage(img, 0, 0, S, S)
        const { data } = g.getImageData(0, 0, S, S)
        let lum = 0
        let n = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 20) continue // ignore transparent pixels
          lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
          n++
        }
        if (!n || !alive) return
        const avg = lum / n / 255 // 0 (black) .. 1 (white)
        // Clash = logo sits on the SAME luminance side as its background.
        const clash = dark ? avg < 0.45 : avg > 0.62
        setFilter(clash ? (dark ? 'brightness(0) invert(1)' : 'brightness(0)') : undefined)
      } catch {
        /* SVG with no intrinsic size / tainted canvas — keep the safe fallback */
      }
    }
    img.src = src
    return () => {
      alive = false
    }
  }, [src, dark])

  return <img src={src} alt="" className={className} style={{ ...style, filter }} />
}
