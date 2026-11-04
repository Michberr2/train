import { randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import type { ConnectionClient } from './_connectionStore'

export type BrowserWorkspaceState = {
  profileId?: string; sessionId?: string; taskId?: string; remoteTaskId?: string
  status?: string; task?: string; result?: string; steps?: string[]
  files?: { id: string; fileName: string }[]
  pending?: 'profile' | 'session' | 'task'; requestId?: string
}
// Deliberately separate from the user-editable task ledger and synced documents.
// A lease serializes all provider mutations, including across tabs/devices.
export class BrowserWorkspaceStore {
  constructor(private client: ConnectionClient) {}
  async sql(pg: string, d1: string, values: (string | number | null)[], write = false): Promise<any[]> {
    if (this.client instanceof CloudflareStore) {
      return write ? (await this.client.batch([{ sql: d1, params: values }])).results[0].results
        : (await this.client.query(d1, values)).results
    }
    return (await this.client.query(pg, values)).rows
  }
  async init() {
    if (!(this.client instanceof CloudflareStore)) await this.client.query(`CREATE TABLE IF NOT EXISTS nalu_browser_workspaces (
      user_id TEXT PRIMARY KEY REFERENCES nalu_users(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT '{}', lease TEXT, lease_until BIGINT NOT NULL DEFAULT 0)`)
  }
  async claim(owner: string) {
    await this.sql('INSERT INTO nalu_browser_workspaces(user_id) VALUES($1) ON CONFLICT DO NOTHING',
      'INSERT INTO nalu_browser_workspaces(user_id) VALUES(?1) ON CONFLICT DO NOTHING', [owner], true)
    const lease = randomUUID(), now = Date.now()
    const rows = await this.sql('UPDATE nalu_browser_workspaces SET lease=$2,lease_until=$3 WHERE user_id=$1 AND lease_until<$4 RETURNING state',
      'UPDATE nalu_browser_workspaces SET lease=?2,lease_until=?3 WHERE user_id=?1 AND lease_until<?4 RETURNING state', [owner, lease, now + 90000, now], true)
    return rows.length ? { lease, state: JSON.parse(rows[0].state) as BrowserWorkspaceState } : null
  }
  async save(owner: string, lease: string, state: BrowserWorkspaceState) {
    const rows = await this.sql('UPDATE nalu_browser_workspaces SET state=$3 WHERE user_id=$1 AND lease=$2 RETURNING user_id',
      'UPDATE nalu_browser_workspaces SET state=?3 WHERE user_id=?1 AND lease=?2 RETURNING user_id', [owner, lease, JSON.stringify(state)], true)
    if (!rows.length) throw new Error('Browser ownership changed')
  }
  async release(owner: string, lease: string) {
    await this.sql('UPDATE nalu_browser_workspaces SET lease=NULL,lease_until=0 WHERE user_id=$1 AND lease=$2',
      'UPDATE nalu_browser_workspaces SET lease=NULL,lease_until=0 WHERE user_id=?1 AND lease=?2', [owner, lease], true)
  }
}
