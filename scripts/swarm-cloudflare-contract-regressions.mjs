import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'esbuild'

// Optional baseline root lets the isolated Swarm implementation be tested
// against a separately reviewed shared-runtime checkout before it is merged.
// The actual signed HTTP adapter and Worker execute against local SQLite;
// there are no network, account, model, or deployment calls.
const baseline = resolve(process.argv[2] || process.cwd())
const imports = [
  `export { SwarmStore } from './api/_swarmStore';`,
  `export { CloudflareStore } from ${JSON.stringify(resolve(baseline, 'api/_cloudflareStore.ts'))};`,
  `export { default as worker } from ${JSON.stringify(resolve(baseline, 'cloudflare/nalu-data/worker.ts'))};`,
  `export { withStorageDeadline } from ${JSON.stringify(resolve(baseline, 'api/_storageDeadline.ts'))};`,
]
const bundled = await build({ stdin: { contents: imports.join('\n'), resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false,
  platform: 'node', format: 'cjs', target: 'es2022', plugins: [{ name: 'reviewed-storage', setup(builder) {
    builder.onResolve({ filter: /\/_cloudflareStore$/ }, () => ({ path: resolve(baseline, 'api/_cloudflareStore.ts') }))
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { SwarmStore, CloudflareStore, worker, withStorageDeadline } = module.exports
const db = new DatabaseSync(':memory:')
db.exec("PRAGMA foreign_keys=ON; CREATE TABLE nalu_users(id TEXT PRIMARY KEY); INSERT INTO nalu_users VALUES('alice'),('bob');")
db.exec(await readFile('cloudflare/nalu-data/migrations/0016_swarm.sql', 'utf8'))
const secret = 'local-swarm-http-contract-fixture-only'
const env = { NALU_DATA_SECRET: secret, DB: {
  prepare(sql) { return { bind(...params) { return { all: async () => ({ results: db.prepare(sql).all(...params) }) } } } },
  async batch(statements) {
    db.exec('BEGIN')
    try { const result = []; for (const statement of statements) result.push(await statement.all()); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  },
} }
const originalFetch = globalThis.fetch
let calls = 0, maxBatch = 0, maxBytes = 0, delayedBody = false
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).origin, 'https://swarm-storage.invalid')
  calls++
  if (delayedBody) return new Response(new ReadableStream({ start() {} }))
  maxBytes = Math.max(maxBytes, Buffer.byteLength(options.body))
  const payload = JSON.parse(options.body)
  maxBatch = Math.max(maxBatch, payload.statements?.length || 0)
  return worker.fetch(new Request(url, options), env)
}
try {
  const store = new SwarmStore(new CloudflareStore('https://swarm-storage.invalid', secret))
  const now = Date.now()
  const first = await store.mutate('alice', draft => {
    draft.state.projects.push({ id: 'project', title: 'Signed transport', brief: '', members: ['Nalu', 'Rocky', 'Milo'], createdAt: now, updatedAt: now })
    draft.state.messages.push({ id: 'private-message', projectId: 'project', thread: 'Rocky', speaker: 'You', content: 'Private source context', createdAt: now })
    draft.state.turns.push({ id: 'turn', projectId: 'project', thread: 'Rocky', userMessageId: 'private-message', replySpeaker: 'Rocky', replyId: 'reply', status: 'pending', createdAt: now, updatedAt: now })
    draft.jobs.push({ id: 'job', projectId: 'project', thread: 'Rocky', kind: 'reply', turnId: 'turn', speaker: 'Rocky', status: 'queued', input: 'Reply here', requestId: 'reply:transport:Rocky', createdAt: now, updatedAt: now, attempts: 0 })
  })
  assert.equal(first.revision, 1)
  assert.deepEqual((await store.read('bob')).state.messages, [])
  assert.deepEqual(await store.dueOwners(), ['alice'])
  const claim = await store.claim('alice', 'job')
  assert.equal(claim.status, 'running')
  assert.equal(await store.renew('alice', claim.id, claim.leaseToken), true)
  const finished = await store.mutateLeased('alice', claim.id, claim.leaseToken, draft => {
    const job = draft.jobs[0]
    job.status = 'done'; job.result = 'Only the requested reply'; job.progress = 1
    delete job.leaseToken; delete job.leaseUntil
    draft.state.turns[0].status = 'completed'
  })
  assert.equal(finished.jobs[0].status, 'done')
  assert.equal(await store.mutateLeased('alice', claim.id, claim.leaseToken, () => { throw new Error('Stale callback must not run') }), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nalu_swarm_accounts WHERE write_token IS NOT NULL').get().n, 0)
  assert.ok(maxBatch <= 45); assert.ok(maxBytes < 1_800_000)
  assert.equal((await new CloudflareStore('https://swarm-storage.invalid', 'different-local-fixture-secret-only').query('SELECT 1').then(() => 'unexpected', () => 'rejected')), 'rejected')
  console.log('PASS actual signed CloudflareStore → Worker → SQLite: schema, normalized rows, owner isolation, claim/renew/result fencing, batch/body limits and HMAC rejection')

  delayedBody = true
  const before = calls
  await assert.rejects(withStorageDeadline(Date.now() + 30, () => store.read('alice')), /deadline|cancel|timed out/i)
  assert.equal(calls, before + 1, 'An uncertain transport response is never automatically replayed')
  console.log('PASS reviewed storage deadline interrupts stalled response bodies without retrying an uncertain operation')
} finally {
  globalThis.fetch = originalFetch
  db.close()
}
