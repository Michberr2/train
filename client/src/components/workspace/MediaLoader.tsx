import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, FileSpreadsheet, FileText, Clapperboard, Box, Globe, Presentation, type LucideIcon } from 'lucide-react'

// Progress bar shown while an artifact is generated. Shows ELAPSED time counting
// up (honest — no lying countdown that freezes) plus a typical estimate, and a
// bar that always keeps creeping so it never looks stuck. These are deep builds
// (8–16k tokens), so the estimates are realistic.

type Kind = 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides'

const KINDS: Record<Kind, { label: string; icon: LucideIcon; est: number; color: string }> = {
  image: { label: 'Generating image', icon: ImageIcon, est: 16000, color: '#5b9bff' },
  sheet: { label: 'Building spreadsheet', icon: FileSpreadsheet, est: 70000, color: '#34d399' },
  doc: { label: 'Writing document', icon: FileText, est: 85000, color: '#7aa2ff' },
  video: { label: 'Generating video', icon: Clapperboard, est: 90000, color: '#c084fc' },
  cad: { label: 'Designing 3D model', icon: Box, est: 35000, color: '#5b9bff' },
  design: { label: 'Designing', icon: Globe, est: 80000, color: '#e879f9' },
  slides: { label: 'Building deck', icon: Presentation, est: 70000, color: '#fbbf24' },
}

export default function MediaLoader({ kind }: { kind: string }) {
  const k = KINDS[(kind as Kind) in KINDS ? (kind as Kind) : 'image']
  const [ms, setMs] = useState(0)
  const start = useRef<number>(0)

  useEffect(() => {
    start.current = Date.now()
    setMs(0)
    const id = setInterval(() => setMs(Date.now() - start.current), 200)
    return () => clearInterval(id)
  }, [kind])

  // 0→90% over the estimate, then a slow asymptotic creep 90→99% so it always
  // keeps moving (never frozen) even when a generation runs long.
  const t = ms / k.est
  const pct = t <= 1 ? 90 * (1 - Math.exp(-2.4 * t)) : Math.min(99, 90 + 9 * (1 - Math.exp(-(t - 1))))
  const elapsed = Math.floor(ms / 1000)
  const estSec = Math.round(k.est / 1000)
  const overdue = ms > k.est * 1.15
  const Icon = k.icon

  return (
    <div className="my-2 w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.1] bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <span className="relative flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${k.color}1f`, color: k.color }}>
          <span className="absolute inset-0 animate-ping rounded-xl opacity-30" style={{ background: `${k.color}22` }} />
          <Icon size={17} className="relative" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[#f0f0f0]">{k.label}…</div>
          <div className="text-[11px] tabular-nums text-[#7e8696]">
            {elapsed}s elapsed{overdue ? ' · almost there' : ` · ~${estSec}s typical`}
          </div>
        </div>
        <div className="ml-auto text-2xl font-semibold tabular-nums leading-none" style={{ color: k.color }}>
          {Math.round(pct)}<span className="text-sm font-normal text-[#7e8696]">%</span>
        </div>
      </div>
      <div className="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="relative h-full overflow-hidden rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(4, pct)}%`, background: `linear-gradient(90deg, ${k.color}99, ${k.color})` }}
        >
          <div className="nalu-sweep absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
        </div>
      </div>
    </div>
  )
}
