import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { publicBase, sign, verifySig } from './_telephony'
import type { MessageClient } from './_messageStore'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { ensureMessageSchema } from './_messageStore'

export function carrierMediaUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid image URL.')
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !(u.hostname === 'media.telnyx.com' || u.hostname.endsWith('.telnyx.com'))) throw new Error('Unsupported carrier image host.')
  return u.href
}

export async function fetchCarrierImage(value: string): Promise<Buffer> {
  const response = await fetch(carrierMediaUrl(value), { redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/') || Number(response.headers.get('content-length')) > 10_000_000) throw new Error('Could not read the attached image.')
  if (!response.body) throw new Error('The attached image was empty.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) { const { done,value } = await reader.read(); if (done) break; size += value.length; if (size > 10_000_000) throw new Error('The attached image is too large.'); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}

export async function compactImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 10_000_000) throw new Error('Image exceeds the size limit.')
  const image = sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().flatten({ background: '#ffffff' })
  for (const [size,quality] of [[1280,82],[1024,72],[800,60]]) {
    const jpeg = await image.clone().resize(size,size,{fit:'inside',withoutEnlargement:true}).jpeg({quality}).toBuffer()
    if (jpeg.length <= 900_000) return jpeg
  }
  throw new Error('The image could not be reduced to the MMS size limit.')
}

export async function saveMedia(c: MessageClient, uid: string, input: Buffer): Promise<string> {
  await ensureMessageSchema(c)
  const bytes = await compactImage(input)
  const id = 'media_' + createHash('sha256').update(uid).update(bytes).digest('hex').slice(0,40)
  if (c instanceof CloudflareStore) await new CloudflareMessages(c).saveMedia(uid, id, bytes)
  else await c.query("INSERT INTO nalu_message_media(id,user_id,mime,bytes) VALUES($1,$2,'image/jpeg',$3) ON CONFLICT(id) DO NOTHING",[id,uid,bytes])
  return id
}

export function mediaLink(uid: string, id: string): string {
  const expires = String(Math.floor(Date.now()/86400000)*86400000 + 7 * 86400000)
  const sig = sign(['message-media',uid,id,expires].join('|'))
  return `${publicBase()}/api/message-media?${new URLSearchParams({uid,id,expires,sig})}`
}
export function mediaLinkValid(q: Record<string, unknown>): boolean {
  const uid=String(q.uid||''),id=String(q.id||''),expires=String(q.expires||'')
  return /^media_[a-f0-9]{40}$/.test(id) && /^\d+$/.test(expires) && Number(expires)>Date.now() && Number(expires)<=Date.now()+8*86400000 && verifySig(['message-media',uid,id,expires].join('|'),String(q.sig||''))
}
