import assert from 'node:assert/strict'
import { build } from 'esbuild'
const services = {
  './_cloudflareData': 'export const cloudflareData=()=>{throw new Error("Cloudflare is covered by its separate real SQLite/Worker suite")}',
  './_db': `export const getClient=()=>globalThis.__chatMergeStore.client();
    export async function ensureSchema(){}
    export async function userIdForToken(_client,token){return token==='fixture-owner'?'owner':token==='fixture-other'?'other':null}
    export const readToken=req=>(req.headers.authorization||'').replace(/^Bearer /,'');
    export const safeJson=value=>{try{return JSON.parse(value)}catch{return {}}};
    export const newToken=()=>crypto.randomUUID().replaceAll('-','');`,
  './_notebook': 'export const handleNotebook=async()=>false',
  './_notes': 'export const extractNotes=()=>{throw new Error("No model calls")}',
  './_limits': 'export const reserveDailyQuota=()=>{throw new Error("No provider actions")}',
  './_push': 'export const handlePushAction=async()=>false',
  './_tasks': 'export const handleTaskAction=async()=>false',
  './_cron': 'export const runDueCrons=()=>{throw new Error("No cron calls")}; export const runOneFlow=runDueCrons',
  './_messageMedia': 'export const mediaLink=()=>""',
  './_phoneOwner': 'export const ownsPhone=()=>false',
}
const bundled = await build({ entryPoints: ['api/data.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-data-services', setup(build) {
    build.onResolve({ filter: /^\.\/_/ }, ({ path }) => {
      if (path === './_chatMerge' || path === './_syncPayload' || path === './_projectData' || path === './_artifactIsolation') return undefined // Exercise the actual focused merge helper.
      assert.ok(path in services, `Unexpected service ${path}`)
      return { path, namespace: 'fixture' }
    })
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: services[path], loader: 'js' }))
  } }],
})
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const clone = value => structuredClone(value)
const decode = value => {
  for (let i = 0; i < 6 && typeof value === 'string'; i++) value = JSON.parse(value)
  return value
}
export function database() {
  const values = new Map(), shares = new Map(), locks = new Map(), events = []
  let beforeQuery = null, connections = 0, closes = 0
  const storeKey = (owner, key) => `${owner}\0${key}`
  return {
    values, shares, events, locks,
    set beforeQuery(value) { beforeQuery = value },
    get connections() { return connections }, get closes() { return closes },
    seed(key, value, owner = 'owner') { values.set(storeKey(owner, key), clone(value)) },
    read(key = 'nalu-chats', owner = 'owner') { const value = values.get(storeKey(owner, key)); return value === undefined ? undefined : decode(clone(value)) },
    client() {
      connections++
      let unlock = null, transaction = false
      const undo = new Map()
      const release = () => { unlock?.(); unlock = null }
      const remember = key => { if (transaction && !undo.has(key)) undo.set(key, values.has(key) ? clone(values.get(key)) : undefined) }
      return {
        async connect() {}, async end() { release(); closes++ },
        async query(sql, params = []) {
          const q = sql.trim().replace(/\s+/g, ' ')
          events.push({ q, params: clone(params) })
          await beforeQuery?.(q, params)
          if (q.startsWith('CREATE TABLE IF NOT EXISTS nalu_shares')) return { rows: [] }
          if (q.startsWith('INSERT INTO nalu_shares')) { shares.set(params[0], params[1]); return { rows: [] } }
          if (q.startsWith('SELECT html FROM nalu_shares')) return { rows: shares.has(params[0]) ? [{ html: shares.get(params[0]) }] : [] }
          if (q === 'BEGIN') { assert.equal(transaction, false, 'no transaction interleaving on a shared client'); transaction = true; return { rows: [] } }
          if (q === 'COMMIT' || q === 'ROLLBACK') {
            if (q === 'ROLLBACK') for (const [key, value] of undo) { if (value === undefined) values.delete(key); else values.set(key, value) }
            undo.clear(); transaction = false; release(); return { rows: [] }
          }
          if (q.includes('pg_advisory_xact_lock')) {
            const key = params.join('|'), previous = locks.get(key)
            let resolve
            const current = new Promise(done => { resolve = done })
            locks.set(key, current)
            if (previous) await previous
            unlock = () => { if (locks.get(key) === current) locks.delete(key); resolve() }
            return { rows: [] }
          }
          if (q.startsWith('SELECT value FROM nalu_user_data')) {
            const value = values.get(storeKey(params[0], params[1]))
            return { rows: value === undefined ? [] : [{ value: clone(value) }] }
          }
          if (q.startsWith('SELECT key, value FROM nalu_user_data')) {
            return { rows: [...values.entries()].filter(([key]) => key.startsWith(params[0] + '\0')).map(([key, value]) => ({ key: key.split('\0')[1], value: clone(value) })) }
          }
          if (q.startsWith('INSERT INTO nalu_user_data')) {
            const key = storeKey(params[0], params[1]); remember(key)
            values.set(key, JSON.parse(params[2])); return { rows: [] }
          }
          if (q.startsWith('DELETE FROM nalu_user_data')) { values.delete(storeKey(params[0], params[1])); return { rows: [] } }
          throw new Error(`Unexpected SQL: ${q}`)
        },
      }
    },
  }
}
export async function request(db, body, token = 'fixture-owner', query) {
  globalThis.__chatMergeStore = db
  const res = { code: 200, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value }, send(body) { this.body = body; return this }, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
  await handler({ method: query ? 'GET' : 'POST', body, query, headers: token ? { authorization: `Bearer ${token}` } : {} }, res)
  return res
}
