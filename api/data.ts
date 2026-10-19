import { projectKeys, ProjectDataValidationError } from '../shared/projectMerge'
import { writeProjectData } from './_projectData'
import { sendIsolatedArtifact } from './_artifactIsolation'
import { handleNotebook } from './_notebook'
import { cloudflareData } from './_cloudflareData'
import { syncEntries } from './_syncPayload'
import { appendConversationTurn } from './_chatMerge'
import { extractNotes } from './_notes'
import { reserveDailyQuota } from './_limits'
import { handlePushAction } from './_push'
// Nalu per-user data store (Neon Postgres). Mirrors the Dashboard's `nalu-*`
// localStorage keys so conversations, projects, plugins, automations, GitHub
// PAT, settings, etc. persist server-side and sync across n4lu.ai/.com + devices.
// POST { action: 'load'|'set'|'setMany'|'remove', token, ... }
import { runDueCrons, runOneFlow } from './_cron'
import { mediaLink } from './_messageMedia'
import { ownsPhone } from './_phoneOwner'
import { handleTaskAction } from './_tasks'
import { writeChatData, ChatDataValidationError } from './_chatMerge'
import { getClient, ensureSchema, userIdForToken, readToken, safeJson, newToken } from './_db'

const SHARE_DDL =
  'CREATE TABLE IF NOT EXISTS nalu_shares (id TEXT PRIMARY KEY, html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())'

// The message fields that hold generated Studio work. If an incoming save is
// missing one that the stored copy still has, we RESTORE it — the DB never
// drops a doc/sheet/deck/design/video, even if a client sends a slimmed payload.
const ARTIFACT_FIELDS = ['doc', 'sheet', 'deck', 'design', 'cad', 'video', 'image']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

// Robustly unwrap a value that may be JSON-string-encoded MORE THAN ONCE. The
// sync layer + setMany can double-encode arrays (a JSON string of a JSON string),
// so a single parse leaves us with a string, not an array — keep parsing until we
// reach the array (or give up). This is why chats/flows can fail to appear.
function deepParseArray(v: unknown): AnyObj[] | null {
  let cur: unknown = v
  for (let i = 0; i < 6; i++) {
    if (Array.isArray(cur)) return cur as AnyObj[]
    if (typeof cur !== 'string') return null
    try { cur = JSON.parse(cur) } catch { return null }
  }
  return Array.isArray(cur) ? (cur as AnyObj[]) : null
}

// Turn the user's stored chats into AutoPilot "activity" items (same shape as a
// task row) so the phone shows everything they've ever made — conversations plus
// every Studio artifact (docs, sheets, decks, sites, videos, CAD, images).
const STUDIO_KIND: Record<string, string> = {
  doc: 'Document', deck: 'Presentation', sheet: 'Spreadsheet',
  design: 'Website', video: 'Video', cad: 'CAD model', image: 'Image',
}
export function deriveChatActivity(chatsVal: unknown): AnyObj[] {
  const chats = deepParseArray(chatsVal)
  if (!chats) return []
  const items: AnyObj[] = []
  for (const c of chats.slice(0, 500)) {
    if (!c || !Array.isArray(c.messages)) continue
    const kinds: string[] = []
    let lastUser = ''
    for (const m of c.messages as AnyObj[]) {
      if (!m) continue
      if (m.role === 'user' && typeof m.content === 'string' && m.content) lastUser = m.content
      for (const f of ARTIFACT_FIELDS) if (m[f] != null && !kinds.includes(f)) kinds.push(f)
    }
    const labels = kinds.map((k) => STUDIO_KIND[k] || k)
    const ts = Number(c.createdAt) || 0
    const iso = ts ? new Date(ts).toISOString() : new Date(0).toISOString()
    items.push({
      id: `chat_${c.id}`,
      source: labels.length ? 'studio' : 'chat',
      title: String(c.title || 'New chat').slice(0, 300),
      detail: labels.length ? labels.join(' · ') : (lastUser ? lastUser.slice(0, 160) : 'Conversation'),
      status: 'done',
      progress: 1,
      events: [],
      meta: { kind: 'chat', artifacts: labels, count: (c.messages as AnyObj[]).length },
      created_at: iso,
      updated_at: iso,
    })
  }
  return items
}

// Turn the user's saved AutoPilot pipelines (agent flows) into activity items, so
// the phone shows every automation they've built — its schedule and last run —
// even when it's idle between runs.
const SCHED_LABEL: Record<string, string> = {
  manual: 'Manual', hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly',
  continuous: 'Continuous', members: 'Daily',
}
export function deriveFlowActivity(flowsVal: unknown): AnyObj[] {
  const flows = deepParseArray(flowsVal)
  if (!flows) return []
  const items: AnyObj[] = []
  for (const f of flows.slice(0, 200)) {
    if (!f || !f.id) continue
    const nodeCount = Array.isArray(f.nodes) ? f.nodes.filter((n: AnyObj) => n && (n.type === 'agent' || n.agent || n.role)).length : 0
    const run = (f.run && typeof f.run === 'object' ? f.run : {}) as AnyObj
    const st = String(run.status || '')
    const status = st === 'running' ? 'running'
      : st === 'awaiting' ? 'waiting'
      : st === 'error' || st === 'stuck' ? 'failed'
      : st === 'stopped' ? 'cancelled'
      : f.lastRun ? 'done' : 'queued'
    const total = Number(run.total) || nodeCount
    const step = Number(run.step) || 0
    const progress = total ? Math.max(0, Math.min(status === 'waiting' ? 0.99 : 1, step / total)) : (status === 'waiting' ? 0 : f.lastRun ? 1 : 0)
    const sched = SCHED_LABEL[String(f.schedule || 'manual')] || 'Manual'
    const approvalLabel = String(run.nodeLabel || 'Approval').slice(0, 160)
    // "Where things are at": while running, show the current agent + step; else
    // the schedule + size.
    const where = status === 'running'
      ? `${run.nodeLabel ? String(run.nodeLabel).slice(0, 40) + ' · ' : ''}step ${step}/${total || '?'}`
      : status === 'waiting' ? `Waiting for your approval: ${approvalLabel}`
      : `${sched}${f.enabled === false ? ' · paused' : ''} · ${nodeCount} agent${nodeCount === 1 ? '' : 's'}`
    const ts = Number(run.updatedAt) || Number(f.lastRun) || 0
    const iso = ts ? new Date(ts).toISOString() : new Date(0).toISOString()
    items.push({
      id: `flow_def_${f.id}`,
      source: 'pipeline',
      title: String(f.name || 'AutoPilot').slice(0, 300),
      detail: where,
      status,
      progress,
      events: run.error ? [{ t: iso, m: String(run.error).slice(0, 200) }] : [],
      // flowId + schedule + whether a resume is possible drive the mobile Run/
      // Continue/Stop buttons. resumable = a run that stalled/stopped/errored
      // partway (some steps done) can be continued.
      meta: {
        kind: 'flow',
        flowId: String(f.id),
        schedule: f.schedule || 'manual',
        enabled: f.enabled !== false,
        nodeCount,
        ...(status === 'waiting' ? { pendingApproval: { nodeId: typeof run.node === 'string' ? run.node : null, nodeLabel: approvalLabel } } : {}),
        resumable: (st === 'stopped' || st === 'error' || st === 'stuck' || st === 'running') && step > 0 && step < total,
      },
      created_at: iso,
      updated_at: iso,
    })
  }
  return items
}

async function writeGuarded(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any, userId: string, key: string, value: unknown,
): Promise<Record<string, unknown> | void> {
  if (projectKeys(key)) return writeProjectData(client, userId, key, value)
  if (key === 'nalu-chats' || key === 'nalu-deleted-chats') {
    // The handler owns this dedicated pg.Client. Chat history and tombstones
    // share a short transaction so simultaneous devices cannot lose each other.
    await writeChatData(client, userId, key, value)
    return
  }
  const toWrite = value

  // Preserve browser-run results in the task ledger before a fresh run can
  // replace flow.results. The phone can export every historical run separately.
  if(key==='nalu-agent-flows')for(const flow of deepParseArray(toWrite)||[]) {
    const startedAt=Number(flow?.run?.startedAt)
    if(!flow?.id || !Number.isFinite(startedAt) || startedAt<=0 || !flow.results || typeof flow.results!=='object')continue
    const id=`flow_${flow.id}_${startedAt}`
    const status=flow.run.status==='done'?'done':flow.run.status==='running'?'running':flow.run.status==='awaiting'?'waiting':flow.run.status==='stopped'?'cancelled':'failed'
    await client.query(`INSERT INTO nalu_tasks(id,user_id,source,title,status,meta,updated_at)
      VALUES($1,$2,'pipeline',$3,$4,$5::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET
      meta=nalu_tasks.meta || jsonb_build_object('results',COALESCE(nalu_tasks.meta->'results','{}'::jsonb)||(EXCLUDED.meta->'results')),
      status=CASE WHEN nalu_tasks.status IN ('done','failed','cancelled') THEN nalu_tasks.status ELSE EXCLUDED.status END,
      updated_at=NOW() WHERE nalu_tasks.user_id=$2`,
      [id,userId,String(flow.name||'AutoPilot').slice(0,300),status,JSON.stringify({results:flow.results,flowId:flow.id})])
  }

  await client.query(
    `INSERT INTO nalu_user_data (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [userId, key, JSON.stringify(toWrite ?? null)],
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  const schedulerDeadlineMs = Date.now() + 240000
  if (process.env.NALU_STORAGE_BACKEND === 'cloudflare') return cloudflareData(req, res)
  // Public GET — serve a shared website by id, no auth (a clickable share link).
  if (req.method === 'GET') {
    const id = String((req.query && req.query.share) || '').replace(/[^a-zA-Z0-9_-]/g, '')
    if (!id) {
      res.status(400).send('Missing share id')
      return
    }
    const c = getClient()
    try {
      await c.connect()
      await c.query(SHARE_DDL)
      const r = await c.query('SELECT html FROM nalu_shares WHERE id = $1', [id])
      if (!r.rows.length) {
        res.status(404).send('This Nalu site was not found.')
        return
      }
      sendIsolatedArtifact(res, r.rows[0].html)
    } catch {
      res.status(500).send('Error loading site.')
    } finally {
      await c.end().catch(() => {})
    }
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  const action = String(body.action || '')

  const client = getClient()
  try {
    await client.connect()
    await ensureSchema(client)

    // Server-side AutoPilot scheduler (Vercel Cron / GitHub Action) — runs DUE
    // flows even when nobody has the site open. Authed by CRON_SECRET, not a user
    // token, so it's handled before the normal auth below.
    const reqAny = req as unknown as { query?: Record<string, unknown>; url?: string; headers: Record<string, string | string[] | undefined> }
    const isCron = action === 'cron' || String(reqAny.query?.action || '') === 'cron' || String(reqAny.url || '').includes('action=cron')
    if (isCron) {
      const secret = process.env.CRON_SECRET
      // Fail CLOSED: with no secret configured, refuse — otherwise anyone could
      // POST ?action=cron and run EVERY user's due pipelines (unauth cross-user
      // write + token burn).
      if (!secret || reqAny.headers['authorization'] !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' })
      const r = await runDueCrons(client, { deadlineMs: schedulerDeadlineMs })
      return res.status(200).json({ ok: true, ...r, at: new Date().toISOString() })
    }

    const userId = await userIdForToken(client, readToken(req))
    if (!userId) return res.status(401).json({ error: 'not authenticated' })

    if(action==='notes-transcribe') {
      const quota=await reserveDailyQuota(req,'notes-audio',{anonPerDay:0,userPerDay:1200})
      if(!quota.ok)return res.status(quota.status || 429).json({error:quota.reason === 'unavailable' ? 'Transcription is temporarily unavailable. Your saved audio can be retried.' : 'Daily transcription limit reached. Your audio stays on this phone and will retry tomorrow.'})
    }
    if (await handleNotebook(client,userId,body,res)) return

    if (action === 'conversation-turn') {
      const {chatId,turnId,user,assistant,source}=body
      if (!['voice','desktop'].includes(source) || typeof chatId!=='string' || !/^(voice|desktop)-[a-f0-9-]{36}$/i.test(chatId) || typeof turnId!=='string' || !/^[a-f0-9-]{36}$/i.test(turnId) ||
          typeof user!=='string' || !user.trim() || user.length>16000 || typeof assistant!=='string' || !assistant.trim() || assistant.length>32000) return res.status(400).json({error:'Invalid conversation turn.'})
      const saved=await appendConversationTurn(client,userId,{chatId,turnId,user,assistant,source})
      return res.status(200).json({ok:true,saved})
    }

    if (action === 'notes-analyze') {
      if (typeof body.transcript !== 'string' || !body.transcript.trim() || body.transcript.length > 8000) return res.status(400).json({ error: 'Transcript must contain 1–8000 characters.' })
      const quota = await reserveDailyQuota(req, 'notes', { anonPerDay: 0, userPerDay: 200 })
      if (!quota.ok) return res.status(quota.status || 429).json({ error: quota.reason === 'unavailable' ? 'Notes generation is temporarily unavailable. Your transcript is saved.' : 'Daily notes limit reached. Your transcript is saved; try again tomorrow.' })
      try { return res.status(200).json(await extractNotes(body.transcript)) }
      catch { await quota.release(); return res.status(502).json({ error: 'Could not extract action items. Your transcript is saved; try again.' }) }
    }

    if (await handlePushAction(client, userId, body, res)) return
    if (await handleTaskAction(client, userId, body, res)) return

    // Publish a generated website and get a shareable link.
    if (action === 'share') {
      const html = String(body.html || '')
      if (!html) return res.status(400).json({ error: 'html required' })
      if (html.length > 800000) return res.status(413).json({ error: 'This website is too large to publish as a link. Download the complete HTML instead.' })
      await client.query(SHARE_DDL)
      const id = newToken().slice(0, 14)
      await client.query('INSERT INTO nalu_shares (id, html) VALUES ($1, $2)', [id, html])
      return res.status(200).json({ ok: true, id, url: `/api/data?share=${id}` })
    }

    if (action === 'load') {
      const r = await client.query('SELECT key, value FROM nalu_user_data WHERE user_id = $1', [userId])
      const data: Record<string, unknown> = {}
      for (const row of r.rows) data[row.key] = row.value
      return res.status(200).json({ data })
    }

    if (action === 'set') {
      const key = String(body.key || '')
      if (!key) return res.status(400).json({ error: 'key required' })
      const data = await writeGuarded(client, userId, key, body.value ?? null)
      return res.status(200).json({ ok: true, ...(data ? { data } : {}) })
    }

    if (action === 'setMany') {
      let entries: Record<string, unknown>
      try { entries = syncEntries(body) } catch { return res.status(400).json({ error: 'Saved data could not be decoded. The local copy has been kept.' }) }
      const keys = Object.keys(entries)
      const data: Record<string, unknown> = {}
      for (const key of keys) {
        Object.assign(data, await writeGuarded(client, userId, key, entries[key] ?? null))
      }
      return res.status(200).json({ ok: true, count: keys.length, ...(Object.keys(data).length ? { data } : {}) })
    }

    if (action === 'remove') {
      const key = String(body.key || '')
      if (projectKeys(key)) throw new ProjectDataValidationError('Delete projects by ID. Project tombstones cannot be removed.')
      if (key) await client.query('DELETE FROM nalu_user_data WHERE user_id = $1 AND key = $2', [userId, key])
      return res.status(200).json({ ok: true })
    }

    // ---- AutoPilot task ledger (per-user) -----------------------------------
    // task-log: create OR update a task. Any surface (CLI/desktop, flywheel,
    // pipeline, voice, browser) calls this with the SAME id to append progress.
    // Everything is scoped to this token's user — a task id from another user is
    // never touched (ON CONFLICT ... WHERE user_id = caller).
    if (action === 'task-log') {
      const id = String(body.id || '') || `t_${newToken().slice(0, 18)}`
      if (id.startsWith('remote_')) return res.status(409).json({ error: 'remote tasks require a worker lease; use task-update' })
      const source = String(body.source || 'cli').slice(0, 24)
      const title = String(body.title || '').slice(0, 300)
      const detail = body.detail != null ? String(body.detail).slice(0, 4000) : null
      const status = body.status != null ? String(body.status).slice(0, 24) : null
      const progress = body.progress != null ? Math.max(0, Math.min(1, Number(body.progress) || 0)) : null
      const event = body.event != null ? String(body.event).slice(0, 500) : null
      const meta = body.meta && typeof body.meta === 'object' ? JSON.stringify(body.meta) : null
      const r = await client.query(
        `INSERT INTO nalu_tasks (id, user_id, source, title, detail, status, progress, events, meta, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6,'running'), COALESCE($7::real,0),
                 CASE WHEN $8::text IS NULL THEN '[]'::jsonb
                      ELSE jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $8::text)) END,
                 COALESCE($9::jsonb,'{}'::jsonb), NOW())
         ON CONFLICT (id) DO UPDATE SET
           source     = COALESCE(EXCLUDED.source, nalu_tasks.source),
           title      = CASE WHEN $4 <> '' THEN EXCLUDED.title ELSE nalu_tasks.title END,
           detail     = COALESCE($5, nalu_tasks.detail),
           status     = COALESCE($6, nalu_tasks.status),
           progress   = COALESCE($7::real, nalu_tasks.progress),
           events     = CASE WHEN $8::text IS NULL THEN nalu_tasks.events
                             ELSE nalu_tasks.events || jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $8::text)) END,
           meta       = nalu_tasks.meta || COALESCE($9::jsonb,'{}'::jsonb),
           updated_at = NOW()
         WHERE nalu_tasks.user_id = $2
         RETURNING id, source, title, detail, status, progress, events, meta, created_at, updated_at`,
        [id, userId, source, title, detail, status, progress, event, meta],
      )
      if (!r.rows[0]) return res.status(409).json({ error: 'task id is already in use' })
      return res.status(200).json({ ok: true, task: r.rows[0] })
    }

    // activity: the FULL AutoPilot picture — the live task ledger PLUS everything
    // this user has ever made in chat (conversations + Studio docs/sheets/decks/
    // sites/videos/CAD/images), unified and newest-first. Used for the initial
    // load and pull-to-refresh; live polling uses task-feed for ledger deltas.
    if (action === 'activity') {
      const tRes = await client.query(
        `SELECT id, source, title, detail, status, progress, events, meta, created_at, updated_at
           FROM nalu_tasks WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 300`,
        [userId],
      )
      const kvRes = await client.query(
        `SELECT key, value FROM nalu_user_data WHERE user_id = $1 AND key IN ('nalu-chats','nalu-agent-flows')`,
        [userId],
      )
      let chatsVal: unknown = null
      let flowsVal: unknown = null
      for (const row of kvRes.rows) {
        if (row.key === 'nalu-chats') chatsVal = row.value
        else if (row.key === 'nalu-agent-flows') flowsVal = row.value
      }
      const chatItems = deriveChatActivity(chatsVal)
      const flowItems = deriveFlowActivity(flowsVal)
      return res.status(200).json({ tasks: decorateTaskMedia(tRes.rows,userId), chats: chatItems, pipelines: flowItems, now: new Date().toISOString() })
    }

    // task-feed: the AutoPilot history — every task for this user, newest first.
    // Pass `since` (ISO) to poll only what changed (real-time updates).
    if (action === 'task-feed') {
      const since = body.since ? String(body.since) : null
      const limit = Math.max(1, Math.min(500, Number(body.limit) || 200))
      const r = await client.query(
        `SELECT id, source, title, detail, status, progress, events, meta, created_at, updated_at
           FROM nalu_tasks
          WHERE user_id = $1 AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
          ORDER BY updated_at DESC
          LIMIT $3`,
        [userId, since, limit],
      )
      return res.status(200).json({ tasks: decorateTaskMedia(r.rows,userId), now: new Date().toISOString() })
    }

    // flow-run: START ('run'), CONTINUE ('resume'), or STOP ('stop') one of this
    // user's AutoPilot pipelines on demand from the phone. Runs server-side and
    // streams progress into the task ledger so the phone shows where it's at.
    if (action === 'flow-run') {
      const flowId = String(body.flowId || '')
      const mode = (['run', 'resume', 'stop'].includes(String(body.mode)) ? String(body.mode) : 'run') as 'run' | 'resume' | 'stop'
      if (!flowId) return res.status(400).json({ error: 'flowId required' })
      if (body.expectedStartedAt != null && (!Number.isFinite(body.expectedStartedAt) || body.expectedStartedAt <= 0)) return res.status(400).json({ error: 'expectedStartedAt must identify a saved run.' })
      const out = await runOneFlow(client, userId, flowId, mode, !!body.force, { expectedStartedAt: body.expectedStartedAt, approval: body.approval, worker: body.pipelineWorker, deadlineMs: schedulerDeadlineMs })
      return res.status(out.code || (out.ok ? 200 : 400)).json(out)
    }

    // task-clear: remove one task (id) or all of this user's finished tasks.
    if (action === 'task-clear') {
      const id = String(body.id || '')
      if (id) {
        const active = await client.query("SELECT id FROM nalu_tasks WHERE user_id=$1 AND id=$2 AND status IN ('queued','running','waiting')", [userId, id])
        if (active.rows.length) return res.status(409).json({ error: 'cancel the task before clearing it' })
        await client.query('DELETE FROM nalu_tasks WHERE user_id = $1 AND id = $2', [userId, id])
      }
      else await client.query(`DELETE FROM nalu_tasks WHERE user_id = $1 AND status IN ('done','failed','cancelled')`, [userId])
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'unknown action' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status((err instanceof ChatDataValidationError || err instanceof ProjectDataValidationError) ? 400 : 500).json({ error: message })
  } finally {
    await client.end().catch(() => {})
  }
}

export function decorateTaskMedia(rows: any[], userId: string) {
  return rows.map(task => ownsPhone(userId) && /^media_[a-f0-9]{40}$/.test(task.meta?.mediaId||'')
    ? {...task,meta:{...task.meta,artifactUrl:mediaLink(userId,task.meta.mediaId)}} : task)
}
