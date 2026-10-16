import { CloudflareStore } from './_cloudflareStore'
import {createHash} from 'node:crypto'
import {sendConnectedEmail} from './connect'
import type {MeetingNote} from './_notebookModel'
type Client={query(sql:string,params?:any[]):Promise<{rows:any[]}>}
export type NoteDelivery={id:string;noteId:string;recipients:string[];status:'sending'|'accepted'|'unconfirmed';results:{email:string;status:'accepted'|'unconfirmed';detail:string}[];createdAt:string}
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)).replace(/\n/g,'<br>')
export function notebookEmail(note:MeetingNote) {
  const title=note.title||'Meeting notes'
  const subject=('Nalu notes — '+title).replace(/[\r\n]/g,' ').slice(0,200)
  const checklist=note.actions.map(action=>`${action.done?'[x]':'[ ]'} ${action.text}${action.owner?' — '+action.owner:''}${action.due?' · Due '+action.due:''}`)
  const text=[title,note.createdAt,'Summary',note.summary,'Action items',...checklist,'Full transcript',...note.segments.map(segment=>segment.text)].join('\n\n')
  const html=`<!doctype html><html><body style="margin:0;background:#f5f3ef;color:#202020;font-family:Arial,sans-serif"><main style="max-width:680px;margin:24px auto;background:#fff;padding:32px;line-height:1.6"><p style="color:#8f6a33;font-size:12px;letter-spacing:2px">NALU · MEETING NOTES</p><h1 style="font-size:28px;line-height:1.2">${escape(title)}</h1><p style="color:#666">${escape(new Date(note.createdAt).toISOString())}</p><h2>Summary</h2><p>${escape(note.summary||'No summary available.')}</p><h2>Action items</h2>${note.actions.length?'<ul>'+note.actions.map(action=>`<li style="margin-bottom:14px"><strong>${action.done?'Completed':'To do'}:</strong> ${escape(action.text)}${action.owner?'<br>Owner: '+escape(action.owner):''}${action.due?'<br>Due: '+escape(action.due):''}</li>`).join('')+'</ul>':'<p>No explicit action items identified.</p>'}<h2>Full transcript</h2>${note.segments.map(segment=>`<p>${escape(segment.text)}</p>`).join('')}<hr style="border:0;border-top:1px solid #e5e5e5"><p style="color:#666;font-size:12px">Prepared with Nalu Silent Notes.</p></main></body></html>`
  return {subject,text,html}
}
export async function notebookDeliveries(c:Client | CloudflareStore,userId:string,noteId:string):Promise<NoteDelivery[]> {
  if(c instanceof CloudflareStore)return (await c.query('SELECT document FROM nalu_note_deliveries WHERE user_id=? AND note_id=? ORDER BY created_at DESC LIMIT 10',[userId,noteId])).results.map(row=>JSON.parse(String(row.document)))
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_note_deliveries(user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,id TEXT NOT NULL,note_id TEXT NOT NULL,fingerprint TEXT NOT NULL,document JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(user_id,id))`)
  return (await c.query('SELECT document FROM nalu_note_deliveries WHERE user_id=$1 AND note_id=$2 ORDER BY created_at DESC LIMIT 10',[userId,noteId])).rows.map(row=>row.document)
}
export async function sendNotebook(c:Client | CloudflareStore,userId:string,note:MeetingNote,id:string,recipients:string[],send=sendConnectedEmail):Promise<NoteDelivery> {
  const payload=notebookEmail(note),fingerprint=createHash('sha256').update(JSON.stringify([note.id,payload,recipients])).digest('hex')
  await notebookDeliveries(c,userId,note.id)
  let intent:NoteDelivery={id,noteId:note.id,recipients,status:'sending',results:[],createdAt:new Date().toISOString()}
  if(c instanceof CloudflareStore) {
    const saved=await c.batch([
      {sql:'INSERT INTO nalu_note_deliveries(user_id,id,note_id,fingerprint,document) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id',params:[userId,id,note.id,fingerprint,JSON.stringify(intent)]},
      {sql:'SELECT fingerprint,document FROM nalu_note_deliveries WHERE user_id=? AND id=?',params:[userId,id]},
    ])
    if(!saved.results[0].results.length) {
      const previous=saved.results[1].results[0]
      if(previous?.fingerprint!==fingerprint)throw Error('This email request already belongs to different content. Review the current notes before sending another email.')
      return JSON.parse(String(previous.document))
    }
  } else {
  await c.query('BEGIN')
  try {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,19))',[userId])
    const existing=(await c.query('SELECT fingerprint,document FROM nalu_note_deliveries WHERE user_id=$1 AND id=$2',[userId,id])).rows[0]
    if(existing){
      if(existing.fingerprint!==fingerprint)throw Error('This email request already belongs to different content. Review the current notes before sending another email.')
      await c.query('COMMIT');return existing.document
    }
    await c.query('INSERT INTO nalu_note_deliveries(user_id,id,note_id,fingerprint,document) VALUES($1,$2,$3,$4,$5::jsonb)',[userId,id,note.id,fingerprint,JSON.stringify(intent)])
    await c.query('COMMIT')
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error}
  }
  // The durable intent consumes this request before any send. Ambiguous carrier
  // acceptance or a dropped client connection must never trigger a second email.
  const results=await Promise.all(recipients.map(async email=>{
    try {const result=await send(c,userId,{to:email,...payload});return {email,status:result.ok?'accepted' as const:'unconfirmed' as const,detail:result.detail}}
    catch {return {email,status:'unconfirmed' as const,detail:'Email acceptance could not be confirmed. Check your email before sending another copy.'}}
  }))
  intent={...intent,results,status:results.every(result=>result.status==='accepted')?'accepted':'unconfirmed'}
  if(c instanceof CloudflareStore)await c.batch([{sql:'UPDATE nalu_note_deliveries SET document=? WHERE user_id=? AND id=? AND fingerprint=?',params:[JSON.stringify(intent),userId,id,fingerprint]}])
  else await c.query('UPDATE nalu_note_deliveries SET document=$3::jsonb WHERE user_id=$1 AND id=$2',[userId,id,JSON.stringify(intent)])
  return intent
}
