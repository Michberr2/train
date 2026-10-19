// Offline scheduler regressions: exercise the public runners with an in-memory DB.
// No accounts, network calls, or deliveries. Run: node scripts/cron-regressions.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const bundled = await build({
  entryPoints: ['api/_cron.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'offline-model', setup(build) {
    build.onResolve({filter:/^\.\/connect$/},()=>({path:'connect',namespace:'delivery-fixture'}))
    build.onLoad({filter:/.*/,namespace:'delivery-fixture'},()=>({contents:'export async function sendPipelineOutput(){throw new Error("Unexpected delivery in offline test")}',loader:'js'}))
    build.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'model', namespace: 'offline' }))
    build.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: 'export async function chatComplete(...args) { if (globalThis.__cronModel) return globalThis.__cronModel(...args); throw new Error("Unexpected model call in offline test") }', loader: 'js' }))
    build.onResolve({filter:/^\.\/_grounding$/},()=>({path:'research',namespace:'research-fixture'}))
    build.onLoad({filter:/.*/,namespace:'research-fixture'},()=>({contents:'export async function groundFromPrompt(prompt){return globalThis.__cronResearch ? globalThis.__cronResearch(prompt) : ""}',loader:'js'}))
  } }],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { runDueCrons, runOneFlow, runFlowByHook } = module.exports

function database(flow) {
  let flows = [structuredClone(flow)]
  const events = []
  const tasks = new Map()
  return {
    get flow() { return structuredClone(flows[0]) },
    set flow(value) { flows = [structuredClone(value)] },
    events, tasks,
    async query(sql, params = []) {
      if (sql.trim().startsWith('WITH settled AS')) return { rows: [] } // no remote dispatch jobs in this fixture
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      if (/SELECT .*value FROM nalu_user_data/.test(sql)) return { rows: [{ user_id: 'test-user', value: JSON.stringify(flows) }] }
      if (/^(INSERT INTO|UPDATE) nalu_user_data/.test(sql.trim())) flows = JSON.parse(params[1])
      if (sql.trim().startsWith('UPDATE nalu_tasks SET meta=')) {
        assert.equal(params[0], 'test-user')
        assert.ok(tasks.has(params[1]), 'results update must target the existing task')
        assert.ok(JSON.parse(params[2]).results)
        return { rows: [] }
      }
      if (sql.includes('nalu_tasks')) {
        events.push(params)
        if (sql.trim().startsWith('UPDATE')) tasks.set(params[0], params[1])
        else tasks.set(params[0], params[5] || 'running')
      }
      return { rows: [] }
    },
  }
}
const base = {
  id: 'approval-flow', name: 'Review output', schedule: 'hourly', enabled: true, apiEnabled: true, apiSecret: 'offline-test',
  nodes: [
    { id: 'input', type: 'trigger', prompt: 'original input' },
    { id: 'gate', type: 'approval', label: 'Review this input' },
    { id: 'after', type: 'memory', memKey: 'approved' },
  ], edges: [{ from: 'input', to: 'gate' }, { from: 'gate', to: 'after' }],
  approvals: { gate: { decision: 'approve', at: 1 } },
  results: { input: 'old run', gate: 'old approval', after: 'old downstream output' },
  run: { status: 'done' },
}

const scheduled = database(base)
assert.equal((await runDueCrons(scheduled)).flowsRan, 1)
assert.equal(scheduled.flow.run.status, 'awaiting')
assert.equal(scheduled.flow.run.node, 'gate')
assert.equal(scheduled.flow.results.input, 'original input')
assert.equal(scheduled.flow.results.after, undefined, 'stale results must not appear in a new run')
assert.equal(scheduled.flow.memory.approved, undefined, 'approval gates must stop downstream mutations')
assert.ok([...scheduled.tasks.values()].includes('waiting'), 'ledger must show waiting, not done')
scheduled.flow = { ...scheduled.flow, lastRun: 0 }
assert.equal((await runDueCrons(scheduled)).flowsRan, 0, 'the next cron must leave pending approvals parked')

for (const decision of ['approve', 'edit', 'reject']) {
  const db = database({ ...scheduled.flow, approvals: { gate: { decision, text: 'reviewed input', at: Date.now() } } })
  const resumed = await runOneFlow(db, 'test-user', base.id, 'resume')
  assert.equal(resumed.status, 'done')
  if (decision === 'reject') {
    assert.equal(db.flow.results.after, undefined)
    assert.equal(db.flow.memory.approved, undefined)
    assert.ok(db.flow.run.cutEdges.includes('gate>after'))
  } else assert.equal(db.flow.memory.approved, decision === 'edit' ? 'reviewed input' : 'original input')
}

const manual = database(base)
assert.equal((await runOneFlow(manual, 'test-user', base.id, 'run')).status, 'awaiting')
assert.deepEqual(manual.flow.approvals, {}, 'Run again must request a new decision')
const hook = database(base)
const hookResult = await runFlowByHook(hook, base.id, 'offline-test', 'new webhook input')
assert.equal(hookResult.status, 202)
assert.match(hookResult.output, /Waiting for your approval/)
assert.equal(hook.flow.results.input, 'new webhook input')
assert.equal(hook.flow.results.after, undefined)
assert.equal(hook.flow.run.node, 'gate')
const failedHook = database({ ...base, nodes: [{ id: 'invalid-url', type: 'fetchurl', prompt: 'no URL supplied' }], edges: [] })
const failedHookResult = await runFlowByHook(failedHook, base.id, 'offline-test', '')
assert.equal(failedHookResult.ok, false, 'a failed node without an exception must not produce a successful webhook response')
assert.equal(failedHookResult.status, 500)
const browserOutput = database({
  ...base, nodes: [{ id: 'file', type: 'pdf', label: 'Save file' }, { id: 'agent', type: 'agent' }],
  edges: [{ from: 'file', to: 'agent' }],
})
const browserResult = await runFlowByHook(browserOutput, base.id, 'offline-test', '')
assert.equal(browserResult.ok, false, 'an unexecuted browser-only output must not count as done')
assert.equal(browserOutput.flow.run.status, 'stuck')
assert.match(browserResult.error, /workspace open/)
assert.equal(browserOutput.flow.results.agent, undefined, 'dependent agents must not run on missing file output')
assert.equal(browserOutput.flow.nodes.find((node) => node.id === 'agent').lastRunDay, undefined, 'blocked agents must remain eligible for the member scheduler')

// Resume must retain a router's earlier cut; the unchosen branch stays untouched.
const branched = database({
  ...scheduled.flow, approvals: { gate: { decision: 'approve', at: Date.now() } },
  nodes: [...base.nodes, { id: 'untaken', type: 'memory', memKey: 'wrong' }],
  edges: [...base.edges, { from: 'input', to: 'untaken' }],
  run: { ...scheduled.flow.run, cutEdges: ['input>untaken'] },
})
await runOneFlow(branched, 'test-user', base.id, 'resume')
assert.equal(branched.flow.memory.wrong, undefined)
assert.ok(branched.flow.run.cutEdges.includes('input>untaken'))

const waitingTask = [...scheduled.tasks.keys()][0]
const originalStart = scheduled.flow.run.startedAt
scheduled.flow = { ...scheduled.flow, approvals: { gate: { decision: 'approve', at: Date.now() } } }
await runOneFlow(scheduled, 'test-user', base.id, 'resume')
assert.equal(scheduled.tasks.get(waitingTask), 'done', 'resume must settle the original waiting task')
assert.equal(scheduled.tasks.size, 1, 'a resumed run must not create a second task')
assert.equal(scheduled.flow.run.startedAt, originalStart)

const checkpoint = database({
  ...base, results: { input: 'restored input' },
  nodes: [...base.nodes, { id: 'agent', type: 'agent' }, { id: 'untaken', type: 'memory', memKey: 'wrong' }],
  edges: [...base.edges, { from: 'after', to: 'agent' }, { from: 'input', to: 'untaken' }],
  run: { status: 'awaiting', startedAt: 1000, node: 'gate', cutEdges: ['input>untaken'] },
})
globalThis.__cronModel = () => {
  assert.ok(checkpoint.flow.run.cutEdges.includes('input>untaken'), 'progress must save branch cuts before a slow model call')
  assert.equal(checkpoint.flow.memory.approved, 'restored input', 'progress must save new memory before a slow model call')
  return 'completed model output'
}
try { await runOneFlow(checkpoint, 'test-user', base.id, 'resume') }
finally { delete globalThis.__cronModel }
assert.equal(checkpoint.flow.results.agent, 'completed model output')
assert.equal(checkpoint.flow.nodes.find((node) => node.id === 'agent').lastRunDay, new Date().toDateString())
console.log('PASS: scheduled/manual/webhook approval pause, fresh decisions, approve/edit/reject resume, checkpoint cuts/memory and single task lifecycle')

for (const enabled of [true, false]) {
  const queries = [], messages = []
  globalThis.__cronResearch = prompt => { queries.push(prompt); return 'READ SOURCE: https://agency.gov/report; measured 42, publication date unknown.' }
  globalThis.__cronModel = input => { messages.push(input); return 'The current result is qualified and sourced.' }
  const db = database({ ...base, nodes: [{id:'input',type:'trigger',prompt:'PRIVATE CONTRACT 9184'}, {id:'research',type:'agent',prompt:'Summarize the current market. {{input}}',webSearch:enabled}], edges:[{from:'input',to:'research'}] })
  assert.equal((await runOneFlow(db,'test-user',base.id,'run')).status,'done')
  assert.deepEqual(queries, enabled ? ['Summarize the current market.'] : [])
  assert.equal(messages[0][0].content.includes('READ SOURCE:'),enabled)
  assert.match(messages[0][0].content,/PRIVATE CONTRACT 9184/,'the model still receives the authorized input')
}
delete globalThis.__cronResearch; delete globalThis.__cronModel
console.log('PASS scheduled agents research current task instructions, preserve private inputs for the model only, and honor web opt-out.')

// AI decisions govern real downstream actions. A provider outage, malformed
// answer or ambiguous branch must settle as an error without executing children.
for (const type of ['filter', 'router']) {
  for (const answer of [null, '', 'yes and no', 'Approved or Rejected']) {
    globalThis.__cronModel = async () => { if (answer === null) throw new Error('provider unavailable'); return answer }
    const gate = { id: 'gate', type, condMode: 'ai', routeBy: 'ai', branches: [{label:'Approved'}, {label:'Rejected'}] }
    const db = database({ ...base, nodes: [{id:'input',type:'trigger',prompt:'unverified'},gate,{id:'after',type:'memory',memKey:'changed'}], edges:[{from:'input',to:'gate'},{from:'gate',to:'after',label:'Approved'}] })
    const result = await runOneFlow(db, 'test-user', base.id, 'run')
    assert.equal(result.status, 'failed', `${type} must reject ${answer}`)
    assert.equal(db.flow.run.status, 'error', 'the saved flow must retain the failed decision')
    assert.equal(db.flow.memory?.changed, undefined)
    assert.equal(db.flow.results.after, undefined)
    assert.equal(db.flow.results.gate, undefined)
  }
  for (const accepted of [true, false]) {
    globalThis.__cronModel = async () => type === 'filter' ? (accepted ? 'yes' : 'no') : (accepted ? 'Approved' : 'Rejected')
    const db = database({ ...base, nodes: [{id:'input',type:'trigger',prompt:'verified'}, {id:'gate',type,condMode:'ai',routeBy:'ai',branches:[{label:'Approved'},{label:'Rejected'}]}, {id:'after',type:'memory',memKey:'changed'}], edges:[{from:'input',to:'gate'},{from:'gate',to:'after',label:'Approved'}] })
    assert.equal((await runOneFlow(db,'test-user',base.id,'run')).status,'done')
    assert.equal(db.flow.memory?.changed,accepted ? 'verified' : undefined)
  }
}
delete globalThis.__cronModel
console.log('PASS 12 AI decision cases: failures stop downstream work; valid yes/no and exact branches retain intended behavior.')

for (const type of ['planner', 'foreach']) {
  for (const answer of [null, '', '{"action":"finish","answer":""}', '{"action":"search","query":']) {
    if (type === 'foreach' && typeof answer === 'string' && answer.length) continue
    globalThis.__cronModel = async () => { if (answer === null) throw new Error('provider unavailable'); return answer }
    const db = database({ ...base, nodes:[{id:'input',type:'trigger',prompt:'item one\nitem two'},{id:'work',type,webSearch:false},{id:'after',type:'memory',memKey:'delivered'}], edges:[{from:'input',to:'work'},{from:'work',to:'after'}] })
    assert.equal((await runOneFlow(db,'test-user',base.id,'run')).status,'failed',`${type}: failed/empty work must not succeed`)
    assert.equal(db.flow.results.work,undefined)
    assert.equal(db.flow.memory?.delivered,undefined)
  }
  globalThis.__cronModel = () => type === 'planner' ? '{"action":"finish","answer":"Verified deliverable"}' : 'Processed item'
  const db = database({ ...base, nodes:[{id:'input',type:'trigger',prompt:'item one\nitem two'},{id:'work',type,webSearch:false},{id:'after',type:'memory',memKey:'delivered'}], edges:[{from:'input',to:'work'},{from:'work',to:'after'}] })
  assert.equal((await runOneFlow(db,'test-user',base.id,'run')).status,'done')
  assert.match(db.flow.memory.delivered,type === 'planner' ? /Verified deliverable/ : /Processed item/)
}
delete globalThis.__cronModel
console.log('PASS planner/foreach failures, empty results and incomplete actions stop downstream delivery; completed work still succeeds.')

for (const outgoing of [
  [{to:'a',label:'A'},{to:'b',label:'B'},{to:'extra'}],
  [{to:'a'},{to:'b'},{to:'extra'}],
  [{to:'a',label:'A'},{to:'b',label:'unknown'}],
  [{to:'a',label:'A'},{to:'a',label:'B'}],
]) {
  globalThis.__cronModel = () => assert.fail('invalid graph must be rejected before model work')
  const db = database({...base,nodes:[{id:'gate',type:'router',branches:[{label:'A'},{label:'B'}]},...['a','b','extra'].map(id=>({id,type:'memory',memKey:id}))],edges:outgoing.map(edge=>({from:'gate',...edge}))})
  assert.equal((await runOneFlow(db,'test-user',base.id,'run')).status,'failed')
  assert.deepEqual(db.flow.results,{})
  assert.equal(db.flow.memory?.extra,undefined)
}
for (const labels of [[undefined,undefined],[' a ','B']]) {
  globalThis.__cronModel = () => 'A'
  const db = database({...base,nodes:[{id:'gate',type:'router',branches:[{label:'A'},{label:'B'}]},...['a','b'].map(id=>({id,type:'memory',memKey:id}))],edges:['a','b'].map((to,i)=>({from:'gate',to,label:labels[i]}))})
  assert.equal((await runOneFlow(db,'test-user',base.id,'run')).status,'done')
  assert.ok(db.flow.results.a)
  assert.equal(db.flow.results.b,undefined)
}
delete globalThis.__cronModel
console.log('PASS ambiguous/unknown/duplicate router connections fail before execution; exact legacy and normalized explicit branch mappings survive.')
