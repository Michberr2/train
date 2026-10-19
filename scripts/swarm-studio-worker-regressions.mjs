import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

// Real actions, SQLite-backed store, worker, scoped Studio adapter and final
// artifact persistence. Only generation/auth infrastructure is synthetic.
const result = await build({ stdin: { contents: `export * from './api/_swarm'; export * from './api/_swarmWorker'; export * from './api/_swarmStore'; export {CloudflareStore} from './api/_cloudflareStore';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'studio-provider-fixture', setup(builder) {
    builder.onResolve({ filter: /^@vercel\/functions$|\/(?:_connectionBackend|_swarmExecution|_swarmStudioHandlers|_swarmStudioMedia)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ resolveDir: process.cwd(), contents:
      path === '@vercel/functions' ? 'export function waitUntil(p){globalThis.__studioWorker.background.push(p)}' :
      path.endsWith('_connectionBackend') ? 'export function connectionBackend(){throw new Error("No infrastructure connection in document fixture")}' :
      path.endsWith('_swarmExecution') ? 'export function executeSwarmWork(){throw new Error("Studio must not use the text worker")}' :
      path.endsWith('_swarmStudioMedia') ? 'export function prepareSwarmStudioMedia(){throw new Error("No media in document fixture")}' :
      `import {registerSwarmStudioHook,excludeSwarmStudioIdentity,recordSwarmStudioQuota,swarmStudioInvocation} from './api/_swarmStudioContext';
       registerSwarmStudioHook('identity'); registerSwarmStudioHook('quota');
       export const swarmStudioHandlers={doc:async(req,res)=>{
         const f=globalThis.__studioWorker;
         if(!excludeSwarmStudioIdentity()) throw new Error('Profile access was not excluded');
         const owner=swarmStudioInvocation().ownerId;
         recordSwarmStudioQuota(owner,'doc',{ok:true,signedIn:true,release:async()=>{f.refundAttempts++;if(f.refundError)throw new Error('PRIVATE_REFUND_TRANSPORT_ERROR');f.refunds++}});
         f.calls.push({owner,body:req.body});
         await f.generate(req);
         res.status(200).json({title:'Scoped document',blocks:[{type:'paragraph',text:'Saved actual fixture output'}]});
       }};` }))
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { SwarmStore, CloudflareStore, applySwarmAction, executeLeasedSwarmJob, finishSwarmJob } = module.exports
class LocalD1 extends CloudflareStore {
  constructor(sql) { super('https://fixture.invalid', 'local-studio-regression-key-not-a-credential'); this.db = new DatabaseSync(':memory:'); this.db.exec("PRAGMA foreign_keys=ON;CREATE TABLE nalu_users(id TEXT PRIMARY KEY);INSERT INTO nalu_users VALUES('owner');"); this.db.exec(sql); this.tail = Promise.resolve() }
  async batch(statements) {
    const before = this.tail; let unlock; this.tail = new Promise(resolve => { unlock = resolve }); await before
    this.db.exec('BEGIN')
    try { const results = statements.map(({sql,params=[]})=>({results:this.db.prepare(sql).all(...params)})); this.db.exec('COMMIT'); return {results} }
    catch(error) { this.db.exec('ROLLBACK'); throw error } finally { unlock() }
  }
  async query(sql, params=[]) { await this.tail; return {results:this.db.prepare(sql).all(...params)} }
}
const db = new LocalD1(await readFile('cloudflare/nalu-data/migrations/0016_swarm.sql','utf8'))
const store = new SwarmStore(db)
const fixture = globalThis.__studioWorker = { background:[], calls:[], refunds:0, refundAttempts:0, refundError:false, generate:async()=>{} }
const mutate = body => store.mutate('owner', draft => applySwarmAction(draft,'owner',body,Date.now()))
const made = await mutate({action:'create',requestId:'studio-project-01',title:'Work',brief:'PROJECT_ONLY_CONTEXT'})
const projectId = made.state.projects[0].id
await store.mutate('owner', draft => { draft.state.messages.push({id:'private',projectId,thread:'Milo',speaker:'You',content:'OTHER_PRIVATE_CANARY',createdAt:Date.now()}) })
async function continuation(suffix) {
  const added = await mutate({action:'add-task',projectId,thread:'Rocky',requestId:`add-studio-${suffix}`,title:'Create a document about this project',assignee:'Rocky'})
  const task = added.state.tasks.at(-1)
  await mutate({action:'start-task',projectId,taskId:task.id,requestId:`start-studio-${suffix}`})
  const source = await store.claim('owner')
  await store.mutateLeased('owner',source.id,source.leaseToken,draft=>finishSwarmJob(draft,source.id,{status:'waiting',content:'Ready for Studio',summary:'Ready for Studio',artifact:{type:'needs-workspace',workspace:'studio',studioKind:'document',prompt:source.input,reason:'Open Studio'}},Date.now()))
  const request = {action:'continue-studio',projectId,taskId:task.id,sourceJobId:source.id,requestId:`continue-studio-${suffix}`}
  await mutate(request)
  return {task,source,request,job:await store.claim('owner')}
}
const first = await continuation('one')
await executeLeasedSwarmJob(store,'owner',first.job,{timeoutMs:5000})
await Promise.all(fixture.background.splice(0))
let saved = await store.read('owner'), job = saved.jobs.find(item=>item.id===first.job.id), task = saved.state.tasks.find(item=>item.id===first.task.id)
assert.equal(job.status,'done'); assert.equal(job.artifact.type,'studio-artifact'); assert.equal(job.artifact.revision,1)
assert.equal(job.artifact.sourceJobId,first.source.id); assert.equal(job.artifact.payload.blocks[0].text,'Saved actual fixture output')
assert.deepEqual(task.artifact,{executionId:job.id,studioKind:'document',revision:1})
assert.equal(task.progress,1); assert.equal(job.leaseToken,undefined)
assert.equal(saved.jobs.find(item=>item.id===first.source.id).status,'waiting','original attempt stays immutable')
assert.equal(saved.state.messages.filter(item=>item.content===job.result && item.thread==='Rocky').length,1)
assert.equal(saved.state.messages.filter(item=>item.content===job.result && item.thread==='group').length,0)
assert.match(JSON.stringify(fixture.calls[0].body),/PROJECT_ONLY_CONTEXT/)
assert.doesNotMatch(JSON.stringify(fixture.calls[0].body),/OTHER_PRIVATE_CANARY/)
const prior = JSON.stringify(saved); await mutate(first.request); assert.equal(JSON.stringify(await store.read('owner')),prior)
console.log('PASS actual Studio worker saves scoped artifact, task reference and private reply once; original handoff remains immutable and replayable')

const second = await continuation('two')
let finish, started
const ready = new Promise(resolve=>{started=resolve})
fixture.generate = async()=>{started();await new Promise(resolve=>{finish=resolve})}
const active = executeLeasedSwarmJob(store,'owner',second.job,{timeoutMs:5000,heartbeatMs:5})
await ready
await mutate({action:'stop-task',projectId,taskId:second.task.id})
finish(); await active; await Promise.all(fixture.background.splice(0))
saved = await store.read('owner'); job = saved.jobs.find(item=>item.id===second.job.id); task = saved.state.tasks.find(item=>item.id===second.task.id)
assert.equal(job.status,'cancelled'); assert.equal(task.status,'cancelled'); assert.equal(task.artifact,undefined)
assert.equal(job.artifact.type,'studio-generation','late generator output never becomes a saved creation')
assert.ok(fixture.refunds>=1,'cancelled generation refunds its observed quota receipt')
console.log('PASS stop during actual Studio adapter execution fences late output and preserves cancelled state')

for (const [suffix, message, expected] of [
  ['size', 'This creation exceeds the saved-work limit. Split it into smaller creations.', /Split it into smaller creations/],
  ['context', 'This image request and its approved context exceed the image generator limit. Narrow the brief explicitly; no context was silently discarded.', /shorter brief or conversation/],
  ['runtime', 'The website has not passed its runtime checks.', /did not pass its runtime checks/],
  ['secret', 'This creation exceeds the saved-work limit. Split it into smaller creations. PRIVATE_PROVIDER_CANARY', /^This attempt could not finish\. Retry when you are ready\.$/],
]) {
  const work = await continuation(suffix), beforeCalls = fixture.calls.length
  fixture.generate = async()=>{throw new Error(message)}
  await executeLeasedSwarmJob(store,'owner',work.job,{timeoutMs:5000})
  saved = await store.read('owner'); job = saved.jobs.find(item=>item.id===work.job.id); task = saved.state.tasks.find(item=>item.id===work.task.id)
  assert.equal(job.status,'failed'); assert.match(job.summary,expected); assert.equal(task.summary,job.summary)
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_PROVIDER_CANARY/)
  assert.equal(job.quotaCleanupPending,undefined)
  assert.equal(fixture.calls.length,beforeCalls+1); assert.equal(await store.claim('owner'),null,'failure does not requeue provider work')
}
console.log('PASS safe Studio validation messages stay actionable; unknown or prefixed provider details remain private')

const failedRefund = await continuation('refund-failed'), beforeRefundCalls = fixture.calls.length
fixture.refundError = true
fixture.generate = async()=>{throw new Error('PRIVATE_PROVIDER_CANARY')}
await executeLeasedSwarmJob(store,'owner',failedRefund.job,{timeoutMs:5000})
saved = await store.read('owner'); job = saved.jobs.find(item=>item.id===failedRefund.job.id); task = saved.state.tasks.find(item=>item.id===failedRefund.task.id)
assert.equal(job.status,'failed'); assert.equal(job.quotaCleanupPending,true)
assert.match(job.summary,/refund could not be confirmed/); assert.equal(task.summary,job.summary)
assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_PROVIDER_CANARY|PRIVATE_REFUND_TRANSPORT_ERROR/)
assert.equal(fixture.calls.length,beforeRefundCalls+1); assert.equal(await store.claim('owner'),null)
console.log('PASS exhausted quota cleanup persists unconfirmed metadata without leaking errors or retrying providers')

const cancelledRefund = await continuation('refund-cancelled')
let cancelEntered, cancelFinish
const cancelReady = new Promise(resolve=>{cancelEntered=resolve})
fixture.generate = async()=>{cancelEntered();await new Promise(resolve=>{cancelFinish=resolve})}
const cancelling = executeLeasedSwarmJob(store,'owner',cancelledRefund.job,{timeoutMs:5000,heartbeatMs:5})
await cancelReady
await mutate({action:'stop-task',projectId,taskId:cancelledRefund.task.id})
cancelFinish(); await cancelling; await Promise.all(fixture.background.splice(0))
saved = await store.read('owner'); job = saved.jobs.find(item=>item.id===cancelledRefund.job.id); task = saved.state.tasks.find(item=>item.id===cancelledRefund.task.id)
assert.equal(job.status,'cancelled'); assert.equal(job.quotaCleanupPending,true); assert.equal(job.leaseToken,undefined)
assert.match(job.summary,/Stopped by you.*refund could not be confirmed/); assert.equal(task.status,'cancelled'); assert.equal(task.summary,job.summary)
assert.equal(await store.claim('owner'),null)
console.log('PASS refund metadata survives Stop removing the lease without reviving cancelled work')

// A lost acknowledgement of successful persistence must never mark its refund
// pending or replace the completed artifact with a failure summary.
fixture.refundError = false
const alreadySaved = await continuation('saved-ack')
await executeLeasedSwarmJob(store,'owner',alreadySaved.job,{timeoutMs:5000,executeStudio:async()=>{
  await store.mutateLeased('owner',alreadySaved.job.id,alreadySaved.job.leaseToken,draft=>{
    const j=draft.jobs.find(item=>item.id===alreadySaved.job.id), t=draft.state.tasks.find(item=>item.id===alreadySaved.task.id)
    j.status='done';j.summary='Saved';delete j.leaseToken;delete j.leaseUntil;t.status='done';t.summary='Saved'
  })
  throw Object.assign(new Error('PRIVATE_ACK_ERROR'),{quotaCleanupPending:true})
}})
saved = await store.read('owner'); job = saved.jobs.find(item=>item.id===alreadySaved.job.id)
assert.equal(job.status,'done'); assert.equal(job.summary,'Saved'); assert.equal(job.quotaCleanupPending,undefined)
console.log('PASS completed attempts cannot be overwritten by late cleanup failures')
db.db.close()
