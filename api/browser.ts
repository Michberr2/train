// Account-owned remote browser jobs. Provider acceptance is queued work, never
// proof that a requested real-world action succeeded. No implicit retries.
import { randomUUID } from 'node:crypto'
import { cors } from './_cors'
import { readToken } from './_db'
import { connectionBackend } from './_connectionBackend'
import { reserveDailyQuota, studioLimitMessage } from './_limits'
import { withRequestCancellation } from './_requestCancellation'
import { abortableWork } from './_chatTransport'
import { BrowserTaskStore, browserBinding, validBrowserBinding, type BrowserTask } from './_browserTasks'

const CLOUD = 'https://api.browser-use.com/api/v2'
const MAX_STEPS = 20
class ProviderError extends Error { constructor(readonly status: number) { super('Browser provider request failed') } }
const text = (value: unknown, max = 16000) => typeof value === 'string' ? value.slice(0, max) : ''
function httpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' } catch { return '' }
}
function screenshotUrl(value: unknown): string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : httpUrl(value)
}
async function provider(url: string, key: string, signal: AbortSignal, body?: unknown, method = body ? 'POST' : 'GET', cloud = true): Promise<any> {
  const response = await abortableWork(() => fetch(url, {
    method, redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(cloud ? { 'X-Browser-Use-API-Key': key } : { Authorization: `Bearer ${key}` }) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), signal, response => { void response.body?.cancel().catch(() => {}) })
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ProviderError(response.status) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty provider response')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await abortableWork(() => reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > 2 * 1024 * 1024) throw new Error('Provider response too large')
      chunks.push(next.value)
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider response')
    return data
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
function cloudStatus(data: any): string {
  if (data.status === 'finished') return data.isSuccess === true ? 'done' : data.isSuccess === false ? 'failed' : 'waiting'
  return ({ created: 'queued', started: 'running', failed: 'failed', stopped: 'cancelled' } as Record<string, string>)[data.status] || 'waiting'
}
function responseFor(task: BrowserTask) {
  return { name: 'Nalu Browser', task_id: task.id, status: task.status, detail: task.detail,
    live_url: httpUrl(task.meta.live_url), result: text(task.meta.result),
    screenshots: Array.isArray(task.meta.screenshots) ? task.meta.screenshots.slice(-6) : [],
    steps: Array.isArray(task.meta.steps) ? task.meta.steps.slice(-MAX_STEPS) : [], url: httpUrl(task.meta.url) }
}

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  let body: any
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} } catch { return res.status(400).json({ error: 'Invalid JSON.' }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Provide a browser request object.' })
  const action = body.action || 'run'
  if (!['run', 'status', 'cancel'].includes(action)) return res.status(400).json({ error: 'Unknown browser action.' })
  const taskText = typeof body.task === 'string' ? body.task.trim() : ''
  const startUrl = body.url ? httpUrl(body.url) : ''
  if (action === 'run' && (!taskText || taskText.length > 6000 || (body.url && !startUrl))) return res.status(400).json({ error: 'Provide a task of up to 6000 characters and an optional HTTP(S) starting URL.' })
  if (action !== 'run' && !/^browser_[a-f0-9-]{36}$/.test(body.task_id || '')) return res.status(400).json({ error: 'Provide a browser task ID.' })
  const token = readToken(req)
  if (!token) return res.status(401).json({ error: 'Sign in to run or view remote browser tasks.' })
  return withRequestCancellation(req, res, async requestSignal => {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 60000)
    const signal = AbortSignal.any([requestSignal, deadline.signal])
    let backend: ReturnType<typeof connectionBackend> | undefined
    let quota: Awaited<ReturnType<typeof reserveDailyQuota>> | undefined
    let task: BrowserTask | undefined, owner = '', submitted = false, accepted = false, refund = true
    let store: BrowserTaskStore | undefined
    const cloudKey = (process.env.BROWSER_USE_API_KEY || process.env.BROWSERUSE_API_KEY || '').trim()
    const base = (process.env.NALU_BROWSER_BASE_URL || '').replace(/\/+$/, '')
    const selfKey = (process.env.NALU_BROWSER_API_KEY || '').trim()
    try {
      backend = connectionBackend()
      await backend.connect()
      owner = await backend.userId(token) || ''
      if (!owner) return res.status(401).json({ error: 'Sign in again to access remote browser tasks.' })
      signal.throwIfAborted()
      store = new BrowserTaskStore(backend.client)
      if (action !== 'run') {
        const saved = await store.get(owner, body.task_id)
        if (!saved) return res.status(404).json({ error: 'Browser task not found.' })
        task = saved
        if (task.meta.provider === 'cloud') {
          if (!validBrowserBinding(cloudKey, owner, task)) return res.status(409).json({ error: 'This task cannot be verified with the current browser connection.' })
          const data = await provider(`${CLOUD}/tasks/${task.meta.remoteId}`, cloudKey, signal, action === 'cancel' ? { action: 'stop_task_and_session' } : undefined, action === 'cancel' ? 'PATCH' : 'GET')
          if (data.id !== task.meta.remoteId || data.sessionId !== task.meta.sessionId) throw new Error('Unexpected provider task')
          task.status = cloudStatus(data)
          task.detail = task.status === 'done' ? 'Browser agent reported completion. Review the result.' : task.status === 'waiting' ? 'The provider has not confirmed a successful outcome.' : `Browser task ${task.status}.`
          task.meta.result = text(data.output)
          task.meta.steps = Array.isArray(data.steps) ? data.steps.slice(-MAX_STEPS).map((s: any) => text(s?.nextGoal, 1000)) : []
          if (['queued', 'running'].includes(task.status)) {
            const session = await provider(`${CLOUD}/sessions/${task.meta.sessionId}`, cloudKey, signal).catch(() => null)
            if (session?.id === task.meta.sessionId) task.meta.live_url = httpUrl(session.liveUrl)
          } else task.meta.live_url = ''
          await store.save(owner, task)
        } else if (action === 'cancel' && !['done', 'failed', 'cancelled'].includes(task.status)) {
          return res.status(409).json({ ...responseFor(task), error: 'This browser connection cannot confirm cancellation. Check the remote browser before starting another task.' })
        }
        return res.status(200).json(responseFor(task))
      }
      if (!cloudKey && !(httpUrl(base) && selfKey)) return res.status(503).json({ error: 'Remote browser service is not connected.' })
      quota = await reserveDailyQuota(req, 'browser', { anonPerDay: 1, userPerDay: 10 })
      if (!quota.ok) return res.status(quota.status || 429).json({ error: studioLimitMessage('browser tasks', quota) })
      if (!quota.signedIn) return res.status(401).json({ error: 'Sign in again to start this browser task.' })
      task = { id: `browser_${randomUUID()}`, title: taskText.slice(0, 200), status: 'queued', detail: 'Preparing browser task.', meta: { provider: cloudKey ? 'cloud' : 'self', maxSteps: MAX_STEPS } }
      await store.save(owner, task)
      signal.throwIfAborted()
      submitted = true
      if (cloudKey) {
        const data = await provider(`${CLOUD}/tasks`, cloudKey, signal, { task: taskText, ...(startUrl ? { startUrl } : {}), maxSteps: MAX_STEPS, metadata: { naluTaskId: task.id } })
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(data.id || '') || !/^[a-zA-Z0-9-]{1,128}$/.test(data.sessionId || '')) throw new Error('Missing provider task identity')
        accepted = true
        task.meta.remoteId = data.id; task.meta.sessionId = data.sessionId
        task.meta.binding = browserBinding(cloudKey, owner, task.id, data.id, data.sessionId)
        task.detail = 'Browser task accepted. Poll its status to see progress and the live view.'
        await store.save(owner, task)
        refund = false
        signal.throwIfAborted()
        return res.status(202).json(responseFor(task))
      }
      const data = await provider(`${base}/run`, selfKey, signal, { task: taskText, url: startUrl, max_steps: MAX_STEPS }, 'POST', false)
      accepted = true; refund = false
      task.status = data.status === 'done' || data.success === true ? 'done' : data.status === 'failed' || data.success === false ? 'failed' : 'waiting'
      task.detail = task.status === 'done' ? 'Browser service reported completion. Review the result.' : 'Browser service returned a result without a confirmed completion status.'
      task.meta.result = text(data.result); task.meta.url = httpUrl(data.url)
      task.meta.steps = Array.isArray(data.steps) ? data.steps.slice(-MAX_STEPS).map((s: unknown) => text(s, 1000)) : []
      task.meta.screenshots = Array.isArray(data.screenshots) ? data.screenshots.slice(-6).map(screenshotUrl).filter(Boolean) : []
      await store.save(owner, task)
      signal.throwIfAborted()
      return res.status(200).json(responseFor(task))
    } catch (error) {
      const rejected = error instanceof ProviderError && error.status >= 400 && error.status < 500
      // A timed-out POST may already have launched a paid external job. Retain
      // its reservation; record uncertainty rather than suggest a duplicate.
      if (submitted && !rejected) refund = false
      if (task && action === 'run' && store) {
        task.status = submitted && !rejected ? 'waiting' : 'failed'
        task.detail = task.status === 'waiting' ? 'Submission outcome is uncertain. Check this task before starting another.' : 'The browser task could not be started.'
        // Request a bounded stop if a known job cannot be handed off durably.
        // A disconnected HTTP request alone does not stop a remote browser.
        if (accepted && cloudKey && task.meta.remoteId) {
          try {
            const stopped = await provider(`${CLOUD}/tasks/${task.meta.remoteId}`, cloudKey, AbortSignal.timeout(5000), { action: 'stop_task_and_session' }, 'PATCH')
            if (stopped.id === task.meta.remoteId && stopped.sessionId === task.meta.sessionId && stopped.status === 'stopped') {
              task.status = 'cancelled'; task.detail = 'Browser service confirmed cancellation.'
            }
          } catch { /* preserve uncertain outcome */ }
        }
        await store.save(owner, task).catch(() => {})
      }
      if (!requestSignal.aborted) return res.status(deadline.signal.aborted ? 504 : submitted || action !== 'run' ? 502 : 503).json({ error: submitted && !rejected ? 'Browser submission could not be confirmed. Check the saved task before retrying.' : 'Remote browser service is temporarily unavailable.', ...(task ? { task_id: task.id, status: task.status } : {}) })
    } finally {
      clearTimeout(timer)
      if (quota?.ok && refund) await quota.release()
      await backend?.close().catch(() => {})
    }
  })
}
