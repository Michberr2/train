import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: "export * from './client/src/components/workspace/design/swarmClient'; export * from './client/src/components/workspace/design/swarmTransport'; export * from './client/src/components/workspace/design/swarmActivity'; export * from './client/src/components/workspace/design/workspaceActivity'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
const { SwarmClient, requestSwarm, isLiveSwarmState, SwarmSessionChanged, swarmActivity, withSwarmActivity, remoteActivity } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const account = { owner: 'account-one', token: 'token-one' }
const project = id => ({ id, title: id, brief: 'Project brief', members: ['Nalu', 'Rocky', 'Milo'], createdAt: 1, updatedAt: 1 })
const base = () => ({ version: 1, mode: 'live', projects: [project('launch'), project('travel')], messages: [], tasks: [], turns: [] })
const task = (id = 'task-one', extra = {}) => ({ id, projectId: 'launch', title: 'Review budget', assignee: 'Rocky', status: 'queued', summary: 'Ready', threads: ['Rocky'], updatedAt: 1, ...extra })
const response = (state, revision = 1, extra = {}) => new Response(JSON.stringify({ state, revision, ...extra }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const memory = () => { const data = new Map(); return { data, getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) } }
const sent = (state, body) => ({ ...state, messages: [...state.messages, { id: `user-${body.requestId}`, projectId: body.projectId, thread: body.thread, speaker: 'You', content: body.content, createdAt: 2 }], turns: [...state.turns, { id: `turn-${body.requestId}`, requestId: body.requestId, projectId: body.projectId, thread: body.thread, replySpeaker: body.thread === 'group' ? 'Nalu' : body.thread, userMessageId: `user-${body.requestId}`, replyId: `reply-${body.requestId}`, status: 'pending', createdAt: 2, updatedAt: 2 }] })
function setup(request, options = {}) {
  let sequence = 0
  return new SwarmClient({ account, readAccount: () => account, storage: memory(), uuid: () => `request-${++sequence}`, request, ...options })
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('transport uses explicit account authorization and rejects fixture/malformed state', async () => {
  let captured
  const result = await requestSwarm(account, { action: 'list' }, new AbortController().signal, () => account, async (url, options) => { captured = { url, options }; return response(base()) })
  assert.equal(captured.url, '/api/swarm')
  assert.equal(captured.options.headers.Authorization, 'Bearer token-one')
  assert.deepEqual(JSON.parse(captured.options.body), { action: 'list' })
  assert.equal(result.state.mode, 'live')
  assert.equal(isLiveSwarmState({ ...base(), mode: 'sample' }), false)
  assert.equal(isLiveSwarmState({ ...base(), tasks: [task('bad', { projectId: 'other-owner' })] }), false)
  assert.equal(isLiveSwarmState({ ...base(), messages: [{ id: 'bad', projectId: 'launch', thread: 'Rocky', speaker: 'Rocky', content: 'sample', createdAt: 2, sample: true }] }), false)
})

test('older poll responses cannot replace a newer mutation revision', async () => {
  const oldRead = deferred(); let reads = 0
  const state = base(), added = { ...state, tasks: [task()] }
  const client = setup(async (_url, options) => {
    const body = JSON.parse(options.body)
    return body.action === 'list' ? ++reads === 1 ? response(state, 1) : oldRead.promise : response(added, 3)
  })
  await client.refresh(); const polling = client.refresh(); await client.addTask('Review budget', 'Rocky')
  oldRead.resolve(response(state, 2)); await polling
  assert.equal(client.getSnapshot().revision, 3)
  assert.equal(client.getSnapshot().state.tasks.length, 1)
  client.dispose()
})

test('send retains draft until acknowledgement and preserves edits typed in flight', async () => {
  const reply = deferred(); let body
  const client = setup(async (_url, options) => { const input = JSON.parse(options.body); if (input.action === 'list') return response(base()); body = input; return reply.promise })
  await client.refresh(); client.navigate('launch', 'Rocky'); client.setDraft('Check the costs')
  const pending = client.send(); assert.equal(client.getSnapshot().preferences.drafts['launch::Rocky'], 'Check the costs')
  assert.deepEqual(client.getSnapshot().sendingRooms, ['launch::Rocky'])
  assert.equal(await client.send(), false, 'same-room send is fenced while acceptance is in flight')
  client.setDraft('A new draft while you work')
  reply.resolve(response(sent(base(), body), 2)); assert.equal(await pending, true)
  assert.equal(client.getSnapshot().preferences.drafts['launch::Rocky'], 'A new draft while you work')
  assert.deepEqual(client.getSnapshot().sendingRooms, [])
  client.dispose()
})

test('uncertain sends retry the same request ID, including after reload, without storing server state/token', async () => {
  const storage = memory(), bodies = []
  const request = async (_url, options) => { const body = JSON.parse(options.body); if (body.action === 'list') return response(base()); bodies.push(body); if (bodies.length === 1) throw new TypeError('lost connection'); return response(sent(base(), body), 2) }
  const first = setup(request, { storage }); await first.refresh(); first.navigate('launch', 'Milo'); first.setDraft('Keep this draft')
  assert.equal(await first.send(), false); assert.equal(first.getSnapshot().preferences.drafts['launch::Milo'], 'Keep this draft'); first.dispose()
  const reloaded = setup(request, { storage, uuid: () => 'should-not-be-used' }); await reloaded.refresh()
  assert.equal(await reloaded.send(), true)
  assert.equal(bodies[0].requestId, bodies[1].requestId)
  assert.equal(reloaded.getSnapshot().preferences.drafts['launch::Milo'], '')
  const stored = [...storage.data.values()].join('')
  assert.ok(!stored.includes('token-one')); assert.ok(!stored.includes('"messages"')); assert.ok(!stored.includes('"turns"'))
  reloaded.dispose()
})

test('a poll confirms only the exact request, project, room and submitted content', async () => {
  let body, state = base(), revision = 1
  const client = setup(async (_url, options) => { const input = JSON.parse(options.body); if (input.action === 'list') return response(state, revision); body = input; throw new TypeError('ack lost') })
  await client.refresh(); client.navigate('launch', 'Rocky'); client.setDraft('A private request'); await client.send()
  state = sent(base(), { ...body, projectId: 'travel' }); revision = 2; await client.refresh()
  assert.equal(client.getSnapshot().preferences.drafts['launch::Rocky'], 'A private request')
  state = sent(base(), body); revision = 3; await client.refresh()
  assert.equal(client.getSnapshot().preferences.drafts['launch::Rocky'], '')
  assert.equal(client.getSnapshot().preferences.intents.length, 0)
  client.dispose()
})

test('poll-confirmed acceptance survives failure of the original connection', async () => {
  const write = deferred(); let body, state = base(), revision = 1
  const client = setup(async (_url, options) => { const input = JSON.parse(options.body); if (input.action === 'list') return response(state, revision); body = input; return write.promise })
  await client.refresh(); client.setDraft('Hello team'); const send = client.send()
  state = sent(base(), body); revision = 2; await client.refresh(); write.reject(new TypeError('response lost'))
  assert.equal(await send, true); assert.equal(client.getSnapshot().error, ''); assert.equal(client.getSnapshot().preferences.drafts['launch::group'], '')
  client.dispose()
})

test('account changes abort requests and fence late responses, with owner-scoped preferences', async () => {
  const pending = deferred(), storage = memory(); let current = account, signal, calls = 0
  const client = setup(async (_url, options) => { calls++; if (calls === 1) return response(base()); signal = options.signal; return pending.promise }, { storage, readAccount: () => current })
  await client.refresh(); client.setDraft('Account one only'); const refresh = client.refresh()
  current = { owner: 'account-two', token: 'token-two' }; client.dispose(); assert.equal(signal.aborted, true)
  pending.resolve(response({ ...base(), projects: [project('late')] }, 99)); await refresh
  assert.equal(client.getSnapshot().revision, 1)
  const second = setup(async () => response(base()), { account: current, readAccount: () => current, storage })
  await second.refresh(); assert.deepEqual(second.getSnapshot().preferences.drafts, {})
  await assert.rejects(requestSwarm(account, { action: 'list' }, new AbortController().signal, () => current, async () => { throw Error('must not run') }), SwarmSessionChanged)
  second.dispose()
})

test('stop and task operations never claim a local completion or implicitly share private tasks', async () => {
  const state = { ...base(), tasks: [task()] }, calls = [], stopReply = deferred()
  const client = setup(async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body)
    if (body.action === 'stop-task') return stopReply.promise
    if (body.action === 'share-task') return response({ ...state, tasks: [task('task-one', { threads: ['Rocky', 'group'] })] }, 4)
    return response(state, 1)
  })
  await client.refresh(); client.navigate('launch', 'Rocky'); client.assignTask('task-one', 'Milo'); await tick()
  assert.deepEqual(client.getSnapshot().state.tasks[0].threads, ['Rocky'])
  assert.equal(calls.filter(call => call.action === 'share-task').length, 0)
  const stopped = client.stopTask('task-one'); assert.equal(client.getSnapshot().state.tasks[0].status, 'queued')
  stopReply.resolve(response({ ...state, tasks: [task('task-one', { status: 'cancelled' })] }, 3)); await stopped
  assert.equal(client.getSnapshot().state.tasks[0].status, 'cancelled')
  await client.shareTask('task-one'); assert.deepEqual(client.getSnapshot().state.tasks[0].threads, ['Rocky', 'group'])
  assert.equal(calls.filter(call => call.action === 'share-task').length, 1)
  client.dispose()
})

test('different project/private rooms can send concurrently without moving navigation or clearing other drafts', async () => {
  const writes = [], waits = []
  const client = setup(async (_url, options) => { const body = JSON.parse(options.body); if (body.action === 'list') return response(base()); const wait = deferred(); writes.push(body); waits.push(wait); return wait.promise })
  await client.refresh(); client.navigate('launch', 'Rocky'); client.setDraft('Launch budget'); const launch = client.send()
  client.navigate('travel', 'Milo'); client.setDraft('Travel dates'); const travel = client.send()
  waits[1].resolve(response(sent(base(), writes[1]), 3)); await travel
  waits[0].resolve(response(sent(base(), writes[0]), 2)); await launch
  assert.equal(client.getSnapshot().preferences.activeProjectId, 'travel'); assert.equal(client.getSnapshot().preferences.recipient, 'Milo')
  assert.equal(client.getSnapshot().preferences.drafts['launch::Rocky'], ''); assert.equal(client.getSnapshot().preferences.drafts['travel::Milo'], '')
  assert.equal(client.getSnapshot().revision, 3)
  client.dispose()
})

test('definitively rejected sends retain their draft but release the failed request receipt', async () => {
  const client = setup(async (_url, options) => JSON.parse(options.body).action === 'list' ? response(base()) : new Response(JSON.stringify({ error: 'Room no longer exists.' }), { status: 404 }))
  await client.refresh(); client.setDraft('Still editable'); assert.equal(await client.send(), false)
  assert.equal(client.getSnapshot().preferences.drafts['launch::group'], 'Still editable'); assert.equal(client.getSnapshot().preferences.intents.length, 0)
  assert.match(client.getSnapshot().error, /Room no longer exists/); client.dispose()
})

test('a lost add-task confirmation reconciles by exact receipt and its form retry cannot add twice', async () => {
  let state = base(), revision = 1, submitted, writes = 0
  const client = setup(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'list') return response(state, revision)
    writes++; submitted = body; throw new TypeError('acknowledgement lost')
  })
  await client.refresh(); client.navigate('launch', 'Rocky')
  await assert.rejects(client.addTask('Review budget', 'Rocky'))
  assert.equal(client.hasPendingRequests(), true, 'uncertain intent keeps polling active')
  state = { ...base(), tasks: [task('foreign', { requestId: submitted.requestId, projectId: 'travel' })] }; revision++
  await client.refresh(); assert.equal(client.getSnapshot().preferences.intents.length, 1)
  state = { ...base(), tasks: [task('accepted', { requestId: submitted.requestId })] }; revision++
  await client.refresh(); assert.equal(client.getSnapshot().preferences.intents.length, 0); assert.equal(client.hasPendingRequests(), false)
  await client.addTask('Review budget', 'Rocky'); assert.equal(writes, 1, 'the still-open form consumes its confirmed retry receipt')
  client.dispose()
})

test('a lost start confirmation keeps its original ID through new execution state and exact poll acknowledgement', async () => {
  let state = { ...base(), tasks: [task()] }, revision = 1
  const writes = []
  const client = setup(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'list') return response(state, revision)
    writes.push(body); throw new TypeError('acknowledgement lost')
  })
  await client.refresh(); await assert.rejects(client.startTask('task-one'))
  assert.equal(client.hasPendingRequests(), true)
  state = { ...base(), tasks: [task('task-one', { status: 'running', executionId: 'execution-new', executionRequestId: 'other-request' })] }; revision++
  await client.refresh(); await assert.rejects(client.startTask('task-one'))
  assert.equal(writes[0].requestId, writes[1].requestId, 'changed execution ID does not generate a second request')
  assert.equal(client.getSnapshot().preferences.intents.length, 1)
  state.tasks[0].executionRequestId = writes[0].requestId; revision++
  await client.refresh(); assert.equal(client.getSnapshot().preferences.intents.length, 0)
  assert.equal(client.hasPendingRequests(), false)
  client.dispose()
})

test('a cleanup/remount fences earlier requests even when the same account resumes', async () => {
  const old = deferred(); let calls = 0
  const client = setup(async () => ++calls === 1 ? old.promise : response(base(), 2))
  const first = client.refresh(); client.dispose(); client.start(); await client.refresh()
  old.resolve(response({ ...base(), projects: [project('obsolete')] }, 99)); await first
  assert.equal(client.getSnapshot().revision, 2)
  assert.equal(client.getSnapshot().state.projects[0].id, 'launch')
  client.dispose()
})

test('owner activity uses real assigned identities and original rooms without exposing transcript text or inventing chat IDs', () => {
  const input = { projectId: 'launch', thread: 'Rocky', content: 'Private transcript must stay inside its chat', requestId: 'private-turn' }
  const state = sent({ ...base(), tasks: [task('reassigned', { assignee: 'Milo', threads: ['Rocky', 'group'], progress: .4, status: 'running' }), task('paused', { status: 'paused', projectId: 'travel' })] }, input)
  const items = swarmActivity(state)
  assert.equal(items.length, 3)
  const assigned = items.find(item => item.id === 'swarm:task:reassigned')
  assert.deepEqual(assigned.swarm, { projectId: 'launch', projectTitle: 'launch', thread: 'Rocky', agent: 'Milo', taskId: 'reassigned' })
  assert.equal(assigned.progress, .4)
  assert.equal(items.find(item => item.id === 'swarm:task:paused').status, 'paused')
  const replying = items.find(item => item.id.startsWith('swarm:turn:'))
  assert.equal(replying.swarm.agent, 'Rocky'); assert.equal(replying.swarm.thread, 'Rocky'); assert.equal(replying.status, 'running')
  assert.ok(items.every(item => item.chatId === undefined && item.preview === false))
  assert.ok(!JSON.stringify(items).includes(input.content), 'global activity never copies private transcript content')
  assert.deepEqual(swarmActivity({ ...state, mode: 'sample' }), [], 'live overview cannot import fixture activity')
  const cli = remoteActivity([{ id: 'cli-work', title: 'CLI work', status: 'running', swarm: { agent: 'Milo' }, source: 'cli' }], [])
  assert.equal(cli[0].swarm, undefined, 'ledger metadata cannot impersonate a Swarm member')
  const merged = withSwarmActivity({ items: cli, isSample: false, error: '', refresh() {} }, state)
  assert.equal(merged.items.filter(item => item.id === 'cli-work').length, 1)
  assert.equal(merged.items.find(item => item.id === 'cli-work').swarm, undefined)
  assert.equal(state.tasks[0].threads[0], 'Rocky', 'overview does not alter private board membership')
})

test('invalid Swarm activity links are omitted and reply progress is never fabricated', () => {
  const state = sent({ ...base(), tasks: [task('missing-links', { threads: undefined }), task('wrong-project', { projectId: 'not-owned' })] }, { projectId: 'travel', thread: 'group', content: 'Hello group', requestId: 'group-turn' })
  const items = swarmActivity(state)
  assert.equal(items.length, 1)
  assert.equal(items[0].swarm.projectId, 'travel'); assert.equal(items[0].swarm.thread, 'group')
  assert.equal(items[0].progress, undefined)
})

test('live task instructions preserve their full text and reject excess text instead of silently truncating it', async () => {
  const writes = []
  const client = setup(async (_url, options) => { const body = JSON.parse(options.body); if (body.action !== 'list') writes.push(body); return response(base()) })
  await client.refresh()
  const instructions = `Review each cost in the budget.\n${'Include the source and assumptions. '.repeat(20)}`
  await client.addTask(instructions, 'Rocky')
  assert.equal(writes[0].title, instructions.trim()); assert.ok(writes[0].title.length > 180)
  await assert.rejects(client.addTask('x'.repeat(2001), 'Rocky'), /2,000 characters/)
  assert.equal(writes.length, 1); client.dispose()
})
