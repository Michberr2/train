const MAX_BODY_BYTES = 3_500_000
const bytes = (text: string) => new TextEncoder().encode(text).byteLength

/** Split large histories by chat; compress an individual large conversation.
 * Every batch still uses the server's merge, so absent chats are never deleted.
 */
export async function syncBodies(entries: Record<string, string | null>, token: string): Promise<string[]> {
  const wrap = (values: Record<string, string | null>) => JSON.stringify({ action: 'setMany', token, entries: values })
  if (bytes(wrap(entries)) <= MAX_BODY_BYTES) return [wrap(entries)]
  const batches: Record<string, string | null>[] = []
  const other = { ...entries }; delete other['nalu-chats']
  if (Object.keys(other).length) batches.push(other)
  if (entries['nalu-chats']) {
    const chats: unknown = JSON.parse(entries['nalu-chats'])
    if (!Array.isArray(chats)) throw new Error('Saved chat history could not be read.')
    let batch: unknown[] = []
    for (const chat of chats) {
      if (batch.length && bytes(wrap({ 'nalu-chats': JSON.stringify([...batch, chat]) })) > MAX_BODY_BYTES) {
        batches.push({ 'nalu-chats': JSON.stringify(batch) }); batch = []
      }
      batch.push(chat)
    }
    if (batch.length) batches.push({ 'nalu-chats': JSON.stringify(batch) })
  }
  const bodies: string[] = []
  for (const batch of batches) {
    const plain = wrap(batch)
    if (bytes(plain) <= MAX_BODY_BYTES) { bodies.push(plain); continue }
    const compressed = new Uint8Array(await new Response(new Blob([JSON.stringify(batch)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    let binary = ''
    for (let i = 0; i < compressed.length; i += 8192) binary += String.fromCharCode(...compressed.subarray(i, i + 8192))
    const body = JSON.stringify({ action: 'setMany', token, compressedEntries: btoa(binary), encoding: 'gzip-base64' })
    if (bytes(body) > MAX_BODY_BYTES) throw new Error('This conversation is too large to sync in one request. It is kept on this device.')
    bodies.push(body)
  }
  return bodies
}
