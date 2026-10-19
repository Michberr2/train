// Place provider requests share a deadline, including JSON body reads.
// Public POI queries only; account identity stays in the /api/web handler.
const UA = 'Nalu/1.0 (+https://n4lu.ai)'
const PLACES_BUDGET_MS = 22_000
const GOOGLE_BUDGET_MS = 4_000
const GEOCODER_BUDGET_MS = 5_000
const OVERPASS_BUDGET_MS = 12_000
// A slow first pair must not consume the entire 12s group deadline before the
// remaining mirrors get a useful turn.
const MIRROR_BUDGET_MS = 3_500
const MIRROR_HEDGE_MS = 1_500

/** Bounds transport and body parsing, even if a provider ignores cancellation. */
function withinBudget<T>(milliseconds: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort() // stop unfinished body reads and losing mirror requests
      if (error) reject(error)
      else resolve(value as T)
    }
    const onAbort = () => finish(controller.signal.reason || new DOMException('Place search cancelled', 'AbortError'))
    const onParentAbort = () => controller.abort(parent?.reason)
    const timer = setTimeout(() => controller.abort(new DOMException('Place search timed out. Please try again.', 'TimeoutError')), milliseconds)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    parent?.addEventListener('abort', onParentAbort, { once: true })
    if (parent?.aborted) { onParentAbort(); return }
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason
      return work(controller.signal)
    }).then((value) => finish(null, value), (error) => finish(error))
  })
}

function providerJson(url: string, init: RequestInit, parent: AbortSignal, milliseconds: number): Promise<unknown> {
  return withinBudget(milliseconds, parent, async (signal) => {
    const response = await fetch(url, { ...init, signal })
    if (!response.ok) throw new Error(`Place provider returned HTTP ${response.status}`)
    return await response.json()
  })
}

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
}
// ---- Free OpenStreetMap fallback (no key) — used when Google Places is not
// enabled/configured, so the map search bar always returns real pins. Category
// queries ("coffee shops", "hotels") go to Overpass; everything else to Nominatim.
type Pin = {
  name: string; address: string; lat: number | null; lng: number | null
  rating: number | null; userRatings: number | null; priceLevel: number | null
  types: string[]; placeId: string; openNow: boolean | null; photoUrl: null
}
const pin = (o: Partial<Pin>): Pin => ({
  name: '', address: '', lat: null, lng: null, rating: null, userRatings: null,
  priceLevel: null, types: [], placeId: '', openNow: null, photoUrl: null, ...o,
})
const OVERPASS_EPS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
// keyword → OSM tag for the common POI categories people search for.
const OSM_TAGS: Array<{ re: RegExp; tag: string }> = [
  { re: /\b(coffee|caf[eé]s?|espresso)\b/i, tag: 'amenity=cafe' },
  { re: /\b(restaurants?|dining|eat|food|diner)\b/i, tag: 'amenity=restaurant' },
  { re: /\b(fast ?food|burgers?|pizza|takeout)\b/i, tag: 'amenity=fast_food' },
  { re: /\b(bars?|pubs?|brewery|breweries|nightlife)\b/i, tag: 'amenity=bar' },
  { re: /\b(hotels?|motels?|lodging|inn|stay|resort)\b/i, tag: 'tourism=hotel' },
  { re: /\b(gyms?|fitness|workout)\b/i, tag: 'leisure=fitness_centre' },
  { re: /\b(pharmac(y|ies)|drug ?stores?)\b/i, tag: 'amenity=pharmacy' },
  { re: /\b(gas|fuel|petrol|gas ?stations?)\b/i, tag: 'amenity=fuel' },
  { re: /\b(grocer(y|ies)|supermarkets?|markets?)\b/i, tag: 'shop=supermarket' },
  { re: /\b(banks?|atm)\b/i, tag: 'amenity=bank' },
  { re: /\b(hospitals?|emergency ?rooms?)\b/i, tag: 'amenity=hospital' },
  { re: /\b(clinics?|doctors?|urgent ?care)\b/i, tag: 'amenity=clinic' },
  { re: /\b(schools?)\b/i, tag: 'amenity=school' },
  { re: /\b(parks?|playgrounds?)\b/i, tag: 'leisure=park' },
  { re: /\b(parking|garages?)\b/i, tag: 'amenity=parking' },
  { re: /\b(stores?|shops?|retail|shopping)\b/i, tag: 'shop=*' },
]
type GeoPlace = { lat: string; lon: string; name?: string; display_name: string; boundingbox?: string[]; type?: string; class?: string; category?: string }
async function nominatim(q: string, signal: AbortSignal, bounds?: [string, string, string, string]): Promise<GeoPlace[]> {
  const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '0', limit: '20', q })
  if (bounds) {
    const [south, north, west, east] = bounds
    params.set('viewbox', `${west},${south},${east},${north}`)
    params.set('bounded', '1')
  }
  const u = `https://nominatim.openstreetmap.org/search?${params}`
  const result = await providerJson(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } }, signal, GEOCODER_BUDGET_MS)
  if (!Array.isArray(result)) throw new Error('Invalid geocoder response')
  return result
}
function geoPins(places: GeoPlace[]): Pin[] {
  const coordinate = (value: unknown, limit: number) =>
    (typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0)) && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit
  return places.filter(g => g && typeof g === 'object' && typeof g.display_name === 'string' && g.display_name.trim() && coordinate(g.lat, 90) && coordinate(g.lon, 180))
    .slice(0, 20).map(g => pin({
      name: typeof g.name === 'string' && g.name.trim() ? g.name : g.display_name.split(',')[0], address: g.display_name,
      lat: Number(g.lat), lng: Number(g.lon), types: [g.category || g.class || g.type || ''].filter(Boolean),
    }))
}
// Run an Overpass category query inside a [south, north, west, east] bbox,
// trying a delayed second mirror only if the first is slow. Returns named POIs.
async function overpassInBbox(tag: string, bb: [string, string, string, string], parent: AbortSignal): Promise<Pin[]> {
  const [s, n, w, e] = bb
  const [k, v] = tag.split('=')
  const sel = v === '*' ? `["${k}"]` : `["${k}"="${v}"]`
  const ql = `[out:json][timeout:10];(node${sel}(${s},${w},${n},${e});way${sel}(${s},${w},${n},${e}););out center 50;`
  return withinBudget(OVERPASS_BUDGET_MS, parent, (signal) => new Promise((resolve, reject) => {
    let next = 0
    let active = 0
    let settled = false
    let hedge: ReturnType<typeof setTimeout> | undefined
    const finish = (error: unknown, pins?: Pin[]) => {
      if (settled) return
      settled = true
      clearTimeout(hedge)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(pins || [])
    }
    const onAbort = () => finish(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const launch = () => {
      if (settled || signal.aborted || next >= OVERPASS_EPS.length) return
      const ep = OVERPASS_EPS[next++]
      active++
      providerJson(ep, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Accept: 'application/json' },
        body: 'data=' + encodeURIComponent(ql),
      }, signal, MIRROR_BUDGET_MS).then((value) => {
        const d = value as { remark?: string; elements?: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> }
        if (!Array.isArray(d?.elements) || (typeof d.remark === 'string' && /runtime error|timed out|rate limit/i.test(d.remark))) throw new Error('Invalid place provider response')
        const pins = d.elements
          .map((el) => {
            const lat = el.lat ?? el.center?.lat ?? null
            const lng = el.lon ?? el.center?.lon ?? null
            const tg = el.tags || {}
            if (lat == null || lng == null || !tg.name) return null
            const addr = [tg['addr:housenumber'], tg['addr:street'], tg['addr:city']].filter(Boolean).join(' ')
            return pin({ name: tg.name, address: addr, lat, lng, types: [tag] })
          })
          .filter(Boolean) as Pin[]
        finish(null, pins.slice(0, 50)) // valid empty response is authoritative too
      }).catch((error) => {
        active--
        if (settled) return
        if (next < OVERPASS_EPS.length) launch()
        else if (active === 0) finish(error)
      })
    }
    launch()
    // Fast providers cause one request. Slow providers get one delayed hedge;
    // failed requests are replaced immediately, with at most two in flight.
    hedge = setTimeout(() => { if (active < 2) launch() }, MIRROR_HEDGE_MS)
  }))
}
async function osmFallback(query: string, near: string, lat: number | undefined, lng: number | undefined, signal: AbortSignal): Promise<Pin[]> {
  const cat = OSM_TAGS.find((c) => c.re.test(query))
  // Determine a search bbox: a point (current map view) wins; else geocode the area.
  let bb: [string, string, string, string] | null = null
  if (typeof lat === 'number' && typeof lng === 'number') {
    const d = 0.13 // ~14 km half-box around where the user is looking
    bb = [String(lat - d), String(lat + d), String(lng - d), String(lng + d)]
  } else {
    const inMatch = query.match(/\bin\s+(.+)$/i)
    const area = (near || (inMatch ? inMatch[1] : '')).trim()
    if (area) {
      const geo = await nominatim(area, signal)
      const g0 = geo[0]?.boundingbox
      if (g0 && g0.length === 4) bb = [g0[0], g0[1], g0[2], g0[3]]
    }
  }
  if (cat && bb) {
    try {
      // A successful empty category response is authoritative; only a provider
      // failure needs recovery, not a broad unrelated name search.
      return await overpassInBbox(cat.tag, bb, signal)
    } catch (error) {
      if (signal.aborted) throw error
      // Nominatim supports an amenity phrase inside a bounded viewbox. This
      // returns real venues of the requested type when Overpass is unavailable,
      // rather than guessing pins or leaving every category search broken.
      // https://nominatim.org/release-docs/latest/api/Search/#other
      const [category, kind] = cat.tag.split('=')
      const phrase = kind === '*' ? category : kind.replace(/_/g, ' ')
      const places = await nominatim(`[${phrase}]`, signal, bb)
      return geoPins(places.filter(place => place && typeof place === 'object' && (place.category || place.class) === category && (kind === '*' || place.type === kind)))
    }
  }
  // name/address search (only for non-category queries, to avoid garbage results)
  if (cat) return []
  const geo = await nominatim(near ? `${query} ${near}` : query, signal)
  return geoPins(geo)
}

export async function placesSearch(query: string, near: string, lat?: number, lng?: number): Promise<unknown> {
  try {
    return await withinBudget(PLACES_BUDGET_MS, undefined, async (signal) => {
      const mapsKey = [process.env.GOOGLE_PLACES_KEY, process.env.GOOGLE_MAPS_KEY, process.env.VITE_GOOGLE_MAPS_KEY].find((key) => key?.trim())?.trim() || ''
      const fallback = async () => {
        const results = await osmFallback(query, near, lat, lng, signal)
        return { results, status: results.length ? 'OK' : 'ZERO_RESULTS', source: 'osm' }
      }
      if (!mapsKey) return fallback()
      const q = near ? `${query} in ${near}` : query
      const bias = typeof lat === 'number' && typeof lng === 'number'
        ? { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } } }
        : {}
      try {
        const value = await providerJson('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': mapsKey,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours.openNow',
          },
          body: JSON.stringify({ textQuery: q, maxResultCount: 20, ...bias }),
        }, signal, GOOGLE_BUDGET_MS)
        const d = value as { error?: unknown; places?: Array<Record<string, unknown>> }
        if (!d || typeof d !== 'object' || d.error || (d.places != null && !Array.isArray(d.places))) throw new Error('Invalid Google Places response')
        const results = (d.places || []).slice(0, 20).map((p) => {
          const loc = p.location as { latitude?: number; longitude?: number } | undefined
          const dn = p.displayName as { text?: string } | undefined
          const pl = p.priceLevel as string | undefined
          return {
            name: dn?.text || '', address: (p.formattedAddress as string) || '',
            lat: loc?.latitude ?? null, lng: loc?.longitude ?? null,
            rating: (p.rating as number) ?? null, userRatings: (p.userRatingCount as number) ?? null,
            priceLevel: pl && pl in PRICE_LEVELS ? PRICE_LEVELS[pl] : null,
            types: (p.types as string[]) || [], placeId: (p.id as string) || '',
            openNow: (p.currentOpeningHours as { openNow?: boolean } | undefined)?.openNow ?? null,
            photoUrl: null,
          }
        })
        if (results.length) return { results, status: 'OK' }
      } catch (error) {
        // Deadline, denied key, quota and malformed responses all use the same
        // genuine OSM fallback. An expired overall budget never starts new work.
        if (signal.aborted) throw error
      }
      return fallback()
    })
  } catch (error) {
    return { results: [], status: 'UNAVAILABLE', error: error instanceof Error && error.name === 'TimeoutError' ? 'Place search timed out. Please try again.' : 'Place search services are temporarily unavailable. Please try again.' }
  }
}
