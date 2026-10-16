import {createHash} from 'node:crypto'
import {ownsPhone} from './_phoneOwner'
import {CallConversation} from './_phonePlanConversation'
import type {CallDraft} from './_callDraft'
import {connectionBackend} from './_connectionBackend'
import {CloudflareStore} from './_cloudflareStore'
import {CloudflarePhonePlans} from './_cloudflarePhonePlans'
import type {ConnectionClient as Client} from './_connectionStore'
export type PlanSnapshot=ReturnType<CallConversation['snapshot']>
export async function ensurePhonePlans(c:Client){
 if(c instanceof CloudflareStore)return
 await c.query(`CREATE TABLE IF NOT EXISTS nalu_phone_plan_turns (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,sid TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',
 input JSONB NOT NULL,snapshot JSONB,reply TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
 await c.query('CREATE INDEX IF NOT EXISTS nalu_phone_plan_sid ON nalu_phone_plan_turns(user_id,sid,created_at DESC)')
}
export async function latestPhonePlan(c:Client,uid:string,sid:string):Promise<PlanSnapshot|null>{
 await ensurePhonePlans(c)
 if(c instanceof CloudflareStore)return new CloudflarePhonePlans(c).latest(uid,sid)
 return (await c.query("SELECT snapshot FROM nalu_phone_plan_turns WHERE user_id=$1 AND sid=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[uid,sid])).rows[0]?.snapshot||null
}
export async function enqueuePhonePlan(c:Client,uid:string,sid:string,event:string,utterance:string,draft?:CallDraft){
 if(!ownsPhone(uid))throw Error('This private line is unavailable.')
 await ensurePhonePlans(c)
 const id='plan_'+createHash('sha256').update(JSON.stringify([uid,sid,event])).digest('hex')
 if(c instanceof CloudflareStore)return new CloudflarePhonePlans(c).enqueue(uid,sid,id,utterance,draft)
 await c.query('BEGIN')
 try{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[uid+':phone-plan:'+sid])
  const prior=(await c.query('SELECT id FROM nalu_phone_plan_turns WHERE id=$1 AND user_id=$2',[id,uid])).rows[0]
  if(prior){await c.query('COMMIT');return prior.id as string}
  const busy=(await c.query("SELECT id FROM nalu_phone_plan_turns WHERE user_id=$1 AND sid=$2 AND status IN ('queued','working') ORDER BY created_at DESC LIMIT 1",[uid,sid])).rows[0]
  if(busy){await c.query('COMMIT');return busy.id as string}
  const snapshot=await latestPhonePlan(c,uid,sid)
  await c.query('INSERT INTO nalu_phone_plan_turns(id,user_id,sid,input,snapshot) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[id,uid,sid,JSON.stringify({utterance,draft}),JSON.stringify(snapshot)])
  await c.query('COMMIT');return id
 }catch(e){await c.query('ROLLBACK');throw e}
}
// The durable claim is never reclaimed: a crash after dialing must not replay
// an automatic request. The outbound session has its own one-way dial fence.
export async function processPhonePlan(uid:string,id:string){
 const backend=connectionBackend(),c=backend.client
 try{
  await backend.connect();await ensurePhonePlans(c)
  if(!ownsPhone(uid))return
  const job=c instanceof CloudflareStore?await new CloudflarePhonePlans(c).claim(uid,id):(await c.query("UPDATE nalu_phone_plan_turns SET status='working',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status='queued' RETURNING *",[id,uid])).rows[0]
  if(!job)return
  const conversation=new CallConversation(uid)
  if(job.snapshot)conversation.restore(job.snapshot)
  try{
   const result=job.input.draft?await conversation.begin(job.input.draft):await conversation.respond(job.input.utterance)
   const reply=result.unrelated?'I’ve stopped working on that call. What would you like to do next?':result.reply
   if(c instanceof CloudflareStore)await new CloudflarePhonePlans(c).finish(uid,id,'done',conversation.snapshot(),reply)
   else await c.query("UPDATE nalu_phone_plan_turns SET status='done',snapshot=$3::jsonb,reply=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2",[id,uid,JSON.stringify(conversation.snapshot()),reply])
  }catch{
   // Failure may occur after a carrier request. Preserve no automatic retry.
   const snapshot=conversation.snapshot();snapshot.active=false
   const reply='I couldn’t finish that request reliably. Check Recent calls in Nalu before trying again.'
   if(c instanceof CloudflareStore)await new CloudflarePhonePlans(c).finish(uid,id,'failed',snapshot,reply)
   else await c.query("UPDATE nalu_phone_plan_turns SET status='failed',snapshot=$3::jsonb,reply=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2",[id,uid,JSON.stringify(snapshot),reply])
  }
 }finally{await backend.close().catch(()=>{})}
}
export async function phonePlanResult(c:Client,uid:string,sid:string,id:string){
 await ensurePhonePlans(c)
 const row=c instanceof CloudflareStore?await new CloudflarePhonePlans(c).result(uid,sid,id):(await c.query('SELECT status,reply,updated_at FROM nalu_phone_plan_turns WHERE id=$1 AND user_id=$2 AND sid=$3',[id,uid,sid])).rows[0]
 if(!row)return {status:'failed',reply:'I couldn’t find that request. Check Recent calls in Nalu.'}
 if(row.status==='working' && Date.now()-new Date(String(row.updated_at)).getTime()>120000)return {status:'failed',reply:'That request is taking longer than expected. Check Recent calls before trying again.'}
 return {status:row.status as string,reply:row.reply as string}
}
