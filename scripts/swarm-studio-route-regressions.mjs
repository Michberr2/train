import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

// Actual route/actions/normalized SQLite store. Authentication, quota and the
// worker wake-up are fixtures; no provider, ordinary-chat or network calls.
const bundled = await build({ stdin: { contents: "export { default as handler } from './api/swarm'; export { SwarmStore } from './api/_swarmStore'; export { CloudflareStore } from './api/_cloudflareStore';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022', plugins: [{ name: 'studio-route-fixtures', setup(builder) {
    builder.onResolve({ filter: /^@vercel\/functions$|\/(?:_connectionBackend|_limits|_db|_swarmWorker)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
      path === '@vercel/functions' ? 'export function waitUntil(p){globalThis.__swarmStudioRoutes.background.push(p)}' :
      path.endsWith('_connectionBackend') ? 'export function connectionBackend(){return globalThis.__swarmStudioRoutes.backend()}' :
      path.endsWith('_limits') ? 'export function reserveDailyQuota(){return globalThis.__swarmStudioRoutes.quota()}' :
      path.endsWith('_swarmWorker') ? 'export async function runSwarmOwner(owner){globalThis.__swarmStudioRoutes.wakes.push(owner)}' :
      `export function readToken(req){return req.headers?.authorization?.replace(/^Bearer /,'') || null}
       export function safeJson(value){try{return JSON.parse(value)}catch{return null}}` }))
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { handler, SwarmStore, CloudflareStore } = module.exports
class LocalD1 extends CloudflareStore {
  constructor(sql) {
    super('https://local-fixture.invalid', 'studio-route-local-fixture-not-a-credential')
    this.db = new DatabaseSync(':memory:')
    this.db.exec("PRAGMA foreign_keys=ON; CREATE TABLE nalu_users(id TEXT PRIMARY KEY); INSERT INTO nalu_users VALUES('alice'),('bob'); CREATE TABLE nalu_user_data(user_id TEXT,key TEXT,value TEXT,PRIMARY KEY(user_id,key)); INSERT INTO nalu_user_data VALUES('alice','nalu-chats','[{\"id\":\"ordinary-chat-canary\",\"messages\":[]}]');")
    this.db.exec(sql); this.tail = Promise.resolve()
  }
  async batch(statements) {
    const prior = this.tail; let release; this.tail = new Promise(resolve => { release = resolve }); await prior
    this.db.exec('BEGIN')
    try {
      const results = statements.map(({ sql, params = [] }) => ({ results: this.db.prepare(sql).all(...params) }))
      this.db.exec('COMMIT'); return { results }
    } catch (error) { this.db.exec('ROLLBACK'); throw error } finally { release() }
  }
  async query(sql, params = []) { await this.tail; return { results: this.db.prepare(sql).all(...params) } }
}
const db = new LocalD1(await readFile('cloudflare/nalu-data/migrations/0016_swarm.sql', 'utf8'))
const store = new SwarmStore(db)
const fixture = globalThis.__swarmStudioRoutes = {
  background: [], wakes: [], reservations: 0, refunds: 0, allowed: true, connects: 0, closes: 0,
  backend() { return { client: db, connect: async () => { fixture.connects++ }, close: async () => { fixture.closes++ },
    userId: async token => ({ 'alice-token': 'alice', 'bob-token': 'bob' })[token] || null } },
  quota() { fixture.reservations++; return Promise.resolve({ ok: fixture.allowed, status: fixture.allowed ? undefined : 429, used: 1, limit: 10, signedIn: true,
    release: async () => { fixture.refunds++ } }) },
}
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Network is forbidden in Studio route regressions') }
const ordinaryBefore = db.db.prepare('SELECT * FROM nalu_user_data').all()
async function request(body, token = 'alice-token') {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(code) { this.code = code; return this }, json(body) { this.body = body; return this }, end() { return this } }
  await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res)
  await Promise.all(fixture.background.splice(0)); return res
}
async function project(requestId, token = 'alice-token') {
  const response = await request({ action: 'create', requestId, title: requestId, brief: 'Only this project' }, token)
  assert.equal(response.code, 200); return response.body.projectId
}
async function waitingTask(projectId, suffix, owner = 'alice') {
  const token = `${owner}-token`
  assert.equal((await request({ action: 'add-task', projectId, thread: 'Rocky', requestId: `task-${suffix}`, title: 'Create the project brief document.', assignee: 'Rocky' }, token)).code, 200)
  let saved = await store.read(owner)
  const task = saved.state.tasks.find(item => item.requestId === `task-${suffix}`)
  assert.equal((await request({ action: 'start-task', projectId, taskId: task.id, requestId: `start-${suffix}` }, token)).code, 200)
  saved = await store.mutate(owner, draft => {
    const current = draft.state.tasks.find(item => item.id === task.id), source = draft.jobs.find(item => item.id === current.executionId)
    source.status = 'waiting'; source.summary = 'Continue with Studio.'
    source.artifact = { type: 'needs-workspace', workspace: 'studio', studioKind: 'document', prompt: source.input, reason: 'Continue with Studio.' }
    current.status = 'waiting'; current.summary = source.summary
    current.handoff = { studioKind: 'document', prompt: source.input, reason: source.summary }
  })
  const current = saved.state.tasks.find(item => item.id === task.id)
  return { taskId: task.id, sourceJobId: current.executionId, source: structuredClone(saved.jobs.find(item => item.id === current.executionId)) }
}
try {
  const projectId = await project('studio-project-alice'), otherProject = await project('studio-project-other')
  const bobProject = await project('studio-project-bob', 'bob-token')
  const waiting = await waitingTask(projectId, 'first-studio-task')
  const foreign = await waitingTask(bobProject, 'foreign-studio-task', 'bob')
  const continueBody = { action: 'continue-studio', projectId, taskId: waiting.taskId, sourceJobId: waiting.sourceJobId, requestId: 'continue-first-studio' }
  const before = await store.read('alice'), beforeCharge = fixture.reservations
  const accepted = await request({ ...continueBody, ownerId: 'bob', prompt: 'INJECTED_PROMPT', context: [{ content: 'INJECTED_CONTEXT' }], studioKind: 'website' })
  assert.equal(accepted.code, 200)
  const after = await store.read('alice'), task = after.state.tasks.find(item => item.id === waiting.taskId)
  const job = after.jobs.find(item => item.id === task.executionId)
  assert.notEqual(job.id, waiting.sourceJobId); assert.equal(job.status, 'queued')
  assert.equal(after.jobs.length, before.jobs.length + 1); assert.equal(fixture.reservations, beforeCharge + 1)
  assert.equal(job.input, waiting.source.input); assert.equal(job.projectId, projectId); assert.equal(job.thread, 'Rocky')
  assert.deepEqual(job.artifact, { type: 'studio-generation', sourceJobId: waiting.sourceJobId, studioKind: 'document' })
  assert.deepEqual(after.jobs.find(item => item.id === waiting.sourceJobId), waiting.source, 'Continuation preserves the immutable waiting source attempt')
  assert.doesNotMatch(JSON.stringify(job), /INJECTED/)
  fixture.allowed = false
  assert.equal((await request(continueBody)).code, 200, 'Duplicate acknowledgement succeeds even after quota exhaustion')
  assert.equal(fixture.reservations, beforeCharge + 1)
  assert.deepEqual(await store.read('alice'), after)
  fixture.allowed = true
  assert.equal((await request({ ...continueBody, requestId: 'stale-source-new-request' })).code, 409)
  assert.equal((await request({ ...continueBody, projectId: otherProject })).code, 404)
  assert.equal((await request({ ...continueBody, projectId: bobProject, taskId: foreign.taskId, sourceJobId: foreign.sourceJobId })).code, 404)
  assert.equal((await request(continueBody, 'bob-token')).code, 404)
  console.log('PASS Studio continuation validates owner/project/source, creates one immutable job and recovers duplicate acknowledgements without charging twice')

  const race = await waitingTask(projectId, 'race-studio-task')
  const raceBody = { action: 'continue-studio', projectId, taskId: race.taskId, sourceJobId: race.sourceJobId, requestId: 'concurrent-studio-request' }
  const charges = fixture.reservations - fixture.refunds
  const raced = await Promise.all([request(raceBody), request(raceBody)])
  assert.ok(raced.every(response => response.code === 200))
  assert.equal((await store.read('alice')).jobs.filter(item => item.artifact?.sourceJobId === race.sourceJobId).length, 1)
  assert.equal(fixture.reservations - fixture.refunds, charges + 1)
  console.log('PASS concurrent duplicate Studio continuation has one durable job and one net quota reservation')

  const readBody = { action: 'artifact', projectId, taskId: waiting.taskId, executionId: job.id }
  assert.equal((await request({ ...readBody, executionId: waiting.sourceJobId })).code, 404)
  assert.equal((await request(readBody)).code, 404, 'A queued generation marker is not a saved artifact')
  const payload = { title: 'Launch brief', blocks: [{ type: 'paragraph', text: 'Original saved content' }] }
  await store.mutate('alice', draft => {
    const current = draft.jobs.find(item => item.id === job.id), currentTask = draft.state.tasks.find(item => item.id === waiting.taskId)
    current.status = 'done'; current.progress = 1
    current.artifact = { type: 'studio-artifact', sourceJobId: waiting.sourceJobId, studioKind: 'document', payload, status: 'done', summary: 'Saved', revision: 1 }
    currentTask.status = 'done'; currentTask.progress = 1
    currentTask.artifact = { executionId: job.id, studioKind: 'document', revision: 1 }
  })
  const completedState = await store.read('alice'), completedCharges = fixture.reservations
  fixture.allowed = false
  assert.equal((await request(continueBody)).code, 200, 'A completed continuation still recovers its original acknowledgement')
  assert.equal(fixture.reservations, completedCharges)
  assert.deepEqual(await store.read('alice'), completedState)
  fixture.allowed = true
  const read = await request(readBody)
  assert.equal(read.code, 200); assert.deepEqual(read.body.artifact.payload, payload)
  assert.equal((await request(readBody, 'bob-token')).code, 404)
  assert.equal((await request({ ...readBody, projectId: otherProject })).code, 404)
  assert.equal((await request({ ...readBody, taskId: race.taskId })).code, 404)
  assert.equal((await request(readBody, null)).code, 401)
  assert.equal(JSON.stringify(read.body).includes('leaseToken'), false)
  console.log('PASS saved Studio artifact reads are authenticated and bound to the exact project, task and execution')

  const currentRevision = read.body.revision
  assert.ok(Number.isSafeInteger(currentRevision), 'Artifact read returns a usable artifact revision')
  const updateBody = { ...readBody, action: 'update-artifact', revision: currentRevision, payload: { ...payload, title: 'Edited title' } }
  await store.mutate('alice', draft => {
    draft.state.messages.push({ id: 'unrelated-account-update', projectId: otherProject, thread: 'group', speaker: 'You', content: 'Independent conversation activity', createdAt: Date.now() })
  })
  const beforeEdit = await store.read('alice'), otherBefore = await store.read('bob'), editCharges = fixture.reservations
  const updated = await request(updateBody)
  assert.equal(updated.code, 200, 'Unrelated account revision changes do not invalidate the artifact-specific revision')
  const reread = await request(readBody)
  assert.equal(reread.body.artifact.payload.title, 'Edited title')
  assert.ok(reread.body.revision > currentRevision)
  const acknowledged = await store.read('alice')
  assert.equal((await request(updateBody)).code, 200, 'An exact repeated edit recovers its lost acknowledgement')
  assert.deepEqual(await store.read('alice'), acknowledged, 'Repeated acknowledgement does not increment either revision again')
  assert.equal((await request({ ...updateBody, payload: { ...payload, title: 'Stale overwrite' } })).code, 409)
  assert.equal((await request(updateBody, 'bob-token')).code, 404)
  assert.equal((await request({ ...updateBody, projectId: otherProject })).code, 404)
  for (const invalid of [
    { revision: -1 }, { revision: '1' }, { payload: [] }, { payload: { title: 'Incomplete', blocks: [] } },
    { payload: { title: 'Oversized', blocks: [{ type: 'paragraph', text: 'x'.repeat(600001) }] } },
  ]) {
    assert.equal((await request({ ...updateBody, revision: reread.body.revision, ...invalid })).code, 400)
    assert.deepEqual(await store.read('alice'), acknowledged, 'Invalid edit must leave the saved artifact and account snapshot unchanged')
  }
  assert.equal(fixture.reservations, editCharges, 'Manual artifact edits do not dispatch or charge model work')
  const afterEdit = await store.read('alice')
  assert.deepEqual(afterEdit.state.tasks.find(item => item.id === waiting.taskId).artifact,
    { executionId: job.id, studioKind: 'document', revision: reread.body.revision })
  assert.deepEqual(afterEdit.state.messages, beforeEdit.state.messages)
  assert.deepEqual(afterEdit.jobs.filter(item => item.id !== job.id), beforeEdit.jobs.filter(item => item.id !== job.id))
  assert.deepEqual(await store.read('bob'), otherBefore)
  const concurrentRevision = reread.body.revision
  const edits = await Promise.all(['Device one', 'Device two'].map(title => request({ ...updateBody, revision: concurrentRevision, payload: { ...payload, title } })))
  assert.deepEqual(edits.map(response => response.code).sort(), [200, 409])
  const website = await waitingTask(projectId, 'website-edit-task')
  await store.mutate('alice', draft => {
    const execution = draft.jobs.find(item => item.id === website.sourceJobId)
    const current = draft.state.tasks.find(item => item.id === website.taskId)
    execution.status = 'done'
    execution.artifact = { type: 'studio-artifact', studioKind: 'website', revision: 1, status: 'done', payload: {
      html: '<html><body>Original website</body></html>', quality: { runtime: { status: 'passed', checks: ['original HTML passed'] } },
    } }
    current.status = 'done'; delete current.handoff
  })
  const websiteRead = { action: 'artifact', projectId, taskId: website.taskId, executionId: website.sourceJobId }
  const websiteUpdate = { ...websiteRead, action: 'update-artifact', revision: 1, payload: {
    html: '<html><body>Edited website</body></html>', quality: { runtime: { status: 'passed', checks: ['untrusted client claim'] } },
  } }
  assert.equal((await request(websiteUpdate)).code, 200)
  const websiteSaved = await request(websiteRead)
  assert.deepEqual(websiteSaved.body.artifact.payload.quality.runtime, {
    status: 'partial', widths: [], checks: [], limitations: ['Edited HTML has not been runtime-tested.'],
  })
  assert.equal((await request(websiteUpdate)).code, 200, 'Normalized website edit still recovers its lost acknowledgement')
  assert.equal((await request({ ...websiteUpdate, revision: 2 })).code, 200)
  assert.deepEqual((await request(websiteRead)).body, websiteSaved.body, 'Unchanged HTML cannot forge a new runtime pass')
  console.log('PASS website edits invalidate runtime checks on the server and cannot forge or replay a false pass')

  const book = await waitingTask(projectId, 'book-handoff-task')
  await store.mutate('alice', draft => {
    draft.jobs.find(item => item.id === book.sourceJobId).artifact.studioKind = 'book'
    draft.state.tasks.find(item => item.id === book.taskId).handoff.studioKind = 'book'
  })
  const beforeBook = await store.read('alice'), bookCharges = fixture.reservations
  const bookResponse = await request({ action: 'continue-studio', projectId, taskId: book.taskId, sourceJobId: book.sourceJobId, requestId: 'unsupported-book-continuation' })
  assert.equal(bookResponse.code, 400); assert.match(bookResponse.body.error, /long-form books in Studio/)
  assert.equal(fixture.reservations, bookCharges); assert.deepEqual(await store.read('alice'), beforeBook)
  console.log('PASS unsupported background books remain waiting without a failed queued job or quota charge')
  const beforeRestart = await request(readBody)
  assert.equal((await request({ action: 'start-task', projectId, taskId: waiting.taskId, requestId: 'newer-artifact-execution' })).code, 200)
  const restarted = await store.read('alice')
  assert.equal((await request({ ...updateBody, revision: beforeRestart.body.revision, payload: { ...payload, title: 'Old execution overwrite' } })).code, 409)
  assert.deepEqual(await store.read('alice'), restarted, 'A newer execution prevents stale artifact editing')
  assert.deepEqual(db.db.prepare('SELECT * FROM nalu_user_data').all(), ordinaryBefore)
  assert.equal(fixture.connects, fixture.closes)
  console.log('PASS artifact revision CAS permits one concurrent edit and preserves other work, accounts and ordinary chats')
} finally {
  globalThis.fetch = originalFetch
  delete globalThis.__swarmStudioRoutes
  db.db.close()
}
