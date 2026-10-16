import type { Attachment } from './extractText'

const CHUNK = 786432
const tokenNow = () => localStorage.getItem('nalu-token') || ''
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('')
function assertOwner(token: string) {
  if (!token || tokenNow() !== token) throw new Error('Your account changed. Reopen this chat to load its images.')
}
async function request(token: string, body: Record<string, unknown>) {
  assertOwner(token)
  const response = await fetch('/api/task-attachments', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const data = await response.json()
  assertOwner(token)
  if (!response.ok) throw new Error(data.error || 'Could not save this image to your account.')
  return data
}

/** Store image bytes privately in R2 before the chat sync discards its inline copy. */
export async function saveChatAttachment(attachment: Attachment, chatId: string, token: string): Promise<Attachment> {
  if (!attachment.isImage || attachment.storage || !attachment.dataUrl || !token) return attachment
  assertOwner(token)
  const blob = await (await fetch(attachment.dataUrl)).blob()
  const bytes = await blob.arrayBuffer(), sha256 = await digest(bytes)
  const { attachment: meta } = await request(token, { action: 'begin', meta: { sourceId: `chat:${chatId}:upload:${attachment.id}`, taskId: `chat_${chatId}`, filename: attachment.name, title: attachment.name, mime: blob.type, size: blob.size, sha256 } })
  for (let part = 0; part < meta.parts; part++) {
    const chunk = new Uint8Array(bytes.slice(part * CHUNK, (part + 1) * CHUNK))
    let binary = ''
    for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192))
    await request(token, { action: 'part', id: meta.id, part, base64: btoa(binary) })
  }
  await request(token, { action: 'finish', id: meta.id })
  return { ...attachment, storage: { id: meta.id, parts: meta.parts, mime: blob.type, size: blob.size, sha256 } }
}

/** No public URLs or token query strings: retrieve and verify the owner's bytes. */
export async function loadChatAttachment(attachment: Attachment, token: string): Promise<string | undefined> {
  if (attachment.dataUrl) return attachment.dataUrl
  const meta = attachment.storage
  if (!meta) return undefined
  assertOwner(token)
  if (!/^att_[a-f0-9]{64}$/.test(meta.id) || !Number.isInteger(meta.parts) || meta.parts < 1 || meta.parts > 134 || !/^image\/[a-z0-9.+-]+$/i.test(meta.mime)) throw new Error('This image has invalid saved metadata.')
  const chunks: ArrayBuffer[] = []
  for (let part = 0; part < meta.parts; part++) {
    assertOwner(token)
    const response = await fetch(`/api/task-attachments?id=${encodeURIComponent(meta.id)}&part=${part}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) })
    const data = await response.json()
    assertOwner(token)
    if (!response.ok || typeof data.base64 !== 'string') throw new Error('This image could not be loaded. Retry to retrieve the saved file.')
    chunks.push(Uint8Array.from(atob(data.base64), c => c.charCodeAt(0)).buffer)
  }
  const blob = new Blob(chunks, { type: meta.mime })
  if (blob.size !== meta.size || await digest(await blob.arrayBuffer()) !== meta.sha256) throw new Error('This image did not pass its integrity check. Retry to retrieve it again.')
  const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob) })
  assertOwner(token)
  return url
}
