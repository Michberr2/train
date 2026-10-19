import assert from 'node:assert/strict'
import { build } from 'esbuild'
const code = await build({ entryPoints: ['api/_pipelineDelivery.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { deliverPipelineOnce } = await import(`data:text/javascript;base64,${Buffer.from(code.outputFiles[0].text).toString('base64')}`)
const rows = new Map()
const db = { async query(q, args = []) {
  const key = `${args[0]}:${args[1]}`
  if (q.startsWith('CREATE')) return { rows: [] }
  if (q.startsWith('INSERT')) { if (rows.has(key)) return { rows: [] }; rows.set(key, null); return { rows: [{ delivery_key: args[1] }] } }
  if (q.startsWith('SELECT')) return { rows: [{ result: rows.get(key) }] }
  if (q.startsWith('UPDATE')) { rows.set(key, JSON.parse(args[2])); return { rows: [] } }
  throw new Error(q)
} }
let sends = 0
const send = async () => { sends++; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, detail: 'Accepted by provider' } }
const parallel = await Promise.all([deliverPipelineOnce(db, 'owner', 'run:node', send), deliverPipelineOnce(db, 'owner', 'run:node', send)])
assert.equal(sends, 1); assert.equal(parallel[0].ok, true); assert.equal(parallel[1].ok, false)
assert.equal((await deliverPipelineOnce(db, 'owner', 'run:node', send)).ok, true); assert.equal(sends, 1)
await deliverPipelineOnce(db, 'other-owner', 'run:node', send); assert.equal(sends, 2)
await deliverPipelineOnce(db, 'owner', 'new-run:node', send); assert.equal(sends, 3)
let rejected = 0
const failure = () => { rejected++; return Promise.reject(new Error('Lost provider response')) }
assert.match((await deliverPipelineOnce(db, 'owner', 'uncertain:node', failure)).detail, /unconfirmed/)
assert.match((await deliverPipelineOnce(db, 'owner', 'uncertain:node', failure)).detail, /unconfirmed/)
assert.equal(rejected, 1)
console.log('PASS concurrent sends, completed resume, lost responses, fresh runs and account isolation never duplicate a delivery')

const route = await build({ stdin: { contents: "export { sendPipelineOutput } from './api/connect.ts'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'isolated-accounts', setup(b) {
  b.onResolve({ filter: /^\.\/_db$/ }, () => ({ path: 'db', namespace: 'fixture' }))
  b.onResolve({ filter: /^\.\/_email$/ }, () => ({ path: 'email', namespace: 'fixture' }))
  b.onResolve({ filter: /^\.\/_connectionHttp$/ }, () => ({ path: 'http', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'db' ? 'export const getClient=()=>null, readToken=()=>null, userIdForToken=()=>null, safeJson=JSON.parse; export const normalizePhone=()=>{throw new Error("Unexpected phone normalization")};' : path === 'http' ? 'export const webhookUrl=value=>new URL(value); export const requestWebhook=(url,options)=>globalThis.fetch(url,options);' : 'export const emailConfigured=()=>false; export async function sendEmail(){throw new Error("No real email allowed")}', loader: 'js' }))
} }] })
const { sendPipelineOutput } = await import(`data:text/javascript;base64,${Buffer.from(route.outputFiles[0].text).toString('base64')}`)
const query = db.query.bind(db)
db.query = async (q, args) => q.startsWith('SELECT * FROM nalu_connections')
  ? { rows: args[0] === 'owner' && args[1] === 'selected' ? [{ app: 'instagram', method: 'webhook', endpoint: 'https://publisher.invalid/receive' }] : [] }
  : query(q, args)
const originalFetch = globalThis.fetch
let requests = 0
try {
  globalThis.fetch = async (url, options) => { requests++; assert.equal(new URL(url).hostname, 'publisher.invalid'); assert.equal(JSON.parse(options.body).caption, 'Saved draft'); return new Response('', { status: 503 }) }
  const payload = { caption: 'Saved draft' }
  assert.equal((await sendPipelineOutput(db, 'other-owner', 'connection-check', { connectionId: 'selected' }, 'post', payload)).ok, false)
  assert.equal(requests, 0)
  const rejected = await sendPipelineOutput(db, 'owner', 'http-rejected', { connectionId: 'selected' }, 'post', payload)
  assert.equal(rejected.ok, false); assert.match(rejected.detail, /503/)
  await sendPipelineOutput(db, 'owner', 'http-rejected', { connectionId: 'selected' }, 'post', payload)
  assert.equal(requests, 1)
  globalThis.fetch = async () => { requests++; return new Response('', { status: 200 }) }
  const target = { webhook: 'https://publisher.invalid/receive' }
  assert.equal((await sendPipelineOutput(db, 'owner', 'hook-accepted', target, 'post', payload)).ok, true)
  assert.equal((await sendPipelineOutput(db, 'owner', 'hook-accepted', target, 'post', payload)).ok, true)
  assert.equal(requests, 2)
  console.log('PASS real selected-connection ownership, HTTP rejection, webhook acceptance and browser/server shared delivery checkpoints')
} finally { globalThis.fetch = originalFetch }
