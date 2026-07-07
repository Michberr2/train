// Nalu auth — server-side accounts in Neon Postgres, shared across n4lu.ai/.com.
// POST { action: 'signup'|'signin'|'me'|'signout', ... }
import { cors } from './_cors'
import { getClient, ensureSchema, hashPassword, newSalt, newToken, readToken, safeJson } from './_db'

const MIN_PASSWORD = 8

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
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

    if (action === 'signup') {
      const id = String(body.email || '').trim().toLowerCase()
      const password = String(body.password || '')
      const displayName = (String(body.displayName || '').trim()) || String(body.email || '').trim()
      if (!id) return res.status(400).json({ ok: false, error: 'Enter an email or username.' })
      if (password.length < MIN_PASSWORD)
        return res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` })

      const existing = await client.query('SELECT id FROM nalu_users WHERE id = $1', [id])
      if (existing.rows.length)
        return res.status(409).json({ ok: false, error: 'An account with that email/username already exists.' })

      const salt = newSalt()
      const hash = hashPassword(password, salt)
      await client.query(
        'INSERT INTO nalu_users (id, display_name, salt, hash) VALUES ($1, $2, $3, $4)',
        [id, displayName, salt, hash],
      )
      const token = newToken()
      await client.query('INSERT INTO nalu_sessions (token, user_id) VALUES ($1, $2)', [token, id])
      return res.status(200).json({ ok: true, user: { id, displayName }, token })
    }

    if (action === 'signin') {
      const id = String(body.email || '').trim().toLowerCase()
      const password = String(body.password || '')
      const invalid = { ok: false, error: 'Incorrect email/username or password.' }
      const r = await client.query('SELECT display_name, salt, hash FROM nalu_users WHERE id = $1', [id])
      const u = r.rows[0]
      if (!u) return res.status(401).json(invalid)
      if (hashPassword(password, u.salt) !== u.hash) return res.status(401).json(invalid)
      const token = newToken()
      await client.query('INSERT INTO nalu_sessions (token, user_id) VALUES ($1, $2)', [token, id])
      return res.status(200).json({ ok: true, user: { id, displayName: u.display_name }, token })
    }

    if (action === 'me') {
      const token = readToken(req)
      if (!token) return res.status(200).json({ user: null })
      const r = await client.query(
        `SELECT u.id, u.display_name FROM nalu_sessions s JOIN nalu_users u ON u.id = s.user_id WHERE s.token = $1`,
        [token],
      )
      const u = r.rows[0]
      return res.status(200).json({ user: u ? { id: u.id, displayName: u.display_name } : null })
    }

    if (action === 'signout') {
      const token = readToken(req)
      if (token) await client.query('DELETE FROM nalu_sessions WHERE token = $1', [token])
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'unknown action' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ ok: false, error: message })
  } finally {
    await client.end().catch(() => {})
  }
}
