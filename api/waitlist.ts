import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Client } from 'pg'

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const MAX_EMAIL_LENGTH = 255

function getClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL not set')
  const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString)
  return new Client({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body ?? {}
    const { email } = body

    if (typeof email !== 'string' || !EMAIL_REGEX.test(email) || email.length > MAX_EMAIL_LENGTH) {
      return res.status(400).json({ error: 'Invalid email address' })
    }

    const normalized = email.toLowerCase().trim()
    const referrer = (req.headers.referer as string | undefined) ?? null
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null

    const client = getClient()
    try {
      await client.connect()
      await client.query(`
        CREATE TABLE IF NOT EXISTS waitlist (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          referrer TEXT,
          user_agent TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      const existing = await client.query('SELECT id FROM waitlist WHERE email = $1', [normalized])
      if (existing.rowCount && existing.rowCount > 0) {
        return res.status(200).json({ exists: true, message: "You're already on the list!" })
      }
      await client.query(
        'INSERT INTO waitlist (email, referrer, user_agent) VALUES ($1, $2, $3)',
        [normalized, referrer, userAgent],
      )
      return res.status(200).json({ success: true, message: "You're on the list!" })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[waitlist POST]', message)
      return res.status(500).json({ error: 'Failed to join waitlist' })
    } finally {
      await client.end().catch(() => {})
    }
  }

  if (req.method === 'GET') {
    const client = getClient()
    try {
      await client.connect()
      const countResult = await client.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM waitlist',
      )
      const entries = await client.query(
        'SELECT id, email, created_at FROM waitlist ORDER BY created_at DESC',
      )
      return res.status(200).json({
        count: countResult.rows[0]?.count ?? 0,
        entries: entries.rows,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error('[waitlist GET]', message)
      return res.status(500).json({ error: 'Failed to fetch waitlist' })
    } finally {
      await client.end().catch(() => {})
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
}
