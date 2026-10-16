import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { canMessagePhone, keywordConsent, recordMessageConsent } from './_messageConsent'
import { waitUntil } from '@vercel/functions'
import { cors } from './_cors'
import { ensureSchema, normalizePhone } from './_db'
import { ownsPhone, phoneOwnerId, privatePhoneUser } from './_phoneOwner'
import { readWebhookBody, validateSignature } from './_telephony'
import { ensureMessageSchema, saveMessage, recordReceipt } from './_messageStore'
import { carrierMediaUrl, mediaLink } from './_messageMedia'
import { processMessages, queueImageRequest } from './_messageWorker'

export const config={api:{bodyParser:false}}
export default async function handler(req:any,res:any) {
  if (cors(req,res)) return
  res.setHeader('Cache-Control','no-store')
  if (req.method!=='POST') return res.status(405).end()
  let raw:Buffer
  try { raw=await readWebhookBody(req) } catch { return res.status(400).json({error:'Invalid message body.'}) }
  const authorization=req.headers.authorization
  const token=typeof authorization==='string' && authorization.startsWith('Bearer ')?authorization.slice(7).trim():''
  if (!token && !validateSignature(raw,req.headers['telnyx-timestamp'],req.headers['telnyx-signature-ed25519'])) return res.status(403).end()
  let body:any
  try { body=JSON.parse(raw.toString('utf8')) } catch { return res.status(400).json({error:'Invalid JSON.'}) }
  if (!body || typeof body!=='object' || Array.isArray(body)) return res.status(400).end()
  const backend=connectionBackend(),c=backend.client
  try {
    await backend.connect(); if(!(c instanceof CloudflareStore)) await ensureSchema(c as any)
    if (token) {
      const uid=await backend.userId(token)
      if (!uid) return res.status(401).json({error:'Sign in to use messaging.'})
      if (!ownsPhone(uid)) return res.status(403).json({error:'This private messaging line belongs to another account.'})
      await ensureMessageSchema(c)
      if (body.action==='status') {
        const phone=normalizePhone(c instanceof CloudflareStore ? await new CloudflareMessages(c).phone(uid) : (await c.query('SELECT phone FROM nalu_users WHERE id=$1',[uid])).rows[0]?.phone||'')
        return res.status(200).json({number:process.env.TELNYX_PHONE_NUMBER||'',phone,optedIn:await canMessagePhone(c,uid,phone)})
      }
      if (body.action==='list') {
        const rows=c instanceof CloudflareStore ? await new CloudflareMessages(c).list(uid) : (await c.query('SELECT id,direction,text,media,status,error,task_id,member_id,created_at FROM nalu_messages WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[uid])).rows
        return res.status(200).json({messages:rows.map((row:any)=>({id:row.id,direction:row.direction,text:row.text,status:row.status,error:row.error,task_id:row.task_id,member_id:row.member_id,created_at:row.created_at,media:row.media.map((m:any)=>m.id?{id:m.id,url:mediaLink(uid,m.id)}:{url:m.url})}))})
      }
      if (body.action==='image') {
        if (typeof body.prompt!=='string' || !body.prompt.trim() || body.prompt.length>20000 || typeof body.requestId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(body.requestId)) return res.status(400).json({error:'Image prompt and request ID are required.'})
        const task=await queueImageRequest(c,uid,body.prompt,body.requestId,body.memberId)
        waitUntil(processMessages(uid)); return res.status(202).json({ok:true,task})
      }
      if (body.action!=='send') return res.status(400).json({error:'Unknown messaging action.'})
      if (typeof body.requestId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(body.requestId) || typeof body.text!=='string' || body.text.length>1500 || (!body.text.trim() && !body.mediaIds?.length)) return res.status(400).json({error:'Provide message text and a request ID.'})
      if (body.mediaIds!=null && (!Array.isArray(body.mediaIds) || body.mediaIds.length>4 || body.mediaIds.some((id:any)=>typeof id!=='string' || !/^media_[a-f0-9]{40}$/.test(id)))) return res.status(400).json({error:'Provide up to four account image IDs.'})
      const media=(body.mediaIds||[]).map((id:string)=>({id}))
      if (media.length) {
        const found=c instanceof CloudflareStore ? (await c.query('SELECT id FROM nalu_message_media WHERE user_id=? AND id IN (SELECT value FROM json_each(?))',[uid,JSON.stringify(body.mediaIds)])).results : (await c.query('SELECT id FROM nalu_message_media WHERE user_id=$1 AND id=ANY($2::text[])',[uid,body.mediaIds])).rows
        if (found.length!==new Set(body.mediaIds).size) return res.status(404).json({error:'Image not found in your account.'})
      }
      const to=normalizePhone(c instanceof CloudflareStore ? await new CloudflareMessages(c).phone(uid) : (await c.query('SELECT phone FROM nalu_users WHERE id=$1',[uid])).rows[0]?.phone||'')
      if (!to) return res.status(400).json({error:'Save your phone number in Nalu settings first.'})
      if (!await canMessagePhone(c,uid,to)) return res.status(409).json({error:'Text START from your saved phone number to Nalu to enable SMS.'})
      const message=await saveMessage(c,uid,{requestId:body.requestId,direction:'outbound',from:process.env.TELNYX_PHONE_NUMBER||'',to,text:body.text.trim(),media})
      waitUntil(processMessages(uid)); return res.status(202).json({ok:true,message:{id:message.id,status:message.status}})
    }
    if (!process.env.TELNYX_MESSAGING_PROFILE_ID) return res.status(503).end()
    const event=body.data, payload=event?.payload
    if (!event || typeof event.id!=='string' || event.id.length>128 || !payload || typeof payload.id!=='string' || payload.id.length>128) return res.status(400).end()
    if (!['message.received','message.sent','message.finalized'].includes(event.event_type)) return res.status(200).json({ok:true})
    const from=normalizePhone(payload.from?.phone_number||'')
    const recipients=Array.isArray(payload.to)?payload.to:[]
    if (recipients.length!==1 || payload.messaging_profile_id!==process.env.TELNYX_MESSAGING_PROFILE_ID) return res.status(403).end()
    const to=normalizePhone(recipients[0]?.phone_number||'')
    const line=normalizePhone(process.env.TELNYX_PHONE_NUMBER||'')
    if (!line || !from || !to || !phoneOwnerId()) return res.status(503).end()
    if (event.event_type!=='message.received') {
      if (from!==line || payload.direction!=='outbound') return res.status(403).end()
      const codes=Array.isArray(payload.errors)?payload.errors.map((e:any)=>String(e.code||'')).filter(Boolean).join(','):''
      await recordReceipt(c,phoneOwnerId(),payload.id,to,String(recipients[0].status||''),codes)
      return res.status(200).json({ok:true})
    }
    if (to!==line || payload.direction!=='inbound') return res.status(403).end()
    const user=await privatePhoneUser(c,from)
    if (!user) return res.status(200).json({ok:true}) // No reply or private context to other callers.
    const text=typeof payload.text==='string'?payload.text:''
    if (text.length>16000 || !Array.isArray(payload.media||[]) || (payload.media||[]).length>4) return res.status(400).end()
    let media
    try { media=(payload.media||[]).map((m:any)=>({url:carrierMediaUrl(m.url),content_type:String(m.content_type||'')})) }
    catch { return res.status(400).end() }
    await ensureMessageSchema(c)
    if(c instanceof CloudflareStore) {
      await new CloudflareMessages(c).save(user.id,{requestId:'inbound:'+payload.id,direction:'inbound',from,to,text,media,carrierId:payload.id},keywordConsent(from,text,event.occurred_at,event.id)||undefined)
    } else {
    await c.query('BEGIN')
    try {
      const stored=await saveMessage(c,user.id,{requestId:'inbound:'+payload.id,direction:'inbound',from,to,text,media,carrierId:payload.id})
      const consent=keywordConsent(from,text,event.occurred_at,event.id)
      if (stored.newlyCreated && consent) await recordMessageConsent(c,user.id,consent)
      await c.query('COMMIT')
    } catch (error) { await c.query('ROLLBACK').catch(()=>{}); throw error }
    }
    waitUntil(processMessages(user.id))
    return res.status(200).json({ok:true})
  } catch (error) {
    const conflict=error instanceof Error && error.message.includes('request ID already')
    return res.status(conflict?409:500).json({error:conflict?'Request ID already used for a different message.':'Messaging is unavailable. Please check activity before retrying.'})
  } finally { await backend.close().catch(()=>{}) }
}
