import { randomBytes } from 'node:crypto'
import { CloudflareStore } from './_cloudflareStore'

export class CloudflarePhoneState {
  constructor(readonly store: CloudflareStore) {}
  async read(uid:string,sid:string){
    const row=(await this.store.query('SELECT document FROM nalu_phone_states WHERE user_id=? AND sid=?',[uid,sid])).results[0]
    return row?JSON.parse(String(row.document)):null
  }
  async save(uid:string,sid:string,state:unknown){
    await this.store.batch([{sql:'INSERT INTO nalu_phone_states(user_id,sid,document) VALUES(?,?,?) ON CONFLICT(user_id,sid) DO UPDATE SET document=excluded.document',params:[uid,sid,JSON.stringify(state)]}])
  }
  async clear(uid:string,sid:string){
    await this.store.batch([
      {sql:"DELETE FROM nalu_sessions WHERE user_id=?1 AND token=(SELECT json_extract(document,'$.token') FROM nalu_phone_states WHERE user_id=?1 AND sid=?2)",params:[uid,sid]},
      {sql:'DELETE FROM nalu_phone_states WHERE user_id=? AND sid=?',params:[uid,sid]},
    ])
  }
  async mint(uid:string){
    const token=randomBytes(32).toString('hex')
    await this.store.batch([{sql:'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)',params:[token,uid]}])
    return token
  }
  async revoke(uid:string,token:string){
    await this.store.batch([{sql:'DELETE FROM nalu_sessions WHERE token=? AND user_id=?',params:[token,uid]}])
  }
}
