import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import sharp from 'sharp'

export async function cloudflareMessageCases({ api, store, worker, env, db }) {
  const oldEnv = { ...process.env }, oldFetch = globalThis.fetch
  const contextSymbol=Symbol.for('@vercel/request-context'), oldContext=globalThis[contextSymbol], background=[]
  globalThis[contextSymbol]={get:()=>({waitUntil:promise=>background.push(promise)})}
  const uid = 'message-owner', phone = '+12025550101', line = '+12025550102'
  Object.assign(process.env, { NALU_STORAGE_BACKEND:'cloudflare', CLOUDFLARE_DATA_URL:'https://fixture.invalid', CLOUDFLARE_DATA_SECRET:env.NALU_DATA_SECRET, NALU_PHONE_OWNER_ID:uid, TELNYX_PHONE_NUMBER:line, TELNYX_API_KEY:'fixture-carrier-key', TELNYX_MESSAGING_PROFILE_ID:'fixture-profile' })
  const local = (url, init) => { assert.ok(String(url).startsWith('https://fixture.invalid/'), 'No live carrier or model requests'); return worker.fetch(new Request(url, init), env) }
  globalThis.fetch = local
  const repo = new api.CloudflareMessages(store)
  await store.batch([{ sql:'INSERT INTO nalu_users(id,display_name,salt,hash,phone) VALUES(?,?,?,?,?)', params:[uid,'Message fixture','salt','hash',phone] }])
  const input = (requestId, extra = {}) => ({requestId, direction:'outbound', from:line, to:phone, text:'A saved message 🐺', ...extra})
  const keyword = (word, seconds, event = word + seconds) => api.keywordConsent(phone, word, new Date(Date.now() - 60000 + seconds * 1000).toISOString(), event)
  try {
    const raced = await Promise.all([repo.save(uid,input('same-request')),repo.save(uid,input('same-request'))])
    assert.equal(raced.filter(r=>r.newlyCreated).length,1)
    assert.equal(raced[0].id,raced[1].id)
    await assert.rejects(repo.save(uid,input('same-request',{text:'Different'})),/different message/)
    assert.equal(await repo.get('owner-b',raced[0].id),null)
    assert.deepEqual(await api.privatePhoneUser(store,phone),{id:uid,display_name:'Message fixture'})
    assert.equal(await api.privatePhoneUser(store,line),null)
    const start = keyword('START',1), stop = {...keyword('STOP',2), occurredAt:start.occurredAt}
    await Promise.all([api.recordMessageConsent(store,uid,start),api.recordMessageConsent(store,uid,stop)])
    assert.equal(await api.canMessagePhone(store,uid,phone),false,'STOP wins the equal-time race')
    await api.recordMessageConsent(store,uid,keyword('START',0))
    assert.equal(await repo.allowed(uid,phone),false,'An older START cannot clear STOP')
    const inbound = input('inbound:start',{direction:'inbound',from:phone,to:line,text:'START',carrierId:'verified-start'})
    const resumed = keyword('START',3)
    await repo.save(uid,inbound,resumed)
    assert.equal(await repo.allowed(uid,phone),true)
    await api.recordMessageConsent(store,uid,keyword('STOP',4))
    await repo.save(uid,inbound,keyword('START',5))
    assert.equal(await repo.allowed(uid,phone),false,'A replayed carrier message cannot grant consent again')
    const broken = new api.CloudflareMessages({batch(statements){return store.batch([...statements,{sql:'UPDATE missing_message_fixture SET x=1'}])}})
    await assert.rejects(broken.save(uid,input('inbound:rollback',{direction:'inbound',from:phone,to:line,text:'START'}),keyword('START',6)),/database operation failed/)
    assert.equal(await repo.get(uid,api.messageId(uid,'inbound:rollback')),null)
    assert.equal(await repo.allowed(uid,phone),false,'Queue insert and verified consent roll back together')
    const snapshot=await store.readDocuments(uid,[api.consentKey(phone)])
    await store.commitDocuments(uid,snapshot.revision,[{key:api.consentKey(phone),value:JSON.stringify(keyword('START',10))}])
    assert.equal(await repo.allowed(uid,phone),false,'Editable account data is not carrier consent')
    console.log('PASS Cloudflare messages: concurrent idempotency, owner isolation, atomic inbound consent, STOP ordering, duplicate-webhook and editable-document consent rejection')

    const task = {id:'image-task-fixture',title:'A wolf',meta:{kind:'image',delivery:{channel:'app',address:'Nalu'}}}
    const image = input('image-request',{direction:'image',taskId:task.id})
    await Promise.all([repo.save(uid,image,undefined,task),repo.save(uid,image,undefined,task)])
    await assert.rejects(repo.save(uid,image,undefined,{...task,meta:{...task.meta,delivery:{channel:'text',address:phone}}}),/different delivery/)
    assert.equal((await repo.task(uid,task.id)).meta.delivery.channel,'app')
    const bytes=Buffer.alloc(900000,0x71),mediaId='media_'+createHash('sha256').update(uid).update(bytes).digest('hex').slice(0,40)
    await repo.saveMedia(uid,mediaId,bytes)
    await repo.saveMedia(uid,mediaId,bytes)
    assert.equal(await repo.mediaSize(uid,mediaId),bytes.length)
    assert.ok((await repo.media(uid,mediaId)).bytes.equals(bytes))
    assert.equal(await repo.media('owner-b',mediaId),null)
    assert.equal(db.prepare('SELECT length(bytes) AS size FROM nalu_message_media WHERE id=?').get(mediaId).size,0,'D1 holds metadata; bytes are in R2')
    console.log('PASS Cloudflare image requests save queue and task atomically; private R2 MMS bytes round-trip across multiple chunks with account isolation')

    await api.recordMessageConsent(store,uid,keyword('START',11))
    const outbound=await repo.save(uid,input('send-race',{taskId:task.id,media:[{id:mediaId}]}))
    let sends=0
    globalThis.fetch=async(url,init)=>{
      if(String(url)==='https://api.telnyx.com/v2/messages'){
        sends++; const body=JSON.parse(init.body)
        assert.equal(body.to,phone);assert.equal(body.from,line);assert.equal(body.type,'MMS');assert.equal(body.media_urls.length,1)
        await repo.receipt(uid,'carrier-race',phone,'delivered','')
        return Response.json({data:{id:'carrier-race'}})
      }
      return local(url,init)
    }
    await Promise.all([api.sendMessageOnce(store,outbound),api.sendMessageOnce(store,outbound)])
    assert.equal(sends,1)
    assert.equal((await repo.get(uid,outbound.id)).status,'delivered','Receipt before acceptance survives')
    await repo.receipt(uid,'carrier-race',phone,'sent','late')
    await repo.receipt('owner-b','carrier-race',phone,'delivery_failed','wrong owner')
    assert.equal((await repo.get(uid,outbound.id)).status,'delivered')
    const metadata=(await repo.task(uid,task.id)).meta
    assert.equal(metadata.delivery.channel,'app');assert.equal(metadata.messageDelivery,'delivered');assert.equal(metadata.messageError,null)
    const uncertain=await repo.save(uid,input('timeout'))
    globalThis.fetch=async(url,init)=>{if(String(url)==='https://api.telnyx.com/v2/messages'){sends++;throw new Error('Carrier accepted; response lost')}return local(url,init)}
    await api.sendMessageOnce(store,uncertain);await api.sendMessageOnce(store,uncertain)
    assert.equal(sends,2);assert.equal((await repo.get(uid,uncertain.id)).status,'uncertain')
    globalThis.fetch=local
    const lostClaim=await repo.save(uid,input('lost-claim'))
    globalThis.fetch=async(url,init)=>{const result=await local(url,init);if(String(url).endsWith('/v1/batch')&&JSON.parse(init.body).statements.some(s=>s.sql.includes("SET status='sending'")))throw new Error('Claim response lost');return result}
    await assert.rejects(api.sendMessageOnce(store,lostClaim),/Claim response lost/)
    globalThis.fetch=local
    await api.sendMessageOnce(store,lostClaim)
    assert.equal((await repo.get(uid,lostClaim.id)).status,'sending','A lost durable claim never triggers an unconfirmed resend')
    const suppressed=await repo.save(uid,input('stopped'))
    await api.recordMessageConsent(store,uid,keyword('STOP',12))
    await api.sendMessageOnce(store,suppressed)
    assert.equal((await repo.get(uid,suppressed.id)).status,'suppressed')
    console.log('PASS Cloudflare carrier transport: one send under concurrency, early receipts and terminal delivery retained, task metadata preserved, uncertain sends and lost claims never replayed')

    // Exercise the actual raw-webhook and account routes, holding the worker
    // lease while inspecting the durable queue created by each request.
    await store.batch([{sql:"UPDATE nalu_messages SET status='done' WHERE user_id=? AND status='queued'",params:[uid]},
      {sql:'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?),(?,?)',params:['message-token',uid,'message-other','owner-b']}])
    const lease=new api.CloudflarePhoneLease(store,uid,'messages'), held=await lease.claim()
    assert.ok(held);assert.equal(await lease.claim(),null)
    const keys=generateKeyPairSync('ed25519')
    process.env.TELNYX_PUBLIC_KEY=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')
    const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},end(){return this}})
    const invoke=async(body,token='message-token',badSignature=false)=>{
      const raw=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000)),res=response()
      const headers=token?{authorization:'Bearer '+token}:{'telnyx-timestamp':timestamp,'telnyx-signature-ed25519':badSignature?'invalid':sign(null,Buffer.from(timestamp+'|'+raw),keys.privateKey).toString('base64')}
      await api.messagesHandler({method:'POST',body:raw,headers},res)
      await Promise.all(background.splice(0))
      return res
    }
    const event=(id,text,extra={})=>({data:{id:'event-'+id,event_type:'message.received',occurred_at:new Date().toISOString(),payload:{id,direction:'inbound',from:{phone_number:phone},to:[{phone_number:line}],messaging_profile_id:process.env.TELNYX_MESSAGING_PROFILE_ID,text,...extra}}})
    assert.equal((await invoke({action:'status'},'invalid')).code,401)
    assert.equal((await invoke({action:'status'},'message-other')).code,403)
    assert.equal((await invoke(event('bad','START'),'',true)).code,403)
    assert.equal((await invoke(event('wrong-profile','START',{messaging_profile_id:'wrong'}),'')).code,403)
    assert.equal((await invoke(event('other-sender','START',{from:{phone_number:'+12025550103'}}),'')).code,200)
    assert.equal(await repo.get(uid,api.messageId(uid,'inbound:other-sender')),null)
    assert.equal((await invoke(event('api-start','START'),'')).code,200)
    assert.equal((await invoke({action:'status'})).body.optedIn,true)
    const accepted=await invoke({action:'send',requestId:'api-outbound',text:'Saved through the real route',mediaIds:[mediaId]})
    assert.equal(accepted.code,202,JSON.stringify(accepted.body))
    assert.equal((await invoke({action:'send',requestId:'api-outbound',text:'Changed'})).code,409)
    const listed=(await invoke({action:'list'})).body.messages
    assert.ok(listed.some(m=>m.id===accepted.body.message.id))
    assert.ok(!listed.some(m=>'mutation_token' in m||'fingerprint' in m))
    const mediaQuery=Object.fromEntries(new URL(api.mediaLink(uid,mediaId)).searchParams)
    for(const method of ['GET','HEAD']){
      const res=response();await api.messageMediaHandler({method,query:mediaQuery},res)
      assert.equal(res.code,200);assert.equal(res.headers['Content-Length'],bytes.length)
      if(method==='GET')assert.ok(res.body.equals(bytes));else assert.equal(res.body,undefined)
    }
    const denied=response();await api.messageMediaHandler({method:'GET',query:{...mediaQuery,id:'media_'+'0'.repeat(40)}},denied);assert.equal(denied.code,403)
    // Expired workers cannot claim another item or release a newer lease.
    await store.batch([{sql:"UPDATE nalu_phone_leases SET expires_at='2000-01-01' WHERE user_id=? AND scope='messages'",params:[uid]}])
    const replacement=await lease.claim();assert.ok(replacement)
    assert.equal(await repo.claimNext(uid,held),null)
    await lease.release(held);assert.equal(await lease.valid(replacement),true)
    await lease.release(replacement)
    console.log('PASS actual Cloudflare messaging routes: authenticated owner access, raw carrier signatures, verified sender/profile, queue/list contracts, signed private media GET/HEAD and expired-worker isolation')

    const png=await sharp({create:{width:32,height:32,channels:3,background:'#aabbcc'}}).png().toBuffer()
    process.env.GEMINI_API_KEY='fixture-image-key'
    let generated=0,workerSends=0
    globalThis.fetch=async(url,init)=>{
      if(String(url)==='https://api.telnyx.com/v2/messages'){workerSends++;return Response.json({data:{id:'worker-message-'+workerSends}})}
      if(String(url).startsWith('https://generativelanguage.googleapis.com/')){generated++;return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]})}
      return local(url,init)
    }
    const directory=await repo.save(uid,input('team-directory',{direction:'inbound',from:phone,to:line,text:'team',carrierId:'verified-team'}))
    const imageTask=await api.queueImageRequest(store,uid,'A wolf in a forest','worker-image')
    await Promise.all([api.processMessages(uid),api.processMessages(uid)])
    assert.equal(generated,1,'Concurrent workers generate this image once')
    assert.equal((await repo.get(uid,directory.id)).status,'done')
    const directoryReply=await repo.get(uid,api.messageId(uid,'reply:'+directory.id))
    assert.match(directoryReply.text,/Creative director/);assert.equal(directoryReply.status,'accepted')
    const finished=await repo.task(uid,imageTask.id)
    assert.equal(finished.status,'done',JSON.stringify(finished))
    assert.equal(finished.meta.delivery.channel,'app');assert.ok(finished.meta.mediaId)
    const generatedFile=await repo.media(uid,finished.meta.mediaId);assert.ok(generatedFile.bytes.length)
    await api.collectTaskAttachments(store,uid,finished.id)
    assert.ok((await api.listAttachments(store,uid,finished.id)).attachments.some(a=>a.mime==='image/jpeg'))
    const delivery={phase:'done',confirmed:true,destination:{channel:'text',address:phone},content:'Confirmed call details'}
    const beforeDelivery=workerSends
    await Promise.all([api.deliverCallDetails(uid,'followup-fixture',delivery),api.deliverCallDetails(uid,'followup-fixture',delivery)])
    assert.equal(workerSends,beforeDelivery+1,'Confirmed follow-up has one durable intent')
    const prefs=await store.readDocuments(uid,['nalu-task-notifications'])
    await store.commitDocuments(uid,prefs.revision,[{key:'nalu-task-notifications',value:JSON.stringify({messageUpdates:true,messageUpdatesSince:'2026-01-01'})}])
    await store.batch([{sql:"INSERT INTO nalu_tasks(id,user_id,source,title,status,meta) VALUES(?,?,'desktop','Fixture completed work','done',?)",params:['message-completion',uid,JSON.stringify({kind:'remote',result:'Finished without touching a real repository.',completedAt:new Date().toISOString()})]}])
    const beforeCompletion=workerSends
    await Promise.all([api.deliverTaskCompletions(uid),api.deliverTaskCompletions(uid)])
    await api.deliverTaskCompletions(uid)
    assert.equal(workerSends,beforeCompletion+1,'Completion notifications are not repeated')
    assert.equal((await store.query("SELECT status FROM nalu_task_notifications WHERE task_id='message-completion' AND channel='message'")).results[0].status,'accepted')
    console.log('PASS actual Cloudflare SMS worker: team directory, one image generation, retained task delivery metadata, R2 image attachments, confirmed follow-up and completion sends each run once with simulated providers')
  } finally {
    await Promise.allSettled(background.splice(0))
    if(oldContext===undefined)delete globalThis[contextSymbol];else globalThis[contextSymbol]=oldContext
    globalThis.fetch=oldFetch
    for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key]
    Object.assign(process.env,oldEnv)
  }
}
