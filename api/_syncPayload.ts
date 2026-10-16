import { gunzipSync } from 'node:zlib'

export function syncEntries(body: Record<string, unknown>): Record<string, unknown> {
  let entries = body.entries
  if (body.compressedEntries !== undefined) {
    if (body.encoding !== 'gzip-base64' || typeof body.compressedEntries !== 'string' || body.compressedEntries.length > 3_600_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.compressedEntries)) throw new Error('Invalid compressed data.')
    entries = JSON.parse(gunzipSync(Buffer.from(body.compressedEntries, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'))
  }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Data entries must be an object.')
  return entries as Record<string, unknown>
}
