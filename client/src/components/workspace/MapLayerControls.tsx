import { useState } from 'react'
import { Check, ChevronDown, Eye, EyeOff, Focus, Layers, Search, X } from 'lucide-react'
import { isMapBackground, mapLayerZoomRange, type MapLayerSummary } from './mapLayerDisplay'
import './mapControls.css'

type Props = {
  layers: MapLayerSummary[]; categories: { key: string; label: string }[]
  active: Record<string, boolean>; opacity: Record<string, number>; zoom: number
  hidden: boolean; solo: string | null; messages: Record<string, string>
  onToggle: (key: string) => void; onOpacity: (key: string, value: number) => void
  onSolo: (key: string | null) => void; onHidden: (value: boolean) => void
  onZoom: (layer: MapLayerSummary) => void; onExample: (layer: MapLayerSummary) => void
  onClear: () => void; onClose: () => void
}

export default function MapLayerControls(props: Props) {
  const { layers, categories, active, opacity, zoom, hidden, solo, messages } = props
  const [tab, setTab] = useState<'active' | 'browse'>(() => layers.some(l => active[l.key]) ? 'active' : 'browse')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ living: true })
  const enabled = layers.filter(l => active[l.key])
  const dataLayers = enabled.filter(l => !isMapBackground(l))
  const filtered = layers.filter(l => `${l.label} ${l.desc} ${categories.find(c => c.key === l.cat)?.label}`.toLowerCase().includes(query.trim().toLowerCase()))

  const row = (layer: MapLayerSummary, details: boolean) => {
    const on = !!active[layer.key]
    const [min, max] = mapLayerZoomRange(layer)
    const zoomOutside = zoom < min || zoom > max
    const background = isMapBackground(layer)
    const paused = !background && (hidden || !!solo && solo !== layer.key)
    return <div key={layer.key} className={`map-layer-row ${on ? 'is-active' : ''}`}>
      <div className="map-layer-heading">
        <button className="map-layer-toggle" aria-pressed={on} onClick={() => props.onToggle(layer.key)}>
          <span className="map-layer-check">{on && <Check size={13} />}</span>
          <span><strong>{layer.label}</strong><span className="map-layer-description">{details ? background ? 'Map background' : paused ? 'Temporarily hidden' : 'Data overlay' : layer.desc}</span></span>
        </button>
        {on && !background && <button className={`map-icon-button ${solo === layer.key ? 'is-selected' : ''}`} aria-label={`View only ${layer.label}`} aria-pressed={solo === layer.key} title="View this layer alone" onClick={() => props.onSolo(solo === layer.key ? null : layer.key)}><Focus size={16} /></button>}
      </div>
      {on && details && <div className="map-layer-details">
        <label className="map-opacity"><span>Opacity</span><input aria-label={`${layer.label} opacity`} type="range" min="0" max="100" step="5" value={Math.round((opacity[layer.key] ?? layer.opacity) * 100)} onChange={e => props.onOpacity(layer.key, Number(e.target.value) / 100)} /><output>{Math.round((opacity[layer.key] ?? layer.opacity) * 100)}%</output></label>
        {zoomOutside && <button className="map-zoom-hint" onClick={() => props.onZoom(layer)}>{zoom < min ? 'Zoom in' : 'Zoom out'} to see this layer <span>↗</span></button>}
        {messages[layer.key] && <p className="map-layer-status">{messages[layer.key]}</p>}
        {layer.home && <button className="map-example" onClick={() => props.onExample(layer)}>Explore an example area ↗</button>}
      </div>}
    </div>
  }

  return <section className="map-layer-panel" aria-label="Map layers">
    <header><div><Layers size={18} /><h2>Map layers</h2></div><button className="map-icon-button" aria-label="Close layers" onClick={props.onClose}><X size={18} /></button></header>
    <p className="map-layer-intro">Keep your map clear. Adjust a layer or view it on its own.</p>
    <div className="map-layer-tabs" role="tablist" aria-label="Layer views">
      <button role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')}>On the map <span>{enabled.length}</span></button>
      <button role="tab" aria-selected={tab === 'browse'} onClick={() => setTab('browse')}>Browse layers</button>
    </div>
    {tab === 'browse' && <label className="map-layer-search"><Search size={16} /><input aria-label="Search layers" placeholder={`Search ${layers.length} layers…`} value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="map-icon-button" aria-label="Clear layer filter" onClick={() => setQuery('')}><X size={14} /></button>}</label>}
    {tab === 'active' && dataLayers.length > 0 && <div className="map-layer-actions"><button aria-pressed={hidden} onClick={() => props.onHidden(!hidden)}>{hidden ? <Eye size={15} /> : <EyeOff size={15} />}{hidden ? 'Show overlays' : 'Hide overlays'}</button>{solo && <button onClick={() => props.onSolo(null)}>Exit solo view</button>}</div>}
    <div className="map-layer-scroll" role="tabpanel" aria-label={tab === 'active' ? 'On the map' : 'Browse layers'}>
      {tab === 'active' ? enabled.length ? enabled.map(layer => row(layer, true)) : <div className="map-layer-empty"><Layers size={28} /><strong>A clear starting point</strong><p>Add the information you need from the layer library.</p><button onClick={() => setTab('browse')}>Browse layers</button></div> : <>
        {categories.map(category => {
          const items = filtered.filter(l => l.cat === category.key)
          if (!items.length) return null
          const open = !!query || !!expanded[category.key]
          return <div key={category.key} className="map-layer-category"><button aria-expanded={open} onClick={() => setExpanded(v => ({ ...v, [category.key]: !open }))}><span>{category.label}</span><span>{items.length}<ChevronDown size={15} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></span></button>{open && items.map(layer => row(layer, false))}</div>
        })}
        {!filtered.length && <p className="map-layer-empty">No layers match “{query}”.</p>}
      </>}
    </div>
    <footer><span>Public data · Coverage varies by source</span>{enabled.length > 0 && <button onClick={props.onClear}>Turn all off</button>}</footer>
  </section>
}
