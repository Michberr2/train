import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'

// Start a GitHub OAuth flow. Generates a random `state`, sets it in a short-
// lived httpOnly cookie, and redirects to GitHub. The callback verifies the
// cookie matches the returned state — standard CSRF defence.

export default function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.GITHUB_CLIENT_ID
  if (!clientId) {
    res.status(500).json({ error: 'GITHUB_CLIENT_ID not set' })
    return
  }

  // Origin of the current request — works for n4lu.com, n4lu.ai, and previews.
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
  const origin = `${proto}://${host}`

  // Where to send the user after sign-in (default: back to root). The caller
  // can pass ?next=/some-path to control it. Restrict to relative paths so
  // an open-redirect can't piggy-back on this.
  const rawNext = typeof req.query.next === 'string' ? req.query.next : '/'
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/'

  const state = crypto.randomBytes(24).toString('base64url')
  const stateValue = JSON.stringify({ s: state, n: next })
  const stateB64 = Buffer.from(stateValue).toString('base64url')

  res.setHeader(
    'Set-Cookie',
    `nalu_oauth_state=${stateB64}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
  )

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/auth/github/callback`,
    scope: 'read:user user:email',
    state,
    allow_signup: 'true',
  })
  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` })
  res.end()
}
