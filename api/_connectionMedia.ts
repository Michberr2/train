import crypto from 'node:crypto'
import { ensureAttachments, storeAttachment, CHUNK_BYTES, type AttachmentClient } from './_taskAttachments'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'

async function schema(c: AttachmentClient) {
  await ensureAttachments(c)
  if (c instanceof CloudflareStore) return
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_connection_media (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES nalu_task_attachments(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours')`)
}
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

/** Publish only an explicitly selected, completed file owned by this account.
 * The random URL grants access to this file for one day, never to the account. */
export async function connectionMediaUrl(c: AttachmentClient, userId: string, sourceId: string, kind: 'image' | 'video'): Promise<string> {
  await schema(c)
  const files = c instanceof CloudflareStore ? new CloudflareAttachments(c) : null
  const row = c instanceof CloudflareStore ? await files!.mediaSource(userId, sourceId) : (await c.query('SELECT id,meta FROM nalu_task_attachments WHERE user_id=$1 AND ready=TRUE AND (id=$2 OR meta->>\'sourceId\'=$2) ORDER BY created_at DESC LIMIT 1', [userId, sourceId])).rows[0]
  if (!row || !String(row.meta?.mime).startsWith(`${kind}/`)) throw new Error(`Save the ${kind} before publishing it.`)
  const token = crypto.randomBytes(32).toString('hex')
  if (c instanceof CloudflareStore) await files!.grantMedia(userId, row.id, hash(token))
  else await c.query('INSERT INTO nalu_connection_media(token_hash,user_id,attachment_id) VALUES($1,$2,$3)', [hash(token), userId, row.id])
  return `${(process.env.NALU_PUBLIC_BASE || 'https://n4lu.ai').replace(/\/+$/, '')}/api/connection-media?file=${token}`
}

/** A readable image for text-only social drafts; no HTML is sent as media. */
export async function storePostGraphic(c: AttachmentClient, userId: string, key: string, payload: Record<string, unknown>): Promise<string> {
  const raw = String(payload.title || payload.caption || payload.text || '').trim()
  if (!raw) throw new Error('The post has no text to render.')
  const escape = (s: string) => s.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
  const words = raw.slice(0, 500).split(/\s+/), lines: string[] = []
  let line = ''
  for (const word of words) {
    if ((line + ' ' + word).length > 32 && line) { lines.push(line); line = '' }
    line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  const shown = lines.slice(0, 12)
  if (lines.length > 12) shown[11] = shown[11].slice(0, 28) + '…'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#173e38"/><stop offset="1" stop-color="#315d50"/></linearGradient></defs><rect width="1080" height="1350" fill="url(#bg)"/><circle cx="990" cy="30" r="440" fill="#bfa373" opacity=".15"/><rect x="84" y="128" width="72" height="7" rx="3" fill="#f0d7a6"/><text x="84" y="${Math.max(310, 740 - shown.length * 36)}" fill="#fff7e7" font-family="sans-serif" font-size="52" font-weight="600">${shown.map((text, i) => `<tspan x="84" dy="${i ? 76 : 0}">${escape(text)}</tspan>`).join('')}</text><text x="84" y="1228" fill="#e7dcc5" font-family="sans-serif" font-size="25">${raw.length > 380 ? 'Read the full caption' : ''}</text></svg>`
  const sharp = (await import('sharp')).default
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer()
  const saved = await storeAttachment(c, userId, { sourceId: `post-graphic:${key}`, title: 'Post graphic', filename: 'post.jpg', mime: 'image/jpeg' }, bytes)
  return connectionMediaUrl(c, userId, saved.id, 'image')
}

export async function serveConnectionMedia(c: AttachmentClient, req: any, res: any): Promise<void> {
  const token = new URL(req.url, 'https://n4lu.ai').searchParams.get('file') || ''
  if (!/^[a-f0-9]{64}$/.test(token)) { res.status(404).end(); return }
  await schema(c)
  const files = c instanceof CloudflareStore ? new CloudflareAttachments(c) : null
  const row = c instanceof CloudflareStore ? await files!.grantedMedia(hash(token)) : (await c.query(`SELECT a.id,a.meta FROM nalu_connection_media m JOIN nalu_task_attachments a ON a.id=m.attachment_id AND a.user_id=m.user_id
    WHERE m.token_hash=$1 AND m.expires_at>NOW() AND a.ready=TRUE`, [hash(token)])).rows[0]
  if (!row || !/^(?:image\/(?:jpeg|png|webp)|video\/(?:mp4|webm))$/.test(row.meta?.mime)) { res.status(404).end(); return }
  const size = Number(row.meta.size)
  if (!Number.isSafeInteger(size) || size <= 0) { res.status(404).end(); return }
  let start = 0, end = size - 1
  const range = req.headers?.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) { res.status(416).setHeader('Content-Range', `bytes */${size}`); res.end(); return }
    if (!match[1]) start = Math.max(0, size - Number(match[2]))
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])) }
    if (start > end || start >= size) { res.status(416).setHeader('Content-Range', `bytes */${size}`); res.end(); return }
    res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  } else res.status(200)
  res.setHeader('Content-Type', row.meta.mime); res.setHeader('Content-Length', end - start + 1)
  res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer')
  if (req.method === 'HEAD') { res.end(); return }
  // Stream database chunks; large videos never become one oversized response.
  res.flushHeaders?.()
  for (let part = Math.floor(start / CHUNK_BYTES); part <= Math.floor(end / CHUNK_BYTES); part++) {
    if (res.destroyed) return
    const saved = c instanceof CloudflareStore ? await files!.part(row.user_id, row.id, part) : (await c.query('SELECT bytes FROM nalu_task_attachment_parts WHERE attachment_id=$1 AND part=$2', [row.id, part])).rows[0]?.bytes
    if (!saved) { res.destroy(); return }
    const bytes = Buffer.from(saved).subarray(Math.max(0, start - part * CHUNK_BYTES), Math.min(CHUNK_BYTES, end - part * CHUNK_BYTES + 1))
    if (!res.write(bytes)) await new Promise<void>(resolve => {
      const done = () => { res.off('drain', done); res.off('close', done); resolve() }
      res.once('drain', done); res.once('close', done)
    })
  }
  res.end()
}
