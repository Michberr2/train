import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const bundled = await build({ stdin: { contents: "export * from './api/_swarmStore'; export { CloudflareStore } from './api/_cloudflareStore'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2022' })
const mod = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { SwarmStore, CloudflareStore, SWARM_MAX_STATE_BYTES, SWARM_MAX_SNAPSHOT_BYTES, SwarmStoreLimitError } = mod.exports
const clone = value => JSON.parse(JSON.stringify(value))
const tables = ['projects', 'rooms', 'messages', 'tasks', 'task_threads', 'turns', 'jobs']
const migration = await readFile('cloudflare/nalu-data/migrations/0016_swarm.sql', 'utf8')

class SQLiteD1 extends CloudflareStore {
  constructor() {
    super('https://fixture.invalid', 'only-local-test-fixture-not-a-real-key')
    this.db = new DatabaseSync(':memory:')
    this.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE nalu_users(id TEXT PRIMARY KEY);')
    this.db.exec(migration)
    this.db.exec("INSERT INTO nalu_users VALUES('alice'),('bob');")
    this.tail = Promise.resolve()
  }
  async batch(statements) {
    assert.ok(statements.length <= 45)
    assert.ok(Buffer.byteLength(JSON.stringify({ statements })) < 1_800_000)
    if (this.beforeWrite && statements[0].sql.startsWith('INSERT')) {
      const hook = this.beforeWrite; this.beforeWrite = null; await hook()
    }
    const prior = this.tail; let release
    this.tail = new Promise(resolve => { release = resolve }); await prior
    this.db.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) {
        if (this.failWrites && statement.sql.startsWith('UPDATE nalu_swarm_accounts SET revision')) { this.failWrites = false; throw new Error('Injected atomic write failure') }
        const prepared = this.db.prepare(statement.sql)
        results.push({ results: prepared.all(...(statement.params || [])) })
      }
      this.db.exec('COMMIT'); return { results }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    finally { release() }
  }
  async query(sql, params = []) { await this.tail; return { results: this.db.prepare(sql).all(...params) } }
}

// This is an explicit PG contract stub, not a claim of a live PostgreSQL test.
// It rejects overlapping transactions/read-throughs on one client and checks
// SQL ownership, locking, rollback and lease predicates while retaining rows.
class PostgresFixture {
  constructor() { this.accounts = new Map(); this.tables = Object.fromEntries(tables.map(table => [table, new Map()])); this.transaction = false }
  async query(sql, params = []) {
    await Promise.resolve()
    const result = rows => ({ rows })
    if (sql.startsWith('CREATE TABLE')) { assert.match(sql, /REFERENCES nalu_users\(id\) ON DELETE CASCADE/); return result([]) }
    if (sql === 'BEGIN') { assert.equal(this.transaction, false, 'shared PG connection has no overlapping transactions'); this.transaction = true; this.backup = { accounts: clone([...this.accounts]), tables: Object.fromEntries(tables.map(table => [table, clone([...this.tables[table]])])) }; return result([]) }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) { assert.equal(this.transaction, true, 'schema advisory lock is scoped to a transaction'); return result([]) }
    if (sql === 'COMMIT') { assert.equal(this.transaction, true); this.transaction = false; return result([]) }
    if (sql === 'ROLLBACK') { this.accounts = new Map(this.backup.accounts); this.tables = Object.fromEntries(tables.map(table => [table, new Map(this.backup.tables[table])])); this.transaction = false; return result([]) }
    if (sql.startsWith('SELECT COALESCE')) {
      assert.equal(this.transaction, false, 'a concurrent read cannot see a half transaction')
      return result([{ revision: this.accounts.get(params[0]) || 0, ...Object.fromEntries(tables.map(table => [table, [...this.tables[table].values()].filter(row => row.owner === params[0]).map(row => clone(row.payload))])) }])
    }
    if (sql.startsWith('SELECT owner_id,MIN')) {
      const due = new Map()
      for (const row of this.tables.jobs.values()) if (row.payload.status === 'queued' || (row.payload.status === 'running' && row.payload.leaseUntil <= params[0])) due.set(row.owner, Math.min(due.get(row.owner) ?? Infinity, row.payload.updatedAt))
      return result([...due].sort((a, b) => a[1] - b[1]).slice(0, params[1]).map(([owner_id]) => ({ owner_id })))
    }
    if (sql.startsWith('INSERT INTO nalu_swarm_accounts')) { if (!this.accounts.has(params[0])) this.accounts.set(params[0], 0); return result([]) }
    if (sql.startsWith('SELECT revision')) { assert.match(sql, /FOR UPDATE/); assert.equal(this.transaction, true); return result([{ revision: this.accounts.get(params[0]) }]) }
    if (sql.startsWith('SELECT id FROM nalu_swarm_jobs')) {
      assert.match(sql, /owner_id=\$1.*status='running'.*leaseToken.*clock_timestamp/)
      const job = this.tables.jobs.get(JSON.stringify([params[0], params[1]]))?.payload
      return result(job && job.status === 'running' && job.leaseToken === params[2] && job.leaseUntil > Date.now() ? [{ id: job.id }] : [])
    }
    if (sql.startsWith('UPDATE nalu_swarm_accounts')) {
      if (this.failWrites) { this.failWrites = false; throw new Error('Injected atomic write failure') }
      this.accounts.set(params[0], this.accounts.get(params[0]) + 1); return result([])
    }
    const table = sql.match(/(?:INSERT INTO|DELETE FROM) nalu_swarm_(\w+)/)?.[1]
    assert.ok(tables.includes(table), `Unexpected PG fixture query: ${sql}`)
    assert.equal(this.transaction, true)
    if (sql.startsWith('DELETE')) {
      assert.match(sql, /owner_id=\$1/)
      for (const id of JSON.parse(params[1])) this.tables[table].delete(JSON.stringify([params[0], id]))
    } else {
      assert.match(sql, /SELECT \$1,value->>'id'/)
      assert.match(sql, /ON CONFLICT\(owner_id,id\)/)
      for (const payload of JSON.parse(params[1])) this.tables[table].set(JSON.stringify([params[0], payload.id]), { owner: params[0], payload })
    }
    return result([])
  }
}

function seed(draft, owner) {
  const now = Date.now()
  draft.state.projects.push({ id: 'project', title: owner, brief: '', members: ['Nalu', 'Rocky', 'Milo'], createdAt: now, updatedAt: now })
  for (let i = 1; i <= 4; i++) {
    draft.state.tasks.push({ id: `task-${i}`, projectId: 'project', title: `Work ${i}`, assignee: 'Rocky', threads: ['Rocky'], status: 'queued', summary: '', updatedAt: now, executionId: `job-${i}` })
    draft.jobs.push({ id: `job-${i}`, projectId: 'project', thread: 'Rocky', kind: 'task', taskId: `task-${i}`, speaker: 'Rocky', status: 'queued', input: `Research ${i}`, requestId: `request-${i}`, createdAt: now + i, updatedAt: now, attempts: 0 })
  }
  draft.state.messages.push({ id: 'ask', projectId: 'project', thread: 'group', speaker: 'You', content: 'Discuss shared work.', createdAt: now })
  draft.state.turns.push({ id: 'turn', projectId: 'project', thread: 'group', replySpeaker: 'Nalu', userMessageId: 'ask', replyId: 'reply', status: 'pending', createdAt: now, updatedAt: now })
  draft.jobs.push({ id: 'reply-job', projectId: 'project', thread: 'group', kind: 'reply', turnId: 'turn', speaker: 'Nalu', status: 'queued', input: 'Discuss shared work.', requestId: 'reply-request', createdAt: now + 5, updatedAt: now, attempts: 0 })
}

async function exercise(client, label) {
  const store = new SwarmStore(client), second = new SwarmStore(client)
  assert.deepEqual((await store.read('alice')).state.projects, [])
  await store.mutate('alice', draft => seed(draft, 'Alice'))
  await second.mutate('bob', draft => seed(draft, 'Bob'))
  assert.equal((await store.read('alice')).state.projects[0].title, 'Alice')
  assert.equal((await store.read('bob')).state.projects[0].title, 'Bob')
  await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? store : second).mutate('alice', draft => {
    draft.state.messages.push({ id: `concurrent-${i}`, projectId: 'project', thread: 'Rocky', speaker: 'You', content: `Private ${i}`, createdAt: Date.now() })
  })))
  assert.equal((await store.read('alice')).state.messages.length, 7)
  assert.equal((await store.read('bob')).state.messages.length, 1)
  assert.ok((await store.dueOwners()).includes('alice'))
  const claimed = (await Promise.all(Array.from({ length: 6 }, () => second.claim('alice')))).filter(Boolean)
  assert.equal(claimed.length, 3); assert.equal(new Set(claimed.map(job => job.id)).size, 3)
  assert.equal(await store.claim('alice'), null)
  assert.equal(await store.renew('alice', claimed[0].id, claimed[0].leaseToken), true)
  assert.equal(await store.renew('bob', claimed[0].id, claimed[0].leaseToken), false)
  assert.equal(await store.renew('alice', claimed[0].id, 'wrong-token'), false)
  await store.mutate('alice', draft => { draft.jobs.find(job => job.id === claimed[0].id).leaseUntil = Date.now() - 1 })
  const next = await store.claim('alice')
  assert.ok(next); assert.notEqual(next.id, claimed[0].id)
  const expired = await store.read('alice')
  assert.equal(expired.jobs.find(job => job.id === claimed[0].id).status, 'failed')
  assert.equal(expired.state.tasks.find(task => task.id === claimed[0].taskId).status, 'failed')
  assert.match(expired.state.tasks.find(task => task.id === claimed[0].taskId).summary, /Retry explicitly/)
  assert.equal(await store.mutateLeased('alice', claimed[0].id, claimed[0].leaseToken, draft => { draft.state.projects[0].title = 'late corruption' }), null)
  await store.mutate('alice', draft => { const job = draft.jobs.find(item => item.id === claimed[1].id); job.status = 'cancelled'; delete job.leaseToken; delete job.leaseUntil })
  assert.equal(await store.mutateLeased('alice', claimed[1].id, claimed[1].leaseToken, draft => { draft.state.projects[0].title = 'cancelled corruption' }), null)
  const reply = await store.claim('alice', 'reply-job'); assert.ok(reply)
  await store.mutate('alice', draft => { draft.jobs.find(job => job.id === reply.id).leaseUntil = Date.now() - 1 })
  await store.claim('alice', 'nonexistent')
  assert.equal((await store.read('alice')).state.turns[0].status, 'failed')
  const finished = await store.mutateLeased('alice', claimed[2].id, claimed[2].leaseToken, draft => {
    const job = draft.jobs.find(item => item.id === claimed[2].id); job.status = 'done'; job.result = 'Actual saved result'; delete job.leaseToken; delete job.leaseUntil
  })
  assert.ok(finished)
  await assert.rejects(store.mutate('alice', draft => { draft.jobs.find(job => job.id === claimed[0].id).status = 'queued' }), /new job ID|cannot be restarted/)
  await assert.rejects(store.mutate('alice', draft => { draft.jobs[0].input = 'Changed request' }), /cannot be rewritten/)
  await assert.rejects(store.mutate('alice', draft => { draft.jobs.push({ ...draft.jobs[0], id: 'duplicate-request' }) }), /Invalid Swarm job/)
  await assert.rejects(store.mutate('alice', draft => { draft.state.messages.push({ id: 'wrong-room', projectId: 'unknown', thread: 'Rocky', speaker: 'You', content: 'not owned', createdAt: Date.now() }) }), /Invalid Swarm message/)
  await assert.rejects(store.mutate('alice', draft => { draft.state.mode = 'sample' }), /Only real/)
  await assert.rejects(store.mutate('alice', draft => { delete draft.state.tasks[0].threads }), /explicitly linked/)
  const beforeFailure = await store.read('alice')
  client.failWrites = true
  await assert.rejects(store.mutate('alice', draft => { draft.state.projects[0].title = 'must roll back' }), /Injected atomic/)
  assert.deepEqual(await store.read('alice'), beforeFailure)
  assert.equal((await store.read('alice')).state.projects[0].title, 'Alice')
  console.log(`PASS ${label}: owner isolation; concurrent append/CAS; maximum three active jobs; lease renewal/fencing; cancellation; expired task and reply failure; immutable attempts; validation; atomic rollback`)
  return { store, second }
}

const sqlite = new SQLiteD1()
const { store } = await exercise(sqlite, 'D1 SQL against real SQLite')
assert.equal(sqlite.db.prepare("SELECT COUNT(*) AS n FROM nalu_swarm_rooms WHERE owner_id='alice'").get().n, 4)
assert.equal(sqlite.db.prepare("SELECT COUNT(*) AS n FROM nalu_swarm_task_threads WHERE owner_id='alice'").get().n, 4)
assert.equal(sqlite.db.prepare('SELECT COUNT(*) AS n FROM nalu_swarm_accounts WHERE write_token IS NOT NULL').get().n, 0)

// A cancellation committed between read and write forces a retry, which then
// refuses the result rather than publishing any part of it.
const live = (await store.read('alice')).jobs.find(job => job.status === 'running')
sqlite.beforeWrite = () => store.mutate('alice', draft => {
  const job = draft.jobs.find(item => item.id === live.id); job.status = 'cancelled'; delete job.leaseToken; delete job.leaseUntil
})
assert.equal(await store.mutateLeased('alice', live.id, live.leaseToken, draft => { draft.state.projects[0].title = 'racing completion' }), null)
assert.equal((await store.read('alice')).state.projects[0].title, 'Alice')

// Database-time fencing also rejects a lease that expires after the callback
// but before its atomic batch starts, without partially writing its payload.
const bob = await store.claim('bob')
await store.mutate('bob', draft => { draft.jobs.find(job => job.id === bob.id).leaseUntil = Date.now() + 30 })
sqlite.beforeWrite = () => new Promise(resolve => setTimeout(resolve, 50))
assert.equal(await store.mutateLeased('bob', bob.id, bob.leaseToken, draft => { draft.state.projects[0].title = 'expired during save' }), null)
assert.equal((await store.read('bob')).state.projects[0].title, 'Bob')
console.log('PASS D1 cancellation race, database-time lease fencing, normalized rooms/associations, and cleared write claims')

sqlite.db.prepare("DELETE FROM nalu_users WHERE id='alice'").run()
for (const table of ['accounts', ...tables]) assert.equal(sqlite.db.prepare(`SELECT COUNT(*) AS n FROM nalu_swarm_${table} WHERE owner_id='alice'`).get().n, 0)
assert.ok((await store.read('bob')).state.projects.length)
console.log('PASS account deletion cascades Swarm data without touching another account')
await exercise(new PostgresFixture(), 'PostgreSQL transaction contract stub')

const cappedDb = new SQLiteD1(), capped = new SwarmStore(cappedDb)
await capped.mutate('alice', draft => seed(draft, 'Capacity'))
const recoveryJob = await capped.claim('alice', 'reply-job')
for (let i = 0; i < 3; i++) await capped.mutate('alice', draft => {
  draft.state.messages.push({ id: `large-${i}`, projectId: 'project', thread: 'group', speaker: 'You', content: 'x'.repeat(900000), createdAt: Date.now() })
})
await capped.mutate('alice', draft => {
  const message = { id: 'fill-state', projectId: 'project', thread: 'group', speaker: 'You', content: '', createdAt: Date.now() }
  draft.state.messages.push(message)
  message.content = 'x'.repeat(SWARM_MAX_STATE_BYTES - 64 - Buffer.byteLength(JSON.stringify(draft.state)))
})
assert.equal(Buffer.byteLength(JSON.stringify((await capped.read('alice')).state)), SWARM_MAX_STATE_BYTES - 64)
const savedAtCap = await capped.read('alice')
await assert.rejects(capped.mutate('alice', draft => { draft.state.projects[0].brief = 'x'.repeat(1000) }), SwarmStoreLimitError)
assert.deepEqual(await capped.read('alice'), savedAtCap, 'limit rejection preserves all saved data and revision')
assert.ok(await capped.mutateLeased('alice', recoveryJob.id, recoveryJob.leaseToken, draft => {
  const job = draft.jobs.find(item => item.id === recoveryJob.id)
  job.status = 'failed'; job.summary = 'The attempt was interrupted. Retry explicitly.'; job.error = job.summary; job.updatedAt = Date.now()
  delete job.leaseToken; delete job.leaseUntil
  draft.state.turns[0].status = 'failed'; draft.state.turns[0].updatedAt = Date.now()
  draft.state.messages.push({ id: `${job.id}:reply`, projectId: job.projectId, thread: job.thread, speaker: job.speaker, content: 'I could not finish that reply. Please try again.', createdAt: Date.now(), turnId: job.turnId })
}))
const recoveredBytes = Buffer.byteLength(JSON.stringify((await capped.read('alice')).state))
assert.ok(recoveredBytes > SWARM_MAX_STATE_BYTES && recoveredBytes <= SWARM_MAX_STATE_BYTES + 16000)
await capped.mutate('alice', draft => {
  const job = draft.jobs.find(item => item.id === recoveryJob.id)
  job.quotaCleanupPending = true; job.summary = 'The usage refund could not be confirmed.'; job.error = job.summary; job.updatedAt = Date.now()
})
assert.equal((await capped.read('alice')).jobs.find(item => item.id === recoveryJob.id).quotaCleanupPending,true,'bounded refund recovery metadata survives full history')
await assert.rejects(capped.mutate('alice', draft => {
  const job = draft.jobs.find(item => item.id === recoveryJob.id)
  job.quotaCleanupPending = true; job.result = 'Arbitrary new result cannot masquerade as cleanup metadata.'
}), SwarmStoreLimitError)
await assert.rejects(capped.mutate('alice', draft => { draft.state.messages.push({ id: 'not-recovery', projectId: 'project', thread: 'group', speaker: 'You', content: 'This is new content, not terminal recovery.', createdAt: Date.now() }) }), SwarmStoreLimitError)

// The separate snapshot cap protects job-result duplication even when the
// returned conversation state is small. Each write remains below D1's body cap.
await capped.mutate('bob', draft => seed(draft, 'Snapshot capacity'))
for (let i = 0; i < 11; i++) await capped.mutate('bob', draft => {
  const now = Date.now()
  draft.jobs.push({ id: `result-${i}`, projectId: 'project', thread: 'Rocky', kind: 'task', taskId: 'task-1', speaker: 'Rocky', status: 'done', input: 'Text work', requestId: `large-result-${i}`, createdAt: now, updatedAt: now, attempts: 1, result: 'x'.repeat(1050000) })
})
const beforeTotalLimit = await capped.read('bob')
assert.ok(Buffer.byteLength(JSON.stringify(beforeTotalLimit)) < SWARM_MAX_SNAPSHOT_BYTES)
await assert.rejects(capped.mutate('bob', draft => {
  const now = Date.now()
  draft.jobs.push({ id: 'result-over-cap', projectId: 'project', thread: 'Rocky', kind: 'task', taskId: 'task-1', speaker: 'Rocky', status: 'done', input: 'Text work', requestId: 'large-result-over-cap', createdAt: now, updatedAt: now, attempts: 1, result: 'x'.repeat(1050000) })
}), SwarmStoreLimitError)
assert.deepEqual(await capped.read('bob'), beforeTotalLimit)
console.log('PASS explicit 3MB state/12MB snapshot limits preserve data; narrow terminal recovery works within 16KB allowance; arbitrary content cannot use recovery capacity')
