import { CloudflareStore } from './_cloudflareStore'
import { CloudflareMessages } from './_cloudflareMessages'
import { CloudflarePhoneLease } from './_cloudflarePhoneLease'
import { processOneMessage } from './_messageWorker'
import { sendMessageOnce } from './_messageTransport'
import { deliverTaskCompletions } from './_taskCompletion'
import { ownsPhone } from './_phoneOwner'

export async function processCloudflareMessages(uid: string) {
  if(!ownsPhone(uid))return
  const store=new CloudflareStore(), repo=new CloudflareMessages(store), lease=new CloudflarePhoneLease(store,uid,'messages')
  let token:string|null=null
  const started=Date.now()
  const sendPending=async()=>{
    for(const row of await repo.list(uid,true)){
      if(Date.now()>started+275000 || !token || !await lease.valid(token)) break
      await sendMessageOnce(store,row)
    }
  }
  try {
    token=await lease.claim()
    if(!token)return
    await repo.recover(uid)
    for(let i=0;i<12 && Date.now()<started+170000;i++){
      const row=await repo.claimNext(uid,token)
      if(!row)break
      try { await processOneMessage(store,row); await repo.finish(uid,row.id,'done') }
      catch {
        await repo.finish(uid,row.id,'failed','Nalu could not finish this request. Check activity before retrying.')
        if(row.task_id) await repo.updateTask(uid,row.task_id,{status:'failed',detail:'Image creation could not be completed.',meta:{completedAt:new Date().toISOString()}})
        const target=row.direction==='inbound'?{channel:'text'}:row.task_id?(await repo.task(uid,row.task_id))?.meta?.delivery:null
        if(target?.channel==='text') await repo.save(uid,{requestId:'reply:'+row.id,direction:'outbound',from:process.env.TELNYX_PHONE_NUMBER||'',to:row.direction==='inbound'?row.from_number:row.to_number,text:'Nalu could not finish that request. Check task activity before retrying.',memberId:row.member_id,taskId:row.task_id}).catch(()=>{})
      }
      await sendPending()
    }
    await sendPending()
    if(Date.now()<started+240000)await deliverTaskCompletions(uid)
  } catch(error) { console.error('[messages] background processing failed:',error instanceof Error?error.name:'error') }
  finally { if(token)await lease.release(token).catch(()=>{}) }
}
