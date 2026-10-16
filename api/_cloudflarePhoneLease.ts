import { randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'

/** Serializes a phone worker without holding a transaction across network I/O.
 * Individual external actions still require their own permanent send claim. */
export class CloudflarePhoneLease {
  constructor(readonly store: CloudflareStore, readonly uid: string, readonly scope: string) {}
  async claim(): Promise<string | null> {
    const token = randomUUID()
    const result = await this.store.batch([{ sql: `INSERT INTO nalu_phone_leases(user_id,scope,token,expires_at)
      VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+6 minutes')) ON CONFLICT(user_id,scope)
      DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
      WHERE nalu_phone_leases.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING token`, params: [this.uid, this.scope, token] }])
    return result.results[0].results.length ? token : null
  }
  async valid(token: string) {
    return !!(await this.store.query("SELECT 1 FROM nalu_phone_leases WHERE user_id=? AND scope=? AND token=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')", [this.uid, this.scope, token])).results.length
  }
  async release(token: string) {
    await this.store.batch([{ sql: 'DELETE FROM nalu_phone_leases WHERE user_id=? AND scope=? AND token=?', params: [this.uid, this.scope, token] }])
  }
}
