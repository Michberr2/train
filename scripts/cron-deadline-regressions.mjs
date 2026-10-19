// Actual scheduler/checkpoint code and actual completion transport, offline.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { artifactDatabase } from './autopilot-artifact-fixture.mjs'

const original = {now:Date.now,fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout}
const keys = ['TINKER_API_KEY','NALU_FALLBACK_API_KEY','NALU_DISABLE_EMERGENCY']
const oldEnv = Object.fromEntries(keys.map(key=>[key,process.env[key]]))
const bundle = await build({stdin:{resolveDir:process.cwd(),contents:"export * from './api/_cron';export {chatComplete as actualCompletion} from './api/_llm'"},bundle:true,write:false,format:'cjs',platform:'node',packages:'external',plugins:[{name:'scheduler-fixtures',setup(b){
  const services={
    './connect':'export async function sendPipelineOutput(){throw new Error("Unexpected external delivery")}',
    './_llm':'export async function chatComplete(...args){return globalThis.__deadline.model(...args)}',
    './_grounding':'export async function groundFromPrompt(){return ""}',
    './_webResearch':'export async function search(q){return globalThis.__deadline.search(q)};export async function fetchPage(u){return globalThis.__deadline.page(u)}',
    './_publicFetch':'export async function publicFetch(...args){return globalThis.__deadline.http(...args)}',
  }
  b.onResolve({filter:/^\.\/(?:connect|_llm|_grounding|_webResearch|_publicFetch)$/},({path})=>({path,namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:services[path],loader:'js'}))
}}]})
const module={exports:{}}
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const {runOneFlow,runDueCrons,actualCompletion}=module.exports
let now=1_000_000, next=0, timers=new Map()
const advance=ms=>{
  now+=ms
  for(const [id,timer] of [...timers]) if(timer.at<=now && timers.delete(id)) timer.fn()
}
const reset=()=>{
  assert.equal(timers.size,0,'completed invocation leaked a watchdog')
  now+=1_000_000
  globalThis.__deadline={model:()=>assert.fail('unexpected model'),search:()=>assert.fail('unexpected search'),page:()=>assert.fail('unexpected page'),http:()=>assert.fail('unexpected HTTP')}
}
const seed=(nodes,edges=[])=>({id:'bounded-flow',name:'Deadline fixture',schedule:'hourly',enabled:true,nodes,edges})
const request=(db,mode='run',ms=5000)=>runOneFlow(db,db.userId,db.flow.id,mode,false,{deadlineMs:now+ms})
try {
  Date.now=()=>now
  globalThis.setTimeout=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id}
  globalThis.clearTimeout=id=>timers.delete(id)
  process.env.TINKER_API_KEY='offline-primary';process.env.NALU_FALLBACK_API_KEY='offline-fallback';process.env.NALU_DISABLE_EMERGENCY='1'

  reset()
  const mapDb=artifactDatabase(seed([{id:'input',type:'trigger',prompt:'one\ntwo\nthree\nfour\nfive\nsix'},{id:'map',type:'foreach',webSearch:false},{id:'after',type:'memory',memKey:'complete'}],[{from:'input',to:'map'},{from:'map',to:'after'}]))
  const seen=[]
  globalThis.__deadline.model=async(messages,opts)=>{
    assert.equal(opts.maxAttempts,2);assert.equal(opts.retryPrimary,false);assert.equal(opts.requireComplete,true)
    assert.ok(opts.signal && opts.timeoutMs<=45000)
    seen.push(messages[0].content)
    advance(1000)
    return `done ${seen.length}`
  }
  assert.equal((await request(mapDb)).status,'running')
  assert.equal(mapDb.flow.run.yielded,true)
  assert.equal(mapDb.flow.run.checkpoints.map.outputs.filter(Boolean).length,3)
  assert.equal(mapDb.flow.results.map,undefined)
  assert.equal(mapDb.flow.memory?.complete,undefined)
  assert.ok([...mapDb.tasks.values()].includes('queued'),'incomplete run must stay queued, not done')
  const runId=mapDb.flow.run.startedAt
  globalThis.__deadline.model=async messages=>{seen.push(messages[0].content);return 'completed remaining item'}
  assert.equal((await request(mapDb,'resume',20000)).status,'done')
  assert.equal(mapDb.flow.run.startedAt,runId)
  assert.equal(mapDb.tasks.size,1,'resume settles the original ledger row')
  assert.equal(seen.length,6,'completed map items must not be paid/generated twice')
  assert.match(mapDb.flow.memory.complete,/Item 6/)
  const stale=await runOneFlow(mapDb,mapDb.userId,mapDb.flow.id,'resume',false,{expectedStartedAt:runId-1})
  assert.equal(stale.code,409,'a stale continuation must never resume a replacement run')

  reset()
  const planDb=artifactDatabase(seed([{id:'planner',type:'planner',prompt:'Research then finish',maxSteps:3},{id:'after',type:'memory',memKey:'complete'}],[{from:'planner',to:'after'}]))
  let modelCalls=0,reads=0
  globalThis.__deadline.model=async()=>{modelCalls++;advance(3100);return '{"action":"fetch","url":"https://example.com/source"}'}
  globalThis.__deadline.page=async()=>{reads++;advance(1200);return {status:'read',url:'https://example.com/source',text:'source evidence'}}
  assert.equal((await request(planDb)).status,'running')
  assert.equal(planDb.flow.run.checkpoints.planner.step,1)
  assert.equal(planDb.flow.memory?.complete,undefined)
  globalThis.__deadline.model=async messages=>{modelCalls++;assert.match(messages[0].content,/source evidence/);return '{"action":"finish","answer":"Grounded deliverable"}'}
  assert.equal((await request(planDb,'resume',20000)).status,'done')
  assert.equal(reads,1);assert.equal(modelCalls,2)
  assert.equal(planDb.flow.memory.complete,'Grounded deliverable')

  reset()
  const mutationDb=artifactDatabase(seed([{id:'send',type:'http',method:'POST',url:'https://example.com/action',prompt:'payload'},{id:'after',type:'memory',memKey:'sent'}],[{from:'send',to:'after'}]))
  let sends=0
  globalThis.__deadline.http=async()=>{sends++;assert.equal(mutationDb.flow.run.pendingEffect.nodeId,'send','claim mutation before sending');advance(5000);throw new Error('outcome unknown')}
  assert.equal((await request(mutationDb)).status,'failed')
  assert.equal(mutationDb.flow.run.status,'stuck')
  assert.equal((await request(mutationDb,'resume')).status,'failed')
  assert.equal(sends,1,'uncertain mutation must not be replayed by Resume')
  assert.equal(mutationDb.flow.memory?.sent,undefined)
  assert.equal((await runDueCrons(mutationDb)).flowsRan,0,'uncertain mutation must not trigger a fresh scheduled run')
  // A killed worker left only its durable send claim, with no response/checkpoint.
  mutationDb.flow={...mutationDb.flow,run:{...mutationDb.flow.run,status:'running',heartbeat:1}}
  assert.equal((await runDueCrons(mutationDb)).flowsRan,1)
  assert.equal(mutationDb.flow.run.status,'stuck');assert.equal(sends,1)

  reset()
  const batchDb=artifactDatabase(seed([{id:'first',type:'agent',webSearch:false}]))
  batchDb.flows.set('other-account',[{...seed([{id:'second',type:'agent',webSearch:false}]),id:'later-flow'}])
  let jobs=0
  globalThis.__deadline.model=async()=>{jobs++;advance(5000);return 'finished work'}
  const result=await runDueCrons(batchDb,{deadlineMs:now+5000})
  assert.equal(result.deferred,true);assert.equal(jobs,1)
  assert.equal(batchDb.flows.get('other-account')[0].lastRun,undefined,'unstarted flows remain due')
  globalThis.__deadline.model=async()=>{jobs++;return 'finished remaining work'}
  await runDueCrons(batchDb,{deadlineMs:now+20000})
  assert.equal(batchDb.flow.run.status,'done')
  assert.equal(jobs,2,'deferred complete node must not rerun')

  reset()
  const hungDb=artifactDatabase(seed([{id:'hung',type:'agent',webSearch:false}]))
  globalThis.__deadline.model=actualCompletion
  let transportCalls=0,entered
  const start=new Promise(resolve=>{entered=resolve})
  globalThis.fetch=async(_url,init)=>{transportCalls++;assert.ok(init.signal);entered();return new Promise(()=>{})}
  const hung=request(hungDb,'run',5000)
  await start
  advance(5000)
  assert.equal((await hung).status,'running','real provider ignoring abort must yield at invocation deadline')
  assert.equal(transportCalls,1,'deadline prevents retry/fallback after cancellation')
  assert.equal(hungDb.flow.results.hung,undefined)
  assert.equal(hungDb.flow.run.yielded,true)
  assert.equal(timers.size,0)
  reset()
  const transactionDb=artifactDatabase(seed([{id:'value',type:'trigger',prompt:'preserved'}]))
  const query=transactionDb.query.bind(transactionDb);let locks=0,rollbacks=0
  transactionDb.query=async(sql,params)=>{const result=await query(sql,params);if(sql.includes('FOR UPDATE')&&++locks===2)advance(5000);if(sql==='ROLLBACK')rollbacks++;return result}
  assert.equal((await request(transactionDb)).status,'running')
  assert.ok(rollbacks>0,'computation cancellation must roll back an open PostgreSQL checkpoint transaction before final saved-state cleanup')
  assert.equal(transactionDb.flow.run.yielded,true)
  reset()
  const exhaustedDb=artifactDatabase(seed([{id:'value',type:'trigger',prompt:'not falsely completed'}]))
  const exhaustedQuery=exhaustedDb.query.bind(exhaustedDb);let exhaustedLocks=0
  exhaustedDb.query=async(sql,params)=>{const result=await exhaustedQuery(sql,params);if(sql.includes('FOR UPDATE')&&++exhaustedLocks===2)advance(40000);return result}
  await assert.rejects(request(exhaustedDb))
  assert.ok(![...exhaustedDb.tasks.values()].includes('done'),'exhausted storage tail must not report a confirmed completion')
  assert.equal(timers.size,0)
  console.log('PASS scheduler budget/attempt caps, durable foreach/planner resume, queued status, unknown-mutation no-replay, lost-worker claim, shared invocation deadline and real ignored-abort provider cancellation.')
  console.log('PASS PostgreSQL checkpoint rollback survives computation cancellation; exhausted storage tail never confirms completion.')
} finally {
  Date.now=original.now;globalThis.fetch=original.fetch;globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout
  for(const [key,value] of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
  delete globalThis.__deadline
}
