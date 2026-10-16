import { cors } from './_cors'
import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { ensureSchema, readToken, safeJson } from './_db'
import { listTeam, createTeamRole, TeamError } from './_team'
import { accountPhoneNumber } from './_phoneOwner'

export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const token = readToken(req)
  if (!token) return res.status(401).json({ error: 'Sign in to manage your team.' })
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  let backend: ConnectionBackend | undefined
  try {
    backend = connectionBackend(); await backend.connect()
    const c=backend.client
    if (!(c instanceof CloudflareStore)) await ensureSchema(c as any)
    const uid = await backend.userId(token)
    if (!uid) return res.status(401).json({ error: 'Sign in to manage your team.' })
    if (body.action === 'list') return res.status(200).json({ number: accountPhoneNumber(uid), members: await listTeam(c, uid) })
    if (body.action === 'create') return res.status(200).json({ member: await createTeamRole(c, uid, body) })
    return res.status(400).json({ error: 'Unknown team action.' })
  } catch (error) {
    return res.status(error instanceof TeamError ? error.status : 500).json({ error: error instanceof TeamError ? error.message : 'Your team is unavailable. Please try again.' })
  } finally { await backend?.close().catch(() => {}) }
}
