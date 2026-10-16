import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

export async function cloudflareRuntimeCases({ api, store, worker, env, db }) {
  const oldEnv = { ...process.env }, oldFetch = globalThis.fetch
  Object.assign(process.env, { NALU_STORAGE_BACKEND: 'cloudflare', CLOUDFLARE_DATA_URL: 'https://fixture.invalid', CLOUDFLARE_DATA_SECRET: env.NALU_DATA_SECRET })
  globalThis.fetch = (url, init) => { assert.ok(String(url).startsWith('https://fixture.invalid/'), 'No external provider calls'); return worker.fetch(new Request(url, init), env) }
  const owner = 'runtime-owner', token = owner
  await store.batch([
    { sql: 'INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)', params: [owner, 'Runtime', 'salt', 'hash'] },
    { sql: 'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)', params: [token, owner] },
  ])
  const invoke = async (handler, body, query, auth = token) => {
    const res = { code: 200, headers: {}, status(n) { this.code=n;return this }, setHeader(k,v) { this.headers[k]=v }, json(v) { this.body=v;return this }, end(){} }
    await handler({ method:query?'GET':'POST', query, body, headers:{ authorization:`Bearer ${auth}` } },res)
    return res
  }
  const putFlows = async flows => {
    const current=await store.readDocuments(owner,['nalu-agent-flows'])
    await store.commitDocuments(owner,current.revision,[{key:'nalu-agent-flows',value:JSON.stringify(JSON.stringify(flows))}])
  }
  try {
    const flow={id:'runtime-flow',name:'Runtime file',nodes:[{id:'start',type:'trigger',prompt:'A wolf and a unicorn'},{id:'file',type:'textfile',label:'Saved story'}],edges:[{from:'start',to:'file'}]}
    await putFlows([flow])
    const run=()=>invoke(api.dataHandler,{action:'flow-run',flowId:flow.id})
    const raced=await Promise.all([run(),run()])
    assert.equal(raced.filter(r=>r.body.ok).length,1,JSON.stringify(raced))
    assert.equal(raced.find(r=>!r.body.ok).code,409)
    const flows=new api.CloudflareFlows(store)
    let saved=JSON.parse(await flows.read(owner))[0]
    assert.equal(saved.run.status,'done')
    const taskId=`flow_${flow.id}_${saved.run.startedAt}`
    assert.equal((await store.query('SELECT status FROM nalu_tasks WHERE user_id=? AND id=?',[owner,taskId])).results[0].status,'done')
    assert.equal((await store.query('SELECT count(*) AS n FROM nalu_autopilot_artifacts WHERE user_id=?',[owner])).results[0].n,1)
    const files=await invoke(api.attachmentHandler,{action:'list',taskId})
    assert.equal(files.code,200,JSON.stringify(files.body));assert.ok(files.body.attachments.length)
    const file=files.body.attachments.find(f=>f.mime==='text/plain')
    const part=await invoke(api.attachmentHandler,{}, {id:file.id,part:'0'})
    assert.equal(part.code,200);assert.ok(Buffer.from(part.body.base64,'base64').length)
    assert.equal((await invoke(api.attachmentHandler,{}, {id:file.id,part:'0'},'owner-b')).code,401)
    const active={...flow,id:'lease-check',run:{status:'running',startedAt:100,heartbeat:Date.now()},results:{saved:'Do not erase'}}
    await putFlows([saved,active])
    const lease=await flows.claim(owner,active.id);assert.ok(lease)
    assert.equal(await flows.claim(owner,active.id),null)
    const snapshot=await store.readDocuments(owner,['nalu-agent-flows'])
    await store.batch([{sql:"UPDATE nalu_flow_leases SET expires_at='2000-01-01' WHERE user_id=? AND flow_id=?",params:[owner,active.id]}])
    const replacement=await flows.claim(owner,active.id);assert.ok(replacement)
    await assert.rejects(store.commitDocuments(owner,snapshot.revision,[{key:'nalu-agent-flows',value:'[]'}],{lease:{flowId:active.id,token:lease}}),/changed/)
    await flows.release(owner,active.id,lease)
    assert.ok(await flows.renew(owner,active.id,replacement))
    const stopped=await flows.stop(owner,active.id,100);assert.ok(stopped.ok)
    assert.equal(await flows.save(owner,{...active,results:{bad:'Stale'}},true,replacement),false)
    saved=JSON.parse(await flows.read(owner)).find(f=>f.id===active.id)
    assert.equal(saved.run.status,'stopped');assert.equal(saved.results.saved,'Do not erase')
    assert.equal((await flows.stop(owner,active.id,99)).code,409)
    await flows.release(owner,active.id,replacement)
    const approval={id:'approval-test',nodes:[{id:'t',type:'trigger',prompt:'Review this'},{id:'a',type:'approval',label:'Review'},{id:'f',type:'textfile',label:'Approved file'}],edges:[{from:'t',to:'a'},{from:'a',to:'f'}]}
    await putFlows([approval])
    assert.equal((await api.runOneFlow(store,owner,approval.id,'run')).status,'awaiting')
    saved=JSON.parse(await flows.read(owner))[0];saved.approvals={a:{decision:'edit',text:'Approved story',at:Date.now()}}
    await putFlows([saved]);assert.equal((await api.runOneFlow(store,owner,approval.id,'resume')).status,'done')
    console.log('PASS Cloudflare actual flow runner: exclusive execution, saved file downloads, approval pause/resume, expired-worker fencing and stop preserves checkpoints')

    const teams=await Promise.all([api.listTeam(store,owner),api.listTeam(store,owner)])
    assert.equal(teams[0].filter(m=>m.active).length,10)
    const makeMember=(name,requestId)=>api.createTeamRole(store,owner,{name,requestId,role:'Test engineer',responsibilities:'Verify release',workspace:'naludesktop'})
    const members=await Promise.all([makeMember('Wolf engineer','team-a'),makeMember('Unicorn engineer','team-b')])
    assert.notEqual(members[0].extension,members[1].extension)
    assert.deepEqual(await makeMember('Wolf engineer','team-a'),members[0])
    await assert.rejects(makeMember('Other engineer','team-a'),/different role/)
    const dispatch={action:'task-dispatch',requestId:'desktop-job',kind:'ide',repo:'naludesktop',prompt:'Check the build',memberId:members[0].id}
    const queued=await Promise.all([invoke(api.dataHandler,dispatch),invoke(api.dataHandler,dispatch)])
    assert.ok(queued.every(r=>r.code===202),JSON.stringify(queued));assert.equal(queued[0].body.task.id,queued[1].body.task.id)
    assert.equal((await invoke(api.dataHandler,{...dispatch,prompt:'A different task'})).code,409)
    const claim=workerId=>invoke(api.dataHandler,{action:'task-claim',workerId,repos:['naludesktop'],kinds:['ide']})
    assert.equal((await invoke(api.dataHandler,{action:'task-claim',workerId:'wrong-repo',repos:['another-repo'],kinds:['ide']})).body.task,null)
    const claimsJobs=await Promise.all([claim('worker-a'),claim('worker-b')]);assert.equal(claimsJobs.filter(r=>r.body.task).length,1)
    const winnerIndex=claimsJobs.findIndex(r=>r.body.task), job=claimsJobs[winnerIndex].body.task, workerId=winnerIndex===0?'worker-a':'worker-b'
    const update={action:'task-update',id:job.id,workerId,leaseToken:job.leaseToken,status:'running',progress:0.5,event:'Working'}
    assert.equal((await invoke(api.dataHandler,{...update,leaseToken:'0'.repeat(64)})).code,409)
    assert.equal((await invoke(api.dataHandler,update)).body.task.progress,0.5)
    const ask={...update,action:'task-ask',questionId:'release-question',question:'Which release should I inspect?'}
    const asked=await Promise.all([invoke(api.dataHandler,ask),invoke(api.dataHandler,ask)])
    assert.ok(asked.every(r=>r.code===200),JSON.stringify(asked))
    assert.equal((await invoke(api.dataHandler,{...ask,questionId:'second-question'})).code,409)
    assert.equal((await invoke(api.dataHandler,{...update,status:'done'})).code,409)
    assert.equal((await invoke(api.dataHandler,{action:'task-questions'})).body.questions.length,1)
    const answer={action:'task-answer',id:job.id,questionId:ask.questionId,answer:'Inspect the new Cloudflare release.'}
    assert.equal((await invoke(api.dataHandler,answer)).code,200)
    assert.equal((await invoke(api.dataHandler,answer)).code,200)
    assert.equal((await invoke(api.dataHandler,{...answer,answer:'Another answer'})).code,409)
    assert.equal((await invoke(api.dataHandler,{...ask,action:'task-question-status'})).body.question.answer,answer.answer)
    const preferences=await invoke(api.dataHandler,{action:'task-notification-preferences',phoneQuestions:false,messageUpdates:true})
    assert.equal(preferences.code,200);assert.equal(preferences.body.messageUpdates,true)
    const push={action:'push-register',deviceToken:'c'.repeat(64),environment:'production'}
    assert.equal((await invoke(api.dataHandler,push)).code,200)
    assert.equal((await invoke(api.dataHandler,{action:'push-status'})).body.devices.length,1)
    await store.batch([{sql:"UPDATE nalu_push_devices SET enabled_since='2000-01-01' WHERE user_id=?",params:[owner]}])
    let pushes=0
    const delivery=new api.CloudflarePush(store,async()=>{pushes++;return {status:200,reason:''}})
    await store.batch([{sql:"INSERT INTO nalu_tasks(id,user_id,status,title) VALUES(?,?,'done','Ready')",params:['push-task',owner]}])
    await Promise.all([delivery.deliver(owner),delivery.deliver(owner)])
    const sentCount=pushes;assert.ok(sentCount>0)
    assert.equal((await store.query("SELECT count(*) AS n FROM nalu_push_deliveries WHERE status='accepted'")).results[0].n,sentCount)
    await delivery.deliver(owner);assert.equal(pushes,sentCount)

    assert.equal((await invoke(api.dataHandler,{action:'task-cancel',id:job.id})).body.task.status,'cancelled')
    assert.equal((await invoke(api.dataHandler,{...update,status:'done'})).body.cancelRequested,true)
    const second=await invoke(api.dataHandler,{...dispatch,requestId:'expire-job'});assert.equal(second.code,202)
    const abandoned=(await claim('worker-c')).body.task
    await store.batch([{sql:"UPDATE nalu_task_jobs SET lease_expires_at='2000-01-01' WHERE id=?",params:[abandoned.id]}])
    assert.equal((await claim('worker-d')).body.task,null)
    assert.equal((await invoke(api.dataHandler,{...update,id:abandoned.id,workerId:'worker-c',leaseToken:abandoned.leaseToken})).code,409)
    assert.equal((await store.query('SELECT status FROM nalu_tasks WHERE id=?',[abandoned.id])).results[0].status,'failed')
    console.log('PASS Cloudflare team seeding/allocation and remote desktop jobs: idempotent dispatch, allowed repositories, exclusive claim, fenced updates, cancellation and no replay after worker expiry')

    const largeReply={data:{'nalu-chats':JSON.stringify([{id:'streamed',messages:[{content:'A unicorn 🦄 with a wolf 🐺. '.repeat(200000)}]}])}}
    class ResponseStream extends EventEmitter {
      parts=[];headers={};closed=false;writes=0
      setHeader(k,v){this.headers[k]=v}
      write(bytes){this.parts.push(bytes);if(++this.writes%3===0){queueMicrotask(()=>this.emit('drain'));return false}return true}
      end(){this.ended=true}
      json(){throw new Error('Large responses must stream')}
    }
    const streamed=new ResponseStream()
    await api.storedJson(streamed,largeReply)
    const download=Buffer.concat(streamed.parts)
    assert.ok(download.length>4500000);assert.deepEqual(JSON.parse(download.toString()),largeReply);assert.equal(streamed.ended,true)
    assert.equal(streamed.listenerCount('drain'),0)
    const closed=new ResponseStream();closed.write=function(bytes){this.parts.push(bytes);queueMicrotask(()=>{this.destroyed=true;this.emit('close')});return false}
    await api.storedJson(closed,largeReply);assert.equal(closed.parts.length,1);assert.equal(closed.ended,undefined)
    console.log('PASS large saved JSON streams preserve Unicode and the existing client format, respect backpressure and stop when a client disconnects')

    const retentionOwner='retention-owner'
    await store.batch([{sql:'INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)',params:[retentionOwner,'Retention','salt','hash']}])
    const oldValue=JSON.stringify('old retained data '.repeat(4000)), newValue=JSON.stringify('current document '.repeat(4000))
    const oldVersion=await store.commitDocuments(retentionOwner,'',[{key:'history',value:oldValue}])
    const oldHash=(await store.query('SELECT sha256 FROM nalu_document_parts WHERE owner=?',[retentionOwner])).results[0].sha256
    await store.batch([{sql:"UPDATE nalu_document_parts SET touched_at='2000-01-01' WHERE owner=?",params:[retentionOwner]}])
    await store.commitDocuments(retentionOwner,oldVersion.revision,[{key:'history',value:newValue}])
    await store.collectDocumentParts()
    assert.equal((await store.query('SELECT count(*) AS n FROM nalu_document_parts WHERE owner=?',[retentionOwner])).results[0].n,2)
    await store.batch([{sql:"UPDATE nalu_document_parts SET touched_at='2000-01-01' WHERE owner=?",params:[retentionOwner]}])
    await store.collectDocumentParts()
    assert.equal((await store.query('SELECT count(*) AS n FROM nalu_document_parts WHERE owner=? AND sha256=?',[retentionOwner,oldHash])).results[0].n,0)
    assert.equal((await store.readDocuments(retentionOwner,['history'])).entries[0].value,newValue)
    console.log('PASS document collection preserves every referenced history piece and recently retired snapshots while reclaiming only old unreachable pieces')

    const req={headers:{authorization:`Bearer ${token}`}}, reserve=()=>api.reserveDailyQuota(req,'runtime-quota',{anonPerDay:1,userPerDay:2})
    const quotas=await Promise.all([reserve(),reserve(),reserve()])
    assert.equal(quotas.filter(q=>q.ok).length,2);assert.ok(quotas.every(q=>q.signedIn))
    const refund=quotas.find(q=>q.ok)
    let lost=false
    globalThis.fetch=async(url,init)=>{
      const result=await worker.fetch(new Request(url,init),env)
      if(!lost&&String(init.body).includes('released=1')){lost=true;throw new Error('Lost refund acknowledgement')}
      return result
    }
    await assert.rejects(refund.release(),/Lost/);await refund.release()
    assert.equal((await store.query('SELECT count FROM nalu_usage WHERE subject=? AND kind=?',[`user:${owner}`,'runtime-quota'])).results[0].count,1)
    globalThis.fetch=(url,init)=>worker.fetch(new Request(url,init),env)
    process.env.NALU_USER_STUDIO_IMAGE_PER_DAY='2'
    const request=api.studioImageRequest(owner,{prompt:'A whimsical unicorn',variation:'first'})
    const claims=await Promise.all([api.claimStudioImage(store,owner,request),api.claimStudioImage(store,owner,request)])
    assert.equal(claims.filter(c=>'leaseId'in c).length,1)
    const owned=claims.find(c=>'leaseId'in c)
    const bytes=Buffer.from('verified-provider-image-bytes'),image={bytes,mimeType:'image/png',width:100,height:100}
    const completed=await api.completeStudioImage(store,owner,request.id,owned.leaseId,image)
    assert.deepEqual(completed.bytes,bytes)
    assert.deepEqual((await api.readStudioImage(store,owner,request.id)).bytes,bytes)
    assert.equal(await api.readStudioImage(store,'owner-b',request.id),null)
    await api.failStudioImage(store,owner,request.id,owned.leaseId)
    assert.equal((await store.query('SELECT count FROM nalu_usage WHERE subject=? AND kind=?',[`user:${owner}`,'studio-image'])).results[0].count,1)
    const next=api.studioImageRequest(owner,{prompt:'An accurate wolf'})
    const nextLease=await api.claimStudioImage(store,owner,next);assert.ok(nextLease.leaseId)
    const third=api.studioImageRequest(owner,{prompt:'Third image'})
    assert.equal((await api.claimStudioImage(store,owner,third)).limited,true)
    await api.failStudioImage(store,owner,next.id,'stale-lease')
    assert.equal((await api.claimStudioImage(store,owner,third)).limited,true)
    await api.failStudioImage(store,owner,next.id,nextLease.leaseId);await api.failStudioImage(store,owner,next.id,nextLease.leaseId)
    assert.ok((await api.claimStudioImage(store,owner,third)).leaseId)
    console.log('PASS Cloudflare concurrent quota limits, lost-acknowledgement idempotent refunds, exclusive image generation, private exact-byte image reload and stale-worker isolation')
  } finally {
    globalThis.fetch=oldFetch
    for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key]
    Object.assign(process.env,oldEnv)
  }
}
