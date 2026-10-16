import { canMessagePhone } from './_messageConsent'
import { normalizePhone } from './_db'
import { createHash } from 'node:crypto'
import type { TeamClient } from './_team'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'

export type MessageClient = TeamClient | CloudflareStore
export type MessageInput = {
  requestId: string; direction: 'inbound' | 'outbound' | 'image'; from: string; to: string; text: string;
  media?: any[]; carrierId?: string; memberId?: string; taskId?: string;
}

export type MessageRow = { id: string; user_id: string; direction: string; text: string; media: any[]; status: string; from_number: string; to_number: string; member_id?: string; task_id?: string; error?: string; newlyCreated?: boolean }
export const messageId = (uid: string, request: string) => 'msg_' + createHash('sha256').update(`${uid}\0${request}`).digest('hex').slice(0, 40)
let ready = false
export async function ensureMessageSchema(c: MessageClient) {
  if (c instanceof CloudflareStore) return
  if (ready) return
  await c.query('BEGIN')
  try {
    await c.query('SELECT pg_advisory_xact_lock(72816421)')
    await c.query(`CREATE TABLE IF NOT EXISTS nalu_messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound','image')),
      from_number TEXT NOT NULL, to_number TEXT NOT NULL, text TEXT NOT NULL,
      media JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'queued',
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, carrier_id TEXT UNIQUE,
      member_id TEXT, task_id TEXT, error TEXT, started_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS nalu_messages_pending ON nalu_messages(user_id,status,created_at);
    CREATE TABLE IF NOT EXISTS nalu_message_media (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      mime TEXT NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS nalu_message_receipts (
      carrier_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, to_number TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`)
    await c.query('COMMIT'); ready = true
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e }
}

export async function saveMessage(c: MessageClient, uid: string, input: MessageInput): Promise<MessageRow> {
  if (c instanceof CloudflareStore) return new CloudflareMessages(c).save(uid, input)
  await ensureMessageSchema(c)
  const media = input.media || []
  const fingerprint = createHash('sha256').update(JSON.stringify([input.direction, input.from, input.to, input.text, media, input.memberId || '', input.taskId || ''])).digest('hex')
  const inserted=await c.query(`INSERT INTO nalu_messages(id,user_id,request_id,fingerprint,direction,from_number,to_number,text,media,carrier_id,member_id,task_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) ON CONFLICT(user_id,request_id) DO NOTHING RETURNING id`,
  [messageId(uid,input.requestId),uid,input.requestId,fingerprint,input.direction,input.from,input.to,input.text,JSON.stringify(media),input.carrierId || null,input.memberId || null,input.taskId || null])
  const row = (await c.query('SELECT * FROM nalu_messages WHERE user_id=$1 AND request_id=$2', [uid,input.requestId])).rows[0]
  if (!row || row.fingerprint !== fingerprint) throw new Error('This request ID already belongs to a different message.')
  return {...row,newlyCreated:inserted.rows.length>0}
}

export async function recordReceipt(c: MessageClient, uid: string, carrierId: string, to: string, status: string, error: string) {
  if (c instanceof CloudflareStore) return new CloudflareMessages(c).receipt(uid, carrierId, to, status, error)
  await ensureMessageSchema(c)
  if (!['sent','delivered','delivery_failed','sending_failed','delivery_unconfirmed'].includes(status)) return
  await c.query(`INSERT INTO nalu_message_receipts(carrier_id,user_id,to_number,status,error) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(carrier_id) DO UPDATE SET status=EXCLUDED.status,error=EXCLUDED.error,updated_at=NOW()
    WHERE nalu_message_receipts.user_id=EXCLUDED.user_id AND nalu_message_receipts.to_number=EXCLUDED.to_number
      AND nalu_message_receipts.status='sent'`, [carrierId,uid,to,status,error || null])
  await c.query(`UPDATE nalu_messages m SET status=r.status,error=r.error,updated_at=NOW() FROM nalu_message_receipts r
    WHERE m.carrier_id=r.carrier_id AND m.user_id=r.user_id AND m.to_number=r.to_number AND r.carrier_id=$1 AND r.user_id=$2`, [carrierId,uid])
  await c.query(`UPDATE nalu_tasks t SET meta=t.meta || jsonb_build_object('messageDelivery',m.status,'messageError',m.error,'messageId',m.id),updated_at=NOW() FROM nalu_messages m WHERE m.carrier_id=$1 AND m.user_id=$2 AND t.id=m.task_id AND t.user_id=m.user_id`,[carrierId,uid])
}

// Compatibility helper: messaging is blocked until this exact profile number opts in.
export async function messagingOptOut(c: MessageClient, uid: string): Promise<boolean> {
  const phone=normalizePhone(c instanceof CloudflareStore ? await new CloudflareMessages(c).phone(uid) : (await c.query('SELECT phone FROM nalu_users WHERE id=$1',[uid])).rows[0]?.phone || '')
  return !await canMessagePhone(c,uid,phone)
}
