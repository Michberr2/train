// Real handlers/store SQL; isolated SQLite + synthetic provider, no paid calls.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import Module from 'node:module'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
const savedFetch = globalThis.fetch, savedKey = process.env.BROWSER_USE_API_KEY
const compiled = await build({ stdin: { contents: "export {default as browser} from './api/browser'; export * from './api/_browserWorkspace'; export * from './api/_browserWorkspaceStore'; export {CloudflareStore} from './_cloudflareStore'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'boundaries', setup(b) {
  const sources = { './_db': `export const readToken=r=>(r.headers.authorization||'').replace(/^Bearer /,'');`, './_connectionBackend': `export const connectionBackend=()=>globalThis.fixture.backend();`, './_limits': `export const reserveDailyQuota=(...a)=>globalThis.fixture.quota(...a); export const studioLimitMessage=()=>'';`, './_cloudflareStore': `export class CloudflareStore {query(...a){return globalThis.fixture.query(...a)} batch(s){return Promise.resolve({results:s.map(x=>globalThis.fixture.query(x.sql,x.params))})}}`, '@vercel/functions': 'export const waitUntil=()=>{};' }
  b.onResolve({ filter: /.*/ }, a => a.path in sources ? { path: a.path, namespace: 'boundary' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'boundary' }, a => ({ contents: sources[a.path], loader: 'js' }))
} }] })
const mod = new Module(`${process.cwd()}/scripts/.browser-workspace.cjs`); mod.filename = `${process.cwd()}/scripts/.browser-workspace.cjs`; mod.paths = Module._nodeModulePaths(process.cwd()); mod._compile(compiled.outputFiles[0].text, mod.filename)
const api = mod.exports
let db, calls, tasks, sessions, quotaOk, count, refunds, gate, cloud
function reset(useCloud = true) {
  db?.close(); db = new DatabaseSync(':memory:'); db.exec("CREATE TABLE nalu_users(id TEXT PRIMARY KEY); INSERT INTO nalu_users VALUES('owner'),('other');")
  db.exec(readFileSync('cloudflare/nalu-data/migrations/0018_browser_workspaces.sql', 'utf8'))
  db.exec("CREATE TABLE nalu_tasks(id TEXT PRIMARY KEY,user_id TEXT,source TEXT,title TEXT,detail TEXT,status TEXT,progress REAL,events TEXT DEFAULT '[]',meta TEXT DEFAULT '{}',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  calls = []; tasks = new Map(); sessions = new Map(); quotaOk = true; count = 0; refunds = 0; gate = null; cloud = useCloud
  process.env.BROWSER_USE_API_KEY = 'test-provider-key'
  const query = (sql, params = []) => ({ results: db.prepare(sql).all(...params) })
  globalThis.fixture = { query, backend: () => ({ connect: async () => {}, close: async () => {}, userId: async token => ['owner', 'other'].includes(token) ? token : null,
    client: cloud ? new api.CloudflareStore() : { query: async (sql, p = []) => {
      if (sql.startsWith('CREATE TABLE')) return { rows: [] }
      const converted = sql.replace(/\$(\d+)/g, '?$1').replace(/::jsonb/g, '').replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP')
      return { rows: query(converted, p).results }
    } } }), quota: async () => ({ ok: quotaOk, signedIn: true, status: 429, release: async () => { refunds++ } }) }
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v2', ''), body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ path, method: options.method, body }); assert.equal(options.headers['X-Browser-Use-API-Key'], 'test-provider-key')
    await gate?.(path, body)
    if (path === '/profiles') return Response.json({ id: `profile-${++count}` })
    if (path === '/sessions') { const id = `session-${++count}`; const s = { id, status: 'active', liveUrl: `https://live.browser-use.com/${id}`, tasks: [], profileId: body.profileId }; sessions.set(id, s); return Response.json(s) }
    if (path === '/tasks') { const id = `remote-${++count}`; const t = { id, sessionId: body.sessionId, status: 'started', metadata: body.metadata, steps: [], outputFiles: [] }; tasks.set(id, t); sessions.get(body.sessionId).tasks.push(t); return Response.json(t) }
    if (path.startsWith('/sessions/')) { const s = sessions.get(path.split('/')[2]); if (body) s.status = 'stopped'; return Response.json(s) }
    if (path.startsWith('/tasks/')) { const t = tasks.get(path.split('/')[2]); if (body) t.status = 'stopped'; return Response.json(t) }
    if (path.startsWith('/files/')) return Response.json({ id: 'file-1', fileName: 'budget.xlsx', downloadUrl: 'https://files.example.com/budget.xlsx' })
    throw Error('Unexpected provider endpoint ' + path)
  }
}
async function run(action, rest = {}, token = 'owner') {
  const req = new EventEmitter(), res = new EventEmitter()
  Object.assign(req, { method: 'POST', headers: { authorization: token ? `Bearer ${token}` : '' }, body: { action, ...rest } })
  Object.assign(res, { setHeader() {}, status(code) { this.code = code; return this }, json(data) { this.data = data; this.writableEnded = true; return this } })
  await api.browser(req, res); return res
}
function state(owner = 'owner') { return JSON.parse(db.prepare('SELECT state FROM nalu_browser_workspaces WHERE user_id=?').get(owner).state) }
let total = 0
async function test(name, fn) { reset(); await fn(); console.log('PASS', name); total++ }
try {
 await test('authentication and input validation prevent provider calls', async () => {
  for (const token of ['', 'invalid']) assert.equal((await run('workspace_open', {}, token)).code, 401)
  assert.equal((await run('workspace_run', { task: 'a'.repeat(6001) })).code, 400)
  assert.equal((await run('workspace_open', { url: 'file:///etc/passwd' })).code, 400)
  assert.equal(calls.length, 0)
 })
 await test('unconfigured service does not pretend a browser is available', async () => { delete process.env.BROWSER_USE_API_KEY; const r = await run('workspace_status'); assert.equal(r.data.configured, false); assert.equal(calls.length, 0) })
 for (const useCloud of [true, false]) await test(`${useCloud ? 'D1' : 'Postgres'} profile reuse and account isolation`, async () => {
  reset(useCloud); const first = await run('workspace_open'); assert.equal(first.code, 200, JSON.stringify(first.data)); const profile = state().profileId
  await run('workspace_close'); await run('workspace_open'); assert.equal(state().profileId, profile)
  await run('workspace_open', {}, 'other'); assert.notEqual(state('other').profileId, profile); assert.notEqual(state('other').sessionId, state().sessionId)
  assert.equal(calls.filter(c => c.path === '/profiles').length, 2); assert.ok(!JSON.stringify(first.data).includes(profile))
 })
 await test('leases reject a second tab before any duplicate create', async () => {
  const store = new api.BrowserWorkspaceStore(fixture.backend().client); const c = await store.claim('owner')
  assert.equal((await run('workspace_open')).code, 409); assert.equal(calls.length, 0); await store.release('owner', c.lease)
 })
 await test('quota fails closed before profiles/sessions/tasks are created', async () => { quotaOk = false; assert.equal((await run('workspace_run', { task: 'Update budget' })).code, 429); assert.equal(calls.length, 0) })
 await test('chat work uses same browser and durable task ledger, serializes tasks, takeover stops AI', async () => {
  await run('workspace_open'); const session = state().sessionId
  const r = await run('workspace_run', { task: 'Update my Excel workbook and verify the saved file' }); assert.equal(r.code, 200); assert.equal(r.data.status, 'queued')
  const create = calls.find(c => c.path === '/tasks'); assert.equal(create.body.sessionId, session); assert.equal(create.body.maxSteps, 60)
  assert.match(create.body.systemPromptExtension, /verify the saved/); assert.equal(db.prepare('SELECT user_id FROM nalu_tasks').get().user_id, 'owner')
  assert.equal((await run('workspace_run', { task: 'Duplicate' })).code, 409)
  const stopped = await run('workspace_takeover'); assert.equal(stopped.data.status, 'cancelled'); assert.equal(stopped.data.active, true)
  assert.equal((await run('workspace_run', { task: 'Continue after my login' })).code, 200)
 })
 await test('completion requires explicit success; output downloads are account scoped', async () => {
  await run('workspace_run', { task: 'Make a workbook' }); const task = tasks.get(state().remoteTaskId); task.status = 'finished'; task.output = 'Saved in OneDrive'; task.outputFiles = [{ id: 'file-1', fileName: 'budget.xlsx' }]
  assert.equal((await run('workspace_status')).data.status, 'finished'); assert.equal(db.prepare('SELECT status FROM nalu_tasks').get().status, 'waiting'); task.isSuccess = true
  assert.equal((await run('workspace_status')).data.status, 'done')
  assert.equal((await run('workspace_download', { file_id: 'file-1' }, 'other')).code, 404)
  assert.equal((await run('workspace_download', { file_id: 'file-2' })).code, 404)
  assert.equal((await run('workspace_download', { file_id: 'file-1' })).data.name, 'budget.xlsx')
 })
 await test('uncertain POST is not retried and can recover by task receipt', async () => {
  await run('workspace_open'); const original = globalThis.fetch
  globalThis.fetch = async (...args) => { const response = await original(...args); if (args[0].endsWith('/tasks')) throw Error('connection lost after acceptance'); return response }
  assert.equal((await run('workspace_run', { task: 'Save document' })).code, 502); assert.equal(state().pending, 'task')
  globalThis.fetch = original; assert.equal((await run('workspace_status')).data.status, 'running'); assert.equal(state().pending, undefined)
  assert.equal(calls.filter(c => c.path === '/tasks').length, 1)
 })
 await test('unknown profile creation stays blocked, and live URL policy rejects unsafe hosts', async () => {
  gate = async path => { if (path === '/profiles') throw Error('unknown outcome') }
  assert.equal((await run('workspace_open')).code, 502); gate = null
  assert.equal((await run('workspace_open')).code, 409); assert.equal(calls.length, 1)
  for (const url of ['javascript:alert(1)', 'https://evil.example.com', 'https://browser-use.com.evil.example/', 'https://u:p@live.browser-use.com/']) assert.equal(api.browserLiveUrl(url), '')
  assert.match(api.browserLiveUrl('https://live.browser-use.com/view'), /^https:/)
 })
 console.log(`PASS ${total} browser workspace integration groups; synthetic provider only`)
} finally { db?.close(); globalThis.fetch = savedFetch; if (savedKey === undefined) delete process.env.BROWSER_USE_API_KEY; else process.env.BROWSER_USE_API_KEY = savedKey }
