import { readToken, safeJson } from './_db'
import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { cors } from './_cors'
import { deleteArtifact, listArtifacts, readArtifact } from './_autopilotArtifacts'

/** Authenticated account-owned Outputs. No public file URLs or bearer tokens
 * in query strings; fetching bytes requires the current account's session. */
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
  const token = readToken(req)
  if (!token) return res.status(401).json({ error: 'Sign in to access saved outputs.' })
  let backend: ConnectionBackend | undefined
  try {
    backend = connectionBackend()
    const client = backend.client
    await backend.connect()
    const userId = await backend.userId(token)
    if (!userId) return res.status(401).json({ error: 'Sign in again to access saved outputs.' })
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {}
      if (body.action !== 'delete' || !/^artifact_[a-f0-9]{64}$/.test(body.id || '')) return res.status(400).json({ error: 'Invalid output action.' })
      await deleteArtifact(client, userId, body.id)
      return res.status(200).json({ ok: true })
    }
    const id = req.query?.id
    if (id == null) return res.status(200).json({ outputs: await listArtifacts(client, userId) })
    if (typeof id !== 'string' || !/^artifact_[a-f0-9]{64}$/.test(id)) return res.status(400).json({ error: 'Invalid output ID.' })
    const file = await readArtifact(client, userId, id)
    if (!file) return res.status(404).json({ error: 'This output is no longer available.' })
    const mime = typeof file.meta.mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.meta.mime) ? file.meta.mime : 'text/plain'
    res.setHeader('Content-Type', mime + (mime.startsWith('text/') || mime === 'application/json' ? '; charset=utf-8' : ''))
    const fallback = file.meta.filename.replace(/[^a-z0-9._-]/gi, '_') || 'output'
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.meta.filename).replace(/'/g, '%27')}`)
    res.setHeader('Content-Length', file.bytes.length)
    return res.status(200).send(file.bytes)
  } catch {
    return res.status(503).json({ error: 'Saved outputs are temporarily unavailable. Please try again.' })
  } finally { await backend?.close().catch(() => {}) }
}
