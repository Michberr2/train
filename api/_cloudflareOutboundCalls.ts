import { randomUUID, createHash } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflarePhoneLease } from './_cloudflarePhoneLease'
import { OutboundError, validateBrief } from './_outboundBrief'
import { listTeam } from './_team'
import { ownsPhone } from './_phoneOwner'
import { phoneConfigured } from './_telephony'
import { deliverCallDetails } from './_callDelivery'
import { publicOutboundSession, terminal, advanceOutboundWebhook, requestOutboundDial, type Session } from './_outboundCalls'
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')"
type StoredSession=Session & {mutation_token:string}
const selection='SELECT c.*,r.document AS dial_receipt FROM nalu_outbound_calls c LEFT JOIN nalu_outbound_receipts r ON r.call_id=c.id AND r.user_id=c.user_id'
function decode(row:any):StoredSession|null{
  if(!row)return null
  const s={...row,brief:JSON.parse(row.brief),turns:JSON.parse(row.turns),delivery:row.delivery?JSON.parse(row.delivery):undefined,cancel_requested:!!row.cancel_requested} as StoredSession
  if(row.dial_receipt){
    const receipt=JSON.parse(row.dial_receipt)
    if(receipt.sid && s.sid && receipt.sid!==s.sid)throw new OutboundError('Carrier call identity conflict; inspect provider logs.',502)
    if(receipt.sid&&!s.sid)s.sid=receipt.sid
    if(s.state==='dialing'){s.state=receipt.error?'uncertain':'ringing';if(receipt.error)s.summary=receipt.error}
  }
  return s
}

export class CloudflareOutboundCalls {
  constructor(readonly store:CloudflareStore){}
  async get(id:string,uid?:string){
    return decode((await this.store.query(selection+' WHERE c.id=?'+(uid?' AND c.user_id=?':''),[id,...(uid?[uid]:[])])).results[0])
  }
  async list(uid:string){return (await this.store.query(selection+' WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 40',[uid])).results.map(decode) as StoredSession[]}
  async prepare(uid:string,body:any){
    const brief=validateBrief(body.brief)
    if(brief.to===process.env.TELNYX_PHONE_NUMBER)throw new OutboundError('Choose the recipient’s number, not Nalu’s own line.')
    if(typeof body.requestId!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(body.requestId))throw new OutboundError('A unique requestId is required.')
    const member=(await listTeam(this.store,uid)).find(m=>m.active&&m.id===body.memberId)
    if(!member)throw new OutboundError('Choose an active team member.')
    const fingerprint=createHash('sha256').update(JSON.stringify({brief,member:member.id})).digest('hex')
    const result=await this.store.batch([
      {sql:`INSERT INTO nalu_outbound_calls(id,user_id,request_id,fingerprint,brief,voice,member_id,expires_at) VALUES(?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes')) ON CONFLICT(user_id,request_id) DO NOTHING`,params:['call_'+randomUUID(),uid,body.requestId,fingerprint,JSON.stringify(brief),member.voice,member.id]},
      {sql:selection+' WHERE c.user_id=? AND c.request_id=?',params:[uid,body.requestId]},
    ])
    const s=decode(result.results[1].results[0])
    if(!s||s.fingerprint!==fingerprint)throw new OutboundError('That requestId belongs to a different call.',409)
    return s
  }
  async active(uid:string){
    return !!(await this.store.query("SELECT id FROM nalu_outbound_calls WHERE user_id=? AND state IN ('dialing','ringing','active','uncertain') AND julianday(updated_at)>julianday('now','-12 minutes') LIMIT 1",[uid])).results.length
  }
  async save(s:StoredSession,lease:string){
    const mutation=randomUUID(),done=terminal.has(s.state)
    const status=s.state==='prepared'?'queued':s.state==='failed'?'failed':s.state==='canceled'?'canceled':done?'done':'running'
    const result=[s.summary,s.evidence?`Recipient confirmation: ${s.evidence}`:'',...s.turns.map(t=>`${t.role==='assistant'?'Nalu':s.brief.recipient}: ${t.text}`)].filter(Boolean).join('\n\n')
    const saved=await this.store.batch([
      {sql:`UPDATE nalu_outbound_calls SET state=?1,sid=?2,turns=?3,turn=?4,outcome=?5,summary=?6,evidence=?7,response_xml=?8,request_hash=?9,cancel_requested=?10,delivery=?11,expires_at=?12,mutation_token=?13,updated_at=${now}
        WHERE id=?14 AND user_id=?15 AND mutation_token=?16 AND EXISTS(SELECT 1 FROM nalu_phone_leases WHERE user_id=?15 AND scope='outbound' AND token=?17 AND expires_at>${now}) RETURNING id`,
        params:[s.state,s.sid,JSON.stringify(s.turns),s.turn,s.outcome,s.summary,s.evidence,s.response_xml,s.request_hash,s.cancel_requested?1:0,JSON.stringify(s.delivery||null),s.expires_at,mutation,s.id,s.user_id,s.mutation_token,lease]},
      {sql:`INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta)
        SELECT ?1,?2,'mobile',?3,?4,?5,?6,'[]',?7 WHERE EXISTS(SELECT 1 FROM nalu_outbound_calls WHERE id=?1 AND user_id=?2 AND mutation_token=?8)
        ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,status=excluded.status,progress=excluded.progress,meta=excluded.meta,updated_at=${now} WHERE nalu_tasks.user_id=excluded.user_id`,
        params:[s.id,s.user_id,`Call ${s.brief.recipient}`,s.summary||`Call ${s.state.replace(/_/g,' ')}`,status,done?100:0,JSON.stringify({kind:'recipient-call',callId:s.id,destination:s.brief.to,outcome:s.outcome,result,memberId:s.member_id}),mutation]},
    ])
    if(!saved.results[0].results.length)throw new OutboundError('The call changed while this request was processing. Check its saved status.',503)
    s.mutation_token=mutation
  }
  async receipt(uid:string,id:string,result:any,error:string){
    const value=result?.sid||result?.call_sid
    await this.store.batch([{sql:'INSERT INTO nalu_outbound_receipts(call_id,user_id,document) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM nalu_outbound_calls WHERE id=?1 AND user_id=?2) ON CONFLICT(call_id) DO NOTHING',params:[id,uid,JSON.stringify({sid:typeof value==='string'&&value?value:null,error})]}])
  }
}

export async function handleCloudflareOutboundAction(store:CloudflareStore,uid:string,body:any,res:any):Promise<boolean>{
  if(!ownsPhone(uid))throw new OutboundError('This private Nalu number belongs to another account.',403)
  const repo=new CloudflareOutboundCalls(store)
  if(body.action==='recipient-list'){res.status(200).json({calls:(await repo.list(uid)).map(publicOutboundSession)});return true}
  if(body.action==='recipient-prepare'){res.status(200).json({call:publicOutboundSession(await repo.prepare(uid,body))});return true}
  if(typeof body.id!=='string')throw new OutboundError('Choose a prepared call.')
  const lease=new CloudflarePhoneLease(store,uid,'outbound'),token=await lease.claim()
  if(!token)throw new OutboundError('The current call is still processing. Check its status in a moment.',503)
  let s:StoredSession
  try{
    const saved=await repo.get(body.id,uid)
    if(!saved)throw new OutboundError('Call not found.',404)
    s=saved
    if(body.action==='recipient-cancel'){
      s.cancel_requested=true
      if(s.state==='prepared'){s.state='canceled';s.outcome='canceled';s.summary='Canceled before dialing.'}
      else if(!terminal.has(s.state))s.summary='Cancellation requested. Waiting for carrier confirmation.'
      await repo.save(s,token)
    }else{
      if(s.state!=='prepared'){res.status(200).json({call:publicOutboundSession(s),duplicate:true});return true}
      if(s.cancel_requested||Date.parse(s.expires_at)<Date.now())throw new OutboundError('This call brief has expired. Prepare a new call.',409)
      if(body.confirm!==true)throw new OutboundError('Confirm the reviewed call brief before dialing.')
      if(!phoneConfigured()||!(process.env.GEMINI_API_KEY||process.env.GOOGLE_AI_API_KEY||process.env.GOOGLE_GENAI_API_KEY))throw new OutboundError('Outbound calling is not configured.',503)
      if(await repo.active(uid))throw new OutboundError('Another call is active or unconfirmed. Check it before starting another.',409)
      s.expires_at=new Date(Date.now()+12*60000).toISOString();s.state='dialing';s.summary='Dial requested. Waiting for the recipient.'
      await repo.save(s,token) // Permanent fence before issuing a carrier request.
    }
  }finally{await lease.release(token).catch(()=>{})}
  if(body.action==='recipient-cancel'){
    if(s.sid&&!terminal.has(s.state)){
      const response=await fetch(`https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(process.env.TELNYX_ACCOUNT_SID!)}/Calls/${encodeURIComponent(s.sid)}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({Status:'completed'}),signal:AbortSignal.timeout(10000)})
      if(!response.ok)throw new OutboundError('Cancellation is pending; the carrier did not confirm it.',502)
    }
    res.status(200).json({call:publicOutboundSession(s)});return true
  }
  const {result,error}=await requestOutboundDial(s)
  await repo.receipt(uid,s.id,result,error)
  // A speech/status callback may be holding the lease while the dial HTTP
  // response arrives. Retain that receipt independently and merge it on read.
  const next=await lease.claim()
  try{const latest=await repo.get(s.id,uid);if(!latest)throw new OutboundError('Call not found.',404);s=latest;if(next)await repo.save(s,next)}
  finally{if(next)await lease.release(next).catch(()=>{})}
  res.status(202).json({call:publicOutboundSession(s)});return true
}

export async function handleCloudflareOutboundWebhook(store:CloudflareStore,q:any,form:Record<string,string>){
  const repo=new CloudflareOutboundCalls(store),initial=await repo.get(String(q.call||''))
  if(!initial||!ownsPhone(initial.user_id))throw new OutboundError('Call callback does not match the approved session.',403)
  const lease=new CloudflarePhoneLease(store,initial.user_id,'outbound'),token=await lease.claim()
  if(!token)throw new OutboundError('The call is still processing.',503)
  try{
    const s=await repo.get(initial.id,initial.user_id)
    if(!s)throw new OutboundError('Call not found.',403)
    const result=await advanceOutboundWebhook(s,q,form)
    if(result.changed)await repo.save(s,token)
    if(result.delivery)waitUntil(deliverCallDetails(s.user_id,s.id,result.delivery,true))
    return result.xml
  }finally{await lease.release(token).catch(()=>{})}
}
