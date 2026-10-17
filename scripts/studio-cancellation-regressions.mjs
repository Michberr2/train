// Exercise real handler/provider/research cancellation with fake transports.
// No paid inference, network, authentication or real quota is touched.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const directory = await mkdtemp(join(process.cwd(), 'scripts/.studio-cancel-'))
const originalFetch = globalThis.fetch
const requestContextSymbol = Symbol.for('@vercel/request-context')
const originalRequestContext = globalThis[requestContextSymbol]
const envKeys = ['TINKER_API_KEY', 'NALU_FALLBACK_API_KEY', 'NALU_DISABLE_EMERGENCY']
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
try {
  globalThis[requestContextSymbol] = { get: () => ({ waitUntil(promise) { const entry = { resolved: false }; globalThis.cancelFixture.cleanupWaits.push(entry); promise.then(() => { entry.resolved = true }) } }) }
  process.env.TINKER_API_KEY = 'synthetic-cancellation-test'
  process.env.NALU_FALLBACK_API_KEY = 'synthetic-fallback-test'
  process.env.NALU_DISABLE_EMERGENCY = '1'
  const bundle = await build({ stdin: { contents: "export {default as handler} from './api/design'; export {withRequestCancellation} from './api/_requestCancellation'; export {chatComplete} from './api/_llm'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'isolated-services', setup(build) {
    build.onResolve({ filter: /^\.\/(?:_db|_limits|_websiteRuntime)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === './_db' ? 'export const identityForRequest=async()=>null;export const identityBlock=()=>"";' : path === './_limits' ? 'export const reserveStudioQuota=async()=>{globalThis.cancelFixture.reservations++;return {ok:true,release:async()=>{if(globalThis.cancelFixture.cleanupWaits[0].resolved)throw new Error("cleanup lifetime ended before refund");await Promise.resolve();globalThis.cancelFixture.releases++}}};export const studioLimitMessage=()=>"limited";' : 'export const WEBSITE_RUNTIME_TEST_SCHEMA="";export const parseRuntimeTests=value=>Array.isArray(value)?value:[];export const inspectRuntimeTests=value=>({tests:parseRuntimeTests(value),issues:[]});export const reviewWebsiteRuntime=async()=>({status:globalThis.cancelFixture.runtimeUnavailable?"unavailable":"passed",widths:[1440,390],checks:[],issues:[],limitations:[]});' }))
  } }] })
  const modulePath = join(directory, 'cancellation.mjs')
  await writeFile(modulePath, bundle.outputFiles[0].text)
  const { handler, withRequestCancellation, chatComplete } = await import(pathToFileURL(modulePath))
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>Counter</h1><button id="add">Add</button><output id="count" aria-label="Count">0</output></main><script>let n=0;document.getElementById("add").onclick=()=>document.getElementById("count").textContent=++n</script></body></html>'
  const plan = JSON.stringify({ runtimeTests: [{name: 'Add increments', steps: [{action: 'click', target: {role:'button',name:'Add'}}], expect:[{type:'text',target:{selector:'#count'},value:'1'}]}], direction: 'Compact counter', pages: [{ name: 'Counter' }] })
  const response = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const makePair = body => {
    const requestController = new AbortController()
    const req = Object.assign(new EventEmitter(), { signal: requestController.signal, method: 'POST', headers: {}, body })
    const res = Object.assign(new EventEmitter(), { writableEnded: false, writes: [], setHeader() {}, status(status) { this.code = status; return this }, json(payload) { this.writes.push({ status: this.code, payload }); this.writableEnded = true; this.emit('close'); return this } })
    return { req, res, requestController }
  }
  const records = []
  for (const mode of ['research', 'plan', 'build', 'edit', 'repair', 'continuation', 'fallback', 'request-error', 'request-signal', 'normal-request-close', 'runtime-unavailable']) {
    const fixture = globalThis.cancelFixture = { reservations: 0, releases: 0, calls: [], aborted: 0, cleanupWaits: [], runtimeUnavailable: mode === 'runtime-unavailable' }
    const body = { kind: 'webpage', prompt: mode === 'research' ? 'Build a site using https://example.com/research-source' : 'Build a useful counter without web research', ...(['edit', 'repair'].includes(mode) ? { prevHtml: html } : {}), ...(mode === 'repair' ? { previewIssues: ['Count does not update after Add.'] } : {}) }
    const { req, res, requestController } = makePair(body)
    const cancelStage = ['request-error', 'request-signal'].includes(mode) ? 'plan' : mode
    let builds = 0
    globalThis.fetch = async (url, init) => {
      const data = init.body ? JSON.parse(init.body) : null
      let stage = !data?.messages ? 'research' : data.messages[1]?.content.startsWith('PLANNING PHASE ONLY.') ? 'plan' : /maintain an existing standalone website/.test(data.messages[0].content) ? mode === 'repair' ? 'repair' : 'edit' : /file was cut off/.test(data.messages.at(-1).content) ? 'continuation' : 'build'
      if (stage === 'build') { builds++; if (builds > 1) stage = 'fallback' }
      fixture.calls.push({ stage, signal: !!init.signal, model: data?.model })
      assert.equal(fixture.cleanupWaits.length, 1, 'register Vercel cleanup lifetime before starting provider/research calls')
      assert.equal(fixture.cleanupWaits[0].resolved, false)
      if (stage === cancelStage) {
        assert.ok(init.signal && !init.signal.aborted, `${mode} must receive a live caller signal`)
        return await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => { fixture.aborted++; reject(new DOMException('Cancelled transport', 'AbortError')) }, { once: true })
          queueMicrotask(() => mode === 'request-error' ? req.emit('error', new Error('aborted')) : mode === 'request-signal' ? requestController.abort() : res.emit('close'))
        })
      }
      if (mode === 'normal-request-close' && stage === 'plan') req.emit('close')
      if (stage === 'plan') return response(plan)
      if (mode === 'fallback' && stage === 'build') return new Response('Upstream unavailable', { status: 503 })
      if (mode === 'continuation' && stage === 'build') return response(html.replace('</script></body></html>', ''))
      return response(html)
    }
    await handler(req, res)
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(req.listenerCount('error'), 0)
    assert.equal(fixture.cleanupWaits.length, 1)
    assert.equal(fixture.cleanupWaits[0].resolved, true, 'finish lifetime only after task cleanup/refund')
    assert.equal(res.listenerCount('close'), 0)
    if (mode === 'runtime-unavailable') {
      assert.equal(res.writes.length, 1)
      assert.equal(res.writes[0].status, 503, 'a missing/timed-out browser must never claim a checked successful build')
      assert.equal(res.writes[0].payload.quality.runtime.status, 'unavailable')
      assert.equal(fixture.releases, 1, 'unverified undelivered builds refund quota')
    } else if (mode === 'normal-request-close') {
      assert.equal(res.writes.length, 1)
      assert.equal(res.writes[0].status, 200)
      assert.equal(fixture.releases, 0, 'completed designs keep their quota reservation')
      assert.equal(fixture.aborted, 0, 'normal request-body close must not cancel generation')
    } else {
      assert.equal(res.writes.length, 0, `${mode}: a disconnected caller must never receive a response attempt`)
      assert.equal(fixture.aborted, 1, `${mode}: cancel active upstream transport`)
      assert.equal(fixture.calls.at(-1).stage, cancelStage, `${mode}: do not start any subsequent provider/stage`)
      assert.equal(fixture.releases, mode === 'research' ? 0 : 1, `${mode}: refund exactly once when a reserved design is not delivered`)
    }
    records.push({ mode, ...fixture, cleanupWaits: fixture.cleanupWaits.map(entry => ({ ...entry })), writes: res.writes.length })
  }

  // Explicit caller signals and the owning HTTP request must BOTH cancel an
  // operation; separate overlapping requests must not share their controller.
  const a = makePair({}), b = makePair({})
  const explicit = new AbortController()
  let started = 0
  let transportAborts = 0
  globalThis.fetch = async (_url, init) => {
    const name = JSON.parse(init.body).messages[0].content
    started++
    if (name === 'unaffected') return response('unaffected result')
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { transportAborts++; reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
      queueMicrotask(() => name === 'explicit' ? explicit.abort() : a.res.emit('close'))
    })
  }
  const completed = await Promise.all([
    withRequestCancellation(a.req, a.res, () => chatComplete([{ role: 'user', content: 'own request' }], { providers: [{ label: 'primary', model: 'fixture', base: 'https://provider.example', key: 'synthetic' }], maxAttempts: 1 })),
    withRequestCancellation(b.req, b.res, () => chatComplete([{ role: 'user', content: 'unaffected' }], { providers: [{ label: 'primary', model: 'fixture', base: 'https://provider.example', key: 'synthetic' }], maxAttempts: 1 })),
  ])
  assert.deepEqual(completed, [undefined, 'unaffected result'])
  const c = makePair({})
  await assert.rejects(withRequestCancellation(c.req, c.res, () => chatComplete([{ role: 'user', content: 'explicit' }], { signal: explicit.signal, providers: [{ label: 'primary', model: 'fixture', base: 'https://provider.example', key: 'synthetic' }], maxAttempts: 1 })), error => error.name === 'AbortError')
  assert.equal(started, 3)
  assert.equal(transportAborts, 2)
  if (process.env.OUTPUT_DIR) { await mkdir(process.env.OUTPUT_DIR, { recursive: true }); await writeFile(join(process.env.OUTPUT_DIR, 'studio-cancellation.json'), JSON.stringify({ at: new Date().toISOString(), records, concurrency: 'Separate requests preserved; either explicit or HTTP cancellation aborts transport', quotaPolicy: 'Refund a reserved design when no result was delivered, including disconnect; charge normally completed results.' }, null, 2)) }
  console.log('Studio cancellation regressions passed: research, plan, build, edit, repair, continuation, fallback; no later provider/response, transport abort, one quota refund, normal request close, Vercel request error/signal plus cleanup lifetime, unavailable-runtime refund and concurrent request isolation.')
} finally {
  globalThis.fetch = originalFetch
  if (originalRequestContext === undefined) delete globalThis[requestContextSymbol]; else globalThis[requestContextSymbol] = originalRequestContext
  delete globalThis.cancelFixture
  for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key] }
  await rm(directory, { recursive: true, force: true })
}
