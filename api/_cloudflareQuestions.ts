import { waitUntil } from '@vercel/functions'
import { deliverPushUpdates, pushConfigured } from './_push'
import { randomUUID } from 'node:crypto'
import { CloudflareStore, CloudflareConflict } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
import { deliverCloudflareQuestion } from './_cloudflareQuestionPhone'
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const question = (row: any) => ({ id:row.id,text:row.text,status:row.status,answer:row.answer })

export class CloudflareQuestions {
  constructor(readonly store: CloudflareStore) {}
  async answer(owner: string, taskId: string, questionId: string, answer: string, phone?:{sid:string;draft:string}) {
    if (!id(taskId)||!id(questionId)||typeof answer!=='string'||!answer.trim()||answer.length>16000) return {code:400,data:{error:'Task, question, and a non-empty answer of at most 16000 characters are required.'}}
    const mutation=randomUUID(), text=answer.trim()
    const saved=await this.store.batch([
      {sql:`UPDATE nalu_task_questions SET status='answered',answer=?4,answered_at=${now},mutation_token=?5 WHERE user_id=?1 AND task_id=?2 AND id=?3 AND status='pending'
        AND EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=?2 AND user_id=?1 AND status='running' AND julianday(lease_expires_at)>julianday('now'))
        ${phone?'AND call_sid=?6 AND phone_draft=?7':''}`,params:[owner,taskId,questionId,text,mutation,...(phone?[phone.sid,phone.draft]:[])]},
      {sql:`UPDATE nalu_tasks SET status='running',detail='Answer received; continuing work',meta=json_remove(meta,'$.pendingQuestion'),
        events=json_insert(events,'$[#]',json_object('t',${now},'m','Answer received; continuing the same task')),updated_at=${now}
        WHERE user_id=? AND id=? AND EXISTS(SELECT 1 FROM nalu_task_questions WHERE id=? AND mutation_token=?)`,params:[owner,taskId,questionId,mutation]},
      {sql:'SELECT q.* FROM nalu_task_questions q JOIN nalu_task_jobs j ON j.id=q.task_id AND j.user_id=q.user_id WHERE q.user_id=? AND q.task_id=? AND q.id=?',params:[owner,taskId,questionId]},
    ])
    const row=saved.results[2].results[0]
    if(!row)return {code:404,data:{error:'Question not found.'}}
    if(row.status==='answered'&&row.answer===text)return {code:200,data:{ok:true,questionId,status:'answered'}}
    return {code:409,data:{error:'This question is no longer awaiting an answer from an active worker.'}}
  }
  async preferences(owner: string, body: any) {
    for(const key of ['phoneQuestions','phoneUpdates','messageUpdates'])if(body[key]!==undefined&&typeof body[key]!=='boolean')throw new Error(key+' must be a boolean.')
    const docs=new CloudflareDataStore(this.store),key='nalu-task-notifications'
    for(let attempt=0;attempt<5;attempt++) {
      const saved=await docs.read(owner,[key]), value={...(saved.values[key]||{})}
      for(const field of ['phoneQuestions','phoneUpdates','messageUpdates']) {
        if(body[field]===undefined)continue
        if(field!=='phoneQuestions'&&body[field]&&value[field]!==true)value[field+'Since']=new Date().toISOString()
        value[field]=body[field]
      }
      try {
        if(['phoneQuestions','phoneUpdates','messageUpdates'].some(field=>body[field]!==undefined))await this.store.commitDocuments(owner,saved.revision,[{key,value:JSON.stringify(value)}])
        return {ok:true,phoneQuestions:value.phoneQuestions===true,phoneUpdates:value.phoneUpdates===true,messageUpdates:value.messageUpdates===true}
      }catch(error){if(!(error instanceof CloudflareConflict)||attempt===4)throw error}
    }
  }
  async handle(owner: string, body: any, res: any): Promise<boolean> {
    const action=body.action, fail=(message:string,status=400)=>{res.status(status).json({error:message});return true}
    if(!['task-ask','task-question-status','task-answer','task-questions','task-notification-preferences','task-notification-deliver'].includes(action))return false
    if(action==='task-notification-deliver'){await deliverCloudflareQuestion(this.store,owner,res);return true}
    if(action==='task-notification-preferences') {
      for(const key of ['phoneQuestions','phoneUpdates','messageUpdates'])if(body[key]!==undefined&&typeof body[key]!=='boolean')return fail(key+' must be a boolean.')
      res.status(200).json(await this.preferences(owner,body));return true
    }
    if(action==='task-answer') {const saved=await this.answer(owner,body.id,body.questionId,body.answer);res.status(saved.code).json(saved.data);return true}
    if(action==='task-questions') {
      const rows=(await this.store.query(`SELECT q.id,q.task_id AS taskId,q.text,q.status,t.title,json_extract(t.meta,'$.repo') AS repo
        FROM nalu_task_questions q JOIN nalu_task_jobs j ON j.id=q.task_id AND j.user_id=q.user_id JOIN nalu_tasks t ON t.id=q.task_id AND t.user_id=q.user_id
        WHERE q.user_id=? AND q.status='pending' AND j.status='running' AND julianday(j.lease_expires_at)>julianday('now') ORDER BY q.created_at`,[owner])).results
      res.status(200).json({ok:true,questions:rows});return true
    }
    if(!id(body.id)||!id(body.workerId)||!id(body.questionId)||typeof body.leaseToken!=='string'||!/^[a-f0-9]{64}$/.test(body.leaseToken))return fail('Task, worker, question ID, and lease token are required.')
    if(action==='task-question-status') {
      const row=(await this.store.query(`SELECT q.id,q.text,q.status,q.answer,j.status AS job_status,j.lease_expires_at
        FROM nalu_task_jobs j JOIN nalu_task_questions q ON q.task_id=j.id AND q.user_id=j.user_id
        WHERE j.id=? AND j.user_id=? AND j.worker_id=? AND j.lease_token=? AND q.id=?`,[body.id,owner,body.workerId,body.leaseToken,body.questionId])).results[0]
      if(!row||row.job_status!=='cancelled'&&(row.job_status!=='running'||Date.parse(String(row.lease_expires_at))<=Date.now()))return fail('The task lease is no longer active.',409)
      res.status(200).json({ok:true,question:question(row),cancelRequested:row.job_status==='cancelled'});return true
    }
    if(typeof body.question!=='string'||!body.question.trim()||body.question.length>2000)return fail('Question must contain 1–2000 characters.')
    const mutation=randomUUID(), text=body.question.trim(), jobGuard="EXISTS(SELECT 1 FROM nalu_task_jobs WHERE id=?2 AND user_id=?1 AND worker_id=?3 AND lease_token=?4 AND status='running' AND julianday(lease_expires_at)>julianday('now'))"
    const saved=await this.store.batch([
      {sql:`SELECT id FROM nalu_task_jobs WHERE id=? AND user_id=? AND worker_id=? AND lease_token=? AND status='running' AND julianday(lease_expires_at)>julianday('now')`,params:[body.id,owner,body.workerId,body.leaseToken]},
      {sql:`INSERT INTO nalu_task_questions(id,task_id,user_id,text,mutation_token) SELECT ?5,?2,?1,?6,?7 WHERE ${jobGuard}
        AND NOT EXISTS(SELECT 1 FROM nalu_task_questions WHERE task_id=?2 AND (id=?5 OR status='pending')) ON CONFLICT DO NOTHING`,params:[owner,body.id,body.workerId,body.leaseToken,body.questionId,text,mutation]},
      {sql:`UPDATE nalu_tasks SET status='waiting',detail='Waiting for your answer',meta=json_set(meta,'$.pendingQuestion',json_object('id',?3,'text',?4)),
        events=json_insert(events,'$[#]',json_object('t',${now},'m',?4)),updated_at=${now} WHERE id=?1 AND user_id=?2
        AND EXISTS(SELECT 1 FROM nalu_task_questions WHERE id=?3 AND mutation_token=?5)`,params:[body.id,owner,body.questionId,text,mutation]},
      {sql:'SELECT id,text,status,answer FROM nalu_task_questions WHERE user_id=? AND task_id=? AND id=?',params:[owner,body.id,body.questionId]},
    ])
    if(!saved.results[0].results.length)return fail('The task lease is no longer active.',409)
    const row=saved.results[3].results[0]
    if(!row||row.text!==text)return fail('Resolve the existing question before asking another.',409)
    if(pushConfigured())waitUntil(deliverPushUpdates(owner))
    res.status(200).json({ok:true,question:question(row)});return true
  }
}
