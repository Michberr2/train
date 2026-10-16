import { CloudflareStore } from './_cloudflareStore'
import { handleCloudflareTasks } from './_cloudflareTasks'
// Durable remote work for signed-in devices. Logging a task never executes it:
// an explicitly started desktop worker must claim an allowed repository first.
import { waitUntil } from '@vercel/functions'
import { deliverTaskCompletions } from './_taskCompletion'
import { createHash, randomBytes } from 'node:crypto'
import { handleQuestionAction } from './_taskQuestions'
import { handleVoiceRoute } from './_voiceRoute'
import { listTeam } from './_team'

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }> }
type Body = Record<string, any>
const KINDS = ['chat', 'ide', 'autopilot', 'pipeline']
const ACTIONS = new Set(['task-dispatch', 'task-claim', 'task-update', 'task-cancel', 'task-workers', 'task-ask', 'task-question-status', 'task-answer', 'task-questions', 'task-notification-preferences', 'task-notification-deliver', 'voice-route'])
const FIELDS = 't.id, t.source, t.title, t.detail, t.status, t.progress, t.events, t.meta, t.created_at, t.updated_at'
const LEASE_SECONDS = 120
let schemaReady = false

export async function ensureTaskSchema(client: Client) {
  if (schemaReady) return
  await client.query(`
    CREATE TABLE IF NOT EXISTS nalu_task_jobs (
      id TEXT PRIMARY KEY REFERENCES nalu_tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      repo TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'desktop',
      flow_id TEXT,
      mode TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS nalu_task_jobs_pending ON nalu_task_jobs (user_id, status, created_at);
    CREATE TABLE IF NOT EXISTS nalu_task_workers (
      user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      repos JSONB NOT NULL DEFAULT '[]'::jsonb,
      kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, worker_id)
    );
  `)
  schemaReady = true
}

const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const bad = (res: any, error: string, status = 400) => res.status(status).json({ error })

export function validateDispatch(body: Body): string | null {
  if (!KINDS.includes(body.kind)) return 'kind must be chat, ide, autopilot, or pipeline'
  if (body.requestId != null && !identifier(body.requestId)) return 'invalid requestId'
  if (body.kind === 'pipeline') {
    if (typeof body.flowId !== 'string' || !body.flowId.trim() || body.flowId.length > 200) return 'flowId required'
    if (body.mode != null && !['run', 'resume'].includes(body.mode)) return 'pipeline mode must be run or resume'
    if (body.target != null && body.target !== 'cloud') return 'pipeline target must be cloud'
    return null
  }
  if (body.target != null && body.target !== 'desktop') return 'target must be desktop'
  if (typeof body.repo !== 'string' || !body.repo.trim() || body.repo.length > 2048 || /[\x00-\x1f]/.test(body.repo)) return 'a valid repository name or path is required'
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 20000 || body.prompt.includes('\0')) return 'prompt must contain 1–20000 characters'
  if (body.requestId != null && !identifier(body.requestId)) return 'invalid requestId'
  return null
}

// Returns false only when this is not a remote-task action. Authentication and
// the core schema have already been checked by data.ts before entering here.
export async function handleTaskAction(client: Client | CloudflareStore, userId: string, body: Body, res: any): Promise<boolean> {
  if (client instanceof CloudflareStore) return handleCloudflareTasks(client,userId,body,res)
  const action = String(body.action || '')
  if (!ACTIONS.has(action)) return false
  await ensureTaskSchema(client)
  if (await handleVoiceRoute(client, userId, body, res)) return true
  if (await handleQuestionAction(client, userId, body, res)) return true

  if (action === 'task-dispatch') {
    const error = validateDispatch(body)
    if (error) { bad(res, error); return true }
    const member = body.memberId ? (await listTeam(client, userId)).find(m => m.active && m.id === body.memberId) : undefined
    if (body.memberId && !member) { bad(res, 'team member not found', 404); return true }
    const requestId = body.requestId || randomBytes(18).toString('hex')
    const id = `remote_${createHash('sha256').update(`${userId}\0${requestId}`).digest('hex').slice(0, 32)}`
    const isPipeline = body.kind === 'pipeline'
    const repo = isPipeline ? '' : body.repo.trim(), prompt = isPipeline ? '' : body.prompt.trim()
    const target = isPipeline ? 'cloud' : 'desktop'
    const flowId = isPipeline ? body.flowId.trim() : null, mode = isPipeline ? body.mode || 'run' : null
    let title = prompt.slice(0, 300)
    if (isPipeline) {
      const saved = await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-agent-flows'", [userId])
      let flows = saved.rows[0]?.value
      for (let i = 0; i < 6 && typeof flows === 'string'; i++) { try { flows = JSON.parse(flows) } catch { flows = null } }
      const flow = Array.isArray(flows) ? flows.find((f: any) => f && String(f.id) === flowId) : null
      if (!flow) { bad(res, 'pipeline not found', 404); return true }
      title = `${mode === 'resume' ? 'Resume' : 'Run'} ${String(flow.name || 'AutoPilot')}`.slice(0, 300)
    }
    await client.query('BEGIN')
    try {
      await client.query(
        `INSERT INTO nalu_tasks (id,user_id,source,title,detail,status,progress,events,meta)
         VALUES ($1,$2,'mobile',$3,'Waiting for a desktop worker','queued',0,
           jsonb_build_array(jsonb_build_object('t',NOW(),'m','Queued for desktop')),$4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [id, userId, title, JSON.stringify({ kind: 'remote', taskType: body.kind, repo, target, ...(member ? { memberId: member.id, memberName: member.name, memberVoice: member.voice, extension: member.extension } : {}), ...(isPipeline ? { flowId, mode } : {}) })],
      )
      await client.query(
        `INSERT INTO nalu_task_jobs (id,user_id,request_id,kind,repo,prompt,target,flow_id,mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id,request_id) DO NOTHING`, [id, userId, requestId, body.kind, repo, prompt, target, flowId, mode],
      )
      const found = await client.query(
        `SELECT ${FIELDS},j.kind,j.repo,j.prompt,j.flow_id,j.mode FROM nalu_task_jobs j JOIN nalu_tasks t ON t.id=j.id
         WHERE j.user_id=$1 AND j.request_id=$2`, [userId, requestId],
      )
      const row = found.rows[0]
      if (!row || (row.meta?.memberId || null) !== (member?.id || null) || row.kind !== body.kind || row.repo !== repo || row.prompt !== prompt || (row.flow_id ?? null) !== flowId || (row.mode ?? null) !== mode) {
        await client.query('ROLLBACK')
        bad(res, 'requestId was already used for a different task', 409)
        return true
      }
      await client.query('COMMIT')
      const { kind: _kind, repo: _repo, prompt: _prompt, flow_id: _flowId, mode: _mode, ...task } = row
      res.status(202).json({ ok: true, task })
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    return true
  }

  if (action === 'task-workers') {
    const result = await client.query(
      `SELECT worker_id AS "workerId",repos,kinds,last_seen_at AS "lastSeenAt",
       last_seen_at > NOW() - INTERVAL '120 seconds' AS online
       FROM nalu_task_workers WHERE user_id=$1 ORDER BY last_seen_at DESC LIMIT 100`, [userId],
    )
    res.status(200).json({ ok: true, workers: result.rows })
    return true
  }

  if (action === 'task-claim') {
    if (!identifier(body.workerId)) { bad(res, 'invalid workerId'); return true }
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length > 100 || body.repos.some((r: unknown) => typeof r !== 'string' || !r.trim() || r.length > 2048 || /[\x00-\x1f]/.test(r))) {
      bad(res, 'repos must list 1–100 explicitly allowed repository names or paths'); return true
    }
    const repos = [...new Set(body.repos.map((r: string) => r.trim()))]
    const kinds = body.kinds == null ? KINDS : body.kinds
    if (!Array.isArray(kinds) || !kinds.length || kinds.some((k: unknown) => !KINDS.includes(String(k)))) { bad(res, 'invalid worker kinds'); return true }
    await client.query(
      `INSERT INTO nalu_task_workers (user_id,worker_id,repos,kinds,last_seen_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,NOW())
       ON CONFLICT (user_id,worker_id) DO UPDATE SET repos=EXCLUDED.repos,kinds=EXCLUDED.kinds,last_seen_at=NOW()`,
      [userId, body.workerId, JSON.stringify(repos), JSON.stringify(kinds)],
    )
    // An interrupted process may have made changes already. Do not replay its
    // prompt automatically when the lease expires; surface the failure instead.
    await client.query(
      `WITH expired AS (
         UPDATE nalu_task_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL
         WHERE user_id=$1 AND status='running' AND lease_expires_at <= NOW() RETURNING id
       ) UPDATE nalu_tasks t SET status='failed',detail='Desktop worker disconnected; review changes before retrying',
         events=t.events || jsonb_build_array(jsonb_build_object('t',NOW(),'m','Worker lease expired; task was not replayed')),updated_at=NOW()
         FROM expired e WHERE t.id=e.id AND t.user_id=$1`, [userId],
    )
    const leaseToken = randomBytes(32).toString('hex')
    const result = await client.query(
      `WITH candidate AS (
         SELECT j.id FROM nalu_task_jobs j WHERE j.user_id=$1 AND j.status='queued'
         AND (j.kind='pipeline' OR j.repo=ANY($3::text[])) AND j.kind=ANY($4::text[]) ORDER BY j.created_at,j.id
         FOR UPDATE OF j SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE nalu_task_jobs j SET status='running',worker_id=$2,lease_token=$5,
         lease_expires_at=NOW()+($6 * INTERVAL '1 second') FROM candidate c WHERE j.id=c.id
         RETURNING j.*
       ) UPDATE nalu_tasks t SET status='running',detail='Desktop worker started',
         events=t.events || jsonb_build_array(jsonb_build_object('t',NOW(),'m','Desktop worker started')),updated_at=NOW()
         FROM claimed c WHERE t.id=c.id AND t.user_id=$1
         RETURNING ${FIELDS},c.kind,c.repo,c.prompt,c.target,c.flow_id,c.mode,c.lease_token,c.lease_expires_at`,
      [userId, body.workerId, repos, kinds, leaseToken, LEASE_SECONDS],
    )
    const row = result.rows[0]
    if (!row) { res.status(200).json({ ok: true, task: null }); return true }
    const { kind, repo, prompt, target, flow_id, mode, lease_token, lease_expires_at, ...task } = row
    res.status(200).json({ ok: true, task: { ...task, request: { kind, repo, prompt, target, ...(kind === 'pipeline' ? { flowId: flow_id, mode } : {}) }, leaseToken: lease_token, leaseExpiresAt: lease_expires_at } })
    return true
  }

  const id = clean(body.id, 128)
  if (!id) { bad(res, 'id required'); return true }
  if (action === 'task-cancel') {
    const result = await client.query(
      `WITH cancelled AS (
         UPDATE nalu_task_jobs SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status IN ('queued','running') RETURNING id
       ) UPDATE nalu_tasks t SET status='cancelled',detail='Cancellation requested',
         events=t.events || jsonb_build_array(jsonb_build_object('t',NOW(),'m','Cancellation requested')),updated_at=NOW()
         FROM cancelled c WHERE t.id=c.id AND t.user_id=$2 RETURNING ${FIELDS}`, [id, userId],
    )
    if (!result.rows[0]) { bad(res, 'active remote task not found', 404); return true }
    res.status(200).json({ ok: true, task: result.rows[0] })
    return true
  }

  if (!identifier(body.workerId) || typeof body.leaseToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.leaseToken)) {
    bad(res, 'workerId and leaseToken required'); return true
  }
  const status = body.status || 'running'
  if (!['running', 'done', 'failed', 'cancelled'].includes(status)) { bad(res, 'invalid task status'); return true }
  if (body.progress != null && (typeof body.progress !== 'number' || !Number.isFinite(body.progress))) { bad(res, 'progress must be a finite number'); return true }
  const progress = body.progress == null ? null : Math.max(0, Math.min(1, body.progress))
  const detail = body.detail == null ? null : clean(body.detail, 4000)
  const event = body.event == null ? null : clean(body.event, 500)
  const meta = JSON.stringify({ ...(typeof body.result === 'string' ? {result:body.result.slice(0,16000)} : {}), ...(['done','failed'].includes(status) ? {completedAt:new Date().toISOString()} : {}) })
  const result = await client.query(
    `WITH updated AS (
       UPDATE nalu_task_jobs j SET status=CASE WHEN j.status='cancelled' THEN 'cancelled' ELSE $5 END,
         lease_expires_at=CASE WHEN $5='running' AND j.status <> 'cancelled' THEN NOW()+($10 * INTERVAL '1 second') ELSE j.lease_expires_at END
       WHERE j.id=$1 AND j.user_id=$2 AND j.worker_id=$3 AND j.lease_token=$4
         AND NOT ($5='done' AND EXISTS (SELECT 1 FROM nalu_tasks pending WHERE pending.id=j.id AND pending.meta->'pendingQuestion' IS NOT NULL))
         AND (j.status='cancelled' OR (j.status='running' AND j.lease_expires_at > NOW())) RETURNING j.*
     ) UPDATE nalu_tasks t SET status=CASE WHEN u.status='running' AND t.meta->'pendingQuestion' IS NOT NULL THEN 'waiting' ELSE u.status END,
       progress=CASE WHEN u.status='done' THEN 1 ELSE COALESCE($6::real,t.progress) END,
       detail=CASE WHEN u.status='cancelled' THEN 'Cancelled' ELSE COALESCE($7,t.detail) END,
       events=CASE WHEN $8::text IS NULL THEN t.events ELSE t.events || jsonb_build_array(jsonb_build_object('t',NOW(),'m',$8::text)) END,
       meta=t.meta || $9::jsonb,updated_at=NOW()
       FROM updated u WHERE t.id=u.id AND t.user_id=$2 RETURNING ${FIELDS}`,
    [id, userId, body.workerId, body.leaseToken, status, progress, detail, event, meta, LEASE_SECONDS],
  )
  if (!result.rows[0]) { bad(res, 'task lease expired, changed, or does not belong to this worker', 409); return true }
  await client.query('UPDATE nalu_task_workers SET last_seen_at=NOW() WHERE user_id=$1 AND worker_id=$2', [userId, body.workerId])
  if (['done','failed'].includes(result.rows[0].status)) waitUntil(deliverTaskCompletions(userId))
  res.status(200).json({ ok: true, task: result.rows[0], cancelRequested: result.rows[0].status === 'cancelled' })
  return true
}

/** Shared with the phone webhook: enqueue and acknowledge without running work
 * inside Twilio's short response deadline. The caller supplies a verified user. */
export async function enqueueTask(client: Client | CloudflareStore, userId: string, body: Body): Promise<{ code: number; data: Record<string, any> }> {
  let code = 500, data: Record<string, any> = { error: 'could not enqueue task' }
  const response = {
    status(value: number) { code = value; return response },
    json(value: Record<string, any>) { data = value; return response },
  }
  await handleTaskAction(client, userId, { ...body, action: 'task-dispatch' }, response)
  return { code, data }
}
