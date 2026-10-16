import { CloudflareStore } from './_cloudflareStore'
import { handleCloudflareOutboundAction, handleCloudflareOutboundWebhook } from './_cloudflareOutboundCalls'
import { waitUntil } from '@vercel/functions'
import { deliveryQuestion, deliveryStep, deliverCallDetails, type DeliveryState } from './_callDelivery'
import { createHash, randomUUID } from 'node:crypto'
import { OutboundError, validateBrief, recipientReply, type CallBrief, type CallTurn } from './_outboundBrief'
import { ownsPhone } from './_phoneOwner'
import { listTeam } from './_team'
import { publicBase, sign, verifySig, phoneConfigured, sayPolly, xmlEscape, type PhoneVoice } from './_telephony'

type PostgresClient = { query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }
export type Session = { id: string; user_id: string; request_id: string; fingerprint: string; brief: CallBrief; voice: PhoneVoice; member_id: string; state: string; sid: string | null; expires_at: string; turns: CallTurn[]; turn: number; outcome: string | null; summary: string; evidence: string; response_xml: string; request_hash: string; cancel_requested: boolean; delivery?: DeliveryState }
type Client = PostgresClient | CloudflareStore
export const terminal = new Set(['finished','failed','no_answer','canceled'])
export async function ensureOutboundSchema(c: Client) {
  if(c instanceof CloudflareStore)return
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_outbound_calls (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, brief JSONB NOT NULL,
    voice TEXT NOT NULL, member_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'prepared', sid TEXT UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL, turns JSONB NOT NULL DEFAULT '[]', turn INTEGER NOT NULL DEFAULT 0,
    outcome TEXT, summary TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '',
    response_xml TEXT NOT NULL DEFAULT '', request_hash TEXT NOT NULL DEFAULT '',
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,request_id));
    ALTER TABLE nalu_outbound_calls ADD COLUMN IF NOT EXISTS delivery JSONB;
    CREATE INDEX IF NOT EXISTS nalu_outbound_calls_owner ON nalu_outbound_calls(user_id,created_at DESC)`)
}
export function publicOutboundSession(s: Session) {
  return { id: s.id, brief: s.brief, memberId: s.member_id, state: s.state, outcome: s.outcome, summary: s.summary, evidence: s.evidence, transcript: s.turns, cancelRequested: s.cancel_requested, delivery: s.delivery }
}
export function outboundCallbackUrl(s: Session, step: string, turn = 0) {
  const expires = String(new Date(s.expires_at).getTime())
  const sig = sign(['recipient', s.id, s.brief.to, expires, step, turn].join('|'))
  return `${publicBase()}/api/phone?` + new URLSearchParams({ step, call: s.id, expires, turn: String(turn), sig })
}
function instruction(s: Session, reply: string, end = false, digits = '') {
  const say = digits ? `<Play digits="${digits}"/>` : sayPolly(reply, s.voice)
  if (end) return say + '<Hangup/>'
  const action = xmlEscape(outboundCallbackUrl(s, 'recipient-turn', s.turn + 1))
  return say + `<Gather input="speech" action="${action}" method="POST" timeout="${digits?20:8}" speechTimeout="2" language="en-US" />` + `<Redirect method="POST">${action}</Redirect>`
}
async function activity(c: PostgresClient, s: Session) {
  const done = terminal.has(s.state)
  const status = s.state === 'prepared' ? 'queued' : s.state === 'failed' ? 'failed' : s.state === 'canceled' ? 'canceled' : done ? 'done' : 'running'
  const result = [s.summary, s.evidence ? `Recipient confirmation: ${s.evidence}` : '', ...s.turns.map(t => `${t.role === 'assistant' ? 'Nalu' : s.brief.recipient}: ${t.text}`)].filter(Boolean).join('\n\n')
  await c.query(`INSERT INTO nalu_tasks (id,user_id,source,title,detail,status,progress,events,meta) VALUES ($1,$2,'mobile',$3,$4,$5,$6,'[]'::jsonb,$7::jsonb)
    ON CONFLICT (id) DO UPDATE SET detail=EXCLUDED.detail,status=EXCLUDED.status,progress=EXCLUDED.progress,meta=EXCLUDED.meta,updated_at=NOW()`, [s.id,s.user_id,`Call ${s.brief.recipient}`,s.summary || `Call ${s.state.replace(/_/g,' ')}`,status,done ? 100 : 0,JSON.stringify({ kind: 'recipient-call', callId: s.id, destination: s.brief.to, outcome: s.outcome, result, memberId: s.member_id })])
}
async function persist(c: PostgresClient, s: Session) {
  await c.query(`UPDATE nalu_outbound_calls SET state=$2,sid=$3,turns=$4::jsonb,turn=$5,outcome=$6,summary=$7,evidence=$8,response_xml=$9,request_hash=$10,cancel_requested=$11,delivery=$12::jsonb,expires_at=$13,updated_at=NOW() WHERE id=$1`,[s.id,s.state,s.sid,JSON.stringify(s.turns),s.turn,s.outcome,s.summary,s.evidence,s.response_xml,s.request_hash,s.cancel_requested,JSON.stringify(s.delivery||null),s.expires_at])
  await activity(c,s)
}
export async function handleOutboundAction(c: Client, uid: string, body: any, res: any): Promise<boolean> {
  if (!['recipient-prepare','recipient-start','recipient-list','recipient-cancel'].includes(body.action)) return false
  if(c instanceof CloudflareStore)return handleCloudflareOutboundAction(c,uid,body,res)
  await ensureOutboundSchema(c)
  if (body.action === 'recipient-list') {
    const rows = (await c.query('SELECT * FROM nalu_outbound_calls WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40',[uid])).rows
    res.status(200).json({ calls: rows.map(publicOutboundSession) }); return true
  }
  if (body.action === 'recipient-prepare') {
    const brief = validateBrief(body.brief)
    if (brief.to === process.env.TELNYX_PHONE_NUMBER) throw new OutboundError('Choose the recipient’s number, not Nalu’s own line.')
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(body.requestId)) throw new OutboundError('A unique requestId is required.')
    const member = (await listTeam(c,uid)).find(m => m.active && m.id === body.memberId)
    if (!member) throw new OutboundError('Choose an active team member.')
    const fingerprint = createHash('sha256').update(JSON.stringify({brief,member:member.id})).digest('hex')
    const id = `call_${randomUUID()}`
    const rows = (await c.query(`INSERT INTO nalu_outbound_calls (id,user_id,request_id,fingerprint,brief,voice,member_id,expires_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,NOW()+INTERVAL '30 minutes') ON CONFLICT (user_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *`,[id,uid,body.requestId,fingerprint,JSON.stringify(brief),member.voice,member.id])).rows
    const s = rows[0] as Session
    if (s.fingerprint !== fingerprint) throw new OutboundError('That requestId belongs to a different call.',409)
    res.status(200).json({ call: publicOutboundSession(s) }); return true
  }
  if (typeof body.id !== 'string') throw new OutboundError('Choose a prepared call.')
  let s: Session
  await c.query('BEGIN')
  try {
    // Serialize starts per owner, so repeated taps or concurrent clients cannot fan out calls.
    await c.query('SELECT id FROM nalu_users WHERE id=$1 FOR UPDATE',[uid])
    s = (await c.query('SELECT * FROM nalu_outbound_calls WHERE id=$1 AND user_id=$2 FOR UPDATE',[body.id,uid])).rows[0]
    if (!s) throw new OutboundError('Call not found.',404)
    if (body.action === 'recipient-cancel') {
      s.cancel_requested = true
      if (s.state === 'prepared') { s.state='canceled'; s.outcome='canceled'; s.summary='Canceled before dialing.' }
      else if (!terminal.has(s.state)) s.summary='Cancellation requested. Waiting for carrier confirmation.'
      await persist(c,s); await c.query('COMMIT')
      if (s.sid && !terminal.has(s.state)) {
        const r = await fetch(`https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(process.env.TELNYX_ACCOUNT_SID!)}/Calls/${encodeURIComponent(s.sid)}`,{method:'POST',headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({Status:'completed'}),signal:AbortSignal.timeout(10000)})
        if (!r.ok) throw new OutboundError('Cancellation is pending; the carrier did not confirm it.',502)
      }
      res.status(200).json({call:publicOutboundSession(s)}); return true
    }
    if (s.state !== 'prepared') { await c.query('COMMIT'); res.status(200).json({call:publicOutboundSession(s),duplicate:true}); return true }
    if (s.cancel_requested || new Date(s.expires_at).getTime() < Date.now()) throw new OutboundError('This call brief has expired. Prepare a new call.',409)
    if (body.confirm !== true) throw new OutboundError('Confirm the reviewed call brief before dialing.')
    if (!phoneConfigured() || !(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GOOGLE_GENAI_API_KEY)) throw new OutboundError('Outbound calling is not configured.',503)
    const active = (await c.query(`SELECT id FROM nalu_outbound_calls WHERE user_id=$1 AND state IN ('dialing','ringing','active','uncertain') AND updated_at>NOW()-INTERVAL '12 minutes' LIMIT 1`,[uid])).rows
    if (active.length) throw new OutboundError('Another call is active or unconfirmed. Check it before starting another.',409)
    s.expires_at=new Date(Date.now()+12*60_000).toISOString()
    s.state='dialing'; s.summary='Dial requested. Waiting for the recipient.'
    await persist(c,s)
    await c.query('COMMIT') // Durable one-way dial fence BEFORE the carrier side effect.
  } catch(error) { await c.query('ROLLBACK').catch(()=>{}); throw error }
  const {result,error}=await requestOutboundDial(s)
  await c.query('BEGIN')
  try {
    s=(await c.query('SELECT * FROM nalu_outbound_calls WHERE id=$1 FOR UPDATE',[s.id])).rows[0]
    const sid=result?.sid || result?.call_sid
    if (typeof sid==='string' && sid && s.sid && s.sid!==sid) throw new OutboundError('Carrier call identity conflict; inspect provider logs.',502)
    if (typeof sid==='string' && sid && !s.sid) s.sid=sid
    if (s.state==='dialing') { s.state=error ? 'uncertain':'ringing'; if(error) s.summary=error }
    await persist(c,s);await c.query('COMMIT')
  } catch(error) {await c.query('ROLLBACK').catch(()=>{});throw error}
  res.status(202).json({call:publicOutboundSession(s)});return true
}

// Caller already verified the provider's raw-body Ed25519 signature and Nalu line.
export async function handleOutboundWebhook(c: Client, q: any, form: Record<string,string>): Promise<string> {
  if(c instanceof CloudflareStore)return handleCloudflareOutboundWebhook(c,q,form)
  await ensureOutboundSchema(c)
  await c.query('BEGIN')
  try {
    const s:Session=(await c.query('SELECT * FROM nalu_outbound_calls WHERE id=$1 FOR UPDATE',[String(q.call||'')])).rows[0]
    const result=await advanceOutboundWebhook(s,q,form)
    if(result.changed)await persist(c,s)
    await c.query('COMMIT')
    if(result.delivery)waitUntil(deliverCallDetails(s.user_id,s.id,result.delivery,true))
    return result.xml
  } catch(error) {await c.query('ROLLBACK').catch(()=>{});throw error}
}

/** The same verified conversation state machine runs on both storage backends. */
export async function advanceOutboundWebhook(s:Session,q:any,form:Record<string,string>):Promise<{xml:string;changed:boolean;delivery?:DeliveryState}>{
  const step=String(q.step||''),id=String(q.call||''),expires=String(q.expires||''),turn=Number(q.turn),sid=String(form.CallSid||'')
  if (!['recipient-answer','recipient-turn','recipient-status'].includes(step) || !sid || !Number.isSafeInteger(turn) || turn<0) throw new OutboundError('Invalid call callback.',403)
    if (!s || !ownsPhone(s.user_id) || !Number.isFinite(Number(expires)) || Number(expires)!==new Date(s.expires_at).getTime() || !verifySig(['recipient',id,s.brief.to,expires,step,turn].join('|'),String(q.sig||'')) || form.To!==s.brief.to || form.From!==process.env.TELNYX_PHONE_NUMBER || (s.sid && s.sid!==sid) || s.state==='prepared') throw new OutboundError('Call callback does not match the approved session.',403)
    s.sid=sid
    if (step==='recipient-status') {
      const status=form.CallStatus
      if (!terminal.has(s.state)) {
        if (['busy','no-answer','failed','canceled','completed'].includes(status)) {
          s.state=s.cancel_requested || status==='canceled' ? 'canceled' : status==='failed' ? 'failed' : ['busy','no-answer'].includes(status) ? 'no_answer' : 'finished'
          s.outcome=s.outcome || (s.cancel_requested ? 'canceled' : status==='completed' ? 'unconfirmed' : status.replace('-','_'))
          s.summary=s.summary && s.outcome!=='unconfirmed' ? s.summary : s.cancel_requested ? 'Call canceled.' : status==='completed' ? 'Call ended without a confirmed outcome. Review the transcript.' : `Call ended: ${status}.`
        } else if (s.state!=='active' && ['ringing','in-progress'].includes(status)) s.state=status==='ringing' ? 'ringing':'active'
      }
      return {xml:'',changed:true}
    }
    if (terminal.has(s.state) || s.cancel_requested || Number(expires)<Date.now()) {
      if (!terminal.has(s.state)) {s.state='canceled';s.outcome='canceled';s.summary='Call stopped or session expired.';}
      return {xml:'<Hangup/>',changed:true}
    }
    const hash=createHash('sha256').update(JSON.stringify({step,turn,speech:form.SpeechResult||''})).digest('hex')
    if (s.response_xml && turn===s.turn) {
      if (hash!==s.request_hash) throw new OutboundError('Conflicting callback replay.',409)
      // A retry must not press a key again after the menu may have transferred.
      return {xml:s.turns[s.turns.length-1]?.digits ? s.response_xml.replace(/^<Play digits="[0-9]"\/>/,'') : s.response_xml,changed:false}
    }
    if ((step==='recipient-answer' && (turn!==0 || s.turn!==0 || s.turns.length)) || (step==='recipient-turn' && turn!==s.turn+1)) throw new OutboundError('Out-of-order call callback.',409)
    let reply:string,end=false,digits=''
    if (step==='recipient-answer') {
      reply=`Hello, I’m Nalu, an AI assistant calling on behalf of ${s.brief.onBehalfOf}. ${s.brief.purpose}`
      s.state='active'
    } else {
      const text=String(form.SpeechResult||'').trim().slice(0,2000)
      s.turn=turn
      if (text) s.turns.push({role:'recipient',text})
      if (!text || turn>=24) {
        reply=!text ? 'I’m sorry we could not connect. I’ll let them know. Goodbye.' : 'I’ll check the remaining details with them. Thank you for your time.'
        end=true;s.outcome=s.outcome || (!text ? 'no_response':'needs_owner');s.summary=s.summary || (!text ? 'No spoken response was received.' : 'Call reached its conversation limit; owner follow-up is needed.')
      } else if (/\b(stop calling|do not call|don't call|remove (me|us)|not interested|hang up)\b/i.test(text)) {
        reply='Understood. I’ll end the call now. Goodbye.';end=true;s.outcome='declined';s.summary='Recipient asked to stop the call. Do not call again without fresh permission.'
      } else if(s.delivery && s.delivery.phase!=='done') {
        const next=deliveryStep(s.delivery,text,'',true);s.delivery=next.state;reply=next.ready?'Got it. I’ll request that follow-up. Thank you for your time.':next.reply;end=next.state.phase==='done'
      } else {
        try {
          const answer=await recipientReply(s.brief,s.turns)
          digits=answer.digits || ''
          reply=digits?`Menu option ${digits} requested.`:answer.reply;end=answer.outcome!=='continue'
          if(!digits && s.turns[s.turns.length-2]?.digits && !(/\bNalu\b/i.test(reply) && /\bAI assistant\b/i.test(reply))) reply=`Hello, I’m Nalu, an AI assistant calling on behalf of ${s.brief.onBehalfOf}. `+reply
          if(end){s.outcome=answer.outcome;s.summary=answer.summary;s.evidence=answer.evidence}
          if(answer.outcome==='confirmed'){s.delivery={phase:'ask',content:s.summary};reply=reply+' '+deliveryQuestion(true);end=false}
        } catch {reply='I’m sorry, I need to check with the person I’m calling for. Thank you for your time.';end=true;s.outcome='needs_owner';s.summary='The assistant could not continue reliably. Review the transcript and follow up.'}
      }
    }
    s.turns.push({role:'assistant',text:reply,...(digits?{digits}:{})})
    if(end)s.state='finished'
    s.response_xml=instruction(s,reply,end,digits);s.request_hash=hash
    return {xml:s.response_xml,changed:true,delivery:s.delivery?.confirmed?s.delivery:undefined}
}

export async function requestOutboundDial(s:Session){
  let result: any, error = ''
  try {
    const r=await fetch(`https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(process.env.TELNYX_ACCOUNT_SID!)}/Calls`,{method:'POST',headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({ApplicationSid:process.env.TELNYX_APPLICATION_SID,From:process.env.TELNYX_PHONE_NUMBER,To:s.brief.to,Url:outboundCallbackUrl(s,'recipient-answer'),UrlMethod:'POST',StatusCallback:outboundCallbackUrl(s,'recipient-status'),StatusCallbackMethod:'POST',StatusCallbackEvent:'initiated ringing answered completed',Timeout:35,TimeLimit:480}),signal:AbortSignal.timeout(10000)})
    result=await r.json().catch(()=>({}))
    if (!r.ok) error=`Carrier returned HTTP ${r.status}; call delivery is unconfirmed.`
    else if (!result.sid && !result.call_sid && !['queued','initiated','ringing','in-progress'].includes(result.status)) error='Carrier response was unclear; call delivery is unconfirmed.'
  } catch { error='Call delivery is unconfirmed. Do not redial until its status is resolved.' }
  return {result,error}
}
