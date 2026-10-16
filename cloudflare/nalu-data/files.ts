type Bucket = {
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; customMetadata: Record<string, string> }): Promise<unknown>
}
type Database = { prepare(sql: string): { bind(...params: unknown[]): { first(): Promise<Record<string, unknown> | null> } } }
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
async function reserve(db: Database, metric: string, amount: number, limit: number) {
  const row = await db.prepare(`INSERT INTO nalu_storage_allowances(metric,used) VALUES(?,?)
    ON CONFLICT(metric) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used<=?
    RETURNING used`).bind(metric, amount, limit).first()
  if (!row) throw new Error('Nalu reached its free file-storage allowance. Existing files are preserved.')
}
/** Private immutable chunks preserve the existing 768 KiB upload contract.
 * Reservations deliberately overcount uncertain/duplicate uploads: a lost
 * response must never create an unmetered retry or remove existing files. */
export async function fileOperation(db: Database, bucket: Bucket | undefined, action: string, input: any): Promise<Record<string, unknown>> {
  if (!bucket) throw new Error('Cloudflare R2 must be enabled before file storage can be used.')
  if (typeof input.owner !== 'string' || !input.owner || input.owner.length > 320 || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('Invalid file selection.')
  const key = `${await digest(encoder.encode(input.owner))}/chunks/${input.sha256}`
  const month = new Date().toISOString().slice(0, 7)
  if (action === 'get') {
    await reserve(db, `reads:${month}`, 1, 9000000)
    const object = await bucket.get(key)
    if (!object) return { found: false }
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.byteLength > 786432 || await digest(bytes) !== input.sha256) throw new Error('Stored file failed its integrity check.')
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    return { found: true, base64: btoa(binary), sha256: input.sha256 }
  }
  if (action !== 'put' || typeof input.base64 !== 'string' || !input.base64 || input.base64.length > 1048576 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new Error('Invalid file chunk.')
  const binary = atob(input.base64), bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  if (!bytes.length || bytes.length > 786432 || await digest(bytes) !== input.sha256) throw new Error('File chunk failed its integrity check.')
  await reserve(db, `reads:${month}`, 1, 9000000)
  const existing = await bucket.head(key)
  if (existing) {
    if (existing.size !== bytes.length || existing.customMetadata?.sha256 !== input.sha256) throw new Error('Stored file metadata does not match.')
    return { ok: true, existing: true, sha256: input.sha256 }
  }
  await reserve(db, 'stored-bytes', bytes.length, 9000000000)
  await reserve(db, `writes:${month}`, 1, 900000)
  await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { sha256: input.sha256 } })
  return { ok: true, sha256: input.sha256 }
}
