import { useEffect, useState } from 'react'
import { BACKGROUNDS } from '../lib/backgroundAssets'
import './scenery.css'

const decoded = new Map<string, Promise<string>>()
function loadBackground(url: string): Promise<string> {
  const saved = decoded.get(url)
  if (saved) return saved
  const pending = new Promise<string>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => image.decode().then(() => resolve(url), () => resolve(url))
    image.onerror = () => { decoded.delete(url); reject(new Error('Background unavailable')) }
    image.src = url
  })
  decoded.set(url, pending)
  return pending
}

/** Show embedded scenery immediately and retain the last decoded frame during
 * a change. Versioned WebP assets use the browser's durable HTTP cache. */
export default function Scenery({ src, className = '', animateLoading = true }: { src: string; className?: string; animateLoading?: boolean }) {
  const asset = BACKGROUNDS[src] || BACKGROUNDS['/bg/tech.png']
  const [frames, setFrames] = useState({ current: '', previous: '' }), [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    const small = window.innerWidth < 768 || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
    loadBackground(small ? asset.small : asset.large).then(url => { if (alive) { setFrames(old => old.current === url ? old : { current: url, previous: old.current }); setLoading(false) } }, () => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [asset])
  return <div aria-hidden="true" data-scenery={src} data-loading={loading} className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`} style={{ backgroundImage: `url(${asset.preview})`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: '#7ba3a7' }}>
    {frames.previous && <img src={frames.previous} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />}
    {frames.current && <img key={frames.current} src={frames.current} alt="" draggable={false} onAnimationEnd={() => setFrames(old => ({ ...old, previous: '' }))} className="scenery-reveal absolute inset-0 h-full w-full object-cover" />}
    {loading && animateLoading && <div className="scenery-breeze absolute -inset-1/4" />}
  </div>
}
