// Scope/lease checks only. No model, generator, account, browser, or network calls.
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['api/_swarmGeneration.ts'], bundle: true, write: false, platform: 'node', format: 'esm', metafile: true,
  plugins: [{ name: 'no-storage-transport', setup(b) {
    // _swarm uses these limits in unrelated mutation actions. Exercise its REAL
    // context builder without loading SQL/Cloudflare transports in this suite.
    b.onResolve({ filter: /^\.\/_swarmStore$/ }, () => ({ path: 'store-limits', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const SWARM_MAX_STATE_BYTES=7000000; export const SWARM_MAX_SNAPSHOT_BYTES=9000000;' }))
  } }],
})
assert.ok(Object.keys(bundle.metafile.inputs).every(path => !/_db|_accountContext|_llm|_writingContext|_autopilotArtifacts/.test(path)), 'scope helper must not load account memory or providers')
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('No network is allowed in Swarm generation scope tests') }
const now = 10000
const handoff = { sourceJobId: 'source', taskId: 'task', expectedStudioKind: 'website' }
const running = { ...handoff, executionId: 'generation', leaseToken: 'lease-one' }
function snapshot(active = false) {
  const source = { id: 'source', projectId: 'project', thread: 'Rocky', kind: 'task', taskId: 'task', speaker: 'Rocky', status: 'waiting', input: 'Build a website for this launch.', requestId: 'source-request', createdAt: 200, updatedAt: 300, attempts: 1,
    artifact: { type: 'needs-workspace', workspace: 'studio', studioKind: 'website', prompt: 'Build a website for this launch.', reason: 'Continue with the Studio runtime.' } }
  const state = { version: 1, mode: 'live', projects: [
    { id: 'project', title: 'Launch', brief: 'SHARED_BRIEF', members: ['Nalu', 'Rocky', 'Milo'], createdAt: 1, updatedAt: 1 },
    { id: 'other', title: 'Another project', brief: 'OTHER_PROJECT_BRIEF', members: ['Nalu', 'Rocky', 'Milo'], createdAt: 1, updatedAt: 1 },
  ], tasks: [{ id: 'task', projectId: 'project', title: 'An edited title is not the immutable job input', assignee: 'Rocky', status: active ? 'running' : 'waiting', summary: 'Ready for Studio.', threads: ['Rocky'], executionId: active ? 'generation' : 'source', updatedAt: 300 },
    { id: 'private-task', projectId: 'project', title: 'MILO_PRIVATE_TASK', assignee: 'Milo', status: 'done', summary: 'Milo-only details', threads: ['Milo'], updatedAt: 50 }], messages: [
    { id: 'group', projectId: 'project', thread: 'group', speaker: 'You', content: 'GROUP_CONTEXT', createdAt: 100 },
    { id: 'rocky', projectId: 'project', thread: 'Rocky', speaker: 'Rocky', content: 'ROCKY_CONTEXT', createdAt: 110 },
    { id: 'milo', projectId: 'project', thread: 'Milo', speaker: 'Milo', content: 'MILO_PRIVATE_CONTEXT', createdAt: 110 },
    { id: 'other', projectId: 'other', thread: 'group', speaker: 'You', content: 'OTHER_PROJECT_CONTEXT', createdAt: 100 },
    { id: 'late', projectId: 'project', thread: 'Rocky', speaker: 'You', content: 'AFTER_HANDOFF_CONTEXT', createdAt: 250 },
  ], turns: [] }
  const jobs = [source]
  if (active) jobs.push({ ...source, id: 'generation', requestId: 'generation-request', createdAt: 400, updatedAt: 400, status: 'running', leaseToken: 'lease-one', leaseUntil: now + 1000,
    artifact: { type: 'studio-generation', sourceJobId: 'source', studioKind: 'website' } })
  return { revision: 2, state, jobs }
}
let cases = 0
const check = async (name, fn) => { await fn(); cases++; console.log(`PASS ${name}`) }
const rejects = (fn, status = 409) => assert.throws(fn, error => error.status === status)
try {
  await check('waiting preflight uses only authenticated-owner read and immutable job input', async () => {
    const saved = snapshot(), original = JSON.stringify(saved), reads = []
    const scope = await api.resolveSwarmStudioHandoff({ read: async owner => { reads.push(owner); return saved } }, 'authenticated-owner', { ...handoff, owner: 'injected-owner', prompt: 'INJECTED_PROMPT', context: [{ role: 'user', content: 'INJECTED_CONTEXT' }] })
    assert.deepEqual(reads, ['authenticated-owner'])
    assert.equal(scope.prompt, saved.jobs[0].input)
    assert.equal(scope.brief, 'SHARED_BRIEF')
    assert.equal(scope.lease, undefined)
    const text = JSON.stringify(scope)
    assert.match(text, /GROUP_CONTEXT/); assert.match(text, /ROCKY_CONTEXT/)
    assert.doesNotMatch(text, /MILO_PRIVATE|OTHER_PROJECT|AFTER_HANDOFF|INJECTED/)
    assert.equal(JSON.stringify(saved), original, 'scope resolution must not mutate durable data')
    assert.ok(Object.isFrozen(scope) && Object.isFrozen(scope.context) && Object.isFrozen(scope.context[0]))
    rejects(() => api.requireLeasedSwarmGeneration(scope))
  })
  await check('other owner cannot read another account handoff', async () => {
    const empty = { ...snapshot(), jobs: [] }
    await assert.rejects(api.resolveSwarmStudioHandoff({ read: async owner => owner === 'owner-a' ? snapshot() : empty }, 'owner-b', handoff), error => error.status === 404)
  })
  await check('invalid auth/kind and sample data fail before generation', async () => {
    let reads = 0
    await assert.rejects(api.resolveSwarmStudioHandoff({ read: async () => { reads++; return snapshot() } }, '', handoff), error => error.status === 401)
    assert.equal(reads, 0)
    for (const kind of ['chat', 'webpage', 'presentation', 'invented']) rejects(() => api.validateSwarmStudioHandoff(snapshot(), 'owner', { ...handoff, expectedStudioKind: kind }), 400)
    const value = snapshot(); value.state.mode = 'sample'
    rejects(() => api.validateSwarmStudioHandoff(value, 'owner', handoff), 400)
  })
  await check('all canonical Studio creation kinds require exact handoff kind', async () => {
    const kinds = ['document', 'book', 'spreadsheet', 'slides', 'cad', 'video', 'image', 'carousel', 'website', 'logo', 'palette', 'brand', 'blueprint', 'poster', 'canvas', 'shopping', 'motion', 'game', 'board', 'email']
    for (const kind of kinds) {
      const value = snapshot(); value.jobs[0].artifact.studioKind = kind
      assert.equal(api.validateSwarmStudioHandoff(value, 'owner', { ...handoff, expectedStudioKind: kind }).studioKind, kind)
      rejects(() => api.validateSwarmStudioHandoff(value, 'owner', { ...handoff, expectedStudioKind: kind === 'website' ? 'logo' : 'website' }))
    }
  })
  await check('handoff cannot substitute task, project, thread, prompt, or artifact type', async () => {
    for (const mutate of [
      v => { v.jobs[0].taskId = 'private-task' }, v => { v.state.tasks[0].projectId = 'other' },
      v => { v.state.tasks[0].threads = ['Milo'] }, v => { v.jobs[0].artifact.prompt = 'New unapproved request' },
      v => { v.jobs[0].artifact.workspace = 'chat' }, v => { v.jobs[0].artifact.type = 'text' },
      v => { v.state.projects[0].members = ['Nalu', 'Milo'] }, v => { v.jobs[0].kind = 'reply' },
    ]) { const value = snapshot(); mutate(value); rejects(() => api.validateSwarmStudioHandoff(value, 'owner', handoff)) }
  })
  await check('stale handoff and active duplicate are rejected inside mutation validator', async () => {
    for (const mutate of [
      v => { v.jobs[0].status = 'done' }, v => { v.state.tasks[0].status = 'cancelled' },
      v => { v.state.tasks[0].executionId = 'a-later-run' },
      v => { v.jobs.push({ ...v.jobs[0], id: 'duplicate', status: 'queued' }) },
    ]) { const value = snapshot(); mutate(value); rejects(() => api.validateSwarmStudioHandoff(value, 'owner', handoff)) }
  })
  await check('running continuation validates durable link, current task, and lease', async () => {
    const scope = await api.resolveSwarmGenerationScope({ read: async () => snapshot(true) }, 'owner', running, () => now)
    assert.deepEqual(scope.lease, { jobId: 'generation', token: 'lease-one' })
    assert.equal(scope.sourceJobId, 'source'); assert.equal(scope.prompt, snapshot().jobs[0].input)
    api.requireLeasedSwarmGeneration(scope)
    rejects(() => api.requireLeasedSwarmGeneration(JSON.parse(JSON.stringify(scope))), 409)
  })
  await check('wrong, expired, missing, and cancelled leases cannot authorize provider work', async () => {
    for (const mutate of [
      v => { v.jobs[1].leaseToken = 'another-worker' }, v => { v.jobs[1].leaseUntil = now },
      v => { delete v.jobs[1].leaseUntil }, v => { v.jobs[1].status = 'cancelled' },
      v => { v.state.tasks[0].executionId = 'a-newer-job' }, v => { v.state.tasks[0].status = 'waiting' },
    ]) { const value = snapshot(true); mutate(value); rejects(() => api.validateSwarmGenerationScope(value, 'owner', running, now)) }
  })
  await check('continuation cannot change immutable source request or cross its boundaries', async () => {
    for (const mutate of [
      v => { v.jobs[1].input = 'Altered request' }, v => { v.jobs[1].projectId = 'other' },
      v => { v.jobs[1].thread = 'group' }, v => { v.jobs[1].taskId = 'private-task' },
      v => { v.jobs[1].speaker = 'Milo' }, v => { v.jobs[1].createdAt = 199 },
      v => { v.jobs[1].artifact.sourceJobId = 'other-source' }, v => { v.jobs[1].artifact.studioKind = 'image' },
      v => { v.jobs[1].artifact.type = 'needs-workspace' },
    ]) { const value = snapshot(true); mutate(value); rejects(() => api.validateSwarmGenerationScope(value, 'owner', running, now)) }
  })
  await check('reassignment preserves root private-thread context guard', async () => {
    const value = snapshot(true); value.state.tasks[0].assignee = 'Milo'; value.jobs[1].speaker = 'Milo'
    const scope = api.validateSwarmGenerationScope(value, 'owner', running, now)
    assert.equal(scope.speaker, 'Milo'); assert.match(JSON.stringify(scope.context), /GROUP_CONTEXT/)
    assert.doesNotMatch(JSON.stringify(scope.context), /ROCKY_CONTEXT|MILO_PRIVATE|AFTER_HANDOFF|OTHER_PROJECT/)
  })
  await check('lease time is evaluated after the durable read, not before it', async () => {
    let clock = now
    await assert.rejects(api.resolveSwarmGenerationScope({ read: async () => { clock += 2000; return snapshot(true) } }, 'owner', running, () => clock), error => error.status === 409)
    rejects(() => api.validateSwarmGenerationScope(snapshot(true), 'owner', running, Infinity), 400)
  })
  console.log(`${cases} Swarm generation scope regressions passed.`)
} finally { globalThis.fetch = originalFetch }
