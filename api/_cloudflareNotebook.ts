import { storedJson } from './_storedJson'
import { createHash, randomUUID } from 'node:crypto'
import { CloudflareStore, CloudflareConflict, type CloudflareStatement } from './_cloudflareStore'
import { CloudflareAttachments } from './_cloudflareAttachments'
import { storeAttachment } from './_taskAttachments'
import { NotebookError, validateChanges, validateGroup } from './_notebook'
import { actionKey, changeNote, type MeetingNote } from './_notebookModel'
import { notebookDeliveries, sendNotebook } from './_notebookEmail'
import { connectedEmailSender } from './connect'
import { transcribeNotebookAudio } from './_notebookTranscribe'
const id = (value: unknown) => typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,159}$/.test(value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')"

/** Full notebooks use private verified file chunks. The searchable summary,
 * mutation receipt and action-item activity are committed in one D1 batch. */
export class CloudflareNotebook {
  constructor(readonly store: CloudflareStore) {}
  private async noteRow(owner: string, row: any): Promise<MeetingNote | undefined> {
    if(!row)return undefined
    if(!row.attachment_id)return JSON.parse(row.document)
    const bytes=await new CloudflareAttachments(this.store).bytes(owner,row.attachment_id)
    if(!bytes)throw new Error('Saved notebook file is incomplete.')
    return JSON.parse(bytes.toString('utf8'))
  }
  async read(owner: string, noteId: string) { return this.noteRow(owner,(await this.store.query('SELECT document,attachment_id FROM nalu_notes WHERE user_id=? AND id=?',[owner,noteId])).results[0]) }
  async groups(owner: string) {return (await this.store.query('SELECT document FROM nalu_note_groups WHERE user_id=? ORDER BY id',[owner])).results.map(row=>JSON.parse(String(row.document)))}
  private async mutate(owner: string, noteId: string, operation: {id:string;payload:unknown} | undefined, change: (current:MeetingNote|undefined)=>MeetingNote, tracked?: {key:string;taskId:string}) {
    if(operation&&!id(operation.id))throw new NotebookError('Invalid notebook request.')
    const scope=`notebook:${owner}`, fingerprint=operation?digest(operation.payload):''
    for(let attempt=0;attempt<5;attempt++) {
      const snapshot=await this.store.batch([
        {sql:'SELECT revision FROM nalu_store_revisions WHERE scope=?',params:[scope]},
        {sql:'SELECT document,attachment_id FROM nalu_notes WHERE user_id=? AND id=?',params:[owner,noteId]},
        {sql:'SELECT fingerprint FROM nalu_note_operations WHERE user_id=? AND id=?',params:[owner,operation?.id||'']},
      ])
      const current=await this.noteRow(owner,snapshot.results[1].results[0]), receipt=snapshot.results[2].results[0]
      if(receipt){if(receipt.fingerprint!==fingerprint)throw new NotebookError('This request ID belongs to another change.',409);return current}
      let note:MeetingNote
      try{note=change(current)}catch(error){throw error instanceof NotebookError?error:new NotebookError(error instanceof Error?error.message:'Invalid note.',404)}
      if(note.segments.length>5000||note.analyzedCount>note.segments.length||JSON.stringify(note).length>2500000)throw new NotebookError('This note is full. Start a new note; the current transcript is saved.')
      note={...note,updatedAt:new Date().toISOString()}
      const attachment=await storeAttachment(this.store,owner,{sourceId:`notebook:${note.id}`,title:note.title||'Meeting note',filename:'Meeting note.json',mime:'application/json'},Buffer.from(JSON.stringify(note)))
      const revision=randomUUID(), guard='EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=?1 AND revision=?2)'
      const summary={id:note.id,title:note.title,summary:note.summary.slice(0,12000),createdAt:note.createdAt,updatedAt:note.updatedAt,analyzedCount:note.analyzedCount}
      const statements:CloudflareStatement[]=[
        {sql:"INSERT INTO nalu_store_revisions(scope,revision) VALUES(?,'') ON CONFLICT DO NOTHING",params:[scope]},
        {sql:'UPDATE nalu_store_revisions SET revision=? WHERE scope=? AND revision=? RETURNING revision',params:[revision,scope,String(snapshot.results[0].results[0]?.revision||'')]},
        {sql:`INSERT INTO nalu_notes(user_id,id,document,attachment_id,updated_at) SELECT ?3,?4,?5,?6,${now} WHERE ${guard}
          ON CONFLICT(user_id,id) DO UPDATE SET document=excluded.document,attachment_id=excluded.attachment_id,updated_at=excluded.updated_at`,params:[scope,revision,owner,noteId,JSON.stringify(summary),attachment.id]},
      ]
      if(operation)statements.push({sql:`INSERT INTO nalu_note_operations(user_id,id,fingerprint) SELECT ?3,?4,?5 WHERE ${guard}`,params:[scope,revision,owner,operation.id,fingerprint]})
      const actions=note.actions.filter(item=>item.taskId).map(item=>({id:item.taskId,done:!!item.done}))
      statements.push({sql:`UPDATE nalu_tasks SET status=CASE WHEN (SELECT json_extract(value,'$.done') FROM json_each(?4) WHERE json_extract(value,'$.id')=nalu_tasks.id) THEN 'done' ELSE 'queued' END,
        progress=CASE WHEN (SELECT json_extract(value,'$.done') FROM json_each(?4) WHERE json_extract(value,'$.id')=nalu_tasks.id) THEN 1 ELSE 0 END,updated_at=${now}
        WHERE user_id=?3 AND json_extract(meta,'$.kind')='note-action' AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?4)) AND ${guard}`,params:[scope,revision,owner,JSON.stringify(actions)]})
      if(tracked) {
        const action=note.actions.find(item=>actionKey(item)===tracked.key)!
        const detail=[note.title||'Meeting note',action.owner&&'Owner: '+action.owner,action.due&&'Due: '+action.due].filter(Boolean).join(' · ')
        statements.push({sql:`INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta,updated_at)
          SELECT ?3,?4,'mobile',?5,?6,?7,?8,'[]',?9,${now} WHERE ${guard} ON CONFLICT(id) DO NOTHING`,params:[scope,revision,tracked.taskId,owner,action.text.slice(0,300),detail,action.done?'done':'queued',Number(action.done),JSON.stringify({kind:'note-action',noteId:note.id,actionKey:tracked.key,owner:action.owner,due:action.due})]})
      }
      const result=await this.store.batch(statements)
      if(result.results[1].results.length)return note
    }
    throw new CloudflareConflict('The notebook changed while saving. Your local changes are retained.')
  }
  async handle(owner: string, body: any, res: any): Promise<boolean> {
    if(!['notes-list','notes-save','notes-group','notes-track','notes-send','notes-deliveries','notes-email-sender','notes-transcribe'].includes(body.action))return false
    try {
      if(body.action==='notes-list') {
        const rows=(await this.store.query('SELECT document,attachment_id FROM nalu_notes WHERE user_id=? ORDER BY updated_at DESC',[owner])).results,notes=[]
        for(let offset=0;offset<rows.length;offset+=4)notes.push(...await Promise.all(rows.slice(offset,offset+4).map(row=>this.noteRow(owner,row))))
        await storedJson(res.status(200),{notes,groups:await this.groups(owner)});return true
      }
      if(body.action==='notes-email-sender'){res.status(200).json(await connectedEmailSender(this.store,owner));return true}
      if(body.action==='notes-deliveries') {
        if(!id(body.noteId))throw new NotebookError('Choose a meeting.')
        res.status(200).json({deliveries:await notebookDeliveries(this.store,owner,body.noteId)});return true
      }
      if(body.action==='notes-send') {
        if(body.confirmed!==true||!id(body.requestId)||!id(body.noteId))throw new NotebookError('Review the email before sending.')
        const recipients=validateGroup({id:'email',name:'Email',emails:body.recipients}).emails
        if(!recipients.length||recipients.length>20)throw new NotebookError('Choose 1–20 email recipients.')
        const note=await this.read(owner,body.noteId)
        if(!note)throw new NotebookError('Note not found.',404)
        if(body.updatedAt!==note.updatedAt)throw new NotebookError('This meeting changed after you reviewed it. Review the updated email before sending.',409)
        if(!note.segments.length||note.analyzedCount!==note.segments.length)throw new NotebookError('Update the summary and action items before sending.')
        res.status(200).json({ok:true,delivery:await sendNotebook(this.store,owner,note,body.requestId,recipients)});return true
      }
      if(body.action==='notes-group') {
        const group=validateGroup(body.group),fingerprint=digest({group})
        if(!id(body.requestId))throw new NotebookError('Invalid notebook request.')
        // A unique operation ID is the transaction's first-writer receipt.
        const claim=randomUUID(),scope=`note-group:${owner}:${body.requestId}`
        const result=await this.store.batch([
          {sql:'INSERT INTO nalu_store_revisions(scope,revision) VALUES(?,?) ON CONFLICT DO NOTHING',params:[scope,claim]},
          {sql:`INSERT INTO nalu_note_operations(user_id,id,fingerprint) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=?4 AND revision=?5) ON CONFLICT DO NOTHING`,params:[owner,body.requestId,fingerprint,scope,claim]},
          {sql:`INSERT INTO nalu_note_groups(user_id,id,document) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=?4 AND revision=?5)
            AND EXISTS(SELECT 1 FROM nalu_note_operations WHERE user_id=?1 AND id=?6 AND fingerprint=?7)
            ON CONFLICT(user_id,id) DO UPDATE SET document=excluded.document`,params:[owner,group.id,JSON.stringify(group),scope,claim,body.requestId,fingerprint]},
          {sql:'SELECT fingerprint FROM nalu_note_operations WHERE user_id=? AND id=?',params:[owner,body.requestId]},
        ])
        if(result.results[3].results[0]?.fingerprint!==fingerprint)throw new NotebookError('This request ID belongs to another change.',409)
        res.status(200).json({ok:true,groups:await this.groups(owner)});return true
      }
      if(body.action==='notes-save') {
        const mutation=body.mutation,changes=validateChanges(mutation?.noteId,mutation?.changes)
        const note=await this.mutate(owner,mutation.noteId,{id:mutation.id,payload:{noteId:mutation.noteId,changes}},current=>changeNote(current,mutation.noteId,changes))
        await storedJson(res.status(200),{ok:true,note});return true
      }
      if(body.action==='notes-transcribe') {
        if(!id(body.noteId)||!id(body.segmentId)||typeof body.at!=='string'||!Number.isFinite(Date.parse(body.at))||typeof body.audio!=='string'||body.audio.length>1200000||!body.audio.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio))throw new NotebookError('Invalid recorded audio.')
        const bytes=Buffer.from(body.audio,'base64')
        if(bytes.length<16||bytes.length>900000||bytes.toString('ascii',4,8)!=='ftyp')throw new NotebookError('Expected an M4A recording.')
        if(!await this.read(owner,body.noteId))throw new NotebookError('Save the meeting before transcribing its audio.',404)
        const operation={id:'audio-'+body.segmentId,payload:{noteId:body.noteId,at:body.at,audioHash:digest(body.audio)}}
        const previous=(await this.store.query('SELECT fingerprint FROM nalu_note_operations WHERE user_id=? AND id=?',[owner,operation.id])).results[0]
        if(previous){if(previous.fingerprint!==digest(operation.payload))throw new NotebookError('This recording ID belongs to different audio.',409);res.status(200).json({ok:true});return true}
        let transcript:string
        try{transcript=await transcribeNotebookAudio(body.audio)}catch(error){throw new NotebookError(error instanceof Error?error.message:'Audio is kept for another transcription attempt.',503)}
        await this.mutate(owner,body.noteId,operation,current=>{
          if(!current)throw new NotebookError('Meeting not found.',404)
          const next=transcript?changeNote(current,body.noteId,[{kind:'append',segments:[{id:body.segmentId,at:body.at,text:transcript}]}]):current
          next.segments.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));return next
        })
        res.status(200).json({ok:true});return true
      }
      if(!id(body.noteId)||typeof body.key!=='string'||body.key.length>5000||body.key.includes('\0'))throw new NotebookError('Choose an action item.')
      const taskId=`note_${digest([owner,body.noteId,body.key]).slice(0,32)}`
      const note=await this.mutate(owner,body.noteId,undefined,current=>{
        if(!current)throw new NotebookError('Note not found.',404)
        if(!current.actions.some(item=>actionKey(item)===body.key))throw new NotebookError('Action item not found.',404)
        return {...current,actions:current.actions.map(item=>actionKey(item)===body.key?{...item,taskId}:item)}
      },{key:body.key,taskId})
      await storedJson(res.status(200),{ok:true,note})
    }catch(error){res.status(error instanceof NotebookError?error.status:503).json({error:error instanceof NotebookError?error.message:'Could not sync your notebook. Your changes remain on this device.'})}
    return true
  }
}
