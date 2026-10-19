// Real video handler, request lifetime, provider ladder, LLM and body reader.
// Only quota storage, timers and HTTP transports are synthetic; no network.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const keys = ['DEEPINFRA_API_KEY','DEEPINFRA_TOKEN','FAL_KEY','FAL_API_KEY','HUGGINGFACE_API_TOKEN','HF_TOKEN','GEMINI_API_KEY','GOOGLE_AI_API_KEY','GOOGLE_GENAI_API_KEY','NALU_VIDEO_BASE_URL','NALU_VIDEO_API_KEY','TINKER_API_KEY','NALU_VIDEO_FREE_SPACES','NALU_DISABLE_EMERGENCY']
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const records = []
let fixture
const pair = (body = { prompt: 'A bird in flight', fast: true }) => {
  const controller = new AbortController()
  const req = Object.assign(new EventEmitter(), { method: 'POST', body, headers: {}, signal: controller.signal })
  const res = Object.assign(new EventEmitter(), { writableEnded: false, writes: [], setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.writes.push({ code: this.code, payload }); this.writableEnded = true; this.emit('close'); return this }, end() { this.writableEnded = true } })
  return { req, res, controller }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })
const completed = url => json({ video_url: url })
const within = async promise => { let timeout; try { return await Promise.race([promise, new Promise((_, reject) => { timeout = originalSetTimeout(() => reject(new Error('Cancellation did not settle promptly')), 1200) })]) } finally { clearTimeout(timeout) } }
const setup = () => globalThis.__videoFixture = fixture = { reservations: 0, releases: 0, calls: [], waits: [], releasedBodies: 0, timerHook: null, quotaOk: true }
const clean = p => { assert.equal(p.req.listenerCount('aborted'), 0); assert.equal(p.req.listenerCount('error'), 0); assert.equal(p.res.listenerCount('close'), 0); assert.ok(fixture.waits.every(w => w.done), 'Vercel cleanup completes after refunds') }
try {
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, { DEEPINFRA_API_KEY: 'synthetic', FAL_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic', HUGGINGFACE_API_TOKEN: 'synthetic', TINKER_API_KEY: 'synthetic', NALU_VIDEO_FREE_SPACES: 'https://video-fixture.invalid', NALU_DISABLE_EMERGENCY: '1' })
  const bundled = await build({ entryPoints: ['api/video.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', plugins: [{ name: 'offline-video', setup(builder) {
    builder.onResolve({ filter: /^\.\/_limits$|^@vercel\/functions$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === './_limits' ? `export async function reserveDailyQuota(){const f=globalThis.__videoFixture;f.reservations++;if(!f.quotaOk)return {ok:false,status:503,reason:'unavailable'};let released=false;return {ok:true,release:async()=>{if(released)return;released=true;if(f.waits.every(w=>w.done))throw Error('cleanup expired before refund');await Promise.resolve();f.releases++}}}` : `export function waitUntil(p){const record={done:false};globalThis.__videoFixture.waits.push(record);p.then(()=>record.done=true)}` }))
  } }] })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
  const handler = mod.exports.default
  globalThis.setTimeout = (fn, ms, ...args) => {
    if ([2000,4000,5000,8000].includes(ms)) {
      if (fixture.timerHook) { const timer = originalSetTimeout(fn, ms, ...args); queueMicrotask(() => fixture.timerHook(ms)); return timer }
      return originalSetTimeout(fn, 0, ...args)
    }
    return originalSetTimeout(fn, ms, ...args)
  }
  for (const mode of ['success','normal-request-close','fallback','quota-unavailable','cancel-signal','cancel-request-error','cancel-response-close','ignored-signal','response-body','fal-poll-sleep','free-pool-backoff','enrichment']) {
    setup()
    const p = pair(mode === 'enrichment' ? { prompt: 'A bird in flight' } : { prompt: 'A bird in flight', fast: true })
    if (mode === 'quota-unavailable') fixture.quotaOk = false
    let lateResolve
    fixture.timerHook = ['fal-poll-sleep','free-pool-backoff'].includes(mode) ? ms => { assert.equal(ms, mode === 'fal-poll-sleep' ? 2000 : 4000); p.controller.abort() } : null
    globalThis.fetch = async (url, init) => {
      const address = String(url)
      fixture.calls.push(address)
      assert.ok(init.signal && !init.signal.aborted, `${mode}: live owning signal reaches transport`)
      assert.ok(fixture.waits.some(w => !w.done), 'cleanup lifetime registered before transport')
      if (mode === 'normal-request-close') p.req.emit('close')
      if (['cancel-signal','cancel-request-error','cancel-response-close','enrichment'].includes(mode)) {
        return await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
          queueMicrotask(() => mode === 'cancel-request-error' ? p.req.emit('error', new Error('aborted')) : mode === 'cancel-response-close' ? p.res.emit('close') : p.controller.abort())
        })
      }
      if (mode === 'ignored-signal') {
        queueMicrotask(() => p.controller.abort())
        return await new Promise(resolve => { lateResolve = resolve })
      }
      if (mode === 'response-body') {
        return new Response(new ReadableStream({ pull() { queueMicrotask(() => p.controller.abort()) }, cancel() { fixture.releasedBodies++ } }))
      }
      if (mode === 'free-pool-backoff') return new Response('Unavailable', { status: 503 })
      if (['fallback','fal-poll-sleep'].includes(mode)) {
        if (address.includes('deepinfra.com')) return new Response('Unavailable', { status: 503 })
        if (address === 'https://queue-fixture.invalid/status') return json({ status: 'COMPLETED' })
        if (address === 'https://queue-fixture.invalid/result') return json({ video: { url: 'https://media.invalid/fallback.mp4' } })
        assert.ok(address.includes('queue.fal.run'))
        return json({ status_url: 'https://queue-fixture.invalid/status', response_url: 'https://queue-fixture.invalid/result' })
      }
      assert.ok(address.includes('deepinfra.com'))
      return completed('https://media.invalid/result.mp4')
    }
    await within(handler(p.req, p.res))
    if (lateResolve) { lateResolve(new Response(new ReadableStream({ cancel() { fixture.releasedBodies++ } }))); await new Promise(resolve => originalSetTimeout(resolve, 0)); assert.equal(fixture.releasedBodies, 1, 'late ignored-signal response body discarded') }
    clean(p)
    if (['success','normal-request-close','fallback'].includes(mode)) {
      assert.equal(p.res.writes.length, 1)
      assert.equal(p.res.writes[0].code, 200)
      assert.equal(p.res.writes[0].payload.backend, mode === 'fallback' ? 'fal' : 'deepinfra')
      assert.equal(fixture.releases, 0, 'completed video keeps its quota')
      assert.equal(fixture.calls.length, mode === 'fallback' ? 4 : 1)
    } else if (mode === 'quota-unavailable') {
      assert.equal(p.res.writes[0].code, 503)
      assert.equal(fixture.calls.length, 0)
    } else {
      assert.equal(p.res.writes.length, 0, `${mode}: no late response`)
      assert.equal(fixture.releases, 1, `${mode}: refund reserved slot once`)
      assert.equal(fixture.calls.length, mode === 'fal-poll-sleep' ? 2 : mode === 'free-pool-backoff' ? 3 : 1, `${mode}: no later provider/poll`)
      if (mode === 'response-body') assert.equal(fixture.releasedBodies, 1, 'cancel and unlock body reader')
      if (mode === 'enrichment') assert.ok(!fixture.calls[0].includes('/inference/'), 'cancel actual LLM enrichment before any video submission')
    }
    records.push(mode)
  }
  setup()
  const a = pair({ prompt: 'cancel me', fast: true }), b = pair({ prompt: 'leave me running', fast: true })
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).prompt
    fixture.calls.push(prompt)
    if (prompt.startsWith('leave')) return completed('https://media.invalid/unaffected.mp4')
    return await new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); queueMicrotask(() => a.controller.abort()) })
  }
  await within(Promise.all([handler(a.req, a.res), handler(b.req, b.res)]))
  assert.equal(a.res.writes.length, 0); assert.equal(b.res.writes[0].code, 200); assert.equal(fixture.releases, 1); assert.equal(fixture.reservations, 2)
  clean(a); clean(b); records.push('concurrent-isolation')
  console.log(`Video cancellation regressions passed (${records.length}): ${records.join(', ')}.`)
} finally {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
  delete globalThis.__videoFixture
  for (const key of keys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key] }
}
