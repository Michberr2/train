// Real flow-run + activity handlers and scheduler, with offline auth/storage.
// Run: node scripts/cron-stop-regressions.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { artifactDatabase, loadArtifactServer } from './autopilot-artifact-fixture.mjs'

const server = await loadArtifactServer()
globalThis.__stopRunner = server
const services = {
  './_projectData': 'export async function writeProjectData(){throw new Error("unexpected project write")}',
  './_artifactIsolation': 'export function sendIsolatedArtifact(){throw new Error("unexpected artifact share")}',
  './_cloudflareData': 'export async function cloudflareData(){throw new Error("unexpected storage backend")}',
  './_notebook': 'export async function handleNotebook(){return false}',
  './_db': `export function getClient(){return globalThis.__stopDb}
    export async function ensureSchema(){}
    export async function userIdForToken(c,t){return t==='owner'?'test-account':t==='other'?'other-account':null}
    export function readToken(req){return (req.headers.authorization||'').replace(/^Bearer /,'')}
    export function safeJson(s){return JSON.parse(s)}
    export function newToken(){throw new Error('unexpected token creation')}`,
  './_cron': 'export const runOneFlow=(...args)=>globalThis.__stopRunner.runOneFlow(...args); export const runDueCrons=(...args)=>globalThis.__stopRunner.runDueCrons(...args)',
  './_notes': 'export function extractNotes(){throw new Error("unexpected provider call")}',
  './_limits': 'export function reserveDailyQuota(){throw new Error("unexpected quota use")}',
  './_push': 'export async function handlePushAction(){return false}',
  './_messageMedia': 'export function mediaLink(){return ""}',
  './_phoneOwner': 'export function ownsPhone(){return false}',
  './_tasks': 'export async function handleTaskAction(){return false}',
}
const compiled = await build({
  entryPoints: ['api/data.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'offline-stop-services', setup(build) {
    build.onResolve({ filter: /^\.\/_/ }, ({ path }) => {
      if (path === './_chatMerge' || path === './_syncPayload') return
      assert.ok(path in services, `unmocked service: ${path}`)
      return { path, namespace: 'offline' }
    })
    build.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: services[path], loader: 'js' }))
  } }],
})
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const seed = {
  id: 'stop-lifecycle', name: 'Review before continuing', schedule: 'manual',
  nodes: [{ id: 'input', type: 'trigger', prompt: 'Prepared input' }, { id: 'gate', type: 'approval', label: 'Review input' }],
  edges: [{ from: 'input', to: 'gate' }],
}

function database() {
  const db = artifactDatabase(seed, 'test-account')
  const query = db.query.bind(db)
  db.ledger = new Map()
  db.statements = []
  db.query = async (sql, params = []) => {
    const q = sql.trim()
    db.statements.push(q)
    if (q.startsWith('INSERT INTO nalu_tasks')) {
      const [id, user_id, source, title, detail, status, progress, event] = params
      const previous = db.ledger.get(id)
      if (!previous || previous.user_id === user_id) db.ledger.set(id, {
        ...previous, id, user_id, source: previous?.source || source || 'pipeline', title: title || previous?.title || '',
        detail: detail ?? previous?.detail, status: status ?? previous?.status ?? 'running', progress: progress ?? previous?.progress ?? 0,
        events: [...(previous?.events || []), ...(event ? [{ m: event }] : [])], meta: {},
      })
      return { rows: [] }
    }
    if (q.startsWith('UPDATE nalu_tasks SET meta=')) {
      assert.match(q, /WHERE user_id=\$1 AND id=\$2/)
      const row = db.ledger.get(params[1])
      if (row?.user_id === params[0]) row.meta = { ...row.meta, ...JSON.parse(params[2]) }
      return { rows: [] }
    }
    if (q.startsWith('UPDATE nalu_tasks')) {
      assert.match(q, /WHERE id=\$1 AND user_id=\$2 AND status IN \('queued','running','waiting'\)/)
      const row = db.ledger.get(params[0])
      if (row?.user_id === params[1] && ['queued', 'running', 'waiting'].includes(row.status)) {
        db.ledger.set(row.id, { ...row, status: 'cancelled', detail: 'Stopped from mobile', events: [...row.events, { m: 'Stopped from mobile' }] })
      }
      return { rows: [] }
    }
    if (q.includes('FROM nalu_tasks')) return { rows: [...db.ledger.values()].filter((row) => row.user_id === params[0]) }
    if (q.startsWith('SELECT key, value FROM nalu_user_data')) return { rows: [{ key: 'nalu-agent-flows', value: JSON.stringify(db.flows.get(params[0]) || []) }] }
    return query(sql, params)
  }
  return db
}

async function request(db, body, token = 'owner') {
  globalThis.__stopDb = db
  const res = { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res)
  return res
}

try {
  for (const status of ['waiting', 'running', 'queued']) {
    const db = database()
    assert.equal((await request(db, { action: 'flow-run', flowId: seed.id, mode: 'run' })).body.status, 'awaiting')
    const taskId = `flow_${seed.id}_${db.flow.run.startedAt}`
    const original = db.ledger.get(taskId)
    if (status !== 'waiting') {
      // A terminated worker leaves its last running/queued ledger checkpoint.
      db.flow = { ...db.flow, run: { ...db.flow.run, status: 'running', heartbeat: 1 } }
      db.ledger.set(taskId, { ...original, status })
    }
    const before = await request(db, { action: 'activity' })
    assert.equal(before.body.tasks.length, 1)
    assert.equal(before.body.tasks[0].status, status)
    const stop = await request(db, { action: 'flow-run', flowId: seed.id, mode: 'stop' })
    assert.equal(stop.code, 200)
    assert.equal(stop.body.status, 'stopped')
    const after = await request(db, { action: 'activity' })
    assert.equal(after.body.tasks.length, 1, `stopping ${status} must not create a separate history row`)
    assert.equal(after.body.tasks[0].id, taskId)
    assert.equal(after.body.tasks[0].status, 'cancelled')
    assert.equal(after.body.tasks[0].progress, original.progress)
    assert.equal(after.body.pipelines[0].status, 'cancelled')
    assert.equal(db.flow.results.input, 'Prepared input')
    const settled = structuredClone(db.ledger.get(taskId))
    await request(db, { action: 'flow-run', flowId: seed.id, mode: 'stop' })
    assert.deepEqual(db.ledger.get(taskId), settled, 'repeat Stop must not append duplicate cancellation events')
    const stopUpdate = db.statements.findIndex((q) => q.startsWith("UPDATE nalu_tasks SET status='cancelled'"))
    assert.ok(stopUpdate >= 0)
    assert.equal(db.statements[stopUpdate + 1], 'COMMIT', 'flow status and task cancellation must commit together')
  }
  console.log('PASS real activity: stopped approvals and orphaned runs settle their original task with one history row')

  for (const status of ['done', 'failed', 'cancelled']) {
    const db = database()
    await request(db, { action: 'flow-run', flowId: seed.id, mode: 'run' })
    const taskId = [...db.ledger.keys()][0]
    const terminal = { ...db.ledger.get(taskId), status }
    db.ledger.set(taskId, terminal)
    await request(db, { action: 'flow-run', flowId: seed.id, mode: 'stop' })
    assert.deepEqual(db.ledger.get(taskId), terminal, 'Stop must preserve terminal task history')
  }
  const db = database()
  await request(db, { action: 'flow-run', flowId: seed.id, mode: 'run' })
  const owned = structuredClone([...db.ledger.values()][0])
  db.flows.set('other-account', [db.flow]) // exact run ID collision owned elsewhere
  assert.equal((await request(db, { action: 'flow-run', flowId: seed.id, mode: 'stop' }, 'other')).code, 200)
  assert.deepEqual(db.ledger.get(owned.id), owned)
  assert.equal(db.flow.run.status, 'awaiting')
  assert.equal((await request(db, { action: 'activity' }, 'other')).body.tasks.length, 0)
  assert.equal((await request(db, { action: 'flow-run', flowId: seed.id, mode: 'stop' }, 'invalid')).code, 401)
  console.log('PASS Stop preserves terminal history and account ownership, including colliding run IDs')
} finally {
  delete globalThis.__stopDb
  delete globalThis.__stopRunner
}
