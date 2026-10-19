// Actual extension service worker with a deterministic Chrome adapter.
// No browser/account/network access; page-side DOM tests live separately.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
const source = fs.readFileSync('nalu-for-chrome/background.js', 'utf8')
const event = () => ({ addListener() {}, removeListener() {} })
const panelUrl = 'chrome-extension://fixture/sidepanel.html'
let checks = 0

function harness(options = {}) {
  const state = {
    tabs: [{ id: 11, windowId: 1, index: 0, active: true, url: 'https://mail.example.test/compose', title: 'Compose' }, { id: 22, windowId: 1, index: 1, active: false, url: 'https://docs.example.test/report', title: 'Report' }],
    documents: new Map([[11, 'doc-a'], [22, 'doc-b']]), panels: [], executions: [], mutations: [], calls: [], approvals: [],
  }
  let receiver
  const target = options.target || { ref: 1, tag: 'textarea', text: 'Message', inputType: 'textarea', form: { search: false, text: 'Send message' } }
  const snap = tab => ({ ok: true, url: tab.url, documentKey: state.documents.get(tab.id) + '-key', snapshotKey: 'snapshot', elements: [target], text: 'Compose and send a message.', viewport: { w: 1000, h: 800 } })
  const send = message => receiver(message, { url: panelUrl }, () => {})
  const chrome = {
    runtime: {
      onInstalled: event(), onMessage: { addListener(value) { receiver = value } }, getURL: path => 'chrome-extension://fixture/' + path,
      async sendMessage(message) {
        state.panels.push(message)
        if (message.ev === 'confirm') {
          state.approvals.push(message.data)
          await options.onApproval?.(state, message.data, send)
          if (options.approve !== false) send({ type: 'approve', id: message.data.id, ok: true })
          else send({ type: 'approve', id: message.data.id, ok: false })
        }
        if (message.ev === 'ask' && options.stopOnAsk) send({ type: 'stop' })
      },
    },
    action: { onClicked: event() }, sidePanel: {}, alarms: { onAlarm: event(), clear() {} },
    tabs: {
      onActivated: event(), onUpdated: event(),
      async query(query) { return state.tabs.filter(tab => !query.active || tab.active).map(tab => ({ ...tab })) },
      async get(id) { return { ...state.tabs.find(tab => tab.id === id) } },
      async captureVisibleTab() { return 'data:image/jpeg;base64,fixture' },
      async sendMessage(id, message, binding) {
        const tab = state.tabs.find(tab => tab.id === id)
        if (message.type === 'ping') return { ok: true, protocol: 2 }
        assert.equal(binding.documentId, state.documents.get(id), 'messages must address the observed Chrome document')
        if (message.type === 'snapshot') return snap(tab)
        assert.equal(message.expected.url, tab.url)
        assert.equal(message.expected.documentKey, state.documents.get(id) + '-key')
        if (message.type === 'validate') return { ok: true }
        if (message.type === 'prepare') return { ok: true, reviewId: 'prepared-action', target }
        if (message.type === 'act') {
          assert.equal(message.reviewId, 'prepared-action')
          state.executions.push({ id, message, binding })
          return { ok: true, detail: 'Executed fixture action.' }
        }
        throw new Error('Unexpected message ' + message.type)
      },
      async update(id, change) { state.mutations.push({ type: 'update', id, change }); if (change.active) state.tabs.forEach(tab => { tab.active = tab.id === id }); return state.tabs.find(tab => tab.id === id) },
      async create(change) { state.mutations.push({ type: 'create', change }); return { id: 33 } },
      async remove(id) { state.mutations.push({ type: 'remove', id }) },
    },
    scripting: { async executeScript({ target: { tabId } }) { return [{ frameId: 0, documentId: state.documents.get(tabId), result: state.tabs.find(tab => tab.id === tabId).url }] } },
  }
  const actions = [...(options.actions || [{ type: 'type', ref: 1, text: 'Hello', submit: true }]), { type: 'finish', summary: 'Finished fixture.' }]
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, AbortController, AbortSignal, console,
    setTimeout(callback) { queueMicrotask(callback); return 1 }, clearTimeout() {},
    async fetch(_url, init) {
      state.calls.push(JSON.parse(init.body))
      if (state.calls.length === 1) await options.afterModel?.(state, send)
      return Response.json({ action: actions.shift() || { type: 'finish' } })
    },
  })
  vm.runInContext(source + '\nglobalThis.fixture = { runAgent, needsConfirm };', context)
  return { state, send, run: unattended => context.fixture.runAgent('Complete the fixture task.', unattended), needsConfirm: context.fixture.needsConfirm }
}

for (const action of [
  { type: 'type', ref: 1, text: 'Hello', submit: true },
  { type: 'click_at', x: 120, y: 80 },
  { type: 'click', ref: 1 },
]) {
  const test = harness({ actions: [action] })
  await test.run(false)
  assert.equal(test.state.approvals.length, 1)
  assert.equal(test.state.executions.length, 1)
  assert.equal(test.state.executions[0].id, 11)
  checks++
  const scheduled = harness({ actions: [action] })
  await scheduled.run(true)
  assert.equal(scheduled.state.approvals.length, 0)
  assert.equal(scheduled.state.executions.length, 0)
  assert.match(JSON.stringify(scheduled.state.calls[1].history), /not auto-approved/)
  checks++
}

for (const change of ['active-tab', 'URL', 'same-URL-new-document']) {
  for (const stage of ['model', 'approval']) {
    const mutate = state => {
      if (change === 'active-tab') state.tabs.forEach(tab => { tab.active = tab.id === 22 })
      if (change === 'URL') state.tabs[0].url = 'https://mail.example.test/different'
      if (change === 'same-URL-new-document') state.documents.set(11, 'new-document')
    }
    const test = harness(stage === 'model' ? { afterModel: mutate } : { onApproval: mutate })
    await test.run(false)
    assert.equal(test.state.executions.length, 0, `${change} after ${stage} must invalidate action`)
    assert.equal(test.state.mutations.length, 0)
    assert.ok(test.state.panels.some(message => message.ev === 'error'))
    checks++
  }
}

let test = harness({ onApproval(state, approval, send) {
  assert.equal(state.executions.length, 0)
  send({ type: 'approve', id: 'old-prompt-id', ok: true })
  assert.equal(state.executions.length, 0)
  assert.ok(approval.id && approval.url && approval.action.text === 'Hello')
} })
await test.run(false); assert.equal(test.state.executions.length, 1); checks++
test = harness({ approve: false })
await test.run(false); assert.equal(test.state.executions.length, 0); checks++
test = harness({ onApproval(_state, _approval, send) { send({ type: 'stop' }) } })
await test.run(false); assert.equal(test.state.executions.length, 0); checks++
test = harness({ actions: [{ type: 'ask', question: 'Which account?' }], stopOnAsk: true })
await test.run(false); assert.equal(test.state.executions.length, 0); checks++
test = harness({ actions: [{ type: 'ask', question: 'Which account?' }] })
await test.run(true); assert.ok(test.state.panels.some(message => message.ev === 'error' && /user input/.test(message.data.message))); checks++
test = harness({ actions: [{ type: 'navigate', url: 'javascript:alert(1)' }] })
await test.run(false); assert.equal(test.state.mutations.length, 0); checks++
test = harness({ actions: [{ type: 'switchtab', index: 1 }], afterModel(state) { state.tabs[1].index = 2; state.tabs.push({ id: 44, windowId: 1, index: 1, active: false, url: 'https://wrong.example.test' }) } })
await test.run(false); assert.equal(test.state.mutations[0].id, 22, 'tab selection binds observed ID, not a reordered index'); checks++
test = harness({ target: { ref: 1, tag: 'input', text: 'Search', form: { search: true, text: 'Search articles' } } })
await test.run(false); assert.equal(test.state.approvals.length, 0); assert.equal(test.state.executions.length, 1); checks++
test = harness({ actions: [{ type: 'click', ref: 1 }], target: { ref: 1, tag: 'button', text: 'Continue' } })
await test.run(false); assert.equal(test.state.approvals.length, 1); assert.equal(test.state.executions.length, 1); checks++
console.log(`PASS ${checks} Chrome action groups: ordinary text submission, coordinate clicks, scheduled rejection, model/approval tab and document races, approval IDs, stop, HTTP navigation, and reordered tabs`)
