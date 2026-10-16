import { CloudflareStore } from './_cloudflareStore'
import { CloudflareNotebook } from './_cloudflareNotebook'
import {transcribeNotebookAudio} from './_notebookTranscribe'
import {connectedEmailSender} from './connect'
import {sendNotebook, notebookDeliveries} from './_notebookEmail'
import {createHash} from 'node:crypto'
import {changeNote, actionKey, normalizeNote, type MeetingNote, type NoteChange, type RecipientGroup} from './_notebookModel'
type Client = {query(sql:string,values?:any[]):Promise<{rows:any[]}>}
const id = (value:unknown):value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,159}$/.test(value)
const text = (value:unknown,max:number):value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
const date = (value:unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class NotebookError extends Error {constructor(message:string, public status=400){super(message)}}
let schema:Promise<void>|undefined
export function ensureNotebook(c:Client):Promise<void> {
  return schema ||= c.query(`CREATE TABLE IF NOT EXISTS nalu_notes (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, id TEXT NOT NULL,
    document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS nalu_note_groups (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, id TEXT NOT NULL,
    document JSONB NOT NULL, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS nalu_note_operations (
    user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE, id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,id));`).then(()=>{}).catch(error=>{schema=undefined;throw error})
}
function actions(value:any):MeetingNote['actions'] {
  if(!Array.isArray(value)||value.length>200)throw new NotebookError('Too many action items.')
  return value.map(action=>{
    if(!action||!text(action.text,4000)||!action.text.trim()||!(action.owner===null||text(action.owner,200))||!(action.due===null||text(action.due,200))||typeof action.done!=='boolean')throw new NotebookError('Invalid action item.')
    return {text:action.text,owner:action.owner,due:action.due,done:action.done}
  })
}
function segments(value:any):MeetingNote['segments'] {
  if(!Array.isArray(value)||value.length>5000)throw new NotebookError('Too many transcript segments.')
  const seen=new Set<string>()
  return value.map(segment=>{
    if(!segment||!id(segment.id)||!text(segment.text,32000)||!segment.text.trim()||!date(segment.at)||seen.has(segment.id))throw new NotebookError('Invalid transcript segment.')
    seen.add(segment.id);return {id:segment.id,text:segment.text,at:segment.at}
  })
}
export function validateChanges(noteId:string,value:any):NoteChange[] {
  if(!id(noteId)||!Array.isArray(value)||!value.length||value.length>300||JSON.stringify(value).length>2000000)throw new NotebookError('Invalid notebook change.')
  return value.map(change=>{
    if(change?.kind==='create') {
      const note=change.note
      if(!note||note.id!==noteId||!date(note.createdAt)||!Array.isArray(note.segments)||!text(note.title||'',200)||!text(note.summary,60000)||!Number.isInteger(note.analyzedCount)||note.analyzedCount<0)throw new NotebookError('Invalid note.')
      const clean={id:note.id,title:note.title||'',createdAt:note.createdAt,summary:note.summary,segments:segments(normalizeNote(note).segments),actions:actions(note.actions),analyzedCount:note.analyzedCount}
      if(clean.analyzedCount>clean.segments.length)throw new NotebookError('Analysis must match the transcript.')
      return {kind:'create',note:clean}
    }
    if(change?.kind==='title'&&text(change.title,200))return {kind:'title',title:change.title}
    if(change?.kind==='append')return {kind:'append',segments:segments(change.segments)}
    if(change?.kind==='analysis'&&text(change.summary,60000)&&Number.isInteger(change.analyzedCount)&&change.analyzedCount>=0)return {kind:'analysis',summary:change.summary,actions:actions(change.actions),analyzedCount:change.analyzedCount}
    if(change?.kind==='check'&&text(change.key,5000)&&typeof change.done==='boolean')return {kind:'check',key:change.key,done:change.done}
    throw new NotebookError('Invalid notebook change.')
  })
}
export function validateGroup(group:any):RecipientGroup {
  if(!group||!id(group.id)||!text(group.name,80)||!group.name.trim()||!Array.isArray(group.emails)||group.emails.length>50||!group.emails.every((email:any)=>typeof email==='string'&&email.length<=254&&/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email)))throw new NotebookError('Check your recipient group and email addresses.')
  return {id:group.id,name:group.name.trim(),emails:[...new Map<string,string>(group.emails.map((email:string)=>[email.toLowerCase(),email])).values()]}
}
const readNote=async(c:Client,userId:string,noteId:string):Promise<MeetingNote|undefined> => (await c.query('SELECT document FROM nalu_notes WHERE user_id=$1 AND id=$2',[userId,noteId])).rows[0]?.document
const groups=async(c:Client,userId:string):Promise<RecipientGroup[]> => (await c.query('SELECT document FROM nalu_note_groups WHERE user_id=$1 ORDER BY id',[userId])).rows.map(row=>row.document)
async function write(c:Client,userId:string,note:MeetingNote) {
  if(note.segments.length>5000||note.analyzedCount>note.segments.length||JSON.stringify(note).length>2500000)throw new NotebookError('This note is full. Start a new note; the current transcript is saved.')
  const saved={...note,updatedAt:new Date().toISOString()}
  await c.query('INSERT INTO nalu_notes(user_id,id,document,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(user_id,id) DO UPDATE SET document=EXCLUDED.document,updated_at=NOW()',[userId,note.id,JSON.stringify(saved)])
  return saved
}
async function transaction<T>(c:Client,userId:string,work:()=>Promise<T>):Promise<T> {
  await c.query('BEGIN')
  try {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,18))",[userId])
    const value=await work();await c.query('COMMIT');return value
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error}
}
async function firstOperation(c:Client,userId:string,operationId:string,payload:unknown):Promise<boolean> {
  if(!id(operationId))throw new NotebookError('Invalid notebook request.')
  const fingerprint=digest(payload)
  const previous=(await c.query('SELECT fingerprint FROM nalu_note_operations WHERE user_id=$1 AND id=$2',[userId,operationId])).rows[0]
  if(previous){if(previous.fingerprint!==fingerprint)throw new NotebookError('This request ID belongs to another change.',409);return false}
  await c.query('INSERT INTO nalu_note_operations(user_id,id,fingerprint) VALUES($1,$2,$3)',[userId,operationId,fingerprint])
  return true
}
export async function handleNotebook(c:Client | CloudflareStore,userId:string,body:any,res:any):Promise<boolean> {
  if(c instanceof CloudflareStore)return new CloudflareNotebook(c).handle(userId,body,res)
  if(!['notes-list','notes-save','notes-group','notes-track','notes-send','notes-deliveries','notes-email-sender','notes-transcribe'].includes(body.action))return false
  try {
    await ensureNotebook(c)
    if(body.action==='notes-transcribe') {
      if(!id(body.noteId)||!id(body.segmentId)||!date(body.at)||typeof body.audio!=='string'||body.audio.length>1200000||!body.audio.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio))throw new NotebookError('Invalid recorded audio.')
      const bytes=Buffer.from(body.audio,'base64')
      if(bytes.length<16||bytes.length>900000||bytes.toString('ascii',4,8)!=='ftyp')throw new NotebookError('Expected an M4A recording.')
      const current=await readNote(c,userId,body.noteId)
      if(!current)throw new NotebookError('Save the meeting before transcribing its audio.',404)
      const operationId='audio-'+body.segmentId, payload={noteId:body.noteId,at:body.at,audioHash:digest(body.audio)}
      const previous=(await c.query('SELECT fingerprint FROM nalu_note_operations WHERE user_id=$1 AND id=$2',[userId,operationId])).rows[0]
      if(previous){if(previous.fingerprint!==digest(payload))throw new NotebookError('This recording ID belongs to different audio.',409);res.status(200).json({ok:true});return true}
      let transcript:string
      try {transcript=await transcribeNotebookAudio(body.audio)}catch(error){throw new NotebookError(error instanceof Error?error.message:'Audio is kept for another transcription attempt.',503)}
      await transaction(c,userId,async()=>{
        const latest=await readNote(c,userId,body.noteId)
        if(!latest)throw new NotebookError('Meeting not found.',404)
        if(!await firstOperation(c,userId,operationId,payload))return
        if(transcript) {
          const next=changeNote(latest,body.noteId,[{kind:'append',segments:[{id:body.segmentId,at:body.at,text:transcript}]}])
          next.segments.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))
          await write(c,userId,next)
        }
      })
      res.status(200).json({ok:true});return true
    }
    if(body.action==='notes-email-sender'){res.status(200).json(await connectedEmailSender(c,userId));return true}
    if(body.action==='notes-list') {
      const rows=await c.query('SELECT document FROM nalu_notes WHERE user_id=$1 ORDER BY updated_at DESC',[userId])
      res.status(200).json({notes:rows.rows.map(row=>row.document),groups:await groups(c,userId)});return true
    }
    if(body.action==='notes-deliveries') {
      if(!id(body.noteId))throw new NotebookError('Choose a meeting.')
      res.status(200).json({deliveries:await notebookDeliveries(c,userId,body.noteId)});return true
    }
    if(body.action==='notes-send') {
      if(body.confirmed!==true||!id(body.requestId)||!id(body.noteId))throw new NotebookError('Review the email before sending.')
      const recipients=validateGroup({id:'email',name:'Email',emails:body.recipients}).emails
      if(!recipients.length||recipients.length>20)throw new NotebookError('Choose 1–20 email recipients.')
      const note=await readNote(c,userId,body.noteId)
      if(!note)throw new NotebookError('Note not found.',404)
      if(body.updatedAt!==note.updatedAt)throw new NotebookError('This meeting changed after you reviewed it. Review the updated email before sending.',409)
      if(!note.segments.length||note.analyzedCount!==note.segments.length)throw new NotebookError('Update the summary and action items before sending.')
      const delivery=await sendNotebook(c,userId,note,body.requestId,recipients)
      res.status(200).json({ok:true,delivery});return true
    }
    if(body.action==='notes-group') {
      const group=validateGroup(body.group)
      const result=await transaction(c,userId,async()=>{
        if(await firstOperation(c,userId,body.requestId,{group}))await c.query('INSERT INTO nalu_note_groups(user_id,id,document) VALUES($1,$2,$3::jsonb) ON CONFLICT(user_id,id) DO UPDATE SET document=EXCLUDED.document',[userId,group.id,JSON.stringify(group)])
        return groups(c,userId)
      })
      res.status(200).json({ok:true,groups:result});return true
    }
    if(body.action==='notes-save') {
      const mutation=body.mutation
      const changes=validateChanges(mutation?.noteId,mutation?.changes)
      const note=await transaction(c,userId,async()=>{
        const current=await readNote(c,userId,mutation.noteId)
        if(!await firstOperation(c,userId,mutation.id,{noteId:mutation.noteId,changes}))return current
        let updated:MeetingNote
        try {updated=changeNote(current,mutation.noteId,changes)}catch(error){throw new NotebookError(error instanceof Error?error.message:'Invalid note.',404)}
        const saved=await write(c,userId,updated)
        for(const action of saved.actions)if(action.taskId)await c.query("UPDATE nalu_tasks SET status=$3,progress=$4,updated_at=NOW() WHERE user_id=$1 AND id=$2 AND meta->>'kind'='note-action'",[userId,action.taskId,action.done?'done':'queued',action.done?1:0])
        return saved
      })
      res.status(200).json({ok:true,note});return true
    }
    if(!id(body.noteId)||!text(body.key,5000))throw new NotebookError('Choose an action item.')
    const note=await transaction(c,userId,async()=>{
      const current=await readNote(c,userId,body.noteId)
      if(!current)throw new NotebookError('Note not found.',404)
      const action=current.actions.find(item=>actionKey(item)===body.key)
      if(!action)throw new NotebookError('Action item not found.',404)
      const taskId=`note_${digest([userId,body.noteId,body.key]).slice(0,32)}`
      await c.query(`INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta,updated_at)
        VALUES($1,$2,'mobile',$3,$4,$5,$6,'[]'::jsonb,$7::jsonb,NOW()) ON CONFLICT(id) DO NOTHING`,
        [taskId,userId,action.text.slice(0,300),[current.title||'Meeting note',action.owner&&'Owner: '+action.owner,action.due&&'Due: '+action.due].filter(Boolean).join(' · '),action.done?'done':'queued',action.done?1:0,JSON.stringify({kind:'note-action',noteId:current.id,actionKey:body.key,owner:action.owner,due:action.due})])
      return write(c,userId,{...current,actions:current.actions.map(item=>actionKey(item)===body.key?{...item,taskId}:item)})
    })
    res.status(200).json({ok:true,note})
  }catch(error){res.status(error instanceof NotebookError?error.status:500).json({error:error instanceof NotebookError?error.message:'Could not sync your notebook. Your changes remain on this device.'})}
  return true
}
