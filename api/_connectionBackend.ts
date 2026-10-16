import { getClient, userIdForToken } from './_db'
import { CloudflareStore } from './_cloudflareStore'
import type { ConnectionClient } from './_connectionStore'

export type ConnectionBackend = { client: ConnectionClient; connect(): Promise<void>; close(): Promise<void>; userId(token: string | null): Promise<string | null> }

/** The migration flag is deliberately opt-in. Production must retain its current
 * backend until the Cloudflare release and its dependent routes have been verified. */
export function connectionBackend(): ConnectionBackend {
  if (process.env.NALU_STORAGE_BACKEND === 'cloudflare') {
    const client = new CloudflareStore()
    return { client, async connect() {}, async close() {}, async userId(token) {
      if (!token) return null
      const result = await client.query('SELECT u.id FROM nalu_sessions s JOIN nalu_users u ON u.id=s.user_id WHERE s.token=?', [token])
      return result.results[0] ? String(result.results[0].id) : null
    } }
  }
  const client = getClient()
  return { client, async connect() { await client.connect() }, async close() { await client.end() }, async userId(token) { return await userIdForToken(client, token) || null } }
}
