import { createHash } from 'node:crypto'
import type { MessageClient } from './_messageStore'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'

export const consentKey = (phone: string) => 'phone-messaging-consent:' + createHash('sha256').update(phone).digest('hex').slice(0,32)
export type MessageConsent = { phone: string; stopped: boolean; occurredAt: string; eventId: string; keyword: string }
export function keywordConsent(phone: string, text: string, occurredAt: unknown, eventId: string, now = Date.now()): MessageConsent | null {
  const keyword=text.trim().toUpperCase()
  if (!/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|START|UNSTOP)$/.test(keyword) || !/^\+[1-9]\d{7,14}$/.test(phone)) return null
  const stopped=!['START','UNSTOP'].includes(keyword)
  const time=typeof occurredAt==='string' ? Date.parse(occurredAt) : NaN
  // A malformed START event must not create permission. Honor STOP conservatively.
  if ((!Number.isFinite(time) || time>now+300000) && !stopped) return null
  return {phone,stopped,occurredAt:new Date(Number.isFinite(time)&&time<=now+300000?time:now).toISOString(),eventId,keyword}
}
export function consentAllows(value: any, phone: string): boolean {
  return !!value && value.phone===phone && value.stopped===false && ['START','UNSTOP'].includes(value.keyword) && typeof value.eventId==='string' && !!value.eventId && typeof value.occurredAt==='string' && Number.isFinite(Date.parse(value.occurredAt))
}
export async function canMessagePhone(c: MessageClient, uid: string, phone: string): Promise<boolean> {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return false
  if (c instanceof CloudflareStore) return new CloudflareMessages(c).allowed(uid, phone)
  const value=(await c.query('SELECT value FROM nalu_user_data WHERE user_id=$1 AND key=$2',[uid,consentKey(phone)])).rows[0]?.value
  return consentAllows(value,phone)
}
// Call only after raw carrier-signature, profile, line, and sender verification.
export async function recordMessageConsent(c: MessageClient, uid: string, consent: MessageConsent): Promise<void> {
  if (c instanceof CloudflareStore) return new CloudflareMessages(c).recordConsent(uid, consent)
  await c.query(`INSERT INTO nalu_user_data(user_id,key,value) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()
    WHERE COALESCE(nalu_user_data.value->>'occurredAt','') < EXCLUDED.value->>'occurredAt'
       OR (nalu_user_data.value->>'occurredAt'=EXCLUDED.value->>'occurredAt' AND EXCLUDED.value->>'stopped'='true')`,[uid,consentKey(consent.phone),JSON.stringify(consent)])
}
