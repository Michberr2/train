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
    <div className="my-2 w-full max-w-md rounded-2xl border border-white/[0.12] bg-white/[0.04] p-4 backdrop-blur-xl">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: `${k.color}22`, color: k.color }}>
          <Icon size={15} />
        </span>
        <span className="text-sm font-medium text-[#ededed]">{k.label}…</span>
        <span className="ml-auto text-xs tabular-nums text-[#8e8e8e]">
          {elapsed}s{overdue ? ' · finishing up' : ` · ~${estSec}s`}
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${k.color}66, ${k.color})` }}
        />
      </div>
      <div className="mt-2 text-[11px] text-[#6e7686]">Deep build — usually ~{estSec}s. It appears here when ready.</div>
    </div>
  )
}
