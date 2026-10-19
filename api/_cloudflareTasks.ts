import { waitUntil } from '@vercel/functions'
import { deliverPushUpdates, pushConfigured } from './_push'
import { deliverTaskCompletions } from './_taskCompletion'
import { ownsPhone } from './_phoneOwner'
import { CloudflareQuestions } from './_cloudflareQuestions'
import { handleVoiceRoute } from './_voiceRoute'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareFlows, flowArray } from './_cloudflareFlows'
import { listTeam } from './_team'
import { validateDispatch } from './_tasks'
import { shallowJsonMerge } from './_cloudflareJson'
import { continuationId, deferPipelineTask, PipelineContinuationError } from './_pipelineContinuation'
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const expiry = "strftime('%Y-%m-%dT%H:%M:%fZ','now','+120 seconds')"
const fields = 't.id,t.source,t.title,t.detail,t.status,t.progress,t.events,t.meta,t.created_at,t.updated_at'
const kinds = ['chat','ide','autopilot','pipeline']
const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0,max) : ''
const task = (row: any) => row ? { ...row, events: JSON.parse(row.events || '[]'), meta: JSON.parse(row.meta || '{}') } : null

export async function handleCloudflareTasks(store: CloudflareStore, owner: string, body: any, res: any): Promise<boolean> {
  if (await handleVoiceRoute(store,owner,body,res)) return true
  if (await new CloudflareQuestions(store).handle(owner,body,res)) return true
  const action = body.action
  if (!['task-dispatch','task-workers','task-claim','task-update','task-cancel'].includes(action)) return false
  const error = (message: string, status = 400) => { res.status(status).json({ error: message }); return true }
  if (action === 'task-dispatch') {
    const invalid = validateDispatch(body)
    if (invalid) return error(invalid)
    const member = body.memberId ? (await listTeam(store,owner)).find(item => item.active && item.id === body.memberId) : undefined
    if (body.memberId && !member) return error('team member not found',404)
    const requestId = body.requestId || randomBytes(18).toString('hex'), pipeline = body.kind === 'pipeline'
    const id = 'remote_' + createHash('sha256').update(`${owner}\0${requestId}`).digest('hex').slice(0,32)
    const repo = pipeline ? '' : body.repo.trim(), prompt = pipeline ? '' : body.prompt.trim(), target = pipeline ? 'cloud' : 'desktop'
    const flowId = pipeline ? body.flowId.trim() : null, mode = pipeline ? body.mode || 'run' : null
    let title = prompt.slice(0,300), resumeStartedAt: number | undefined
    if (pipeline) {
      const flow = flowArray(await new CloudflareFlows(store).read(owner))?.find(item => String(item.id) === flowId)
      if (!flow) return error('pipeline not found',404)
      if (mode === 'resume') {
        if (!Number.isFinite(flow.run?.startedAt) || flow.run.startedAt <= 0) return error('pipeline has no saved run to resume',409)
        resumeStartedAt = flow.run.startedAt
      }
      title = `${mode === 'resume' ? 'Resume' : 'Run'} ${String(flow.name || 'AutoPilot')}`.slice(0,300)
    }
    const meta = { kind:'remote',taskType:body.kind,repo,target,...(member ? { memberId:member.id,memberName:member.name,memberVoice:member.voice,extension:member.extension } : {}),...(pipeline ? {flowId,mode} : {}),...(resumeStartedAt ? {pipelineContinuation:{flowId,startedAt:resumeStartedAt}} : {}) }
    const saved = await store.batch([
      { sql: `INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta)
        VALUES(?,?,'mobile',?,'Waiting for a desktop worker','queued',0,json_array(json_object('t',${now},'m','Queued for desktop')),?) ON CONFLICT(id) DO NOTHING`, params:[id,owner,title,JSON.stringify(meta)] },
      { sql: `INSERT INTO nalu_task_jobs(id,user_id,request_id,kind,repo,prompt,target,flow_id,mode) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
        WHERE EXISTS(SELECT 1 FROM nalu_tasks WHERE id=?1 AND user_id=?2) ON CONFLICT(user_id,request_id) DO NOTHING`,params:[id,owner,requestId,body.kind,repo,prompt,target,flowId,mode] },
      { sql:`SELECT ${fields},j.kind,j.repo,j.prompt,j.flow_id,j.mode FROM nalu_task_jobs j JOIN nalu_tasks t ON t.id=j.id AND t.user_id=j.user_id WHERE j.user_id=? AND j.request_id=?`,params:[owner,requestId] },
    ])
    const row = task(saved.results[2].results[0])
    if (!row || (row.meta.memberId || null) !== (member?.id || null) || row.kind !== body.kind || row.repo !== repo || row.prompt !== prompt || (row.flow_id ?? null) !== flowId || (row.mode ?? null) !== mode) return error('requestId was already used for a different task',409)
    const { kind:_k,repo:_r,prompt:_p,flow_id:_f,mode:_m,...result } = row
    res.status(202).json({ok:true,task:result});return true
  }
  if (action === 'task-workers') {
    const rows = (await store.query(`SELECT worker_id AS workerId,repos,kinds,last_seen_at AS lastSeenAt,julianday(last_seen_at)>julianday('now','-120 seconds') AS online
      FROM nalu_task_workers WHERE user_id=? ORDER BY last_seen_at DESC LIMIT 100`,[owner])).results
    res.status(200).json({ok:true,workers:rows.map(row => ({...row,repos:JSON.parse(String(row.repos)),kinds:JSON.parse(String(row.kinds)),online:!!row.online}))});return true
  }
  if (action === 'task-claim') {
    if (!identifier(body.workerId)) return error('invalid workerId')
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length>100 || body.repos.some((repo: any) => typeof repo !== 'string' || !repo.trim() || repo.length>2048 || /[\x00-\x1f]/.test(repo))) return error('repos must list 1–100 explicitly allowed repository names or paths')
    const allowed = body.kinds ?? kinds
    if (!Array.isArray(allowed) || !allowed.length || allowed.some(kind => !kinds.includes(kind))) return error('invalid worker kinds')
    const repos = [...new Set(body.repos.map((repo: string) => repo.trim()))], lease = randomBytes(32).toString('hex'), expired = randomUUID()
    const saved = await store.batch([
      {sql:`INSERT INTO nalu_task_workers(user_id,worker_id,repos,kinds,last_seen_at) VALUES(?,?,?,?,${now}) ON CONFLICT(user_id,worker_id) DO UPDATE SET repos=excluded.repos,kinds=excluded.kinds,last_seen_at=excluded.last_seen_at`,params:[owner,body.workerId,JSON.stringify(repos),JSON.stringify(allowed)]},
      {sql:`UPDATE nalu_task_jobs SET status='failed',lease_token=NULL,lease_expires_at=NULL,mutation_token=? WHERE user_id=? AND status='running' AND julianday(lease_expires_at)<=julianday('now')`,params:[expired,owner]},
      {sql:`UPDATE nalu_tasks SET status='failed',detail='Desktop worker disconnected; review changes before retrying',events=json_insert(events,'$[#]',json_object('t',${now},'m','Worker lease expired; task was not replayed')),updated_at=${now}
        WHERE user_id=? AND id IN (SELECT id FROM nalu_task_jobs WHERE user_id=? AND mutation_token=?)`,params:[owner,owner,expired]},
      {sql:`UPDATE nalu_task_jobs SET status='running',worker_id=?2,lease_token=?5,lease_expires_at=${expiry} WHERE user_id=?1 AND status='queued'
        AND id=(SELECT id FROM nalu_task_jobs WHERE user_id=?1 AND status='queued' AND (kind='pipeline' OR repo IN (SELECT value FROM json_each(?3))) AND kind IN (SELECT value FROM json_each(?4)) ORDER BY created_at,id LIMIT 1)`,params:[owner,body.workerId,JSON.stringify(repos),JSON.stringify(allowed),lease]},
      {sql:`UPDATE nalu_tasks SET status='running',detail='Desktop worker started',events=json_insert(events,'$[#]',json_object('t',${now},'m','Desktop worker started')),updated_at=${now}
        WHERE user_id=? AND id IN (SELECT id FROM nalu_task_jobs WHERE user_id=? AND lease_token=?)`,params:[owner,owner,lease]},
      {sql:`SELECT ${fields},j.kind,j.repo,j.prompt,j.target,j.flow_id,j.mode,j.lease_token,j.lease_expires_at FROM nalu_task_jobs j JOIN nalu_tasks t ON t.id=j.id AND t.user_id=j.user_id WHERE j.user_id=? AND j.lease_token=?`,params:[owner,lease]},
    ])
    const row=task(saved.results[5].results[0])
    if (!row) {res.status(200).json({ok:true,task:null});return true}
    const {kind,repo,prompt,target,flow_id,mode,lease_token,lease_expires_at,...result}=row
    res.status(200).json({ok:true,task:{...result,request:{kind,repo,prompt,target,...(kind==='pipeline'?{flowId:flow_id,mode,...(continuationId(result.meta)?{startedAt:continuationId(result.meta)}:{})}:{})},leaseToken:lease_token,leaseExpiresAt:lease_expires_at}});return true
  }
  const id=clean(body.id,128), mutation=randomUUID()
  if (!id) return error('id required')
  if (action === 'task-cancel') {
    const saved=await store.batch([
      {sql:"UPDATE nalu_task_jobs SET status='cancelled',mutation_token=? WHERE user_id=? AND id=? AND status IN ('queued','running','waiting')",params:[mutation,owner,id]},
      {sql:`UPDATE nalu_tasks SET status='cancelled',detail='Cancellation requested',events=json_insert(events,'$[#]',json_object('t',${now},'m','Cancellation requested')),updated_at=${now} WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=? AND mutation_token=?) RETURNING *`,params:[owner,id,id,mutation]},
    ])
    const row=task(saved.results[1].results[0]);if(!row)return error('active remote task not found',404)
    res.status(200).json({ok:true,task:row});return true
  }
  if(!identifier(body.workerId)||typeof body.leaseToken!=='string'||!/^[a-f0-9]{64}$/.test(body.leaseToken))return error('workerId and leaseToken required')
  const status=body.status||'running'
  if(['queued','waiting'].includes(status)) {
    try { const task=await deferPipelineTask(store,owner,body);res.status(200).json({ok:true,task,cancelRequested:task.status==='cancelled'}) }
    catch(cause){if(!(cause instanceof PipelineContinuationError))throw cause;return error(cause.message,409)}
    return true
  }
  if(!['running','done','failed','cancelled'].includes(status))return error('invalid task status')
  if(body.progress!=null&&(typeof body.progress!=='number'||!Number.isFinite(body.progress)))return error('progress must be a finite number')
  const progress=body.progress==null?null:Math.max(0,Math.min(1,body.progress)),detail=body.detail==null?null:clean(body.detail,4000),event=body.event==null?null:clean(body.event,500)
  const meta={...(typeof body.result==='string'?{result:body.result.slice(0,16000)}:{}),...(['done','failed'].includes(status)?{completedAt:new Date().toISOString()}:{})}
  const saved=await store.batch([
    {sql:`UPDATE nalu_task_jobs SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE ?5 END,mutation_token=?6,
      lease_expires_at=CASE WHEN ?5='running' AND status<>'cancelled' THEN ${expiry} ELSE lease_expires_at END
      WHERE id=?1 AND user_id=?2 AND worker_id=?3 AND lease_token=?4 AND (status='cancelled' OR (status='running' AND julianday(lease_expires_at)>julianday('now')))
        AND NOT (?5='done' AND EXISTS(SELECT 1 FROM nalu_tasks WHERE id=?1 AND json_type(meta,'$.pendingQuestion') IS NOT NULL))`,params:[id,owner,body.workerId,body.leaseToken,status,mutation]},
    {sql:`UPDATE nalu_tasks SET status=CASE WHEN (SELECT status FROM nalu_task_jobs WHERE id=?1)='running' AND json_type(meta,'$.pendingQuestion') IS NOT NULL THEN 'waiting' ELSE (SELECT status FROM nalu_task_jobs WHERE id=?1) END,
      progress=CASE WHEN (SELECT status FROM nalu_task_jobs WHERE id=?1)='done' THEN 1 ELSE COALESCE(?4,progress) END,
      detail=CASE WHEN (SELECT status FROM nalu_task_jobs WHERE id=?1)='cancelled' THEN 'Cancelled' ELSE COALESCE(?5,detail) END,
      events=CASE WHEN ?6 IS NULL THEN events ELSE json_insert(events,'$[#]',json_object('t',${now},'m',?6)) END,
      meta=${shallowJsonMerge('nalu_tasks.meta','?7')},updated_at=${now}
      WHERE id=?1 AND user_id=?2 AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=?1 AND mutation_token=?3) RETURNING *`,params:[id,owner,mutation,progress,detail,event,JSON.stringify(meta)]},
    {sql:`UPDATE nalu_task_workers SET last_seen_at=${now} WHERE user_id=? AND worker_id=? AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=? AND mutation_token=?)`,params:[owner,body.workerId,id,mutation]},
  ])
  const row=task(saved.results[1].results[0]);if(!row)return error('task lease expired, changed, or does not belong to this worker',409)
  if(['done','failed'].includes(row.status)&&(ownsPhone(owner)||pushConfigured()))waitUntil(deliverTaskCompletions(owner))
  res.status(200).json({ok:true,task:row,cancelRequested:row.status==='cancelled'});return true
}
