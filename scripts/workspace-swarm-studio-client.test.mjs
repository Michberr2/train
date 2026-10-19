import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: "export * from './client/src/components/workspace/design/swarmClient'; export * from './client/src/components/workspace/design/swarmTransport'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
const { SwarmClient, requestSwarmMedia, SwarmSessionChanged } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const account = { owner: 'owner-one', token: 'token-one' }
const task = (extra = {}) => ({ id: 'draft', projectId: 'launch', title: 'Launch brief', assignee: 'Milo', status: 'waiting', summary: 'Needs Studio', threads: ['Milo'], updatedAt: 1, executionId: 'source-job', handoff: { studioKind: 'document', prompt: 'Write a launch brief', reason: 'Document needed' }, ...extra })
const state = (tasks = [task()]) => ({ version: 1, mode: 'live', projects: [{ id: 'launch', title: 'Launch', brief: 'Project brief', members: ['Nalu', 'Rocky', 'Milo'], createdAt: 1, updatedAt: 1 }], tasks, messages: [], turns: [] })
const artifact = (payload = { title: 'Launch brief', blocks: [{ type: 'p', text: 'Owner-scoped draft' }] }, studioKind = 'document') => ({ type: 'studio-artifact', studioKind, payload, status: 'done', summary: 'Saved with task' })
const savedTask = (revision = 1) => task({ status: 'done', handoff: undefined, executionId: 'studio-job', artifact: { executionId: 'studio-job', studioKind: 'document', revision } })
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const make = request => new SwarmClient({ account, readAccount: () => account, request, uuid: () => 'stable-id' })

test('Studio continuation sends the exact waiting source and reconciles lost acceptance without inventing completion', async () => {
  let current = state(), revision = 1, body
  const client = make(async (_url, options) => {
    const request = JSON.parse(options.body)
    if (request.action === 'list') return json({ state: current, revision })
    body = request; throw new TypeError('acceptance response lost')
  })
  await client.refresh(); client.navigate('launch', 'Milo')
  await assert.rejects(client.continueStudio('draft'))
  assert.deepEqual(body, { action: 'continue-studio', projectId: 'launch', taskId: 'draft', sourceJobId: 'source-job', requestId: 'stable-id' })
  assert.equal(client.getSnapshot().state.tasks[0].status, 'waiting')
  assert.equal(client.hasPendingRequests(), true)
  current = state([task({ status: 'queued', executionId: 'studio-job', executionRequestId: body.requestId })]); revision++
  await client.refresh(); assert.equal(client.hasPendingRequests(), false)
  assert.equal(client.getSnapshot().state.tasks[0].status, 'queued')
  client.dispose()
})

test('artifact reads require the current explicit room and exact execution; stale poll results cannot replace newer saved work', async () => {
  let current = state([savedTask()]), revision = 1, body
  const waiting = deferred()
  const client = make(async (_url, options) => { body = JSON.parse(options.body); return body.action === 'list' ? json({ state: current, revision }) : waiting.promise })
  await client.refresh()
  await assert.rejects(client.getArtifact('draft', 'studio-job'), /selected conversation/)
  client.navigate('launch', 'Milo')
  await assert.rejects(client.getArtifact('draft', 'foreign-job'), /changed/)
  const read = client.getArtifact('draft', 'studio-job')
  assert.deepEqual(body, { action: 'artifact', projectId: 'launch', taskId: 'draft', executionId: 'studio-job' })
  current = state([savedTask(2)]); revision++; await client.refresh()
  waiting.resolve(json({ artifact: artifact(), revision: 1 }))
  await assert.rejects(read, /newer creation/)
  client.dispose()
})

test('account changes and disposal abort artifact reads and reject late private results', async () => {
  let current = account, signal
  const waiting = deferred()
  const client = new SwarmClient({ account, readAccount: () => current, request: async (_url, options) => {
    if (JSON.parse(options.body).action === 'list') return json({ state: state([savedTask()]), revision: 1 })
    signal = options.signal; return waiting.promise
  } })
  await client.refresh(); client.navigate('launch', 'Milo'); const read = client.getArtifact('draft', 'studio-job')
  current = { owner: 'owner-two', token: 'token-two' }; client.dispose()
  assert.equal(signal.aborted, true)
  waiting.resolve(json({ artifact: artifact(), revision: 1 }))
  await assert.rejects(read, SwarmSessionChanged)
})

test('artifact saves include full payload and artifact revision, preserve metadata and refuse stale revisions', async () => {
  let current = state([savedTask()]), revision = 1, submitted
  const client = make(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'update-artifact') { submitted = body; current = state([savedTask(2)]); revision++ }
    return json({ state: current, revision })
  })
  await client.refresh(); client.navigate('launch', 'Milo')
  const payload = { ...artifact().payload, title: 'Edited title', diagnostics: { preserved: true } }
  assert.equal(await client.updateArtifact('draft', 'studio-job', 1, payload), 2)
  assert.deepEqual(submitted, { action: 'update-artifact', projectId: 'launch', taskId: 'draft', executionId: 'studio-job', revision: 1, payload })
  await assert.rejects(client.updateArtifact('draft', 'studio-job', 1, payload), /newer saved/)
  assert.equal(client.getSnapshot().state.tasks[0].chatId, undefined)
  client.dispose()
})

test('lost save confirmation only succeeds when exact scoped payload is read back at a newer artifact revision', async () => {
  let payload = artifact().payload, saved = false
  const client = make(async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'list') return json({ state: state([savedTask(saved ? 2 : 1)]), revision: saved ? 2 : 1 })
    if (body.action === 'update-artifact') { payload = body.payload; saved = true; throw new TypeError('lost response') }
    return json({ artifact: artifact(payload), revision: 2 })
  })
  await client.refresh(); client.navigate('launch', 'Milo')
  assert.equal(await client.updateArtifact('draft', 'studio-job', 1, { ...payload, title: 'Saved despite lost response' }), 2)
  client.dispose()
})

test('media chunks use bearer headers, verify hashes, reject corruption and honor abort/account changes', async () => {
  const bytes = Buffer.from('saved image bytes'), hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  const media = { attachmentId: `att_${'a'.repeat(64)}`, filename: 'creation.png', mime: 'image/png', size: bytes.length, parts: 1, sha256: hash }
  const calls = [], request = async (url, options) => { calls.push({ url, options }); return json({ base64: bytes.toString('base64') }) }
  const result = await requestSwarmMedia(account, media, new AbortController().signal, () => account, request)
  assert.equal(await result.text(), bytes.toString()); assert.equal(result.type, 'image/png')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-one'); assert.ok(!calls[0].url.includes('token'))
  await assert.rejects(requestSwarmMedia(account, { ...media, sha256: 'b'.repeat(64) }, new AbortController().signal, () => account, request), /integrity/)
  let current = account
  await assert.rejects(requestSwarmMedia(account, media, new AbortController().signal, () => current, async () => { current = { owner: 'other', token: 'other' }; return json({ base64: bytes.toString('base64') }) }), SwarmSessionChanged)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(requestSwarmMedia(account, media, cancelled.signal, () => account, request), { name: 'AbortError' })
})

test('long-form book handoffs remain waiting without dispatching unsupported background work', async () => {
  const calls = []
  const client = make(async (_url, options) => { const body = JSON.parse(options.body); calls.push(body); return json({ state: state([task({ handoff: { studioKind: 'book', prompt: 'Create a book', reason: 'Long-form coordinator required' } })]), revision: 1 }) })
  await client.refresh(); client.navigate('launch', 'Milo')
  await assert.rejects(client.continueStudio('draft'), /Background book generation is not available/)
  assert.equal(calls.length, 1)
  assert.equal(client.getSnapshot().state.tasks[0].status, 'waiting')
  client.dispose()
})
