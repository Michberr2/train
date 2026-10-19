import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

// Exercise the actual dispatcher and leased-worker lifetime. Storage, provider
// work and clock advancement are explicit fixtures; no browser/network/model.
const result = await build({ stdin: { contents: "export { runSwarmOwner } from './api/_swarmWorker'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022', plugins: [{ name: 'scheduler-fixtures', setup(builder) {
    builder.onResolve({ filter: /\/(?:_connectionBackend|_swarmStore|_swarm|_swarmExecution)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents:
      path.endsWith('_connectionBackend') ? 'export function connectionBackend(){return globalThis.__swarmScheduler.backend()}' :
      path.endsWith('_swarmStore') ? `export class SwarmStore {
        constructor(client){this.client=client}
        claim(owner){return globalThis.__swarmScheduler.claim(owner,this.client)}
        read(){return Promise.resolve(globalThis.__swarmScheduler.snapshot)}
        renew(owner,id,token){return globalThis.__swarmScheduler.renew(id,token)}
        mutateLeased(owner,id,token,change){return globalThis.__swarmScheduler.mutate(id,token,change)}
      }` :
      path.endsWith('_swarmExecution') ? 'export function executeSwarmWork(input){return globalThis.__swarmScheduler.execute(input)}' :
      `export function swarmContext(){return {brief:'',context:[]}}
       export function appendSwarmResult(snapshot,job,content){snapshot.state.messages.push({id:job.id,content})}` }))
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { runSwarmOwner } = module.exports
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const within = async (promise, message) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 500) })]) }
  finally { clearTimeout(timer) }
}
const realNow = Date.now
let time = 1_800_000_000_000
Date.now = () => time
function fixture() {
  const f = {
    snapshot: { revision: 0, state: { projects: [], messages: [], tasks: [], turns: [] }, jobs: [] },
    events: [], claimCount: 0, backendCount: 0,
    async claim() { return null },
    async execute() { return { status: 'done', content: 'Actual fixture result', summary: 'Ready' } },
    async connect() {}, async close() {},
    backend() {
      const id = f.backendCount++ === 0 ? 'dispatcher' : `worker-${f.backendCount - 1}`
      return { client: { id }, async connect() { f.events.push(`connect:${id}`); await f.connect(id) },
        async close() { f.events.push(`closing:${id}`); await f.close(id); f.events.push(`closed:${id}`) } }
    },
    job(id) {
      const job = { id, projectId: 'project', thread: 'group', kind: 'reply', speaker: 'Nalu', input: id,
        requestId: id, status: 'running', leaseToken: `lease-${id}`, leaseUntil: time + 120000, createdAt: time, updatedAt: time, attempts: 1 }
      f.snapshot.jobs.push(job); return { ...job }
    },
    async renew(id, token) {
      f.events.push(`renew:${id}`)
      const job = f.snapshot.jobs.find(item => item.id === id)
      if (job?.status !== 'running' || job.leaseToken !== token || job.leaseUntil <= time) return false
      job.leaseUntil = time + 120000; return true
    },
    async mutate(id, token, change) {
      const job = f.snapshot.jobs.find(item => item.id === id)
      if (job?.status !== 'running' || job.leaseToken !== token || job.leaseUntil <= time) return null
      change(f.snapshot); return f.snapshot
    },
  }
  globalThis.__swarmScheduler = f
  return f
}
try {
  {
    const f = fixture(), second = defer(), secondEntered = defer(), started = defer(), finish = defer()
    f.claim = async () => {
      if (++f.claimCount === 1) return f.job('first')
      secondEntered.resolve(); return second.promise
    }
    f.execute = async () => { started.resolve(); await finish.promise; return { status: 'done', content: 'First result', summary: 'Ready' } }
    const running = runSwarmOwner('owner', 20000)
    try {
      await within(secondEntered.promise, 'The second storage claim was never attempted')
      await within(started.promise, 'The first worker waited for the delayed second claim')
      assert.ok(f.events.includes('renew:first'), 'Initial lease renewal precedes completion of the delayed second claim')
      assert.equal(f.snapshot.jobs[0].status, 'running')
    } finally { time += 20000; second.resolve(null); finish.resolve(); await running }
    assert.equal(f.snapshot.jobs[0].status, 'done')
    assert.equal(f.events.at(-1), 'closed:dispatcher')
    console.log('PASS first claimed worker renews and starts while the next storage claim is still unresolved')
  }
  {
    const f = fixture()
    f.claim = async () => { f.claimCount++; time += 11000; return f.job('admitted') }
    await runSwarmOwner('owner', 20000)
    assert.equal(f.claimCount, 1, 'Admission budget is checked again before a second claim')
    assert.equal(f.snapshot.jobs[0].status, 'done', 'Already accepted work still completes within the cleanup tail')
    const none = fixture(); await runSwarmOwner('owner', 10000)
    assert.equal(none.backendCount, 1); assert.equal(none.snapshot.jobs.length, 0)
    console.log('PASS elapsed admission budget stops further claims while preserving already started work')
  }
  {
    const f = fixture(), started = defer(), claimFailed = defer(), finish = defer(), closing = defer(), cleanup = defer()
    const expected = new Error('Later storage claim failed')
    f.claim = async () => {
      if (++f.claimCount === 1) return f.job('survivor')
      await started.promise; claimFailed.resolve(); throw expected
    }
    f.execute = async () => { started.resolve(); await finish.promise; return { status: 'done', content: 'Preserved result', summary: 'Ready' } }
    f.close = async id => { if (id === 'worker-1') { closing.resolve(); await cleanup.promise } }
    let settled = false
    const observed = runSwarmOwner('owner', 20000).then(() => ({ ok: true }), error => ({ error })).finally(() => { settled = true })
    try {
      await within(claimFailed.promise, 'The later claim failure was not reached'); await tick()
      assert.equal(settled, false, 'A later claim error must not abandon active execution')
      finish.resolve(); await within(closing.promise, 'Worker connection cleanup was never started'); await tick()
      assert.equal(settled, false, 'Dispatcher must await asynchronous worker cleanup')
      assert.equal(f.events.includes('closing:dispatcher'), false)
    } finally { finish.resolve(); cleanup.resolve() }
    assert.equal((await observed).error, expected)
    assert.equal(f.snapshot.jobs[0].status, 'done')
    assert.ok(f.events.indexOf('closed:worker-1') < f.events.indexOf('closing:dispatcher'))
    console.log('PASS a later claim error waits for started execution and connection cleanup before rejecting')
  }
  {
    const f = fixture(), second = defer(), entered = defer(), unhandled = []
    const capture = reason => unhandled.push(reason)
    process.on('unhandledRejection', capture)
    f.claim = async () => { if (++f.claimCount === 1) return f.job('connection-failure'); entered.resolve(); return second.promise }
    f.connect = async id => { if (id === 'worker-1') throw new Error('Worker connection failed') }
    const running = runSwarmOwner('owner', 20000)
    try {
      await within(entered.promise, 'Second claim not entered'); await tick(); await tick()
      assert.deepEqual(unhandled, [], 'The failed worker must have a rejection handler before later claims settle')
      assert.ok(f.events.includes('closed:worker-1'))
      assert.equal(f.snapshot.jobs[0].status, 'running', 'A connection failure leaves its durable lease for the expiration sweep')
    } finally { time += 20000; second.resolve(null); await running; process.off('unhandledRejection', capture) }
    console.log('PASS immediate worker rejection is handled and cleaned up while later claims remain pending')
  }
} finally {
  Date.now = realNow
  delete globalThis.__swarmScheduler
}
