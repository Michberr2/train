import { createHash } from 'node:crypto'
import { ensureSchema, normalizePhone } from './_db'
import { ensureTaskSchema } from './_tasks'
import { saveMessage } from './_messageStore'
import { sendMessageOnce } from './_messageTransport'
import { canMessagePhone } from './_messageConsent'
import { sendConnectedEmail } from './connect'
import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { CloudflareCallDelivery } from './_cloudflareCallDelivery'
export type DeliveryDestination = {channel:'email'|'text'|'app';address:string}
export type DeliveryState = {phase:'ask'|'confirm'|'done';content:string;destination?:DeliveryDestination;confirmed?:boolean}
const yes=/^(?:yes|yeah|yep|correct|right|that(?:'s| is) (?:right|correct)|yes[ ,]+(?:please|that(?:'s| is) (?:right|correct))|go ahead|send it)[.!?]*$/i
const skip=/^(?:no(?: thanks)?|nope|skip(?: it)?|never mind|nevermind|don'?t send(?: (?:it|anything))?|nothing|leave it here)[.!?]*$/i
export const deliveryQuestion=(external=false)=>external?'Where would you like the follow-up emailed? Or we can leave it here.':'Where should I send these details—email, text, or keep them in Nalu?'
export function deliveryStep(state:DeliveryState, said:string, profilePhone='', external=false):{state:DeliveryState;reply:string;ready:boolean} {
  if(state.phase==='done') return {state,reply:'Those delivery details are already saved.',ready:false}
  if(skip.test(said.trim()))return {state:{...state,phase:'done',confirmed:false,destination:undefined},reply:'No problem. I won’t send anything.',ready:false}
  if(state.phase==='confirm'&&state.destination&&yes.test(said.trim())) return {state:{...state,phase:'done',confirmed:true},reply:'Got it. I’ll use that destination.',ready:true}
  let destination:DeliveryDestination|undefined
  const normalized=said.toLowerCase().replace(/\s+(?:at|at sign)\s+/g,'@').replace(/\s+dot\s+/g,'.')
  const email=normalized.match(/\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}\b/g)
  if(email?.length===1&&email[0].length<=254&&!email[0].includes('..'))destination={channel:'email',address:email[0]}
  else if(/\b(?:app|in nalu|keep (?:it|them|these) here)\b/i.test(said)&&!external)destination={channel:'app',address:'Nalu'}
  else if(/\b(?:text|sms|phone|number)\b/i.test(said)&&!external){
    const number=said.match(/\+?\d[\d ()-]{6,}\d/)
    const address=number?normalizePhone(number[0]):/\b(?:me|my (?:phone|number)|this number)\b/i.test(said)?profilePhone:''
    if(address)destination={channel:'text',address}
    else return {state:{...state,phase:'ask',destination:undefined},reply:'What number should I use, including the country code?',ready:false}
  }
  if(!destination)return {state:{...state,phase:'ask',destination:undefined},reply:deliveryQuestion(external),ready:false}
  const label=destination.channel==='email'?destination.address.replace('@',' at ').replace(/\./g,' dot '):destination.channel==='text'?destination.address.split('').join(' '):'Nalu'
  return {state:{...state,phase:'confirm',destination,confirmed:false},reply:`${destination.channel==='app'?'Keep these details in':'Send these details to'} ${label}. Is that right?`,ready:false}
}
// Durable one-way claim before any send. A retried webhook cannot send twice.
export async function deliverCallDetails(uid:string,id:string,state:DeliveryState,external=false):Promise<void>{
  if(!state.confirmed||state.phase!=='done'||!state.destination)return
  const backend=connectionBackend(),c=backend.client;const taskId='delivery_'+createHash('sha256').update(uid+'|'+id).digest('hex').slice(0,40)
  try{
    await backend.connect();if(!(c instanceof CloudflareStore)){await ensureSchema(c as any);await ensureTaskSchema(c as any)}
    const destination=state.destination
    let status='saved',detail='Saved in Nalu.'
    if(c instanceof CloudflareStore){if(!await new CloudflareCallDelivery(c).claim(uid,id,taskId,state))return}
    else {
    await c.query('BEGIN')
    const result=await c.query(`INSERT INTO nalu_user_data(user_id,key,value,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(user_id,key) DO NOTHING RETURNING key`,[uid,'call-delivery:'+id,JSON.stringify({...state,status:'sending'})])
    if(!result.rows.length){await c.query('ROLLBACK');return}
    await c.query(`INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta) VALUES($1,$2,'mobile','Call follow-up',$3,'running',0,'[]'::jsonb,$4::jsonb) ON CONFLICT(id) DO NOTHING`,[taskId,uid,'Preparing your confirmed call follow-up.',JSON.stringify({kind:'call-delivery',result:state.content,destination,deliveryStatus:'sending'})])
    await c.query('COMMIT')
    }
    try{
      if(destination.channel==='email'){
        const sent=await sendConnectedEmail(c,uid,{to:destination.address,subject:'Your Nalu call follow-up',text:state.content+'\n\n— Nalu'})
        status=sent.ok?'accepted':'unconfirmed';detail=sent.ok?'Email provider accepted the follow-up. Inbox delivery is not confirmed.':sent.detail
      }else if(destination.channel==='text'){
        const saved=normalizePhone(c instanceof CloudflareStore ? await new CloudflareMessages(c).phone(uid) : (await c.query('SELECT phone FROM nalu_users WHERE id=$1',[uid])).rows[0]?.phone||'')
        if(external||destination.address!==saved||!await canMessagePhone(c,uid,saved)){status='unavailable';detail='Text delivery requires your saved phone number and its START opt-in. Details are saved here.'}
        else{
          const row=await saveMessage(c,uid,{requestId:'call-delivery:'+id,direction:'outbound',from:process.env.TELNYX_PHONE_NUMBER||'',to:saved,text:state.content.length>1450?state.content.slice(0,1450)+'\nFull details are saved in Nalu.':state.content,taskId})
          await sendMessageOnce(c,row)
          status=(c instanceof CloudflareStore ? (await new CloudflareMessages(c).get(uid,row.id))?.status : (await c.query('SELECT status FROM nalu_messages WHERE id=$1',[row.id])).rows[0]?.status)||'unconfirmed';detail='Text delivery: '+status+'. Full details are saved here.'
        }
      }
    }catch{status='unconfirmed';detail='Delivery could not be confirmed. Check the provider before retrying. Details are saved here.'}
    if(c instanceof CloudflareStore) await new CloudflareCallDelivery(c).finish(uid,id,taskId,state,status,detail)
    else {
    await c.query('UPDATE nalu_user_data SET value=$3::jsonb,updated_at=NOW() WHERE user_id=$1 AND key=$2',[uid,'call-delivery:'+id,JSON.stringify({...state,status,detail})])
    await c.query(`UPDATE nalu_tasks SET status=$3,detail=$4,progress=1,meta=meta||$5::jsonb,updated_at=NOW() WHERE id=$1 AND user_id=$2`,[taskId,uid,['saved','accepted','delivered','sent'].includes(status)?'done':'failed',detail,JSON.stringify({deliveryStatus:status})])
    }
  }catch(error){if(!(c instanceof CloudflareStore))await c.query('ROLLBACK').catch(()=>{});throw error}finally{await backend.close().catch(()=>{})}
}
