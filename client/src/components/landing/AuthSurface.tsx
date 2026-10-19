import Scenery from '../Scenery'
import NaluMark from './NaluMark'
import './auth.css'

export function AuthScene() {
  return <><Scenery src="/images/bg-hills-teal.png" /><div className="nalu-auth-shade" /><div className="nalu-auth-grid" aria-hidden="true" /></>
}

export function AuthBrand() {
  return <div className="nalu-auth-brand"><NaluMark /><span>nalu</span><small>YOUR IDEAS.<br />IN GOOD COMPANY.</small></div>
}
