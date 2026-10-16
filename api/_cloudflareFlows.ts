import { randomUUID } from 'node:crypto'
import { CloudflareStore, CloudflareConflict } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const expiry = "strftime('%Y-%m-%dT%H:%M:%fZ','now','+600 seconds')"
export function flowArray(value: unknown): any[] | null {
  for (let n = 0; n < 6 && typeof value === 'string'; n++) { try { value = JSON.parse(value) } catch { return null } }
  return Array.isArray(value) ? value : null
}

/** Flow ownership lives in D1. Every checkpoint also tests the same lease in
 * its document transaction, so an expired worker cannot publish stale state. */
export class CloudflareFlows {
  readonly documents: CloudflareDataStore
  constructor(readonly store: CloudflareStore) { this.documents = new CloudflareDataStore(store) }
  async read(owner: string) { return (await this.documents.read(owner, ['nalu-agent-flows'])).values['nalu-agent-flows'] }
  async all() {
    const rows = (await this.store.query("SELECT user_id FROM nalu_user_data WHERE key='nalu-agent-flows'")).results
    const result = []
    for (const row of rows) result.push({ user_id: String(row.user_id), value: await this.read(String(row.user_id)) })
    return result
  }
  async claim(owner: string, flowId: string): Promise<string | null> {
    const token = randomUUID()
    const saved = await this.store.batch([{ sql: `INSERT INTO nalu_flow_leases(user_id,flow_id,token,expires_at) VALUES(?,?,?,${expiry})
      ON CONFLICT(user_id,flow_id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
      WHERE julianday(nalu_flow_leases.expires_at)<=julianday('now') RETURNING token`, params: [owner, flowId, token] }])
    return saved.results[0].results.length ? token : null
  }
  async renew(owner: string, flowId: string, token: string): Promise<boolean> {
    return !!(await this.store.batch([{ sql: `UPDATE nalu_flow_leases SET expires_at=${expiry}
      WHERE user_id=? AND flow_id=? AND token=? AND julianday(expires_at)>julianday('now') RETURNING token`, params: [owner, flowId, token] }])).results[0].results.length
  }
  async release(owner: string, flowId: string, token: string) {
    await this.store.batch([{ sql: 'DELETE FROM nalu_flow_leases WHERE user_id=? AND flow_id=? AND token=?', params: [owner, flowId, token] }])
  }
  async save(owner: string, flow: any, active: boolean, token: string, observedStartedAt?: number): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!await this.renew(owner, flow.id, token)) throw new Error('The pipeline worker lease expired. Resume from its last saved step.')
      const saved = await this.documents.read(owner, ['nalu-agent-flows']), raw = saved.values['nalu-agent-flows'], flows = flowArray(raw)
      const index = flows?.findIndex(item => String(item.id) === String(flow.id)) ?? -1
      if (!flows || index < 0) return false
      const current = flows[index]
      if (active ? current.run?.startedAt !== flow.run?.startedAt : current.run?.startedAt !== observedStartedAt) return false
      if (active && current.run?.status === 'stopped') { flow.run.status = 'stopped'; return false }
      const runDays = new Map((flow.nodes || []).map((node: any) => [node.id, node.lastRunDay]))
      flows[index] = { ...current, results: flow.results, run: flow.run, lastRun: flow.lastRun, memory: flow.memory, approvals: flow.approvals, artifacts: flow.artifacts,
        nodes: current.nodes?.map((node: any) => runDays.get(node.id) ? { ...node, lastRunDay: runDays.get(node.id) } : node) }
      try {
        await this.store.commitDocuments(owner, saved.revision, [{ key: 'nalu-agent-flows', value: JSON.stringify(typeof raw === 'string' ? JSON.stringify(flows) : flows) }], { lease: { flowId: flow.id, token } })
        return true
      } catch (error) { if (!(error instanceof CloudflareConflict) || attempt === 4) throw error }
    }
    return false
  }
  async stop(owner: string, flowId: string, observedStartedAt?: number) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const saved = await this.documents.read(owner, ['nalu-agent-flows']), raw = saved.values['nalu-agent-flows'], flows = flowArray(raw)
      const flow = flows?.find(item => String(item.id) === String(flowId))
      if (!flow) return { ok: false, error: 'pipeline not found', code: 404 }
      if (flow.run?.startedAt !== observedStartedAt) return { ok: false, error: 'a newer run has started; refresh before stopping it', code: 409 }
      const time = Date.now()
      flow.run = { ...(flow.run || { step: 0, total: flow.nodes?.length || 0, startedAt: time }), status: 'stopped', heartbeat: time, updatedAt: time }
      try {
        await this.store.commitDocuments(owner, saved.revision, [{ key: 'nalu-agent-flows', value: JSON.stringify(typeof raw === 'string' ? JSON.stringify(flows) : flows) }], { stopTaskId: `flow_${flow.id}_${flow.run.startedAt}` })
        return { ok: true, status: 'stopped' }
      } catch (error) { if (!(error instanceof CloudflareConflict) || attempt === 4) throw error }
    }
    return { ok: false, error: 'pipeline changed while stopping', code: 409 }
  }
  async results(owner: string, id: string, results: Record<string, string>, lease?: { flowId: string; token: string }) {
    await this.store.batch([{ sql: `UPDATE nalu_tasks SET meta=json_set(meta,'$.results',json(?)),updated_at=${now} WHERE user_id=? AND id=?${lease ? " AND EXISTS(SELECT 1 FROM nalu_flow_leases WHERE user_id=? AND flow_id=? AND token=? AND julianday(expires_at)>julianday('now'))" : ''}`, params: [JSON.stringify(results), owner, id, ...(lease ? [owner,lease.flowId,lease.token] : [])] }])
  }
}
