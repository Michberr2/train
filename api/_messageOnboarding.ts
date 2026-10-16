import { consentKey } from './_messageConsent'
import { messageId, saveMessage, type MessageRow } from './_messageStore'
import type { MessageClient } from './_messageStore'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'

export const OPT_IN_INVITE = 'Nalu Technologies Inc: Hi! Reply START to receive assistant replies, requested images and optional task updates by text. Msg frequency varies. Msg & data rates may apply. Consent is not a condition of purchase. STOP to opt out; HELP for help. Terms: https://n4lu.ai/sms-terms.html Privacy: https://n4lu.ai/privacy.html#messaging'
const inviteRequest = (phone: string) => 'opt-in-invite:' + phone
export const isOptInInvite = (row: MessageRow) => row.id === messageId(row.user_id, inviteRequest(row.to_number))

// Never invite a number with any prior consent record, including STOP. A new
// conversation is not permission to clear an opt-out or send assistant content.
async function hasNoConsent(c: MessageClient, uid: string, phone: string) {
  if (c instanceof CloudflareStore) return !await new CloudflareMessages(c).consent(uid, phone)
  return !(await c.query('SELECT 1 FROM nalu_user_data WHERE user_id=$1 AND key=$2', [uid, consentKey(phone)])).rows.length
}
export async function queueOptInInvite(c: MessageClient, row: MessageRow) {
  if (row.direction !== 'inbound' || !await hasNoConsent(c, row.user_id, row.from_number)) return
  await saveMessage(c, row.user_id, {requestId: inviteRequest(row.from_number), direction:'outbound', from:row.to_number, to:row.from_number, text:OPT_IN_INVITE})
}
// A narrow exception for one fixed signup response to a verified incoming text.
// Recheck at send time so STOP or a changed account phone cancels queued invites.
export async function canSendOptInInvite(c: MessageClient, row: MessageRow) {
  if (!isOptInInvite(row) || row.direction !== 'outbound' || row.text !== OPT_IN_INVITE || row.media.length || row.task_id || row.member_id || row.from_number !== process.env.TELNYX_PHONE_NUMBER) return false
  if (!await hasNoConsent(c, row.user_id, row.to_number)) return false
  if (c instanceof CloudflareStore) return new CloudflareMessages(c).recentInvite(row)
  return !!(await c.query(`SELECT 1 FROM nalu_messages i JOIN nalu_messages o ON o.id=$1 AND o.user_id=i.user_id
    WHERE i.user_id=$2 AND i.direction='inbound' AND i.carrier_id IS NOT NULL
      AND i.from_number=o.to_number AND i.to_number=o.from_number
      AND i.created_at BETWEEN o.created_at-INTERVAL '5 minutes' AND o.created_at
      AND o.created_at>NOW()-INTERVAL '5 minutes'
      AND UPPER(TRIM(i.text)) NOT IN ('START','UNSTOP','STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','HELP') LIMIT 1`, [row.id,row.user_id])).rows.length
}
