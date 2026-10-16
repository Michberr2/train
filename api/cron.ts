import { CloudflareStore } from './_cloudflareStore'
import { connectionBackend } from './_connectionBackend'
import { deliverPushUpdates } from './_push'
// Server-side AutoPilot scheduler endpoint. Triggered by Vercel Cron (hourly) and
// a GitHub Action (every 15 min). Runs every user's DUE flows from the DB so
// scheduled work happens EVEN WHEN NOBODY HAS THE SITE OPEN.
import { ensureSchema } from './_db'
import { deliverTaskCompletions } from './_taskCompletion'
import { processMessages } from './_messageWorker'
import { phoneOwnerId } from './_phoneOwner'
import { runDueCrons } from './_cron'
import { processConnectionPosts } from './_connectionPublishing'

export default async function handler(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (n: number) => { json: (v: unknown) => void } },
) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const backend=connectionBackend(),client=backend.client
  try {
    await backend.connect()
    if (!(client instanceof CloudflareStore)) await ensureSchema(client as any)
    await processConnectionPosts(client)
    await Promise.all([processMessages(phoneOwnerId()),deliverTaskCompletions(phoneOwnerId())])
    await deliverPushUpdates()
    const r = await runDueCrons(client)
    if (client instanceof CloudflareStore) await client.collectDocumentParts()
    res.status(200).json({ ok: true, ...r, at: new Date().toISOString() })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'cron failed' })
  } finally {
    try { await backend.close() } catch { /* */ }
  }
}
