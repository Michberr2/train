import { useEffect, useRef, useState } from 'react'
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
  const word = overdue ? 'Putting it all together' : k.phrases[phrase % k.phrases.length]

  return (
    <div className="my-2 flex w-full max-w-md items-center gap-4 rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.05] to-white/[0.015] p-4 shadow-[0_10px_34px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
      {/* Circular progress ring */}
      <div className="relative h-12 w-12 shrink-0">
        <svg className="h-12 w-12 -rotate-90" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
          <circle cx="20" cy="20" r={R} fill="none" stroke={k.color} strokeWidth="3" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} style={{ transition: 'stroke-dashoffset .4s ease' }} />
        </svg>
        {/* faint spinning accent for liveliness */}
        <svg className="absolute inset-0 h-12 w-12 animate-spin" style={{ animationDuration: '2.4s' }} viewBox="0 0 40 40">
          <circle cx="20" cy="20" r={R} fill="none" stroke={k.color} strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${C * 0.12} ${C}`} transform="rotate(-90 20 20)" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon size={14} style={{ color: k.color }} />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div key={word} className="nalu-fadein text-[14.5px] font-medium text-[#f0f0f0]">
          {word}<span className="text-[#7e8696]">…</span>
        </div>
        <div className="mt-0.5 text-[11px] tabular-nums text-[#79808f]">{k.label} · {elapsed}s</div>
      </div>
      <div className="shrink-0 text-[13px] font-medium tabular-nums" style={{ color: k.color }}>{Math.round(pct)}%</div>
    </div>
  )
}
