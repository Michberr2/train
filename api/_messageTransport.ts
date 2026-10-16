import { isOptInInvite, canSendOptInInvite } from './_messageOnboarding'
import { canMessagePhone } from './_messageConsent'
import { normalizePhone } from './_db'
import { ownsPhone } from './_phoneOwner'
import { mediaLink } from './_messageMedia'
import { type MessageRow } from './_messageStore'
import { publicBase } from './_telephony'
import type { MessageClient } from './_messageStore'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'

export async function sendMessageOnce(c: MessageClient, row: MessageRow): Promise<void> {
  if (!ownsPhone(row.user_id)) throw new Error('This account does not own the messaging line.')
  const saved = normalizePhone(c instanceof CloudflareStore ? await new CloudflareMessages(c).phone(row.user_id) : (await c.query('SELECT phone FROM nalu_users WHERE id=$1',[row.user_id])).rows[0]?.phone || '')
  const permitted = isOptInInvite(row) ? await canSendOptInInvite(c,row) : await canMessagePhone(c,row.user_id,saved)
  if (!saved || row.to_number !== saved || !permitted) {
    if (c instanceof CloudflareStore) await new CloudflareMessages(c).suppress(row)
    else await c.query("UPDATE nalu_messages SET status='suppressed',error='Destination changed or this number has not opted in. Text START to Nalu.',updated_at=NOW() WHERE id=$1 AND status='queued'",[row.id])
    return
  }
  if (!process.env.TELNYX_API_KEY || !process.env.TELNYX_MESSAGING_PROFILE_ID) throw new Error('Messaging is not configured.')
  if (!row.text && !row.media.length) throw new Error('Message is empty.')
  const mediaUrls: string[]=[]
  let total=0
  for (const item of row.media) {
    const size=c instanceof CloudflareStore ? await new CloudflareMessages(c).mediaSize(row.user_id,item.id) : (await c.query('SELECT octet_length(bytes) AS size FROM nalu_message_media WHERE id=$1 AND user_id=$2',[item.id,row.user_id])).rows[0]?.size
    if (size == null) throw new Error('Message image was not found in this account.')
    total+=Number(size); mediaUrls.push(mediaLink(row.user_id,item.id))
  }
  if (total>950000 || mediaUrls.length>4) throw new Error('The message exceeds MMS limits.')
  const claimed=c instanceof CloudflareStore ? await new CloudflareMessages(c).claimSend(row) : (await c.query("UPDATE nalu_messages SET status='sending',started_at=NOW(),updated_at=NOW() WHERE id=$1 AND user_id=$2 AND direction='outbound' AND status='queued' RETURNING id",[row.id,row.user_id])).rows.length>0
  if (!claimed) return
  try {
    const response=await fetch('https://api.telnyx.com/v2/messages',{
      method:'POST',headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:process.env.TELNYX_PHONE_NUMBER,to:row.to_number,text:row.text,
        messaging_profile_id:process.env.TELNYX_MESSAGING_PROFILE_ID,webhook_url:`${publicBase()}/api/messages`,
        ...(mediaUrls.length?{type:'MMS',media_urls:mediaUrls}:{})}),
      signal:AbortSignal.timeout(15000),
    })
    const data=await response.json().catch(()=>null)
    if (!response.ok) {
      const codes=Array.isArray(data?.errors)?data.errors.map((e:any)=>String(e.code||'')).filter(Boolean).join(','):''
      const status=response.status>=500?'uncertain':'sending_failed', error=`Carrier HTTP ${response.status}${codes?' ('+codes+')':''}. Check messaging registration and carrier logs.`
      if (c instanceof CloudflareStore) await new CloudflareMessages(c).sendResult(row,status,error)
      else await c.query('UPDATE nalu_messages SET status=$2,error=$3,updated_at=NOW() WHERE id=$1',[row.id,status,error])
      return
    }
    const id=data?.data?.id
    if (typeof id!=='string' || !id) throw new Error('Carrier acceptance could not be confirmed.')
    if (c instanceof CloudflareStore) { await new CloudflareMessages(c).sendResult(row,'accepted',null,id); return }
    await c.query("UPDATE nalu_messages SET carrier_id=$2,status='accepted',updated_at=NOW() WHERE id=$1",[row.id,id])
    // A delivery receipt can race the send response; retain it even if it arrived first.
    await c.query(`UPDATE nalu_messages m SET status=r.status,error=r.error,updated_at=NOW() FROM nalu_message_receipts r
      WHERE m.id=$1 AND r.carrier_id=m.carrier_id AND r.user_id=m.user_id AND r.to_number=m.to_number`,[row.id])
  } catch {
    // The carrier might already have sent it. Never automatically resend.
    if (c instanceof CloudflareStore) await new CloudflareMessages(c).sendResult(row,'uncertain','Delivery is uncertain. Check carrier logs before retrying.')
    else await c.query("UPDATE nalu_messages SET status='uncertain',error='Delivery is uncertain. Check carrier logs before retrying.',updated_at=NOW() WHERE id=$1 AND status='sending'",[row.id])
  } finally {
    if (!(c instanceof CloudflareStore)) await c.query(`UPDATE nalu_tasks t SET meta=t.meta || jsonb_build_object('messageDelivery',m.status,'messageError',m.error,'messageId',m.id),updated_at=NOW() FROM nalu_messages m WHERE m.id=$1 AND t.id=m.task_id AND t.user_id=m.user_id`,[row.id])
  }
}
