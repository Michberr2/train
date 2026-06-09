import type { VercelRequest, VercelResponse } from '@vercel/node'

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Set-Cookie', 'nalu_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
  // GET → redirect to root, POST → JSON ack (so a fetch() can read it).
  if (req.method === 'POST') {
    res.status(200).json({ ok: true })
    return
  }
  res.writeHead(302, { Location: '/' })
  res.end()
}
