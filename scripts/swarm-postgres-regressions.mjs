import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { build } from 'esbuild'
import pg from 'pg'

// This script always creates a fresh private cluster. It never accepts an
// existing cluster, connection URL, credentials, or TCP listener.
const binary = '/opt/homebrew/opt/postgresql@16/bin'
const directory = await mkdtemp('/private/tmp/nalu-swarm-pg-')
const data = join(directory, 'data'), socket = join(directory, 'socket')
await mkdir(socket, { mode: 0o700 })
const runFile = promisify(execFile), clients = [], checks = []
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', PGPASSFILE: '/dev/null', PGSERVICE: '', PGPASSWORD: '' }
const receipt = { startedAt: new Date().toISOString(), directory, socket, tcp: false, syntheticOnly: true, checks,
  source: {}, serverStopped: false, status: 'RUNNING' }
const run = async (name, args) => {
  try {
    const result = await runFile(join(binary, name), args, { env, timeout: 30000, maxBuffer: 2000000 })
    await writeFile(join(directory, `${name}-${Date.now()}.log`), result.stdout + result.stderr)
    return result
  } catch (error) {
    await writeFile(join(directory, `${name}-${Date.now()}-error.log`), String(error.stdout || '') + String(error.stderr || '') + String(error.message))
    throw error
  }
}
const connected = async () => {
  const client = new pg.Client({ host: socket, port: 55432, user: 'nalu_swarm_test', database: 'postgres', password: '', ssl: false,
    connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: 'swarm-isolated-regression' })
  clients.push(client); await client.connect(); return client
}
const check = (name) => { checks.push(name); console.log(`PASS ${name}`) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let testError
try {
  for (const path of ['api/_swarmStore.ts', 'api/_swarm.ts', 'api/_swarmGeneration.ts']) {
    receipt.source[path] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  await run('initdb', ['-D', data, '-U', 'nalu_swarm_test', '--auth=trust', '--no-locale', '--encoding=UTF8'])
  await run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-F -c listen_addresses='' -c unix_socket_directories='${socket}' -c port=55432 -c shared_buffers=16MB -c max_connections=20`, '-w', 'start'])
  const admin = await connected()
  const configuration = (await admin.query("SELECT version(),inet_server_addr() AS address,current_setting('listen_addresses') AS listeners,current_setting('unix_socket_directories') AS sockets")).rows[0]
  assert.equal(configuration.address, null); assert.equal(configuration.listeners, ''); assert.equal(configuration.sockets, socket)
  receipt.server = configuration
  await admin.query("CREATE TABLE nalu_users(id TEXT PRIMARY KEY); INSERT INTO nalu_users VALUES('alice'),('bob'); CREATE TABLE nalu_user_data(user_id TEXT REFERENCES nalu_users(id) ON DELETE CASCADE,key TEXT,value TEXT,PRIMARY KEY(user_id,key)); INSERT INTO nalu_user_data VALUES('alice','nalu-chats','ordinary-chat-canary');")
  const bundled = await build({ stdin: { contents: "export { SwarmStore } from './api/_swarmStore'; export { applySwarmAction,readSwarmArtifact } from './api/_swarm';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  const { SwarmStore, applySwarmAction, readSwarmArtifact } = module.exports
  const stores = []
  for (let i = 0; i < 4; i++) stores.push(new SwarmStore(await connected()))
  const coldReads = await Promise.allSettled(stores.map(store => store.read('alice')))
  for (const result of coldReads) if (result.status === 'rejected') throw result.reason
  assert.ok(coldReads.every(result => result.value.state.projects.length === 0))
  check('real PostgreSQL schema initializes on concurrent independent connections without touching existing data')
  // A schema bootstrap failure must roll back its DDL, release the advisory
  // lock, and clear its per-client ready cache so a later request can retry.
  await admin.query('CREATE SCHEMA missing_parent')
  const retryClient = await connected(), retryStore = new SwarmStore(retryClient)
  await retryClient.query('SET search_path TO missing_parent')
  await assert.rejects(retryStore.read('alice'), error => error.code === '42P01')
  assert.equal((await retryClient.query("SELECT to_regclass('missing_parent.nalu_swarm_accounts') AS table_name")).rows[0].table_name, null)
  const lock = "hashtext('nalu_swarm_schema_v1')"
  assert.equal((await admin.query(`SELECT pg_try_advisory_lock(${lock}) AS available`)).rows[0].available, true)
  await admin.query(`SELECT pg_advisory_unlock(${lock})`)
  await retryClient.query('SET search_path TO public')
  assert.equal((await retryStore.read('alice')).state.projects.length, 0)
  await admin.query('DROP SCHEMA missing_parent')
  check('failed PostgreSQL schema initialization rolls back, releases its lock, and retries on the same client')
  const store = stores[0]
  const action = (body, which = store, owner = 'alice') => which.mutate(owner, draft => applySwarmAction(draft, owner, body, Date.now()))
  let saved = await action({ action: 'create', requestId: 'pg-project-alice', title: 'Alice project', brief: '' })
  const projectId = saved.state.projects[0].id
  await action({ action: 'create', requestId: 'pg-project-bob', title: 'Bob project', brief: '' }, stores[1], 'bob')
  const bobBefore = await stores[1].read('bob')
  await Promise.all(Array.from({ length: 6 }, (_, i) => stores[i % stores.length].mutate('alice', draft => {
    draft.state.messages.push({ id: `competing-${i}`, projectId, thread: 'Rocky', speaker: 'You', content: `Concurrent append ${i}`, createdAt: Date.now() })
  })))
  assert.equal((await store.read('alice')).state.messages.length, 6)
  assert.deepEqual(await stores[1].read('bob'), bobBefore)
  check('competing PostgreSQL revision CAS retains all independent appends and isolates owners')

  for (let i = 0; i < 5; i++) {
    saved = await action({ action: 'add-task', projectId, thread: 'Rocky', requestId: `pg-work-${i}`, title: `Task ${i}`, assignee: 'Rocky' })
    const task = saved.state.tasks.find(item => item.requestId === `pg-work-${i}`)
    await action({ action: 'start-task', projectId, taskId: task.id, requestId: `pg-start-${i}` })
  }
  const claimed = (await Promise.all(Array.from({ length: 6 }, (_, i) => stores[i % stores.length].claim('alice')))).filter(Boolean)
  assert.equal(claimed.length, 3); assert.equal(new Set(claimed.map(job => job.id)).size, 3)
  assert.equal(await store.renew('alice', claimed[0].id, claimed[0].leaseToken), true)
  assert.equal(await store.renew('bob', claimed[0].id, claimed[0].leaseToken), false)
  assert.equal(await store.renew('alice', claimed[0].id, 'wrong-token'), false)
  await action({ action: 'stop-task', projectId, taskId: claimed[0].taskId })
  assert.equal(await store.mutateLeased('alice', claimed[0].id, claimed[0].leaseToken, draft => { draft.state.projects[0].title = 'CANCELLED_RESULT' }), null)
  const finished = await store.mutateLeased('alice', claimed[1].id, claimed[1].leaseToken, draft => {
    const job = draft.jobs.find(item => item.id === claimed[1].id), task = draft.state.tasks.find(item => item.id === job.taskId)
    job.status = 'done'; job.result = 'Real persisted fixture result'; job.progress = 1; delete job.leaseToken; delete job.leaseUntil
    task.status = 'done'; task.progress = 1
  })
  assert.equal(finished.jobs.find(item => item.id === claimed[1].id).result, 'Real persisted fixture result')
  check('PostgreSQL parallel claims cap at three, renew correct leases, and fence cancellation and results')

  // Hold the owner row while the result waits to commit. A lease valid at the
  // application read must still be valid at PostgreSQL write time.
  const expiring = claimed[2]
  await store.mutate('alice', draft => { draft.jobs.find(item => item.id === expiring.id).leaseUntil = Date.now() + 150 })
  await admin.query('BEGIN')
  await admin.query('SELECT owner_id FROM nalu_swarm_accounts WHERE owner_id=$1 FOR UPDATE', ['alice'])
  let callbackRan
  const callback = new Promise(resolve => { callbackRan = resolve })
  const late = store.mutateLeased('alice', expiring.id, expiring.leaseToken, draft => { callbackRan(); draft.state.projects[0].title = 'EXPIRED_RESULT' })
  await callback; await delay(200); await admin.query('COMMIT')
  assert.equal(await late, null)
  await store.claim('alice', 'no-such-job')
  saved = await store.read('alice')
  assert.equal(saved.jobs.find(item => item.id === expiring.id).status, 'failed')
  assert.equal(saved.state.tasks.find(item => item.id === expiring.taskId).status, 'failed')
  assert.equal(saved.state.projects[0].title, 'Alice project')
  for (const task of saved.state.tasks) await action({ action: 'stop-task', projectId, taskId: task.id })
  check('PostgreSQL database-time fencing rejects a lease that expires while waiting for the owner lock')

  await admin.query("CREATE FUNCTION fail_swarm_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected revision write failure'; END $$; CREATE TRIGGER fail_revision BEFORE UPDATE ON nalu_swarm_accounts FOR EACH ROW EXECUTE FUNCTION fail_swarm_revision();")
  const beforeFailure = await store.read('alice')
  await assert.rejects(store.mutate('alice', draft => { draft.state.projects[0].title = 'MUST_ROLL_BACK' }), /Injected revision/)
  await admin.query('DROP TRIGGER fail_revision ON nalu_swarm_accounts; DROP FUNCTION fail_swarm_revision();')
  assert.deepEqual(await store.read('alice'), beforeFailure)
  check('real PostgreSQL transaction rollback restores all rows when the final revision update fails')

  saved = await action({ action: 'add-task', projectId, thread: 'Rocky', requestId: 'pg-studio-task', title: 'Create the launch document', assignee: 'Rocky' })
  const studioTask = saved.state.tasks.find(item => item.requestId === 'pg-studio-task')
  saved = await action({ action: 'start-task', projectId, taskId: studioTask.id, requestId: 'pg-studio-source' })
  const sourceId = saved.state.tasks.find(item => item.id === studioTask.id).executionId
  await store.mutate('alice', draft => {
    const job = draft.jobs.find(item => item.id === sourceId), task = draft.state.tasks.find(item => item.id === studioTask.id)
    job.status = 'waiting'; job.artifact = { type: 'needs-workspace', workspace: 'studio', studioKind: 'document', prompt: job.input, reason: 'Continue in Studio' }
    task.status = 'waiting'
  })
  const continuation = { action: 'continue-studio', projectId, taskId: studioTask.id, sourceJobId: sourceId, requestId: 'pg-studio-continue' }
  const concurrent = await Promise.all([action(continuation, stores[0]), action(continuation, stores[1])])
  const executionId = concurrent[0].state.tasks.find(item => item.id === studioTask.id).executionId
  saved = await store.read('alice')
  assert.equal(saved.jobs.filter(item => item.artifact?.sourceJobId === sourceId).length, 1)
  const generation = await store.claim('alice', executionId)
  await store.mutateLeased('alice', executionId, generation.leaseToken, draft => {
    const job = draft.jobs.find(item => item.id === executionId), task = draft.state.tasks.find(item => item.id === studioTask.id)
    job.status = 'done'; delete job.leaseToken; delete job.leaseUntil
    job.artifact = { type: 'studio-artifact', studioKind: 'document', sourceJobId: sourceId, revision: 1, payload: { title: 'Original', blocks: [{ type: 'paragraph', text: 'Saved content' }] } }
    task.status = 'done'; task.artifact = { executionId, studioKind: 'document', revision: 1 }
  })
  const readBody = { projectId, taskId: studioTask.id, executionId }
  assert.equal(readSwarmArtifact(await store.read('alice'), readBody).revision, 1)
  const edits = await Promise.allSettled(['One', 'Two'].map((title, i) => action({ ...readBody, action: 'update-artifact', revision: 1,
    payload: { title, blocks: [{ type: 'paragraph', text: 'Edited content' }] } }, stores[i])))
  assert.equal(edits.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(edits.find(item => item.status === 'rejected').reason.status, 409)
  const artifact = readSwarmArtifact(await store.read('alice'), readBody)
  assert.equal(artifact.revision, 2)
  const beforeAck = await store.read('alice')
  await action(continuation)
  assert.deepEqual(await store.read('alice'), beforeAck)
  assert.throws(() => readSwarmArtifact(bobBefore, readBody), error => error.status === 404)
  assert.equal((await admin.query("SELECT value FROM nalu_user_data WHERE user_id='alice' AND key='nalu-chats'")).rows[0].value, 'ordinary-chat-canary')
  check('actual Studio actions persist idempotent continuation and artifact CAS without changing ordinary chats')

  await admin.query('DELETE FROM nalu_users WHERE id=$1', ['alice'])
  for (const table of ['accounts', 'projects', 'rooms', 'messages', 'tasks', 'task_threads', 'turns', 'jobs']) {
    assert.equal(Number((await admin.query(`SELECT COUNT(*) AS n FROM nalu_swarm_${table} WHERE owner_id=$1`, ['alice'])).rows[0].n), 0)
  }
  assert.deepEqual(await stores[1].read('bob'), bobBefore)
  check('PostgreSQL foreign keys cascade account deletion while preserving the other account')
  receipt.status = 'PASS'
} catch (error) {
  testError = error; receipt.status = 'FAIL'; receipt.error = error.stack || String(error)
} finally {
  await Promise.allSettled(clients.map(client => client.end()))
  try {
    await access(join(data, 'postmaster.pid'))
    await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'])
    receipt.serverStopped = true
  } catch (error) {
    if (error.code === 'ENOENT') receipt.serverStopped = true
    else { receipt.cleanupError = String(error); receipt.status = 'FAIL'; testError ||= error }
  }
  receipt.finishedAt = new Date().toISOString()
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(`Receipt: ${join(directory, 'receipt.json')}`)
}
if (testError) throw testError
