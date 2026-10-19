import { createHmac, timingSafeEqual } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareTaskLedger } from './_cloudflareTaskLedger'
import type { ConnectionClient } from './_connectionStore'

export type BrowserTask = { id: string; title: string; status: string; detail: string; meta: Record<string, any> }

// Accounts can edit their own shared task ledger. A ledger row alone must not
// authorize operations on an arbitrary deployment-key provider task ID.
export function browserBinding(key: string, owner: string, id: string, remoteId: string, sessionId: string): string {
  return createHmac('sha256', key).update(JSON.stringify(['nalu-browser-v2', owner, id, remoteId, sessionId])).digest('hex')
}
export function validBrowserBinding(key: string, owner: string, task: BrowserTask): boolean {
  const { remoteId, sessionId, binding } = task.meta
  if (!key || !/^[a-zA-Z0-9-]{1,128}$/.test(remoteId || '') || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId || '') || !/^[a-f0-9]{64}$/.test(binding || '')) return false
  return timingSafeEqual(Buffer.from(binding, 'hex'), Buffer.from(browserBinding(key, owner, task.id, remoteId, sessionId), 'hex'))
}
export class BrowserTaskStore {
  constructor(readonly client: ConnectionClient) {}
  async get(owner: string, id: string): Promise<BrowserTask | null> {
    if (this.client instanceof CloudflareStore) {
      const result = await this.client.query("SELECT id,title,status,detail,meta FROM nalu_tasks WHERE user_id=?1 AND id=?2 AND source='browser'", [owner, id])
      const row = result.results[0] as Record<string, unknown> | undefined
      return row ? {
        id: String(row.id || ''),
        title: String(row.title || ''),
        status: String(row.status || ''),
        detail: String(row.detail || ''),
        meta: JSON.parse(String(row.meta || '{}')) as Record<string, any>,
      } : null
    }
    const row = (await this.client.query("SELECT id,title,status,detail,meta FROM nalu_tasks WHERE user_id=$1 AND id=$2 AND source='browser'", [owner, id])).rows[0] as Record<string, unknown> | undefined
    return row ? {
      id: String(row.id || ''),
      title: String(row.title || ''),
      status: String(row.status || ''),
      detail: String(row.detail || ''),
      meta: (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta || {}) as Record<string, any>,
    } : null
  }
  async save(owner: string, task: BrowserTask): Promise<void> {
    if (this.client instanceof CloudflareStore) {
      if (!await new CloudflareTaskLedger(this.client).log(owner, task.id, { source: 'browser', ...task, progress: task.status === 'done' ? 1 : 0 })) throw new Error('Browser task ownership changed')
      return
    }
    const result = await this.client.query(`INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,meta,updated_at)
      VALUES($1,$2,'browser',$3,$4,$5,$6,$7::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET
      detail=EXCLUDED.detail,status=EXCLUDED.status,progress=EXCLUDED.progress,meta=EXCLUDED.meta,updated_at=NOW()
      WHERE nalu_tasks.user_id=$2 RETURNING id`, [task.id, owner, task.title, task.detail, task.status, task.status === 'done' ? 1 : 0, JSON.stringify(task.meta)])
    if (!result.rows.length) throw new Error('Browser task ownership changed')
  }
}
