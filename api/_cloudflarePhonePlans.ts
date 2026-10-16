import { CloudflareStore } from './_cloudflareStore'
import type { PlanSnapshot } from './_phonePlans'
import type { CallDraft } from './_callDraft'
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const decode=(row:any)=>row?{...row,input:JSON.parse(row.input),snapshot:row.snapshot?JSON.parse(row.snapshot):null}:null

export class CloudflarePhonePlans {
  constructor(readonly store: CloudflareStore) {}
  async latest(uid:string,sid:string):Promise<PlanSnapshot|null>{
    const row=(await this.store.query('SELECT snapshot FROM nalu_phone_plan_turns WHERE user_id=? AND sid=? ORDER BY created_at DESC,id DESC LIMIT 1',[uid,sid])).results[0]
    return row?.snapshot?JSON.parse(String(row.snapshot)):null
  }
  async enqueue(uid:string,sid:string,id:string,utterance:string,draft?:CallDraft){
    const result=await this.store.batch([
      {sql:`INSERT INTO nalu_phone_plan_turns(id,user_id,sid,input,snapshot)
        SELECT ?1,?2,?3,?4,(SELECT snapshot FROM nalu_phone_plan_turns WHERE user_id=?2 AND sid=?3 ORDER BY created_at DESC,id DESC LIMIT 1)
        WHERE NOT EXISTS(SELECT 1 FROM nalu_phone_plan_turns WHERE user_id=?2 AND sid=?3 AND status IN ('queued','working')) ON CONFLICT DO NOTHING`,params:[id,uid,sid,JSON.stringify({utterance,draft})]},
      {sql:"SELECT id FROM nalu_phone_plan_turns WHERE user_id=?1 AND sid=?2 AND (id=?3 OR status IN ('queued','working')) ORDER BY CASE WHEN id=?3 THEN 0 ELSE 1 END,created_at DESC LIMIT 1",params:[uid,sid,id]},
    ])
    const row=result.results[1].results[0]
    if(!row)throw new Error('The call plan could not be queued.')
    return String(row.id)
  }
  async claim(uid:string,id:string){
    return decode((await this.store.batch([{sql:`UPDATE nalu_phone_plan_turns SET status='working',updated_at=${now} WHERE user_id=? AND id=? AND status='queued' RETURNING *`,params:[uid,id]}])).results[0].results[0])
  }
  async finish(uid:string,id:string,status:'done'|'failed',snapshot:PlanSnapshot,reply:string){
    await this.store.batch([{sql:`UPDATE nalu_phone_plan_turns SET status=?,snapshot=?,reply=?,updated_at=${now} WHERE user_id=? AND id=? AND status='working'`,params:[status,JSON.stringify(snapshot),reply,uid,id]}])
  }
  async result(uid:string,sid:string,id:string){
    return (await this.store.query('SELECT status,reply,updated_at FROM nalu_phone_plan_turns WHERE id=? AND user_id=? AND sid=?',[id,uid,sid])).results[0]
  }
}
