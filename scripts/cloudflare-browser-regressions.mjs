import assert from 'node:assert/strict'
import { build } from 'esbuild'
import Module from 'node:module'
const compiled = await build({ entryPoints: ['cloudflare/nalu-browser/worker.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'browser-fixture', setup(b) { b.onResolve({ filter: /^@cloudflare\/puppeteer$/ }, () => ({ path: 'driver', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default {acquire:async()=>({sessionId:"session-1"}),connect:async()=>globalThis.driver,launch:async()=>globalThis.driver}' })) } }] })
const module = new Module('browser-test'); module._compile(compiled.outputFiles[0].text, 'browser-test.cjs')
const { BrowserWorkspace, default: service } = module.exports
const state = new Map(); let alarm, clicks = 0, connections = 0
const ctx = { blockConcurrencyWhile: f => f(), storage: { get: async k => structuredClone(state.get(k)), put: async (k, v) => typeof k === 'string' ? state.set(k, structuredClone(v)) : Object.entries(k).forEach(([key, value]) => state.set(key, structuredClone(value))), setAlarm: async v => { alarm = v } } }
const cdp = { send: async method => method === 'Storage.getCookies' ? { cookies: [] } : { devtoolsFrontendUrl: 'https://live.browser.run/ui/view?wss=private-test' }, detach: async () => {} }
const handle = { evaluate: async f => f.toString().includes('getBoundingClientRect') ? { label: 'Save', tag: 'BUTTON' } : false, click: async () => { clicks++ } }
const page = { target: () => ({ createCDPSession: async () => cdp }), setViewport: async () => {}, evaluateOnNewDocument: async () => {}, goto: async () => {}, url: () => 'https://example.com/', title: async () => 'Test page', evaluate: async f => f.toString().includes('localStorage') ? {} : 'Observed saved result', $$: async () => [handle] }
globalThis.driver = { target: () => ({ createCDPSession: async () => cdp }), sessionId: () => 'session-1', pages: async () => { connections++; return [page] }, disconnect() {}, close: async () => {} }
let output = JSON.stringify({ action: 'done', reason: 'Observed saved result' })
const env = { BROWSER: {}, AI: { run: async () => ({ response: output }) } }
let worker = new BrowserWorkspace(ctx, env)
async function req(path, body, method = body ? 'POST' : 'GET') { const r = await worker.fetch(new Request('https://service.test' + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })); return { status: r.status, data: await r.json() } }
assert.equal((await service.fetch(new Request('https://service.test/profiles'), {})).status, 401)
assert.equal((await service.fetch(new Request('https://service.test/profiles', { headers: { Authorization: 'Bearer key' } }), { SERVICE_KEY: 'key' })).status, 400)
const profile = (await req('/profiles', {})).data.id
assert.equal((await req('/sessions', { profileId: 'foreign' })).status, 404)
assert.equal((await req('/sessions', { profileId: profile, startUrl: 'http://127.0.0.1/' })).status, 400)
assert.equal((await req('/sessions', { profileId: profile, startUrl: 'https://example.com' })).data.status, 'active')
assert.equal((await req('/sessions/foreign')).status, 404)
const start = () => req('/tasks', { sessionId: 'session-1', task: 'Read the page', metadata: { naluTaskId: crypto.randomUUID() } })
const first = (await start()).data
assert.ok(alarm); assert.equal((await start()).status, 409)
await worker.alarm(); assert.equal((await req('/tasks/' + first.id)).data.isSuccess, true)
output = JSON.stringify({ action: 'evaluate', reason: 'Run arbitrary code', code: 'alert(1)' })
const invalid = (await start()).data; await worker.alarm(); assert.equal((await req('/tasks/' + invalid.id)).data.status, 'failed'); assert.equal(clicks, 0)
// A persisted inflight action after an isolate restart must never be repeated.
const interrupted = (await start()).data; const snapshot = state.get('workspace'); snapshot.task.inflight = true; state.set('workspace', snapshot)
worker = new BrowserWorkspace(ctx, env); await worker.alarm(); assert.equal((await req('/tasks/' + interrupted.id)).data.status, 'failed'); assert.equal(clicks, 0)
// Stop arriving while model inference is pending prevents its eventual click.
let finish, began; const entered = new Promise(r => { began = r })
env.AI.run = async () => { began(); return new Promise(r => { finish = r }) }
const running = (await start()).data; const work = worker.alarm(); await entered
const before = connections; assert.equal((await req('/sessions/session-1')).data.status, 'active'); assert.equal(connections, before)
assert.equal((await req('/tasks/' + running.id, { action: 'stop' }, 'PATCH')).status, 409)
finish({ response: JSON.stringify({ action: 'click', index: 0, reason: 'Click Save' }) }); await work
assert.equal((await req('/tasks/' + running.id)).data.status, 'stopped'); assert.equal(clicks, 0)
assert.equal((await req('/sessions/session-1', { action: 'stop' }, 'PATCH')).data.status, 'stopped')
console.log('PASS browser service authentication, owner IDs, restricted URLs/actions, task limits, interrupted action recovery, concurrent monitoring, and takeover during inference')
