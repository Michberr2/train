import { deliverPushUpdates } from './_push'
import { getClient, ensureSchema, normalizePhone } from './_db'
import { ownsPhone } from './_phoneOwner'
import { listTeam } from './_team'
import { saveMessage } from './_messageStore'
import { sendMessageOnce } from './_messageTransport'
import { placeCall, publicBase, sign, forSpeech, phoneConfigured } from './_telephony'
import { cloudflareTaskCompletions } from './_cloudflareTaskCompletion'

export async function deliverTaskCompletions(uid: string) {
  await deliverPushUpdates(uid)
  if (!ownsPhone(uid)) return
  if(process.env.NALU_STORAGE_BACKEND==='cloudflare')return cloudflareTaskCompletions(uid)
  const c=getClient(); let locked=false
  try {
    await c.connect(); await ensureSchema(c)
    const prefs=(await c.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-task-notifications'",[uid])).rows[0]?.value||{}
    if (prefs.phoneUpdates!==true && prefs.messageUpdates!==true) return
    const to=normalizePhone((await c.query('SELECT phone FROM nalu_users WHERE id=$1',[uid])).rows[0]?.phone||'')
    if (!to) return
    locked=(await c.query("SELECT pg_try_advisory_lock(hashtext('nalu-completions:' || $1)) AS locked",[uid])).rows[0]?.locked===true
    if (!locked) return
    await c.query(`CREATE TABLE IF NOT EXISTS nalu_task_notifications (
      task_id TEXT NOT NULL REFERENCES nalu_tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL, status TEXT NOT NULL, carrier_id TEXT, error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(task_id,channel)
    );`)
    await c.query("UPDATE nalu_task_notifications SET status='uncertain',error='Notification was interrupted; check carrier logs.' WHERE user_id=$1 AND status='sending' AND created_at<NOW()-INTERVAL '6 minutes'",[uid])
    const members=await listTeam(c,uid)
    const deadline=Date.now()+25000
    for (const channel of ['phone','message']) {
      if (prefs[channel+'Updates']!==true || !prefs[channel+'UpdatesSince'] || (channel==='phone' && !phoneConfigured())) continue
      const since=new Date(prefs[channel+'UpdatesSince'])
      if (!Number.isFinite(since.getTime())) continue
      const tasks=(await c.query(`SELECT t.* FROM nalu_tasks t WHERE t.user_id=$1 AND t.status IN ('done','failed')
        AND t.meta->>'kind'=ANY($4::text[]) AND COALESCE(t.meta->>'completedAt',t.updated_at::text)::timestamptz>=$2::timestamptz
        AND NOT EXISTS(SELECT 1 FROM nalu_task_notifications n WHERE n.task_id=t.id AND n.channel=$3)
        ORDER BY t.updated_at LIMIT 20`,[uid,since.toISOString(),channel,channel==='phone'?['remote','image']:['remote']])).rows
      for (const task of tasks) {
        if (Date.now()>deadline) break
        const member=members.find(m=>m.active && m.id===task.meta?.memberId)||members[0]
        const state=task.status==='done'?'finished':'could not finish'
        const message=forSpeech(`${member.name} here, your ${member.role}. I ${state} ${task.title}. ${task.status==='done'?(task.meta?.result||'Open Nalu for the result.'):(task.detail||'Open Nalu to review what happened.')}`,500)
        if (channel==='message') {
          const row=await saveMessage(c,uid,{requestId:'completion:'+task.id,direction:'outbound',from:process.env.TELNYX_PHONE_NUMBER||'',to,text:message,memberId:member.id,taskId:task.id})
          await c.query("INSERT INTO nalu_task_notifications(task_id,user_id,channel,status) VALUES($1,$2,'message','queued') ON CONFLICT DO NOTHING",[task.id,uid])
          await sendMessageOnce(c,row)
          await c.query("UPDATE nalu_task_notifications SET status=(SELECT status FROM nalu_messages WHERE id=$2),updated_at=NOW() WHERE task_id=$1 AND channel='message'",[task.id,row.id])
          continue
        }
        // Claim before dialing. A carrier timeout must not trigger another call.
        const claim=await c.query("INSERT INTO nalu_task_notifications(task_id,user_id,channel,status) VALUES($1,$2,'phone','sending') ON CONFLICT DO NOTHING RETURNING task_id",[task.id,uid])
        if (!claim.rows.length) continue
        const expires=String(Date.now()+10*60000),sig=sign([uid,message,to,expires,member.id].join('|'))
        const url=`${publicBase()}/api/phone?${new URLSearchParams({step:'outbound',uid,msg:message,to,expires,sig,memberId:member.id})}`
        const result=await placeCall(to,url)
        await c.query("UPDATE nalu_task_notifications SET status=$2,carrier_id=$3,error=$4,updated_at=NOW() WHERE task_id=$1 AND channel='phone'",[task.id,result.ok?'accepted':'uncertain',result.sid||null,result.error||null])
      }
    }
  } catch (e) { console.error('[task-completion] notification failed:',e instanceof Error?e.name:'error') }
  finally { if(locked)await c.query("SELECT pg_advisory_unlock(hashtext('nalu-completions:' || $1))",[uid]).catch(()=>{});await c.end().catch(()=>{}) }
}
