import { waitUntil } from '@vercel/functions'
import { cors } from './_cors'
import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { readToken, safeJson } from './_db'
import { reserveDailyQuota, type QuotaResult } from './_limits'
import { SwarmStore, SwarmStoreLimitError } from './_swarmStore'
import { applySwarmAction, createdProjectId, readSwarmArtifact, SwarmError } from './_swarm'
import { runSwarmOwner } from './_swarmWorker'

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const token = readToken(req)
  if (!token) return res.status(401).json({ error: 'Sign in to use Swarm.' })
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  if (Array.isArray(body) || typeof body !== 'object' || Buffer.byteLength(JSON.stringify(body)) > (body.action === 'update-artifact' ? 650000 : 32000)) return res.status(400).json({ error: 'Invalid Swarm request.' })
  let backend: ConnectionBackend | undefined
  let quota: QuotaResult | undefined
  try {
    backend = connectionBackend(); await backend.connect()
    const owner = await backend.userId(token)
    if (!owner) return res.status(401).json({ error: 'Sign in to use Swarm.' })
    const store = new SwarmStore(backend.client), before = await store.read(owner)
    if (body.action === 'artifact') {
      const { artifact, revision } = readSwarmArtifact(before, body)
      return res.status(200).json({ artifact, revision })
    }
    let snapshot = before
    if (body.action !== 'list') {
      const preview = structuredClone(before), acceptedAt = Date.now()
      applySwarmAction(preview, owner, body, acceptedAt)
      const priorJobs = new Set(before.jobs.map(job => job.id)), newJobs = preview.jobs.filter(job => !priorJobs.has(job.id))
      if (newJobs.length) {
        quota = await reserveDailyQuota(req, 'chat', { anonPerDay: 0, userPerDay: Number(process.env.NALU_CHAT_USER_PER_DAY ?? 6000) })
        if (!quota.ok) {
          // Newer quota providers distinguish a metering outage from a used-up
          // allowance. Neither outcome may enqueue work or wake a worker.
          const unavailable = (quota as QuotaResult & { status?: number }).status === 503
          return res.status(unavailable ? 503 : 429).json({ error: unavailable
            ? 'Usage checks are temporarily unavailable. Please retry in a moment; your request has not started.'
            : 'Your daily message limit has been reached. Try again tomorrow.' })
        }
      }
      let created = false
      snapshot = await store.mutate(owner, draft => {
        const ids = new Set(draft.jobs.map(job => job.id))
        applySwarmAction(draft, owner, body, acceptedAt)
        created = newJobs.some(job => !ids.has(job.id) && draft.jobs.some(item => item.id === job.id))
      })
      if (quota && !created) await quota.release().catch(() => {})
    }
    if (snapshot.jobs.some(job => job.status === 'queued' || (job.status === 'running' && (job.leaseUntil || 0) < Date.now()))) {
      waitUntil(runSwarmOwner(owner).catch(() => { console.error('Swarm worker wake-up failed; durable work remains available to the scheduler.') }))
    }
    return res.status(200).json({ state: snapshot.state, revision: snapshot.revision, projectId: createdProjectId(owner, body) })
  } catch (error) {
    if ((error instanceof SwarmError || error instanceof SwarmStoreLimitError) && quota) await quota.release().catch(() => {})
    // Do not automatically refund/retry an uncertain persisted write. The
    // same request ID can be replayed safely to recover its acknowledgement.
    const known = error instanceof SwarmError || error instanceof SwarmStoreLimitError
    return res.status(known ? error.status : 500).json({ error: known ? error.message : 'Swarm could not confirm that request. Try again with the same request.' })
  } finally { await backend?.close().catch(() => {}) }
}
