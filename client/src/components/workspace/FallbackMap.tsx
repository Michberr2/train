import { useEffect, useRef, useState } from 'react'
import { cachedPlaces, reliablePlaces, project, unproject, placesViewport, type PlaceSnapshot } from './mapReliability'
import { mapPlaceUrl, type MapPlace } from './mapRequests'
import './fallback-map.css'
type View = { lat: number; lng: number; zoom: number }
export default function FallbackMap({ query: initialQuery, reason, onPrimary, initialSnapshot, initialView }: { query?: string; reason: string; initialSnapshot?: PlaceSnapshot | null; initialView?: View | null; onPrimary: () => void }) {
  const [query, setQuery] = useState(initialQuery || ''), [snapshot, setSnapshot] = useState<PlaceSnapshot | null>(() => initialSnapshot || (initialQuery ? cachedPlaces(initialQuery, initialView) : null))
  const [view, setView] = useState<View>(() => {
    const cached = initialSnapshot || (initialQuery ? cachedPlaces(initialQuery, initialView) : null)
    return placesViewport(cached?.results || [], 700, 500) || initialView || { lat: 30, lng: 0, zoom: 2 }
  })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState<string>()
  const [tiles, setTiles] = useState({ loaded: 0, failed: false, attempt: 0 }), [offline, setOffline] = useState(!navigator.onLine)
  const host = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 700, height: 500 })
  const search = useRef<AbortController | null>(null)
  const drag = useRef<{ x: number; y: number; center: { x: number; y: number }; moved: boolean }>()
  const run = async (text: string) => {
    if (!text.trim()) return
    search.current?.abort(); const request = new AbortController(); search.current = request
    setBusy(true); setError('')
    try {
      const data = await reliablePlaces(text, initialView, request.signal)
      if (search.current !== request || request.signal.aborted) return
      setSnapshot(data)
      const next = placesViewport(data.results, size.width, size.height)
      if (next) setView(next)
      if (!data.results.length) setError('No matching places were returned. Try a more specific city or category.')
    } catch (e) { if (!request.signal.aborted) setError(e instanceof Error ? e.message : 'Search is unavailable. Try again.') }
    finally { if (search.current === request) setBusy(false) }
  }
  useEffect(() => { if (initialQuery) { setQuery(initialQuery); void run(initialQuery) }; return () => search.current?.abort() }, [initialQuery])
  useEffect(() => {
    if (!host.current) return
    const resize = new ResizeObserver(entries => { const r = entries[0].contentRect; if (r.width && r.height) setSize({ width: r.width, height: r.height }) })
    resize.observe(host.current); return () => resize.disconnect()
  }, [])
  useEffect(() => {
    const update = () => {
      setOffline(!navigator.onLine)
      if (navigator.onLine) {
        setTiles(t => ({ loaded: 0, failed: false, attempt: t.attempt + 1 }))
        if (query) void run(query)
      }
    }
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [query])
  const center = project(view.lat, view.lng, view.zoom), world = 256 * 2 ** view.zoom
  const visibleTiles: { x: number; y: number; left: number; top: number; worldX: number }[] = []
  for (let y = Math.floor((center.y - size.height / 2) / 256); y <= Math.floor((center.y + size.height / 2) / 256); y++) {
    for (let x = Math.floor((center.x - size.width / 2) / 256); x <= Math.floor((center.x + size.width / 2) / 256); x++) {
      if (y >= 0 && y < 2 ** view.zoom) visibleTiles.push({ worldX: x, x: (x % 2 ** view.zoom + 2 ** view.zoom) % 2 ** view.zoom, y, left: x * 256 - center.x + size.width / 2, top: y * 256 - center.y + size.height / 2 })
    }
  }
  const pin = (p: MapPlace) => {
    const at = project(p.lat, p.lng, view.zoom), dx = ((at.x - center.x + world / 2) % world + world) % world - world / 2
    return { left: dx + size.width / 2, top: at.y - center.y + size.height / 2 }
  }
  const choose = (p: MapPlace) => { setSelected(p.id); setView(v => ({ ...v, lat: p.lat, lng: p.lng, zoom: Math.max(v.zoom, 14) })) }
  return <section className="fallback-map" aria-label="Resilient map workspace">
    <div className="fallback-map-toolbar"><span>{offline ? 'Offline map' : 'Backup map'} · {reason}</span><button onClick={onPrimary}>Retry full map</button></div>
    <div className="fallback-map-body"><aside aria-label="Map search and results"><form onSubmit={e => { e.preventDefault(); void run(query) }}><label>Find a place<input aria-label="Map search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Restaurants in Dallas"/></label><button disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</button>{busy && <button type="button" onClick={() => { search.current?.abort(); setBusy(false) }}>Stop</button>}</form>
      {error && <p role="status">{error}</p>}
      {snapshot && <p className="fallback-map-notice">Showing: {snapshot.query}</p>}
      {snapshot?.cached && <p className="fallback-map-notice" role="status">Saved results from {new Date(snapshot.savedAt).toLocaleString()}. Live availability and ratings may have changed.</p>}
      {snapshot?.source === 'osm' && <p className="fallback-map-notice">Locations from OpenStreetMap; ratings are unavailable. These are not ranked recommendations.</p>}
      <div className="fallback-map-results">{snapshot?.results.map((p, i) => <article key={p.id}><button aria-label={`Show ${p.name} on map`} aria-pressed={selected === p.id} onClick={() => choose(p)}><b>{i + 1}. {p.name}</b><span>{p.address}</span>{p.rating != null && <small>Rating {p.rating}</small>}</button><a href={mapPlaceUrl(p)} target="_blank" rel="noreferrer">Directions ↗</a></article>)}</div>
    </aside><div ref={host} className="fallback-tile-map" role="region" aria-label="Interactive fallback map" tabIndex={0}
      onPointerDown={e => { if ((e.target as Element).closest('button,a')) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, center, moved: false } }}
      onPointerMove={e => { if (!drag.current) return; const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y; drag.current.moved ||= Math.abs(dx) + Math.abs(dy) > 3; setView(v => ({ ...unproject(drag.current!.center.x - dx, drag.current!.center.y - dy, v.zoom), zoom: v.zoom })) }}
      onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}
      onKeyDown={e => { if (e.target !== e.currentTarget) return; const delta = ({ ArrowLeft: [-96, 0], ArrowRight: [96, 0], ArrowUp: [0, -96], ArrowDown: [0, 96] } as Record<string, number[]>)[e.key]; if (delta) { e.preventDefault(); setView(v => ({ ...unproject(center.x + delta[0], center.y + delta[1], v.zoom), zoom: v.zoom })) } }}>
      <div className="fallback-grid" aria-hidden="true"/>
      {visibleTiles.map(tile => <img key={`${tiles.attempt}-${view.zoom}-${tile.worldX}-${tile.y}`} src={`https://tile.openstreetmap.org/${view.zoom}/${tile.x}/${tile.y}.png`} alt="" draggable={false} style={{ left: tile.left, top: tile.top }} onLoad={() => setTiles(t => ({ ...t, loaded: t.loaded + 1 }))} onError={event => { event.currentTarget.style.visibility = 'hidden'; setTiles(t => ({ ...t, failed: true })) }}/>)}
      {snapshot?.results.map((p, i) => { const at = pin(p); return at.left > -30 && at.left < size.width + 30 && at.top > -30 && at.top < size.height + 30 ? <button key={p.id} className="fallback-map-pin" style={at} title={p.name} aria-label={`Map pin: ${p.name}`} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)}>{i + 1}</button> : null })}
      <nav className="fallback-map-controls" aria-label="Map camera"><button aria-label="Zoom in" onClick={() => setView(v => ({ ...v, zoom: Math.min(18, v.zoom + 1) }))}>+</button><button aria-label="Zoom out" onClick={() => setView(v => ({ ...v, zoom: Math.max(2, v.zoom - 1) }))}>−</button><button onClick={() => { const fit = placesViewport(snapshot?.results || [], size.width, size.height); if (fit) setView(fit) }}>Fit places</button></nav>
      {(offline || tiles.failed) && <div className="fallback-tile-notice" role="status">{offline ? 'Offline: saved locations remain usable.' : 'Some street tiles are unavailable. Location pins and controls still work.'}<button onClick={() => setTiles(t => ({ loaded: 0, failed: false, attempt: t.attempt + 1 }))}>Retry tiles</button></div>}
      {selected && snapshot?.results.find(p => p.id === selected) && <div className="fallback-map-selection"><b>{snapshot.results.find(p => p.id === selected)!.name}</b><button aria-label="Close selected place" onClick={() => setSelected(undefined)}>×</button><p>{snapshot.results.find(p => p.id === selected)!.address}</p><a href={mapPlaceUrl(snapshot.results.find(p => p.id === selected)!)} target="_blank" rel="noreferrer">Open directions ↗</a></div>}
      <span className="fallback-map-coordinate">{view.lat.toFixed(4)}, {view.lng.toFixed(4)} · zoom {view.zoom}</span><a className="fallback-map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
    </div></div>
  </section>
}
