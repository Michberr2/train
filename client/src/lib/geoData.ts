// Shared FREE public geo-data sources (no API key), used by BOTH the map UI and
// the chat AI's tools — so the assistant can read the exact same parcel, permit,
// and place data that the map shows. Everything is queried LIVE (always current).

// ---------------------------------------------------------------- Parcels ----
// Statewide public parcel services (geometry + owner/assessment). Parcel data is
// public record but published per state/county; these are the states with a fast,
// public, CORS-enabled statewide service (verified). bbox = [W, S, E, N].
export type ParcelSvc = { name: string; bbox: [number, number, number, number]; url: string }
export const PARCEL_SVCS: ParcelSvc[] = [
  { name: 'Montana', bbox: [-116.05, 44.36, -104.04, 49.01], url: 'https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0' },
  { name: 'North Carolina', bbox: [-84.33, 33.83, -75.40, 36.59], url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1' },
  { name: 'Utah', bbox: [-114.06, 36.99, -109.03, 42.01], url: 'https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer/0' },
  { name: 'Vermont', bbox: [-73.44, 42.72, -71.46, 45.02], url: 'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0' },
  { name: 'Washington', bbox: [-124.85, 45.54, -116.92, 49.01], url: 'https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0' },
]
export const parcelStates = (): string => PARCEL_SVCS.map((s) => s.name).join(', ')
export const parcelSvcFor = (lng: number, lat: number): ParcelSvc | undefined =>
  PARCEL_SVCS.find((s) => lng >= s.bbox[0] && lng <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3])

// Counties/states use different field names; pull the human-meaningful ones generically.
export function parcelFacts(props: Record<string, unknown>): { label: string; value: string }[] {
  const keys = Object.keys(props)
  const pick = (subs: string[], exclude: string[] = []): string => {
    for (const k of keys) {
      const u = k.toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (exclude.some((e) => u.includes(e))) continue
      if (subs.some((s) => u.includes(s))) {
        const v = props[k]
        if (v != null && v !== '' && String(v).toLowerCase() !== 'null') return String(v)
      }
    }
    return ''
  }
  const num = (s: string) => (s && !isNaN(Number(s)) ? Number(s) : null)
  const out: { label: string; value: string }[] = []
  const owner = pick(['OWNERNAME', 'OWNNAME', 'OWNER', 'TAXPAYER', 'DEEDOWNER'])
  const addr = pick(['SITEADDRESS', 'SITUSADDRESS', 'SITUS', 'SITEADDR', 'PHYSADDR', 'PROPADDR', 'PARCELADD', 'PROPERTYADDRESS', 'LOCATION', 'ADDRESS', 'ADDR'], ['MAIL', 'OWNER'])
  const city = pick(['PARCELCITY', 'SITECITY', 'PROPCITY', 'SITUSCITY', 'CITY', 'TOWN', 'TNAME'], ['MAIL', 'COUNTY'])
  const use = pick(['LANDUSE', 'USEDESC', 'PROPTYPE', 'PROPCLASS', 'PROPERTYCLASS', 'USECODE', 'CLASS'])
  const acres = pick(['GISACRES', 'DEEDACRES', 'CALCACRES', 'ACRES', 'ACREAGE'])
  const land = pick(['LANDVAL'])
  const impr = pick(['IMPROVVAL', 'IMPVAL', 'BLDGVAL'])
  const value = pick(['PARVAL', 'TOTALVALUE', 'TOTALVAL', 'TOTVAL', 'ASSESSEDVALUE', 'ASSESSED', 'MARKETVALUE', 'JUSTVALUE', 'APPRAISED'])
  const pid = pick(['PARCELID', 'PARCELNUMBER', 'PARCELNUM', 'PARCELNO', 'PARNO', 'PARCID', 'SPAN', 'PIN', 'APN', 'GPIN', 'PROPERTYID', 'TAXID'])
  const dollars = (s: string) => { const n = num(s); return n != null ? '$' + Math.round(n).toLocaleString() : s }
  if (owner) out.push({ label: 'Owner', value: owner })
  if (addr) out.push({ label: 'Address', value: city ? `${addr}, ${city}` : addr })
  else if (city) out.push({ label: 'City', value: city })
  if (use) out.push({ label: 'Use', value: use })
  if (acres) { const n = num(acres); out.push({ label: 'Acres', value: n != null ? n.toFixed(2) : acres }) }
  if (value) out.push({ label: 'Assessed value', value: dollars(value) })
  if (land) out.push({ label: 'Land value', value: dollars(land) })
  if (impr) out.push({ label: 'Improvements', value: dollars(impr) })
  if (pid) out.push({ label: 'Parcel ID', value: pid })
  return out
}

// ---------------------------------------------------------------- Permits ----
// Free city open-data building-permit feeds (Socrata). These cover pre-design
// (filed/applied), design (under review), and construction (issued/active).
export type PermitSvc = {
  city: string; bbox: [number, number, number, number]; url: string
  mode: 'latlng' | 'circle'; lat?: string; lng?: string; loc?: string; date: string
}
// Auto-discovered across the Socrata open-data network (then verified to return
// geocoded permits). Add a city by dropping its dataset in here.
export const PERMIT_SVCS: PermitSvc[] = [
  { city: 'Chicago', bbox: [-87.914, 41.654, -87.527, 42.019], url: 'https://data.cityofchicago.org/resource/ydr8-5enu.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issue_date' },
  { city: 'New York', bbox: [-74.243, 40.512, -73.706, 40.906], url: 'https://data.cityofnewyork.us/resource/rbx6-tga4.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issued_date' },
  { city: 'Los Angeles', bbox: [-118.657, 33.707, -118.164, 34.325], url: 'https://data.lacity.org/resource/pi9x-tg5x.json', mode: 'latlng', lat: 'lat', lng: 'lon', date: 'issue_date' },
  { city: 'Seattle', bbox: [-122.418, 47.497, -122.242, 47.734], url: 'https://cos-data.seattle.gov/resource/76t5-zqzr.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'applieddate' },
  { city: 'Austin', bbox: [-98.05, 30.0, -97.5, 30.6], url: 'https://data.austintexas.gov/resource/3syk-w9eu.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issue_date' },
  { city: 'San Francisco', bbox: [-122.55, 37.69, -122.35, 37.84], url: 'https://data.sfgov.org/resource/i98e-djp9.json', mode: 'circle', loc: 'location', date: 'issued_date' },
  { city: 'Orlando', bbox: [-81.401, 28.394, -81.243, 28.576], url: 'https://data.cityoforlando.net/resource/ryhf-m453.json', mode: 'circle', loc: 'geocoded_column', date: 'issue_permit_date' },
  { city: 'Mesa AZ', bbox: [-111.893, 33.296, -111.581, 33.495], url: 'https://citydata.mesaaz.gov/resource/2gkz-7z4f.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issued_date' },
  { city: 'Henderson NV', bbox: [-115.16, 35.925, -114.908, 36.129], url: 'https://performance.cityofhenderson.com/resource/fpc9-568j.json', mode: 'circle', loc: 'gis_point', date: 'applydate' },
  { city: 'Cambridge MA', bbox: [-71.157, 42.354, -71.074, 42.402], url: 'https://data.cambridgema.gov/resource/qu2z-8suj.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issue_date' },
  { city: 'Gainesville FL', bbox: [-82.437, 29.607, -82.259, 29.752], url: 'https://data.cityofgainesville.org/resource/p798-x3nx.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issue' },
  { city: 'Norfolk VA', bbox: [-76.32, 36.823, -76.18, 36.968], url: 'https://data.norfolk.gov/resource/fahm-yuh4.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'issue_date' },
  { city: 'College Station TX', bbox: [-96.394, 30.489, -96.195, 30.648], url: 'https://data.cstx.gov/resource/hrbn-znt6.json', mode: 'circle', loc: 'location', date: 'applied_date' },
  { city: 'Everett WA', bbox: [-122.285, 47.884, -122.177, 48.015], url: 'https://data.everettwa.gov/resource/3w3u-656c.json', mode: 'circle', loc: 'geocoded_column', date: 'applieddate' },
  { city: 'Corona CA', bbox: [-117.666, 33.769, -117.452, 33.963], url: 'https://corstat.coronaca.gov/resource/2agx-camz.json', mode: 'circle', loc: 'geolocation', date: 'issued' },
  { city: 'Marin County CA', bbox: [-122.97, 37.861, -122.444, 38.259], url: 'https://data.marincounty.gov/resource/mkbn-caye.json', mode: 'latlng', lat: 'latitude', lng: 'longitude', date: 'most_recent_issued_received_date' },
  { city: 'Montgomery County MD', bbox: [-77.474, 38.947, -76.919, 39.332], url: 'https://data.montgomerycountymd.gov/resource/qxie-8qnp.json', mode: 'circle', loc: 'location', date: 'issueddate' },
  { city: 'Sonoma County CA', bbox: [-123.0, 38.263, -122.399, 38.743], url: 'https://data.sonomacounty.ca.gov/resource/652y-5ihx.json', mode: 'circle', loc: 'geocoded_column', date: 'date_opened' },
]
export const permitCities = (): string => {
  const names = PERMIT_SVCS.map((s) => s.city)
  return `${names.length} US cities/counties incl. ${names.slice(0, 8).join(', ')}…`
}
export const permitSvcFor = (lng: number, lat: number): PermitSvc | undefined =>
  PERMIT_SVCS.find((s) => lng >= s.bbox[0] && lng <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3])

export type Permit = { facts: { label: string; value: string }[]; title: string; lat: number | null; lng: number | null }
function permitOne(rec: Record<string, unknown>, svc: PermitSvc): Permit {
  const keys = Object.keys(rec)
  const pick = (subs: string[], exclude: string[] = []): string => {
    for (const k of keys) {
      const u = k.toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (exclude.some((e) => u.includes(e))) continue
      if (subs.some((s) => u.includes(s))) { const v = rec[k]; if (v != null && v !== '') return String(v) }
    }
    return ''
  }
  const type = pick(['PERMITTYPEDESC', 'PERMITTYPEDEFINITION', 'PERMITTYPE', 'PERMITCLASS', 'WORKTYPE', 'JOBTYPE'])
  const desc = pick(['WORKDESCRIPTION', 'DESCRIPTION', 'PERMITTYPEDEFINITION'])
  const status = pick(['STATUSCURRENT', 'PERMITSTATUS', 'STATUS', 'PERMITMILESTONE'])
  const date = pick(['ISSUEDDATE', 'ISSUEDATE', 'ISSUANCEDATE', 'STATUSDATE', 'PERMITCREATIONDATE', 'APPLIEDDATE'])
  const cost = pick(['ESTPROJECTCOST', 'REPORTEDCOST', 'ESTIMATEDCOST', 'DECLAREDVALUATION', 'TOTALVALUATION', 'VALUATION'])
  // address — combine street parts when present, else a single address field
  let addr = pick(['ORIGINALADDRESS1', 'PERMITLOCATION', 'ADDRESS', 'STREETADDRESS'])
  if (!addr) {
    const num = pick(['STREETNUMBER', 'HOUSE'])
    const street = pick(['STREETNAME'])
    addr = [num, pick(['STREETDIRECTION']), street, pick(['STREETSUFFIX'])].filter(Boolean).join(' ').trim()
  }
  const num = (s: string) => (s && !isNaN(Number(s)) ? Number(s) : null)
  const facts: { label: string; value: string }[] = []
  if (type) facts.push({ label: 'Type', value: type })
  if (desc && desc !== type) facts.push({ label: 'Work', value: desc.length > 160 ? desc.slice(0, 157) + '…' : desc })
  if (addr) facts.push({ label: 'Address', value: addr })
  if (status) facts.push({ label: 'Status', value: status })
  if (date) facts.push({ label: 'Date', value: String(date).slice(0, 10) })
  if (cost) { const n = num(cost); if (n) facts.push({ label: 'Value', value: '$' + Math.round(n).toLocaleString() }) }
  // coordinates
  let lat: number | null = null, lng: number | null = null
  if (svc.mode === 'latlng' && svc.lat && svc.lng) { lat = num(String(rec[svc.lat])); lng = num(String(rec[svc.lng])) }
  else if (svc.loc) {
    const loc = rec[svc.loc] as { latitude?: string; longitude?: string; coordinates?: number[] } | undefined
    if (loc?.latitude) { lat = num(loc.latitude); lng = num(loc.longitude || '') }
    else if (loc?.coordinates) { lng = loc.coordinates[0]; lat = loc.coordinates[1] }
  }
  return { facts, title: type || 'Building permit', lat, lng }
}

async function jget(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// Geocode a place / address to a point (free, OpenStreetMap Nominatim).
export async function geocode(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  try {
    const d = (await jget(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`)) as Array<{ lat: string; lon: string; display_name: string }>
    if (!d[0]) return null
    return { lat: Number(d[0].lat), lng: Number(d[0].lon), label: d[0].display_name }
  } catch { return null }
}

// Look up the parcel at a point: owner, assessed value, acreage, use, parcel id.
export async function queryParcelAt(lat: number, lng: number): Promise<{ state?: string; facts?: { label: string; value: string }[]; note?: string; error?: string }> {
  const svc = parcelSvcFor(lng, lat)
  if (!svc) return { error: `No public statewide parcel service is wired for this location. Live coverage: ${parcelStates()}. (Most other states publish parcels only at the county level; full US coverage needs a paid provider like Regrid.)` }
  const d = 0.0003
  const qs = new URLSearchParams({ where: '1=1', geometry: `${lng - d},${lat - d},${lng + d},${lat + d}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*', resultRecordCount: '1', returnGeometry: 'false', f: 'json' })
  try {
    const j = (await jget(`${svc.url}/query?${qs}`)) as { features?: Array<{ attributes?: Record<string, unknown> }> }
    const f = j.features?.[0]
    if (!f) return { state: svc.name, note: 'No parcel found at that exact point — try nudging the location.' }
    return { state: svc.name, facts: parcelFacts(f.attributes || {}) }
  } catch (e) { return { error: `${svc.name} parcel service error: ${(e as Error).message}` } }
}

// Recent building permits near a point (pre-design / design / construction).
export async function queryPermitsNear(lat: number, lng: number, limit = 20): Promise<{ city?: string; permits?: Permit[]; error?: string }> {
  const svc = permitSvcFor(lng, lat)
  if (!svc) return { error: `No free building-permit feed is wired for this city yet. Live coverage: ${permitCities()}. (Permits are filed per municipality; more cities can be added on request.)` }
  let url: string
  if (svc.mode === 'circle' && svc.loc) url = `${svc.url}?$where=${encodeURIComponent(`within_circle(${svc.loc}, ${lat}, ${lng}, 1200)`)}&$order=${svc.date}+DESC&$limit=${limit}`
  else { const d = 0.012; url = `${svc.url}?$where=${encodeURIComponent(`${svc.lat} between ${lat - d} and ${lat + d} AND ${svc.lng} between ${lng - d} and ${lng + d}`)}&$order=${svc.date}+DESC&$limit=${limit}` }
  try {
    const recs = (await jget(url)) as Array<Record<string, unknown>>
    return { city: svc.city, permits: recs.map((r) => permitOne(r, svc)) }
  } catch (e) { return { error: `${svc.city} permit feed error: ${(e as Error).message}` } }
}

// Short catalog the AI can cite when asked what map data exists.
export const MAP_LAYER_CATALOG =
  'The map has 40+ free public layers in 7 groups: Real estate & land (property parcels w/ owner+assessment, FEMA flood zones, base flood elevations, flood-map changes, wetlands, PLSS land survey); Boundaries & census (counties, tracts/blocks, cities/places, ZIP/PUMA, legislative districts, place names); Hazards & risk (EPA regulated/Superfund sites, NWS alerts); Weather (radar, precipitation, sea-level-rise); Nature (USGS hydrography, watersheds, national forests, wilderness, trails); Infrastructure (roads & rail, public structures, USGS transportation, forest roads, nautical charts); Imagery & terrain (USGS & Esri aerial, topo, OpenTopoMap, contours, hillshade, relief, NatGeo, Ocean, Carto, OpenStreetMap). Parcels are live in ' +
  PARCEL_SVCS.map((s) => s.name).join(', ') +
  '. Building permits are live in ' + PERMIT_SVCS.map((s) => s.city).join(', ') +
  '. All data is queried live (always current).'
