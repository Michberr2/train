import {ensureSchema} from './_db'
import {connectionBackend} from './_connectionBackend'
import type {ConnectionClient} from './_connectionStore'
import {CloudflareStore} from './_cloudflareStore'
import {listTeam} from './_team'
import {handleOutboundAction} from './_outboundCalls'
import {refineCallDraft as refine} from './_callDraft'
import {searchCallRecipients as search} from './_callSearch'
import {readLocation} from './_placeContext'
export type {CallDraft} from './_callDraft'
export type {CallRecipient} from './_callSearch'
export type {CallBrief as OutboundBrief} from './_outboundBrief'
import type {CallBrief} from './_outboundBrief'
import type {CallDraft} from './_callDraft'
import type {CallRecipient} from './_callSearch'
export type OutboundCall={id:string;brief:CallBrief;state:string;summary?:string}
async function db<T>(fn:(c:ConnectionClient)=>Promise<T>):Promise<T>{
 const backend=connectionBackend(),c=backend.client;try{await backend.connect();if(!(c instanceof CloudflareStore))await ensureSchema(c as any);return await fn(c)}finally{await backend.close().catch(()=>{})}
}
export const fetchMe=(uid:string)=>db(async c=>{
 const row=c instanceof CloudflareStore?(await c.query('SELECT id,display_name,phone FROM nalu_users WHERE id=?',[uid])).results[0]:(await c.query('SELECT id,display_name,phone FROM nalu_users WHERE id=$1',[uid])).rows[0]
 return row?{id:row.id,displayName:row.display_name,phone:row.phone}:null
})
export const fetchTeam=(uid:string)=>db(async c=>({members:await listTeam(c,uid)}))
export const searchCallRecipients=(uid:string,query:string,area:string)=>db(async c=>search(query,area,await readLocation(c,uid)))
export const refineCallDraft=(_uid:string,draft:CallDraft,utterance:string,matches:CallRecipient[])=>refine(draft,utterance,matches,draft.fields.timezone||'UTC')
async function action(uid:string,body:Record<string,unknown>):Promise<{call:OutboundCall}>{
 return db(async c=>{let data:any,code=200;await handleOutboundAction(c,uid,body,{status(n:number){code=n;return this},json(v:any){data=v}});if(code>=400||!data?.call)throw Error(data?.error||'Could not update the call.');return data})
}
export const prepareOutboundCall=(uid:string,brief:CallBrief,memberId:string,requestId:string)=>action(uid,{action:'recipient-prepare',brief,memberId,requestId})
export const startOutboundCall=(uid:string,id:string)=>action(uid,{action:'recipient-start',id,confirm:true})
export const cancelOutboundCall=(uid:string,id:string)=>action(uid,{action:'recipient-cancel',id})
