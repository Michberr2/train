import { Router, Request, Response } from 'express'
import { pool } from '../db.js'

const router = Router()

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const MAX_EMAIL_LENGTH = 255

router.post('/', async (req: Request, res: Response) => {
  const { email } = req.body ?? {}

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email) || email.length > MAX_EMAIL_LENGTH) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  const normalized = email.toLowerCase().trim()
  const referrer = (req.headers.referer as string | undefined) ?? null
  const userAgent = (req.headers['user-agent'] as string | undefined) ?? null

  try {
    const existing = await pool.query('SELECT id FROM waitlist WHERE email = $1', [normalized])
    if (existing.rowCount && existing.rowCount > 0) {
      return res.json({ exists: true, message: "You're already on the list!" })
    }

    await pool.query(
      'INSERT INTO waitlist (email, referrer, user_agent) VALUES ($1, $2, $3)',
      [normalized, referrer, userAgent]
    )

    res.json({ success: true, message: "You're on the list!" })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[waitlist POST]', message)
    res.status(500).json({ error: 'Failed to join waitlist' })
  }
})

router.get('/', async (_req: Request, res: Response) => {
  try {
    const countResult = await pool.query<{ count: string }>('SELECT COUNT(*)::int AS count FROM waitlist')
    const entries = await pool.query(
      'SELECT id, email, created_at FROM waitlist ORDER BY created_at DESC'
    )
    res.json({
      count: countResult.rows[0]?.count ?? 0,
      entries: entries.rows,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[waitlist GET]', message)
    res.status(500).json({ error: 'Failed to fetch waitlist' })
  }
})

export default router
