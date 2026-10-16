// Nalu auth — server-side accounts in Neon Postgres, shared across n4lu.ai/.com.
// POST { action: 'signup'|'signin'|'me'|'signout', ... }
import { cors } from './_cors'
import { getClient, ensureSchema, hashPassword, newSalt, newToken, readToken, safeJson, sha256, newRecoveryCode, normalizeRecoveryCode, userIdForToken, normalizePhone } from './_db'
import { sendEmail, resetEmail } from './_email'
import { cloudflareAuth } from './_cloudflareAuth'

const MIN_PASSWORD = 8

// Reset links may only point at our own domains — never an attacker-supplied host.
function allowedOrigin(o: string): string {
  const allow = ['https://n4lu.ai', 'https://n4lu.com', 'https://www.n4lu.ai', 'https://www.n4lu.com']
  try {
    const u = new URL(o)
    const base = `${u.protocol}//${u.host}`
    if (allow.includes(base)) return base
  } catch { /* fall through */ }
  return 'https://n4lu.ai'
}
const isEmailAddr = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {}
  const action = String(body.action || '')
  if (process.env.NALU_STORAGE_BACKEND === 'cloudflare') return cloudflareAuth(req, res, body)

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
      const recoveryCode = newRecoveryCode()
      await client.query(
        'INSERT INTO nalu_users (id, display_name, salt, hash, recovery_hash) VALUES ($1, $2, $3, $4, $5)',
        [id, displayName, salt, hash, sha256(normalizeRecoveryCode(recoveryCode))],
      )
      const token = newToken()
      await client.query('INSERT INTO nalu_sessions (token, user_id) VALUES ($1, $2)', [token, id])
      // recoveryCode is shown ONCE so they can reset their password without email.
      return res.status(200).json({ ok: true, user: { id, displayName, phone: null }, token, recoveryCode })
    }

    if (action === 'signin') {
      const id = String(body.email || '').trim().toLowerCase()
      const password = String(body.password || '')
      const invalid = { ok: false, error: 'Incorrect email/username or password.' }
      const r = await client.query('SELECT display_name, salt, hash, recovery_hash, phone FROM nalu_users WHERE id = $1', [id])
      const u = r.rows[0]
      if (!u) return res.status(401).json(invalid)
      if (hashPassword(password, u.salt) !== u.hash) return res.status(401).json(invalid)
      const token = newToken()
      await client.query('INSERT INTO nalu_sessions (token, user_id) VALUES ($1, $2)', [token, id])
      // Backfill: users created before recovery codes existed get one on sign-in,
      // returned ONCE so they can save it. New users already have theirs.
      let recoveryCode: string | undefined
      if (!u.recovery_hash) {
        recoveryCode = newRecoveryCode()
        await client.query('UPDATE nalu_users SET recovery_hash = $1 WHERE id = $2', [sha256(normalizeRecoveryCode(recoveryCode)), id])
      }
      return res.status(200).json({ ok: true, user: { id, displayName: u.display_name, phone: u.phone ?? null }, token, ...(recoveryCode ? { recoveryCode } : {}) })
    }

    if (action === 'me') {
      const token = readToken(req)
      if (!token) return res.status(200).json({ user: null })
      const r = await client.query(
        `SELECT u.id, u.display_name, u.phone FROM nalu_sessions s JOIN nalu_users u ON u.id = s.user_id WHERE s.token = $1`,
        [token],
      )
      const u = r.rows[0]
      return res.status(200).json({ user: u ? { id: u.id, displayName: u.display_name, phone: u.phone ?? null } : null })
    }

    // Update the signed-in user's profile (display name and/or phone number).
    // Authed by Bearer token. Phone is normalized to E.164; send '' to clear it.
    if (action === 'update-profile') {
      const userId = await userIdForToken(client, readToken(req))
      if (!userId) return res.status(401).json({ ok: false, error: 'not authenticated' })
      const sets: string[] = []
      const vals: unknown[] = []
      if (typeof body.displayName === 'string' && body.displayName.trim()) {
        vals.push(body.displayName.trim().slice(0, 80)); sets.push(`display_name = $${vals.length}`)
      }
      if (body.phone !== undefined) {
        const raw = String(body.phone || '').trim()
        const phone = raw ? normalizePhone(raw) : ''
        if (raw && !phone) return res.status(400).json({ ok: false, error: 'That doesn’t look like a valid phone number. Include the country code, e.g. +1 415 555 1234.' })
        vals.push(phone || null); sets.push(`phone = $${vals.length}`)
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: 'nothing to update' })
      vals.push(userId)
      await client.query(`UPDATE nalu_users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals)
      const r = await client.query('SELECT id, display_name, phone FROM nalu_users WHERE id = $1', [userId])
      const u = r.rows[0]
      return res.status(200).json({ ok: true, user: { id: u.id, displayName: u.display_name, phone: u.phone ?? null } })
    }

    if (action === 'signout') {
      const token = readToken(req)
      if (token) await client.query('DELETE FROM nalu_sessions WHERE token = $1', [token])
      return res.status(200).json({ ok: true })
    }

    // Step 1 of reset: email a one-time link. ALWAYS returns { ok: true } so it
    // never reveals whether an account exists (no user enumeration).
    if (action === 'request-reset') {
      const id = String(body.email || '').trim().toLowerCase()
      const done = { ok: true, emailConfigured: !!process.env.RESEND_API_KEY }
      if (!id) return res.status(200).json(done)
      const r = await client.query('SELECT id, display_name FROM nalu_users WHERE id = $1', [id])
      const u = r.rows[0]
      if (u) {
        const raw = newToken()
        await client.query(
          `INSERT INTO nalu_password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
          [sha256(raw), id],
        )
        const link = `${allowedOrigin(String(body.origin || ''))}/reset?token=${raw}`
        if (isEmailAddr(id)) {
          const { subject, html, text } = resetEmail(String(u.display_name || id), link)
          const sent = await sendEmail({ to: id, subject, html, text })
          // Until email delivery is set up, drop the link in the server logs so the
          // owner can still complete a reset. NEVER returned to the client.
          if (!sent.ok) {
            const reason = 'reason' in sent ? sent.reason : 'unknown'
            console.log(`[reset] email not sent (${reason}); link for ${id}: ${link}`)
          }
        } else {
          console.log(`[reset] account "${id}" is a username (no email) — link: ${link}`)
        }
      }
      return res.status(200).json(done)
    }

    // Step 2 of reset: consume the token, set the new password, and sign the user
    // in (a fresh session) while revoking every old session.
    if (action === 'reset-password') {
      const token = String(body.token || '')
      const password = String(body.password || '')
      if (!token) return res.status(400).json({ ok: false, error: 'This reset link is invalid.' })
      if (password.length < MIN_PASSWORD)
        return res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` })
      const r = await client.query(
        `SELECT user_id FROM nalu_password_resets WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()`,
        [sha256(token)],
      )
      const userId = r.rows[0]?.user_id as string | undefined
      if (!userId)
        return res.status(400).json({ ok: false, error: 'This reset link is invalid or has expired. Request a new one.' })
      const salt = newSalt()
      await client.query('UPDATE nalu_users SET salt = $1, hash = $2 WHERE id = $3', [salt, hashPassword(password, salt), userId])
      await client.query('UPDATE nalu_password_resets SET used = TRUE WHERE user_id = $1', [userId]) // burn all outstanding links
      await client.query('DELETE FROM nalu_sessions WHERE user_id = $1', [userId]) // sign out everywhere
      const newTok = newToken()
      await client.query('INSERT INTO nalu_sessions (token, user_id) VALUES ($1, $2)', [newTok, userId])
      const uq = await client.query('SELECT display_name FROM nalu_users WHERE id = $1', [userId])
      return res.status(200).json({ ok: true, user: { id: userId, displayName: uq.rows[0]?.display_name || userId }, token: newTok })
    }

    // Email-FREE reset: prove ownership with the recovery code shown at signup.
    // Works for anyone, no email provider needed. Issues a fresh code on success.
    if (action === 'reset-with-code') {
      const id = String(body.email || '').trim().toLowerCase()
      const code = normalizeRecoveryCode(String(body.code || ''))
      const password = String(body.password || '')
      const bad = { ok: false, error: 'Incorrect email/username or recovery code.' }
      if (!id || !code) return res.status(400).json(bad)
      if (password.length < MIN_PASSWORD)
        return res.status(400).json({ ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` })
      const r = await client.query('SELECT recovery_hash FROM nalu_users WHERE id = $1', [id])
      const stored = r.rows[0]?.recovery_hash as string | undefined
      if (!stored || sha256(code) !== stored) return res.status(401).json(bad)
      const salt = newSalt()
      const nextCode = newRecoveryCode() // one-time code is consumed — issue a new one
      await client.query(
        'UPDATE nalu_users SET salt = $1, hash = $2, recovery_hash = $3 WHERE id = $4',
        [salt, hashPassword(password, salt), sha256(normalizeRecoveryCode(nextCode)), id],
      )
      await client.query('UPDATE nalu_password_resets SET used = TRUE WHERE user_id = $1', [id])
      await client.query('DELETE FROM nalu_sessions WHERE user_id = $1', [id]) // sign out everywhere
      const newTok = newToken()
      await client.query('INSERT INTO nalu_sessions (token, user_id) VALUES ($1, $2)', [newTok, id])
      const uq = await client.query('SELECT display_name FROM nalu_users WHERE id = $1', [id])
      return res.status(200).json({ ok: true, user: { id, displayName: uq.rows[0]?.display_name || id }, token: newTok, recoveryCode: nextCode })
    }

    return res.status(400).json({ error: 'unknown action' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return res.status(500).json({ ok: false, error: message })
  } finally {
    await client.end().catch(() => {})
  }
}
