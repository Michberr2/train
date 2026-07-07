import { useRef, useState } from 'react'
import { Download, Copy, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { CarouselArt } from './types'

// A social post rendered from STRUCTURED data with a bulletproof, container-query
// template — so text NEVER overflows and the design is consistent every time.
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

export default function CarouselCard({ art }: { art: CarouselArt }) {
  const slides = (art.slides || []).filter((s) => s && s.headline)
  const t = art.theme || ({} as CarouselArt['theme'])
  const [idx, setIdx] = useState(0)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const slideRefs = useRef<(HTMLDivElement | null)[]>([])

  const fontHref = FONT_LINK([t.headingFont, t.bodyFont])
  const pad = ratioPct(art.ratio)

  const go = (i: number) => {
    const n = Math.max(0, Math.min(slides.length - 1, i))
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
    setIdx(best)
  }

  const caption = [art.caption, (art.hashtags || []).join(' ')].filter(Boolean).join('\n\n')
  const copyCaption = async () => {
    try { await navigator.clipboard.writeText(caption); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* */ }
  }

  const shot = async (el: HTMLElement): Promise<Blob | null> => {
    const html2canvas = (await import('html2canvas')).default
    const canvas = await html2canvas(el, { useCORS: true, allowTaint: false, scale: 2, backgroundColor: null, logging: false })
    return await new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'))
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
    if (!el || busy) return
    setBusy(true)
    try { const b = await shot(el); if (b) save(b, `${base}-slide-${idx + 1}.png`) } finally { setBusy(false) }
  }
  const downloadAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      for (let i = 0; i < slides.length; i++) {
        const el = slideRefs.current[i]
        if (!el) continue
        const b = await shot(el)
        if (b) save(b, `${base}-slide-${i + 1}.png`)
        await new Promise((r) => setTimeout(r, 250))
      }
    } finally { setBusy(false) }
  }

  const headFam = `'${t.headingFont || 'Anton'}', system-ui, sans-serif`
  const bodyFam = `'${t.bodyFont || 'Inter'}', system-ui, sans-serif`
  const bg = t.bg2 && t.bg2 !== t.bg ? `linear-gradient(150deg, ${t.bg}, ${t.bg2})` : t.bg

  return (
    <div className="my-4 border-y border-glass/[0.12]">
      {fontHref && <link rel="stylesheet" href={fontHref} />}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">{art.platform || 'Social'} post</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{slides[0]?.headline || 'Post'}</span>
        <button onClick={() => void downloadAll()} disabled={busy} className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline disabled:opacity-50">
          {busy ? 'Rendering…' : 'Download all'}
        </button>
        <span className="text-xs text-dim">·</span>
        <button onClick={() => void downloadOne()} disabled={busy} className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline disabled:opacity-50">This slide</button>
      </div>

      <div className="bg-canvas px-3 py-4">
        <div className="relative mx-auto w-full max-w-[420px]">
          {/* swipeable track */}
          <div
            ref={trackRef}
            onScroll={onScroll}
            className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {slides.map((sl, i) => (
              <div
                key={i}
                ref={(el) => { slideRefs.current[i] = el }}
                className="relative shrink-0 basis-full snap-center overflow-hidden rounded-2xl"
                style={{ containerType: 'size', paddingBottom: `${pad}%`, background: bg, fontFamily: bodyFam } as React.CSSProperties}
              >
                {sl.img && (
                  <>
                    <img src={sl.img} alt="" crossOrigin="anonymous" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, ${t.bg}22, ${t.bg}cc)` }} />
                  </>
                )}
                {/* content — everything sized in cqmin so it NEVER overflows */}
                <div
                  style={{
                    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                    padding: '8cqmin', boxSizing: 'border-box', color: t.ink, overflow: 'hidden',
                  }}
                >
                  {sl.badge && (
                    <span style={{ fontFamily: headFam, fontSize: '11cqmin', lineHeight: 1, color: t.accent, fontWeight: 800 }}>{sl.badge}</span>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: sl.kind === 'cover' ? 'center' : 'flex-start', flex: 1, minHeight: 0, gap: '3cqmin', marginTop: sl.badge ? '4cqmin' : 0 }}>
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
            <button onClick={() => go(idx - 1)} className="flex h-7 w-7 items-center justify-center rounded-full bg-glass/10 text-ink hover:bg-glass/20"><ChevronLeft size={14} /></button>
            <span className="flex gap-1.5">
              {slides.map((_, i) => (
                <button key={i} onClick={() => go(i)} className="h-1.5 rounded-full transition-all" style={{ width: i === idx ? 18 : 6, background: i === idx ? t.accent : 'rgba(150,150,150,0.4)' }} />
              ))}
            </span>
            <button onClick={() => go(idx + 1)} className="flex h-7 w-7 items-center justify-center rounded-full bg-glass/10 text-ink hover:bg-glass/20"><ChevronRight size={14} /></button>
          </div>
        </div>

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
