import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import { X, Orbit, Mountain, Satellite, Map as MapIcon } from 'lucide-react'

// Real 3D — MapLibre GL globe with 3D terrain (free AWS DEM), 3D buildings + streets
// (OpenFreeMap), and satellite (Esri). Tilt / rotate / pitch work EVERYWHERE (vector),
// unlike Google's oblique imagery that only exists in a few big cities. All free, no key.
// Opened over the existing Google map from the "3D" button, centered on the current view.

const STREETS_STYLE = 'https://tiles.openfreemap.org/styles/liberty' // vector: 3D buildings + streets + labels
const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
// MapLibre 6 ships a separate module worker. Its relative runtime URL cannot
// survive Vite's dependency optimizer or hashed chunks; emit it as a real asset.
maplibregl.setWorkerUrl(mapWorkerUrl)

export type MapCameraRequest =
  | { kind: 'point'; lat: number; lng: number; zoom: number }
  | { kind: 'bounds'; bounds: [[number, number], [number, number]]; padding: number }

export default function MapGlobe3D({ center, zoom, cameraRequest, onClose }: { center: { lat: number; lng: number }; zoom: number; cameraRequest?: MapCameraRequest; onClose: () => void }) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const spinRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [sat, setSat] = useState(false)
  const [exag, setExag] = useState(1.4)
  const [spinning, setSpinning] = useState(false)

  useEffect(() => {
    if (!elRef.current) return
    setReady(false); setError(''); setSpinning(false)
    let map: maplibregl.Map
    try { map = new maplibregl.Map({
      container: elRef.current,
      style: STREETS_STYLE,
      center: [center.lng, center.lat],
      zoom: Math.max(3, Math.min(zoom, 17)),
      pitch: 62,
      bearing: -20,
      maxPitch: 85,
      attributionControl: { compact: true },
    }) } catch {
      setError('3D could not start on this device. Retry or return to the map.')
      return
    }
    mapRef.current = map
    let loaded = false
    const timeout = setTimeout(() => { if (!loaded) setError('3D is taking too long to load. Check your connection and retry.') }, 20_000)
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(elRef.current)
    map.on('error', (event) => {
      if (!loaded && !('sourceId' in event)) setError('The 3D map could not load. Check your connection and retry.')
    })
    map.on('webglcontextlost', () => { setError('3D graphics were interrupted. Retry or return to the map.'); setSpinning(false) })
    map.on('dragstart', () => setSpinning(false))
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left')
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-left')

    map.on('load', () => {
      loaded = true
      clearTimeout(timeout)
      setError('')
      try {
        map.addSource('nalu-terrain', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
        map.setTerrain({ source: 'nalu-terrain', exaggeration: exag })
      } catch { /* terrain optional */ }
      try { map.setSky({ 'sky-color': '#0b1a33', 'sky-horizon-blend': 0.5, 'horizon-color': '#88a0c0', 'horizon-fog-blend': 0.6, 'fog-color': '#dfe8f2', 'fog-ground-blend': 0.4 }) } catch { /* */ }
      try { (map as unknown as { setProjection: (p: unknown) => void }).setProjection({ type: 'globe' }) } catch { /* older maplibre */ }
      // satellite raster, hidden until toggled — inserted under the first label layer
      try {
        map.addSource('nalu-sat', { type: 'raster', tiles: [SAT_TILES], tileSize: 256, attribution: 'Imagery © Esri' })
        const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id
        map.addLayer({ id: 'nalu-sat', type: 'raster', source: 'nalu-sat', layout: { visibility: 'none' } }, firstSymbol)
      } catch { /* */ }
      setReady(true)
    })
    return () => { clearTimeout(timeout); observer.disconnect(); if (spinRef.current) cancelAnimationFrame(spinRef.current); map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  // Satellite / streets toggle.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    try { map.setLayoutProperty('nalu-sat', 'visibility', sat ? 'visible' : 'none') } catch { /* */ }
  }, [sat, ready])

  // Terrain exaggeration.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    try { map.setTerrain({ source: 'nalu-terrain', exaggeration: exag }) } catch { /* */ }
  }, [exag, ready])

  // A new request represents explicit navigation (search/focus), including
  // clicking the same result again. Other parent renders keep its identity and
  // therefore preserve the user's camera/orbit. Updates queued during loading
  // apply when this map is ready.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !cameraRequest) return
    cancelAnimationFrame(spinRef.current); spinRef.current = 0
    setSpinning(false)
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700
    if (cameraRequest.kind === 'bounds') map.fitBounds(cameraRequest.bounds, { padding: cameraRequest.padding, maxZoom: 17, duration })
    else map.flyTo({ center: [cameraRequest.lng, cameraRequest.lat], zoom: cameraRequest.zoom, duration })
  }, [cameraRequest, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !spinning || !ready || error) return
    let last = 0
    const step = (time: number) => {
      if (mapRef.current !== map) return
      if (last) map.setBearing((map.getBearing() + Math.min(time - last, 64) * 0.0108) % 360)
      last = time
      spinRef.current = requestAnimationFrame(step)
    }
    spinRef.current = requestAnimationFrame(step)
    const onHidden = () => { if (document.hidden) setSpinning(false) }
    document.addEventListener('visibilitychange', onHidden)
    return () => { cancelAnimationFrame(spinRef.current); spinRef.current = 0; document.removeEventListener('visibilitychange', onHidden) }
  }, [spinning, ready, error])

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [onClose])

  return (
    <div role="region" aria-label="3D map" className="map-globe-3d absolute inset-0 z-10">
      <div ref={elRef} className="h-full w-full" />
      {!ready && !error && (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white/80 backdrop-blur-sm">Loading 3D…</div>
      )}
      {error && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center text-sm text-white"><p role="alert">{error}</p><button onClick={() => setAttempt((value) => value + 1)} className="rounded-lg border border-white/30 px-3 py-2">Retry 3D</button><button onClick={onClose} className="rounded-lg px-3 py-2 underline">Return to map</button></div>}
      {/* Toolbar */}
      <div className="absolute bottom-10 left-3 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-1 rounded-xl border border-white/15 bg-black/60 p-1 backdrop-blur">
        <button disabled={!ready || !!error} onClick={() => setSat((s) => !s)} title={sat ? 'Streets + 3D buildings' : 'Satellite imagery'} className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium disabled:opacity-40 ${sat ? 'bg-white/15 text-white' : 'text-white/85 hover:bg-white/10'}`}>
          {sat ? <MapIcon size={14} /> : <Satellite size={14} />} {sat ? 'Streets' : 'Satellite'}
        </button>
        <button disabled={!ready || !!error} onClick={() => setSpinning((value) => !value)} aria-label="Auto-orbit" aria-pressed={spinning} title="Auto-orbit" className={`flex h-8 w-8 items-center justify-center rounded-lg disabled:opacity-40 ${spinning ? 'bg-white/15 text-white' : 'text-white/85 hover:bg-white/10'}`}>
          <Orbit size={15} className={spinning ? 'animate-spin' : ''} />
        </button>
        <label className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-white/85" title="Terrain exaggeration">
          <Mountain size={14} />
          <input aria-label="Terrain exaggeration" disabled={!ready || !!error} type="range" min={0} max={3} step={0.1} value={exag} onChange={(e) => setExag(Number(e.target.value))} className="h-1 w-16 cursor-pointer accent-amber-400" />
        </label>
        <span className="mx-0.5 h-5 w-px bg-white/15" />
        <button onClick={onClose} aria-label="Exit 3D" title="Exit 3D" className="flex h-8 w-8 items-center justify-center rounded-lg text-white/85 hover:bg-red-500/40 hover:text-white"><X size={15} /></button>
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white/70 backdrop-blur">Drag to rotate · right-drag to tilt · scroll to zoom</div>
    </div>
  )
}
