// Mirrored from nalumobile/src/callConversation.ts; keep behavior synchronized.
import { cancelOutboundCall, fetchMe, fetchTeam, prepareOutboundCall, refineCallDraft, searchCallRecipients, startOutboundCall, type CallDraft, type CallRecipient, type OutboundBrief, type OutboundCall } from './_phonePlanApi'

const CONFIRM = /^(?:(?:yes|yeah|yep|okay|ok|sure)[, ]*)?(?:go ahead(?: and call(?: them)?)?|call (?:now|them)|make the call|place the call|that(?:'s| is) correct|yes|yeah|yep|okay|ok|sure)[.! ]*$/i
const CANCEL = /^(?:cancel(?: (?:it|that|the call))?|never ?mind|stop|don['’]t call(?: them)?|do not call(?: them)?)[.! ]*$/i
export function missingCallDetail(draft: CallDraft): string {
  const f=draft.fields
  if(!f.to) return 'What number should I call, including the country code?'
  if(!f.recipient) return 'Who am I calling?'
  if(!f.onBehalfOf) return 'Whose name should I give when I call?'
  if(!f.purpose) return 'What would you like me to ask them?'
  if(draft.kind==='reservation') {
    if(!f.date) return 'What date would you like the reservation?'
    if(!f.time) return 'What time, and is that morning or evening?'
    if(!f.timezone) return 'What time zone is the reservation in?'
    if(!f.partySize) return 'How many people is it for?'
    if(!f.bookingName) return 'What name should the reservation be under?'
    if(!f.contact) return 'What contact number should I give them, including the country code?'
  }
  return ''
}
export function draftBrief(draft: CallDraft): OutboundBrief {
  const f=draft.fields
  return {kind:draft.kind,to:f.to||'',recipient:f.recipient||'',onBehalfOf:f.onBehalfOf||'',purpose:f.purpose||'',facts:f.facts||'',questions:f.questions||'',alternatives:f.alternatives||'',...(draft.kind==='reservation'?{reservation:{date:f.date,time:f.time,timezone:f.timezone,partySize:Number(f.partySize),name:f.bookingName,contact:f.contact}}:{})}
}
export type CallConversationReply={reply:string;unrelated?:boolean;sources?:{title:string;url:string}[];searchHtml?:string}
const dependencies={cancelOutboundCall,fetchMe,fetchTeam,prepareOutboundCall,refineCallDraft,searchCallRecipients,startOutboundCall}

// A voice session owns exactly one review at a time. A correction invalidates
// that review. A dial attempt consumes it before the network request, so an
// interrupted or uncertain response cannot turn a repeated "yes" into a redial.
export class CallConversation {
  draft: CallDraft | null = null
  matches: CallRecipient[] = []
  private choices: CallRecipient[] = []
  selected: CallRecipient | null = null
  review: OutboundCall | null = null
  active = false
  private busy = false
  private requestId = ''
  private fingerprint = ''
  constructor(private token: string, private api=dependencies) {}
  snapshot() {
    return {draft:this.draft,matches:this.matches,choices:this.choices,selected:this.selected,review:this.review,active:this.active,requestId:this.requestId,fingerprint:this.fingerprint}
  }
  restore(state:ReturnType<CallConversation['snapshot']>) {
    this.draft=state.draft;this.matches=state.matches;this.choices=state.choices;this.selected=state.selected;this.review=state.review;this.active=state.active;this.requestId=state.requestId;this.fingerprint=state.fingerprint
  }
  async begin(draft:CallDraft,signal?:AbortSignal):Promise<CallConversationReply> {
    if(this.busy)return {reply:"One moment—I’m still working on that call."}
    this.busy=true
    try {
    this.draft=draft;this.active=true;this.matches=[];this.choices=[];this.selected=null;this.review=null
    return await this.advance(signal)
    }finally{this.busy=false}
  }
  async respond(utterance:string,signal?:AbortSignal):Promise<CallConversationReply> {
    if(this.busy) return {reply:"One moment—I’m still working on that call."}
    if(!this.active||!this.draft) return {reply:'',unrelated:true}
    if(signal?.aborted) return {reply:''}
    this.busy=true
    try {
      if(CANCEL.test(utterance.trim()))return await this.cancel()
      if(this.review && CONFIRM.test(utterance.trim())) {
        return await this.dial(signal)
      }
      const change=await this.api.refineCallDraft(this.token,this.draft,utterance,this.choices)
      if(signal?.aborted)return {reply:''}
      if(change.intent==='cancel')return await this.cancel()
      if(change.intent==='unrelated'){await this.cancel();return {reply:'',unrelated:true}}
      if(this.review){await this.api.cancelOutboundCall(this.token,this.review.id);this.review=null}
      const prior=this.draft
      this.draft=change.draft
      if(change.intent==='select') {
        const selected=this.choices[change.selection]
        if(!selected)return {reply:'Which place would you like—the first, second, or a different search?'}
        this.select(selected)
      }else if(this.draft.query!==prior.query||this.draft.area!==prior.area||this.draft.fields.to!==prior.fields.to){this.selected=null;this.matches=[];this.choices=[]}
      return await this.advance(signal)
    }finally{this.busy=false}
  }
  private async dial(signal?:AbortSignal):Promise<CallConversationReply>{
    if(signal?.aborted)return {reply:''}
    const review=this.review!
    this.review=null;this.active=false
    try {
      const {call}=await this.api.startOutboundCall(this.token,review.id)
      return {reply:call.state==='uncertain'?'I couldn’t confirm whether the call started. Check Recent calls before trying again.':['dialing','ringing','active'].includes(call.state)?`I’m calling ${call.brief.recipient}. I’ll put the result in Recent calls.`:call.summary||`The call is ${call.state.replace(/_/g,' ')}. Check Recent calls for details.`}
    }catch{return {reply:'I couldn’t confirm whether the call started. Check Recent calls before trying again.'}}
  }
  private select(match:CallRecipient){
    this.selected=match;this.matches=[]
    if(this.draft)this.draft={...this.draft,query:'',fields:{...this.draft.fields,recipient:match.name,to:match.phone}}
  }
  private async cancel():Promise<CallConversationReply>{
    if(this.review)await this.api.cancelOutboundCall(this.token,this.review.id)
    this.review=null;this.active=false
    return {reply:'Canceled. I haven’t placed the call.'}
  }
  private async advance(signal?:AbortSignal):Promise<CallConversationReply>{
    const draft=this.draft!
    if(signal?.aborted)return {reply:''}
    let searchHtml:string|undefined
    let found=false
    if(draft.useProfile){
      const profile=await this.api.fetchMe(this.token)
      if(signal?.aborted)return {reply:''}
      if(profile){
        const f=draft.fields
        if(!f.onBehalfOf && profile.displayName)f.onBehalfOf=profile.displayName
        if(draft.kind==='reservation'){
          if(!f.bookingName && profile.displayName)f.bookingName=profile.displayName
          if(!f.contact && profile.phone && /^\+[1-9]\d{7,14}$/.test(profile.phone))f.contact=profile.phone
        }
      }
    }
    if(draft.query&&!draft.fields.to&&!this.matches.length){
      const result=await this.api.searchCallRecipients(this.token,draft.query,draft.area)
      if(signal?.aborted)return {reply:''}
      this.matches=result.places;this.choices=result.places;searchHtml=result.searchHtml
      if(!this.matches.length)return {reply:result.message,searchHtml}
      if(this.matches.length===1||draft.execution==='automatic'){this.select(this.matches[0]);found=true}
    }
    if(this.matches.length)return {reply:this.matches.map((m,i)=>`${i+1}: ${m.name}, ${m.address}. ${m.reason}`).join(' ')+' Which would you like me to call?',sources:this.matches.flatMap(m=>m.sources),searchHtml}
    const question=missingCallDetail(this.draft!)
    if(question)return {reply:(found && this.selected?`I found ${this.selected.name} at ${this.selected.address}. `:'')+question,sources:this.selected?.sources,searchHtml}
    const {members}=await this.api.fetchTeam(this.token)
    if(signal?.aborted)return {reply:''}
    const member=members.find(m=>m.active)
    if(!member)throw Error('Choose an active teammate before placing a call.')
    const brief=draftBrief(this.draft!)
    const fingerprint=JSON.stringify({brief,member:member.id})
    if(fingerprint!==this.fingerprint){this.fingerprint=fingerprint;this.requestId=`voice-call-${Date.now()}-${Math.random().toString(36).slice(2)}`}
    const {call}=await this.api.prepareOutboundCall(this.token,brief,member.id,this.requestId)
    if(signal?.aborted)return {reply:''}
    if(call.state!=='prepared')throw Error('That call is already in Recent calls. Check its status before starting another.')
    this.review=call
    if(this.draft!.execution==='automatic'){
      const result=await this.dial(signal)
      return {...result,sources:this.selected?.sources,searchHtml}
    }
    const r=brief.reservation
    const when=r?new Date(r.date+'T'+r.time+':00Z'):null
    const day=when?new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}).format(when):''
    const time=when?new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'UTC'}).format(when):''
    const details=r?`Reserve ${day} at ${time}, ${r.timezone.split('/').pop()?.replace(/_/g,' ')} time, for ${r.partySize}, under ${r.name}. Contact number ${r.contact}.`:brief.purpose
    return {reply:`I’ll call ${brief.recipient}${this.selected?' at '+this.selected.address:''}, ${brief.to}, on behalf of ${brief.onBehalfOf}. ${details}${r?' '+brief.purpose:''}${brief.facts?' Details to share: '+brief.facts:''}${brief.questions?' I’ll ask: '+brief.questions:''}${brief.alternatives?' Allowed alternatives: '+brief.alternatives:''} Shall I place the call?`,sources:this.selected?.sources,searchHtml}
  }
}
