import { CloudflareStore } from './_cloudflareStore'
import { shallowJsonMerge } from './_cloudflareJson'
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const fields = 'id,source,title,detail,status,progress,events,meta,created_at,updated_at'
const decoded = (row: Record<string, unknown>) => ({ ...row, events: JSON.parse(String(row.events || '[]')), meta: JSON.parse(String(row.meta || '{}')) })

export class CloudflareTaskLedger {
  constructor(readonly store: CloudflareStore) {}
  async log(owner: string, id: string, body: { source?: string; title?: string; detail?: string | null; status?: string | null; progress?: number | null; event?: string | null; meta?: Record<string, unknown> }, lease?: { flowId: string; token: string }) {
    const guard = lease ? "EXISTS(SELECT 1 FROM nalu_flow_leases WHERE user_id=?2 AND flow_id=?10 AND token=?11 AND julianday(expires_at)>julianday('now'))" : "1"
    const result = await this.store.batch([{ sql: `INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta,updated_at)
      SELECT ?1,?2,?3,?4,?5,COALESCE(?6,'running'),COALESCE(?7,0),
      CASE WHEN ?8 IS NULL THEN '[]' ELSE json_array(json_object('t',${now},'m',?8)) END,COALESCE(?9,'{}'),${now} WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET source=excluded.source,
      title=CASE WHEN ?4<>'' THEN excluded.title ELSE nalu_tasks.title END,detail=COALESCE(?5,nalu_tasks.detail),
      status=COALESCE(?6,nalu_tasks.status),progress=COALESCE(?7,nalu_tasks.progress),
      events=CASE WHEN ?8 IS NULL THEN nalu_tasks.events ELSE json_insert(nalu_tasks.events,'$[#]',json_object('t',${now},'m',?8)) END,
      meta=${shallowJsonMerge('nalu_tasks.meta', '?9')},updated_at=${now}
      WHERE nalu_tasks.user_id=?2 AND ${guard}${lease ? " AND (nalu_tasks.status<>'cancelled' OR ?6='cancelled')" : ''} RETURNING ${fields}`,
      params: [id, owner, body.source || 'cli', body.title || '', body.detail ?? null, body.status ?? null, body.progress ?? null, body.event ?? null, body.meta ? JSON.stringify(body.meta) : null, ...(lease ? [lease.flowId, lease.token] : [])] }])
    return result.results[0].results[0] ? decoded(result.results[0].results[0]) : null
  }
  async list(owner: string, limit = 300, since: string | null = null) {
    const result = await this.store.query(`SELECT ${fields} FROM nalu_tasks WHERE user_id=?1
      AND (?2 IS NULL OR julianday(updated_at)>julianday(?2)) ORDER BY updated_at DESC LIMIT ?3`, [owner, since, limit])
    return result.results.map(decoded)
  }
  async clear(owner: string, id?: string): Promise<boolean> {
    if (id) {
      const result = await this.store.batch([
        { sql: "SELECT id FROM nalu_tasks WHERE user_id=?1 AND id=?2 AND status IN ('queued','running','waiting')", params: [owner, id] },
        { sql: "DELETE FROM nalu_tasks WHERE user_id=?1 AND id=?2 AND status NOT IN ('queued','running','waiting')", params: [owner, id] },
      ])
      return !result.results[0].results.length
    }
    await this.store.batch([{ sql: "DELETE FROM nalu_tasks WHERE user_id=? AND status IN ('done','failed','cancelled')", params: [owner] }])
    return true
  }
  async preserveFlowResults(owner: string, flow: any): Promise<void> {
    const started = Number(flow?.run?.startedAt)
    if (!flow?.id || !Number.isFinite(started) || started <= 0 || !flow.results || typeof flow.results !== 'object' || Array.isArray(flow.results)) return
    const status = flow.run.status === 'done' ? 'done' : flow.run.status === 'running' ? 'running' : flow.run.status === 'awaiting' ? 'waiting' : flow.run.status === 'stopped' ? 'cancelled' : 'failed'
    await this.store.batch([{ sql: `INSERT INTO nalu_tasks(id,user_id,source,title,status,meta,updated_at)
      VALUES(?1,?2,'pipeline',?3,?4,?5,${now}) ON CONFLICT(id) DO UPDATE SET
      meta=json_set(nalu_tasks.meta,'$.results',json(${shallowJsonMerge("json_extract(nalu_tasks.meta,'$.results')", "json_extract(?5,'$.results')")})),
      status=CASE WHEN nalu_tasks.status IN ('done','failed','cancelled') THEN nalu_tasks.status ELSE excluded.status END,
      updated_at=${now} WHERE nalu_tasks.user_id=?2`, params: [`flow_${flow.id}_${started}`, owner, String(flow.name || 'AutoPilot').slice(0, 300), status, JSON.stringify({ results: flow.results, flowId: flow.id })] }])
  }
}
