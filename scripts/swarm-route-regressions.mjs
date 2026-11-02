import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

// HTTP/auth/quota/scheduler are fixtures; the handler, action service, worker
// state machine, store and D1 SQL are real. No network or model is called.
const entry = `export { default as handler } from './api/swarm'; export { default as cronHandler } from './api/swarm-cron'; export * from './api/_swarm'; export * from './api/_swarmWorker'; export * from './api/_swarmStore'; export { CloudflareStore } from './api/_cloudflareStore';`
const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2022', plugins: [{ name: 'local-services', setup(builder) {
  builder.onResolve({ filter: /^@vercel\/functions$|\/_connectionBackend$|\/_limits$|\/_db$|\/_swarmExecution$|\/_swarmStudioRunner$/ }, args => ({ path: args.path, namespace: 'fixture' }))
  builder.onResolve({ filter: /\/_swarmWorker$/ }, args => /\/(?:swarm|swarm-cron)\.ts$/.test(args.importer) ? { path: args.path, namespace: 'fixture' } : undefined)
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
    path === '@vercel/functions' ? 'export function waitUntil(promise){globalThis.__swarmRoutes.background.push(promise)}' :
    path.endsWith('_connectionBackend') ? 'export function connectionBackend(){return globalThis.__swarmRoutes.backend()}' :
    path.endsWith('_limits') ? 'export function reserveDailyQuota(){return globalThis.__swarmRoutes.quota()}' :
    path.endsWith('_db') ? `export function readToken(req){return req.headers?.authorization?.replace(/^Bearer /,'') || null} export function safeJson(value){try{return JSON.parse(value)}catch{return null}}` :
    path.endsWith('_swarmWorker') ? 'export async function runSwarmOwner(owner){globalThis.__swarmRoutes.wakes.push(owner)} export async function runDueSwarmJobs(){globalThis.__swarmRoutes.crons++;return {accountsChecked:0}}' :
    path.endsWith('_swarmStudioRunner') ? 'export async function runSwarmStudioJob(){throw new Error("No real Studio provider in route regressions")}' :
    'export async function executeSwarmWork(input){if(!globalThis.__swarmRoutes.execute)throw new Error("No real model in route regressions");return globalThis.__swarmRoutes.execute(input)}' }))
} }] })
const mod = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports)
const { handler, cronHandler, SwarmStore, CloudflareStore, swarmContext, executeLeasedSwarmJob, runSwarmOwner, applySwarmAction } = mod.exports
class LocalD1 extends CloudflareStore {
  constructor(sql) { super('https://fixture.invalid', 'isolated-regression-key-not-a-credential'); this.db = new DatabaseSync(':memory:'); this.db.exec("PRAGMA foreign_keys=ON;CREATE TABLE nalu_users(id TEXT PRIMARY KEY);INSERT INTO nalu_users VALUES('alice'),('bob'),('carol');"); this.db.exec(sql); this.tail = Promise.resolve() }
  async batch(statements) {
    const previous = this.tail; let release; this.tail = new Promise(resolve => { release = resolve }); await previous
    this.db.exec('BEGIN')
    try { const results = statements.map(({ sql, params = [] }) => ({ results: this.db.prepare(sql).all(...params) })); this.db.exec('COMMIT'); return { results } }
    catch (error) { this.db.exec('ROLLBACK'); throw error } finally { release() }
  }
  async query(sql, params = []) { await this.tail; return { results: this.db.prepare(sql).all(...params) } }
}
const db = new LocalD1(await readFile('cloudflare/nalu-data/migrations/0016_swarm.sql', 'utf8'))
const store = new SwarmStore(db)
const fixture = globalThis.__swarmRoutes = { background: [], wakes: [], crons: 0, connects: 0, closes: 0, reservations: 0, releases: 0, quotaAllowed: true, quotaStatus: 429,
  backend() { return { client: db, connect: async () => { fixture.connects++ }, close: async () => { fixture.closes++ }, userId: async token => ({ 'alice-token': 'alice', 'bob-token': 'bob', 'carol-token': 'carol' })[token] || null } },
  quota() { fixture.reservations++; return Promise.resolve({ ok: fixture.quotaAllowed, status: fixture.quotaAllowed ? undefined : fixture.quotaStatus, used: 1, limit: 10, signedIn: true, release: async () => { fixture.releases++ } }) },
}
async function request(body, token = 'alice-token', method = 'POST', run = handler) {
  const res = { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, status(value) { this.code = value; return this }, json(value) { this.body = value; return this }, end() { return this } }
  await run({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res)
  await Promise.all(fixture.background.splice(0))
  return res
}
assert.equal((await request({}, null)).code, 401)
assert.equal((await request({}, 'unknown-token')).code, 401)
assert.equal((await request({}, null, 'OPTIONS')).code, 204)
assert.equal((await request({}, null, 'GET')).code, 405)
assert.equal((await request([])).code, 400)
assert.equal((await request({ large: 'x'.repeat(32001) })).code, 400)
const create = { action: 'create', requestId: 'project-request-01', title: 'Launch', brief: 'Shared scope' }
const made = await request(create); assert.equal(made.code, 200)
const projectId = made.body.projectId
assert.equal(made.headers['Cache-Control'], 'no-store')
assert.equal((await request(create)).body.revision, made.body.revision)
assert.equal((await request({ ...create, title: 'Changed payload' })).code, 409)
const bob = await request({ ...create, owner: 'alice' }, 'bob-token')
assert.equal(bob.code, 200); assert.notEqual(bob.body.projectId, projectId)
assert.equal((await request({ action: 'send', projectId, thread: 'group', requestId: 'foreign-message', content: 'No access' }, 'bob-token')).code, 404)
const send = { action: 'send', projectId, thread: 'group', requestId: 'send-request-001', content: '@Nalu @Rocky @Milo review the launch' }
const sent = await request(send); assert.equal(sent.code, 200)
let snapshot = await store.read('alice')
assert.equal(snapshot.jobs.length, 3)
assert.deepEqual(new Set(snapshot.jobs.map(job => job.requestId)), new Set(['reply:send-request-001:Nalu', 'reply:send-request-001:Rocky', 'reply:send-request-001:Milo']))
assert.equal(new Set(snapshot.state.turns.map(turn => turn.id)).size, 3)
const charged = fixture.reservations
fixture.quotaAllowed = false
assert.equal((await request(send)).code, 200, 'acknowledgement recovery requires no second quota')
assert.equal(fixture.reservations, charged)
const denied = await request({ action: 'send', projectId, thread: 'Rocky', requestId: 'denied-message', content: 'Private' })
assert.equal(denied.code, 429); assert.equal((await store.read('alice')).jobs.length, 3)
fixture.quotaStatus = 503
const beforeOutage = await store.read('alice'), wakesBeforeOutage = fixture.wakes.length
const unavailable = await request({ action: 'send', projectId, thread: 'Rocky', requestId: 'outage-message', content: 'Try when usage checks recover' })
assert.equal(unavailable.code, 503)
assert.match(unavailable.body.error, /temporarily unavailable/)
assert.doesNotMatch(unavailable.body.error, /daily message limit/)
assert.deepEqual(await store.read('alice'), beforeOutage, 'metering outage persists no message, turn or job')
assert.equal(fixture.wakes.length, wakesBeforeOutage, 'metering outage cannot wake a worker')
fixture.quotaStatus = 429
fixture.quotaAllowed = true
await request({ action: 'stop', projectId, thread: 'group' })
const duplicate = { action: 'send', projectId, thread: 'group', requestId: 'simultaneous-001', content: 'One acknowledged turn' }
const releases = fixture.releases
const concurrent = await Promise.all([request(duplicate), request(duplicate)])
assert.ok(concurrent.every(response => response.code === 200))
assert.equal((await store.read('alice')).state.messages.filter(message => message.content === duplicate.content).length, 1)
assert.equal(fixture.releases, releases + 1, 'duplicate racing reservation is refunded')
assert.equal(JSON.stringify(sent.body).includes('leaseToken'), false)
assert.equal(Object.hasOwn(sent.body, 'jobs'), false)
assert.equal((await request({ action: 'list', owner: 'bob' })).body.state.projects[0].id, projectId)
assert.equal(fixture.connects, fixture.closes, 'all settled routes close their backend')
console.log('PASS real route + SQLite store: auth, owner-derived access, request validation, multi-agent request IDs, idempotency, quota refusal/refund, polling response and connection cleanup')

const originalSecret = process.env.CRON_SECRET
delete process.env.CRON_SECRET
assert.equal((await request({}, 'anything', 'GET', cronHandler)).code, 401)
process.env.CRON_SECRET = 'isolated-cron-fixture'
assert.equal((await request({}, 'wrong', 'GET', cronHandler)).code, 401)
assert.equal((await request({}, 'isolated-cron-fixture', 'GET', cronHandler)).code, 200)
assert.equal(fixture.crons, 1)
if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret
console.log('PASS scheduler rejects missing/wrong credentials and calls its bounded sweep only after authentication')

// Manual tracking must preserve the space reserved for already accepted jobs.
// A duplicate acknowledgement adds no content and remains recoverable at cap.
const bobSend = { action: 'send', projectId: bob.body.projectId, thread: 'group', requestId: 'reserved-bob-001', content: '@Nalu @Rocky @Milo compare the approaches' }
assert.equal((await request(bobSend, 'bob-token')).code, 200)
await store.mutate('bob', draft => { draft.state.messages.push({ id: 'reserve-fill-one', projectId: bob.body.projectId, thread: 'group', speaker: 'You', content: 'x'.repeat(1100000), createdAt: Date.now() }) })
await store.mutate('bob', draft => {
  const message = { id: 'reserve-fill-two', projectId: bob.body.projectId, thread: 'group', speaker: 'You', content: '', createdAt: Date.now() }
  draft.state.messages.push(message)
  message.content = 'x'.repeat(1749900 - Buffer.byteLength(JSON.stringify(draft.state)))
})
const reservedState = await store.read('bob')
assert.equal((await request({ action: 'add-task', projectId: bob.body.projectId, thread: 'group', requestId: 'reserve-task-001', title: 't'.repeat(2000), assignee: 'Rocky' }, 'bob-token')).code, 429)
assert.equal((await request({ action: 'create', requestId: 'reserve-project-001', title: 'Extra project', brief: 'b'.repeat(4000) }, 'bob-token')).code, 429)
assert.deepEqual(await store.read('bob'), reservedState)
const beforeDuplicateQuota = fixture.reservations
assert.equal((await request(bobSend, 'bob-token')).code, 200)
assert.equal(fixture.reservations, beforeDuplicateQuota)
assert.deepEqual(await store.read('bob'), reservedState)
console.log('PASS project/manual-task writes preserve pending-job headroom; duplicate acceptance still recovers unchanged near the limit')

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
await request({ action: 'stop', projectId, thread: 'group' })
await request({ action: 'send', projectId, thread: 'Rocky', requestId: 'cancel-worker-001', content: 'Private worker reply' })
snapshot = await store.read('alice')
const pending = snapshot.jobs.find(job => job.status === 'queued')
const claim = await store.claim('alice', pending.id)
const started = defer(), late = defer()
const running = executeLeasedSwarmJob(store, 'alice', claim, { execute: async () => { started.resolve(); await late.promise; return { status: 'done', content: 'Must not appear', summary: 'Ready' } } })
await started.promise
await request({ action: 'stop', projectId, thread: 'Rocky' })
late.resolve(); await running
snapshot = await store.read('alice')
assert.equal(snapshot.jobs.find(job => job.id === claim.id).status, 'cancelled')
assert.equal(snapshot.state.messages.some(message => message.content === 'Must not appear'), false)

const taskRequest = { action: 'add-task', projectId, thread: 'Rocky', requestId: 'tracked-work-001', title: 'Write a concise checklist', assignee: 'Rocky' }
assert.equal((await request(taskRequest)).code, 200)
const task = (await store.read('alice')).state.tasks[0]
assert.equal((await request({ action: 'start-task', projectId, taskId: task.id, requestId: 'start-work-0001' })).code, 200)
const taskJob = await store.claim('alice', (await store.read('alice')).state.tasks[0].executionId)
await executeLeasedSwarmJob(store, 'alice', taskJob, { execute: async input => {
  await input.onProgress({ stage: 'writing', message: 'Writing the checklist' })
  const during = (await store.read('alice')).state.tasks[0]
  assert.equal(during.status, 'running'); assert.equal(during.progress, undefined)
  return { status: 'done', content: '- Actual injected checklist', summary: 'Checklist ready', artifact: { type: 'text', mime: 'text/markdown', filename: 'checklist.md', content: '- Actual injected checklist' } }
} })
const completed = (await store.read('alice')).state.tasks[0]
assert.equal(completed.status, 'done'); assert.equal(completed.progress, 1)
console.log('PASS real worker/store: cancellation fences late replies; progress is absent during non-quantified work and 1 only for completed output')

const failures = []
async function regression(name, run) { try { await run(); console.log(`PASS ${name}`) } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) } }
await regression('expired claim cannot start model execution', async () => {
  await request({ action: 'send', projectId, thread: 'Milo', requestId: 'expired-work-001', content: 'Do not execute an expired claim' })
  const queued = (await store.read('alice')).jobs.find(job => job.status === 'queued')
  const claimed = await store.claim('alice', queued.id)
  await store.mutate('alice', draft => { draft.jobs.find(job => job.id === claimed.id).leaseUntil = Date.now() - 1 })
  let calls = 0
  await executeLeasedSwarmJob(store, 'alice', claimed, { execute: async () => { calls++; return { status: 'done', content: 'Expired', summary: 'Wrong' } } })
  assert.equal(calls, 0)
})
await regression('server context always fits execution adapter limits', () => {
  const data = structuredClone(snapshot), now = Date.now()
  data.state.messages = Array.from({ length: 60 }, (_, i) => ({ id: `history-${i}`, projectId, thread: 'Rocky', speaker: i % 2 ? 'Rocky' : 'You', content: i === 59 ? 'x'.repeat(40000) : 'x'.repeat(300), createdAt: now - 100 + i }))
  data.state.projects[0].brief = 'b'.repeat(4000)
  data.state.tasks = Array.from({ length: 30 }, (_, i) => ({ id: `context-work-${i}`, projectId, assignee: 'Rocky', title: 't'.repeat(2000), summary: 's'.repeat(800), status: 'done', threads: ['Rocky'], updatedAt: now }))
  const job = { ...claim, createdAt: now, input: 'i'.repeat(12000) }
  const scope = swarmContext(data, job)
  assert.ok(scope.context.length <= 40)
  assert.ok(scope.context.every(message => message.content.length <= 12000))
  assert.ok(scope.brief.length + job.input.length + scope.context.reduce((n, item) => n + item.content.length, 0) <= 60000)
})
await regression('reassigned task does not disclose original private conversation to another agent', () => {
  const data = structuredClone(snapshot), now = Date.now()
  data.state.messages.push({ id: 'private-canary', projectId, thread: 'Rocky', speaker: 'You', content: 'ROCKY_ONLY_PRIVATE_CONTEXT', createdAt: now - 1 })
  data.state.tasks = []
  applySwarmAction(data, 'alice', { ...taskRequest, requestId: 'reassigned-0001' }, now)
  const task = data.state.tasks[0]
  applySwarmAction(data, 'alice', { action: 'assign-task', projectId, taskId: task.id, assignee: 'Milo' }, now)
  applySwarmAction(data, 'alice', { action: 'start-task', projectId, taskId: task.id, requestId: 'reassigned-run-01' }, now)
  const job = data.jobs.find(item => item.id === task.executionId)
  assert.equal(job.speaker, 'Milo')
  assert.doesNotMatch(JSON.stringify(swarmContext(data, job).context), /ROCKY_ONLY_PRIVATE_CONTEXT/)
})
await regression('ordinary group sends persist one real worker reply per teammate with private branches isolated', async () => {
  const teamRequest = body => request(body, 'carol-token')
  const made = await teamRequest({ ...create, requestId: 'team-project-001', title: 'Team conversation' })
  assert.equal(made.code, 200)
  const teamProject = made.body.projectId
  for (const speaker of ['Rocky', 'Milo']) {
    assert.equal((await teamRequest({ action: 'send', projectId: teamProject, thread: speaker, requestId: `team-private-${speaker}`, content: `${speaker.toUpperCase()}_TEAM_PRIVATE_CANARY` })).code, 200)
    assert.equal((await teamRequest({ action: 'stop', projectId: teamProject, thread: speaker })).code, 200)
  }
  const groupSend = { action: 'send', projectId: teamProject, thread: 'group', requestId: 'team-default-001', content: 'Everyone, give your view on the launch.' }
  const beforeQuota = fixture.reservations
  assert.equal((await teamRequest(groupSend)).code, 200)
  assert.equal(fixture.reservations, beforeQuota + 1, 'one accepted user message reserves quota once')
  const jobs = (await store.read('carol')).jobs.filter(job => job.projectId === teamProject && job.thread === 'group')
  assert.deepEqual(jobs.map(job => job.speaker).sort(), ['Milo', 'Nalu', 'Rocky'])
  assert.equal((await teamRequest(groupSend)).code, 200)
  assert.equal(fixture.reservations, beforeQuota + 1, 'lost acknowledgement cannot reserve again')
  const executed = []
  fixture.execute = async input => {
    executed.push(input.speaker)
    assert.match(JSON.stringify(input.context), /give your view on the launch/)
    assert.doesNotMatch(JSON.stringify(input.context), /TEAM_PRIVATE_CANARY/)
    return { status: 'done', content: `${input.speaker}: my own contribution.`, summary: 'Reply ready' }
  }
  try { await runSwarmOwner('carol', 20000) } finally { delete fixture.execute }
  assert.deepEqual(executed.sort(), ['Milo', 'Nalu', 'Rocky'])
  const done = await store.read('carol')
  const replies = done.state.messages.filter(message => message.projectId === teamProject && message.thread === 'group' && message.speaker !== 'You')
  assert.deepEqual(replies.map(message => message.speaker).sort(), ['Milo', 'Nalu', 'Rocky'])
  assert.equal(new Set(replies.map(message => message.id)).size, 3)
  assert.ok(done.state.turns.filter(turn => turn.projectId === teamProject && turn.thread === 'group').every(turn => turn.status === 'completed'))
  assert.equal((await teamRequest(groupSend)).code, 200)
  assert.deepEqual(await store.read('carol'), done, 'retry after completion must not requeue teammates')

  assert.equal((await teamRequest({ action: 'send', projectId: teamProject, thread: 'Rocky', requestId: 'private-unrelated-001', content: 'An unrelated private reply.' })).code, 200)
  const nextSend = { ...groupSend, requestId: 'team-cancel-001', content: 'Discuss the next step.' }
  assert.equal((await teamRequest(nextSend)).code, 200)
  const pending = (await store.read('carol')).jobs.filter(job => job.projectId === teamProject && job.thread === 'group' && job.status === 'queued')
  assert.equal(pending.length, 3)
  const claim = await store.claim('carol', pending[0].id), started = defer(), late = defer()
  const running = executeLeasedSwarmJob(store, 'carol', claim, { execute: async () => { started.resolve(); await late.promise; return { status: 'done', content: 'LATE_TEAM_REPLY', summary: 'Late' } } })
  await started.promise
  assert.equal((await teamRequest({ action: 'stop', projectId: teamProject, thread: 'group' })).code, 200)
  late.resolve(); await running
  const stopped = await store.read('carol')
  assert.ok(stopped.jobs.filter(job => pending.some(item => item.id === job.id)).every(job => job.status === 'cancelled'))
  assert.ok(stopped.state.turns.filter(turn => turn.projectId === teamProject && turn.requestId === nextSend.requestId).every(turn => turn.status === 'cancelled'))
  assert.equal(stopped.state.messages.some(message => message.content === 'LATE_TEAM_REPLY'), false)
  assert.deepEqual(stopped.jobs.filter(job => job.projectId === teamProject && job.requestId === 'reply:private-unrelated-001:Rocky').map(job => job.status), ['queued'], 'stopping the group must not stop private replies')
  assert.equal((await teamRequest(nextSend)).code, 200)
  assert.deepEqual(await store.read('carol'), stopped, 'retrying a stopped turn must not revive it')
  const targeted = { ...groupSend, requestId: 'team-target-001', content: '@milo, what is your recommendation?' }
  assert.equal((await teamRequest(targeted)).code, 200)
  assert.deepEqual((await store.read('carol')).jobs.filter(job => job.requestId.startsWith(`reply:${targeted.requestId}:`)).map(job => job.speaker), ['Milo'])
})
await regression('device jobs use no quota/provider wake, stay out of cloud claims, and complete through owner-scoped fenced receipts', async () => {
  db.db.exec("INSERT INTO nalu_users VALUES('device-owner')")
  const priorBackend = fixture.backend
  fixture.backend = () => ({ ...priorBackend(), userId: async token => token === 'device-token' ? 'device-owner' : ({ 'alice-token': 'alice', 'bob-token': 'bob', 'carol-token': 'carol' })[token] || null })
  const local = body => request({ ...body, executionMode: 'device' }, 'device-token')
  const quota = fixture.reservations, wakes = fixture.wakes.length
  const made = await local({ action: 'create', requestId: 'device-project-01', title: 'Local team', brief: 'Shared local brief.' })
  assert.equal(made.code, 200)
  const id = made.body.projectId
  const sendLocal = (thread, requestId, content) => local({ action: 'send', projectId: id, thread, requestId, content })
  fixture.quotaAllowed = false
  assert.equal((await sendLocal('group', 'device-group-001', '@Nalu Shared launch fact.')).code, 200)
  assert.equal(fixture.reservations, quota); assert.equal(fixture.wakes.length, wakes)
  assert.equal(await store.claim('device-owner'), null)
  assert.ok(!(await store.dueOwners(100)).includes('device-owner'), 'real SQLite scheduler excludes device-only queues')
  const [one, two] = await Promise.all([local({ action: 'device-claim' }), local({ action: 'device-claim' })])
  assert.equal(one.code, 200); assert.equal(two.code, 200)
  const claims = [one.body.deviceJob, two.body.deviceJob].filter(Boolean)
  assert.equal(claims.length, 1, 'two browsers cannot claim two GPU jobs for the same account')
  const job = claims[0]
  assert.ok(!JSON.stringify(one.body.state).includes('leaseToken'))
  assert.equal(job.thread, 'group')
  assert.ok(!JSON.stringify(job.context).includes('PRIVATE_CANARY'))
  assert.equal((await sendLocal('Rocky', 'device-private-01', 'ROCKY_PRIVATE_CANARY')).code, 200)
  assert.equal((await sendLocal('Milo', 'device-private-02', 'MILO_PRIVATE_CANARY')).code, 200)
  const completed = { action: 'device-result', jobId: job.id, leaseToken: job.leaseToken, result: { status: 'done', summary: 'Local reply', content: 'A real local reply.' } }
  assert.equal((await request({ ...completed, executionMode: 'device' }, 'bob-token')).code, 404)
  assert.equal((await local({ ...completed, leaseToken: 'wrong-token' })).code, 409)
  assert.equal((await local({ action: 'device-renew', jobId: job.id, leaseToken: job.leaseToken })).code, 200)
  const saved = await local(completed)
  assert.equal(saved.code, 200)
  const repeated = await local(completed)
  assert.equal(repeated.code, 200); assert.deepEqual(repeated.body, saved.body)
  assert.equal(saved.body.state.messages.filter(message => message.content === 'A real local reply.').length, 1)
  assert.equal((await local({ ...completed, result: { ...completed.result, content: 'Changed retry' } })).code, 409)
  const privateClaim = (await local({ action: 'device-claim' })).body.deviceJob
  assert.ok(['Rocky', 'Milo'].includes(privateClaim.thread))
  assert.ok(JSON.stringify(privateClaim.context).includes(`${privateClaim.thread.toUpperCase()}_PRIVATE_CANARY`))
  assert.ok(!JSON.stringify(privateClaim.context).includes(`${privateClaim.thread === 'Rocky' ? 'MILO' : 'ROCKY'}_PRIVATE_CANARY`))
  let serverCalls = 0
  const durable = (await store.read('device-owner')).jobs.find(item => item.id === privateClaim.id)
  await assert.rejects(executeLeasedSwarmJob(store, 'device-owner', durable, { execute: async () => { serverCalls++; throw Error('must not run') } }), /cannot use a server model/)
  assert.equal(serverCalls, 0)
  await local({ action: 'stop', projectId: id, thread: privateClaim.thread })
  assert.equal((await local({ ...completed, jobId: privateClaim.id, leaseToken: privateClaim.leaseToken })).code, 409)
  assert.ok(!(await store.read('device-owner')).state.messages.some(message => message.thread === privateClaim.thread && message.content === 'A real local reply.'))
  const last = (await local({ action: 'device-claim' })).body.deviceJob
  await store.mutate('device-owner', draft => { draft.jobs.find(item => item.id === last.id).leaseUntil = Date.now() - 1 })
  await store.claim('device-owner')
  assert.equal((await store.read('device-owner')).jobs.find(item => item.id === last.id).status, 'running', 'cloud sweeps cannot mutate device leases')
  assert.equal((await local({ action: 'device-claim' })).body.deviceJob, null)
  assert.equal((await store.read('device-owner')).jobs.find(item => item.id === last.id).status, 'failed', 'an expired device attempt is not silently replayed')
  assert.equal((await local({ ...completed, jobId: last.id, leaseToken: last.leaseToken })).code, 409)
  const added = await local({ action: 'add-task', projectId: id, thread: 'Rocky', requestId: 'device-task-001', title: 'Write a complete checklist.', assignee: 'Rocky' })
  const task = added.body.state.tasks.find(item => item.requestId === 'device-task-001')
  await local({ action: 'start-task', projectId: id, taskId: task.id, requestId: 'device-start-001' })
  const work = (await local({ action: 'device-claim' })).body.deviceJob
  const text = '- Complete local checklist'
  const workResult = { status: 'done', summary: 'Checklist ready.', content: text, artifact: { type: 'text', mime: 'text/markdown', filename: 'checklist.md', content: text } }
  assert.equal((await local({ action: 'device-result', jobId: work.id, leaseToken: work.leaseToken, result: { ...workResult, artifact: { ...workResult.artifact, content: 'Incomplete mismatch' } } })).code, 400)
  const finished = await local({ action: 'device-result', jobId: work.id, leaseToken: work.leaseToken, result: workResult })
  assert.equal(finished.code, 200)
  assert.equal(finished.body.state.tasks.find(item => item.id === task.id).status, 'done')
  assert.equal(finished.body.state.tasks.find(item => item.id === task.id).progress, 1)
  await local({ action: 'share-task', projectId: id, taskId: task.id })
  assert.ok((await store.read('device-owner')).state.messages.some(message => message.thread === 'group' && message.content === text))
  const docTaskResponse = await local({ action: 'add-task', projectId: id, thread: 'Milo', requestId: 'device-doc-task-01', title: 'Create a document about our launch.', assignee: 'Milo' })
  const docTask = docTaskResponse.body.state.tasks.find(item => item.requestId === 'device-doc-task-01')
  await local({ action: 'start-task', projectId: id, taskId: docTask.id, requestId: 'device-doc-start-01' })
  const handoff = (await local({ action: 'device-claim' })).body.deviceJob
  const reason = 'Create the document in Studio.'
  assert.equal((await local({ action: 'device-result', jobId: handoff.id, leaseToken: handoff.leaseToken, result: { status: 'waiting', summary: reason, content: reason, artifact: { type: 'needs-workspace', workspace: 'studio', studioKind: 'document', prompt: handoff.input, reason } } })).code, 200)
  assert.equal((await local({ action: 'continue-studio', projectId: id, taskId: docTask.id, sourceJobId: handoff.id, requestId: 'device-doc-continue-01' })).code, 200)
  const studio = (await local({ action: 'device-claim' })).body.deviceJob
  assert.equal(studio.studio.kind, 'document'); assert.equal(studio.studio.sourceJobId, handoff.id)
  assert.ok(JSON.stringify(studio.context).includes('MILO_PRIVATE_CANARY'))
  assert.ok(!JSON.stringify(studio.context).includes('ROCKY_PRIVATE_CANARY'))
  const payload = { title: 'Launch document', subtitle: '', cover: '', blocks: [{ type: 'paragraph', text: 'A complete local launch document.' }] }
  const studioSaved = await local({ action: 'device-result', jobId: studio.id, leaseToken: studio.leaseToken, result: { payload } })
  assert.equal(studioSaved.code, 200)
  const savedTask = studioSaved.body.state.tasks.find(item => item.id === docTask.id)
  assert.equal(savedTask.status, 'done'); assert.equal(savedTask.artifact.executionId, studio.id)
  const reopened = await local({ action: 'artifact', projectId: id, taskId: docTask.id, executionId: studio.id })
  assert.equal(reopened.code, 200); assert.deepEqual(reopened.body.artifact.payload, payload)
  assert.equal((await local({ action: 'device-result', jobId: studio.id, leaseToken: studio.leaseToken, result: { payload } })).code, 200)
  assert.equal(fixture.reservations, quota); assert.equal(fixture.wakes.length, wakes)
  fixture.quotaAllowed = true
})
if (failures.length) { console.error(`${failures.length} outstanding Swarm regression(s): ${failures.join('; ')}`); process.exitCode = 1 }
delete globalThis.__swarmRoutes
