// Actual task routes + scheduler + signed Cloudflare worker over in-memory SQLite.
// No model/provider requests, desktop execution, or real account data.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const bundledWorker=await build({entryPoints:['cloudflare/nalu-data/worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})
const {default:worker}=await import(`data:text/javascript;base64,${Buffer.from(bundledWorker.outputFiles[0].text).toString('base64')}`)
const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON')
for(const path of (await readdir('cloudflare/nalu-data/migrations')).filter(x=>x.endsWith('.sql')).sort()) db.exec(await readFile('cloudflare/nalu-data/migrations/'+path,'utf8'))
for(const owner of ['owner-a','owner-b']) db.prepare('INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)').run(owner,owner,'salt','hash')
db.prepare('INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)').run('fixture-session','owner-a')
let tail=Promise.resolve()
const secret='pipeline-offline-regression-secret-12345678'
const env={NALU_DATA_SECRET:secret,DB:{prepare(sql){return{sql,params:[],bind(...params){this.params=params;return this},async all(){return{results:db.prepare(this.sql).all(...this.params)}},async first(){return db.prepare(this.sql).get(...this.params)||null}}},async batch(statements){const prior=tail;let unlock;tail=new Promise(r=>unlock=r);await prior;db.exec('BEGIN');try{const result=[];for(const stmt of statements)result.push(await stmt.all());db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}finally{unlock()}}}}
const built=await build({stdin:{contents:"export { default as dataHandler } from './api/data';export * from './api/_cloudflareStore';export * from './api/_cloudflareFlows';export * from './api/_pipelineContinuation';export * from './api/_cron';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'cjs',platform:'node',external:['sharp'],target:'es2022'})
const mod={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports)
const {dataHandler,CloudflareStore,CloudflareFlows,deferPipelineTask,settlePipelineContinuations}=mod.exports
const oldFetch=globalThis.fetch,keys=['NALU_STORAGE_BACKEND','CLOUDFLARE_DATA_URL','CLOUDFLARE_DATA_SECRET'],oldEnv=Object.fromEntries(keys.map(k=>[k,process.env[k]]))
process.env.NALU_STORAGE_BACKEND='cloudflare';process.env.CLOUDFLARE_DATA_URL='https://fixture.invalid';process.env.CLOUDFLARE_DATA_SECRET=secret
let intercept
const fetchWorker=async(url,init)=>{assert.equal(new URL(url).origin,'https://fixture.invalid','unexpected external request');if(intercept)await intercept(url,init);return worker.fetch(new Request(url,init),env)}
globalThis.fetch=fetchWorker
const store=new CloudflareStore(),flows=new CloudflareFlows(store)
const save=async(flow,owner='owner-a')=>{const snapshot=await store.readDocuments(owner,['nalu-agent-flows']);await store.commitDocuments(owner,snapshot.revision,[{key:'nalu-agent-flows',value:JSON.stringify(JSON.stringify([flow]))}])}
const read=async()=>JSON.parse(await flows.read('owner-a'))[0]
const invoke=async body=>{let status=200,payload;const res={setHeader(){},status(n){status=n;return this},json(x){payload=x;return this},send(x){payload=x;return this},end(){}};await dataHandler({method:'POST',headers:{authorization:'Bearer fixture-session'},body},res);return{status,body:payload}}
const expect=async(body,status=200)=>{const response=await invoke(body);assert.equal(response.status,status,JSON.stringify(response.body));return response.body}
const claim=()=>expect({action:'task-claim',workerId:'fixture-worker',repos:['fixture'],kinds:['pipeline']})
const seed=(id='pipeline')=>({id,name:'Checkpoint fixture',nodes:[{id:'input',type:'trigger',prompt:'Approved text'},{id:'review',type:'approval'},{id:'output',type:'memory',memKey:'confirmed'}],edges:[{from:'input',to:'review'},{from:'review',to:'output'}]})
const update=(job,status,startedAt)=>({action:'task-update',id:job.id,workerId:'fixture-worker',leaseToken:job.leaseToken,status,pipelineContinuation:{flowId:job.request.flowId,startedAt}})
try{
  await save(seed())
  await expect({action:'task-dispatch',kind:'pipeline',flowId:'pipeline',mode:'resume',requestId:'missing'},409)
  const dispatched=await expect({action:'task-dispatch',kind:'pipeline',flowId:'pipeline',requestId:'review-run'},202)
  const first=(await claim()).task;assert.equal(first.id,dispatched.task.id)
  const waiting=await expect({action:'flow-run',flowId:'pipeline',mode:'run'});assert.equal(waiting.status,'awaiting');assert.ok(waiting.startedAt)
  await expect(update({...first,leaseToken:'0'.repeat(64)},'waiting',waiting.startedAt),409)
  await expect(update(first,'waiting',waiting.startedAt+1),409)
  const handed=await expect(update(first,'waiting',waiting.startedAt));assert.equal(handed.task.status,'waiting')
  assert.equal((await claim()).task,null,'review waits for human, never hot-loops worker')
  const finished=await expect({action:'flow-run',flowId:'pipeline',mode:'resume',expectedStartedAt:waiting.startedAt,approval:{nodeId:'review',decision:'approve'}})
  assert.equal(finished.status,'done');assert.equal((await read()).memory.confirmed,'Approved text')
  assert.equal(db.prepare('SELECT status FROM nalu_task_jobs WHERE id=?').get(first.id).status,'done','other client completion settles original dispatch')
  assert.equal(db.prepare('SELECT status FROM nalu_tasks WHERE id=?').get(first.id).status,'done')
  await expect({action:'flow-run',flowId:'pipeline',mode:'resume',expectedStartedAt:waiting.startedAt-1},409)
  await expect({action:'flow-run',flowId:'pipeline',mode:'resume',expectedStartedAt:'bad'},400)
  await expect(update(first,'waiting',waiting.startedAt),409,'released lease cannot overwrite completion')
  console.log('PASS actual route approval handoff stays waiting, atomic review resumes exact run, old dispatch settles done; stale run and lease rejected')

  const paused={...seed(),run:{status:'running',yielded:true,serverManaged:true,startedAt:Date.now()+5,heartbeat:Date.now()},results:{input:'saved'},approvals:{}}
  await save(paused)
  const queued=await expect({action:'task-dispatch',kind:'pipeline',flowId:'pipeline',mode:'resume',requestId:'paused-run'},202)
  const second=(await claim()).task;assert.equal(second.id,queued.task.id);assert.equal(second.request.startedAt,paused.run.startedAt)
  // Revision changes between reading the checkpoint and committing handoff.
  let changed=false
  intercept=async(url,init)=>{if(String(url).endsWith('/v1/batch')&&JSON.parse(init.body).statements?.some(s=>s.sql.includes("mode='resume'"))&&!changed){changed=true;db.prepare('UPDATE nalu_store_revisions SET revision=? WHERE scope=?').run('concurrent-write','user:owner-a')}}
  await expect(update(second,'queued',paused.run.startedAt),409);intercept=undefined
  assert.equal(db.prepare('SELECT status FROM nalu_task_jobs WHERE id=?').get(second.id).status,'running')
  await save(paused)
  const queuedAck=await expect(update(second,'queued',paused.run.startedAt));assert.equal(queuedAck.task.status,'queued')
  assert.notEqual(queuedAck.task.progress,1)
  const third=(await claim()).task;assert.equal(third.id,second.id);assert.equal(third.request.mode,'resume');assert.equal(third.request.startedAt,paused.run.startedAt)
  assert.notEqual(third.leaseToken,second.leaseToken)
  await expect(update(second,'queued',paused.run.startedAt),409,'old lease cannot hand off newly claimed work')
  await save({...paused,run:{...paused.run,pendingEffect:{nodeId:'send',startedAt:1}}})
  await expect(update(third,'queued',paused.run.startedAt),409,'uncertain mutation is not retryable')
  await save(paused)
  db.prepare("UPDATE nalu_task_jobs SET lease_expires_at='2000-01-01' WHERE id=?").run(third.id)
  await expect(update(third,'queued',paused.run.startedAt),409,'expired lease cannot hand off')
  db.prepare("UPDATE nalu_task_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds') WHERE id=?").run(third.id)
  await assert.rejects(deferPipelineTask(store,'owner-b',update(third,'queued',paused.run.startedAt)),/checkpoint/)
  await expect(update(third,'queued',paused.run.startedAt))
  await settlePipelineContinuations(store,'owner-a','pipeline',paused.run.startedAt+1,'done')
  assert.equal(db.prepare('SELECT status FROM nalu_task_jobs WHERE id=?').get(third.id).status,'queued','unrelated replacement cannot settle saved run')
  await expect({action:'flow-run',flowId:'pipeline',mode:'stop',expectedStartedAt:paused.run.startedAt})
  assert.equal(db.prepare('SELECT status FROM nalu_task_jobs WHERE id=?').get(third.id).status,'cancelled')
  console.log('PASS queued handoff survives new claim with same run ID; revision, owner, expiry, replacement and uncertain-mutation fences; stop settles pending task')

  await save(seed('worker-flow'))
  await expect({action:'task-dispatch',kind:'pipeline',flowId:'worker-flow',requestId:'bound-worker'},202)
  const boundJob=(await claim()).task
  const pipelineWorker={id:boundJob.id,workerId:'fixture-worker',leaseToken:boundJob.leaseToken}
  await expect({action:'flow-run',flowId:'worker-flow',mode:'stop',pipelineWorker},409,'fresh worker cannot stop an unconfirmed run')
  await expect({action:'flow-run',flowId:'worker-flow',mode:'run',pipelineWorker:{...pipelineWorker,leaseToken:'0'.repeat(64)}},409)
  const boundRun=await expect({action:'flow-run',flowId:'worker-flow',mode:'run',pipelineWorker})
  assert.equal(boundRun.status,'awaiting')
  const savedBound=await read();assert.equal(savedBound.run.remoteTaskId,boundJob.id)
  assert.equal(JSON.parse(db.prepare('SELECT meta FROM nalu_tasks WHERE id=?').get(boundJob.id).meta).pipelineContinuation.startedAt,boundRun.startedAt)
  await save({...savedBound,run:{...savedBound.run,startedAt:boundRun.startedAt+1}})
  await expect({action:'flow-run',flowId:'worker-flow',mode:'stop',pipelineWorker},409,'old worker cannot stop a replacement')
  assert.equal((await read()).run.status,'awaiting')
  await save(savedBound)
  await expect({action:'task-cancel',id:boundJob.id})
  const stopped=await expect({action:'flow-run',flowId:'worker-flow',mode:'stop',pipelineWorker})
  assert.equal(stopped.status,'stopped')

  await save(seed('cancel-before-work'))
  await expect({action:'task-dispatch',kind:'pipeline',flowId:'cancel-before-work',requestId:'cancel-before-work'},202)
  const cancelledJob=(await claim()).task;let cancelledBeforeWork=false
  intercept=async(url,init)=>{const payload=JSON.parse(init.body);if(!cancelledBeforeWork&&payload.sql?.startsWith('SELECT status FROM nalu_task_jobs')){cancelledBeforeWork=true;db.prepare("UPDATE nalu_task_jobs SET status='cancelled' WHERE id=?").run(cancelledJob.id)}}
  const cancelledRun=await expect({action:'flow-run',flowId:'cancel-before-work',mode:'run',pipelineWorker:{id:cancelledJob.id,workerId:'fixture-worker',leaseToken:cancelledJob.leaseToken}})
  intercept=undefined;assert.equal(cancelledRun.status,'stopped');assert.deepEqual((await read()).results,{})
  console.log('PASS fresh run binds claimed job before work; worker stop rejects replacement/unconfirmed run; task cancellation stops server before next node')

  const pgCalls=[];let pgUpdate=true
  const pg={async query(sql,params){pgCalls.push({sql,params});if(sql.startsWith('SELECT value'))return{rows:[{value:[paused]}]};if(sql.startsWith('WITH updated'))return{rows:pgUpdate?[{id:'pg',status:'queued'}]:[]};return{rows:[]}}}
  assert.equal((await deferPipelineTask(pg,'owner-a',update(third,'queued',paused.run.startedAt))).status,'queued')
  assert.equal(pgCalls[0].sql,'BEGIN');assert.match(pgCalls[1].sql,/FOR UPDATE/);assert.equal(pgCalls.at(-1).sql,'COMMIT')
  assert.match(pgCalls.find(c=>c.sql.startsWith('WITH updated')).sql,/worker_id=\$3 AND lease_token=\$4 AND lease_expires_at>NOW\(\)/)
  pgUpdate=false;await assert.rejects(deferPipelineTask(pg,'owner-a',update(third,'queued',paused.run.startedAt)),/lease/);assert.equal(pgCalls.at(-1).sql,'ROLLBACK')
  console.log('PASS PostgreSQL handoff holds flow row lock, checks lease and rolls back rejected transition (SQL contract fixture; no live PG execution)')
}finally{globalThis.fetch=oldFetch;for(const key of keys){if(oldEnv[key]===undefined)delete process.env[key];else process.env[key]=oldEnv[key]}db.close()}
