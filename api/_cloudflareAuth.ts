import { CloudflareStore } from './_cloudflareStore'
import { CloudflareAccounts } from './_cloudflareAccounts'
import { normalizePhone, normalizeRecoveryCode, readToken } from './_db'
import { sendEmail, resetEmail } from './_email'

/** Same public account contract, with D1's atomic account/session operations. */
export async function cloudflareAuth(req: any, res: any, body: any) {
  try {
    const accounts = new CloudflareAccounts(new CloudflareStore()), action = String(body.action || '')
    const id = String(body.email || '').trim().toLowerCase(), password = String(body.password || '')
    const passwordError = () => res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' })
    if (action === 'signup') {
      if (!id || id.length > 320) return res.status(400).json({ ok: false, error: 'Enter an email or username.' })
      if (password.length < 8) return passwordError()
      const result = await accounts.signup(id, String(body.displayName || '').trim() || String(body.email || '').trim(), password)
      return result ? res.status(200).json({ ok: true, ...result }) : res.status(409).json({ ok: false, error: 'An account with that email/username already exists.' })
    }
    if (action === 'signin') {
      const result = await accounts.signin(id, password)
      return result ? res.status(200).json({ ok: true, ...result }) : res.status(401).json({ ok: false, error: 'Incorrect email/username or password.' })
    }
    if (action === 'me') return res.status(200).json({ user: await accounts.current(readToken(req)) })
    if (action === 'signout') { await accounts.signout(readToken(req)); return res.status(200).json({ ok: true }) }
    if (action === 'update-profile') {
      const token = readToken(req)
      if (!token || !await accounts.current(token)) return res.status(401).json({ ok: false, error: 'not authenticated' })
      const values: { displayName?: string; phone?: string | null } = {}
      if (typeof body.displayName === 'string' && body.displayName.trim()) values.displayName = body.displayName.trim().slice(0, 80)
      if (body.phone !== undefined) {
        const raw = String(body.phone || '').trim(), phone = raw ? normalizePhone(raw) : ''
        if (raw && !phone) return res.status(400).json({ ok: false, error: 'That doesn’t look like a valid phone number. Include the country code, e.g. +1 415 555 1234.' })
        values.phone = phone || null
      }
      if (!Object.keys(values).length) return res.status(400).json({ ok: false, error: 'nothing to update' })
      const user = await accounts.updateProfile(token, values)
      return user ? res.status(200).json({ ok: true, user }) : res.status(401).json({ ok: false, error: 'not authenticated' })
    }
    if (action === 'request-reset') {
      const done = { ok: true, emailConfigured: !!process.env.RESEND_API_KEY }
      if (!id) return res.status(200).json(done)
      const reset = await accounts.createPasswordReset(id)
      if (reset && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) {
        let origin = 'https://n4lu.ai'
        try { const requested = new URL(String(body.origin || '')).origin; if (['https://n4lu.ai', 'https://n4lu.com', 'https://www.n4lu.ai', 'https://www.n4lu.com'].includes(requested)) origin = requested } catch { /* canonical origin */ }
        const email = resetEmail(reset.user.displayName || id, `${origin}/reset?token=${reset.resetToken}`)
        // Recovery secrets stay out of both responses and server logs.
        await sendEmail({ to: id, ...email })
      }
      return res.status(200).json(done)
    }
    if (action === 'reset-password') {
      const token = String(body.token || '')
      if (!token) return res.status(400).json({ ok: false, error: 'This reset link is invalid.' })
      if (password.length < 8) return passwordError()
      const result = await accounts.resetPassword(token, password)
      return result ? res.status(200).json({ ok: true, ...result }) : res.status(400).json({ ok: false, error: 'This reset link is invalid or has expired. Request a new one.' })
    }
    if (action === 'reset-with-code') {
      const code = normalizeRecoveryCode(String(body.code || '')), bad = { ok: false, error: 'Incorrect email/username or recovery code.' }
      if (!id || !code) return res.status(400).json(bad)
      if (password.length < 8) return passwordError()
      const result = await accounts.resetWithCode(id, code, password)
      return result ? res.status(200).json({ ok: true, ...result }) : res.status(401).json(bad)
    }
    return res.status(400).json({ error: 'unknown action' })
  } catch { return res.status(503).json({ ok: false, error: 'Account storage is temporarily unavailable. Please try again.' }) }
}
