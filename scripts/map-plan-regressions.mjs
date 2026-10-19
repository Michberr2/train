// Actual Map handler with local completion fixtures; no model or map providers.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(root, 'scripts', '.map-plan-'))
const oldKey = process.env.TINKER_API_KEY
const oldFetch = globalThis.fetch
try {
  process.env.TINKER_API_KEY = 'offline-map-plan'
  globalThis.fetch = () => { throw new Error('Unexpected provider request in offline Map plan regression') }
  const result = await build({
    stdin: { resolveDir: root, contents: `export {default as handler} from './api/web'; export * from './api/_mapPlan'; export {normalizeMapComparison} from './shared/mapComparison';` },
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'es2020',
    plugins: [{ name: 'offline-map-plan', setup(build) {
      build.onResolve({ filter: /^\.\/_db$|^\.\/_mapAi$/ }, args => ({ path: args.path, namespace: 'offline' }))
      build.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === './_db'
        ? 'export async function identityForRequest(){return null}; export function identityBlock(){return ""}'
        : 'export async function completeMapAi(){return JSON.stringify(globalThis.__mapPlanFixture)}',
      }))
    } }],
  })
  const modulePath = join(temp, 'plan.mjs')
  await writeFile(modulePath, result.outputFiles[0].text)
  const { handler, plainPlacePlan, isPlainMapPlaceLookup, normalizeMapComparison } = await import(pathToFileURL(modulePath).href)
  const plan = {
    answer: 'Searching live Places near downtown Orlando.', search: 'coffee shop near downtown Orlando FL',
    center: { lat: 28.5383, lng: -81.3792 }, zoom: 14,
    layers: ['walkability'], shapes: [{ type: 'circle', category: 'area', label: 'Unrequested zone', center: { lat: 28.5383, lng: -81.3792 }, radiusM: 1000 }],
    comparison: { title: 'Unrequested comparison', criteria: ['walkability', 'access'], places: [
      { name: 'North', lat: 28.55, lng: -81.38, scores: { walkability: 7, access: 8 }, note: '' },
      { name: 'South', lat: 28.53, lng: -81.38, scores: { walkability: 6, access: 5 }, note: '' },
    ], winner: 'North' },
  }
  const original = JSON.stringify(plan)
  const invoke = async (query, source = plan) => {
    globalThis.__mapPlanFixture = source
    const res = { code: 200, payload: null, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload; return this } }
    await handler({ method: 'POST', headers: {}, body: { action: 'mapai', query, catalog: [{ key: 'walkability', label: 'Walkability index' }] } }, res)
    assert.equal(res.code, 200)
    return res.payload
  }
  const plain = [
    'coffee near downtown Orlando', 'coffee shop near downtown Orlando FL', '  Coffee near downtown Orlando?  ',
    'Find coffee near me', 'Show me restaurants in Orlando', 'Please find a coffee shop near downtown Orlando',
    'Can you locate the nearest pharmacy in Orlando?', 'Where are cafes near Winter Park?',
    'Where can I get coffee in Orlando?', 'cafés near Montréal', 'gas stations nearby', 'Find nearby hotels',
    'coffee', 'Find parking near downtown Orlando', 'museums in St. Augustine, FL', "cafes in O'Fallon",
  ]
  for (const query of plain) {
    assert.equal(isPlainMapPlaceLookup(query), true, query)
    const cleaned = plainPlacePlan(query, plan)
    assert.notEqual(cleaned, plan)
    assert.deepEqual(cleaned, { ...plan, layers: [], shapes: [], comparison: null }, query)
    const actual = await invoke(query)
    assert.deepEqual(actual, cleaned, `actual handler: ${query}`)
  }
  const advanced = [
    'Find restaurants in flood zones', 'coffee near downtown Orlando and outline the area',
    'coffee near downtown Orlando with walkability', 'coffee near downtown Orlando; add traffic',
    'Find restaurants with parking in Orlando', 'Coffee within walking distance of downtown Orlando',
    'Compare coffee shops near downtown Orlando', 'Where should I invest in restaurants in Orlando?',
    'Draw a 1-mile zone around coffee shops in Orlando', 'restaurants in safe neighborhoods near Orlando',
    'restaurants near Orlando with school district boundaries', 'Find a route to coffee near downtown Orlando',
    'cafes near Orlando under $20', 'restaurants in Orlando with population density',
    'Show flood risk around Orlando restaurants', 'Outline downtown Orlando', 'best coffee near Orlando',
    'Starbucks near downtown Orlando', 'coffee near Orlando and hospitals near Tampa',
  ]
  for (const query of advanced) {
    assert.equal(isPlainMapPlaceLookup(query), false, query)
    assert.equal(plainPlacePlan(query, plan), plan, 'ambiguous or analytical requests retain their plan')
    assert.deepEqual(await invoke(query), { ...plan, comparison: normalizeMapComparison(plan.comparison, []) }, `actual advanced handler: ${query}`)
  }
  for (const search of [null, '']) {
    const noSearch = { ...plan, search }
    assert.equal(plainPlacePlan('coffee near downtown Orlando', noSearch), noSearch)
    assert.deepEqual(await invoke('coffee near downtown Orlando', noSearch), { ...noSearch, search: null, comparison: normalizeMapComparison(plan.comparison, []) }, 'only plans with a Places lookup are narrowed')
  }
  assert.equal(JSON.stringify(plan), original, 'neither classification nor handler mutates the model response fixture')
  console.log(`PASS: ${plain.length} plain lookup and ${advanced.length} advanced/ambiguous query cases through the actual Map handler; no-search preservation, exact center/query/answer preservation, and no provider calls.`)
} finally {
  globalThis.fetch = oldFetch
  delete globalThis.__mapPlanFixture
  if (oldKey === undefined) delete process.env.TINKER_API_KEY; else process.env.TINKER_API_KEY = oldKey
  await rm(temp, { recursive: true, force: true })
}
