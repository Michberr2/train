import { useEffect, useRef, useState } from 'react'
import { Download, Copy, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { CarouselArt } from './types'
import { ensureSlideFonts, loadSlideFont, readableFontFallbacks, resolveSlideFont, slideFontCss, type SlideFontStyle } from './slideFonts'

// Structured social slides share explicit aspect-ratio geometry with exports.
// Swipeable, per-slide + all-slide PNG download, one-click caption+hashtags copy.

const FONT_LINK = (fams: string[]) => {
  const uniq = [...new Set(fams.filter(Boolean))]
  if (!uniq.length) return null
  const q = uniq.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600;700;800;900`).join('&')
  return `https://fonts.googleapis.com/css2?${q}&display=swap`
}

function ratioPct(r?: string): number {
  if (r === '9:16') return (16 / 9) * 100
  if (r === '1:1') return 100
  return (5 / 4) * 100 // 4:5 default
}

function copyOverflows(slide: HTMLElement): boolean {
  const copy = slide.querySelector<HTMLElement>('[data-carousel-copy]')
  if (!copy) return false
  const bounds = copy.getBoundingClientRect()
  let previousBottom = -Infinity
  // Range bounds detect actual wrapped text and overlaps. scrollHeight on an
  // individual heading can exceed its deliberately tight line-height normally.
  return [...copy.children].some(child => {
    const range = document.createRange()
    range.selectNodeContents(child)
    const text = range.getBoundingClientRect()
    const leading = parseFloat(getComputedStyle(child).fontSize) * .25
    const clipped = text.top < bounds.top - leading || text.bottom > bounds.bottom + leading || text.top < previousBottom - 2
    previousBottom = text.bottom
    return clipped
  })
}

// STANDALONE export — turn the structured carousel into a self-contained .html
// file (same container-query template as the live card) so AutoPilot's Social
// step can save/download/publish a real artifact. No React, no external assets
// beyond the Google Fonts link.
export function carouselToHtml(art: CarouselArt): string {
  const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const slides = (art.slides || []).filter((s) => s && s.headline)
  const t = art.theme || ({} as CarouselArt['theme'])
  const pad = ratioPct(art.ratio)
  const headFam = `'${t.headingFont || 'Anton'}', system-ui, sans-serif`
  const bodyFam = `'${t.bodyFont || 'Inter'}', system-ui, sans-serif`
  const bg = t.bg2 && t.bg2 !== t.bg ? `linear-gradient(150deg, ${t.bg}, ${t.bg2})` : t.bg || '#4F46E5'
  const fontHref = FONT_LINK([t.headingFont, t.bodyFont])
  const slideHtml = slides.map((sl, i) => {
    const coverJust = sl.kind === 'cover' ? 'center' : 'flex-start'
    const headSize = sl.kind === 'cover' ? 'clamp(1rem, 12cqmin, 240px)' : 'clamp(0.9rem, 8.5cqmin, 200px)'
    const img = sl.img ? `<img src="${esc(sl.img)}" alt="" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"/><div style="position:absolute;inset:0;background:linear-gradient(180deg, ${t.ink ? t.bg + '22' : '#00000022'}, ${t.bg || '#000'}cc)"></div>` : ''
    const badge = sl.badge ? `<span style="font-family:${headFam};font-size:11cqmin;line-height:1;color:${t.accent || '#FBBF24'};font-weight:800">${esc(sl.badge)}</span>` : ''
    const sub = sl.sub ? `<p style="margin:0;font-size:4.6cqmin;line-height:1.35;opacity:.92;overflow-wrap:break-word">${esc(sl.sub)}</p>` : ''
    const body = (sl.body || []).map((b) => `<p style="margin:0;font-size:4.4cqmin;line-height:1.4;opacity:.9;overflow-wrap:break-word">${esc(b)}</p>`).join('')
    return `<div class="slide" style="container-type:size;aspect-ratio:100 / ${pad};background:${bg};font-family:${bodyFam};color:${t.ink || '#fff'}">
      ${img}
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;padding:8cqmin;box-sizing:border-box;overflow:hidden">
        ${badge}
        <div style="display:flex;flex-direction:column;justify-content:${coverJust};flex:1;min-height:0;gap:3cqmin;margin-top:${sl.badge ? '4cqmin' : '0'}">
          <h2 style="font-family:${headFam};font-weight:800;line-height:1.04;margin:0;font-size:${headSize};letter-spacing:-0.01em;overflow-wrap:break-word">${esc(sl.headline)}</h2>
          ${sub}${body}
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:3.4cqmin;opacity:.85;margin-top:4cqmin">
          <span>${esc(art.handle || '')}</span><span>${i === 0 && slides.length > 1 ? 'Swipe →' : `${i + 1}/${slides.length}`}</span>
        </div>
        <div style="position:absolute;left:0;top:0;bottom:0;width:2.2cqmin;background:${t.accent || '#FBBF24'}"></div>
      </div>
    </div>`
  }).join('\n')
  const caption = art.caption ? `<p class="cap">${esc(art.caption)}</p>` : ''
  const tags = (art.hashtags || []).length ? `<p class="tags">${esc((art.hashtags || []).join(' '))}</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(art.name || 'Nalu post')} — ${esc(art.platform || 'social')}</title>
${fontHref ? `<link rel="stylesheet" href="${fontHref}">` : ''}
<style>body{margin:0;background:#0b0b0f;font-family:${bodyFam};padding:24px}
.wrap{max-width:440px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.slide{position:relative;width:100%;border-radius:18px;overflow:hidden}
.meta{color:#9aa;font-size:12px;text-transform:uppercase;letter-spacing:.16em;margin:2px 0}
.capbox{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:14px;color:#e8e8ef}
.cap{white-space:pre-wrap;line-height:1.5;margin:0;font-size:13.5px}
.tags{color:#FBBF24;margin:.6em 0 0;font-size:12.5px}</style></head>
<body><div class="wrap">
<div class="meta">${esc(art.platform || 'Social')} post · ${slides.length} slides</div>
${slideHtml}
${caption || tags ? `<div class="capbox">${caption}${tags}</div>` : ''}
</div></body></html>`
}

export default function CarouselCard({ art }: { art: CarouselArt }) {
  const slides = (art.slides || []).filter((s) => s && s.headline)
  const t = art.theme || ({} as CarouselArt['theme'])
  const [idx, setIdx] = useState(0)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [overflow, setOverflow] = useState<number[]>([])
  const [fontsReady, setFontsReady] = useState(false)
  const [fontError, setFontError] = useState('')
  const [fontAttempt, setFontAttempt] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const slideRefs = useRef<(HTMLDivElement | null)[]>([])
  const lock = useRef(false)
  const mounted = useRef(false)
  const artifactKey = JSON.stringify(art)
  const currentKey = useRef(artifactKey)
  const pendingSlide = useRef<number | null>(null)
  currentKey.current = artifactKey

  const pad = ratioPct(art.ratio)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let disposed = false
    setFontsReady(false); setFontError('')
    ensureSlideFonts([t.headingFont || 'Anton', t.bodyFont || 'Inter']).then(() => { if (!disposed) setFontsReady(true) }).catch(error => { if (!disposed) setFontError(error.message) })
    return () => { disposed = true }
  }, [t.headingFont, t.bodyFont, fontAttempt])
  useEffect(() => { pendingSlide.current = null; setIdx(0); setError(''); trackRef.current?.scrollTo({ left: 0 }); slideRefs.current.length = slides.length }, [artifactKey])
  useEffect(() => {
    let disposed = false
    const check = () => {
      if (disposed) return
      const clipped = slideRefs.current.flatMap((slide, i) => slide && copyOverflows(slide) ? [i] : [])
      setOverflow(old => JSON.stringify(old) === JSON.stringify(clipped) ? old : clipped)
    }
    const observer = new ResizeObserver(check)
    slideRefs.current.forEach(slide => { if (slide) observer.observe(slide) })
    check(); void document.fonts.ready.then(check)
    return () => { disposed = true; observer.disconnect() }
  }, [artifactKey, fontsReady])

  const go = (i: number) => {
    const n = Math.max(0, Math.min(slides.length - 1, i))
    pendingSlide.current = n
    setIdx(n)
    const el = slideRefs.current[n]
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }
  const onScroll = () => {
    const track = trackRef.current
    if (!track) return
    const center = track.scrollLeft + track.clientWidth / 2
    let best = 0
    let bestD = Infinity
    slideRefs.current.forEach((el, i) => {
      if (!el) return
      const c = el.offsetLeft + el.clientWidth / 2
      const d = Math.abs(c - center)
      if (d < bestD) { bestD = d; best = i }
    })
    if (pendingSlide.current !== null && best !== pendingSlide.current) return
    pendingSlide.current = null
    setIdx(best)
  }

  const caption = [art.caption, (art.hashtags || []).join(' ')].filter(Boolean).join('\n\n')
  const copyCaption = async () => {
    try { await navigator.clipboard.writeText(caption); setCopied(true); setTimeout(() => { if (mounted.current) setCopied(false) }, 1800) } catch { setError('The caption could not be copied. Select and copy the text below.') }
  }

  const shot = async (el: HTMLElement): Promise<Blob> => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-12000px;top:0;width:1080px;pointer-events:none'
    host.setAttribute('aria-hidden', 'true')
    const clone = el.cloneNode(true) as HTMLElement
    Object.assign(clone.style, { width: '1080px', minWidth: '1080px', maxWidth: '1080px', height: `${Math.round(1080 * pad / 100)}px`, paddingBottom: '0', flex: 'none' })
    host.append(clone); document.body.append(host)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Imperatively loaded FontFace objects are absent from html2canvas's
      // cloned document. Give the clone the same font bytes through CSS so its
      // text measurement and the canvas renderer cannot use different faces.
      const fontStyle = document.createElement('style')
      const families = [...new Set([t.headingFont || 'Anton', t.bodyFont || 'Inter'].map(face => resolveSlideFont(face).effective))]
      fontStyle.textContent = (await Promise.all(families.flatMap(family => (['normal', 'bold', 'italic', 'bolditalic'] as SlideFontStyle[]).map(async style => {
        const bytes = await loadSlideFont(family, style)
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
        return `@font-face{font-family:"${family}";font-style:${style.includes('italic') ? 'italic' : 'normal'};font-weight:${style.includes('bold') ? 700 : 400};src:url(data:font/ttf;base64,${btoa(binary)}) format('truetype')}`
      })))).join('\n')
      host.prepend(fontStyle)
      await Promise.race([
        Promise.all([document.fonts.ready, ...Array.from(clone.querySelectorAll('img')).map(image => image.decode().catch(() => { throw new Error('A carousel image could not load. Retry after the image is available.') }))]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Carousel fonts or images timed out. Please retry.')), 15000) }),
      ])
      // html2canvas does not implement object-fit. Bake each cover crop into an
      // image of the artboard's exact dimensions before the DOM is rasterized.
      for (const image of clone.querySelectorAll('img')) {
        const crop = document.createElement('canvas')
        crop.width = 1080; crop.height = Math.round(1080 * pad / 100)
        const ctx = crop.getContext('2d')
        if (!ctx) throw new Error('The carousel image could not be prepared.')
        const scale = Math.max(crop.width / image.naturalWidth, crop.height / image.naturalHeight)
        const w = image.naturalWidth * scale, h = image.naturalHeight * scale
        ctx.drawImage(image, (crop.width - w) / 2, (crop.height - h) / 2, w, h)
        image.src = crop.toDataURL('image/png'); image.style.objectFit = 'fill'
        await image.decode()
      }
      if (copyOverflows(clone)) throw new Error('This slide has more text than fits. Shorten it or split it across slides before downloading.')
      const html2canvas = (await import('html2canvas')).default
      const canvas = await html2canvas(clone, { useCORS: true, allowTaint: false, scale: 1, width: 1080, height: Math.round(1080 * pad / 100), windowWidth: 1200, windowHeight: Math.max(1600, Math.round(1080 * pad / 100) + 64), scrollX: 0, scrollY: 0, backgroundColor: null, logging: false })
      return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The carousel image could not be exported.')), 'image/png'))
    } finally { if (timer) clearTimeout(timer); host.remove() }
  }
  const save = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }
  const base = (art.platform || 'nalu').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const downloadOne = async () => {
    const el = slideRefs.current[idx]
    if (!el || lock.current) return
    const key = artifactKey
    lock.current = true; setBusy(true); setError('')
    try {
      const blob = await shot(el)
      if (!mounted.current || currentKey.current !== key) throw new Error('The carousel changed during export. Please try again.')
      save(blob, `${base}-slide-${idx + 1}.png`)
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Carousel export failed. Please try again.') }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const downloadAll = async () => {
    if (lock.current || !slides.length) return
    const key = artifactKey
    lock.current = true; setBusy(true); setError('')
    try {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      for (let i = 0; i < slides.length; i++) {
        const el = slideRefs.current[i]
        if (!el) throw new Error('A carousel slide is unavailable. Please try again.')
        const b = await shot(el)
        if (!mounted.current || currentKey.current !== key) throw new Error('The carousel changed during export. Please try again.')
        zip.file(`${base}-slide-${i + 1}.png`, b)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      if (!mounted.current || currentKey.current !== key) throw new Error('The carousel changed during export. Please try again.')
      save(blob, `${base}-slides.zip`)
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'Carousel export failed. Please try again.') }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }

  const headFam = slideFontCss(t.headingFont || 'Anton')
  const bodyFam = slideFontCss(t.bodyFont || 'Inter')
  const bg = t.bg2 && t.bg2 !== t.bg ? `linear-gradient(150deg, ${t.bg}, ${t.bg2})` : t.bg

  return (
    <div role="region" aria-label={`${art.name || 'Social'} carousel`} className="my-4 border-y border-glass/[0.12]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">{art.platform || 'Social'} post</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{slides[0]?.headline || 'Post'}</span>
        <button onClick={() => void downloadAll()} disabled={busy || !fontsReady || !slides.length || overflow.length > 0} title="Download all slides as a ZIP of 1080px PNG files" className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">
          {busy ? 'Rendering…' : 'Download all'}
        </button>
        <span className="text-xs text-dim">·</span>
        <button onClick={() => void downloadOne()} disabled={busy || !fontsReady || !slides.length || overflow.includes(idx)} className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline disabled:opacity-50">This slide</button>
      </div>
      {error && <p role="alert" className="px-3 py-2 text-sm text-red-400">{error}</p>}
      {fontError && <div role="alert" className="px-3 py-2 text-sm text-red-400">{fontError} <button className="underline" onClick={() => setFontAttempt(n => n + 1)}>Retry fonts</button></div>}
      {overflow.length > 0 && <p role="alert" className="px-3 py-2 text-sm text-amber-400">Slides {overflow.map(i => i + 1).join(', ')} need more space. Shorten the text or split it across slides before downloading.</p>}

      <div className="bg-canvas px-3 py-4">
        <div className="relative mx-auto w-full max-w-[420px]">
          {/* swipeable track */}
          <div
            ref={trackRef}
            onScroll={onScroll}
            onPointerDown={() => { pendingSlide.current = null }}
            onWheel={() => { pendingSlide.current = null }}
            className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {slides.map((sl, i) => (
              <div
                data-carousel-slide
                key={i}
                ref={(el) => { slideRefs.current[i] = el }}
                className="relative shrink-0 basis-full snap-center overflow-hidden rounded-2xl"
                style={{ containerType: 'size', aspectRatio: `100 / ${pad}`, background: bg, fontFamily: bodyFam } as React.CSSProperties}
              >
                {sl.img && (
                  <>
                    <img src={sl.img} alt="" crossOrigin="anonymous" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, ${t.bg}22, ${t.bg}cc)` }} />
                  </>
                )}
                {/* Container-relative type scales with the artboard. Dense text
                    is measured and flagged before it can be clipped in export. */}
                <div
                  style={{
                    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                    padding: '8cqmin', boxSizing: 'border-box', color: t.ink, overflow: 'hidden',
                  }}
                >
                  {sl.badge && (
                    <span style={{ fontFamily: headFam, fontSize: '11cqmin', lineHeight: 1, color: t.accent, fontWeight: 800 }}>{sl.badge}</span>
                  )}
                  <div data-carousel-copy style={{ display: 'flex', flexDirection: 'column', justifyContent: sl.kind === 'cover' ? 'center' : 'flex-start', flex: 1, minHeight: 0, gap: '3cqmin', marginTop: sl.badge ? '4cqmin' : 0 }}>
                    <h2 style={{ fontFamily: headFam, fontWeight: 800, lineHeight: 1.04, margin: 0, fontSize: sl.kind === 'cover' ? 'clamp(1rem, 12cqmin, 240px)' : 'clamp(0.9rem, 8.5cqmin, 200px)', letterSpacing: '-0.01em', overflowWrap: 'break-word' }}>
                      {sl.headline}
                    </h2>
                    {sl.sub && <p style={{ margin: 0, fontSize: '4.6cqmin', lineHeight: 1.35, opacity: 0.92, overflowWrap: 'break-word' }}>{sl.sub}</p>}
                    {(sl.body || []).map((b, j) => (
                      <p key={j} style={{ margin: 0, fontSize: '4.4cqmin', lineHeight: 1.4, opacity: 0.9, overflowWrap: 'break-word' }}>{b}</p>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '3.4cqmin', opacity: 0.85, marginTop: '4cqmin' }}>
                    <span>{art.handle || ''}</span>
                    <span>{i === 0 && slides.length > 1 ? 'Swipe →' : `${i + 1}/${slides.length}`}</span>
                  </div>
                  {/* accent bar — the recognizable Nalu system motif */}
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '2.2cqmin', background: t.accent }} />
                </div>
              </div>
            ))}
          </div>

          {/* nav */}
          <div className="mt-2 flex items-center justify-center gap-2">
            <button aria-label="Previous slide" disabled={idx === 0} onClick={() => go(idx - 1)} className="flex h-7 w-7 items-center justify-center rounded-full bg-glass/10 text-ink hover:bg-glass/20 disabled:opacity-40"><ChevronLeft size={14} /></button>
            <span className="flex gap-1.5">
              {slides.map((_, i) => (
                <button key={i} aria-label={`Slide ${i + 1}`} aria-current={idx === i ? 'true' : undefined} onClick={() => go(i)} className="h-1.5 rounded-full transition-all" style={{ width: i === idx ? 18 : 6, background: i === idx ? t.accent : 'rgba(150,150,150,0.4)' }} />
              ))}
            </span>
            <button aria-label="Next slide" disabled={idx >= slides.length - 1} onClick={() => go(idx + 1)} className="flex h-7 w-7 items-center justify-center rounded-full bg-glass/10 text-ink hover:bg-glass/20 disabled:opacity-40"><ChevronRight size={14} /></button>
          </div>
        </div>
        <p className="mx-auto mt-2 max-w-xl text-xs text-dim">PNG files are 1080 pixels wide. Download all includes every slide in one ZIP.{readableFontFallbacks([t.headingFont || 'Anton', t.bodyFont || 'Inter']).length > 0 && ` Font substitutions: ${readableFontFallbacks([t.headingFont || 'Anton', t.bodyFont || 'Inter']).join('; ')}.`}</p>

        {/* schedule + auto-post to your accounts */}
        <details className="mx-auto mt-3 max-w-xl rounded-xl border border-glass/[0.1] bg-glass/[0.03] px-3 py-2 text-[12px] text-ink">
          <summary className="cursor-pointer select-none font-medium text-gold">Schedule &amp; auto-post to your accounts</summary>
          <div className="mt-2 space-y-1.5 leading-relaxed text-dim">
            <p><span className="font-medium text-ink">Post now:</span> download the slides above (or copy the caption) and post them, or hand them to your scheduler.</p>
            <p><span className="font-medium text-ink">Auto-post + schedule:</span> open <span className="text-gold">AutoPilot</span> → click <span className="text-gold">+ Post</span> for a ready daily auto-poster. In the <span className="text-ink">Social post</span> step pick the platform, paste a publish webhook from Zapier / Make / Buffer (that connects your real Instagram, TikTok, LinkedIn, etc.), pick a cadence, and toggle On — Nalu then builds and posts on schedule.</p>
          </div>
        </details>

        {/* caption + hashtags */}
        {(art.caption || (art.hashtags || []).length > 0) && (
          <div className="mx-auto mt-4 max-w-xl rounded-xl border border-glass/[0.1] bg-glass/[0.04] p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Caption &amp; hashtags</span>
              <button onClick={() => void copyCaption()} className="flex items-center gap-1 text-[11px] font-medium text-gold hover:text-ink">
                {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
              </button>
            </div>
            {art.caption && <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{art.caption}</p>}
            {(art.hashtags || []).length > 0 && <p className="mt-2 text-[12px] text-gold/90">{(art.hashtags || []).join(' ')}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
