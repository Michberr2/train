import { useEffect, useRef, useState } from 'react'
import { NaluAvatar as AvatarRig, type AvatarPhase } from './rig.mjs'
import artwork from './nalu-avatar.png'
import './avatar.css'

/** Original interactive artwork, with application state and no demo controls. */
export default function NaluAvatar({ size = 176, phase = null }: { size?: number; phase?: AvatarPhase }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const rig = useRef<AvatarRig | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!canvas.current) return
    let disposed = false
    const fail = () => { if (!disposed) setReady(false); avatar.destroy() }
    const avatar = new AvatarRig(canvas.current, { src: artwork, onError: fail })
    rig.current = avatar
    void avatar.loaded.then(() => { if (!disposed && avatar.ready) setReady(true) }).catch(fail)
    return () => { disposed = true; avatar.destroy(); rig.current = null }
  }, [])
  useEffect(() => { rig.current?.setActivity(phase) }, [ready, phase])
  return <div className="nalu-avatar" style={{ width: size }} data-nalu-avatar data-ready={ready} data-phase={phase}>
    <div className="nalu-avatar-art">
      <img src={artwork} alt={ready ? '' : 'Nalu, a charcoal particle wolf with glowing golden eyes'} aria-hidden={ready} />
      <canvas ref={canvas} className={ready ? 'is-ready' : ''} tabIndex={ready ? 0 : -1} role="button"
        aria-hidden={!ready} aria-label="Say hi to Nalu" title="Move your cursor to guide Nalu. Click to say hi; arrow keys move the gaze." />
    </div>
  </div>
}
