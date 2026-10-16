/** One request owns a map search/viewport at a time, including its later callbacks. */
export class MapRequestScope {
  private current: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  start(timeoutMs = 45_000): AbortController {
    this.cancel()
    const request = new AbortController()
    this.current = request
    this.timer = setTimeout(() => request.abort(new DOMException('Map request timed out. Please try again.', 'TimeoutError')), timeoutMs)
    return request
  }

  owns(request: AbortController): boolean { return this.current === request }
  active(request: AbortController): boolean { return this.owns(request) && !request.signal.aborted }
  check(request: AbortController): void {
    if (!this.active(request)) throw request.signal.reason || new DOMException('Request cancelled', 'AbortError')
  }

  finish(request: AbortController): void {
    if (!this.owns(request)) return
    clearTimeout(this.timer)
    this.current = null
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.current?.abort()
    this.current = null
  }
}

export async function mapJson(response: Response): Promise<Record<string, any>> {
  let body: Record<string, any>
  try { body = await response.json() } catch { throw new Error(`Map service returned an unreadable response (HTTP ${response.status}). Please try again.`) }
  if (!response.ok || body?.error) {
    const message = typeof body?.error === 'string' ? body.error : typeof body?.error?.message === 'string' ? body.error.message : `Map service unavailable (HTTP ${response.status}). Please try again.`
    throw new Error(message)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Map service returned an invalid response. Please try again.')
  return body
}

export function validMapPoint(value: unknown): value is { lat: number; lng: number } {
  if (!value || typeof value !== 'object') return false
  const point = value as { lat?: unknown; lng?: unknown }
  return typeof point.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 &&
    typeof point.lng === 'number' && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180
}

export type MapPlace = {
  id: string; name: string; address: string; lat: number; lng: number
  rating: number | null; userRatings: number | null; priceLevel: number | null
  types: string[]; placeId: string; openNow: boolean | null; photoUrl: string | null
}

export function mapPlaces(value: unknown): MapPlace[] {
  if (!Array.isArray(value)) throw new Error('Places returned an invalid response. Please try again.')
  const finite = (number: unknown) => typeof number === 'number' && Number.isFinite(number) ? number : null
  const canonical = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()
  const seen = new Set<string>()
  const results: MapPlace[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const place = raw as Record<string, unknown>
    const point = { lat: place.lat, lng: place.lng }
    if (typeof place.name !== 'string' || !place.name.trim() || !validMapPoint(point)) continue
    const name = place.name.trim()
    const address = typeof place.address === 'string' ? place.address.trim() : ''
    const placeId = typeof place.placeId === 'string' ? place.placeId.trim() : ''
    // Google IDs identify Google's records. OSM/name lookups have no Google ID;
    // their exact name/location/address identifies a result without conflating
    // different branches, co-located businesses, or the whole ID-less list.
    const id = placeId ? `google:${placeId}` : `location:${JSON.stringify([canonical(name), point.lat, point.lng, canonical(address)])}`
    if (seen.has(id)) continue
    seen.add(id)
    results.push({
      id, name, address, lat: point.lat, lng: point.lng, placeId,
      types: Array.isArray(place.types) ? place.types.filter((type): type is string => typeof type === 'string') : [],
      rating: finite(place.rating), userRatings: finite(place.userRatings), priceLevel: finite(place.priceLevel),
      openNow: typeof place.openNow === 'boolean' ? place.openNow : null,
      photoUrl: typeof place.photoUrl === 'string' ? place.photoUrl : null,
    })
    if (results.length >= 100) break
  }
  return results
}

export function mapPlaceUrl(place: MapPlace): string {
  const params = new URLSearchParams({ api: '1', query: place.placeId ? `${place.name} ${place.address}`.trim() : `${place.lat},${place.lng}` })
  if (place.placeId) params.set('query_place_id', place.placeId)
  return `https://www.google.com/maps/search/?${params}`
}

export function mapHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export function savedMapLayers(storage: Pick<Storage, 'getItem'>, key: string, knownKeys: string[]): string[] {
  try {
    const saved: unknown = JSON.parse(storage.getItem(key) || '[]')
    return Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === 'string' && knownKeys.includes(item)))] : []
  } catch { return [] }
}
