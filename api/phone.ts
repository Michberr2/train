import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { CloudflarePhoneState } from './_cloudflarePhoneState'
import {latestPhonePlan,enqueuePhonePlan,processPhonePlan,phonePlanResult} from './_phonePlans'
import { deliveryQuestion, deliveryStep, deliverCallDetails, type DeliveryState } from './_callDelivery'
import { readLocation } from './_placeContext'
// Phone-call brain (Telnyx Programmable Voice). One webhook drives the whole
// two-way call: Nalu greets, listens (Telnyx speech-to-text), replies in a natural
// British voice (our Fish Audio TTS via <Play>), and — when you ask — launches an
// AutoPilot flow or just chats. Works for BOTH directions:
//   • Inbound  — you call the Nalu number; we match your caller-ID to your account
//                so the call acts as you (personalized chat, your flows).
//   • Outbound — POST /api/call places a call whose TeXML points here with ?step=outbound.
//
// Telnyx config (set as Vercel env, then point your number's Voice webhook at
// https://n4lu.ai/api/phone): TELNYX_API_KEY, TELNYX_ACCOUNT_SID, TELNYX_APPLICATION_SID, TELNYX_PUBLIC_KEY, TELNYX_PHONE_NUMBER.
import { handleOutboundWebhook } from './_outboundCalls'
import { OutboundError } from './_outboundBrief'
import { waitUntil } from '@vercel/functions'
import { queueImageRequest, processMessages } from './_messageWorker'
import { ensureSchema, normalizePhone, tokenForUserId } from './_db'
import { enqueueTask, ensureTaskSchema } from './_tasks'
import { resolveVoiceRoute } from './_voiceRoute'
import { handleTaskQuestionPhone } from './_taskQuestionPhone'
import crypto from 'node:crypto'
import { listTeam, selectTeamMember, type TeamMember } from './_team'
import { ownsPhone, privatePhoneUser } from './_phoneOwner'
import type { PhoneVoice } from './_telephony'
import {
  parseForm, readWebhookBody, validateSignature, requestUrl, sendCallXml, speak, sayPolly, publicBase, sign, verifySig, chatReply, phoneConfigured, forSpeech, xmlEscape,
} from './_telephony'

// Preserve exact bytes for Ed25519 verification. Configure TeXML for POST.
export const config = { api: { bodyParser: false } }

type Turn = { role: 'user' | 'assistant'; content: string }
type CallState = { userId?: string; token?: string; history: Turn[]; reprompts: number; members?: TeamMember[]; memberId?: string; delivery?: DeliveryState; deliveryId?: string; pendingImage?: {prompt:string;requestId:string;memberId?:string} }
type CallContext = { uid: string; expires: string; contextSig: string }

function callContext(userId: string, sid: string): CallContext {
  const expires = String(Date.now() + 2 * 60 * 60_000)
  return { uid: userId, expires, contextSig: sign(['phone', userId, sid, expires].join('|')) }
}

// Per-call state keyed by Telnyx's CallSid. Persisted in the caller's KV store when
// we know who they are (so history survives across Telnyx's stateless webhooks);
// falls back to a single-turn conversation for unidentified callers.
function stateKey(sid: string): string { return `phonecall:${sid}` }
async function loadState(userId: string, sid: string): Promise<CallState | null> {
  const backend=connectionBackend(),c=backend.client
  if(c instanceof CloudflareStore)return new CloudflarePhoneState(c).read(userId,sid)
  try {
    await backend.connect()
    const r = await c.query('SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = $2', [userId, stateKey(sid)])
    const v = r.rows[0]?.value
    return v && typeof v === 'object' ? (v as CallState) : null
  } catch { return null } finally { await backend.close().catch(() => {}) }
}
async function saveState(userId: string, sid: string, st: CallState): Promise<void> {
  const backend=connectionBackend(),c=backend.client
  if(c instanceof CloudflareStore)return new CloudflarePhoneState(c).save(userId,sid,{...st,history:st.history.slice(-32)})
  try {
    await backend.connect()
    // keep the last ~12 turns so a long call doesn't grow unbounded
    const trimmed: CallState = { ...st, history: st.history.slice(-32) }
    await c.query(
      `INSERT INTO nalu_user_data (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [userId, stateKey(sid), JSON.stringify(trimmed)],
    )
  } catch { /* best-effort */ } finally { await backend.close().catch(() => {}) }
}
async function clearState(userId: string, sid: string): Promise<void> {
  const backend=connectionBackend(),c=backend.client
  if(c instanceof CloudflareStore)return new CloudflarePhoneState(c).clear(userId,sid)
  try {
    await backend.connect()
    const r = await c.query('DELETE FROM nalu_user_data WHERE user_id = $1 AND key = $2 RETURNING value', [userId, stateKey(sid)])
    const token = r.rows[0]?.value?.token
    if (token) await c.query('DELETE FROM nalu_sessions WHERE token = $1 AND user_id = $2', [token, userId])
  }
  catch { /* */ } finally { await backend.close().catch(() => {}) }
}

// A <Gather> that listens for speech and posts the transcript back to ?step=handle.
function listen(prompt: string, sid: string, voice: PhoneVoice, context?: CallContext, reprompts = 0): string {
  const params = new URLSearchParams({ sid, voice, ...(context || {}) })
  const action = `${publicBase()}/api/phone?step=handle&${params}`
  const reprompt = `${publicBase()}/api/phone?step=reprompt&attempt=${reprompts + 1}&${params}`
  return (
    `<Gather input="dtmf speech" finishOnKey="#" timeout="8" action="${xmlEscape(action)}" method="POST" speechTimeout="1" language="en-US" hints="Nalu,train,naludesktop,autopilot">` +
    (prompt ? speak(prompt, voice) : '') +
    `</Gather>` +
    `<Redirect method="POST">${xmlEscape(reprompt)}</Redirect>`
  )
}

function planWait(id:string,sid:string,voice:PhoneVoice,context:CallContext,prompt=''){
 const url=`${publicBase()}/api/phone?`+new URLSearchParams({step:'plan-poll',plan:id,sid,voice,...context})
 return (prompt?speak(prompt,voice):'')+`<Pause length="2"/><Redirect method="POST">${xmlEscape(url)}</Redirect>`
}
function runPlan(uid:string,id:string){waitUntil(processPhonePlan(uid,id).catch(()=>console.error('[phone] planning worker failed')))}

const BYE = /\b(good ?bye|bye bye|hang up|that'?s all|that is all|nothing else|we'?re done|i'?m done|talk later|see you)\b/i
const LAUNCH = /\b(run|launch|start|kick ?off|set ?off|fire ?off|execute|trigger)\b/i

// Very light flow name-match: pull the user's flows and find the best title hit.
async function findFlow(userId: string, said: string): Promise<{ id: string; name: string } | null> {
  const backend=connectionBackend(),c=backend.client
  try {
    await backend.connect()
    let value = c instanceof CloudflareStore ? (await new CloudflareDataStore(c).read(userId,['nalu-agent-flows'])).values['nalu-agent-flows'] : (await c.query("SELECT value FROM nalu_user_data WHERE user_id = $1 AND key = 'nalu-agent-flows'", [userId])).rows[0]?.value
    for (let i = 0; i < 6 && typeof value === 'string'; i++) { try { value = JSON.parse(value) } catch { return null } }
    const flows = (Array.isArray(value) ? value : []) as { id?: string; name?: string }[]
    if (!flows.length) return null
    const normalized = ' ' + said.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '
    const matches = flows.filter(f => f.id && f.name && normalized.includes(' ' + f.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' '))
    return matches.length === 1 ? { id: String(matches[0].id), name: String(matches[0].name) } : null
  } catch { return null } finally { await backend.close().catch(() => {}) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  if (!phoneConfigured()) { res.status(503).end(); return }
  let raw: Buffer
  try { raw = await readWebhookBody(req) } catch { res.status(400).end(); return }
  if (!validateSignature(raw, req.headers['telnyx-timestamp'], req.headers['telnyx-signature-ed25519'])) {
    res.status(403).end(); return
  }
  const form = parseForm({ body: raw })

  const q = req.query || {}
  const step = String(q.step || '')
  const sid = String(form.CallSid || '')
  if (!sid || (q.sid && String(q.sid) !== sid)) { res.status(400).end(); return }
  let voice: PhoneVoice = (String(q.voice || 'britishWoman') === 'britishMan' ? 'britishMan' : 'britishWoman') as 'britishWoman' | 'britishMan'
  const from = String(form.From || '')

  try {
    const outbound = step.startsWith('recipient-') || step === 'outbound' || step === 'task-question' || String(form.Direction || '').startsWith('outbound')
    const line = normalizePhone(outbound ? String(form.From || '') : String(form.To || ''))
    if (line !== normalizePhone(process.env.TELNYX_PHONE_NUMBER || '')) return res.status(403).end()
    if (step.startsWith('recipient-')) {
      const backend=connectionBackend(),c=backend.client
      try { await backend.connect(); if(!(c instanceof CloudflareStore))await ensureSchema(c as any); return sendCallXml(res, await handleOutboundWebhook(c, q, form)) }
      finally { await backend.close().catch(() => {}) }
    }
    if (step === 'task-question') return await handleTaskQuestionPhone(req, res, form)
    // Identify the caller by their phone number → act as that account.
    let userId: string | undefined
    let name = ''
    let context: CallContext | undefined
    if (step !== 'outbound' && (q.uid || q.contextSig)) {
      const uid = String(q.uid || ''), expires = String(q.expires || ''), contextSig = String(q.contextSig || '')
      if (!uid || !Number.isFinite(Number(expires)) || Number(expires) < Date.now() || !verifySig(['phone', uid, sid, expires].join('|'), contextSig)) {
        return sendCallXml(res, sayPolly('This call session has expired. Please call again.') + '<Hangup/>')
      }
      userId = uid
      context = { uid, expires, contextSig }
    } else if (from && step !== 'outbound' && !String(form.Direction || '').startsWith('outbound')) {
      const backend=connectionBackend(),c=backend.client
      try { await backend.connect(); if(!(c instanceof CloudflareStore))await ensureSchema(c as any); const u = await privatePhoneUser(c, from); if (u) { userId = u.id; name = u.display_name } }
      finally { await backend.close().catch(() => {}) }
    }

    // ---- OUTBOUND: Nalu placed this call; play the prepared message, then listen.
    if (step === 'outbound') {
      const msg = String(q.msg || 'Hello, this is Nalu calling.')
      const uid = String(q.uid || '')
      const s = String(q.sig || ''), to = String(q.to || ''), expires = String(q.expires || '')
      if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now() || to !== String(form.To || '') || !verifySig([uid, msg, to, expires, ...(q.memberId ? [String(q.memberId)] : [])].join('|'), s)) {
        return sendCallXml(res, sayPolly('This call could not be verified. Goodbye.') + '<Hangup/>')
      }
      if (!ownsPhone(uid)) return sendCallXml(res, sayPolly('This private line is unavailable for this account.') + '<Hangup/>')
      const members = await readTeam(uid)
      const member = members.find(m => m.active && m.id === String(q.memberId || '')) || (!q.memberId ? members[0] : undefined)
      if (!member) return sendCallXml(res, sayPolly('That team member is unavailable.') + '<Hangup/>')
      voice = member.voice as PhoneVoice
      if (uid) {
        await saveState(uid, sid, { userId: uid, history: [{ role: 'assistant', content: msg }], reprompts: 0, members, memberId: member.id })
        context = callContext(uid, sid)
      }
      return sendCallXml(res, speak(msg, voice) + listen('What would you like me to do?', sid, voice, context))
    }

    if (!ownsPhone(userId)) return sendCallXml(res, sayPolly('This is a private Nalu line. Please call from the number saved on your account.') + '<Hangup/>')

    if (userId && !context) context = callContext(userId, sid)

    if(step==='plan-poll'){
      const backend=connectionBackend(),c=backend.client
      const st=await loadState(userId!,sid)
      voice=(st?.members?.find(m=>m.id===st.memberId)?.voice||voice) as PhoneVoice
      try{
        await backend.connect()
        const id=String(q.plan||'')
        const result=await phonePlanResult(c,userId!,sid,id)
        if(result.status==='queued'){runPlan(userId!,id);return sendCallXml(res,planWait(id,sid,voice,context!))}
        if(result.status==='working')return sendCallXml(res,planWait(id,sid,voice,context!))
        if(st && st.history[st.history.length-1]?.content!==result.reply){st.history.push({role:'assistant',content:result.reply});await saveState(userId!,sid,st)}
        return sendCallXml(res,speak(result.reply,voice)+listen('',sid,voice,context))
      }finally{await backend.close().catch(()=>{})}
    }

    // ---- INBOUND start: greet and open the mic.
    if (!step || step === 'start') {
      const members = await readTeam(userId!)
      voice = members[0].voice as PhoneVoice
      if (userId) await saveState(userId, sid, { userId, history: [], reprompts: 0, members, memberId: members[0].id })
      const hi = userId
        ? `Hi ${name.split('@')[0] || 'there'}, it's Nalu. What can I do for you?`
        : `Hi, you've reached Nalu. What can I do for you?`
      return sendCallXml(res, listen(hi, sid, voice, context))
    }

    // ---- REPROMPT: Gather heard nothing.
    if (step === 'reprompt') {
      const st = userId ? await loadState(userId, sid) : null
      voice = (st?.members?.find(m => m.id === st.memberId)?.voice || voice) as PhoneVoice
      const n = Math.max((st?.reprompts || 0) + 1, Number(q.attempt) || 1)
      if (n >= 4) {
        if (userId) await clearState(userId, sid)
        return sendCallXml(res, speak('I’ll let you go for now. Talk soon.', voice) + '<Hangup/>')
      }
      if (userId && st) await saveState(userId, sid, { ...st, reprompts: n })
      return sendCallXml(res, listen(n === 2 ? 'Still with me?' : '', sid, voice, context, n))
    }

    // ---- HANDLE: we have a transcript of what the caller said.
    const said = String(form.Digits || form.SpeechResult || '').trim()
    if (!said) {
      return sendCallXml(res, listen('Sorry, I didn’t catch that — could you say it again?', sid, voice, context))
    }

    const st: CallState = (userId ? await loadState(userId, sid) : null) || { userId, token: undefined, history: [], reprompts: 0 }
    if (st.delivery && st.delivery.phase !== 'done' && userId) {
      const backend=connectionBackend(),c=backend.client;let profile=''
      try {await backend.connect();profile=normalizePhone(c instanceof CloudflareStore?await new CloudflareMessages(c).phone(userId):(await c.query('SELECT phone FROM nalu_users WHERE id=$1',[userId])).rows[0]?.phone||'')} finally {await backend.close().catch(()=>{})}
      const next=deliveryStep(st.delivery,BYE.test(said)?'skip':said,profile)
      st.delivery=next.state
      await saveState(userId,sid,st)
      let reply=next.ready?'Got it. You can check delivery in Nalu. Anything else?':next.reply
      if(st.pendingImage && next.state.phase==='done'){
        const image=st.pendingImage
        if(next.ready && next.state.destination){
          const backend=connectionBackend(),c=backend.client
          try{await backend.connect();if(!(c instanceof CloudflareStore))await ensureSchema(c as any);if(!(c instanceof CloudflareStore))await ensureTaskSchema(c as any);await queueImageRequest(c,userId,image.prompt,image.requestId,image.memberId,next.state.destination);waitUntil(processMessages(userId));reply='Your image is queued. I’ll use the destination you confirmed. Anything else?';st.pendingImage=undefined}
          catch(error){st.delivery={phase:'ask',content:image.prompt};reply=(error instanceof Error?error.message:'I couldn’t queue the image.')+' '+deliveryQuestion()}
          finally{await backend.close().catch(()=>{})}
        }else{st.pendingImage=undefined;reply='No problem. I haven’t started the image.'}
        await saveState(userId,sid,st)
      }else if(next.ready) waitUntil(deliverCallDetails(userId,st.deliveryId || sid,next.state))
      if(BYE.test(said)){await clearState(userId,sid);return sendCallXml(res,speak('No problem. Goodbye!',voice)+'<Hangup/>')}
      return sendCallXml(res,listen(reply,sid,voice,context))
    }
    st.members = await readTeam(userId!)
    const selected = selectTeamMember(st.members, said)
    const current = st.members.find(m => m.active && m.id === st.memberId) || st.members[0]
    voice = current.voice as PhoneVoice
    if (selected) {
      st.memberId = selected.id
      voice = selected.voice as PhoneVoice
      await saveState(userId!, sid, st)
      return sendCallXml(res, listen(`This is ${selected.name}, your ${selected.role}. What can I help with?`, sid, voice, context))
    }
    if (/^(?:who(?:'s| is) (?:on|in) (?:my |the )?team|(?:list|show|read)(?: me)? (?:my |the )?(?:team|extensions)|team directory)[.!?]?$/i.test(said)) {
      const reply = st.members.filter(m => m.active).map(m => `${m.name}, ${m.role}, extension ${String(m.extension).split('').join(' ')}`).join('. ')
      return sendCallXml(res, listen(reply + '. Say a name or enter an extension followed by pound.', sid, voice, context))
    }
    if (/^(?:(?:extension|ext)\s*)?\d{3,4}[.!]?$/i.test(said)) return sendCallXml(res, listen('I could not find that extension. Say team directory to hear your team.', sid, voice, context))
    st.reprompts = 0
    st.history.push({ role: 'user', content: said })

    if(/^(?:please )?(?:send|email|text|share)(?: me)? (?:that|this|the (?:details|answer|summary|information))(?: please)?[.!?]*$/i.test(said)){
      const details=st.history.filter(turn=>turn.role==='assistant').map(turn=>turn.content).join('\n\n')
      if(details){st.delivery={phase:'ask',content:details};st.deliveryId=sid+':'+crypto.createHash('sha256').update(raw).digest('hex').slice(0,16);await saveState(userId!,sid,st);return sendCallXml(res,listen(deliveryQuestion(),sid,voice,context))}
    }

    // Goodbye → wrap up.
    if (BYE.test(said)) {
      const details=st.history.filter(turn=>turn.role==='assistant').map(turn=>turn.content).join('\n\n')
      if(userId && !st.delivery && details.length>60){
        st.delivery={phase:'ask',content:details};st.deliveryId=sid
        await saveState(userId,sid,st)
        return sendCallXml(res,listen('Before you go, '+deliveryQuestion().replace(/^Where/,'where'),sid,voice,context))
      }
      if (userId) await clearState(userId, sid)
      return sendCallXml(res, speak('Great talking with you. Goodbye!', voice) + '<Hangup/>')
    }

    // Follow-up details belong to the saved call plan, not general chat.
    {
      const backend=connectionBackend(),c=backend.client
      try{
        await backend.connect()
        const plan=await latestPhonePlan(c,userId!,sid)
        if(plan?.active){
          const id=await enqueuePhonePlan(c,userId!,sid,crypto.createHash('sha256').update(raw).digest('hex'),said)
          await saveState(userId!,sid,st);runPlan(userId!,id)
          return sendCallXml(res,planWait(id,sid,voice,context!))
        }
      }finally{await backend.close().catch(()=>{})}
    }

    // Queue execution durably and return TeXML promptly. The desktop worker
    // waits for completion; a carrier webhook cannot wait for a whole pipeline.
    const repoMatch = said.match(/\b(?:in|on|for|inside)\s+(?:the\s+)?(train|nalu\s*desktop)\b/i)
    if (userId) {
      const flow = LAUNCH.test(said) && !/\b(?:not|don't|never|explain|how)\b/i.test(said) && !repoMatch ? await findFlow(userId, said) : null
      let clarification = ''
      let body: Record<string, unknown> | undefined = flow
          ? { kind: 'pipeline', flowId: flow.id, mode: 'run' }
          : undefined
      if (!body) {
        const backend=connectionBackend(),c=backend.client
        try {
          await backend.connect()
          if(!(c instanceof CloudflareStore))await ensureSchema(c as any)
          if(!(c instanceof CloudflareStore))await ensureTaskSchema(c as any)
          const workers = c instanceof CloudflareStore ? await new CloudflareMessages(c).workers(userId) : (await c.query('SELECT repos,kinds FROM nalu_task_workers WHERE user_id=$1 ORDER BY last_seen_at DESC LIMIT 100', [userId])).rows.map(row=>({repos:row.repos,kinds:row.kinds}))
          const savedLocation:any=c instanceof CloudflareStore?(await new CloudflareDataStore(c).read(userId,['phone-current-location'])).values['phone-current-location']:(await c.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='phone-current-location'",[userId])).rows[0]?.value
          let timezone=typeof savedLocation?.timezone==='string'?savedLocation.timezone:''
          try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{timezone=''}
          const route = await resolveVoiceRoute(st.history.slice(-32), workers, undefined, true, { members: st.members, selectedId: st.memberId }, true, await readLocation(c,userId), {timezone:timezone||'UTC'})
          if(route.type==='callDraft'){
            if(!timezone && !route.draft.area)delete route.draft.fields.timezone
            const id=await enqueuePhonePlan(c,userId,sid,crypto.createHash('sha256').update(raw).digest('hex'),said,route.draft)
            await saveState(userId,sid,st);runPlan(userId,id)
            return sendCallXml(res,planWait(id,sid,voice,context!,'I’ll work on that now.'))
          }
          if (route.type === 'image') {
            const requestId='phone-image:'+crypto.createHash('sha256').update(raw).digest('hex').slice(0,40)
            const artist=st.members.find(m=>m.id===route.memberId)||st.members.find(m=>m.role==='Creative director')
            if (artist) { st.memberId=artist.id; voice=artist.voice as PhoneVoice }
            st.pendingImage={prompt:route.prompt,requestId,memberId:route.memberId}
            st.delivery={phase:'ask',content:route.prompt};st.deliveryId=requestId
            const reply=`${artist?artist.name+' here. ':''}Where should I send the image—email, text, or keep it in Nalu?`
            st.history.push({role:'assistant',content:reply}); await saveState(userId,sid,st)
            return sendCallXml(res,speak(reply,voice)+listen('',sid,voice,context))
          }
          if (route.type === 'remote') body = { kind: route.kind, repo: route.repo, prompt: route.prompt, target: 'desktop', memberId: route.memberId || st.memberId }
          else if (route.type === 'clarify') clarification = route.question
          else if (route.reply) {
            clarification=forSpeech(route.reply,1000)

          }
        } catch { clarification = 'I could not confirm the task destination. Please tell me what you want to do again.' }
        finally { await backend.close().catch(() => {}) }
      }
      if (body) {
        const assigned = st.members.find(m => m.active && m.id === (body.memberId || st.memberId))
        if (assigned) { st.memberId = assigned.id; voice = assigned.voice as PhoneVoice }
        const introduction = assigned && assigned.id !== current.id ? `${assigned.name} here. ` : ''
        const idempotency = crypto.createHash('sha256').update(raw).digest('hex')
        const requestId = 'phone_' + crypto.createHash('sha256').update([sid, idempotency || requestUrl(req), said].join('|')).digest('hex').slice(0, 40)
        const backend=connectionBackend(),c=backend.client
        let queued = false
        try {
          await backend.connect()
          if(!(c instanceof CloudflareStore))await ensureSchema(c as any)
          const r = await enqueueTask(c, userId, { ...body, memberId: body.memberId || st.memberId, requestId })
          queued = r.code >= 200 && r.code < 300 && !!r.data?.ok
        } catch (error) { console.error('[phone] task enqueue failed:', error instanceof Error ? error.message : 'unknown error') }
        finally { await backend.close().catch(() => {}) }
        const reply = queued
          ? `${introduction}I've queued ${flow ? '"' + flow.name + '"' : 'that task'} for your desktop. It will start when your Nalu worker is connected. Anything else?`
          : `I couldn't queue ${flow ? '"' + flow.name + '"' : 'that task'} just now. Please check AutoPilot in the app and try again.`
        st.history.push({ role: 'assistant', content: reply })
        await saveState(userId, sid, st)
        return sendCallXml(res, speak(reply, voice) + listen('', sid, voice, context))
      }
      if (clarification || LAUNCH.test(said)) {
        const reply = clarification || 'I could not match that to one of your saved pipelines. Tell me what you want to accomplish.'
        st.history.push({ role: 'assistant', content: reply })
        await saveState(userId, sid, st)
        return sendCallXml(res, speak(reply, voice) + listen('', sid, voice, context))
      }
    }

    // Otherwise: a normal conversation turn. Ask Inkling, speak the reply — cleaned
    // of markdown/URLs and kept short so it sounds natural read aloud.
    const token = userId ? await mintToken(userId) : undefined
    let reply = ''
    try { reply = await chatReply(st.history, token) }
    finally { if (token && userId) await revokeToken(userId, token) }
    const spoken = forSpeech(reply, 700) || `I'm not sure I got that. Could you say it another way?`
    st.history.push({ role: 'assistant', content: spoken })
    if (userId) await saveState(userId, sid, st)
    return sendCallXml(res, speak(spoken, voice) + listen('', sid, voice, context))
  } catch (e) {
    if(step.startsWith('recipient-')&&e instanceof OutboundError){if(e.status===503)res.setHeader('Retry-After','1');return res.status(e.status).end()}
    console.error('[phone] handler error:', e instanceof Error ? e.stack || e.message : e)
    return sendCallXml(res, sayPolly('Sorry, something went wrong on my end. Please try again. Goodbye.') + '<Hangup/>')
  }
}

// Mint a caller-ID-authenticated session so the call can act as the user.
async function mintToken(userId: string): Promise<string> {
  const backend=connectionBackend(),c=backend.client
  try { await backend.connect(); if(!(c instanceof CloudflareStore))await ensureSchema(c as any); return c instanceof CloudflareStore?await new CloudflarePhoneState(c).mint(userId):await tokenForUserId(c as any, userId) }
  catch { return '' } finally { await backend.close().catch(() => {}) }
}

// Call sessions are temporary: never leave a permanent login behind after a
// caller hangs up without saying goodbye.
async function revokeToken(userId: string, token: string): Promise<void> {
  const backend=connectionBackend(),c=backend.client
  try { await backend.connect(); c instanceof CloudflareStore?await new CloudflarePhoneState(c).revoke(userId,token):await c.query('DELETE FROM nalu_sessions WHERE token = $1 AND user_id = $2', [token, userId]) }
  catch { console.error('[phone] could not revoke temporary session') }
  finally { await backend.close().catch(() => {}) }
}

async function readTeam(userId: string): Promise<TeamMember[]> {
  const backend=connectionBackend(),c=backend.client
  try { await backend.connect(); if(!(c instanceof CloudflareStore))await ensureSchema(c as any); return await listTeam(c, userId) }
  finally { await backend.close().catch(() => {}) }
}
