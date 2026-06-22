// Nalu per-user data store (Neon Postgres). Mirrors the Dashboard's `nalu-*`
// localStorage keys so conversations, projects, plugins, automations, GitHub
// PAT, settings, etc. persist server-side and sync across n4lu.ai/.com + devices.
// POST { action: 'load'|'set'|'setMany'|'remove', token, ... }
import { getClient, ensureSchema, userIdForToken, readToken, safeJson, newToken } from './_db'

const SHARE_DDL =
  'CREATE TABLE IF NOT EXISTS nalu_shares (id TEXT PRIMARY KEY, html TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
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
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'public, max-age=600')
      res.status(200).send(r.rows[0].html)
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
    const userId = await userIdForToken(client, readToken(req))
    if (!userId) return res.status(401).json({ error: 'not authenticated' })

    // Publish a generated website and get a shareable link.
    if (action === 'share') {
      const html = String(body.html || '')
      if (!html) return res.status(400).json({ error: 'html required' })
      await client.query(SHARE_DDL)
      const id = newToken().slice(0, 14)
      await client.query('INSERT INTO nalu_shares (id, html) VALUES ($1, $2)', [id, html.slice(0, 800000)])
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
      await client.query(
        `INSERT INTO nalu_user_data (user_id, key, value, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [userId, key, JSON.stringify(body.value ?? null)],
      )
      return res.status(200).json({ ok: true })
    }

    if (action === 'setMany') {
      const entries = (body.entries && typeof body.entries === 'object' ? body.entries : {}) as Record<string, unknown>
      const keys = Object.keys(entries)
      for (const key of keys) {
        await client.query(
          `INSERT INTO nalu_user_data (user_id, key, value, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [userId, key, JSON.stringify(entries[key] ?? null)],
        )
      }
      return res.status(200).json({ ok: true, count: keys.length })
    }

    if (action === 'remove') {
      const key = String(body.key || '')
      if (key) await client.query('DELETE FROM nalu_user_data WHERE user_id = $1 AND key = $2', [userId, key])
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'unknown action' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ error: message })
  } finally {
    await client.end().catch(() => {})
  }
}
