import { randomUUID } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'
import { shallowJsonMerge } from './_cloudflareJson'
import type { DeliveryState } from './_callDelivery'

export class CloudflareCallDelivery {
  constructor(readonly store: CloudflareStore) {}
  async claim(uid: string, id: string, taskId: string, state: DeliveryState) {
    const token=randomUUID()
    const result=await this.store.batch([
      {sql:'INSERT INTO nalu_call_deliveries(user_id,id,document,mutation_token) VALUES(?,?,?,?) ON CONFLICT(user_id,id) DO NOTHING RETURNING id',params:[uid,id,JSON.stringify({...state,status:'sending'}),token]},
      {sql:`INSERT INTO nalu_tasks(id,user_id,source,title,detail,status,progress,events,meta)
        SELECT ?1,?2,'mobile','Call follow-up','Preparing your confirmed call follow-up.','running',0,'[]',?3
        WHERE EXISTS(SELECT 1 FROM nalu_call_deliveries WHERE user_id=?2 AND id=?4 AND mutation_token=?5) ON CONFLICT(id) DO NOTHING`,params:[taskId,uid,JSON.stringify({kind:'call-delivery',result:state.content,destination:state.destination,deliveryStatus:'sending'}),id,token]},
    ])
    return !!result.results[0].results.length
  }
  async finish(uid: string, id: string, taskId: string, state: DeliveryState, status: string, detail: string) {
    await this.store.batch([
      {sql:'UPDATE nalu_call_deliveries SET document=? WHERE user_id=? AND id=?',params:[JSON.stringify({...state,status,detail}),uid,id]},
      {sql:`UPDATE nalu_tasks SET status=?1,detail=?2,progress=1,meta=${shallowJsonMerge('meta','?3')},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?4 AND user_id=?5`,params:[['saved','accepted','delivered','sent'].includes(status)?'done':'failed',detail,JSON.stringify({deliveryStatus:status}),taskId,uid]},
    ])
  }
}
