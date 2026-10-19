import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundled = await build({ stdin: { contents: `export * from './api/_swarm'; export * from './api/_swarmWorker'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'no-services', setup(builder) {
    builder.onResolve({ filter: /\/_connectionBackend$|\/_swarmStore$|\/_swarmExecution$|\/_swarmStudioRunner$/ }, args => ({ path: args.path, namespace: 'offline' }))
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, args => ({ contents: args.path.endsWith('_swarmExecution')
      ? 'export async function executeSwarmWork(){throw new Error("Inject offline executor")}'
      : args.path.endsWith('_swarmStudioRunner') ? 'export async function runSwarmStudioJob(){throw new Error("Inject offline Studio executor")}'
      : args.path.endsWith('_swarmStore') ? 'export class SwarmStore {}; export const SWARM_MAX_STATE_BYTES=3000000, SWARM_MAX_SNAPSHOT_BYTES=12000000' : 'export function connectionBackend(){throw new Error("No real database in this suite")}' }))
  } }] })
const { applySwarmAction, createdProjectId, swarmContext, appendSwarmResult, executeLeasedSwarmJob } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const empty = () => ({ revision: 0, state: { version: 1, mode: 'live', projects: [], tasks: [], messages: [], turns: [] }, jobs: [] })
const change = (s, action, now = 1000, owner = 'owner-a') => applySwarmAction(s, owner, action, now)
const projectRequest = { action: 'create', requestId: 'project-0001', title: 'Launch', brief: 'Shared brief' }
let state = empty()
change(state, projectRequest)
const projectId = state.state.projects[0].id
assert.equal(createdProjectId('owner-a', projectRequest), projectId)
change(state, projectRequest)
assert.equal(state.state.projects.length, 1)
assert.throws(() => change(state, { ...projectRequest, title: 'Different' }), /different project/)
const other = empty(); change(other, projectRequest, 1000, 'owner-b')
assert.notEqual(other.state.projects[0].id, projectId)
assert.throws(() => change(other, { action: 'send', projectId, thread: 'group', requestId: 'foreign-0001', content: 'no' }), /not found/)

// Ordinary group messages belong to the whole team; explicit handles narrow
// recipients without making emails/longer handles into accidental mentions.
for (const [content, speakers] of [
  ['What should we do next?', ['Nalu', 'Rocky', 'Milo']],
  ['@rocky, what would you change?', ['Rocky']],
  ['(@MILO) and @Rocky: compare these. @milo', ['Rocky', 'Milo']],
  ['@Nalu review team@Rocky.example, @Milo2, @Rocky_note, and @Miloñ.', ['Nalu']],
]) {
  const snapshot = empty(); change(snapshot, projectRequest)
  const action = { action: 'send', projectId, thread: 'group', requestId: 'routing-00001', content }
  change(snapshot, action)
  assert.deepEqual(snapshot.jobs.map(job => job.speaker), speakers, content)
  assert.deepEqual(snapshot.state.turns.map(turn => turn.replySpeaker), speakers)
  assert.equal(new Set(snapshot.jobs.map(job => job.id)).size, speakers.length)
  change(snapshot, action)
  assert.equal(snapshot.jobs.length, speakers.length, 'repeated acceptance creates no extra jobs')
  assert.equal(snapshot.state.messages.length, 1, 'repeated acceptance creates no extra user message')
}
{
  const snapshot = empty(); change(snapshot, projectRequest)
  snapshot.state.projects[0].members = ['Rocky', 'Milo']
  change(snapshot, { action: 'send', projectId, thread: 'group', requestId: 'members-00001', content: 'Discuss the plan.' })
  assert.deepEqual(snapshot.jobs.map(job => job.speaker), ['Rocky', 'Milo'], 'use this project’s membership')
}
for (const thread of ['Nalu', 'Rocky', 'Milo']) {
  const snapshot = empty(); change(snapshot, projectRequest)
  change(snapshot, { action: 'send', projectId, thread, requestId: 'private-route-001', content: '@Nalu @Rocky @Milo: keep this in our private branch.' })
  assert.deepEqual(snapshot.jobs.map(job => job.speaker), [thread], 'mentions cannot share or redirect a private branch')
  assert.deepEqual(snapshot.state.turns.map(turn => turn.thread), [thread])
}

const send = (requestId, thread, content, now = 1100) => change(state, { action: 'send', projectId, requestId, thread, content }, now)
send('group-00001', 'group', '@Nalu @Rocky @Milo discuss the launch')
assert.equal(state.jobs.length, 3)
assert.equal(new Set(state.jobs.map(job => job.requestId)).size, 3)
send('group-00001', 'group', '@Nalu @Rocky @Milo discuss the launch')
assert.equal(state.jobs.length, 3, 'idempotent reply acceptance')
assert.throws(() => send('group-00002', 'group', 'duplicate pending'), /Wait for/)
change(state, { action: 'stop', projectId, thread: 'group' }, 1200)
assert.ok(state.jobs.every(job => job.status === 'cancelled'))
assert.ok(state.state.turns.every(turn => turn.status === 'cancelled'))
send('private-0001', 'Rocky', 'ROCKY_PRIVATE_CANARY', 1300)
send('private-0002', 'Milo', 'MILO_PRIVATE_CANARY', 1301)
const rocky = state.jobs.find(job => job.thread === 'Rocky')
const context = swarmContext(state, rocky).context.map(message => message.content).join('\n')
assert.match(context, /Shared|launch/)
assert.match(context, /ROCKY_PRIVATE_CANARY/)
assert.doesNotMatch(context, /MILO_PRIVATE_CANARY/)
change(state, { ...projectRequest, requestId: 'project-0002', title: 'Other' }, 1000)
const otherProject = state.state.projects[1].id
change(state, { action: 'send', projectId: otherProject, requestId: 'other-msg-001', thread: 'group', content: 'OTHER_PROJECT_CANARY' }, 1100)
assert.doesNotMatch(swarmContext(state, rocky).context.map(message => message.content).join('\n'), /OTHER_PROJECT_CANARY/)

change(state, { action: 'add-task', projectId, thread: 'Rocky', requestId: 'work-00001', title: 'Prepare private notes', assignee: 'Rocky' }, 1400)
const task = state.state.tasks[0]
change(state, { action: 'assign-task', projectId, taskId: task.id, assignee: 'Milo' }, 1401)
assert.deepEqual(task.threads, ['Rocky'], 'reassignment must not share private work')
change(state, { action: 'start-task', projectId, taskId: task.id, requestId: 'start-00001' }, 1402)
const job = state.jobs.find(job => job.id === task.executionId)
assert.equal(job.thread, 'Rocky'); assert.equal(job.speaker, 'Milo')
assert.throws(() => change(state, { action: 'assign-task', projectId, taskId: task.id, assignee: 'Nalu' }), /Stop this work/)
change(state, { action: 'start-task', projectId, taskId: task.id, requestId: 'start-00001' }, 1402)
assert.equal(state.jobs.filter(job => job.taskId === task.id).length, 1)
change(state, { action: 'stop-task', projectId, taskId: task.id }, 1403)
assert.equal(task.status, 'cancelled')
change(state, { action: 'start-task', projectId, taskId: task.id, requestId: 'start-00002' }, 1404)
assert.notEqual(task.executionId, job.id)
assert.equal(job.status, 'cancelled')

// Explicitly sharing a completed work item copies only its result, not the
// private conversation, and does not duplicate it on a repeated share request.
const latestJob = state.jobs.find(job => job.id === task.executionId)
latestJob.status = 'done'; latestJob.result = 'EXPLICIT_WORK_RESULT'; task.status = 'done'
appendSwarmResult(state, latestJob, latestJob.result, 1500)
assert.equal(state.state.messages.filter(message => message.thread === 'group' && message.content === latestJob.result).length, 0)
change(state, { action: 'share-task', projectId, taskId: task.id }, 1600)
change(state, { action: 'share-task', projectId, taskId: task.id }, 1601)
assert.equal(state.state.messages.filter(message => message.thread === 'group' && message.content === latestJob.result).length, 1)
assert.equal(state.state.messages.filter(message => message.thread === 'group' && /PRIVATE_CANARY/.test(message.content)).length, 0)

function fixtureJob() {
  const snapshot = empty(); change(snapshot, projectRequest)
  change(snapshot, { action: 'send', projectId, thread: 'Rocky', requestId: 'worker-0001', content: 'Give the answer' }, 2000)
  const job = snapshot.jobs[0]
  Object.assign(job, { status: 'running', leaseToken: 'owned-lease', leaseUntil: Date.now() + 120000 })
  let current = snapshot
  const store = {
    read: async () => structuredClone(current),
    renew: async (_owner, id, token) => current.jobs.some(job => job.id === id && job.status === 'running' && job.leaseToken === token),
    mutateLeased: async (_owner, id, token, mutation) => {
      if (!current.jobs.some(job => job.id === id && job.status === 'running' && job.leaseToken === token)) return null
      const draft = structuredClone(current); mutation(draft); current = draft; return structuredClone(current)
    },
  }
  return { store, job: structuredClone(job), state: () => current }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let fixture = fixtureJob()
await executeLeasedSwarmJob(fixture.store, 'owner-a', fixture.job, { execute: async input => {
  assert.equal(input.speaker, 'Rocky')
  await input.onProgress({ stage: 'writing', message: 'Writing the reply' })
  return { content: 'A real injected reply.', status: 'done', summary: 'Ready' }
} })
assert.equal(fixture.state().jobs[0].status, 'done')
assert.equal(fixture.state().state.turns[0].status, 'completed')
assert.equal(fixture.state().state.messages.at(-1).content, 'A real injected reply.')

fixture = fixtureJob()
const started = deferred(), late = deferred()
const running = executeLeasedSwarmJob(fixture.store, 'owner-a', fixture.job, { heartbeatMs: 5, execute: async () => { started.resolve(); await late.promise; return { content: 'Late result must not publish', status: 'done', summary: 'Ready' } } })
await started.promise
change(fixture.state(), { action: 'stop', projectId, thread: 'Rocky' }, 3000)
late.resolve(); await running
assert.equal(fixture.state().jobs[0].status, 'cancelled')
assert.equal(fixture.state().state.messages.length, 1)
assert.equal(fixture.state().state.turns[0].status, 'cancelled')

fixture = fixtureJob()
await executeLeasedSwarmJob(fixture.store, 'owner-a', fixture.job, { execute: async () => { throw new Error('provider secret must not be exposed') } })
assert.equal(fixture.state().jobs[0].status, 'failed')
assert.equal(fixture.state().state.turns[0].status, 'failed')
assert.doesNotMatch(JSON.stringify(fixture.state()), /provider secret/)
console.log('PASS Swarm actions, idempotency, owner references, private context, explicit sharing, retries, actual worker completion, cancellation fencing, and failure handling.')
