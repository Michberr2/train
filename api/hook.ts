// Inbound webhook / Flow-as-API endpoint. Lets any external service (Zapier,
// Make, a form, another app…) trigger an AutoPilot pipeline by calling:
//
//   POST /api/hook?flow=<flowId>&secret=<apiSecret>
//   body: anything — text, JSON, form data — becomes the trigger node's output
//
// The secret may also be sent as the `x-nalu-secret` header. The pipeline must be
// exposed (apiEnabled) with a matching secret, set from the AutoPilot UI. The
// final leaf output is returned so the caller can use the result synchronously.
import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { ensureSchema } from './_db'
import { runFlowByHook } from './_cron'
import { cors } from './_cors'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'use POST' }); return
  }
  const q = req.query || {}
  const flowId = String(q.flow || q.flowId || '').trim()
  const secret = String(q.secret || req.headers['x-nalu-secret'] || '').trim()
  if (!flowId) { res.status(400).json({ error: 'missing ?flow=<flowId>' }); return }
  if (!secret) { res.status(401).json({ error: 'missing secret (?secret= or x-nalu-secret header)' }); return }

  // The request body is the payload the trigger passes into the pipeline. Accept
  // raw text, JSON (stringified back), or the parsed object Vercel gives us.
  let payload = ''
  const b = req.body
  if (typeof b === 'string') payload = b
  else if (b && typeof b === 'object') { try { payload = JSON.stringify(b) } catch { payload = '' } }
  if (!payload && typeof q.payload === 'string') payload = q.payload

  const backend = connectionBackend(), client = backend.client
  try {
    await backend.connect()
    if (!(client instanceof CloudflareStore)) await ensureSchema(client as any)
    const r = await runFlowByHook(client, flowId, secret, payload)
    res.status(r.status || (r.ok ? 200 : 500)).json({ ok: r.ok, output: r.output, error: r.error })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'hook failed' })
  } finally {
    try { await backend.close() } catch { /* */ }
  }
}
