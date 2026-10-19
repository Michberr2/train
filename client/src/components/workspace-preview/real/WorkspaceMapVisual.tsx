import { useState } from 'react'
import { Layers, MapPin, Search } from 'lucide-react'
import './workspace-map-visual.css'

// The same public raster basemap available in MapPanel. This is a real map of
// the preview's sample city; it never requests the person's current location.
const ZOOM = 13
const latitude = 32.0809 * Math.PI / 180
const centerX = (-81.0912 + 180) / 360 * 2 ** ZOOM * 256
const centerY = (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2 * 2 ** ZOOM * 256
const tiles = Array.from({ length: 3 }, (_, column) => Array.from({ length: 3 }, (_, row) => {
  const x = Math.floor(centerX / 256) + column - 1
  const y = Math.floor(centerY / 256) + row - 1
  return { x, y, left: x * 256 - centerX, top: y * 256 - centerY }
})).flat().filter(tile => tile.left < 175 && tile.left + 256 > -175 && tile.top < 74 && tile.top + 256 > -74)

export default function WorkspaceMapVisual({ active }: { active: boolean }) {
  const [failed, setFailed] = useState(false)
  return <div className="workspace-map-visual" data-map-active={active} aria-hidden="true">
    <div className="workspace-map-tiles">
      {tiles.map(tile => <img key={`${tile.x}-${tile.y}`} alt="" loading="lazy" draggable={false}
        src={`https://tile.openstreetmap.org/${ZOOM}/${tile.x}/${tile.y}.png`} referrerPolicy="strict-origin-when-cross-origin"
        style={{ left: `calc(50% + ${tile.left}px)`, top: `calc(50% + ${tile.top}px)` }} onError={() => setFailed(true)}/>)}
    </div>
    <div className="workspace-map-preview-search"><Search size={9}/><span>Savannah, Georgia</span></div>
    <div className="workspace-map-preview-pin"><MapPin size={16} strokeWidth={1.4}/></div>
    <span className="workspace-map-preview-layers"><Layers size={12} strokeWidth={1}/></span>
    {failed && <span className="workspace-map-preview-error">Map preview unavailable</span>}
    <span className="workspace-map-preview-credit">© OpenStreetMap contributors</span>
  </div>
}
