import { CloudflareStore } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'
import { connectionBackend } from './_connectionBackend'
import { readToken,safeJson } from './_db'
import { cors } from './_cors'
import { beginAttachment,putAttachmentPart,finishAttachment,ensureAttachments,collectTaskAttachments,listAttachments } from './_taskAttachments'
export default async function handler(req:any,res:any) {
  if(cors(req,res))return
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff')
  if(!['POST','GET'].includes(req.method))return res.status(405).end()
  const token=readToken(req);if(!token)return res.status(401).json({error:'Sign in to open attachments.'})
  const backend=connectionBackend(), c=backend.client
  try {
    await backend.connect();const uid=await backend.userId(token)
    if(!uid)return res.status(401).json({error:'Sign in to open attachments.'})
    await ensureAttachments(c)
    if(req.method==='GET') {
      const {id,part}=req.query||{}
      if(typeof id!=='string'||!/^att_[a-f0-9]{64}$/.test(id)||typeof part!=='string'||!/^\d+$/.test(part))return res.status(400).json({error:'Invalid attachment.'})
      const bytes=c instanceof CloudflareStore?await new CloudflareAttachments(c).part(uid,id,Number(part)):undefined
      const row=c instanceof CloudflareStore?(bytes?{bytes}:null):(await c.query('SELECT a.meta,p.bytes FROM nalu_task_attachments a JOIN nalu_task_attachment_parts p ON p.attachment_id=a.id WHERE a.user_id=$1 AND a.id=$2 AND a.ready=TRUE AND p.part=$3',[uid,id,Number(part)])).rows[0]
      if(!row)return res.status(404).json({error:'Attachment unavailable.'})
      // Each response stays below the host response-size limit, including videos.
      return res.status(200).json({base64:Buffer.from(row.bytes).toString('base64')})
    }
    const b=typeof req.body==='string'?safeJson(req.body):req.body||{}
    if(b.action==='list') {
      if(b.taskId!=null && (typeof b.taskId!=='string'||b.taskId.length>300))return res.status(400).json({error:'Invalid task.'})
      if(b.taskId&&!b.cursor)await collectTaskAttachments(c,uid,b.taskId)
      return res.status(200).json(await listAttachments(c,uid,b.taskId,b.cursor))
    }
    if(b.action==='begin')return res.status(200).json({attachment:await beginAttachment(c,uid,b.meta)})
    if(!/^att_[a-f0-9]{64}$/.test(b.id||''))return res.status(400).json({error:'Invalid attachment.'})
    if(b.action==='part') {
      if(typeof b.base64!=='string'||b.base64.length>1048576||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.base64))return res.status(400).json({error:'Invalid attachment bytes.'})
      await putAttachmentPart(c,uid,b.id,b.part,Buffer.from(b.base64,'base64'));return res.status(200).json({ok:true})
    }
    if(b.action==='finish')return res.status(200).json({attachment:await finishAttachment(c,uid,b.id)})
    return res.status(400).json({error:'Unknown attachment action.'})
  }catch(e){return res.status(400).json({error:e instanceof Error?e.message:'Attachments are unavailable.'})}
  finally{await backend.close().catch(()=>{})}
}
