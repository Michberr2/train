import { CloudflareStore } from './_cloudflareStore'
import { CloudflareDataStore } from './_cloudflareDataStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { CloudflarePhoneLease } from './_cloudflarePhoneLease'
import { normalizePhone } from './_db'
import { listTeam } from './_team'
import { sendMessageOnce } from './_messageTransport'
import { placeCall, publicBase, sign, forSpeech, phoneConfigured } from './_telephony'

export async function cloudflareTaskCompletions(uid: string) {
  const store=new CloudflareStore(),repo=new CloudflareMessages(store),lease=new CloudflarePhoneLease(store,uid,'completions')
  let token:string|null=null
  try {
    const prefs=(await new CloudflareDataStore(store).read(uid,['nalu-task-notifications'])).values['nalu-task-notifications'] as any || {}
    if(prefs.phoneUpdates!==true && prefs.messageUpdates!==true)return
    const to=normalizePhone(await repo.phone(uid))
    if(!to)return
    token=await lease.claim()
    if(!token)return
    await store.batch([{sql:"UPDATE nalu_task_notifications SET status='uncertain',error='Notification was interrupted; check carrier logs.' WHERE user_id=? AND status='sending' AND julianday(created_at)<julianday('now','-6 minutes')",params:[uid]}])
    const members=await listTeam(store,uid),deadline=Date.now()+25000
    for(const channel of ['phone','message']){
      if(prefs[channel+'Updates']!==true || !prefs[channel+'UpdatesSince'] || (channel==='phone'&&!phoneConfigured()))continue
      const since=new Date(prefs[channel+'UpdatesSince'])
      if(!Number.isFinite(since.getTime()))continue
      const tasks=(await store.query(`SELECT t.* FROM nalu_tasks t WHERE t.user_id=?1 AND t.status IN ('done','failed')
        AND json_extract(t.meta,'$.kind') IN (SELECT value FROM json_each(?4))
        AND julianday(COALESCE(json_extract(t.meta,'$.completedAt'),t.updated_at))>=julianday(?2)
        AND NOT EXISTS(SELECT 1 FROM nalu_task_notifications n WHERE n.task_id=t.id AND n.channel=?3)
        ORDER BY t.updated_at LIMIT 20`,[uid,since.toISOString(),channel,JSON.stringify(channel==='phone'?['remote','image']:['remote'])])).results
      for(const task of tasks){
        if(Date.now()>deadline || !await lease.valid(token))break
        const meta=JSON.parse(String(task.meta||'{}')),member=members.find(m=>m.active&&m.id===meta.memberId)||members[0]
        const state=task.status==='done'?'finished':'could not finish'
        const message=forSpeech(`${member.name} here, your ${member.role}. I ${state} ${task.title}. ${task.status==='done'?(meta.result||'Open Nalu for the result.'):(task.detail||'Open Nalu to review what happened.')}`,500)
        const id=String(task.id)
        if(channel==='message'){
          const row=await repo.save(uid,{requestId:'completion:'+id,direction:'outbound',from:process.env.TELNYX_PHONE_NUMBER||'',to,text:message,memberId:member.id,taskId:id})
          await store.batch([{sql:"INSERT INTO nalu_task_notifications(task_id,user_id,channel,status) VALUES(?,?,'message','queued') ON CONFLICT DO NOTHING",params:[id,uid]}])
          await sendMessageOnce(store,row)
          await store.batch([{sql:"UPDATE nalu_task_notifications SET status=(SELECT status FROM nalu_messages WHERE id=?2 AND user_id=?3),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=?1 AND user_id=?3 AND channel='message'",params:[id,row.id,uid]}])
          continue
        }
        const claim=await store.batch([{sql:"INSERT INTO nalu_task_notifications(task_id,user_id,channel,status) VALUES(?,?,'phone','sending') ON CONFLICT DO NOTHING RETURNING task_id",params:[id,uid]}])
        if(!claim.results[0].results.length)continue
        const expires=String(Date.now()+10*60000),sig=sign([uid,message,to,expires,member.id].join('|'))
        const result=await placeCall(to,`${publicBase()}/api/phone?${new URLSearchParams({step:'outbound',uid,msg:message,to,expires,sig,memberId:member.id})}`)
        await store.batch([{sql:"UPDATE nalu_task_notifications SET status=?,carrier_id=?,error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND user_id=? AND channel='phone'",params:[result.ok?'accepted':'uncertain',result.sid||null,result.error||null,id,uid]}])
      }
    }
  } catch(error) { console.error('[task-completion] notification failed:',error instanceof Error?error.name:'error') }
  finally { if(token)await lease.release(token).catch(()=>{}) }
}
