import { getToken } from '../../lib/localAuth'
import { mapJson, mapPlaces, type MapPlace } from './mapRequests'
export type PlaceSnapshot = { query: string; results: MapPlace[]; source: string; savedAt: number; cached: boolean }
const CACHE = 'nalu-map-place-cache-v1'
export function placeRequest(query: string, bias?: { lat?: number; lng?: number } | null) {
  const area = /\bin\s+([^?!]+?)[.!?]*$/i.exec(query), near = area?.[1]?.trim()
  return { action: 'places', query: near ? query.slice(0, area!.index).trim() : query, ...(near ? { near } : {}),
    ...(!near && Number.isFinite(bias?.lat) && Number.isFinite(bias?.lng) ? { lat: bias!.lat, lng: bias!.lng } : {}) }
}
function owner(): string { try { return localStorage.getItem('nalu-data-owner') || '' } catch { return '' } }
function cacheKey(query: string, bias?: { lat?: number; lng?: number } | null) { return JSON.stringify(placeRequest(query.trim().toLowerCase(), bias)) }
export function cachedPlaces(query: string, bias?: { lat?: number; lng?: number } | null): PlaceSnapshot | null {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE) || '{}')
    if (!owner() || data.owner !== owner()) return null
    const item = data.entries?.[cacheKey(query, bias)]
    if (!item || !Number.isFinite(item.savedAt)) return null
    return { query, results: mapPlaces(item.results), source: String(item.source || 'provider'), savedAt: item.savedAt, cached: true }
  } catch { return null }
}
function save(query: string, bias: { lat?: number; lng?: number } | null | undefined, snapshot: PlaceSnapshot) {
  try {
    const id = owner(); if (!id) return
    const data = JSON.parse(localStorage.getItem(CACHE) || '{}')
    const entries = data.owner === id && data.entries && typeof data.entries === 'object' ? data.entries : {}
    entries[cacheKey(query, bias)] = snapshot
    const recent = Object.entries(entries).sort(([, a], [, b]) => Number((b as PlaceSnapshot).savedAt) - Number((a as PlaceSnapshot).savedAt)).slice(0, 8)
    localStorage.setItem(CACHE, JSON.stringify({ owner: id, entries: Object.fromEntries(recent) }))
  } catch { /* A full browser cache must not prevent live results. */ }
}
export async function reliablePlaces(query: string, bias?: { lat?: number; lng?: number } | null, signal?: AbortSignal): Promise<PlaceSnapshot> {
  const token = getToken(), account = owner()
  const current = () => token === getToken() && account === owner()
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const saved = current() ? cachedPlaces(query, bias) : null
    if (saved) return saved
    throw new Error('You are offline. Saved map locations remain available; reconnect to search for new places.')
  }
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted || !current()) throw signal?.reason || new DOMException('Account or search changed', 'AbortError')
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('Place search timed out', 'TimeoutError')), attempt ? 12000 : 20000)
    try {
      const response = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(placeRequest(query, bias)), signal: controller.signal })
      const data = await mapJson(response)
      if (!current() || signal?.aborted) throw new DOMException('Account or search changed', 'AbortError')
      const snapshot = { query, results: mapPlaces(data.results), source: typeof data.source === 'string' ? data.source : 'provider', savedAt: Date.now(), cached: false }
      save(query, bias, snapshot)
      return snapshot
    } catch (error) { failure = error; if (signal?.aborted || !current()) throw signal?.reason || error }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  const saved = current() ? cachedPlaces(query, bias) : null
  if (saved) return saved
  const detail = failure instanceof Error && failure.name !== 'TypeError' ? ` ${failure.message}` : ''
  throw new Error(`Place search is temporarily unavailable.${detail} Your map is still usable. Try again shortly.`)
}
export function project(lat: number, lng: number, zoom: number) {
  const size = 256 * 2 ** zoom, clamped = Math.max(-85.05112878, Math.min(85.05112878, lat)), sin = Math.sin(clamped * Math.PI / 180)
  return { x: (lng + 180) / 360 * size, y: (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size }
}
export function unproject(x: number, y: number, zoom: number) {
  const size = 256 * 2 ** zoom, n = Math.PI - 2 * Math.PI * Math.max(0, Math.min(size, y)) / size
  return { lng: ((x / size * 360 - 180 + 180) % 360 + 360) % 360 - 180, lat: Math.atan(Math.sinh(n)) * 180 / Math.PI }
}
export function placesViewport(places: MapPlace[], width: number, height: number) {
  if (!places.length) return null
  const lats = places.map(p => p.lat), lngs = places.map(p => p.lng)
  const center = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lngs) + Math.max(...lngs)) / 2 }
  let zoom = places.length === 1 ? 14 : 15
  while (zoom > 2) {
    const points = places.map(p => project(p.lat, p.lng, zoom))
    if (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) < Math.max(120, width - 90) && Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) < Math.max(120, height - 100)) break
    zoom--
  }
  return { ...center, zoom }
}
