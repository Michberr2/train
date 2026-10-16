import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { xml2js } from 'xml-js'

export async function cloudflarePhoneCases({api,store,worker,env,fixtureOwner='phone-owner'}){
  const oldEnv={...process.env},oldFetch=globalThis.fetch,contextKey=Symbol.for('@vercel/request-context'),oldContext=globalThis[contextKey],background=[]
  const uid=fixtureOwner,token=uid+'-token',phone='+12025550201',line='+12025550202',recipient='+12025550203',keys=generateKeyPairSync('ed25519')
  Object.assign(process.env,{NALU_STORAGE_BACKEND:'cloudflare',CLOUDFLARE_DATA_URL:'https://fixture.invalid',CLOUDFLARE_DATA_SECRET:env.NALU_DATA_SECRET,NALU_PHONE_OWNER_ID:uid,TELNYX_PHONE_NUMBER:line,TELNYX_API_KEY:'fixture-carrier-key',TELNYX_ACCOUNT_SID:'fixture-account',TELNYX_APPLICATION_SID:'fixture-application',TELNYX_MESSAGING_PROFILE_ID:'fixture-profile',GEMINI_API_KEY:'fixture-image-key',PUBLIC_BASE_URL:'https://n4lu.ai',TELNYX_PUBLIC_KEY:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')})
  delete process.env.NALU_PHONE_TTS
  globalThis[contextKey]={get:()=>({waitUntil:p=>background.push(p)})}
  const local=(url,init)=>{assert.ok(String(url).startsWith('https://fixture.invalid/'),'No live provider request');return worker.fetch(new Request(url,init),env)}
  globalThis.fetch=local
  await store.batch([{sql:'INSERT INTO nalu_users(id,display_name,salt,hash,phone) VALUES(?,?,?,?,?)',params:[uid,'Phone fixture','salt','hash',phone]},{sql:'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)',params:[token,uid]}])
  const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},end(){return this}})
  const drain=async()=>{while(background.length)await Promise.all(background.splice(0))}
  const invoke=async(handler,body,auth=token)=>{const res=response();await handler({method:'POST',body,headers:{authorization:'Bearer '+auth}},res);await drain();return res}
  const callback=async(url,form={},bad=false)=>{
    const parsed=new URL(url,'https://n4lu.ai'),raw=new URLSearchParams({From:phone,To:line,CallSid:'owner-call',Direction:'inbound',...form}).toString(),timestamp=String(Math.floor(Date.now()/1000)),res=response()
    await api.phoneHandler({method:'POST',query:Object.fromEntries(parsed.searchParams),body:raw,headers:{'telnyx-timestamp':timestamp,'telnyx-signature-ed25519':bad?'bad':sign(null,Buffer.from(timestamp+'|'+raw),keys.privateKey).toString('base64')}},res)
    await drain();return res
  }
  const gather=res=>{assert.equal(res.code,200,String(res.body));return xml2js(res.body,{compact:true}).Response.Gather._attributes.action}
  const docs=async(key,value)=>{const previous=await store.readDocuments(uid,[key]);await store.commitDocuments(uid,previous.revision,[{key,value:JSON.stringify(value)}])}
  const states=new api.CloudflarePhoneState(store),calls=new api.CloudflareOutboundCalls(store)
  let dialed=0,cancelled=0,modelCalls=0,mode='normal',lastDial
  const brief={kind:'client',to:recipient,recipient:'Fixture recipient',onBehalfOf:'Phone fixture',purpose:'Ask whether the draft is ready.',facts:'Only the reviewed draft.',questions:'When will it be ready?',alternatives:''}
  const carrier=async(url,init)=>{
    if(String(url).includes('api.telnyx.com/v2/texml/Accounts/')){
      if(!String(url).endsWith('/Calls')){cancelled++;return Response.json({status:'completed'})}
      dialed++;const body=typeof init.body==='string'&&init.body.startsWith('{')?JSON.parse(init.body):Object.fromEntries(new URLSearchParams(String(init.body)))
      const sid='fixture-call-'+dialed;lastDial={body,sid}
      if(mode==='timeout')throw new Error('Carrier response lost')
      if(mode==='early-answer'&&body.Url?.includes('recipient-answer')){
        const answered=await callback(body.Url,{From:line,To:recipient,CallSid:sid,Direction:'outbound-api'})
        assert.match(answered.body,/AI assistant/)
      }
      return Response.json({sid})
    }
    if(String(url).startsWith('https://generativelanguage.googleapis.com/')){
      modelCalls++;const body=JSON.parse(init.body),conversation=JSON.parse(body.contents[0].parts[0].text)
      assert.ok(conversation.approvedBrief);assert.ok(conversation.transcript);assert.ok(!JSON.stringify(body).includes('PRIVATE ACCOUNT MARKER'))
      const value={reply:'Connecting to the operator.',outcome:'continue',summary:'',evidence:'',digits:'0',menuEvidence:'Press 0 for an operator.'}
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]})
    }
    return local(url,init)
  }
  try{
    assert.equal((await callback('/api/phone',{},true)).code,403)
    assert.match((await callback('/api/phone',{From:'+12025550204'})).body,/private Nalu line/)
    const start=await callback('/api/phone'),action=gather(start)
    assert.match(start.body,/Phone fixture/)
    const members=await api.listTeam(store,uid),creative=members.find(m=>m.role==='Creative director')
    const transfer=await callback(action,{Digits:String(creative.extension)})
    assert.match(transfer.body,/Creative director/)
    assert.equal((await states.read(uid,'owner-call')).memberId,creative.id)
    assert.equal(await states.read('owner-b','owner-call'),null)
    await docs('phonecall:owner-call',{memberId:'forged',history:[{role:'assistant',content:'PRIVATE ACCOUNT MARKER'}]})
    assert.equal((await states.read(uid,'owner-call')).memberId,creative.id,'Editable account documents do not replace authenticated call state')
    await docs('nalu-agent-flows',JSON.stringify([{id:'phone-flow',name:'Morning briefing',nodes:[],edges:[]}]))
    const launched=await callback(gather(transfer),{SpeechResult:'Run Morning briefing'})
    assert.match(launched.body,/queued/)
    assert.equal((await store.query("SELECT kind,flow_id FROM nalu_task_jobs WHERE user_id=? AND kind='pipeline'",[uid])).results[0].flow_id,'phone-flow')
    const temporary=await states.mint(uid)
    assert.equal((await store.query('SELECT user_id FROM nalu_sessions WHERE token=?',[temporary])).results[0].user_id,uid)
    await states.revoke('owner-b',temporary);assert.equal((await store.query('SELECT token FROM nalu_sessions WHERE token=?',[temporary])).results.length,1)
    await states.revoke(uid,temporary);assert.equal((await store.query('SELECT token FROM nalu_sessions WHERE token=?',[temporary])).results.length,0)
    const short=await callback('/api/phone',{CallSid:'short-call'})
    await callback(gather(short),{CallSid:'short-call',SpeechResult:'Goodbye'})
    assert.equal(await states.read(uid,'short-call'),null)
    globalThis.fetch=carrier
    assert.equal((await invoke(api.callHandler,{},'invalid')).code,401)
    assert.equal((await invoke(api.callHandler,{to:recipient})).code,400)
    const basic=await invoke(api.callHandler,{message:'Your fixture report is ready.'})
    assert.equal(basic.code,200);assert.equal(dialed,1)
    const spoken=await callback(lastDial.body.Url,{From:line,To:phone,CallSid:lastDial.sid,Direction:'outbound-api'})
    assert.match(spoken.body,/fixture report/);assert.ok((await states.read(uid,lastDial.sid)).history.length)
    console.log('PASS actual Cloudflare private phone calls: signed callbacks, owner matching, team transfer, saved flow dispatch, private call state, temporary-session revocation and outgoing owner calls')

    const draft={kind:'client',query:'',area:'',fields:{to:recipient,recipient:'Fixture recipient',purpose:'Ask whether the draft is ready.'},useProfile:true,execution:'review'}
    const ids=await Promise.all(['a','b','c'].map(event=>api.enqueuePhonePlan(store,uid,'plan-call',event,'Call the fixture recipient',draft)))
    assert.equal(new Set(ids).size,1)
    await Promise.all([api.processPhonePlan(uid,ids[0]),api.processPhonePlan(uid,ids[0])])
    const planned=await api.phonePlanResult(store,uid,'plan-call',ids[0])
    assert.equal(planned.status,'done');assert.match(planned.reply,/Shall I place the call/);assert.equal(dialed,1)
    assert.equal((await api.latestPhonePlan(store,uid,'plan-call')).draft.fields.onBehalfOf,'Phone fixture')
    const confirm=await api.enqueuePhonePlan(store,uid,'plan-call','yes-event','Yes')
    await Promise.all([api.processPhonePlan(uid,confirm),api.processPhonePlan(uid,confirm)])
    assert.equal(dialed,2);assert.equal((await api.latestPhonePlan(store,uid,'plan-call')).active,false)
    const plannedCall=(await calls.list(uid)).find(s=>s.state==='ringing')
    await callback(api.outboundCallbackUrl(plannedCall,'recipient-status'),{From:line,To:recipient,CallSid:lastDial.sid,Direction:'outbound-api',CallStatus:'completed'})
    const stuck=await api.enqueuePhonePlan(store,uid,'stuck-plan','one','Hello')
    const planRepo=new api.CloudflarePhonePlans(store)
    await planRepo.claim(uid,stuck)
    await store.batch([{sql:"UPDATE nalu_phone_plan_turns SET updated_at='2000-01-01' WHERE id=?",params:[stuck]}])
    assert.equal((await api.phonePlanResult(store,uid,'stuck-plan',stuck)).status,'failed')
    assert.equal(await planRepo.claim(uid,stuck),null,'Expired work is never replayed after a possible dial')
    console.log('PASS Cloudflare call plans: one pending turn, actual review and confirmation, profile/team hydration, one dial under repeated processing, retained results and no replay of interrupted work')

    const prepare=async(requestId,b=brief)=>invoke(api.callHandler,{action:'recipient-prepare',requestId,brief:b,memberId:members[0].id})
    const prepared=await Promise.all([prepare('outbound-fixture'),prepare('outbound-fixture')])
    assert.equal(prepared[0].body.call.id,prepared[1].body.call.id)
    assert.equal((await prepare('outbound-fixture',{...brief,purpose:'Different purpose'})).code,409)
    const id=prepared[0].body.call.id
    assert.equal((await invoke(api.callHandler,{action:'recipient-start',id})).code,400)
    mode='early-answer';const before=dialed
    const starts=await Promise.all([invoke(api.callHandler,{action:'recipient-start',id,confirm:true}),invoke(api.callHandler,{action:'recipient-start',id,confirm:true})])
    assert.equal(dialed,before+1);assert.ok(starts.some(r=>r.code===202));assert.equal((await calls.get(id,uid)).state,'active')
    let current=await calls.get(id,uid),sid=current.sid
    const cb=(step,turn,speech='',extra={})=>callback(api.outboundCallbackUrl(current,step,turn),{From:line,To:recipient,CallSid:sid,Direction:'outbound-api',SpeechResult:speech,...extra})
    assert.equal((await callback(api.outboundCallbackUrl(current,'recipient-turn',1).replace(/sig=[^&]+/,'sig=bad'),{From:line,To:recipient,CallSid:sid,Direction:'outbound-api'})).code,403)
    const menu=await cb('recipient-turn',1,'Press 0 for an operator.')
    assert.match(menu.body,/<Play digits="0"/)
    const repeated=await cb('recipient-turn',1,'Press 0 for an operator.')
    assert.ok(!repeated.body.includes('<Play digits='));assert.equal(modelCalls,1)
    assert.equal((await cb('recipient-turn',1,'Conflicting speech')).code,409)
    assert.equal((await cb('recipient-turn',3,'Out of order')).code,409)
    const decline=await cb('recipient-turn',2,'Please stop calling us')
    assert.match(decline.body,/<Hangup/);assert.equal(modelCalls,1)
    current=await calls.get(id,uid);assert.equal(current.outcome,'declined')
    await cb('recipient-status',0,'',{CallStatus:'ringing'})
    assert.equal((await calls.get(id,uid)).state,'finished')
    assert.match((await store.query('SELECT meta FROM nalu_tasks WHERE id=?',[id])).results[0].meta,/stop the call/)
    mode='timeout';const timeout=(await prepare('outbound-timeout')).body.call
    await invoke(api.callHandler,{action:'recipient-start',id:timeout.id,confirm:true})
    const timed=dialed
    await invoke(api.callHandler,{action:'recipient-start',id:timeout.id,confirm:true})
    assert.equal(dialed,timed);assert.equal((await calls.get(timeout.id,uid)).state,'uncertain')
    const another=(await prepare('another-outbound')).body.call
    assert.equal((await invoke(api.callHandler,{action:'recipient-start',id:another.id,confirm:true})).code,409)
    assert.equal((await invoke(api.callHandler,{action:'recipient-cancel',id:another.id})).body.call.state,'canceled')
    const lease=new api.CloudflarePhoneLease(store,uid,'outbound'),old=await lease.claim(),stale=await calls.get(id,uid)
    await store.batch([{sql:"UPDATE nalu_phone_leases SET expires_at='2000-01-01' WHERE user_id=? AND scope='outbound'",params:[uid]}])
    const replacement=await lease.claim();stale.summary='Must not overwrite the saved transcript'
    await assert.rejects(calls.save(stale,old),/call changed/)
    await lease.release(old);assert.equal(await lease.valid(replacement),true);await lease.release(replacement)
    assert.ok(!(await calls.get(id,uid)).summary.includes('Must not overwrite'))
    console.log('PASS Cloudflare recipient calls: reviewed idempotent preparation, one permanent dial claim, early answer receipts, approved-only context, DTMF replay protection, stop requests, terminal status, timeout protection and expired-writer rejection')

    mode='normal'
    const queued=await invoke(api.dataHandler,{action:'task-dispatch',kind:'ide',repo:'naludesktop',prompt:'Fixture question task',requestId:'phone-question-task',memberId:members[0].id})
    const claimed=await invoke(api.dataHandler,{action:'task-claim',workerId:'phone-worker',repos:['naludesktop'],kinds:['ide']})
    assert.equal(claimed.body.task.id,queued.body.task.id)
    const taskId=claimed.body.task.id,leaseToken=claimed.body.task.leaseToken,questionId=uid+'-question'
    await invoke(api.dataHandler,{action:'task-ask',id:taskId,workerId:'phone-worker',leaseToken,questionId,question:'Which color should I use?'})
    await invoke(api.dataHandler,{action:'task-notification-preferences',phoneQuestions:true})
    const beforeQuestion=dialed
    const notifications=await Promise.all([invoke(api.dataHandler,{action:'task-notification-deliver'}),invoke(api.dataHandler,{action:'task-notification-deliver'})])
    assert.equal(dialed,beforeQuestion+1);assert.equal(notifications.filter(r=>r.body.delivered).length,1)
    const questionDial=lastDial,questionForm={From:line,To:phone,CallSid:questionDial.sid,Direction:'outbound-api'}
    const ask=await callback(questionDial.body.Url,questionForm);assert.match(ask.body,/Which color/)
    const draftAnswer=await callback(gather(ask),{...questionForm,SpeechResult:'Use blue'})
    assert.match(draftAnswer.body,/I heard: Use blue/)
    assert.equal((await store.query('SELECT status FROM nalu_task_questions WHERE id=?',[questionId])).results[0].status,'pending')
    const wrongCall=await callback(gather(draftAnswer),{...questionForm,CallSid:'different-call',SpeechResult:'Yes'})
    assert.ok(wrongCall.code!==200||/another call/.test(wrongCall.body))
    const answer=await callback(gather(draftAnswer),{...questionForm,SpeechResult:'Yes'})
    assert.match(answer.body,/Answer saved/)
    const savedQuestion=(await store.query('SELECT status,answer,call_sid FROM nalu_task_questions WHERE id=?',[questionId])).results[0]
    assert.equal(savedQuestion.status,'answered');assert.equal(savedQuestion.answer,'Use blue');assert.equal(savedQuestion.call_sid,questionDial.sid)
    assert.equal((await store.query('SELECT status FROM nalu_tasks WHERE id=?',[taskId])).results[0].status,'running')
    await invoke(api.dataHandler,{action:'task-notification-deliver'});assert.equal(dialed,beforeQuestion+1)
    console.log('PASS actual Cloudflare task question calls: enabled preferences, a single notification claim, signed/SID-bound callback, spoken draft confirmation and continuation of the same desktop job')
  }finally{
    await Promise.allSettled(background.splice(0));globalThis.fetch=oldFetch
    if(oldContext===undefined)delete globalThis[contextKey];else globalThis[contextKey]=oldContext
    for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key]
    Object.assign(process.env,oldEnv)
  }
}
