import { useEffect, useRef, useState } from 'react'
import { useCallback } from 'react'
import { getBrand } from './brandKit'
import { Image as ImageIcon, FileSpreadsheet, FileText, Clapperboard, Box, Globe, Presentation, type LucideIcon } from 'lucide-react'

// Build-in-progress card: a refined circular progress ring (not a bar), honest
// elapsed time, and rotating playful status phrases so the wait feels alive.

type Kind = 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides'

const KINDS: Record<Kind, { label: string; icon: LucideIcon; est: number; color: string; phrases: string[] }> = {
  image: { label: 'Image', icon: ImageIcon, est: 16000, color: '#5b9bff', phrases: ['Mixing the pixels', 'Finding the light', 'Adding the detail', 'Bringing it into focus', 'Final touches'] },
  sheet: { label: 'Spreadsheet', icon: FileSpreadsheet, est: 70000, color: '#34d399', phrases: ['Crunching the numbers', 'Wiring up the formulas', 'Laying out the columns', 'Balancing everything', 'Tidying the cells'] },
  doc: { label: 'Document', icon: FileText, est: 85000, color: '#7aa2ff', phrases: ['Sketching the outline', 'Finding the right words', 'Structuring the sections', 'Tightening the prose', 'Adding the polish'] },
  video: { label: 'Video', icon: Clapperboard, est: 90000, color: '#c084fc', phrases: ['Setting up the shot', 'Rolling the camera', 'Rendering the frames', 'Color-grading', 'Almost in the can'] },
  cad: { label: '3D model', icon: Box, est: 35000, color: '#5b9bff', phrases: ['Sketching the geometry', 'Extruding the shapes', 'Checking dimensions', 'Tightening tolerances', 'Smoothing edges'] },
  design: { label: 'Design', icon: Globe, est: 80000, color: '#e879f9', phrases: ['Choosing the colors', 'Composing the layout', 'Setting the type', 'Refining the details', 'Finishing touches'] },
  slides: { label: 'Deck', icon: Presentation, est: 70000, color: '#fbbf24', phrases: ['Storyboarding the deck', 'Choosing a palette', 'Designing the layouts', 'Writing punchy headlines', 'Aligning every pixel'] },
}

// Wolf-flavored one-word status — Nalu is a wolf; let it act like one while it
// works. Shared with the chat thinking indicator next to the logo.
export const WOLF_WORDS = ['awooing', 'moon-howling', 'zoomies', 'den-digging', 'pack-snuggling', 'snow-romping', 'tail-floofing', 'moon-gazing', 'howl-tuning', 'fang-brushing', 'paw-typing', 'rabbit-dreaming', 'elk-chasing', 'snoot-lifting', 'star-sniffing', 'den-decorating', 'wolfing', 'fur-fluffing', 'pup-napping', 'panting']
export function WolfWord({ className = '' }: { className?: string }) {
  const [i, setI] = useState(() => Math.floor(Math.random() * WOLF_WORDS.length))
  useEffect(() => {
    const iv = setInterval(() => setI((v) => (v + 1 + Math.floor(Math.random() * 3)) % WOLF_WORDS.length), 1300)
    return () => clearInterval(iv)
  }, [])
  const w = WOLF_WORDS[i]
  return (
    <span key={w} className={`nalu-fadein italic tracking-wide text-gold ${className}`}>
      {w}<span className="opacity-60">…</span>
    </span>
  )
}

const R = 17
const C = 2 * Math.PI * R

export default function MediaLoader({ kind }: { kind: string }) {
  const k = KINDS[(kind as Kind) in KINDS ? (kind as Kind) : 'image']
  const [ms, setMs] = useState(0)
  const [phrase, setPhrase] = useState(0)
  const start = useRef<number>(0)

  useEffect(() => {
    start.current = Date.now()
    setMs(0); setPhrase(0)
    const t = setInterval(() => setMs(Date.now() - start.current), 200)
    const p = setInterval(() => setPhrase((i) => i + 1), 2400)
    return () => { clearInterval(t); clearInterval(p) }
  }, [kind])

  const tt = ms / k.est
  const pct = tt <= 1 ? 90 * (1 - Math.exp(-2.4 * tt)) : Math.min(99, 90 + 9 * (1 - Math.exp(-(tt - 1))))
  const elapsed = Math.floor(ms / 1000)
  const overdue = ms > k.est * 1.15
  const Icon = k.icon
  const wolf = WOLF_WORDS[(phrase >> 1) % WOLF_WORDS.length]
  const word = overdue
    ? 'Putting it all together'
    : phrase % 2
      ? wolf[0].toUpperCase() + wolf.slice(1)
      : k.phrases[(phrase >> 1) % k.phrases.length]

  void Icon
  return (
    <div className="my-2 w-full max-w-sm overflow-hidden rounded-2xl border border-glass/[0.14] bg-panel2/90 shadow-[0_14px_40px_-14px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="flex items-center justify-between px-5 pt-4">
        <span className="text-[15px] font-medium text-ink">Creating {k.label.toLowerCase()}</span>
        <span className="text-[12px] font-medium tabular-nums text-dim">{Math.round(pct)}%</span>
      </div>
      <DotField pct={pct} accent={"#" + (getBrand()?.accent || "AF8C56")} />
      <div className="flex items-center justify-between px-5 pb-3.5">
        <span key={word} className="nalu-fadein min-w-0 truncate text-[12px] text-dim">{word}…</span>
        <span className="shrink-0 pl-3 text-[11px] tabular-nums text-dim/70">{elapsed}s</span>
      </div>
    </div>
  )
}

// The build canvas — a field of TINY NALU WOLF HEADS that shimmers like
// thought and BUILDS left→right with real progress: built wolves settle into
// the artifact's accent, the frontier glows, the pack drifts and bobs.
// (Falls back to dots until the wolf sprite loads.)
function tintedWolf(img: HTMLImageElement, color: string, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const x = c.getContext('2d')
  if (!x) return c
  x.drawImage(img, 0, 0, size, size)
  x.globalCompositeOperation = 'source-in'
  x.fillStyle = color
  x.fillRect(0, 0, size, size)
  return c
}
function DotField({ pct, accent }: { pct: number; accent: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const pctRef = useRef(pct)
  pctRef.current = pct
  // the waiting game: catch the howler before it moves — score persists per session
  const howlerRef = useRef<{ x: number; y: number; size: number } | null>(null)
  const catchesRef = useRef(Number(sessionStorage.getItem('nalu-awoo-catches') || 0))
  const burstRef = useRef<{ x: number; y: number; at: number } | null>(null)
  const hexRgb = useCallback((h: string): [number, number, number] => {
    const m = h.replace('#', '')
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]
  }, [])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const DPR = Math.min(2, window.devicePixelRatio || 1)
    const resize = () => {
      canvas.width = Math.max(1, canvas.clientWidth * DPR)
      canvas.height = Math.max(1, canvas.clientHeight * DPR)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    const [ar, ag, ab] = hexRgb(accent)
    const dark = document.documentElement.classList.contains('dark')
    const neutral = dark ? 'rgb(226,230,238)' : 'rgb(30,44,66)' // site ink tones
    const [nr, ng, nb] = dark ? [226, 230, 238] : [30, 44, 66]
    // wolf sprites (neutral + brand accent), prepared once the logo loads
    const SPRITE = 64
    let wolfWhite: HTMLCanvasElement | null = null
    let wolfAccent: HTMLCanvasElement | null = null
    const wolfImg = new Image()
    wolfImg.onload = () => {
      wolfWhite = tintedWolf(wolfImg, neutral, SPRITE)
      wolfAccent = tintedWolf(wolfImg, `rgb(${ar},${ag},${ab})`, SPRITE)
    }
    wolfImg.src = '/wolf-icon.png'
    let raf = 0
    const t0 = performance.now()
    // each loading screen hides the howler somewhere NEW
    const seed = 1 + Math.floor(Math.random() * 99991)
    const draw = (now: number) => {
      const t = (now - t0) / 1000
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const pitch = (wolfWhite ? 22 : 15) * DPR
      const cols = Math.ceil(w / pitch)
      const rows = Math.ceil(h / pitch)
      // two soft energy blobs drifting through the field (the "thinking")
      const b1x = w * (0.30 + 0.22 * Math.sin(t * 0.55))
      const b1y = h * (0.38 + 0.30 * Math.cos(t * 0.42))
      const b2x = w * (0.68 + 0.24 * Math.cos(t * 0.35 + 2))
      const b2y = h * (0.60 + 0.26 * Math.sin(t * 0.5 + 1))
      const rad = Math.min(w, h) * 0.42
      const frontier = (pctRef.current / 100) * (w + rad * 0.6) - rad * 0.3
      // the howler IS one of the pack — pick its cell for this epoch
      const EPOCH = 2.4
      const hk = Math.floor(t / EPOCH)
      const hphase = (t % EPOCH) / EPOCH
      const hc = (((hk + seed) * 7919) % Math.max(1, cols - 2)) + 1
      const hr = (((hk + seed) * 104729) % Math.max(1, rows - 2)) + 1
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * pitch + pitch / 2
          const y = r * pitch + pitch / 2
          const d1 = Math.hypot(x - b1x, y - b1y)
          const d2 = Math.hypot(x - b2x, y - b2y)
          const glow = Math.max(0, 1 - d1 / rad) ** 2 * 0.5 + Math.max(0, 1 - d2 / rad) ** 2 * 0.38
          const ripple = 0.05 * Math.sin(x * 0.012 + t * 1.4) * Math.sin(y * 0.014 - t)
          const base = 0.08 + ripple
          const built = x < frontier
          const edge = Math.max(0, 1 - Math.abs(x - frontier) / (pitch * 3)) // glowing build frontier
          const a = Math.max(0.03, Math.min(0.95, base + glow + (built ? 0.10 : 0) + edge * 0.5))
          if (wolfWhite && wolfAccent) {
            // a pack of tiny wolves: brighter ones swell and bob with the energy
            const bob = Math.sin(t * 1.6 + (c * 7 + r * 13) * 0.7) * a * 2.2 * DPR
            const wsize = pitch * (0.42 + a * 0.5)
            const sprite = built || edge > 0.15 ? wolfAccent : wolfWhite
            const alpha = built || edge > 0.15 ? Math.min(1, a * 0.95) : a * 0.6
            if (c === hc && r === hr) {
              // the hidden howler: identical size/color/alpha to its packmates,
              // just tilted back mid-howl — find it to catch it
              howlerRef.current = { x, y, size: wsize * 2.4 }
              ctx.save()
              ctx.translate(x, y + bob)
              ctx.rotate(-0.55)
              ctx.globalAlpha = alpha
              ctx.drawImage(sprite, -wsize / 2, -wsize / 2, wsize, wsize)
              ctx.restore()
              ctx.globalAlpha = 1
              // whisper-faint awoo — the only tell
              const hp = hphase < 0.12 ? hphase / 0.12 : hphase > 0.88 ? (1 - hphase) / 0.12 : 1
              ctx.strokeStyle = `rgba(${ar},${ag},${ab},${(0.14 * hp).toFixed(3)})`
              ctx.lineWidth = 1 * DPR
              ctx.beginPath()
              ctx.arc(x + wsize * 0.32, y - wsize * 0.36, wsize * 0.7, -1.9, -0.9)
              ctx.stroke()
            } else {
              ctx.globalAlpha = alpha
              ctx.drawImage(sprite, x - wsize / 2, y - wsize / 2 + bob, wsize, wsize)
              ctx.globalAlpha = 1
            }
          } else {
            const size = (1.05 + a * 1.5) * DPR
            ctx.fillStyle = built || edge > 0.15 ? `rgba(${ar},${ag},${ab},${(a * 0.9).toFixed(3)})` : `rgba(${nr},${ng},${nb},${(a * 0.55).toFixed(3)})`
            ctx.beginPath()
            ctx.arc(x, y, size, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
      if (!reduced) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) * DPR
      const y = (e.clientY - rect.top) * DPR
      const hcur = howlerRef.current
      if (hcur && Math.hypot(x - hcur.x, y - hcur.y) < hcur.size * 1.1) {
        catchesRef.current += 1
        try { sessionStorage.setItem('nalu-awoo-catches', String(catchesRef.current)) } catch { /* */ }
        burstRef.current = { x: hcur.x, y: hcur.y, at: performance.now() }
      }
    }
    canvas.addEventListener('click', onClick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('click', onClick)
    }
  }, [accent, hexRgb])
  return <canvas ref={ref} className="mt-2 block h-[26rem] w-full cursor-pointer" title="Catch the howling wolf" aria-label="Catch the howling wolf while Nalu builds" />
}
