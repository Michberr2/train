import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, FileSpreadsheet, FileText, Clapperboard, Box, Globe, Presentation, type LucideIcon } from 'lucide-react'

// Build-in-progress card: an elegant bar + honest elapsed time + rotating
// playful status phrases so the wait feels alive rather than stuck.

type Kind = 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides'

const KINDS: Record<Kind, { label: string; icon: LucideIcon; est: number; color: string; phrases: string[] }> = {
  image: {
    label: 'Image', icon: ImageIcon, est: 16000, color: '#5b9bff',
    phrases: ['Mixing the pixels', 'Finding the light', 'Adding the detail', 'Bringing it into focus', 'Final touches'],
  },
  sheet: {
    label: 'Spreadsheet', icon: FileSpreadsheet, est: 70000, color: '#34d399',
    phrases: ['Crunching the numbers', 'Wiring up the formulas', 'Laying out the columns', 'Balancing everything', 'Tidying the cells'],
  },
  doc: {
    label: 'Document', icon: FileText, est: 85000, color: '#7aa2ff',
    phrases: ['Sketching the outline', 'Finding the right words', 'Structuring the sections', 'Tightening the prose', 'Adding the polish'],
  },
  video: {
    label: 'Video', icon: Clapperboard, est: 90000, color: '#c084fc',
    phrases: ['Setting up the shot', 'Rolling the camera', 'Rendering the frames', 'Color-grading', 'Almost in the can'],
  },
  cad: {
    label: '3D model', icon: Box, est: 35000, color: '#5b9bff',
    phrases: ['Sketching the geometry', 'Extruding the shapes', 'Checking dimensions', 'Tightening tolerances', 'Smoothing edges'],
  },
  design: {
    label: 'Design', icon: Globe, est: 80000, color: '#e879f9',
    phrases: ['Choosing the colors', 'Composing the layout', 'Setting the type', 'Refining the details', 'Finishing touches'],
  },
  slides: {
    label: 'Deck', icon: Presentation, est: 70000, color: '#fbbf24',
    phrases: ['Storyboarding the deck', 'Choosing a palette', 'Designing the layouts', 'Writing punchy headlines', 'Aligning every pixel'],
  },
}

export default function MediaLoader({ kind }: { kind: string }) {
  const k = KINDS[(kind as Kind) in KINDS ? (kind as Kind) : 'image']
  const [ms, setMs] = useState(0)
  const [phrase, setPhrase] = useState(0)
  const start = useRef<number>(0)

  useEffect(() => {
    start.current = Date.now()
    setMs(0); setPhrase(0)
    const t = setInterval(() => setMs(Date.now() - start.current), 200)
    const p = setInterval(() => setPhrase((i) => i + 1), 2400) // rotate playful status
    return () => { clearInterval(t); clearInterval(p) }
  }, [kind])

  const t = ms / k.est
  const pct = t <= 1 ? 90 * (1 - Math.exp(-2.4 * t)) : Math.min(99, 90 + 9 * (1 - Math.exp(-(t - 1))))
  const elapsed = Math.floor(ms / 1000)
  const overdue = ms > k.est * 1.15
  const Icon = k.icon
  const word = overdue ? 'Putting it all together' : k.phrases[phrase % k.phrases.length]

  return (
    <div className="my-2 w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.09] bg-gradient-to-b from-white/[0.055] to-white/[0.015] p-4 shadow-[0_10px_34px_-10px_rgba(0,0,0,0.5)] backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `${k.color}1c`, color: k.color }}>
          <span className="absolute inset-0 animate-ping rounded-xl opacity-25" style={{ background: `${k.color}22` }} />
          <Icon size={17} className="relative" />
        </span>
        <div className="min-w-0 flex-1">
          <div key={word} className="nalu-fadein text-[14px] font-medium text-[#f0f0f0]">
            {word}<span className="text-[#7e8696]">…</span>
          </div>
          <div className="text-[11px] tabular-nums text-[#79808f]">{k.label} · {elapsed}s</div>
        </div>
        <div className="text-[13px] font-medium tabular-nums text-[#9aa2b2]">{Math.round(pct)}%</div>
      </div>
      <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="relative h-full overflow-hidden rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(5, pct)}%`, background: `linear-gradient(90deg, ${k.color}88, ${k.color})` }}
        >
          <div className="nalu-sweep absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        </div>
      </div>
    </div>
  )
}
