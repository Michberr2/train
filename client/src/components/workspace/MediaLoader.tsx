import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import '../nalu-globe.css'

const LABELS: Record<string, string> = {
  image:'image', sheet:'spreadsheet', doc:'document', video:'video',
  cad:'3D model', design:'design', slides:'deck', email:'email',
}

/** Activity and elapsed time are real; generation does not expose a percentage. */
export default function MediaLoader({ kind, action = 'creating' }: { kind: string; action?: 'creating' | 'opening' }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    let timer: ReturnType<typeof setInterval> | undefined
    const update = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    const synchronize = () => {
      clearInterval(timer)
      update()
      if (document.visibilityState !== 'hidden') timer = setInterval(update, 1000)
    }
    synchronize()
    document.addEventListener('visibilitychange', synchronize)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', synchronize)
    }
  }, [kind, action])
  const time = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  return <div className="nalu-media-loader" role="status">
    <Loader2 size={22} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <div className="nalu-media-loader-copy">
      <span className="nalu-media-loader-title">{action === 'opening' ? 'Opening' : 'Creating'} your {LABELS[kind] || 'creation'}</span>
      <span className="nalu-media-loader-elapsed" aria-hidden="true">{time} elapsed</span>
    </div>
  </div>
}
