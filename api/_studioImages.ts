import { CloudflareStore } from './_cloudflareStore'
import { CloudflareStudioImages } from './_cloudflareStudioImages'
import { createHash, randomUUID } from 'node:crypto'
import { imageSize, imageDataUrl, MAX_IMAGE_BYTES, type GeneratedImage } from './_imageGeneration'

export type ImageClient = CloudflareStore | { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
export type StudioImageRequest = { id: string; requestKey: string; prompt: string; size: string; width: number; height: number; variation: string }
export type StudioImageRow = { id: string; user_id: string; request_key: string; status: 'pending' | 'ready' | 'failed'; lease_id?: string; lease_until?: Date | string; quota_day?: string; bytes?: Buffer; width?: number; height?: number; mime_type?: 'image/png' | 'image/jpeg' }
export const STUDIO_IMAGE_LEASE_SECONDS = 180
const schemaClients = new WeakSet<ImageClient>()

export async function ensureStudioImageSchema(client: ImageClient): Promise<void> {
  if (client instanceof CloudflareStore || schemaClients.has(client)) return
  await client.query(`CREATE TABLE IF NOT EXISTS nalu_studio_images (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL,
    request JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
    lease_id TEXT,
    lease_until TIMESTAMPTZ,
    quota_day DATE,
    bytes BYTEA CHECK (octet_length(bytes) <= 2097152),
    mime_type TEXT,
    width INT,
    height INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, request_key)
  );
  CREATE INDEX IF NOT EXISTS nalu_studio_images_user_created ON nalu_studio_images(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS nalu_usage (
    subject TEXT NOT NULL, day DATE NOT NULL, kind TEXT NOT NULL,
    count INT NOT NULL DEFAULT 0, PRIMARY KEY (subject,day,kind)
  )`)
  schemaClients.add(client)
}

export function studioImageRequest(userId: string, value: any): StudioImageRequest {
  const prompt = typeof value?.prompt === 'string' ? value.prompt.trim() : ''
  if (!prompt || prompt.length > 6000) throw new Error('Provide an image prompt of up to 6000 characters.')
  if (value.variation != null && (typeof value.variation !== 'string' || value.variation.length > 128)) throw new Error('Invalid image variation.')
  const variation = value.variation || ''
  const size = imageSize(value.size)
  // Version is stable across deployments. Model/palette changes must not turn
  // reopening a saved deck into a new generation or silently replace its image.
  const requestKey = createHash('sha256').update(JSON.stringify([userId, prompt, size.size, 'v1', variation])).digest('hex')
  return { id: `studio_image_${requestKey}`, requestKey, prompt, variation, ...size }
}

export async function readStudioImage(client: ImageClient, userId: string, id: string): Promise<StudioImageRow | null> {
  if (client instanceof CloudflareStore) return new CloudflareStudioImages(client).read(userId,id)
  await ensureStudioImageSchema(client)
  return (await client.query('SELECT * FROM nalu_studio_images WHERE user_id=$1 AND id=$2', [userId, id])).rows[0] || null
}

export function studioImageResult(row: StudioImageRow) {
  if (row.status !== 'ready' || !row.bytes || !row.width || !row.height || !row.mime_type) throw new Error('This image is not ready.')
  const image: GeneratedImage = { bytes: Buffer.from(row.bytes), width: row.width, height: row.height, mimeType: row.mime_type }
  return { id: row.id, requestKey: row.request_key, url: imageDataUrl(image), width: image.width, height: image.height, mimeType: image.mimeType }
}

export function liveImageLease(row: StudioImageRow): boolean {
  return row.status === 'pending' && new Date(row.lease_until || 0).getTime() > Date.now()
}

export function studioImageDailyLimit(): number {
  const raw = process.env.NALU_USER_STUDIO_IMAGE_PER_DAY || process.env.NALU_USER_STUDIO_PER_DAY
  const value = raw ? Number(raw) : 400
  return Number.isInteger(value) && value >= 0 ? value : 400
}

/** Only a new generation claims usage. The short transaction finishes before
 * any provider call; concurrent readers get pending, with no duplicate bill. */
export async function claimStudioImage(client: ImageClient, userId: string, request: StudioImageRequest): Promise<{ leaseId: string } | { row: StudioImageRow | null } | { limited: true }> {
  await ensureStudioImageSchema(client)
  if (client instanceof CloudflareStore) return new CloudflareStudioImages(client).claim(userId,request)
  const leaseId = randomUUID()
  await client.query('BEGIN')
  try {
    const claimed = await client.query(`INSERT INTO nalu_studio_images (id,user_id,request_key,request,status,lease_id,lease_until)
      VALUES ($1,$2,$3,$4::jsonb,'pending',$5,NOW()+$6*INTERVAL '1 second')
      ON CONFLICT (id) DO UPDATE SET status='pending',lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,updated_at=NOW()
      WHERE nalu_studio_images.user_id=EXCLUDED.user_id AND nalu_studio_images.status<>'ready'
        AND (nalu_studio_images.status<>'pending' OR nalu_studio_images.lease_until<=NOW())
      RETURNING id`, [request.id, userId, request.requestKey, JSON.stringify({ prompt: request.prompt, size: request.size, variation: request.variation }), leaseId, STUDIO_IMAGE_LEASE_SECONDS])
    if (!claimed.rows.length) {
      await client.query('ROLLBACK')
      return { row: await readStudioImage(client, userId, request.id) }
    }
    const limit = studioImageDailyLimit()
    if (!limit) { await client.query('ROLLBACK'); return { limited: true } }
    const reserved = await client.query(`INSERT INTO nalu_usage (subject,day,kind,count) VALUES ($1,CURRENT_DATE,'studio-image',1)
      ON CONFLICT (subject,day,kind) DO UPDATE SET count=nalu_usage.count+1 WHERE nalu_usage.count<$2
      RETURNING day::text AS quota_day`, [`user:${userId}`, limit])
    if (!reserved.rows.length) { await client.query('ROLLBACK'); return { limited: true } }
    await client.query('UPDATE nalu_studio_images SET quota_day=$3::date WHERE user_id=$1 AND id=$2', [userId, request.id, reserved.rows[0].quota_day])
    await client.query('COMMIT')
    return { leaseId }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

export async function completeStudioImage(client: ImageClient, userId: string, id: string, leaseId: string, image: GeneratedImage): Promise<StudioImageRow> {
  if (!image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 || !['image/png', 'image/jpeg'].includes(image.mimeType)) throw new Error('The generated image is invalid.')
  if (client instanceof CloudflareStore) return new CloudflareStudioImages(client).complete(userId,id,leaseId,image)
  const result = await client.query(`UPDATE nalu_studio_images SET status='ready',bytes=$4,mime_type=$5,width=$6,height=$7,lease_id=NULL,lease_until=NULL,updated_at=NOW()
    WHERE user_id=$1 AND id=$2 AND lease_id=$3 AND status='pending' AND lease_until>NOW() RETURNING *`, [userId, id, leaseId, image.bytes, image.mimeType, image.width, image.height])
  if (result.rows.length) return result.rows[0]
  const prior = await readStudioImage(client, userId, id)
  if (prior?.status === 'ready') return prior // first committed image wins
  throw new Error('The image request expired. Choose Generate imagery to retry.')
}

/** Refund at most once, against the original reservation day. A stale worker
 * cannot overwrite a replacement lease or refund its replacement's usage. */
export async function failStudioImage(client: ImageClient, userId: string, id: string, leaseId: string): Promise<void> {
  if (client instanceof CloudflareStore) return new CloudflareStudioImages(client).fail(userId,id,leaseId)
  await client.query('BEGIN')
  try {
    const failed = await client.query(`UPDATE nalu_studio_images SET status='failed',lease_id=NULL,lease_until=NULL,updated_at=NOW()
      WHERE user_id=$1 AND id=$2 AND lease_id=$3 AND status='pending' RETURNING quota_day::text AS quota_day`, [userId, id, leaseId])
    if (failed.rows[0]?.quota_day) await client.query(`UPDATE nalu_usage SET count=GREATEST(count-1,0) WHERE subject=$1 AND day=$2::date AND kind='studio-image'`, [`user:${userId}`, failed.rows[0].quota_day])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}
