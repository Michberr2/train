import { randomBytes } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { ownsPhone } from './_phoneOwner'
import { normalizePhone } from './_db'
import { placeCall, publicBase, sign, phoneConfigured } from './_telephony'
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')"

export class CloudflareQuestionPhone {
  constructor(readonly store: CloudflareStore) {}
  async bind(uid:string,id:string,sid:string){
    const result=await this.store.batch([
      {sql:`UPDATE nalu_task_questions SET call_sid=?3 WHERE id=?1 AND user_id=?2 AND status='pending' AND (call_sid IS NULL OR call_sid=?3)
        AND EXISTS(SELECT 1 FROM nalu_task_jobs j WHERE j.id=nalu_task_questions.task_id AND j.user_id=?2 AND j.status='running' AND julianday(j.lease_expires_at)>julianday('now')) RETURNING id`,params:[id,uid,sid]},
      {sql:`SELECT q.*,j.status AS job_status,j.lease_expires_at,t.meta AS task_meta FROM nalu_task_questions q
        JOIN nalu_task_jobs j ON j.id=q.task_id AND j.user_id=q.user_id JOIN nalu_tasks t ON t.id=q.task_id AND t.user_id=q.user_id WHERE q.id=? AND q.user_id=?`,params:[id,uid]},
    ])
    const row=result.results[1].results[0]
    return {bound:!!result.results[0].results.length,question:row?{...row,task_meta:JSON.parse(String(row.task_meta||'{}'))}:null}
  }
  async draft(uid:string,id:string,sid:string,text:string){
    return !!(await this.store.batch([{sql:`UPDATE nalu_task_questions SET phone_draft=?4 WHERE id=?1 AND user_id=?2 AND call_sid=?3 AND status='pending'
      AND EXISTS(SELECT 1 FROM nalu_task_jobs j WHERE j.id=nalu_task_questions.task_id AND j.user_id=?2 AND j.status='running' AND julianday(j.lease_expires_at)>julianday('now')) RETURNING id`,params:[id,uid,sid,text]}])).results[0].results.length
  }
  async claim(uid:string){
    return (await this.store.batch([{sql:`UPDATE nalu_task_questions SET notification_status='sending' WHERE id=(
      SELECT q.id FROM nalu_task_questions q JOIN nalu_task_jobs j ON j.id=q.task_id AND j.user_id=q.user_id
      WHERE q.user_id=? AND q.status='pending' AND q.notification_status='pending' AND j.status='running'
      AND julianday(j.lease_expires_at)>julianday('now') ORDER BY q.created_at,q.id LIMIT 1) RETURNING *`,params:[uid]}])).results[0].results[0]
  }
  async settled(uid:string,id:string,taskId:string,result:{ok:boolean;sid?:string;error?:string}){
    const saved=await this.store.batch([
      {sql:`UPDATE nalu_task_questions SET notification_status=CASE WHEN call_sid IS NOT NULL AND ?3 IS NOT NULL AND call_sid<>?3 THEN 'uncertain' ELSE ?4 END,
        call_sid=COALESCE(call_sid,?3),notification_error=CASE WHEN call_sid IS NOT NULL AND ?3 IS NOT NULL AND call_sid<>?3 THEN 'Carrier identity conflict; inspect provider logs.' ELSE ?5 END
        WHERE id=?1 AND user_id=?2 AND notification_status='sending' RETURNING notification_status,notification_error`,params:[id,uid,result.sid||null,result.ok?'sent':'uncertain',result.error||null]},
      {sql:`UPDATE nalu_tasks SET meta=json_set(meta,'$.phoneNotification',(SELECT notification_status FROM nalu_task_questions WHERE id=?3 AND user_id=?2)),
        events=json_insert(events,'$[#]',json_object('t',${now},'m',CASE WHEN (SELECT notification_status FROM nalu_task_questions WHERE id=?3 AND user_id=?2)='sent' THEN 'Nalu called your saved number with a task question.' ELSE 'Phone delivery could not be confirmed; answer the question in Voice.' END)),updated_at=${now} WHERE id=?1 AND user_id=?2`,params:[taskId,uid,id]},
    ])
    return saved.results[0].results[0]
  }
}

export async function deliverCloudflareQuestion(store:CloudflareStore,uid:string,res:any){
  const none=(reason?:string)=>res.status(200).json({ok:true,delivered:false,...(reason?{reason}:{})})
  if(!ownsPhone(uid))return none('This account does not own the private phone line.')
  const value=(await new CloudflareDataStore(store).read(uid,['nalu-task-notifications'])).values['nalu-task-notifications'] as any
  if(value?.phoneQuestions!==true)return none('Phone questions are disabled.')
  if(!phoneConfigured())return none('Phone service is not configured.')
  const to=normalizePhone(await new CloudflareMessages(store).phone(uid))
  if(!to)return none('Save a profile phone number first.')
  const repo=new CloudflareQuestionPhone(store),question=await repo.claim(uid)
  if(!question)return none()
  const expires=String(Date.now()+30*60000),nonce=randomBytes(12).toString('hex'),id=String(question.id)
  const sig=sign(['task-question',uid,id,to,expires,nonce].join('|'))
  const result=await placeCall(to,`${publicBase()}/api/phone?${new URLSearchParams({step:'task-question',uid,questionId:id,to,expires,nonce,sig})}`)
  const saved=await repo.settled(uid,id,String(question.task_id),result)
  return res.status(200).json({ok:true,delivered:saved?.notification_status==='sent',...(saved?.notification_error?{errorDetail:saved.notification_error}:{})})
}
