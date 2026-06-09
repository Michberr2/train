import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'node:crypto'

// Return the current user from the signed session cookie, or 401.
// Used by App.tsx on load to decide whether to render the Dashboard.

function verify(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf('.')
  if (idx < 0) return null
  const value = signed.slice(0, idx)
  const sig = signed.slice(idx + 1)
  const expected = crypto.createHmac('sha256', secret).update(value).digest('base64url')
  try {
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null
    }
  } catch {
    return null
  }
  return value
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

export default function handler(req: VercelRequest, res: VercelResponse) {
  const sessionSecret = process.env.NALU_SESSION_SECRET || process.env.GITHUB_CLIENT_SECRET
  if (!sessionSecret) {
    res.status(500).json({ error: 'session not configured' })
    return
  }
  const cookies = parseCookies(req)
  const signed = cookies['nalu_session']
  if (!signed) {
    res.status(401).json({ user: null })
    return
  }
  const value = verify(signed, sessionSecret)
  if (!value) {
    res.status(401).json({ user: null })
    return
  }
  try {
    const session = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'))
    res.status(200).json({ user: session })
  } catch {
    res.status(401).json({ user: null })
  }
}
