import { useState } from 'react'
import Scenery from './Scenery'

export default function LoadingScreen() {
  const [bounces, setBounces] = useState(0)
  return <div role="status" aria-label="Opening Nalu" className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden">
    <Scenery src="/bg/tech.png" />
    <div className="absolute inset-0 bg-white/20 backdrop-blur-sm dark:bg-black/20" />
    <div className="relative flex flex-col items-center gap-5 rounded-3xl border border-white/25 bg-white/15 px-10 py-8 text-ink shadow-xl backdrop-blur-xl">
      <img src="/wolf-icon.png" alt="" className="h-12 w-12 brightness-0 dark:invert" />
      <p className="text-sm">Opening your space…</p>
      <button key={bounces} type="button" aria-label="Bounce the ball" title="Bounce the ball" onClick={() => setBounces(count => count + 1)} className="scenery-ball mt-3 h-9 w-9 rounded-full border border-white/50 bg-amber-300 shadow-lg" style={{ animationDuration: bounces % 2 ? '.65s' : '1.1s' }} />
      <span className="text-xs text-dim">{bounces ? `${bounces} ${bounces === 1 ? 'bounce' : 'bounces'}` : 'Give the ball a tap'}</span>
    </div>
  </div>
}
