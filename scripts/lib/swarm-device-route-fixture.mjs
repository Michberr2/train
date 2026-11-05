import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

/** Actual handler, action service and transactional SQLite store. Any cloud
 * worker or model quota reservation is a test failure. */
export async function swarmDeviceRouteFixture() {
  const built = await build({ stdin: { contents: "export {default as handler} from './api/swarm';export {SwarmStore} from './api/_swarmStore';export {CloudflareStore} from './api/_cloudflareStore'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'device-api-dependencies', setup(builder) {
    builder.onResolve({ filter: /^@vercel\/functions$|\/(?:_connectionBackend|_limits|_db|_swarmWorker)$/ }, args => ({ path: args.path, namespace: 'device-fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'device-fixture' }, ({ path }) => ({ contents:
      path === '@vercel/functions' ? 'export function waitUntil(p){globalThis.__deviceSwarmAPI.background.push(p)}' :
      path.endsWith('_connectionBackend') ? 'export function connectionBackend(){return globalThis.__deviceSwarmAPI.backend()}' :
      path.endsWith('_limits') ? 'export function reserveDailyQuota(){globalThis.__deviceSwarmAPI.quota++;throw Error("Cloud quota must not run for device jobs")}' :
      path.endsWith('_swarmWorker') ? 'export async function runSwarmOwner(){globalThis.__deviceSwarmAPI.cloud++;throw Error("Cloud workers must not run for device jobs")}' :
      'export function readToken(req){return req.headers.authorization?.replace(/^Bearer /,"")||null}export function safeJson(value){try{return JSON.parse(value)}catch{return null}}' }))
  } }] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  const { handler, SwarmStore, CloudflareStore } = module.exports
  class LocalStore extends CloudflareStore {
    constructor(sql) {
      super('https://device-fixture.invalid', 'synthetic-local-fixture-not-a-real-credential')
      this.db = new DatabaseSync(':memory:')
      this.db.exec("PRAGMA foreign_keys=ON;CREATE TABLE nalu_users(id TEXT PRIMARY KEY);INSERT INTO nalu_users VALUES('browser-owner'),('other-owner');")
      this.db.exec(sql); this.tail = Promise.resolve()
    }
    async batch(statements) {
      const prior = this.tail; let release
      this.tail = new Promise(resolve => { release = resolve }); await prior
      this.db.exec('BEGIN')
      try { const results = statements.map(({ sql, params = [] }) => ({ results: this.db.prepare(sql).all(...params) })); this.db.exec('COMMIT'); return { results } }
      catch (error) { this.db.exec('ROLLBACK'); throw error } finally { release() }
    }
    async query(sql, params = []) { await this.tail; return { results: this.db.prepare(sql).all(...params) } }
  }
  const db = new LocalStore((await Promise.all(['0016_swarm.sql', '0019_swarm_delegations.sql'].map(name => readFile('cloudflare/nalu-data/migrations/' + name, 'utf8')))).join('\n'))
  const state = globalThis.__deviceSwarmAPI = { quota: 0, cloud: 0, background: [], calls: [], backend: () => ({ client: db, connect: async () => {}, close: async () => {}, userId: async token => ({ 'browser-token': 'browser-owner', 'other-token': 'other-owner' })[token] || null }) }
  return { state, store: new SwarmStore(db), async call(body, token = 'browser-token') {
    state.calls.push({ action: body.action, executionMode: body.executionMode, token })
    const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = structuredClone(body); return this }, end() { return this } }
    await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, response)
    await Promise.all(state.background.splice(0))
    return response
  }, close() { db.db.close(); delete globalThis.__deviceSwarmAPI } }
}
