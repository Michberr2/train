import NaluMark from './landing/NaluMark'
import Scenery from './Scenery'
import NaluGlobe from './NaluGlobe'
import './landing/loading.css'

export default function LoadingScreen({ onSkip }: { onSkip?: () => void }) {
  return <div className="nalu-opening">
    <Scenery src="/images/bg-hills-teal.png" />
    <div className="nalu-opening-shade" />
    <div className="nalu-opening-center" role="status" aria-label="Opening Nalu">
      <NaluMark className="nalu-opening-logo" />
      <span className="nalu-opening-wordmark" aria-hidden="true">nalu</span>
      <p className="nalu-opening-caption">A little help. A little more possibility.</p>
      <div className="nalu-opening-status"><span>Opening Nalu</span><NaluGlobe size={26} /></div>
    </div>
    {onSkip && <button type="button" onClick={onSkip} className="nalu-opening-skip">Skip intro ↗</button>}
  </div>
}
