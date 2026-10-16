import { attachmentPreview } from './_attachmentPreview'
import { embeddedMedia, emailDraft } from './_attachmentMedia'
import { createHash } from 'node:crypto'
import { ensureArtifactSchema } from './_autopilotArtifacts'
import { readArtifact } from './_autopilotArtifacts'
import { CloudflareDataStore } from './_cloudflareDataStore'
import type { ArtifactClient } from './_autopilotArtifacts'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'
import { CloudflareMessages } from './_cloudflareMessages'

export const CHUNK_BYTES = 768 * 1024
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export type Attachment = { id:string; filename:string; mime:string; size:number; parts:number; title:string; taskId?:string; flowId?:string; sourceId:string; sha256:string; createdAt:string }
const clients=new WeakSet<ArtifactClient>()
export type AttachmentClient = ArtifactClient | CloudflareStore
export async function ensureAttachments(c:AttachmentClient) {
  if(c instanceof CloudflareStore)return
  if(clients.has(c))return
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_task_attachments (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
    meta JSONB NOT NULL,ready BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS nalu_task_attachments_owner ON nalu_task_attachments(user_id,created_at DESC,id);
    CREATE TABLE IF NOT EXISTS nalu_task_attachment_parts (
    attachment_id TEXT NOT NULL REFERENCES nalu_task_attachments(id) ON DELETE CASCADE,
    part INTEGER NOT NULL CHECK(part>=0),bytes BYTEA NOT NULL CHECK(octet_length(bytes)<=786432),PRIMARY KEY(attachment_id,part));`)
  clients.add(c)
}
export function filename(value:unknown) { return String(value||'Output.txt').replace(/[\\/\u0000-\u001f\u007f]/g,'_').replace(/^\.+/,'').slice(0,180)||'Output.txt' }
export async function beginAttachment(c:AttachmentClient,uid:string,raw:any):Promise<Attachment> {
  await ensureAttachments(c)
  if(!raw || typeof raw.sourceId!=='string' || !raw.sourceId || raw.sourceId.length>500 || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isInteger(raw.size) || raw.size<0 || raw.size>MAX_FILE_BYTES)throw new Error('Invalid attachment metadata (100 MB maximum).')
  const id='att_'+createHash('sha256').update(JSON.stringify([uid,raw.sourceId,raw.sha256])).digest('hex')
  const meta:Attachment={id,sourceId:raw.sourceId,filename:filename(raw.filename),mime:typeof raw.mime==='string'&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(raw.mime)?raw.mime:'application/octet-stream',size:raw.size,parts:Math.max(1,Math.ceil(raw.size/CHUNK_BYTES)),title:String(raw.title||raw.filename||'Output').slice(0,300),sha256:raw.sha256,createdAt:new Date().toISOString(),...(typeof raw.taskId==='string'?{taskId:raw.taskId.slice(0,300)}:{}),...(typeof raw.flowId==='string'?{flowId:raw.flowId.slice(0,300)}:{})}
  if(c instanceof CloudflareStore)return new CloudflareAttachments(c).begin(uid,meta)
  await c.query('INSERT INTO nalu_task_attachments(id,user_id,meta) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING',[id,uid,JSON.stringify(meta)])
  return (await c.query('SELECT meta FROM nalu_task_attachments WHERE user_id=$1 AND id=$2',[uid,id])).rows[0].meta
}
export async function putAttachmentPart(c:AttachmentClient,uid:string,id:string,part:number,bytes:Buffer) {
  if(c instanceof CloudflareStore)return new CloudflareAttachments(c).put(uid,id,part,bytes)
  const row=(await c.query('SELECT meta,ready FROM nalu_task_attachments WHERE user_id=$1 AND id=$2',[uid,id])).rows[0]
  if(!row)throw new Error('Attachment not found.')
  const m=row.meta as Attachment
  if(!Number.isInteger(part)||part<0||part>=m.parts||bytes.length!==(part===m.parts-1?m.size-part*CHUNK_BYTES:CHUNK_BYTES))throw new Error('Invalid attachment part.')
  const previous=(await c.query('SELECT bytes FROM nalu_task_attachment_parts WHERE attachment_id=$1 AND part=$2',[id,part])).rows[0]
  if(previous) {if(!Buffer.from(previous.bytes).equals(bytes))throw new Error('Attachment part already contains different bytes.');return}
  if(row.ready)throw new Error('Completed attachment cannot change.')
  await c.query('INSERT INTO nalu_task_attachment_parts(attachment_id,part,bytes) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,part,bytes])
}
export async function finishAttachment(c:AttachmentClient,uid:string,id:string) {
  if(c instanceof CloudflareStore)return new CloudflareAttachments(c).finish(uid,id)
  const row=(await c.query('SELECT meta FROM nalu_task_attachments WHERE user_id=$1 AND id=$2',[uid,id])).rows[0]
  if(!row)throw new Error('Attachment not found.')
  const m=row.meta as Attachment
  const parts=(await c.query('SELECT bytes FROM nalu_task_attachment_parts WHERE attachment_id=$1 ORDER BY part',[id])).rows
  const hash=createHash('sha256');let size=0
  for(const p of parts){const b=Buffer.from(p.bytes);size+=b.length;hash.update(b)}
  if(parts.length!==m.parts || size!==m.size || hash.digest('hex')!==m.sha256)throw new Error('Upload is incomplete or failed its integrity check.')
  await c.query('UPDATE nalu_task_attachments SET ready=TRUE WHERE user_id=$1 AND id=$2',[uid,id]);return m
}
export async function storeAttachment(c:AttachmentClient,uid:string,meta:Record<string,unknown>,bytes:Buffer) {
  const saved=await beginAttachment(c,uid,{...meta,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  const ready=c instanceof CloudflareStore?(await new CloudflareAttachments(c).get(uid,saved.id))?.ready:(await c.query('SELECT ready FROM nalu_task_attachments WHERE user_id=$1 AND id=$2',[uid,saved.id])).rows[0]?.ready
  if(ready)return saved
  for(let part=0;part<saved.parts;part++)await putAttachmentPart(c,uid,saved.id,part,bytes.subarray(part*CHUNK_BYTES,(part+1)*CHUNK_BYTES))
  return finishAttachment(c,uid,saved.id)
}
export async function listAttachments(c:AttachmentClient,uid:string,taskId?:string,cursor?:string) {
  await ensureAttachments(c)
  if(c instanceof CloudflareStore)return new CloudflareAttachments(c).list(uid,taskId,cursor)
  const rows=(await c.query(`SELECT meta FROM nalu_task_attachments WHERE user_id=$1 AND ready=TRUE
    AND ($2::text IS NULL OR meta->>'taskId'=$2 OR 'flow_def_'||(meta->>'flowId')=$2)
    AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT 101`,[uid,taskId||null,cursor||null])).rows
  return {attachments:rows.slice(0,100).map(r=>r.meta),next:rows.length>100?rows[99].meta.id:null}
}
export function parseArray(raw:unknown):any[] {for(let i=0;i<6&&typeof raw==='string';i++){try{raw=JSON.parse(raw)}catch{return []}}return Array.isArray(raw)?raw:[]}
/** Materialize existing stored results too; never rerun the task to obtain files. */
export async function collectTaskAttachments(c:AttachmentClient,uid:string,taskId:string) {
  const text=async(sourceId:string,title:string,body:unknown,extra:Record<string,unknown>={})=>{
    if(body==null||body==='')return
    await storeAttachment(c,uid,{sourceId,taskId,title,filename:filename(title)+'.txt',mime:'text/plain',...extra},Buffer.from(typeof body==='string'?body:JSON.stringify(body,null,2)))
  }
  await ensureArtifactSchema(c)
  const prior=c instanceof CloudflareStore?[]:(await c.query(`SELECT meta,bytes FROM nalu_autopilot_artifacts WHERE user_id=$1 AND (meta->>'runId'=$2 OR 'flow_def_'||(meta->>'flowId')=$2)`,[uid,taskId])).rows
  for(const file of prior)await storeAttachment(c,uid,{sourceId:file.meta.id,taskId,flowId:file.meta.flowId,title:file.meta.nodeLabel,filename:file.meta.filename,mime:file.meta.mime||'text/plain'},Buffer.from(file.bytes))
  if(c instanceof CloudflareStore) {
    const artifacts=(await c.query("SELECT id FROM nalu_autopilot_artifacts WHERE user_id=?1 AND (json_extract(meta,'$.runId')=?2 OR 'flow_def_'||json_extract(meta,'$.flowId')=?2)",[uid,taskId])).results
    for(const row of artifacts) {
      const artifact=await readArtifact(c,uid,String(row.id))
      if(artifact)await storeAttachment(c,uid,{sourceId:artifact.meta.id,taskId,flowId:artifact.meta.flowId,title:artifact.meta.nodeLabel,filename:artifact.meta.filename,mime:artifact.meta.mime||'text/plain'},artifact.bytes)
    }
  }
  const task=c instanceof CloudflareStore?(await c.query('SELECT * FROM nalu_tasks WHERE user_id=? AND id=?',[uid,taskId])).results[0] as any:(await c.query('SELECT * FROM nalu_tasks WHERE user_id=$1 AND id=$2',[uid,taskId])).rows[0]
  if(task&&c instanceof CloudflareStore){task.meta=JSON.parse(String(task.meta||'{}'));task.events=JSON.parse(String(task.events||'[]'))}
  if(task){
    await text(taskId+':result',task.title||'Task result',task.meta?.result)
    if(!task.meta?.result && ['done','failed','cancelled'].includes(task.status))await text(taskId+':summary',(task.title||'Task')+' — summary',[task.detail,...(Array.isArray(task.events)?task.events.map((e:any)=>e.m):[])].filter(Boolean).join('\n\n'))
    if(/^media_[a-f0-9]{40}$/.test(task.meta?.mediaId||'')) {
      const image=c instanceof CloudflareStore?await new CloudflareMessages(c).media(uid,task.meta.mediaId):(await c.query('SELECT bytes,mime FROM nalu_message_media WHERE user_id=$1 AND id=$2',[uid,task.meta.mediaId])).rows[0]
      if(image)await storeAttachment(c,uid,{sourceId:c instanceof CloudflareStore?taskId+':'+task.meta.mediaId:task.meta.mediaId,taskId,title:task.title,filename:filename(task.title)+'.jpg',mime:image.mime},Buffer.from(image.bytes))
    }
    if(task.meta?.results && typeof task.meta.results==='object')for(const [node,body]of Object.entries(task.meta.results))await text(taskId+':'+node,node,body)
  }
  const documents=c instanceof CloudflareStore?await new CloudflareDataStore(c).read(uid,['nalu-agent-flows','nalu-chats']):null
  const rows=documents?Object.entries(documents.values).map(([key,value])=>({key,value})):(await (c as ArtifactClient).query("SELECT key,value FROM nalu_user_data WHERE user_id=$1 AND key IN ('nalu-agent-flows','nalu-chats')",[uid])).rows
  const flows=parseArray(rows.find(r=>r.key==='nalu-agent-flows')?.value)
  for(const f of flows) {
    if(taskId!=='flow_def_'+f.id && taskId!==`flow_${f.id}_${f.run?.startedAt}`)continue
    for(const [node,body]of Object.entries(f.results||{})) {
      const label=f.nodes?.find((n:any)=>n.id===node)?.label||node
      await text(`flow:${f.id}:${f.run?.startedAt||f.lastRun||'legacy'}:${node}`,label,body,{flowId:f.id})
    }
  }
  const chat=parseArray(rows.find(r=>r.key==='nalu-chats')?.value).find(ch=>'chat_'+ch.id===taskId)
  if(chat){
    await text(taskId+':conversation',chat.title||'Conversation',(chat.messages||[]).map((m:any)=>`${m.role==='user'?'You':'Nalu'}\n${m.content||''}`).join('\n\n'))
    for(const [i,m]of (chat.messages||[]).entries()) {
      if(m.role!=='assistant')continue
      for(const media of embeddedMedia(m))await storeAttachment(c,uid,{sourceId:`${taskId}:${i}:media:${media.sha256}`,taskId,title:media.title,filename:media.filename,mime:media.mime},media.bytes)
      const draft=emailDraft(m.email)
      if(draft)await storeAttachment(c,uid,{sourceId:`${taskId}:${i}:email`,taskId,title:draft.title,filename:filename(draft.title)+'.eml',mime:'message/rfc822'},draft.bytes)
      for(const kind of ['doc','deck','sheet','design','cad','video','image','email'])if(m[kind]!=null){
      await storeAttachment(c,uid,{sourceId:`${taskId}:${i}:${kind}`,taskId,title:m[kind]?.title||kind,filename:filename(m[kind]?.title||kind)+'.json',mime:'application/json'},Buffer.from(JSON.stringify(m[kind],null,2)))
      if(kind==='cad'&&typeof m[kind]==='string')await storeAttachment(c,uid,{sourceId:`${taskId}:${i}:scad`,taskId,title:'CAD model',filename:'Model.scad',mime:'text/plain'},Buffer.from(m[kind]))
      const html=kind==='design'&&typeof m[kind]?.html==='string'?m[kind].html:attachmentPreview(m[kind]?.title||kind,m[kind])
      await storeAttachment(c,uid,{sourceId:`${taskId}:${i}:${kind}:preview`,taskId,title:m[kind]?.title||kind,filename:filename(m[kind]?.title||kind)+'.html',mime:'text/html'},Buffer.from(html))

      }
    }
  }
}
