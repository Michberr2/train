// Execute MapPanel's actual search handler against a recording map and deferred
// providers. Extract its AST node, not a copied implementation; no browser or
// simulated layout is involved. React rendering remains a separate concern.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const path = join(root, 'client/src/components/workspace/MapPanel.tsx')
const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'runSearch') handler = node.initializer.getText(source)
  ts.forEachChild(node, visit)
}
visit(source)
assert.ok(handler, 'MapPanel must expose its real search handler to the integration harness')
const names = ['mapRef', 'ready', 'authErr', 'searchRequests', 'clearAIShapes', 'saveShapes', 'plot', 'infoRef', 'setResults', 'setSel', 'setLoading', 'setErr', 'setAnswer', 'setComparison', 'LAYER_KEYWORDS', 'LAYERS', 'CATEGORIES', 'enableLayer', 'legacySearch', 'fetch', 'drawAIShapes', 'runPlaces', 'moveGlobe', 'fitGlobe', 'geocodeTo']
const temp = await mkdtemp(join(root, 'scripts', '.map-search-'))
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
try {
  const built = await build({ stdin: { resolveDir: root, contents: `
    import {mapJson,validMapPoint,MapRequestScope} from './client/src/components/workspace/mapRequests';
    import {normalizeMapComparison} from './shared/mapComparison';
    export {MapRequestScope};
    export function createSearch(context) { const {${names.join(',')}} = context; return ${handler}; }
  `, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2020' })
  const modulePath = join(temp, 'search.mjs')
  await writeFile(modulePath, built.outputFiles[0].text)
  const { createSearch, MapRequestScope } = await import(pathToFileURL(modulePath).href)
  const plan = { answer: 'Orlando map answer', layers: [], shapes: [], search: 'coffee in Orlando', center: { lat: 28.54, lng: -81.38 }, zoom: 12 }
  const make = (options = {}) => {
    const state = { loading: false, answer: '', error: '', results: [], events: [] }
    const emit = (name, ...args) => state.events.push([name, ...args])
    const requests = new MapRequestScope()
    const context = {
      ready: true, authErr: false, searchRequests: { current: requests },
      mapRef: { current: { getCenter: () => ({ lat: () => 40, lng: () => -74 }), getZoom: () => 9, panTo: point => emit('pan', point), setZoom: zoom => emit('zoom', zoom), fitBounds: bounds => emit('bounds', bounds) } },
      clearAIShapes() {}, saveShapes() {}, plot() {}, infoRef: { current: { close() {} } },
      setResults: results => { state.results = results }, setSel() {},
      setLoading: loading => { state.loading = loading }, setErr: error => { state.error = error },
      setAnswer: answer => { state.answer = answer }, setComparison() {},
      LAYER_KEYWORDS: [], LAYERS: [], CATEGORIES: [], enableLayer: () => null,
      legacySearch: async () => emit('legacy'),
      fetch: async (_url, init) => Response.json(options.plan?.(JSON.parse(init.body).query) || plan),
      drawAIShapes: () => 'shape bounds',
      runPlaces: async (query, fit, request) => {
        emit('places', query, fit)
        const places = await (options.places?.(query, request) ?? [])
        requests.check(request)
        state.results = places
        return places
      },
      moveGlobe: camera => emit('globe', camera), fitGlobe: bounds => emit('globeBounds', bounds),
      geocodeTo: async query => { emit('geocode', query); return true },
    }
    return { state, requests, search: createSearch(context) }
  }

  // Production failure: AI succeeds, but the optional Places request times out.
  // The camera and answer must be usable before that provider resolves.
  const pins = deferred()
  let fixture = make({ places: () => pins.promise })
  let pending = fixture.search('Find Orlando coffee')
  await flush()
  assert.equal(fixture.state.answer, plan.answer)
  assert.equal(fixture.state.loading, true)
  assert.deepEqual(fixture.state.events.slice(0, 2), [['pan', plan.center], ['zoom', 12]])
  assert.ok(fixture.state.events.findIndex(event => event[0] === 'pan') < fixture.state.events.findIndex(event => event[0] === 'places'))
  pins.reject(new Error('Place search timed out. Please try again.'))
  await pending
  assert.equal(fixture.state.loading, false)
  assert.equal(fixture.state.answer, plan.answer)
  assert.match(fixture.state.error, /Live place pins are unavailable.*timed out/)
  assert.equal(fixture.state.events.some(event => event[0] === 'geocode'), false)

  // A later query owns its own camera, answer and pending state. A late failed
  // pin request from the previous query cannot overwrite any of them.
  const oldPins = deferred(), newPins = deferred()
  fixture = make({
    plan: query => ({ ...plan, answer: query, search: query, center: { lat: query === 'new' ? 30 : 28, lng: -81 } }),
    places: query => query === 'old' ? oldPins.promise : newPins.promise,
  })
  pending = fixture.search('old'); await flush()
  const latest = fixture.search('new'); await flush()
  oldPins.reject(new Error('Old service failure')); await pending
  assert.equal(fixture.state.answer, 'new'); assert.equal(fixture.state.error, '')
  assert.equal(fixture.state.loading, true)
  newPins.resolve([{ name: 'Current cafe' }]); await latest
  assert.equal(fixture.state.answer, 'new'); assert.equal(fixture.state.loading, false)
  assert.deepEqual(fixture.state.results, [{ name: 'Current cafe' }])

  // With no planned center/shapes, real result bounds own framing; an extra
  // geocoder response must not move the camera away from those actual pins.
  fixture = make({ plan: () => ({ ...plan, center: null }), places: () => [{ name: 'Actual cafe' }] })
  await fixture.search('coffee')
  assert.deepEqual(fixture.state.events, [['places', plan.search, true]])
  assert.equal(fixture.state.error, '')

  fixture = make({ plan: () => ({ ...plan, center: null }), places: () => [] })
  await fixture.search('coffee')
  assert.match(fixture.state.error, /No matching live places/)
  assert.deepEqual(fixture.state.events.at(-1), ['geocode', plan.search])

  fixture = make({ plan: () => ({ error: 'Map AI unavailable' }) })
  await fixture.search('coffee')
  assert.deepEqual(fixture.state.events, [['legacy']])
  assert.equal(fixture.state.loading, false)
  console.log('PASS: actual MapPanel search handler applies AI camera/answer before optional pins, retains partial success, discards stale failures, keeps newest loading state, preserves real pin bounds, and reports empty results honestly.')
} finally { await rm(temp, { recursive: true, force: true }) }
