import { randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'
import { storeAttachment } from './_taskAttachments'
import { STUDIO_IMAGE_LEASE_SECONDS, studioImageDailyLimit, type StudioImageRequest, type StudioImageRow } from './_studioImages'
import type { GeneratedImage } from './_imageGeneration'
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

export class CloudflareStudioImages {
  constructor(readonly store: CloudflareStore) {}
  async read(owner: string, id: string): Promise<StudioImageRow | null> {
    const row = (await this.store.query('SELECT * FROM nalu_studio_images WHERE user_id=? AND id=?', [owner, id])).results[0]
    if (!row) return null
    if (row.status === 'ready') {
      const bytes = row.attachment_id ? await new CloudflareAttachments(this.store).bytes(owner, String(row.attachment_id)) : null
      if (!bytes) throw new Error('Saved Studio image is incomplete.')
      row.bytes = bytes
    }
    return row as StudioImageRow
  }
  async claim(owner: string, request: StudioImageRequest): Promise<{ leaseId: string } | { row: StudioImageRow | null } | { limited: true }> {
    const limit = studioImageDailyLimit(), leaseId = randomUUID(), subject = `user:${owner}`
    if (!limit) return { limited: true }
    const saved = await this.store.batch([
      { sql: "INSERT INTO nalu_usage(subject,day,kind,count) VALUES(?,CURRENT_DATE,'studio-image',0) ON CONFLICT DO NOTHING", params: [subject] },
      { sql: `INSERT INTO nalu_studio_images(id,user_id,request_key,request,status,lease_id,lease_until)
        SELECT ?1,?2,?3,?4,'pending',?5,strftime('%Y-%m-%dT%H:%M:%fZ','now',?6)
        WHERE (SELECT count FROM nalu_usage WHERE subject=?7 AND day=CURRENT_DATE AND kind='studio-image')<?8
        ON CONFLICT(id) DO UPDATE SET status='pending',lease_id=excluded.lease_id,lease_until=excluded.lease_until,quota_day=NULL,updated_at=${now}
        WHERE nalu_studio_images.user_id=excluded.user_id AND nalu_studio_images.status<>'ready'
          AND (nalu_studio_images.status<>'pending' OR julianday(nalu_studio_images.lease_until)<=julianday('now'))`,
        params: [request.id, owner, request.requestKey, JSON.stringify({ prompt: request.prompt, size: request.size, variation: request.variation }), leaseId, `+${STUDIO_IMAGE_LEASE_SECONDS} seconds`, subject, limit] },
      { sql: `UPDATE nalu_usage SET count=count+1 WHERE subject=?1 AND day=CURRENT_DATE AND kind='studio-image'
        AND EXISTS(SELECT 1 FROM nalu_studio_images WHERE id=?2 AND user_id=?3 AND lease_id=?4 AND quota_day IS NULL)`, params: [subject, request.id, owner, leaseId] },
      { sql: 'UPDATE nalu_studio_images SET quota_day=CURRENT_DATE WHERE user_id=? AND id=? AND lease_id=? RETURNING id', params: [owner, request.id, leaseId] },
    ])
    if (saved.results[3].results.length) return { leaseId }
    const row = await this.read(owner, request.id)
    if (row?.status === 'ready' || row?.status === 'pending' && Date.parse(String(row.lease_until)) > Date.now()) return { row }
    return { limited: true }
  }
  async complete(owner: string, id: string, leaseId: string, image: GeneratedImage): Promise<StudioImageRow> {
    const attachment = await storeAttachment(this.store, owner, { sourceId: id, title: 'Studio image', filename: image.mimeType === 'image/png' ? 'Studio image.png' : 'Studio image.jpg', mime: image.mimeType }, image.bytes)
    await this.store.batch([{ sql: `UPDATE nalu_studio_images SET status='ready',bytes=NULL,attachment_id=?4,mime_type=?5,width=?6,height=?7,
      lease_id=NULL,lease_until=NULL,updated_at=${now} WHERE user_id=?1 AND id=?2 AND lease_id=?3 AND status='pending' AND julianday(lease_until)>julianday('now')`,
      params: [owner, id, leaseId, attachment.id, image.mimeType, image.width, image.height] }])
    const row = await this.read(owner, id)
    if (row?.status === 'ready') return row
    throw new Error('The image request expired. Choose Generate imagery to retry.')
  }
  async fail(owner: string, id: string, leaseId: string) {
    await this.store.batch([
      { sql: `UPDATE nalu_usage SET count=MAX(count-1,0) WHERE subject=?1 AND kind='studio-image'
        AND day=(SELECT quota_day FROM nalu_studio_images WHERE user_id=?2 AND id=?3 AND lease_id=?4 AND status='pending')`, params: [`user:${owner}`, owner, id, leaseId] },
      { sql: `UPDATE nalu_studio_images SET status='failed',lease_id=NULL,lease_until=NULL,updated_at=${now}
        WHERE user_id=? AND id=? AND lease_id=? AND status='pending'`, params: [owner, id, leaseId] },
    ])
  }
}
