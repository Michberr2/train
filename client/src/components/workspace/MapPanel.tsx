import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, Star, MapPin, ExternalLink, Layers, Pencil, Square, Circle, Minus, Hexagon, MousePointer2, Trash2 } from 'lucide-react'

// Ploti-style real-estate map: AI/Places search, a stack of free open-source data
// layers, multiple base maps, and drawing tools (polygons/areas/markers) you can
// categorize. Drawn shapes persist. Parcel/zoning at national scale still needs a
// paid provider (Regrid/ATTOM) — everything else here is free + open.

type Place = {
  name: string; address: string; lat: number | null; lng: number | null
  rating: number | null; userRatings: number | null; priceLevel: number | null
  types: string[]; placeId: string; openNow: boolean | null; photoUrl: string | null
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GMaps = any

let mapsPromise: Promise<GMaps> | null = null
function teardownMaps() {
  document.querySelectorAll('script[src*="maps.googleapis.com/maps/api/js"]').forEach((s) => s.remove())
  try { delete (window as unknown as { google?: unknown }).google } catch { /* */ }
  mapsPromise = null
}
function loadMaps(key: string): Promise<GMaps> {
  const w = window as unknown as { google?: { maps?: unknown } }
  if (w.google?.maps) return Promise.resolve((w as { google: GMaps }).google)
  if (mapsPromise) return mapsPromise
  mapsPromise = new Promise<GMaps>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,drawing,geometry`
    s.async = true; s.defer = true
    s.onload = async () => {
      const g = (window as unknown as { google?: GMaps }).google
      try { if (g?.maps?.importLibrary) await g.maps.importLibrary('maps') } catch { /* */ }
      if (g?.maps?.Map) resolve(g)
      else reject(new Error('Google Maps loaded but the Map class is unavailable — confirm "Maps JavaScript API" is enabled.'))
    }
    s.onerror = () => reject(new Error('Failed to load Google Maps — check the API key and that Maps JavaScript API is enabled.'))
    document.head.appendChild(s)
  })
  return mapsPromise
}

const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1c2230' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0d1018' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9aa4b8' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#13202e' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a3142' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#7e8aa3' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1d2a22' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#3a4255' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
]
const GOLD = '#AF8C56'

const BASES = [
  { key: 'dark', label: 'Dark', gType: 'roadmap' as const },
  { key: 'satellite', label: 'Satellite', gType: 'hybrid' as const },
  { key: 'terrain', label: 'Terrain', gType: 'terrain' as const },
  { key: 'streets', label: 'Streets', gType: 'roadmap' as const },
]

// Web-Mercator tile bbox for ArcGIS dynamic "export" overlays.
function tileToBbox3857(x: number, y: number, z: number): [number, number, number, number] {
  const R = 20037508.342789244
  const n = Math.pow(2, z); const s = (2 * R) / n
  return [-R + x * s, R - (y + 1) * s, -R + (x + 1) * s, R - y * s]
}
type LayerDef = {
  key: string; label: string; desc: string; opacity: number; minZoom: number
  kind: 'xyz' | 'export'; url: string; layers?: string
}
const LAYERS: LayerDef[] = [
  { key: 'flood', label: 'FEMA flood zones', desc: 'National Flood Hazard Layer', kind: 'export', url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer', layers: '28', opacity: 0.6, minZoom: 13 },
  { key: 'water', label: 'Water & hydrology', desc: 'USGS National Hydrography', kind: 'export', url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer', opacity: 0.7, minZoom: 9 },
  { key: 'counties', label: 'County / state lines', desc: 'US Census TIGERweb', kind: 'export', url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer', opacity: 0.8, minZoom: 5 },
  { key: 'forests', label: 'National forests', desc: 'USDA Forest Service', kind: 'export', url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer', opacity: 0.55, minZoom: 6 },
  { key: 'topo', label: 'Topographic', desc: 'USGS Topo contours', kind: 'xyz', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile', opacity: 0.55, minZoom: 5 },
  { key: 'osm', label: 'OpenStreetMap', desc: 'Detailed streets & places', kind: 'xyz', url: 'https://tile.openstreetmap.org', opacity: 0.85, minZoom: 3 },
]
function makeOverlay(g: GMaps, def: LayerDef): GMaps {
  return new g.maps.ImageMapType({
    name: def.label,
    tileSize: new g.maps.Size(256, 256),
    opacity: def.opacity,
    getTileUrl: (coord: { x: number; y: number }, zoom: number) => {
      if (def.kind === 'xyz') {
        // USGS uses /tile/{z}/{y}/{x}; OSM uses /{z}/{x}/{y}.png
        if (def.url.includes('/MapServer/tile')) return `${def.url}/${zoom}/${coord.y}/${coord.x}`
        return `${def.url}/${zoom}/${coord.x}/${coord.y}.png`
      }
      const b = tileToBbox3857(coord.x, coord.y, zoom)
      return `${def.url}/export?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true${def.layers ? `&layers=show:${def.layers}` : ''}&f=image`
    },
  })
}

// Categories for drawing/labelling areas on the map.
const CATEGORIES = [
  { key: 'area', label: 'Area', color: '#AF8C56' },
  { key: 'residential', label: 'Residential', color: '#34d399' },
  { key: 'commercial', label: 'Commercial', color: '#5b9bff' },
  { key: 'industrial', label: 'Industrial', color: '#fbbf24' },
  { key: 'flood', label: 'Flood risk', color: '#f87171' },
  { key: 'opportunity', label: 'Opportunity', color: '#c084fc' },
]
const TOOLS = [
  { key: 'pan', label: 'Select', icon: MousePointer2 },
  { key: 'marker', label: 'Pin', icon: MapPin },
  { key: 'polyline', label: 'Line', icon: Minus },
  { key: 'polygon', label: 'Polygon', icon: Hexagon },
  { key: 'rectangle', label: 'Box', icon: Square },
  { key: 'circle', label: 'Circle', icon: Circle },
]
const priceStr = (n: number | null) => (n == null ? '' : '$'.repeat(Math.max(1, n)))
const MAP_KEYS = [
  (import.meta.env.VITE_GOOGLE_MAPS_KEY as string) || '',
  (import.meta.env.VITE_GOOGLE_MAPS_KEY2 as string) || '',
].filter(Boolean)
const SHAPES_KEY = 'nalu-map-shapes'

export default function MapPanel() {
  const [keyIdx, setKeyIdx] = useState(0)
  const key = MAP_KEYS[keyIdx] || ''
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<GMaps>(null)
  const infoRef = useRef<GMaps>(null)
  const markersRef = useRef<GMaps[]>([])
  const dmRef = useRef<GMaps>(null)
  const shapesRef = useRef<GMaps[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [authErr, setAuthErr] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [base, setBase] = useState('dark')
  const [active, setActive] = useState<Record<string, boolean>>({})
  const overlaysRef = useRef<Record<string, GMaps>>({})
  const [showLayers, setShowLayers] = useState(false)
  const [tool, setTool] = useState('pan')
  const [cat, setCat] = useState('area')
  const catRef = useRef(cat); catRef.current = cat

  useEffect(() => {
    ;(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
      if (keyIdx + 1 < MAP_KEYS.length) { teardownMaps(); setReady(false); setKeyIdx((i) => i + 1) }
      else setAuthErr(true)
    }
  }, [keyIdx])

  // ---- init map + drawing manager ----
  useEffect(() => {
    if (!key) { setErr('Map key not configured (VITE_GOOGLE_MAPS_KEY).'); return }
    let alive = true
    loadMaps(key).then((g) => {
      if (!alive || !mapEl.current) return
      const map = new g.maps.Map(mapEl.current, {
        center: { lat: 28.4, lng: -81.4 }, zoom: 6, clickableIcons: false,
        styles: DARK_STYLE, backgroundColor: '#1c2230',
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false, mapTypeId: 'roadmap',
      })
      mapRef.current = map
      infoRef.current = new g.maps.InfoWindow()
      // drawing manager
      const dm = new g.maps.drawing.DrawingManager({ drawingMode: null, drawingControl: false })
      dm.setMap(map); dmRef.current = dm
      g.maps.event.addListener(dm, 'overlaycomplete', (e: { type: string; overlay: GMaps }) => {
        const color = CATEGORIES.find((c) => c.key === catRef.current)?.color || GOLD
        const ov = e.overlay
        ov.__cat = catRef.current
        if (e.type !== 'marker') ov.setOptions?.({ fillColor: color, strokeColor: color, fillOpacity: 0.18, strokeWeight: 2, editable: false })
        shapesRef.current.push(ov)
        dm.setDrawingMode(null); setTool('pan')
        saveShapes()
      })
      restoreShapes(g, map)
      setReady(true)
    }).catch((e) => setErr(e.message))
    return () => { alive = false }
  }, [key])

  // ---- shapes persistence ----
  const saveShapes = () => {
    const g = (window as unknown as { google?: GMaps }).google
    const out = shapesRef.current.map((ov) => {
      if (ov.getPath) return { t: ov.getPaths ? 'polygon' : 'polyline', cat: ov.__cat, path: ov.getPath().getArray().map((p: GMaps) => ({ lat: p.lat(), lng: p.lng() })) }
      if (ov.getBounds) { const b = ov.getBounds(); return { t: 'rectangle', cat: ov.__cat, ne: { lat: b.getNorthEast().lat(), lng: b.getNorthEast().lng() }, sw: { lat: b.getSouthWest().lat(), lng: b.getSouthWest().lng() } } }
      if (ov.getRadius) { const c = ov.getCenter(); return { t: 'circle', cat: ov.__cat, lat: c.lat(), lng: c.lng(), r: ov.getRadius() } }
      const p = ov.getPosition(); return { t: 'marker', cat: ov.__cat, lat: p.lat(), lng: p.lng() }
    })
    try { localStorage.setItem(SHAPES_KEY, JSON.stringify(out)) } catch { /* */ }
    void g
  }
  const restoreShapes = (g: GMaps, map: GMaps) => {
    let saved: GMaps[] = []
    try { saved = JSON.parse(localStorage.getItem(SHAPES_KEY) || '[]') } catch { /* */ }
    for (const s of saved) {
      const color = CATEGORIES.find((c) => c.key === s.cat)?.color || GOLD
      const opt = { fillColor: color, strokeColor: color, fillOpacity: 0.18, strokeWeight: 2, map }
      let ov: GMaps
      if (s.t === 'polygon') ov = new g.maps.Polygon({ ...opt, paths: s.path })
      else if (s.t === 'polyline') ov = new g.maps.Polyline({ ...opt, path: s.path, fillOpacity: 0 })
      else if (s.t === 'rectangle') ov = new g.maps.Rectangle({ ...opt, bounds: { north: s.ne.lat, east: s.ne.lng, south: s.sw.lat, west: s.sw.lng } })
      else if (s.t === 'circle') ov = new g.maps.Circle({ ...opt, center: { lat: s.lat, lng: s.lng }, radius: s.r })
      else ov = new g.maps.Marker({ position: { lat: s.lat, lng: s.lng }, map })
      ov.__cat = s.cat
      shapesRef.current.push(ov)
    }
  }
  const clearShapes = () => {
    shapesRef.current.forEach((ov) => ov.setMap(null))
    shapesRef.current = []
    saveShapes()
  }

  // ---- tool selection drives the drawing manager ----
  useEffect(() => {
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !dmRef.current) return
    const OT = g.maps.drawing.OverlayType
    const map: Record<string, unknown> = { pan: null, marker: OT.MARKER, polyline: OT.POLYLINE, polygon: OT.POLYGON, rectangle: OT.RECTANGLE, circle: OT.CIRCLE }
    dmRef.current.setDrawingMode(map[tool] ?? null)
  }, [tool, ready])

  // ---- base map ----
  useEffect(() => {
    if (!mapRef.current) return
    const b = BASES.find((x) => x.key === base) || BASES[0]
    mapRef.current.setMapTypeId(b.gType)
    mapRef.current.setOptions({ styles: base === 'dark' ? DARK_STYLE : [] })
  }, [base, ready])

  const toggleLayer = (lk: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !mapRef.current) return
    const def = LAYERS.find((l) => l.key === lk)!
    const on = !active[lk]
    setActive((a) => ({ ...a, [lk]: on }))
    if (on) {
      const ov = makeOverlay(g, def)
      overlaysRef.current[lk] = ov
      mapRef.current.overlayMapTypes.push(ov)
      if (mapRef.current.getZoom() < def.minZoom) mapRef.current.setZoom(def.minZoom)
    } else {
      const idx = mapRef.current.overlayMapTypes.getArray().indexOf(overlaysRef.current[lk])
      if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
      delete overlaysRef.current[lk]
    }
  }

  const focus = (p: Place) => {
    if (!mapRef.current || p.lat == null || p.lng == null) return
    mapRef.current.panTo({ lat: p.lat, lng: p.lng }); mapRef.current.setZoom(15); setSel(p.placeId)
    infoRef.current?.setContent(`<div style="font-family:Inter,sans-serif;max-width:240px;color:#111"><div style="font-weight:600;font-size:13px">${p.name}</div><div style="font-size:11px;color:#555;margin-top:2px">${p.address}</div>${p.rating ? `<div style="font-size:11px;color:#b8860b;margin-top:3px">★ ${p.rating} (${p.userRatings || 0})</div>` : ''}</div>`)
    const mk = markersRef.current.find((m) => m.__id === p.placeId)
    if (mk) infoRef.current?.open({ map: mapRef.current, anchor: mk })
  }
  // color search markers by category (AI/Places type) — a quick "categorize".
  const typeColor = (types: string[]) => {
    const t = (types || []).join(' ')
    if (/real_estate|premise|lodging|home/.test(t)) return '#34d399'
    if (/store|shopping|restaurant|food|cafe|bar/.test(t)) return '#5b9bff'
    if (/school|hospital|government|police/.test(t)) return '#c084fc'
    if (/park|natural|campground/.test(t)) return '#86efac'
    return GOLD
  }
  const plot = (res: Place[]) => {
    const g = (window as unknown as { google: GMaps }).google
    markersRef.current.forEach((m) => m.setMap(null)); markersRef.current = []
    if (!mapRef.current || !res.length) return
    const bounds = new g.maps.LatLngBounds()
    res.forEach((p, i) => {
      if (p.lat == null || p.lng == null) return
      const mk = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map: mapRef.current,
        label: { text: String(i + 1), color: '#15170f', fontSize: '11px', fontWeight: '700' },
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 11, fillColor: typeColor(p.types), fillOpacity: 1, strokeColor: '#15170f', strokeWeight: 1.5 },
      })
      mk.__id = p.placeId; mk.addListener('click', () => focus(p)); markersRef.current.push(mk)
      bounds.extend({ lat: p.lat, lng: p.lng })
    })
    mapRef.current.fitBounds(bounds, 60)
  }

  const search = async () => {
    const q = query.trim()
    if (!q || loading) return
    setLoading(true); setErr('')
    try {
      const r = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'places', query: q }) })
      const d = (await r.json()) as { results?: Place[]; error?: string }
      if (d.error) setErr(d.error)
      const res = (d.results || []).filter((p) => p.lat != null && p.lng != null)
      setResults(res); plot(res)
      if (!res.length && !d.error) setErr('No results — try "waterfront homes in Miami".')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Search failed') } finally { setLoading(false) }
  }

  const TBtn = ({ k, label, Icon }: { k: string; label: string; Icon: typeof MapPin }) => (
    <button onClick={() => setTool(k)} title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg ${tool === k ? 'bg-[#AF8C56] text-[#15170f]' : 'bg-white/10 text-[#cfcfcf] hover:bg-white/20'}`}>
      <Icon size={15} />
    </button>
  )

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: search + results */}
      <div className="flex w-[20rem] shrink-0 flex-col border-r border-white/[0.08] bg-[#0b0e16]">
        <div className="border-b border-white/[0.08] p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#AF8C56]/15 text-[#d8b878]"><MapPin size={13} /></span>
            <span className="text-sm font-medium text-[#ededed]">Map search</span>
          </div>
          <p className="mb-2 text-[11px] text-[#8e8e8e]">Ask in plain language. Markers are colored by category.</p>
          <div className="flex items-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-2.5 py-2 focus-within:border-white/25">
            <Search size={14} className="text-[#8e8e8e]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
              placeholder="e.g. waterfront homes in Miami" className="w-full bg-transparent text-sm text-[#ededed] outline-none placeholder:text-[#5f6675]" />
            <button onClick={() => void search()} disabled={loading} className="shrink-0 text-[#AF8C56] disabled:opacity-50">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            </button>
          </div>
          {err && <div className="mt-2 text-[11px] text-amber-300/90">{err}</div>}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {results.map((p, i) => (
            <button key={p.placeId || i} onClick={() => focus(p)}
              className={`mb-1.5 flex w-full gap-2.5 rounded-xl border p-2 text-left transition-colors ${sel === p.placeId ? 'border-[#AF8C56]/50 bg-[#AF8C56]/[0.08]' : 'border-white/[0.07] hover:bg-white/[0.04]'}`}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-[#15170f]" style={{ background: typeColor(p.types) }}>{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[#ededed]">{p.name}</span>
                <span className="mt-0.5 block truncate text-[11px] text-[#8e8e8e]">{p.address}</span>
                <span className="mt-1 flex items-center gap-2 text-[10px] text-[#9a9a9a]">
                  {p.rating != null && <span className="flex items-center gap-0.5 text-[#d8b878]"><Star size={9} fill="currentColor" /> {p.rating}</span>}
                  {p.priceLevel != null && <span>{priceStr(p.priceLevel)}</span>}
                  {p.types[0] && <span className="capitalize">{p.types[0].replace(/_/g, ' ')}</span>}
                </span>
              </span>
              <a href={`https://www.google.com/maps/place/?q=place_id:${p.placeId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="mt-0.5 shrink-0 text-[#8e8e8e] hover:text-white"><ExternalLink size={12} /></a>
            </button>
          ))}
          {!results.length && !loading && !err && <div className="px-2 py-6 text-center text-[11px] text-[#6e7686]">Search to see results on the map.</div>}
        </div>
      </div>

      {/* Map + controls */}
      <div className="relative flex-1">
        <div ref={mapEl} className="h-full w-full bg-[#1c2230]" />

        {ready && (
          <>
            {/* Drawing toolbar */}
            <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-xl border border-white/[0.12] bg-black/60 p-1.5 backdrop-blur">
              {TOOLS.map((tl) => <TBtn key={tl.key} k={tl.key} label={tl.label} Icon={tl.icon} />)}
              <span className="mx-0.5 h-6 w-px bg-white/15" />
              <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-md bg-white/10 px-1.5 py-1.5 text-[11px] text-[#ededed] outline-none" title="Category for new shapes">
                {CATEGORIES.map((c) => <option key={c.key} value={c.key} className="bg-[#13151b]">{c.label}</option>)}
              </select>
              <button onClick={clearShapes} title="Clear drawings" className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-[#cfcfcf] hover:bg-red-500/30 hover:text-red-200"><Trash2 size={14} /></button>
            </div>

            {/* Base maps */}
            <div className="absolute bottom-3 left-3 flex gap-1 rounded-xl border border-white/[0.12] bg-black/60 p-1 backdrop-blur">
              {BASES.map((b) => (
                <button key={b.key} onClick={() => setBase(b.key)} className={`rounded-lg px-2.5 py-1 text-[11px] ${base === b.key ? 'bg-[#AF8C56] text-[#15170f]' : 'text-[#cfcfcf] hover:bg-white/10'}`}>{b.label}</button>
              ))}
            </div>

            {/* Layers */}
            <div className="absolute right-3 top-3">
              <button onClick={() => setShowLayers((v) => !v)} className="flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-black/60 px-2.5 py-2 text-[12px] text-[#ededed] backdrop-blur hover:bg-black/70">
                <Layers size={14} className="text-[#d8b878]" /> Layers
              </button>
              {showLayers && (
                <div className="mt-1.5 w-56 rounded-xl border border-white/[0.12] bg-black/70 p-2.5 backdrop-blur">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d8b878]">Data layers</div>
                  {LAYERS.map((l) => (
                    <button key={l.key} onClick={() => toggleLayer(l.key)} className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-white/[0.06]">
                      <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${active[l.key] ? 'border-[#AF8C56] bg-[#AF8C56]' : 'border-white/30'}`}>{active[l.key] && <span className="h-1.5 w-1.5 rounded-sm bg-[#15170f]" />}</span>
                      <span className="min-w-0"><span className="block text-[12px] font-medium text-[#ededed]">{l.label}</span><span className="block text-[10px] text-[#8e8e8e]">{l.desc}</span></span>
                    </button>
                  ))}
                  <div className="mt-1 px-1.5 text-[9px] leading-snug text-[#6e7686]">Free public layers. Parcels & zoning at national scale need a paid provider.</div>
                </div>
              )}
            </div>
            <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-black/55 px-2 py-1 text-[10px] text-[#9aa2b2] backdrop-blur">
              {tool === 'pan' ? 'Pick a tool to draw + categorize areas' : `Drawing: ${TOOLS.find((t) => t.key === tool)?.label} (${CATEGORIES.find((c) => c.key === cat)?.label})`}
            </div>
          </>
        )}

        {authErr && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0b0e16]/95 p-6">
            <div className="max-w-md text-[13px] leading-relaxed text-[#cfcfcf]">
              <div className="mb-2 text-sm font-medium text-amber-300">Google rejected the Maps key</div>
              In the Cloud Console for this project, make sure: <b>billing is enabled</b>, <b>Maps JavaScript API</b> is enabled, and the key allows the Maps JavaScript API + referrers <b>n4lu.ai</b> / <b>n4lu.com</b>. Then reload.
            </div>
          </div>
        )}
        {!ready && !err && !authErr && <div className="absolute inset-0 flex items-center justify-center text-sm text-[#8e8e8e]"><Loader2 size={18} className="mr-2 animate-spin" /> Loading map…</div>}
        {err && !ready && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-amber-300/90">{err}</div>}
      </div>
    </div>
  )
}
