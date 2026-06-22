import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, Star, MapPin, ExternalLink } from 'lucide-react'

// Ploti-style real-estate / "find stuff" map. Natural-language search → Google
// Places (via /api/web) → plotted on a Google Map with result cards. Parcel-level
// data (zoning/flood/ownership) needs a paid provider — see the note in chat.

type Place = {
  name: string; address: string; lat: number | null; lng: number | null
  rating: number | null; userRatings: number | null; priceLevel: number | null
  types: string[]; placeId: string; openNow: boolean | null; photoUrl: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GMaps = any
let mapsPromise: Promise<GMaps> | null = null
function loadMaps(key: string): Promise<GMaps> {
  const w = window as unknown as { google?: { maps?: unknown } }
  if (w.google?.maps) return Promise.resolve((w as { google: GMaps }).google)
  if (mapsPromise) return mapsPromise
  mapsPromise = new Promise<GMaps>((resolve, reject) => {
    const s = document.createElement('script')
    // No loading=async: we want google.maps.Map ready synchronously on onload.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,marker`
    s.async = true
    s.defer = true
    s.onload = async () => {
      const g = (window as unknown as { google?: GMaps }).google
      try {
        // Ensure the core classes are materialized (newer API loads on demand).
        if (g?.maps?.importLibrary) await g.maps.importLibrary('maps')
      } catch { /* fall through; classic access below */ }
      if (g?.maps?.Map) resolve(g)
      else reject(new Error('Google Maps loaded but the Map class is unavailable — confirm "Maps JavaScript API" is enabled for this key.'))
    }
    s.onerror = () => reject(new Error('Failed to load Google Maps — check the API key and that Maps JavaScript API is enabled.'))
    document.head.appendChild(s)
  })
  return mapsPromise
}

// A muted dark map style to match the app.
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
const priceStr = (n: number | null) => (n == null ? '' : '$'.repeat(Math.max(1, n)))

// ── Data layers (free, nationwide, public ArcGIS services) ───────────────────
// Rendered as Google Maps image overlays computed per map tile. These are the
// real regulatory layers (flood/wetlands) ploti shows; parcel/zoning at national
// scale needs a paid provider (Regrid/ATTOM) — wired behind a key when available.
function tileToBbox3857(x: number, y: number, z: number): [number, number, number, number] {
  const R = 20037508.342789244
  const n = Math.pow(2, z)
  const s = (2 * R) / n
  return [-R + x * s, R - (y + 1) * s, -R + (x + 1) * s, R - y * s]
}
type LayerDef = { key: string; label: string; desc: string; base: string; layers: string; opacity: number }
const LAYERS: LayerDef[] = [
  { key: 'flood', label: 'FEMA flood zones', desc: 'National Flood Hazard Layer', base: 'https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer', layers: '28', opacity: 0.55 },
  { key: 'wetlands', label: 'Wetlands', desc: 'USFWS National Wetlands Inventory', base: 'https://www.fws.gov/wetlandsmapservice/rest/services/Wetlands/MapServer', layers: '0', opacity: 0.6 },
]
function makeOverlay(g: GMaps, def: LayerDef): GMaps {
  return new g.maps.ImageMapType({
    name: def.label,
    tileSize: new g.maps.Size(256, 256),
    opacity: def.opacity,
    getTileUrl: (coord: { x: number; y: number }, zoom: number) => {
      const b = tileToBbox3857(coord.x, coord.y, zoom)
      return `${def.base}/export?bbox=${b.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true&layers=show:${def.layers}&f=image`
    },
  })
}

export default function MapPanel() {
  const key = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string) || ''
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<GMaps>(null)
  const infoRef = useRef<GMaps>(null)
  const markersRef = useRef<GMaps[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [active, setActive] = useState<Record<string, boolean>>({})
  const overlaysRef = useRef<Record<string, GMaps>>({})

  const toggleLayer = (key: string) => {
    const g = (window as unknown as { google?: GMaps }).google
    if (!g || !mapRef.current) return
    const def = LAYERS.find((l) => l.key === key)!
    const on = !active[key]
    setActive((a) => ({ ...a, [key]: on }))
    if (on) {
      const ov = makeOverlay(g, def)
      overlaysRef.current[key] = ov
      mapRef.current.overlayMapTypes.push(ov)
    } else {
      const ov = overlaysRef.current[key]
      const idx = mapRef.current.overlayMapTypes.getArray().indexOf(ov)
      if (idx >= 0) mapRef.current.overlayMapTypes.removeAt(idx)
      delete overlaysRef.current[key]
    }
  }

  useEffect(() => {
    if (!key) { setErr('Map key not configured (VITE_GOOGLE_MAPS_KEY).'); return }
    let alive = true
    loadMaps(key)
      .then((g) => {
        if (!alive || !mapEl.current) return
        mapRef.current = new g.maps.Map(mapEl.current, {
          center: { lat: 28.4, lng: -81.4 }, // central FL like the demo
          zoom: 6, disableDefaultUI: false, clickableIcons: false,
          styles: DARK_STYLE, backgroundColor: '#1c2230',
          mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
        })
        infoRef.current = new g.maps.InfoWindow()
        setReady(true)
      })
      .catch((e) => setErr(e.message))
    return () => { alive = false }
  }, [key])

  const focus = (p: Place) => {
    const g = (window as unknown as { google: GMaps }).google
    if (!mapRef.current || p.lat == null || p.lng == null) return
    mapRef.current.panTo({ lat: p.lat, lng: p.lng })
    mapRef.current.setZoom(15)
    setSel(p.placeId)
    infoRef.current?.setContent(
      `<div style="font-family:Inter,sans-serif;max-width:240px;color:#111">
        <div style="font-weight:600;font-size:13px">${p.name}</div>
        <div style="font-size:11px;color:#555;margin-top:2px">${p.address}</div>
        ${p.rating ? `<div style="font-size:11px;color:#b8860b;margin-top:3px">★ ${p.rating} (${p.userRatings || 0})</div>` : ''}
      </div>`,
    )
    const mk = markersRef.current.find((m) => m.__id === p.placeId)
    if (mk) infoRef.current?.open({ map: mapRef.current, anchor: mk })
    void g
  }

  const plot = (res: Place[]) => {
    const g = (window as unknown as { google: GMaps }).google
    markersRef.current.forEach((m) => m.setMap(null))
    markersRef.current = []
    if (!mapRef.current || !res.length) return
    const bounds = new g.maps.LatLngBounds()
    res.forEach((p, i) => {
      if (p.lat == null || p.lng == null) return
      const mk = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map: mapRef.current,
        label: { text: String(i + 1), color: '#15170f', fontSize: '11px', fontWeight: '700' },
        icon: {
          path: g.maps.SymbolPath.CIRCLE, scale: 11, fillColor: GOLD, fillOpacity: 1,
          strokeColor: '#15170f', strokeWeight: 1.5,
        },
      })
      mk.__id = p.placeId
      mk.addListener('click', () => focus(p))
      markersRef.current.push(mk)
      bounds.extend({ lat: p.lat, lng: p.lng })
    })
    mapRef.current.fitBounds(bounds, 60)
  }

  const search = async () => {
    const q = query.trim()
    if (!q || loading) return
    setLoading(true); setErr('')
    try {
      const r = await fetch('/api/web', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'places', query: q }),
      })
      const d = (await r.json()) as { results?: Place[]; error?: string }
      if (d.error) setErr(d.error)
      const res = (d.results || []).filter((p) => p.lat != null && p.lng != null)
      setResults(res)
      plot(res)
      if (!res.length && !d.error) setErr('No results — try a place + what to find, e.g. "waterfront homes in Miami".')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  const EXAMPLES = ['Waterfront homes in Miami', 'Land for sale near Orlando', 'New construction in Tampa', 'Apartments in Winter Park FL']

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: search + results */}
      <div className="flex w-[20rem] shrink-0 flex-col border-r border-white/[0.08] bg-[#0b0e16]">
        <div className="border-b border-white/[0.08] p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#AF8C56]/15 text-[#d8b878]"><MapPin size={13} /></span>
            <span className="text-sm font-medium text-[#ededed]">Map search</span>
          </div>
          <p className="mb-2 text-[11px] text-[#8e8e8e]">Ask in plain language. Nalu finds and plots it on the map.</p>
          <div className="flex items-center gap-1.5 rounded-xl border border-white/[0.12] bg-white/[0.04] px-2.5 py-2 focus-within:border-white/25">
            <Search size={14} className="text-[#8e8e8e]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
              placeholder="e.g. waterfront homes in Miami"
              className="w-full bg-transparent text-sm text-[#ededed] outline-none placeholder:text-[#5f6675]"
            />
            <button onClick={() => void search()} disabled={loading} className="shrink-0 text-[#AF8C56] disabled:opacity-50">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            </button>
          </div>
          {!results.length && !loading && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((e) => (
                <button key={e} onClick={() => { setQuery(e); setTimeout(() => void search(), 0) }}
                  className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-[#9a9a9a] hover:border-[#AF8C56]/40 hover:text-[#d8b878]">
                  {e}
                </button>
              ))}
            </div>
          )}
          {err && <div className="mt-2 text-[11px] text-amber-300/90">{err}</div>}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {results.map((p, i) => (
            <button key={p.placeId || i} onClick={() => focus(p)}
              className={`mb-1.5 flex w-full gap-2.5 rounded-xl border p-2 text-left transition-colors ${sel === p.placeId ? 'border-[#AF8C56]/50 bg-[#AF8C56]/[0.08]' : 'border-white/[0.07] hover:bg-white/[0.04]'}`}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#AF8C56] text-[10px] font-bold text-[#15170f]">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[#ededed]">{p.name}</span>
                <span className="mt-0.5 block truncate text-[11px] text-[#8e8e8e]">{p.address}</span>
                <span className="mt-1 flex items-center gap-2 text-[10px] text-[#9a9a9a]">
                  {p.rating != null && <span className="flex items-center gap-0.5 text-[#d8b878]"><Star size={9} fill="currentColor" /> {p.rating}</span>}
                  {p.priceLevel != null && <span>{priceStr(p.priceLevel)}</span>}
                  {p.openNow != null && <span className={p.openNow ? 'text-emerald-400' : 'text-red-400'}>{p.openNow ? 'Open' : 'Closed'}</span>}
                  {p.types[0] && <span className="capitalize">{p.types[0].replace(/_/g, ' ')}</span>}
                </span>
              </span>
              <a href={`https://www.google.com/maps/place/?q=place_id:${p.placeId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                className="mt-0.5 shrink-0 text-[#8e8e8e] hover:text-white" title="Open in Google Maps"><ExternalLink size={12} /></a>
            </button>
          ))}
          {!results.length && !loading && !err && (
            <div className="px-2 py-6 text-center text-[11px] text-[#6e7686]">Search to see results on the map.</div>
          )}
        </div>
      </div>

      {/* Map */}
      <div className="relative flex-1">
        <div ref={mapEl} className="h-full w-full bg-[#1c2230]" />

        {/* Data layers */}
        {ready && (
          <div className="absolute right-3 top-3 w-52 rounded-xl border border-white/[0.12] bg-black/60 p-2.5 backdrop-blur">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#d8b878]">Data layers</div>
            {LAYERS.map((l) => (
              <button key={l.key} onClick={() => toggleLayer(l.key)}
                className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-white/[0.06]">
                <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${active[l.key] ? 'border-[#AF8C56] bg-[#AF8C56]' : 'border-white/30'}`}>
                  {active[l.key] && <span className="h-1.5 w-1.5 rounded-sm bg-[#15170f]" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-[#ededed]">{l.label}</span>
                  <span className="block text-[10px] text-[#8e8e8e]">{l.desc}</span>
                </span>
              </button>
            ))}
            <div className="mt-1 px-1.5 text-[9px] leading-snug text-[#6e7686]">Parcels & zoning at national scale need a paid data provider.</div>
          </div>
        )}

        {!ready && !err && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[#8e8e8e]"><Loader2 size={18} className="mr-2 animate-spin" /> Loading map…</div>
        )}
        {err && !ready && (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-amber-300/90">{err}</div>
        )}
      </div>
    </div>
  )
}
