import { createHash, createHmac } from 'node:crypto'
import { DOCUMENT_INLINE_BYTES, DOCUMENT_MAX_BYTES, DOCUMENT_PART_BYTES, type WireDocument } from '../cloudflare/nalu-data/protocol'

export type CloudflareStatement = { sql: string; params?: Array<string | number | null> }
export type CloudflareDocument = { key: string; value: string; updated_at?: string }
export class CloudflareConflict extends Error {}

/** Explicit Cloudflare operations. This is not a pg.Client compatibility shim:
 * callers must choose an atomic D1 batch or a document revision commit. */
export class CloudflareStore {
  constructor(private url = process.env.CLOUDFLARE_DATA_URL || '', private secret = process.env.CLOUDFLARE_DATA_SECRET || '') {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || secret.length < 32) throw new Error('Cloudflare data service is not configured.')
    this.url = parsed.origin
  }
  private async call<T>(path: string, data: unknown): Promise<T> {
    const body = JSON.stringify(data), timestamp = String(Date.now())
    const signature = createHmac('sha256', this.secret).update(`${timestamp}\nPOST\n${path}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')
    // Never retry an uncertain write automatically. The calling operation owns
    // its durable claim or revision; a lost response must not duplicate work.
    const response = await fetch(this.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-nalu-time': timestamp, 'x-nalu-signature': signature }, body, signal: AbortSignal.timeout(20000) })
    const value = await response.json().catch(() => ({})) as any
    if (response.status === 409 && value.conflict) throw new CloudflareConflict('The saved data changed. Read and merge again.')
    if (!response.ok) throw new Error(value.error || 'Cloudflare could not confirm the database operation.')
    return value as T
  }
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: CloudflareStatement['params'] = []) {
    return this.call<{ results: T[] }>('/v1/query', { sql, params })
  }
  batch(statements: CloudflareStatement[]) { return this.call<{ results: Array<{ results: Record<string, unknown>[] }> }>('/v1/batch', { statements }) }
  async readDocuments(owner: string, keys: string[]): Promise<{ revision: string; entries: CloudflareDocument[] }> {
    const snapshot = await this.call<{ revision: string; entries: WireDocument[] }>('/v1/documents/read', { owner, keys })
    const entries: CloudflareDocument[] = []
    for (const item of snapshot.entries) {
      if (!item.manifest) { entries.push({ key: item.key, value: item.value ?? 'null', updated_at: item.updated_at }); continue }
      const { parts, sha256, byteLength } = item.manifest
      const buffers = new Map<string, Buffer>(), unique = [...new Set(parts)]
      for (let offset = 0; offset < unique.length; offset += 2) {
        const result = await this.call<{ parts: Array<{ sha256: string; base64: string }> }>('/v1/documents/parts/read', { owner, hashes: unique.slice(offset, offset + 2) })
        for (const part of result.parts) {
          const bytes = Buffer.from(part.base64, 'base64')
          if (createHash('sha256').update(bytes).digest('hex') !== part.sha256) throw new Error('Saved history failed its integrity check.')
          buffers.set(part.sha256, bytes)
        }
      }
      if (parts.some(hash => !buffers.has(hash))) throw new Error('Saved history is incomplete. No partial history was returned.')
      const bytes = Buffer.concat(parts.map(hash => buffers.get(hash)!))
      if (bytes.length !== byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Saved history failed its integrity check.')
      const value = bytes.toString('utf8'); JSON.parse(value)
      entries.push({ key: item.key, value, updated_at: item.updated_at })
    }
    return { revision: snapshot.revision, entries }
  }
  async commitDocuments(owner: string, revision: string, entries: CloudflareDocument[], options?: { lease?: { flowId: string; token: string }; stopTaskId?: string }) {
    if (!entries.length || entries.length > 20 || new Set(entries.map(item => item.key)).size !== entries.length) throw new Error('Invalid document update.')
    let totalBytes = 0
    for (const entry of entries) { JSON.parse(entry.value); totalBytes += Buffer.byteLength(entry.value) }
    if (totalBytes > DOCUMENT_MAX_BYTES) throw new Error('The document update exceeds the supported save size.')
    const wire: WireDocument[] = [], chunks = new Map<string, Buffer>()
    for (const entry of entries) {
      const bytes = Buffer.from(entry.value)
      if (bytes.length <= DOCUMENT_INLINE_BYTES) { wire.push(entry); continue }
      const parts: string[] = []
      for (let offset = 0; offset < bytes.length; offset += DOCUMENT_PART_BYTES) {
        const part = bytes.subarray(offset, offset + DOCUMENT_PART_BYTES), hash = createHash('sha256').update(part).digest('hex')
        parts.push(hash); chunks.set(hash, part)
      }
      wire.push({ key: entry.key, manifest: { parts, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length } })
    }
    const hashes = [...chunks.keys()], missing: string[] = []
    for (let offset = 0; offset < hashes.length; offset += 90) {
      const page = hashes.slice(offset, offset + 90)
      const existing = await this.call<{ parts: Array<{ sha256: string }> }>('/v1/documents/parts/check', { owner, hashes: page })
      const found = new Set(existing.parts.map(part => part.sha256))
      missing.push(...page.filter(hash => !found.has(hash)))
    }
    // Independent immutable parts can upload together. Publish the manifest
    // only after every upload is acknowledged; never retry an uncertain commit.
    for (let offset = 0; offset < missing.length; offset += 4) {
      const results = await Promise.allSettled(missing.slice(offset, offset + 4).map(sha256 => this.call('/v1/documents/parts/put', { owner, sha256, base64: chunks.get(sha256)!.toString('base64') })))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    return this.call<{ ok: true; revision: string }>('/v1/documents/commit', { owner, revision, entries: wire, ...options })
  }
  collectDocumentParts() { return this.call<{ ok: true; removed: number }>('/v1/documents/collect', {}) }
  async putChunk(owner: string, bytes: Buffer): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await this.call('/v1/files/put', { owner, sha256, base64: bytes.toString('base64') })
    return sha256
  }
  async getChunk(owner: string, sha256: string): Promise<Buffer | null> {
    const result = await this.call<{ found: boolean; base64?: string }>('/v1/files/get', { owner, sha256 })
    if (!result.found) return null
    const bytes = Buffer.from(result.base64 || '', 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('The downloaded file failed its integrity check.')
    return bytes
  }
}
