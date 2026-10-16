import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { ownsPhone } from './_phoneOwner'
import { mediaLinkValid } from './_messageMedia'

export default async function handler(req: any,res: any) {
  res.setHeader('Cache-Control','private, max-age=300')
  res.setHeader('X-Content-Type-Options','nosniff')
  if (!['GET','HEAD'].includes(req.method)) return res.status(405).end()
  const q=req.query||{}
  if (!ownsPhone(String(q.uid||'')) || !mediaLinkValid(q)) return res.status(403).end()
  const backend=connectionBackend(), c=backend.client
  try {
    await backend.connect()
    const row=c instanceof CloudflareStore ? await new CloudflareMessages(c).media(String(q.uid),String(q.id)) : (await c.query('SELECT mime,bytes FROM nalu_message_media WHERE id=$1 AND user_id=$2',[String(q.id),String(q.uid)])).rows[0]
    if (!row) return res.status(404).end()
    res.setHeader('Content-Type',row.mime); res.setHeader('Content-Length',row.bytes.length)
    return req.method==='HEAD' ? res.status(200).end() : res.status(200).send(row.bytes)
  } finally { await backend.close().catch(()=>{}) }
}
