import { CloudflareStore } from './_cloudflareStore'
import { CloudflareQuestions } from './_cloudflareQuestions'
import { waitUntil } from '@vercel/functions'
import { deliverPushUpdates } from './_push'
import { randomBytes } from 'node:crypto'
import { normalizePhone } from './_db'
import { ownsPhone } from './_phoneOwner'
import { placeCall, publicBase, sign, phoneConfigured } from './_telephony'

type Client = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }
type Body = Record<string, any>
const ACTIONS = new Set(['task-ask', 'task-question-status', 'task-answer', 'task-questions', 'task-notification-preferences', 'task-notification-deliver'])
const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const failure = (res: any, code: number, error: string) => res.status(code).json({ error })

export async function ensureQuestionSchema(client: Client) {
  await client.query(`CREATE TABLE IF NOT EXISTS nalu_task_questions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES nalu_task_jobs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    text TEXT NOT NULL, answer TEXT, status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), answered_at TIMESTAMPTZ,
    notification_status TEXT NOT NULL DEFAULT 'pending', call_sid TEXT, notification_error TEXT, phone_draft TEXT,
    UNIQUE(task_id,id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS nalu_one_pending_question ON nalu_task_questions(task_id) WHERE status='pending';
  ALTER TABLE nalu_task_questions ADD COLUMN IF NOT EXISTS phone_draft TEXT;`)
}

export async function answerTaskQuestion(client: Client | CloudflareStore, userId: string, taskId: string, questionId: string, answer: string) {
  if (client instanceof CloudflareStore) return new CloudflareQuestions(client).answer(userId,taskId,questionId,answer)
  if (!validId(taskId) || !validId(questionId) || typeof answer !== 'string' || !answer.trim() || answer.length > 16000) {
    return { code: 400, data: { error: 'Task, question, and a non-empty answer of at most 16000 characters are required.' } }
  }
  await client.query('BEGIN')
  try {
    // Lock job before question everywhere, including creation and cancellation.
    const job = (await client.query('SELECT status,lease_expires_at FROM nalu_task_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [taskId, userId])).rows[0]
    const question = (await client.query('SELECT * FROM nalu_task_questions WHERE id=$1 AND task_id=$2 AND user_id=$3 FOR UPDATE', [questionId, taskId, userId])).rows[0]
    if (!job || !question) { await client.query('ROLLBACK'); return { code: 404, data: { error: 'Question not found.' } } }
    if (question.status === 'answered' && question.answer === answer.trim()) {
      await client.query('COMMIT'); return { code: 200, data: { ok: true, questionId, status: 'answered' } }
    }
    if (job.status !== 'running' || new Date(job.lease_expires_at).getTime() <= Date.now() || question.status !== 'pending') {
      await client.query('ROLLBACK'); return { code: 409, data: { error: 'This question is no longer awaiting an answer from an active worker.' } }
    }
    await client.query("UPDATE nalu_task_questions SET answer=$2,status='answered',answered_at=NOW() WHERE id=$1", [questionId, answer.trim()])
    await client.query(`UPDATE nalu_tasks SET status='running',detail='Answer received; continuing work',
      meta=meta-'pendingQuestion',events=events || jsonb_build_array(jsonb_build_object('t',NOW(),'m','Answer received; continuing the same task')),updated_at=NOW()
      WHERE id=$1 AND user_id=$2`, [taskId, userId])
    await client.query('COMMIT')
    return { code: 200, data: { ok: true, questionId, status: 'answered' } }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

export async function handleQuestionAction(client: Client | CloudflareStore, userId: string, body: Body, res: any): Promise<boolean> {
  if (client instanceof CloudflareStore) return new CloudflareQuestions(client).handle(userId,body,res)
  if (!ACTIONS.has(body.action)) return false
  await ensureQuestionSchema(client)
  if (body.action === 'task-notification-preferences') {
    const previous = (await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-task-notifications'",[userId])).rows[0]?.value || {}
    const patch: Record<string, unknown> = {}
    for (const key of ['phoneQuestions','phoneUpdates','messageUpdates']) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') { failure(res,400,key+' must be a boolean.'); return true }
      patch[key] = body[key]
      if (key !== 'phoneQuestions' && body[key] && previous[key] !== true) patch[key+'Since'] = new Date().toISOString()
    }
    if (Object.keys(patch).length) {
      await client.query(`INSERT INTO nalu_user_data(user_id,key,value,updated_at) VALUES($1,'nalu-task-notifications',$2::jsonb,NOW())
        ON CONFLICT(user_id,key) DO UPDATE SET value=COALESCE(nalu_user_data.value,'{}'::jsonb)||EXCLUDED.value,updated_at=NOW()`,[userId,JSON.stringify(patch)])
    }
    const value = (await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-task-notifications'", [userId])).rows[0]?.value
    res.status(200).json({ ok: true, phoneQuestions: value?.phoneQuestions === true, phoneUpdates: value?.phoneUpdates === true, messageUpdates: value?.messageUpdates === true }); return true
  }
  if (body.action === 'task-questions') {
    const rows = await client.query(`SELECT q.id,q.task_id AS "taskId",q.text,q.status,t.title,t.meta->>'repo' AS repo
      FROM nalu_task_questions q JOIN nalu_task_jobs j ON j.id=q.task_id JOIN nalu_tasks t ON t.id=q.task_id
      WHERE q.user_id=$1 AND q.status='pending' AND j.status='running' AND j.lease_expires_at>NOW() ORDER BY q.created_at`, [userId])
    res.status(200).json({ ok: true, questions: rows.rows }); return true
  }
  if (body.action === 'task-answer') {
    const result = await answerTaskQuestion(client, userId, body.id, body.questionId, body.answer)
    res.status(result.code).json(result.data); return true
  }
  if (body.action === 'task-notification-deliver') {
    await deliverQuestionNotification(client, userId, res); return true
  }
  if (!validId(body.id) || !validId(body.workerId) || !validId(body.questionId) || !/^[a-f0-9]{64}$/.test(body.leaseToken || '')) {
    failure(res, 400, 'Task, worker, question ID, and lease token are required.'); return true
  }
  if (body.action === 'task-question-status') {
    const result = await client.query(`SELECT q.id,q.text,q.status,q.answer,j.status AS job_status,j.lease_expires_at
      FROM nalu_task_jobs j JOIN nalu_task_questions q ON q.task_id=j.id
      WHERE j.id=$1 AND j.user_id=$2 AND j.worker_id=$3 AND j.lease_token=$4 AND q.id=$5`, [body.id, userId, body.workerId, body.leaseToken, body.questionId])
    const question = result.rows[0]
    if (!question || (question.job_status !== 'cancelled' && (question.job_status !== 'running' || new Date(question.lease_expires_at).getTime() <= Date.now()))) {
      failure(res, 409, 'The task lease is no longer active.'); return true
    }
    res.status(200).json({ ok: true, question: { id: question.id, text: question.text, status: question.status, answer: question.answer }, cancelRequested: question.job_status === 'cancelled' }); return true
  }
  if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) { failure(res, 400, 'Question must contain 1–2000 characters.'); return true }
  await client.query('BEGIN')
  try {
    const job = (await client.query(`SELECT id FROM nalu_task_jobs WHERE id=$1 AND user_id=$2 AND worker_id=$3 AND lease_token=$4
      AND status='running' AND lease_expires_at>NOW() FOR UPDATE`, [body.id, userId, body.workerId, body.leaseToken])).rows[0]
    if (!job) { await client.query('ROLLBACK'); failure(res, 409, 'The task lease is no longer active.'); return true }
    const existing = (await client.query('SELECT * FROM nalu_task_questions WHERE task_id=$1 AND (id=$2 OR status=\'pending\') FOR UPDATE', [body.id, body.questionId])).rows
    if (existing.length) {
      const same = existing.find((q: any) => q.id === body.questionId && q.text === body.question.trim())
      await client.query('COMMIT')
      if (!same) failure(res, 409, 'Resolve the existing question before asking another.')
      else res.status(200).json({ ok: true, question: { id: same.id, text: same.text, status: same.status, answer: same.answer } })
      return true
    }
    await client.query('INSERT INTO nalu_task_questions(id,task_id,user_id,text) VALUES($1,$2,$3,$4)', [body.questionId, body.id, userId, body.question.trim()])
    await client.query(`UPDATE nalu_tasks SET status='waiting',detail='Waiting for your answer',
      meta=meta || jsonb_build_object('pendingQuestion',jsonb_build_object('id',$3::text,'text',$4::text)),
      events=events || jsonb_build_array(jsonb_build_object('t',NOW(),'m',$4::text)),updated_at=NOW() WHERE id=$1 AND user_id=$2`, [body.id, userId, body.questionId, body.question.trim()])
    await client.query('COMMIT')
    waitUntil(deliverPushUpdates(userId))
    res.status(200).json({ ok: true, question: { id: body.questionId, text: body.question.trim(), status: 'pending', answer: null } })
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  return true
}

async function deliverQuestionNotification(client: Client, userId: string, res: any) {
  if (!ownsPhone(userId)) { res.status(200).json({ ok: true, delivered: false, reason: 'This account does not own the private phone line.' }); return }
  const value = (await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-task-notifications'", [userId])).rows[0]?.value
  if (value?.phoneQuestions !== true) { res.status(200).json({ ok: true, delivered: false, reason: 'Phone questions are disabled.' }); return }
  if (!phoneConfigured()) { res.status(200).json({ ok: true, delivered: false, reason: 'Phone service is not configured.' }); return }
  const to = normalizePhone((await client.query('SELECT phone FROM nalu_users WHERE id=$1', [userId])).rows[0]?.phone || '')
  if (!to) { res.status(200).json({ ok: true, delivered: false, reason: 'Save a profile phone number first.' }); return }
  // Claim once, before the carrier request. Ambiguous delivery is surfaced, never
  // retried automatically: a timeout must not ring the user repeatedly.
  const question = (await client.query(`WITH candidate AS (
    SELECT q.id FROM nalu_task_questions q JOIN nalu_task_jobs j ON j.id=q.task_id
    WHERE q.user_id=$1 AND q.status='pending' AND q.notification_status='pending'
      AND j.status='running' AND j.lease_expires_at>NOW() ORDER BY q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1
  ) UPDATE nalu_task_questions q SET notification_status='sending' FROM candidate c WHERE q.id=c.id RETURNING q.*`, [userId])).rows[0]
  if (!question) { res.status(200).json({ ok: true, delivered: false }); return }
  const expires = String(Date.now() + 30 * 60_000)
  const nonce = randomBytes(12).toString('hex')
  const sig = sign(['task-question', userId, question.id, to, expires, nonce].join('|'))
  const params = new URLSearchParams({ step: 'task-question', uid: userId, questionId: question.id, to, expires, nonce, sig })
  const result = await placeCall(to, `${publicBase()}/api/phone?${params}`)
  await client.query('UPDATE nalu_task_questions SET notification_status=$2,call_sid=$3,notification_error=$4 WHERE id=$1',
    [question.id, result.ok ? 'sent' : 'uncertain', result.sid || null, result.error || null])
  await client.query(`UPDATE nalu_tasks SET meta=meta || jsonb_build_object('phoneNotification',$3::text),
    events=events || jsonb_build_array(jsonb_build_object('t',NOW(),'m',$4::text)),updated_at=NOW() WHERE id=$1 AND user_id=$2`,
    [question.task_id, userId, result.ok ? 'sent' : 'uncertain', result.ok ? 'Nalu called your saved number with a task question.' : 'Phone delivery could not be confirmed; answer the question in Voice.'])
  res.status(200).json({ ok: true, delivered: result.ok, ...(result.error ? { errorDetail: result.error } : {}) })
}
