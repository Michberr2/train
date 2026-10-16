import { randomUUID, createHash } from 'node:crypto'
import { CloudflareStore, type CloudflareStatement } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'
import { shallowJsonMerge } from './_cloudflareJson'
import { storeAttachment } from './_taskAttachments'
import { consentAllows, type MessageConsent } from './_messageConsent'
import { messageId, type MessageInput, type MessageRow } from './_messageStore'

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const decodeMessage = (row: any): MessageRow => ({ ...row, media: JSON.parse(row.media || '[]') })
const decodeTask = (row: any) => row ? { ...row, meta: JSON.parse(row.meta || '{}'), events: JSON.parse(row.events || '[]') } : null

/** D1 batches own each durable claim. No transaction spans a carrier request. */
export class CloudflareMessages {
  constructor(readonly store: CloudflareStore) {}
  async phone(uid: string) { return String((await this.store.query('SELECT phone FROM nalu_users WHERE id=?', [uid])).results[0]?.phone || '') }
  async consent(uid: string, phone: string) {
    const row = (await this.store.query('SELECT document FROM nalu_message_consents WHERE user_id=? AND phone=?', [uid, phone])).results[0]
    return row ? JSON.parse(String(row.document)) : null
  }
  async allowed(uid: string, phone: string) { return consentAllows(await this.consent(uid, phone), phone) }
  private consentStatement(uid: string, consent: MessageConsent, guard?: { id: string; token: string }): CloudflareStatement {
    return { sql: `INSERT INTO nalu_message_consents(user_id,phone,document) SELECT ?1,?2,?3
      ${guard ? 'WHERE EXISTS(SELECT 1 FROM nalu_messages WHERE id=?4 AND user_id=?1 AND mutation_token=?5)' : 'WHERE 1'}
      ON CONFLICT(user_id,phone) DO UPDATE SET document=excluded.document
      WHERE COALESCE(json_extract(nalu_message_consents.document,'$.occurredAt'),'') < json_extract(excluded.document,'$.occurredAt')
      OR (json_extract(nalu_message_consents.document,'$.occurredAt')=json_extract(excluded.document,'$.occurredAt') AND json_extract(excluded.document,'$.stopped')=1)`,
      params: [uid, consent.phone, JSON.stringify(consent), ...(guard ? [guard.id, guard.token] : [])] }
  }
  async recordConsent(uid: string, consent: MessageConsent) { await this.store.batch([this.consentStatement(uid, consent)]) }
  async save(uid: string, input: MessageInput, consent?: MessageConsent, imageTask?: { id: string; title: string; meta: Record<string, unknown> }): Promise<MessageRow> {
    const media = input.media || [], id = messageId(uid, input.requestId), token = randomUUID()
    const fingerprint = createHash('sha256').update(JSON.stringify([input.direction, input.from, input.to, input.text, media, input.memberId || '', input.taskId || ''])).digest('hex')
    // An image task and its queue item must become visible together. A conflict
    // in the requested delivery destination leaves both previous records intact.
    const statements: CloudflareStatement[] = [{ sql: `INSERT INTO nalu_messages(id,user_id,request_id,fingerprint,direction,from_number,to_number,text,media,carrier_id,member_id,task_id,mutation_token)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13
      ${imageTask ? "WHERE NOT EXISTS(SELECT 1 FROM nalu_tasks WHERE id=?12)" : 'WHERE 1'}
      ON CONFLICT(user_id,request_id) DO NOTHING RETURNING id`,
      params: [id, uid, input.requestId, fingerprint, input.direction, input.from, input.to, input.text, JSON.stringify(media), input.carrierId || null, input.memberId || null, input.taskId || null, token] }]
    if (consent) statements.push(this.consentStatement(uid, consent, { id, token }))
    if (imageTask) statements.push({ sql: `INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,meta)
      SELECT ?1,?2,'voice',?3,'Creating your image','queued',?4 WHERE EXISTS(SELECT 1 FROM nalu_messages WHERE id=?5 AND user_id=?2 AND mutation_token=?6)
      ON CONFLICT(id) DO NOTHING`, params: [imageTask.id, uid, imageTask.title, JSON.stringify(imageTask.meta), id, token] })
    statements.push({ sql: 'SELECT * FROM nalu_messages WHERE user_id=? AND request_id=?', params: [uid, input.requestId] })
    if (imageTask) statements.push({ sql: 'SELECT * FROM nalu_tasks WHERE user_id=? AND id=?', params: [uid, imageTask.id] })
    const result = await this.store.batch(statements), row = result.results[statements.length - (imageTask ? 2 : 1)].results[0]
    if (!row || row.fingerprint !== fingerprint) throw new Error('This request ID already belongs to a different message.')
    if (imageTask) {
      const task = decodeTask(result.results[result.results.length-1]?.results[0]), prior = task?.meta?.delivery || { channel: 'app', address: 'Nalu' }, desired = imageTask.meta.delivery as any
      if (!task || prior.channel !== desired.channel || prior.address !== desired.address) throw new Error('This image request already has a different delivery destination.')
    }
    return { ...decodeMessage(row), newlyCreated: result.results[0].results.length > 0 }
  }
  private taskReceipt(where: string, params: CloudflareStatement['params']): CloudflareStatement {
    return { sql: `UPDATE nalu_tasks AS t SET meta=${shallowJsonMerge('t.meta', "json_object('messageDelivery',m.status,'messageError',m.error,'messageId',m.id)")},updated_at=${now}
      FROM nalu_messages m WHERE t.id=m.task_id AND t.user_id=m.user_id AND ${where}`, params }
  }
  private applyReceipt(where: string, params: CloudflareStatement['params']): CloudflareStatement {
    return { sql: `UPDATE nalu_messages AS m SET status=r.status,error=r.error,updated_at=${now} FROM nalu_message_receipts r
      WHERE m.carrier_id=r.carrier_id AND m.user_id=r.user_id AND m.to_number=r.to_number AND ${where}`, params }
  }
  async receipt(uid: string, carrierId: string, to: string, status: string, error: string) {
    if (!['sent','delivered','delivery_failed','sending_failed','delivery_unconfirmed'].includes(status)) return
    await this.store.batch([
      { sql: `INSERT INTO nalu_message_receipts(carrier_id,user_id,to_number,status,error) VALUES(?,?,?,?,?)
        ON CONFLICT(carrier_id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=${now}
        WHERE nalu_message_receipts.user_id=excluded.user_id AND nalu_message_receipts.to_number=excluded.to_number AND nalu_message_receipts.status='sent'`, params: [carrierId, uid, to, status, error || null] },
      this.applyReceipt('r.carrier_id=? AND r.user_id=?', [carrierId, uid]), this.taskReceipt('m.carrier_id=? AND m.user_id=?', [carrierId, uid]),
    ])
  }
  async get(uid: string, id: string) {
    const row = (await this.store.query('SELECT * FROM nalu_messages WHERE user_id=? AND id=?', [uid, id])).results[0]
    return row ? decodeMessage(row) : null
  }
  async list(uid: string, outbound = false) {
    const rows = (await this.store.query(`SELECT * FROM nalu_messages WHERE user_id=? ${outbound ? "AND direction='outbound' AND status='queued' ORDER BY created_at,id LIMIT 20" : 'ORDER BY created_at DESC,id DESC LIMIT 100'}`, [uid])).results
    return rows.map(decodeMessage)
  }
  async recentInvite(row: MessageRow) {
    return !!(await this.store.query(`SELECT 1 FROM nalu_messages i JOIN nalu_messages o ON o.id=?1 AND o.user_id=i.user_id
      WHERE i.user_id=?2 AND i.direction='inbound' AND i.carrier_id IS NOT NULL AND i.from_number=o.to_number AND i.to_number=o.from_number
      AND julianday(i.created_at) BETWEEN julianday(o.created_at)-5.0/1440 AND julianday(o.created_at)
      AND julianday(o.created_at)>julianday('now','-5 minutes')
      AND UPPER(TRIM(i.text)) NOT IN ('START','UNSTOP','STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','HELP') LIMIT 1`, [row.id, row.user_id])).results.length
  }
  async saveMedia(uid: string, id: string, bytes: Buffer) {
    const saved = await storeAttachment(this.store, uid, { sourceId: id, filename: id + '.jpg', mime: 'image/jpeg', title: 'Message image' }, bytes)
    await this.store.batch([{ sql: "INSERT INTO nalu_message_media(id,user_id,mime,bytes,attachment_id,byte_length) VALUES(?,?,'image/jpeg',X'',?,?) ON CONFLICT(id) DO NOTHING", params: [id, uid, saved.id, bytes.length] }])
  }
  async mediaSize(uid: string, id: string) {
    const row = (await this.store.query('SELECT byte_length AS size FROM nalu_message_media WHERE user_id=? AND id=? AND attachment_id IS NOT NULL', [uid, id])).results[0]
    return row ? Number(row.size) : null
  }
  async media(uid: string, id: string): Promise<{ mime: string; bytes: Buffer } | null> {
    const row = (await this.store.query('SELECT mime,attachment_id,byte_length FROM nalu_message_media WHERE user_id=? AND id=?', [uid, id])).results[0]
    if (!row?.attachment_id) return null
    const bytes = await new CloudflareAttachments(this.store).bytes(uid, String(row.attachment_id))
    if (!bytes || bytes.length !== row.byte_length) return null
    return { mime: String(row.mime), bytes }
  }
  async suppress(row: MessageRow) {
    await this.store.batch([{ sql: `UPDATE nalu_messages SET status='suppressed',error='Destination changed or this number has not opted in. Text START to Nalu.',updated_at=${now} WHERE id=? AND user_id=? AND status='queued'`, params: [row.id, row.user_id] }, this.taskReceipt('m.id=? AND m.user_id=?', [row.id, row.user_id])])
  }
  async claimSend(row: MessageRow) {
    return !!(await this.store.batch([{ sql: `UPDATE nalu_messages SET status='sending',started_at=${now},updated_at=${now}
      WHERE id=? AND user_id=? AND direction='outbound' AND status='queued' RETURNING id`, params: [row.id, row.user_id] }])).results[0].results.length
  }
  async sendResult(row: MessageRow, status: string, error: string | null = null, carrierId?: string) {
    await this.store.batch([
      { sql: `UPDATE nalu_messages SET status=?,error=?,carrier_id=COALESCE(?,carrier_id),updated_at=${now} WHERE id=? AND user_id=? AND status='sending'`, params: [status, error, carrierId || null, row.id, row.user_id] },
      this.applyReceipt('m.id=? AND m.user_id=?', [row.id, row.user_id]), this.taskReceipt('m.id=? AND m.user_id=?', [row.id, row.user_id]),
    ])
  }
  async task(uid: string, id: string) { return decodeTask((await this.store.query('SELECT * FROM nalu_tasks WHERE user_id=? AND id=?', [uid, id])).results[0]) }
  async setMessage(uid: string, id: string, patch: { media?: any[]; task_id?: string; member_id?: string; status?: string; error?: string }) {
    const fields = Object.entries(patch).filter(([key]) => ['media','task_id','member_id','status','error'].includes(key))
    if (!fields.length) return
    await this.store.batch([{ sql: `UPDATE nalu_messages SET ${fields.map(([key]) => key + '=?').join(',')},updated_at=${now} WHERE user_id=? AND id=?`, params: [...fields.map(([key, value]) => key === 'media' ? JSON.stringify(value) : String(value)), uid, id] }])
  }
  async updateTask(uid: string, id: string, patch: { status?: string; detail?: string; progress?: number; meta?: Record<string, unknown> }) {
    const fields = Object.entries(patch).filter(([key]) => ['status','detail','progress','meta'].includes(key))
    if (!fields.length) return
    await this.store.batch([{ sql: `UPDATE nalu_tasks SET ${fields.map(([key]) => key === 'meta' ? 'meta=' + shallowJsonMerge('meta', '?') : key + '=?').join(',')},updated_at=${now} WHERE user_id=? AND id=?`,
      params: [...fields.flatMap(([key, value]) => key === 'meta' ? [JSON.stringify(value), JSON.stringify(value)] : [value as string | number]), uid, id] }])
  }
  async startImage(uid: string, row: MessageRow, taskId: string, member: { id: string; name: string; extension: number }) {
    await this.store.batch([
      { sql: `UPDATE nalu_messages SET task_id=?,member_id=?,updated_at=${now} WHERE user_id=? AND id=?`, params: [taskId, member.id, uid, row.id] },
      { sql: `INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,meta) VALUES(?,?,'sms',?,'Creating your image','running',?)
        ON CONFLICT(id) DO UPDATE SET status='running',updated_at=${now} WHERE nalu_tasks.user_id=excluded.user_id`, params: [taskId, uid, row.text.slice(0,300), JSON.stringify({kind:'image',memberId:member.id,memberName:member.name,extension:member.extension})] },
    ])
  }
  async history(uid: string, id: string) {
    return (await this.store.query(`SELECT direction,text FROM nalu_messages WHERE user_id=?1 AND created_at<=(SELECT created_at FROM nalu_messages WHERE id=?2 AND user_id=?1)
      AND id<>?2 AND direction IN ('inbound','outbound') AND status IN ('done','accepted','sent','delivered') ORDER BY created_at DESC,id DESC LIMIT 10`, [uid,id])).results.reverse()
      .map(row => ({role:(row.direction==='inbound'?'user':'assistant') as 'user'|'assistant',content:String(row.text)}))
  }
  async workers(uid: string) {
    return (await this.store.query('SELECT repos,kinds FROM nalu_task_workers WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 100',[uid])).results
      .map(row=>({...row,repos:JSON.parse(String(row.repos||'[]')),kinds:JSON.parse(String(row.kinds||'[]'))}))
  }
  async recover(uid: string) {
    await this.store.batch([
      { sql: `UPDATE nalu_messages SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'interrupted' END,
        error='Processing was interrupted. Check activity and carrier logs before retrying.',updated_at=${now}
        WHERE user_id=? AND status IN ('processing','sending') AND julianday(started_at)<julianday('now','-6 minutes')`, params:[uid] },
      { sql: `UPDATE nalu_tasks AS t SET status='failed',detail=m.error,updated_at=${now} FROM nalu_messages m
        WHERE m.user_id=? AND m.status='interrupted' AND t.id=m.task_id AND t.user_id=m.user_id AND t.status IN ('queued','running')`, params:[uid] },
    ])
  }
  async claimNext(uid: string, lease: string) {
    const result=await this.store.batch([{sql:`UPDATE nalu_messages SET status='processing',started_at=${now},updated_at=${now}
      WHERE id=(SELECT id FROM nalu_messages WHERE user_id=?1 AND direction IN ('inbound','image') AND status='queued' ORDER BY created_at,id LIMIT 1)
      AND EXISTS(SELECT 1 FROM nalu_phone_leases WHERE user_id=?1 AND scope='messages' AND token=?2 AND expires_at>${now}) RETURNING *`,params:[uid,lease]}])
    const row=result.results[0].results[0]
    return row?decodeMessage(row):null
  }
  async finish(uid: string, id: string, status: 'done'|'failed', error?: string) {
    await this.store.batch([{sql:`UPDATE nalu_messages SET status=?,error=?,updated_at=${now} WHERE user_id=? AND id=? AND status='processing'`,params:[status,error||null,uid,id]}])
  }
}
