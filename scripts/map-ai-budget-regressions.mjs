// Real web handler + completion helper + client response parser. All network,
// identity and Places services are local fixtures; no provider calls or sleeps.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(root, 'scripts', '.map-ai-budget-'))
const original = { fetch: globalThis.fetch, now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
const envKeys = ['TINKER_API_KEY', 'TINKER_BASE_URL', 'NALU_AGENT_MODEL']
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
let state, sequence = 0
const timers = new Map()
const plan = { answer: 'Orlando fixture answer.', layers: ['osm', 'unknown'], search: null, shapes: [], center: { lat: 28.5, lng: -81.4 }, zoom: 12 }
const completion = () => Response.json({ choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: 'stop' }] })
const reset = (options = {}) => {
  assert.equal(timers.size, 0, 'previous case retained a deadline')
  state = { time: 0, calls: [], places: [], identity: async () => null, provider: async () => completion(), research: async () => new Promise(() => {}), ...options }
  globalThis.__mapAiBudget = state
}
const advance = async milliseconds => {
  const target = state.time + milliseconds
  for (;;) {
    const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    state.time = next[1].at
    timers.delete(next[0]); next[1].callback()
    await flush()
  }
  state.time = target
  await flush()
}
try {
  process.env.TINKER_API_KEY = 'offline-map-key'
  process.env.TINKER_BASE_URL = 'https://map-primary.invalid'
  process.env.NALU_AGENT_MODEL = 'fixture-map-model'
  const built = await build({
    stdin: { resolveDir: root, contents: `export { default as handler } from './api/web'; export {completeMapAi} from './api/_mapAi'; export {mapJson} from './client/src/components/workspace/mapRequests';` },
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'es2020',
    plugins: [{ name: 'offline-map-services', setup(build) {
      build.onResolve({ filter: /^\.\/_db$|^\.\/_places$/ }, args => ({ path: args.path, namespace: 'offline' }))
      build.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === './_db'
        ? 'export function identityForRequest(){return globalThis.__mapAiBudget.identity()}; export function identityBlock(value){return value ? " IDENTITY: " + value.name : ""}'
        : 'export async function placesSearch(query,near,lat,lng){globalThis.__mapAiBudget.places.push({query,lat,lng});return {results:[{name:"Fixture Cafe",lat:28.5,lng:-81.4}],status:"OK"}}',
      }))
    } }],
  })
  const modulePath = join(temp, 'map.mjs')
  await writeFile(modulePath, built.outputFiles[0].text)
  const { handler, completeMapAi, mapJson } = await import(pathToFileURL(modulePath).href)
  Date.now = () => state.time
  globalThis.setTimeout = (callback, ms) => { const id = ++sequence; timers.set(id, { callback, at: state.time + ms, ms }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), signal: init.signal, body: init.body ? JSON.parse(init.body) : undefined, at: state.time }
    state.calls.push(call)
    if (call.url === 'https://map-primary.invalid/chat/completions') return state.provider(call)
    // A stalled initial research request exercises the real Map research path
    // without allowing any request to leave this fake transport.
    return state.research(call)
  }
  const invoke = async (body = {}) => {
    const res = { code: 200, payload: undefined, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload; return this } }
    await handler({ method: 'POST', headers: {}, body: { action: 'mapai', query: 'Outline Orlando', lat: 28.5, lng: -81.4, catalog: [{ key: 'osm', label: 'OpenStreetMap' }], categories: ['area'], ...body } }, res)
    return res
  }
  const modelCalls = () => state.calls.filter(call => call.body?.messages)

  reset({ identity: async () => ({ name: 'Fixture identity' }) })
  let response = await invoke()
  assert.equal(response.code, 200)
  assert.equal(response.payload.answer, plan.answer)
  assert.deepEqual(response.payload.layers, ['osm'])
  assert.deepEqual(response.payload.center, plan.center)
  assert.equal(modelCalls().length, 1)
  assert.equal(modelCalls()[0].body.model, 'fixture-map-model')
  assert.equal(modelCalls()[0].body.max_tokens, 3200)
  assert.equal(modelCalls()[0].body.stream, false)
  assert.match(modelCalls()[0].body.messages[0].content, /IDENTITY: Fixture identity/)
  assert.match(modelCalls()[0].body.messages[1].content, /QUESTION: Outline Orlando/)
  assert.equal(timers.size, 0)

  // Research that ignores cancellation uses only5s, leaving the model13s. A
  // timely plan remains useful, and no late research is appended to its prompt.
  reset()
  let settled = false
  let result = invoke({ query: 'Compare neighborhoods in Orlando' })
  result.then(() => { settled = true })
  await flush()
  assert.equal(modelCalls().length, 0)
  await advance(4999)
  assert.equal(settled, false)
  await advance(1)
  response = await result
  assert.equal(response.payload.answer, plan.answer)
  assert.equal(modelCalls()[0].at, 5000)
  assert.doesNotMatch(modelCalls()[0].body.messages[1].content, /LIVE RESEARCH/)
  assert.equal(timers.size, 0)

  // Both research and model fetch ignore abort. The actual handler still
  // returns a clean no-plan at18s, rather than reaching the client45s timeout.
  const lateModel = deferred()
  reset({ provider: () => lateModel.promise })
  settled = false
  result = invoke({ query: 'Compare neighborhoods in Orlando' })
  result.then(() => { settled = true })
  await flush()
  await advance(5000)
  assert.equal(modelCalls().length, 1)
  await advance(12999)
  assert.equal(settled, false)
  await advance(1)
  response = await result
  assert.equal(response.code, 200)
  assert.deepEqual(response.payload, { error: 'Map AI is temporarily unavailable.' })
  assert.equal(modelCalls()[0].signal.aborted, true)
  assert.equal(timers.size, 0)
  assert.equal(state.time, 18000)
  // The real client parser rejects this exact response, which runSearch catches
  // as no-plan. Exercise the subsequent real handler Places action too; the
  // companion browser fixture verifies this branch in actual MapPanel.
  assert.equal(await mapJson(Response.json(response.payload)).catch(() => null), null)
  const pins = await invoke({ action: 'places', query: 'Compare neighborhoods in Orlando' })
  assert.equal((await mapJson(Response.json(pins.payload))).results[0].name, 'Fixture Cafe')
  assert.deepEqual(state.places, [{ query: 'Compare neighborhoods in Orlando', lat: 28.5, lng: -81.4 }])
  let lateCancelled = 0
  lateModel.resolve({ ok: true, body: { cancel: () => { lateCancelled++; return Promise.resolve() } }, json: () => assert.fail('late provider output must not be read') })
  await flush()
  assert.equal(lateCancelled, 1)
  assert.equal(modelCalls().length, 1, 'expired Map work cannot retry or start fallback model calls')

  // A stalled successful JSON body also has an independent deadline and its
  // reader is cancelled/released even if cleanup itself never resolves.
  let cancelled = 0
  const body = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}) } }))
  reset({ provider: () => body })
  result = invoke()
  await flush()
  assert.equal(body.body.locked, true)
  await advance(18000)
  assert.deepEqual((await result).payload, { error: 'Map AI is temporarily unavailable.' })
  assert.equal(cancelled, 1)
  assert.equal(body.body.locked, false)
  assert.equal(timers.size, 0)

  // Identity is best-effort too; an unavailable DB must not consume all18s.
  reset({ identity: () => new Promise(() => {}) })
  result = invoke()
  await flush()
  await advance(2000)
  assert.equal((await result).payload.answer, plan.answer)
  assert.equal(modelCalls()[0].at, 2000)
  assert.equal(timers.size, 0)

  for (const status of [402, 429, 503]) {
    reset({ provider: async () => new Response('private upstream body', { status }) })
    assert.deepEqual((await invoke()).payload, { error: 'Map AI is temporarily unavailable.' })
    assert.equal(modelCalls().length, 1, `${status} cannot start hidden model retries`)
    assert.equal(timers.size, 0)
  }

  // The bounded preparation interface discards late values and preserves fast
  // identity/research context without changing the configured model/provider.
  reset()
  const lateResearch = deferred()
  let researchSignal
  result = completeMapAi({ provider: { base: 'https://map-primary.invalid', key: 'offline', model: 'fixture-map-model', label: 'primary' }, system: 'Map system.', user: 'Question.', identity: async () => ' Identity.', research: signal => { researchSignal = signal; return lateResearch.promise } })
  await flush()
  await advance(5000)
  assert.equal(await result, JSON.stringify(plan))
  assert.equal(researchSignal.aborted, true)
  lateResearch.resolve(' Late private research.')
  await flush()
  assert.doesNotMatch(modelCalls()[0].body.messages[1].content, /Late private research/)
  assert.equal(modelCalls().length, 1)
  assert.equal(timers.size, 0)

  reset()
  await completeMapAi({ provider: { base: 'https://map-primary.invalid', key: 'offline', model: 'fixture-map-model', label: 'primary' }, system: 'Map system.', user: 'Question.', identity: async () => ' Identity.', research: async () => ' LIVE RESEARCH: fixture fact.' })
  assert.equal(modelCalls()[0].body.messages[0].content, 'Map system. Identity.')
  assert.equal(modelCalls()[0].body.messages[1].content, 'Question. LIVE RESEARCH: fixture fact.\n\nJSON:')
  assert.equal(timers.size, 0)
  console.log('PASS: real Map AI handler18s deadline, bounded research/identity, ignored fetch/body abort and late-answer disposal, unchanged configured provider/model/plan sanitation, no hidden retries, and actual no-plan→client parser→Places response.')
} finally {
  globalThis.fetch = original.fetch
  Date.now = original.now
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  delete globalThis.__mapAiBudget
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(temp, { recursive: true, force: true })
}
