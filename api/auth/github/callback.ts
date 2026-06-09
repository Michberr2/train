import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'

// GitHub OAuth callback. Verifies `state` against the cookie, exchanges the
// `code` for an access token, fetches the user identity, then sets a signed
// session cookie and redirects to `next` (default: /).
//
// The session cookie is HMAC-signed with NALU_SESSION_SECRET — same pattern
// used by NextAuth / Express sessions. No DB needed because the cookie itself
// is the source of truth.

function sign(value: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(value).digest('base64url')
  return `${value}.${sig}`
}

function parseCookies(req: VercelRequest): Record<string, string> {
  const header = req.headers.cookie || ''
  const out: Record<string, string> = {}
  for (const piece of header.split(';')) {
    const [k, ...rest] = piece.trim().split('=')
    if (!k) continue
    out[k] = decodeURIComponent(rest.join('=') || '')
  }
  return out
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  const sessionSecret = process.env.NALU_SESSION_SECRET || clientSecret
  if (!clientId || !clientSecret || !sessionSecret) {
    res.status(500).send('OAuth not configured')
    return
  }

  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  if (!code || !state) {
    res.status(400).send('Missing code or state')
    return
  }

  // Verify state via cookie.
  const cookies = parseCookies(req)
  const stateB64 = cookies['nalu_oauth_state']
  if (!stateB64) {
    res.status(400).send('OAuth state cookie missing — your session may have timed out. Try again.')
    return
  }
  let parsed: { s: string; n: string }
  try {
    parsed = JSON.parse(Buffer.from(stateB64, 'base64url').toString('utf-8'))
  } catch {
    res.status(400).send('Bad state cookie')
    return
  }
  if (parsed.s !== state) {
    res.status(400).send('OAuth state mismatch')
    return
  }

  // Exchange code for token.
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https'
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${proto}://${host}/api/auth/github/callback`,
    }),
  })
  if (!tokenRes.ok) {
    res.status(502).send(`GitHub token exchange failed: ${tokenRes.status}`)
    return
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!tokenJson.access_token) {
    res.status(401).send(`GitHub OAuth: ${tokenJson.error ?? 'no token returned'}`)
    return
  }
  const accessToken = tokenJson.access_token

  // Fetch user identity.
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nalu',
    },
  })
  if (!userRes.ok) {
    res.status(502).send(`GitHub /user failed: ${userRes.status}`)
    return
  }
  const user = (await userRes.json()) as {
    id: number
    login: string
    name?: string
    email?: string
    avatar_url?: string
  }

  // Build a session payload — no access token here; we only need identity.
  // (If we ever want gh API calls server-side, we'd store the token encrypted
  // in a real store, not the cookie.)
  const session = {
    id: user.id,
    login: user.login,
    name: user.name || user.login,
    avatar: user.avatar_url || '',
    iat: Date.now(),
  }
  const sessionStr = Buffer.from(JSON.stringify(session)).toString('base64url')
  const signed = sign(sessionStr, sessionSecret)

  // Clear oauth state cookie + set the session cookie. 30-day expiry.
  res.setHeader('Set-Cookie', [
    'nalu_oauth_state=; Path=/; Max-Age=0',
    `nalu_session=${signed}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
  ])

  const next = parsed.n.startsWith('/') && !parsed.n.startsWith('//') ? parsed.n : '/'
  res.writeHead(302, { Location: next })
  res.end()
}
