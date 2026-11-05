import assert from 'node:assert/strict'
import { DeviceRuntime } from './runtime.mjs'
import { startProxy } from '../browser-host/proxy.mjs'
import { validateAction, equal, webUrl } from './policy.mjs'

assert.equal(equal('a', 'b'), false)
assert.equal(equal('a', 'a'), true)
for (const url of ['http://127.0.0.1', 'file:///etc/passwd', 'https://localhost', 'https://x.local', 'http://[::1]']) assert.throws(() => webUrl(url))
assert.throws(() => validateAction({ type: 'evaluate', code: '1' }, 0, 0))
assert.throws(() => validateAction({ type: 'click', ref: 1 }, 1, 0))
assert.throws(() => validateAction({ type: 'click_at', x: -1, y: 2 }, 0, 0))
assert.throws(() => validateAction({ type: 'finish', summary: 'The Nalu engine is unavailable right now — try again.' }, 0, 0))
await import('./auth.integration.mjs')
await startProxy()
let calls = 0
const runtime = new DeviceRuntime({ decide: async (_owner, input) => {
  if (input.goal === 'queued smoke') return { thought: 'Queued browser started', action: { type: 'finish', summary: 'Queued browser started.' } }
  calls++
  assert.ok(input.screenshot.startsWith('data:image/jpeg;base64,'))
  const field = input.elements.find(e => e.tag === 'INPUT')
  if (field?.value !== 'Verified local work') return { thought: 'Fill title', action: { type: 'type', ref: field.ref, text: 'Verified local work' } }
  if (!input.text.includes('Saved: Verified local work')) return { thought: 'Save title', action: { type: 'click', ref: input.elements.find(e => e.text === 'Save').ref } }
  return { thought: 'Verified saved text', action: { type: 'finish', summary: 'Saved: Verified local work' } }
} })
const owner = 'test-' + Date.now()
try {
  await runtime.request(owner, 'workspace_open')
  await runtime.request(owner + '-other', 'workspace_open')
  const a = runtime.agent(owner), b = runtime.agent(owner + '-other')
  await a.page.setCookie({ name: 'isolation_test', value: 'owner-a', domain: 'example.com', path: '/', secure: true })
  assert.equal((await b.page.cookies('https://example.com')).some(c => c.name === 'isolation_test'), false)
  const queued = await runtime.request(owner, 'workspace_run', { agent_id: 'queued', task: 'queued smoke' })
  assert.equal(queued.status, 'queued')
  await runtime.request(owner + '-other', 'workspace_close')
  const queuedAgent = runtime.agent(owner, 'queued'), queueDeadline = Date.now() + 15000
  while (['queued', 'running'].includes(queuedAgent.status) && Date.now() < queueDeadline) await new Promise(r => setTimeout(r, 100))
  assert.equal(queuedAgent.status, 'done', queuedAgent.detail)
  await runtime.request(owner, 'workspace_close', { agent_id: 'queued' })

  await runtime.request(owner, 'workspace_open', { agent_id: 'second' })
  assert.equal((await runtime.agent(owner, 'second').page.cookies('https://example.com')).some(c => c.name === 'isolation_test'), false)
  await runtime.request(owner, 'workspace_close', { agent_id: 'second' })
  await a.page.setContent('<label>Title<input aria-label="Title"></label><button onclick="document.querySelector(\'p\').textContent=\'Saved: \'+document.querySelector(\'input\').value">Save</button><p></p>')
  await runtime.request(owner, 'workspace_run', { task: 'Set title to Verified local work and save.' })
  const until = Date.now() + 20000
  while (a.status === 'running' && Date.now() < until) await new Promise(r => setTimeout(r, 100))
  assert.equal(a.status, 'done', a.detail)
  assert.equal(calls, 3)
  assert.equal(await a.page.$eval('p', p => p.textContent), 'Saved: Verified local work')
  await runtime.request(owner, 'workspace_input', { kind: 'click', x: 100, y: 18 })
  await a.page.focus('input')
  await runtime.request(owner, 'workspace_input', { kind: 'key', key: 'Control+a' })
  await runtime.request(owner, 'workspace_input', { kind: 'text', text: 'Verified local work' })
  assert.equal(await a.page.$eval('input', e => e.value), 'Verified local work')
  const shot = await runtime.request(owner, 'workspace_screen'); assert.ok(shot.image.length > 1000)
  let release, observed
  const inference = new Promise(r => { observed = r })
  runtime.decide = async () => { observed(); return new Promise(r => { release = r }) }
  await runtime.request(owner, 'workspace_run', { task: 'Should stop before click.' })
  await inference
  await runtime.request(owner, 'workspace_takeover')
  release({ action: { type: 'type', ref: 0, text: 'SHOULD NOT TYPE' } })
  await new Promise(r => setTimeout(r, 200))
  assert.equal(await a.page.$eval('input', e => e.value), 'Verified local work')
  assert.equal(a.status, 'paused')
  await a.page.setContent('<input type="password"><button>Sign in</button>')
  await runtime.request(owner, 'workspace_run', { task: 'Open my account.' })
  while (a.status === 'running') await new Promise(r => setTimeout(r, 100))
  assert.equal(a.status, 'needs_help')
  assert.match(a.detail, /Sign in directly/)
  console.log('PASS: real Chromium typing/save, screenshot, account + agent cookie isolation, takeover during inference, login handoff, queued browser dispatch, keyboard chords, action validation. AI decisions were deterministic test inputs, not a live model.')
} finally { await runtime.disconnect() }
process.exit()
