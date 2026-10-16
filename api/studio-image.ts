import { cors } from './_cors'
import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { readToken } from './_db'
import { generateImage } from './_imageGeneration'
import { claimStudioImage, completeStudioImage, failStudioImage, liveImageLease, readStudioImage, studioImageDailyLimit, studioImageRequest, studioImageResult, type StudioImageRow } from './_studioImages'

/** Private, durable Studio imagery. Reads never generate; a new provider call
 * requires the explicit generate action and an atomically claimed owner lease. */
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
  // This endpoint accepts bearer auth only: private images never use URL tokens.
  const authorization = req.headers?.authorization || req.headers?.Authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in to use saved Studio images.' })
  const token = readToken({ headers: { authorization } })
  let backend: ConnectionBackend | undefined
  const respond = (row: StudioImageRow | null) => {
    if (row?.status === 'ready') return res.status(200).json(studioImageResult(row))
    if (row && liveImageLease(row)) {
      res.setHeader('Retry-After', '3')
      return res.status(202).json({ status: 'pending', id: row.id, requestKey: row.request_key, retryAfter: 3 })
    }
    return res.status(404).json({ status: row ? 'failed' : 'missing', error: row ? 'This image did not finish. Choose Generate imagery to retry.' : 'No saved image exists for this request.' })
  }
  try {
    backend = connectionBackend(); await backend.connect()
    const client = backend.client, userId = await backend.userId(token)
    if (!userId) return res.status(401).json({ error: 'Sign in again to use saved Studio images.' })
    if (req.method === 'GET') {
      const id = req.query?.id
      if (typeof id !== 'string' || !/^studio_image_[a-f0-9]{64}$/.test(id)) return res.status(400).json({ error: 'Invalid saved image ID.' })
      return respond(await readStudioImage(client, userId, id))
    }
    let body: any
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} }
    catch { return res.status(400).json({ error: 'Invalid JSON.' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Provide an image request object.' })
    if (!['lookup', 'generate'].includes(body.action)) return res.status(400).json({ error: 'Choose lookup or generate.' })
    let request
    try { request = studioImageRequest(userId, body) }
    catch (error) { return res.status(400).json({ error: (error as Error).message }) }
    const stored = await readStudioImage(client, userId, request.id)
    if (body.action === 'lookup' || stored?.status === 'ready' || stored && liveImageLease(stored)) return respond(stored)
    const claim = await claimStudioImage(client, userId, request)
    if ('limited' in claim) return res.status(429).json({ error: `You've reached today's Studio image limit (${studioImageDailyLimit()}/day). Saved images remain available.` })
    if ('row' in claim) return respond(claim.row)
    try {
      const image = await generateImage(request.prompt, request.width, request.height, { timeoutMs: 120000, enrich: false })
      const saved = await completeStudioImage(client, userId, request.id, claim.leaseId, image)
      return respond(saved)
    } catch {
      await failStudioImage(client, userId, request.id, claim.leaseId).catch(() => {})
      return res.status(502).json({ error: 'The image could not be saved. Choose Generate imagery to retry.' })
    }
  } catch { return res.status(503).json({ error: 'Saved Studio images are temporarily unavailable. Please try again.' }) }
  finally { await backend?.close().catch(() => {}) }
}
