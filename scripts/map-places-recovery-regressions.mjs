// Actual provider implementation with deterministic transport/deadlines. No
// browser, live credentials, public provider traffic, or account writes.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(root, 'scripts', '.map-places-'))
const original = { fetch: globalThis.fetch, setTimeout, clearTimeout }
const keys = ['GOOGLE_PLACES_KEY', 'GOOGLE_MAPS_KEY', 'VITE_GOOGLE_MAPS_KEY']
const oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const timers = new Map()
let time = 0, sequence = 0, calls = [], provider
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const advance = async milliseconds => {
  const target = time + milliseconds
  for (;;) {
    const next = [...timers].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    time = next[1].at; timers.delete(next[0]); next[1].run(); await flush()
  }
  time = target; await flush()
}
const reset = (handler, google = '') => {
  assert.equal(timers.size, 0, 'completed request retained a deadline')
  time = 0; calls = []; provider = handler
  for (const key of keys) process.env[key] = ''
  process.env.GOOGLE_PLACES_KEY = google
}
const poi = (name = 'Fixture cafe') => Response.json({ elements: [{ lat: 28.54, lon: -81.38, tags: { name, 'addr:city': 'Orlando' } }] })
const geo = (changes = {}) => ({ lat: '28.54', lon: '-81.38', name: 'Real fixture cafe', display_name: 'Real fixture cafe, Orlando, Florida', category: 'amenity', type: 'cafe', ...changes })
const stopped = call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }))
try {
  const built = await build({ stdin: { resolveDir: root, contents: `export {placesSearch} from './api/_places'; export {mapJson,mapPlaces} from './client/src/components/workspace/mapRequests';` }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2020' })
  const modulePath = join(temp, 'places.mjs')
  await writeFile(modulePath, built.outputFiles[0].text)
  const { placesSearch, mapJson, mapPlaces } = await import(pathToFileURL(modulePath).href)
  globalThis.setTimeout = (run, ms) => { const id = ++sequence; timers.set(id, { at: time + ms, run }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), ...init, at: time }
    calls.push(call)
    return provider(call, calls.length)
  }
  const request = () => placesSearch('coffee shops', '', 28.54, -81.38)

  reset(() => Response.json({ places: [{ id: 'google-fixture', displayName: { text: 'Google cafe' }, formattedAddress: 'Orlando', location: { latitude: 28.54, longitude: -81.38 }, priceLevel: 'PRICE_LEVEL_MODERATE' }] }), 'fixture-key')
  let result = await placesSearch('coffee', 'Orlando', 28.54, -81.38)
  assert.equal(result.status, 'OK')
  assert.equal(result.results[0].placeId, 'google-fixture')
  assert.equal(result.results[0].priceLevel, 2)
  assert.equal(JSON.parse(calls[0].body).textQuery, 'coffee in Orlando')
  assert.deepEqual(JSON.parse(calls[0].body).locationBias.circle.center, { latitude: 28.54, longitude: -81.38 })
  await advance(30_000); assert.equal(calls.length, 1)

  for (const stalledBody of [false, true]) {
    reset(call => call.url.includes('places.googleapis.com') ? stalledBody ? { ok: true, json: () => new Promise(() => {}) } : stopped(call) : poi(), 'fixture-key')
    let pending = request(); await flush(); await advance(3999)
    assert.equal(calls.length, 1)
    await advance(1); result = await pending
    assert.equal(result.source, 'osm'); assert.equal(calls[0].signal.aborted, true)
    assert.equal(calls.length, 2)
  }

  reset((_call, index) => index === 1 ? new Promise(() => {}) : poi('Hedged cafe'))
  let pending = request(); await flush(); await advance(1499)
  assert.equal(calls.length, 1)
  await advance(1); result = await pending
  assert.equal(result.results[0].name, 'Hedged cafe')
  assert.equal(calls[0].signal.aborted, true)
  await advance(30_000); assert.equal(calls.length, 2)

  // The former 10s mirror budget starved the third/fourth providers. The third
  // now starts at3.5s, while the second remains live; no more than2 run at once.
  reset((_call, index) => index < 3 ? new Promise(() => {}) : poi('Third mirror cafe'))
  pending = request(); await flush(); await advance(3499)
  assert.equal(calls.length, 2)
  await advance(1); result = await pending
  assert.equal(result.results[0].name, 'Third mirror cafe')
  assert.equal(calls[2].at, 3500)
  assert.equal(calls.every(call => call.signal.aborted), true)

  // Reproduce the production category failure: all Overpass transports hang.
  // The last mirror gets a full slice, then bounded Nominatim recovers actual
  // category pins. Reject unrelated places and malformed coordinates.
  reset(call => call.url.includes('nominatim') ? Response.json([
    null, 3, {}, geo(), geo({ type: 'hospital', name: 'Wrong category' }),
    geo({ lat: 'broken', name: 'Bad coordinates' }),
    geo({ lat: null }), geo({ lon: '' }), geo({ lat: '91' }), geo({ lon: '181' }),
  ]) : new Promise(() => {}))
  pending = request(); await flush(); await advance(3500)
  assert.equal(calls.length, 3)
  assert.equal(calls.filter(call => !call.signal.aborted).length, 2)
  await advance(1500); assert.equal(calls.length, 4)
  await advance(3500); result = await pending
  assert.equal(calls.length, 5); assert.equal(calls[4].at, 8500)
  const params = new URL(calls[4].url).searchParams
  assert.equal(params.get('q'), '[cafe]'); assert.equal(params.get('bounded'), '1')
  const bounds = params.get('viewbox').split(',').map(Number)
  assert.ok(Math.abs(bounds[0] - (-81.51)) < 1e-8)
  assert.ok(Math.abs(bounds[1] - 28.41) < 1e-8)
  assert.ok(Math.abs(bounds[2] - (-81.25)) < 1e-8)
  assert.ok(Math.abs(bounds[3] - 28.67) < 1e-8)
  assert.equal(result.status, 'OK'); assert.equal(result.source, 'osm')
  const parsed = mapPlaces((await mapJson(Response.json(result))).results)
  assert.equal(parsed.length, 1); assert.equal(parsed[0].name, 'Real fixture cafe')
  assert.equal(parsed[0].rating, null); assert.equal(parsed[0].placeId, '')
  assert.equal(calls.every(call => call.signal.aborted), true)

  reset(() => Response.json({ elements: [] }))
  result = await request()
  assert.equal(result.status, 'ZERO_RESULTS')
  assert.deepEqual(result.results, [])
  await advance(30_000); assert.equal(calls.length, 1, 'valid empty data must not become unrelated name results')

  reset(call => call.url.includes('nominatim') ? stopped(call) : new Response('provider unavailable', { status: 503 }))
  pending = request(); await flush(); await advance(5000); result = await pending
  assert.equal(result.status, 'UNAVAILABLE'); assert.match(result.error, /timed out/)
  await assert.rejects(() => mapJson(Response.json(result)), /timed out/)
  assert.equal(calls.every(call => call.signal.aborted), true)

  reset(call => call.url.includes('nominatim') ? Response.json([geo({ boundingbox: ['28', '29', '-82', '-81'] })]) : poi())
  result = await placesSearch('coffee in Orlando', '')
  assert.equal(result.status, 'OK')
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'Orlando')
  assert.match(new URLSearchParams(calls[1].body).get('data'), /\(28,-82,29,-81\)/)
  assert.equal(timers.size, 0)
  console.log('PASS: real Places Google/OSM contracts, stalled transports and bodies, fair mirror budgets, bounded category recovery, result validation, empty-vs-unavailable semantics, viewport/geocoder bias, and timer/cancellation cleanup.')
} finally {
  globalThis.fetch = original.fetch; globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(temp, { recursive: true, force: true })
}
