// COMPAT-1 integration: actual web UI/save + API/Worker/SQLite + mobile list/dispatch.
// This uses synthetic accounts and an isolated browser. It never runs queued jobs,
// contacts a provider, controls a phone, or changes production account data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { build, transform } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = path.resolve(root, '../nalumobile')
const output = process.env.OUTPUT_DIR || '/tmp/nalu-flow-cross-client-integration'
const require = createRequire(import.meta.url)
const owner = 'compat-integration-owner'
const token = 'compat-integration-synthetic-session'
const secret = 'isolated-compat-worker-auth-key-123456789'
const oldEnv = { ...process.env }, oldFetch = globalThis.fetch
const db = new DatabaseSync(':memory:')
const report = {
  checkedAt: new Date().toISOString(), finding: 'COMPAT-1', passed: false,
  scope: 'Actual browser workflow import/rename/save, API load, mobile list and assistant command dispatch, and persisted queued job IDs.',
  adapters: ['In-memory SQLite implements the D1 binding; actual Worker, migrations, request signing and API session lookup run.', 'Expo fetch forwards to the isolated request transport. AsyncStorage and Expo filesystem are unavailable and fail if called.', 'Actual AgentsPanel and web sync mount in a Vite test entry. Auxiliary connection/output listing APIs return empty fixture lists.'],
  limits: ['No physical iPhone UI, microphone, speech recognition, or voice acoustics are exercised.', 'Dispatch acceptance is proved by the real API and queued job records. Jobs are not executed.', 'Synthetic identities and in-memory storage only; no live account or provider requests.'],
  checks: [], requests: [], blockedRequests: [], sourceHashes: {}, representations: [], pageErrors: [], browserConsole: [],
}
function record(name) { report.checks.push(name); console.log(`PASS ${name}`) }
async function bundle(contents, options = {}) {
  return build({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, write: false,
    format: 'cjs', platform: 'node', target: 'es2022', ...options })
}
function loadBundle(result, loader = require) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(loader, module, module.exports)
  return module.exports
}
let browser, server, api, worker, env, origin, page
async function invoke(body, auth = token) {
  const response = { code: 200, headers: {}, status(code) { this.code = code; return this },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    json(value) { this.body = value; return this }, send(value) { this.body = value; return this }, end() {} }
  await api.dataHandler({ method: 'POST', body, headers: auth ? { authorization: `Bearer ${auth}` } : {} }, response)
  return response
}
async function expectAPI(body) {
  const response = await invoke(body)
  assert.ok(response.code >= 200 && response.code < 300, JSON.stringify({ body, response }))
  return response.body
}
try {
  await mkdir(output, { recursive: true })
  db.exec('PRAGMA foreign_keys=ON')
  const migrationRoot = path.join(root, 'cloudflare/nalu-data/migrations')
  for (const file of (await readdir(migrationRoot)).filter(name => name.endsWith('.sql')).sort()) db.exec(await readFile(path.join(migrationRoot, file), 'utf8'))
  db.prepare('INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)').run(owner, 'Compatibility fixture', 'synthetic-salt', 'synthetic-hash')
  db.prepare('INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)').run(token, owner)
  let batchTail = Promise.resolve()
  env = { NALU_DATA_SECRET: secret, DB: {
    prepare(sql) { return { sql, params: [], bind(...params) { this.params = params; return this },
      async all() { return { results: db.prepare(this.sql).all(...this.params) } },
      async first() { return db.prepare(this.sql).get(...this.params) || null } } },
    async batch(statements) {
      const previous = batchTail; let unlock
      batchTail = new Promise(resolve => { unlock = resolve }); await previous
      db.exec('BEGIN')
      try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec('COMMIT'); return results }
      catch (error) { db.exec('ROLLBACK'); throw error }
      finally { unlock() }
    },
  } }
  worker = loadBundle(await bundle("export { default } from './cloudflare/nalu-data/worker'", { platform: 'browser' })).default
  api = loadBundle(await bundle("export { default as dataHandler } from './api/data'", { external: ['sharp'] }))
  Object.assign(process.env, { NALU_STORAGE_BACKEND: 'cloudflare', CLOUDFLARE_DATA_URL: 'https://fixture.invalid', CLOUDFLARE_DATA_SECRET: secret })
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.origin === 'https://fixture.invalid') return worker.fetch(request, env)
    if (url.origin === 'https://n4lu.ai' && url.pathname === '/api/data' && request.method === 'POST') {
      const body = await request.json()
      report.requests.push({ surface: 'mobile', action: body.action, flowId: body.flowId, mode: body.mode })
      const response = await invoke(body, (request.headers.get('authorization') || '').replace(/^Bearer /, ''))
      return Response.json(response.body, { status: response.code, headers: response.headers })
    }
    report.blockedRequests.push({ transport: 'node', method: request.method, origin: url.origin, path: url.pathname })
    throw new Error(`Unexpected network request blocked: ${request.method} ${url.origin}${url.pathname}`)
  }
  assert.equal((await invoke({ action: 'load' }, 'invalid-synthetic-session')).code, 401)
  assert.deepEqual((await expectAPI({ action: 'load' })).data, {})
  record('Real API session authentication rejects an unknown token and loads the isolated owner')

  const nativeModules = new Set(['expo/fetch', 'expo-file-system', '@react-native-async-storage/async-storage'])
  const mobile = loadBundle(await bundle(`export { loadFlows } from ${JSON.stringify(path.join(mobileRoot, 'src/api.ts'))}; export { assistantTurn } from ${JSON.stringify(path.join(mobileRoot, 'src/assistant.ts'))};`, { external: [...nativeModules] }), id => {
    if (id === 'expo/fetch') return { fetch: (...args) => globalThis.fetch(...args) }
    if (nativeModules.has(id)) return new Proxy({}, { get(_target, key) {
      if (key === '__esModule') return false
      throw new Error(`Unexpected native runtime access in flow contract: ${id}.${String(key)}`)
    } })
    return require(id)
  })

  const clientRoot = path.join(root, 'client')
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import AgentsPanel from '/src/components/workspace/AgentsPanel.tsx'; import {installSync,loadFromServer} from '/src/lib/sync.ts'; import '/src/globals.css'; installSync(); await loadFromServer(); createRoot(document.getElementById('root')).render(<AgentsPanel/>);`
  server = await createServer({ configFile: false, root: clientRoot, cacheDir: path.join(output, 'vite-cache'),
    css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [path.join(clientRoot, 'src/**/*.{ts,tsx}')] })] } },
    plugins: [react(), { name: 'flow-compat-entry', resolveId(id) { if (id === '/@flow-compat-entry') return '\0flow-compat-entry' },
      load(id) { if (id === '\0flow-compat-entry') return entry },
      transform(code, id) { if (id === '\0flow-compat-entry') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
      configureServer(vite) { vite.middlewares.use('/__flow-compat', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/__flow-compat', '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/@flow-compat-entry"></script></body></html>'))
      }) },
    }], server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false } })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('nalu-token', token)
    localStorage.setItem('nalu-data-owner', owner)
    // Keep the real fresh-account defaults. Tombstoning every starter while
    // providing no saved flow makes AgentsPanel render null, not an empty editor.
  }, { token, owner })
  const webSaves = []
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) {
      report.blockedRequests.push({ transport: 'browser', method: request.method(), origin: url.origin, path: url.pathname })
      return route.abort()
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/data') {
      const body = request.postDataJSON() || {}
      report.requests.push({ surface: 'web', action: body.action, keys: Object.keys(body.entries || {}) })
      if (body.action === 'setMany' && body.entries?.['nalu-agent-flows']) webSaves.push(body.entries['nalu-agent-flows'])
      const response = await invoke(body, (request.headers().authorization || '').replace(/^Bearer /, ''))
      return route.fulfill({ status: response.code, headers: response.headers, json: response.body })
    }
    if (url.pathname === '/api/connect' || url.pathname === '/api/artifacts') return route.fulfill({ json: { ok: true, items: [], outputs: [], connections: [] } })
    report.blockedRequests.push({ transport: 'browser-api', method: request.method(), path: url.pathname })
    return route.abort()
  })
  page = await context.newPage()
  page.on('pageerror', error => report.pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') report.browserConsole.push({ type: message.type(), text: message.text() })
  })
  await page.goto(`${origin}/__flow-compat`)
  await expect(page.getByLabel('Workflow name', { exact: true })).toBeVisible({ timeout: 45000 })
  await page.getByRole('button', { name: 'More workflow actions', exact: true }).click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /^Import a pipeline/ }).click()])
  await chooser.setFiles({ name: 'inert-flow.nalu.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    nalu: 'autopilot-flow', v: 1, flow: { id: 'untrusted-import-id', name: 'Imported compatibility flow', schedule: 'manual', enabled: false,
      nodes: [{ id: 'input', type: 'trigger', triggerKind: 'manual', label: 'Inert test input', prompt: 'No external actions', x: 40, y: 40 }], edges: [] },
  })) })
  await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue('Imported compatibility flow')
  const name = 'Cross client compatibility flow'
  await page.getByLabel('Workflow name', { exact: true }).fill(name)
  await expect.poll(async () => webSaves.some(value => JSON.parse(value).some(flow => flow.name === name)), { timeout: 15000 }).toBe(true)
  let webValue
  await expect.poll(async () => {
    webValue = (await expectAPI({ action: 'load' })).data['nalu-agent-flows']
    return typeof webValue === 'string' && JSON.parse(webValue).some(flow => flow.name === name)
  }, { timeout: 15000 }).toBe(true)
  const flows = JSON.parse(webValue), flow = flows.find(item => item.name === name)
  assert.notEqual(flow.id, 'untrusted-import-id', 'Real import generated a stable new ID')
  assert.equal(flow.nodes.length, 1); assert.equal(flow.nodes[0].type, 'trigger')
  assert.equal(flow.enabled, false)
  assert.ok(webSaves.includes(webValue), 'API retained the actual complete serialized web save')
  report.webSavedFlow = { id: flow.id, name: flow.name, nodes: flow.nodes.length, enabled: flow.enabled }
  await page.screenshot({ path: path.join(output, 'web-saved-flow.png'), fullPage: true })
  assert.deepEqual(report.pageErrors, [])
  await context.close()
  record('Actual web import and rename serialize and sync the inert manual workflow through the real API/Worker')

  for (const [representation, value] of [['web-json-string', webValue], ['legacy-array', flows], ['nested-legacy-string', JSON.stringify(webValue)]]) {
    if (representation !== 'web-json-string') await expectAPI({ action: 'set', key: 'nalu-agent-flows', value })
    const listed = await mobile.loadFlows(token)
    assert.deepEqual(listed.find(item => item.id === flow.id), { id: flow.id, name })
    const runs = []
    for (const [command, mode] of [[`run pipeline ${name}`, 'run'], [`resume flow ${flow.id}`, 'resume']]) {
      if (mode === 'resume') {
        // Resume is valid only for a flow with a persisted continuation. Seed
        // the isolated fixture with one so this check exercises the real
        // resume dispatch path instead of asserting an invalid request.
        const resumable = flows.map(item => item.id === flow.id
          ? { ...item, run: { status: 'running', startedAt: Date.now(), revision: 1 } }
          : item)
        await expectAPI({ action: 'set', key: 'nalu-agent-flows', value: resumable })
      }
      const before = db.prepare('SELECT COUNT(*) AS count FROM nalu_task_jobs WHERE user_id=?').get(owner).count
      const errors = [], deltas = []
      const reply = await mobile.assistantTurn([{ role: 'user', content: command }], { onError: error => errors.push(error), onDelta: delta => deltas.push(delta) }, token)
      assert.deepEqual(errors, [], reply)
      assert.equal(reply, `Pipeline ${name}: queued.`)
      assert.equal(deltas.join(''), reply)
      const jobs = db.prepare('SELECT flow_id,mode,status,kind,target FROM nalu_task_jobs WHERE user_id=? ORDER BY rowid').all(owner)
      assert.equal(jobs.length, before + 1)
      const job = jobs.at(-1)
      assert.equal(job.flow_id, flow.id); assert.equal(job.mode, mode)
      assert.equal(job.status, 'queued'); assert.equal(job.kind, 'pipeline'); assert.equal(job.target, 'cloud')
      runs.push({ command, resolvedFlowId: job.flow_id, mode: job.mode, status: job.status })
    }
    report.representations.push({ representation, listedStableId: flow.id, runs })
    record(`Actual mobile list, name/ID resolution and persisted run/resume dispatch: ${representation}`)
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM nalu_task_jobs WHERE status<>'queued'").get().count, 0)
  assert.deepEqual(report.blockedRequests, [], 'No unexpected network/API traffic occurred')
  record('All six jobs remain queued in memory; no provider calls, native effects, or production mutations')
  for (const relative of ['client/src/components/workspace/AgentsPanel.tsx', 'client/src/lib/sync.ts', 'api/data.ts', 'api/_cloudflareData.ts', 'api/_cloudflareTasks.ts', 'cloudflare/nalu-data/worker.ts', '../nalumobile/src/api.ts', '../nalumobile/src/assistant.ts', '../nalumobile/src/commands.ts']) {
    report.sourceHashes[relative] = createHash('sha256').update(await readFile(path.resolve(root, relative))).digest('hex')
  }
  report.passed = true
} catch (error) {
  report.error = String(error.stack || error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<fixture bundle>')
  if (page && !page.isClosed()) {
    report.diagnostics = { url: page.url() }
    try {
      await writeFile(path.join(output, 'failure-page.html'), await page.content())
      report.diagnostics.html = 'failure-page.html'
      report.diagnostics.bodyText = (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 16000)
    } catch (diagnosticError) { report.diagnostics.domError = String(diagnosticError) }
    try {
      await page.screenshot({ path: path.join(output, 'failure-page.png'), fullPage: true, timeout: 5000 })
      report.diagnostics.screenshot = 'failure-page.png'
    } catch (diagnosticError) { report.diagnostics.screenshotError = String(diagnosticError) }
  }
  process.exitCode = 1
  console.error(report.error)
} finally {
  await browser?.close()
  await server?.close()
  globalThis.fetch = oldFetch
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
  db.close()
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: path.join(output, 'report.json') }))
}
