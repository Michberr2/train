import { createHash } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import type { Attachment } from './_taskAttachments'

const CHUNK_BYTES = 786432
const emptyHash = createHash('sha256').update('').digest('hex')
type SavedAttachment = { meta: Attachment; ready: boolean }

/** Immutable attachment manifests preserve the existing upload/download contract.
 * A completed attachment is published only after every private R2 chunk has
 * been read back and the complete file's hash has been verified. */
export class CloudflareAttachments {
  constructor(readonly store: CloudflareStore) {}
  async bytes(owner: string, id: string): Promise<Buffer | null> {
    const saved = await this.get(owner, id)
    if (!saved?.ready) return null
    const parts: Buffer[] = []
    for (let part = 0; part < saved.meta.parts; part++) {
      const bytes = await this.part(owner, id, part)
      if (!bytes) throw new Error('Saved attachment is incomplete.')
      parts.push(bytes)
    }
    const bytes = Buffer.concat(parts)
    if (bytes.length !== saved.meta.size || createHash('sha256').update(bytes).digest('hex') !== saved.meta.sha256) throw new Error('Saved attachment failed its integrity check.')
    return bytes
  }
  async get(owner: string, id: string): Promise<SavedAttachment | null> {
    const row = (await this.store.query('SELECT meta,ready FROM nalu_task_attachments WHERE user_id=?1 AND id=?2', [owner, id])).results[0]
    return row ? { meta: JSON.parse(String(row.meta)), ready: !!row.ready } : null
  }
  async begin(owner: string, meta: Attachment): Promise<Attachment> {
    await this.store.batch([{ sql: 'INSERT INTO nalu_task_attachments(id,user_id,meta) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING', params: [meta.id, owner, JSON.stringify(meta)] }])
    const row = await this.get(owner, meta.id)
    if (!row) throw new Error('Attachment not found.')
    return row.meta
  }
  private async reference(owner: string, id: string, part: number, ready = false) {
    return (await this.store.query(`SELECT p.sha256,p.byte_length FROM nalu_attachment_chunks p
      JOIN nalu_task_attachments a ON a.id=p.attachment_id
      WHERE a.user_id=?1 AND a.id=?2 AND p.part=?3 AND (?4=0 OR a.ready=1)`, [owner, id, part, Number(ready)])).results[0]
  }
  async part(owner: string, id: string, part: number, ready = true): Promise<Buffer | null> {
    const saved = await this.reference(owner, id, part, ready)
    if (!saved) return null
    const hash = String(saved.sha256), size = Number(saved.byte_length)
    if (!size && hash === emptyHash) return Buffer.alloc(0)
    const bytes = await this.store.getChunk(owner, hash)
    if (!bytes || bytes.length !== size) throw new Error('Saved attachment is incomplete. No partial file was returned.')
    return bytes
  }
  async put(owner: string, id: string, part: number, bytes: Buffer): Promise<void> {
    const row = await this.get(owner, id)
    if (!row) throw new Error('Attachment not found.')
    const meta = row.meta
    if (!Number.isInteger(part) || part < 0 || part >= meta.parts || bytes.length !== (part === meta.parts - 1 ? meta.size - part * CHUNK_BYTES : CHUNK_BYTES)) throw new Error('Invalid attachment part.')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const previous = await this.reference(owner, id, part)
    const matches = (saved: Record<string, unknown>) => saved.sha256 === sha256 && Number(saved.byte_length) === bytes.length
    if (previous) {
      if (!matches(previous)) throw new Error('Attachment part already contains different bytes.')
      return
    }
    if (row.ready) throw new Error('Completed attachment cannot change.')
    // Empty files have one empty part under the existing API contract. They do
    // not require an R2 object; the empty hash remains part of the manifest.
    if (bytes.length) await this.store.putChunk(owner, bytes)
    await this.store.batch([{ sql: `INSERT INTO nalu_attachment_chunks(attachment_id,part,sha256,byte_length)
      SELECT id,?3,?4,?5 FROM nalu_task_attachments WHERE user_id=?1 AND id=?2 AND ready=0
      ON CONFLICT(attachment_id,part) DO NOTHING`, params: [owner, id, part, sha256, bytes.length] }])
    // Two uploaders may race for the same part. Only the immutable winner may
    // be acknowledged, even when both objects reached R2 successfully.
    const saved = await this.reference(owner, id, part)
    if (!saved) throw new Error('Attachment upload could not be confirmed.')
    if (!matches(saved)) throw new Error('Attachment part already contains different bytes.')
  }
  async finish(owner: string, id: string): Promise<Attachment> {
    const row = await this.get(owner, id)
    if (!row) throw new Error('Attachment not found.')
    const meta = row.meta, hash = createHash('sha256')
    let size = 0
    for (let part = 0; part < meta.parts; part++) {
      const bytes = await this.part(owner, id, part, false)
      if (!bytes || bytes.length !== (part === meta.parts - 1 ? meta.size - part * CHUNK_BYTES : CHUNK_BYTES)) throw new Error('Upload is incomplete or failed its integrity check.')
      size += bytes.length; hash.update(bytes)
    }
    if (size !== meta.size || hash.digest('hex') !== meta.sha256) throw new Error('Upload is incomplete or failed its integrity check.')
    const saved = await this.store.batch([{ sql: `UPDATE nalu_task_attachments SET ready=1 WHERE user_id=?1 AND id=?2
      AND (SELECT count(*) FROM nalu_attachment_chunks WHERE attachment_id=?2)=?3 RETURNING id`, params: [owner, id, meta.parts] }])
    if (!saved.results[0].results.length) throw new Error('Attachment upload could not be confirmed.')
    return meta
  }
  async list(owner: string, taskId?: string, cursor?: string) {
    const rows = (await this.store.query(`SELECT meta FROM nalu_task_attachments WHERE user_id=?1 AND ready=1
      AND (?2 IS NULL OR json_extract(meta,'$.taskId')=?2 OR 'flow_def_'||json_extract(meta,'$.flowId')=?2)
      AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT 101`, [owner, taskId || null, cursor || null])).results
    const attachments = rows.map(row => JSON.parse(String(row.meta)) as Attachment)
    return { attachments: attachments.slice(0, 100), next: attachments.length > 100 ? attachments[99].id : null }
  }
  async mediaSource(owner: string, sourceId: string): Promise<{ id: string; meta: Attachment } | null> {
    const row = (await this.store.query(`SELECT id,meta FROM nalu_task_attachments WHERE user_id=?1 AND ready=1
      AND (id=?2 OR json_extract(meta,'$.sourceId')=?2) ORDER BY created_at DESC,id DESC LIMIT 1`, [owner, sourceId])).results[0]
    return row ? { id: String(row.id), meta: JSON.parse(String(row.meta)) } : null
  }
  async grantMedia(owner: string, id: string, tokenHash: string) {
    const result = await this.store.batch([{ sql: `INSERT INTO nalu_connection_media(token_hash,user_id,attachment_id)
      SELECT ?3,user_id,id FROM nalu_task_attachments WHERE user_id=?1 AND id=?2 AND ready=1 RETURNING token_hash`, params: [owner, id, tokenHash] }])
    if (!result.results[0].results.length) throw new Error('Attachment not found.')
  }
  async grantedMedia(tokenHash: string): Promise<{ id: string; user_id: string; meta: Attachment } | null> {
    const row = (await this.store.query(`SELECT a.id,a.user_id,a.meta FROM nalu_connection_media m
      JOIN nalu_task_attachments a ON a.id=m.attachment_id AND a.user_id=m.user_id
      WHERE m.token_hash=?1 AND julianday(m.expires_at)>julianday('now') AND a.ready=1`, [tokenHash])).results[0]
    return row ? { id: String(row.id), user_id: String(row.user_id), meta: JSON.parse(String(row.meta)) } : null
  }
}
