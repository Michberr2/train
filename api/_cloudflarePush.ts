import { createHash, randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { notificationPayload, pushConfigured, sendApplePush, validDevice } from './_push'
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

export class CloudflarePush {
  constructor(readonly store: CloudflareStore, readonly send = sendApplePush) {}
  private async claim(device: string, event: string, owner: string, retry: boolean) {
    const token=randomUUID()
    const saved=await this.store.batch([{sql:`INSERT INTO nalu_push_deliveries(device_id,event_id,status,claim_token)
      SELECT ?1,?2,'sending',?3 WHERE EXISTS(SELECT 1 FROM nalu_push_devices WHERE id=?1 AND user_id=?4 AND enabled=1)
      ON CONFLICT(device_id,event_id) DO UPDATE SET status='sending',claim_token=excluded.claim_token,attempts=nalu_push_deliveries.attempts+1,updated_at=${now}
      WHERE ?5=1 AND nalu_push_deliveries.status='retry' AND nalu_push_deliveries.attempts<5 AND julianday(nalu_push_deliveries.updated_at)<=julianday('now','-2 minutes') RETURNING device_id`,params:[device,event,token,owner,Number(retry)]}])
    return saved.results[0].results.length?token:null
  }
  private async settle(device: string, event: string, token: string, sent: {status:number;reason:string}) {
    const status=sent.status===200?'accepted':sent.status===0?'uncertain':sent.status===429||sent.status===403||sent.status>=500?'retry':'rejected'
    await this.store.batch([{sql:`UPDATE nalu_push_deliveries SET status=?,reason=?,updated_at=${now} WHERE device_id=? AND event_id=? AND claim_token=?`,params:[status,sent.reason,device,event,token]}])
  }
  async handle(owner: string, body: any, res: any): Promise<boolean> {
    const action=body.action
    if(!['push-status','push-register','push-unregister','push-test'].includes(action))return false
    if(action==='push-status') {
      const rows=(await this.store.query('SELECT environment,enabled,updated_at FROM nalu_push_devices WHERE user_id=?',[owner])).results
      res.status(200).json({ok:true,configured:pushConfigured(),devices:rows.map(row=>({...row,enabled:!!row.enabled}))});return true
    }
    if(!validDevice(body)){res.status(400).json({error:'Valid iPhone device token and push environment required.'});return true}
    const token=body.deviceToken.toLowerCase(), id=createHash('sha256').update(`${body.environment}:${token}`).digest('hex')
    if(action==='push-unregister')await this.store.batch([{sql:'DELETE FROM nalu_push_devices WHERE id=? AND user_id=?',params:[id,owner]}])
    else if(action==='push-register')await this.store.batch([{sql:`INSERT INTO nalu_push_devices(id,user_id,token,environment) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,enabled=1,
      enabled_since=CASE WHEN nalu_push_devices.user_id=excluded.user_id AND nalu_push_devices.enabled=1 THEN nalu_push_devices.enabled_since ELSE ${now} END,updated_at=${now}`,params:[id,owner,token,body.environment]}])
    else {
      const device=(await this.store.query('SELECT * FROM nalu_push_devices WHERE id=? AND user_id=? AND enabled=1',[id,owner])).results[0]
      if(!device){res.status(404).json({error:'Enable notifications on this device first.'});return true}
      if(!pushConfigured()){res.status(503).json({error:'Apple push credentials still need configuration.'});return true}
      const event=`test:${Math.floor(Date.now()/60000)}`, claim=await this.claim(id,event,owner,false)
      if(!claim){res.status(429).json({error:'Wait a minute before sending another test.'});return true}
      let sent
      try{sent=await this.send(device as any,event,{aps:{alert:{title:'Nalu',body:'Notifications are connected.'},sound:'default'},userId:owner,kind:'test'})}catch{sent={status:0,reason:'Apple connection failed.'}}
      await this.settle(id,event,claim,sent)
      res.status(sent.status===200?200:502).json({ok:sent.status===200,accepted:sent.status===200,error:sent.status===200?undefined:sent.reason||'Apple rejected the notification.'});return true
    }
    res.status(200).json({ok:true,configured:pushConfigured()});return true
  }
  async deliver(owner?: string) {
    await this.store.batch([{sql:`UPDATE nalu_push_deliveries SET status='uncertain',reason='Delivery acknowledgement was interrupted.' WHERE status='sending' AND julianday(updated_at)<julianday('now','-6 minutes')`}])
    const rows=(await this.store.query(`SELECT d.id AS device_id,d.token,d.environment,d.user_id,t.id AS task_id,t.status,
      CASE WHEN t.status='waiting' THEN 'question:'||json_extract(t.meta,'$.pendingQuestion.id') ELSE t.status END AS kind
      FROM nalu_push_devices d JOIN nalu_tasks t ON t.user_id=d.user_id
      WHERE d.enabled=1 AND julianday(d.updated_at)>julianday('now','-90 days') AND (?1 IS NULL OR d.user_id=?1)
        AND julianday(t.updated_at)>=julianday(d.enabled_since) AND julianday(t.updated_at)>julianday('now','-1 day')
        AND (t.status IN ('done','failed') OR (t.status='waiting' AND json_extract(t.meta,'$.pendingQuestion.id') IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM nalu_push_deliveries p WHERE p.device_id=d.id AND p.event_id=t.id||':'||CASE WHEN t.status='waiting' THEN 'question:'||json_extract(t.meta,'$.pendingQuestion.id') ELSE t.status END
          AND (p.status<>'retry' OR p.attempts>=5 OR julianday(p.updated_at)>julianday('now','-2 minutes')))
      ORDER BY t.updated_at LIMIT 50`,[owner||null])).results
    const deadline=Date.now()+40000
    for(const row of rows) {
      if(Date.now()>deadline)break
      if(String(row.kind).startsWith('question:')&&!(await this.store.query("SELECT id FROM nalu_tasks WHERE id=? AND user_id=? AND status='waiting' AND json_extract(meta,'$.pendingQuestion.id')=?",[String(row.task_id),String(row.user_id),String(row.kind).slice(9)])).results.length)continue
      const device=String(row.device_id),event=`${row.task_id}:${row.kind}`,claim=await this.claim(device,event,String(row.user_id),true)
      if(!claim)continue
      let sent
      try{sent=await this.send(row as any,event,notificationPayload(String(row.user_id),String(row.task_id),String(row.kind).startsWith('question:')?'question':String(row.status)))}catch{sent={status:0,reason:'Apple connection failed.'}}
      await this.settle(device,event,claim,sent)
      if(sent.status===410||['BadDeviceToken','DeviceTokenNotForTopic'].includes(sent.reason))await this.store.batch([{sql:'UPDATE nalu_push_devices SET enabled=0 WHERE id=? AND user_id=? AND token=?',params:[device,String(row.user_id),String(row.token)]}])
    }
  }
}
