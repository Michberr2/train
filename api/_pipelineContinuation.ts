import { randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
import { flowArray } from './_cloudflareFlows'

type Client = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
export class PipelineContinuationError extends Error {}
export type PipelineWorker = { id: string; workerId: string; leaseToken: string }
function validWorker(worker: PipelineWorker): boolean { return !!worker && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(worker.id) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(worker.workerId) && /^[a-f0-9]{64}$/.test(worker.leaseToken) }

export async function pipelineWorkerState(client: Client | CloudflareStore, owner: string, flowId: string, worker: PipelineWorker): Promise<{ status: string; mode: string; startedAt?: number } | null> {
  if (!validWorker(worker)) return null
  const params = [worker.id, owner, flowId, worker.workerId, worker.leaseToken]
  const row = client instanceof CloudflareStore
    ? (await client.query(`SELECT j.status,j.mode,t.meta FROM nalu_task_jobs j JOIN nalu_tasks t ON t.id=j.id AND t.user_id=j.user_id
      WHERE j.id=? AND j.user_id=? AND j.flow_id=? AND j.worker_id=? AND j.lease_token=? AND j.kind='pipeline'
        AND j.status IN ('running','cancelled') AND julianday(j.lease_expires_at)>julianday('now')`, params)).results[0]
    : (await client.query(`SELECT j.status,j.mode,t.meta FROM nalu_task_jobs j JOIN nalu_tasks t ON t.id=j.id AND t.user_id=j.user_id
      WHERE j.id=$1 AND j.user_id=$2 AND j.flow_id=$3 AND j.worker_id=$4 AND j.lease_token=$5 AND j.kind='pipeline'
        AND j.status IN ('running','cancelled') AND j.lease_expires_at>NOW()`, params)).rows[0]
  return row ? { status: String(row.status), mode: String(row.mode), startedAt: continuationId(row.meta) } : null
}

/** Bind a fresh worker start before any provider/effect. Cancellation then
 * identifies this exact run even if the initial long HTTP reply is lost. */
export async function bindPipelineWorker(client: Client | CloudflareStore, owner: string, flowId: string, startedAt: number, worker: PipelineWorker): Promise<boolean> {
  if (!validWorker(worker)) return false
  const meta = JSON.stringify({ pipelineContinuation: { flowId, startedAt } })
  const params = [worker.id, owner, flowId, worker.workerId, worker.leaseToken, meta]
  if (client instanceof CloudflareStore) return !!(await client.batch([{ sql: `UPDATE nalu_tasks SET meta=json_set(meta,'$.pipelineContinuation',json_extract(?6,'$.pipelineContinuation'))
    WHERE id=?1 AND user_id=?2 AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=?1 AND user_id=?2 AND flow_id=?3 AND worker_id=?4 AND lease_token=?5
      AND kind='pipeline' AND status='running' AND julianday(lease_expires_at)>julianday('now')) RETURNING id`, params }])).results[0].results.length
  return !!(await client.query(`UPDATE nalu_tasks t SET meta=t.meta || $6::jsonb WHERE t.id=$1 AND t.user_id=$2
    AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=$1 AND user_id=$2 AND flow_id=$3 AND worker_id=$4 AND lease_token=$5
      AND kind='pipeline' AND status='running' AND lease_expires_at>NOW()) RETURNING t.id`, params)).rows.length
}

export async function pipelineTaskCancelled(client: Client | CloudflareStore, owner: string, flowId: string, id: string): Promise<boolean> {
  const row = client instanceof CloudflareStore
    ? (await client.query("SELECT status FROM nalu_task_jobs WHERE id=? AND user_id=? AND flow_id=? AND kind='pipeline'", [id, owner, flowId])).results[0]
    : (await client.query("SELECT status FROM nalu_task_jobs WHERE id=$1 AND user_id=$2 AND flow_id=$3 AND kind='pipeline'", [id, owner, flowId])).rows[0]
  return !row || ['cancelled', 'failed'].includes(String(row.status))
}

export function continuationId(meta: any): number | undefined {
  try { if (typeof meta === 'string') meta = JSON.parse(meta) } catch { return undefined }
  const value = meta?.pipelineContinuation?.startedAt
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function validate(flow: any, body: any) {
  const continuation = body.pipelineContinuation
  if (!continuation || typeof continuation.flowId !== 'string' || !Number.isFinite(continuation.startedAt) || continuation.startedAt <= 0 ||
      !flow || flow.run?.startedAt !== continuation.startedAt) throw new PipelineContinuationError('The pipeline checkpoint was replaced or is missing. Refresh before continuing.')
  const state = flow.run.status
  // A different runner may have finished between the worker reply and handoff.
  if (state === 'done') return 'done'
  if (state === 'stopped') return 'cancelled'
  if (state === 'error' || state === 'stuck') return 'failed'
  if (body.status === 'queued' && state === 'running' && flow.run.yielded === true && !flow.run.pendingEffect) return 'queued'
  if (body.status === 'waiting' && state === 'awaiting') return 'waiting'
  throw new PipelineContinuationError('The pipeline has no confirmed checkpoint for this handoff.')
}

/** Handoff is lease-checked and bound to the saved flow revision, not a worker's
 * assertion of completion. No executable request can turn into fresh work. */
export async function deferPipelineTask(client: Client | CloudflareStore, owner: string, body: any): Promise<any> {
  const flowId = body.pipelineContinuation?.flowId
  if (!['queued', 'waiting'].includes(body.status) || typeof flowId !== 'string' || !flowId || flowId.length > 200) throw new PipelineContinuationError('A valid pipeline continuation is required.')
  const meta = { pipelineContinuation: { flowId, startedAt: body.pipelineContinuation.startedAt }, ...(typeof body.result === 'string' ? { result: body.result.slice(0, 16000) } : {}) }
  const detail = body.status === 'waiting' ? 'Pipeline is waiting for your review.' : 'Pipeline saved its checkpoint; remaining work is queued.'
  if (client instanceof CloudflareStore) {
    const saved = await new CloudflareDataStore(client).read(owner, ['nalu-agent-flows'])
    const flow = flowArray(saved.values['nalu-agent-flows'])?.find(item => String(item.id) === flowId)
    const status = validate(flow, body), mutation = randomUUID()
    const result = await client.batch([
      { sql: `UPDATE nalu_task_jobs SET status=?5, mode='resume', worker_id=NULL,lease_token=NULL,lease_expires_at=NULL,mutation_token=?6
        WHERE id=?1 AND user_id=?2 AND kind='pipeline' AND flow_id=?7 AND status='running' AND worker_id=?3 AND lease_token=?4
          AND julianday(lease_expires_at)>julianday('now')
          AND EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=?8 AND revision=?9)`, params: [body.id, owner, body.workerId, body.leaseToken, status, mutation, flowId, 'user:' + owner, saved.revision] },
      { sql: `UPDATE nalu_tasks SET status=?4,progress=CASE WHEN ?4='done' THEN 1 ELSE progress END,detail=?5,
        meta=json_set(meta,'$.pipelineContinuation',json(?6),'$.mode','resume'),updated_at=${now},
        events=json_insert(events,'$[#]',json_object('t',${now},'m',?5))
        WHERE id=?1 AND user_id=?2 AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=?1 AND mutation_token=?3) RETURNING *`, params: [body.id, owner, mutation, status, ['queued', 'waiting'].includes(status) ? detail : `Pipeline ${status}`, JSON.stringify(meta.pipelineContinuation)] },
    ])
    const row = result.results[1].results[0]
    if (!row) throw new PipelineContinuationError('The worker lease or saved checkpoint changed before handoff.')
    return { ...row, meta: JSON.parse(String(row.meta || '{}')), events: JSON.parse(String(row.events || '[]')) }
  }
  await client.query('BEGIN')
  try {
    const saved = await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-agent-flows' FOR UPDATE", [owner])
    const flow = flowArray(saved.rows[0]?.value)?.find(item => String(item.id) === flowId)
    const status = validate(flow, body)
    const result = await client.query(`WITH updated AS (
      UPDATE nalu_task_jobs SET status=$5,mode='resume',worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE id=$1 AND user_id=$2 AND kind='pipeline' AND flow_id=$6 AND status='running' AND worker_id=$3 AND lease_token=$4 AND lease_expires_at>NOW()
      RETURNING id
    ) UPDATE nalu_tasks t SET status=$5,progress=CASE WHEN $5='done' THEN 1 ELSE t.progress END,detail=$7,
      meta=t.meta || $8::jsonb || '{"mode":"resume"}'::jsonb,updated_at=NOW(),
      events=t.events || jsonb_build_array(jsonb_build_object('t',NOW(),'m',$7::text))
      FROM updated u WHERE t.id=u.id AND t.user_id=$2 RETURNING t.*`, [body.id, owner, body.workerId, body.leaseToken, status, flowId, ['queued', 'waiting'].includes(status) ? detail : `Pipeline ${status}`, JSON.stringify(meta)])
    if (!result.rows[0]) throw new PipelineContinuationError('The worker lease changed before handoff.')
    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

/** An approval may be resumed from another client. Settle earlier queued or
 * waiting dispatch records only for that exact run; active workers own theirs. */
export async function settlePipelineContinuations(client: Client | CloudflareStore, owner: string, flowId: string, startedAt: number, status: string): Promise<void> {
  if (!['done', 'failed', 'cancelled'].includes(status)) return
  if (client instanceof CloudflareStore) {
    const mutation = randomUUID()
    await client.batch([
      { sql: `UPDATE nalu_task_jobs SET status=?4,mutation_token=?5 WHERE user_id=?1 AND kind='pipeline' AND flow_id=?2 AND status IN ('queued','waiting')
        AND id IN (SELECT id FROM nalu_tasks WHERE user_id=?1 AND json_extract(meta,'$.pipelineContinuation.startedAt')=?3)`, params: [owner, flowId, startedAt, status, mutation] },
      { sql: `UPDATE nalu_tasks SET status=?3,progress=CASE WHEN ?3='done' THEN 1 ELSE progress END,detail=?4,updated_at=${now}
        WHERE user_id=?1 AND id IN (SELECT id FROM nalu_task_jobs WHERE user_id=?1 AND mutation_token=?2)`, params: [owner, mutation, status, `Pipeline ${status}`] },
    ])
  } else await client.query(`WITH settled AS (
    UPDATE nalu_task_jobs j SET status=$4 WHERE j.user_id=$1 AND j.kind='pipeline' AND j.flow_id=$2 AND j.status IN ('queued','waiting')
      AND EXISTS(SELECT 1 FROM nalu_tasks t WHERE t.id=j.id AND t.user_id=$1 AND t.meta->'pipelineContinuation'->>'startedAt'=$3) RETURNING j.id
    ) UPDATE nalu_tasks t SET status=$4,progress=CASE WHEN $4='done' THEN 1 ELSE t.progress END,detail=$5,updated_at=NOW()
      FROM settled s WHERE t.id=s.id AND t.user_id=$1`, [owner, flowId, String(startedAt), status, `Pipeline ${status}`])
}
