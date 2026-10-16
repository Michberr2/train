import { connectionBackend } from './_connectionBackend'
import { serveConnectionMedia } from './_connectionMedia'
export default async function handler(req: any, res: any) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.status(405).end(); return }
  const backend = connectionBackend()
  try { await backend.connect(); await serveConnectionMedia(backend.client, req, res) }
  catch { if (res.headersSent) res.destroy(); else res.status(503).end() }
  finally { await backend.close().catch(() => {}) }
}
