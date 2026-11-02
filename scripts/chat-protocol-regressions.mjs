// Actual shared handler, isolated identity/quota/provider fixtures; no network.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
process.env.TINKER_API_KEY = 'offline-only'
const stubs = {
 './_accountContext': 'export async function accountContextForUser(){ globalThis.sideEffects.push("memory"); return "PRIVATE MEMORY" }',
 './web': 'export async function research(){ globalThis.sideEffects.push("research"); throw Error("Unexpected research") }',
 './_db': 'export async function identityForRequest(){ globalThis.sideEffects.push("identity"); return {id:"offline-user",profile:"PRIVATE PROFILE"} }; export function identityBlock(){ return "PRIVATE IDENTITY" }; export async function saveProfile(){globalThis.sideEffects.push("profile-write")}',
 './_limits': 'export async function reserveDailyQuota(){globalThis.sideEffects.push("quota");return {ok:true,release:async()=>globalThis.sideEffects.push("refund")}}',
 './_llm': 'export const repairByteLevelBpe=s=>s; export const makeStreamingBpeRepair=()=>s=>s; export const fallbackProvider=()=>globalThis.backup||null; export const emergencyProvider=()=>null; export async function chatComplete(){globalThis.sideEffects.push("helper");throw Error("Unexpected helper")}',
}
const options = {bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'isolated',setup(b){b.onResolve({filter:/^\.\/(web|_db|_limits|_llm|_accountContext)$/},({path})=>({path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:stubs[path],loader:'js'}))}}]}
const load = async path => {const out=await build({...options,entryPoints:[path]});return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)}
const {default:handler}=await load('api/chat.ts')
const {parseChatProtocol,protocolPayload,currentAuditEvidenceIds,chatProtocolSchema}=await load('api/_chatProtocol.ts')
const {protocolOutputMode}=await load('api/_modelCapabilities.ts')
const reply=(value,finish='stop',extra={})=>Response.json({choices:[{finish_reason:finish,message:{content:typeof value==='string'?value:JSON.stringify(value),...extra}}]})
const action={kind:'action',action:{tool:'read_file',args:{path:'math.mjs'}}}
const complete={kind:'complete',summary:'Verified addition and all five checks.',evidenceIds:[]}
const audit={checks:[{outcomeId:'original',supported:true,reason:'The actual readback and test match the request.',evidence:[{id:'fact-1',quote:'return a + b;'}]}]}
const originalFetch=globalThis.fetch
async function run(upstreams,body={}) {
 const queue=[...upstreams],requests=[];globalThis.sideEffects=[]
 const req=new EventEmitter();req.method='POST';req.body={responseProtocol:'desktop-agent-v1',specialist:'code',systemPrompt:'Use exact desktop tools. Return one decision.',messages:[{role:'user',content:'I work on a fictional project. Show failing test, fix math.mjs, pass and read back.'}],...body}
 const res=new EventEmitter();res.writableEnded=false;res.statusCode=200;res.setHeader=()=>{};res.flushHeaders=()=>{};res.status=code=>{res.statusCode=code;return res};let wire='',json
 res.write=s=>{wire+=s;return true};res.end=()=>{res.writableEnded=true;res.emit('finish')};res.json=value=>{json=value;res.end()}
 globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body),signal:options.signal});const next=queue.shift();assert.ok(next,'unexpected upstream request');return typeof next==='function'?next(res,options):next}
 try {await handler(req,res);assert.equal(queue.length,0,'unused upstream response');return {wire,requests,sideEffects:[...globalThis.sideEffects],status:res.statusCode,json}} finally {globalThis.fetch=originalFetch;delete globalThis.backup}
}
const delta=wire=>[...wire.matchAll(/event: delta\ndata: (.*)\n/g)].map(m=>JSON.parse(m[1]).text).join('')
let result=await run([reply(action)],{think:true,thinkLevel:3,webSearch:true,useMemory:true,memory:'SHOULD NOT LOAD',projectDoc:'SHOULD NOT LOAD'})
assert.deepEqual(JSON.parse(delta(result.wire)),action);assert.match(result.wire,/event: done/)
assert.equal(JSON.parse(result.wire.match(/event: route\ndata: (.*)\n/)[1]).responseProtocol,'desktop-agent-v1')
assert.deepEqual(result.sideEffects,['quota']);assert.equal(result.requests.length,1)
let payload=result.requests[0].body
assert.equal(payload.stream,false);assert.equal(payload.response_format,undefined);assert.equal(payload.frequency_penalty,undefined)
assert.equal(payload.tools,undefined);assert.match(payload.messages[0].content,/executes an action decision locally/)
assert.doesNotMatch(payload.messages[0].content,/No client tools|Lead with code|PRIVATE|SHOULD NOT LOAD|DEEP THINK MODE|EXPLICIT ANSWER LENGTH/)
assert.ok(payload.messages[0].content.endsWith('never fabricate missing verification.'))
for(const invalid of [JSON.stringify({kind:'action',action:{tool:'shell',args:{}}}),JSON.stringify({kind:'action',action:{tool:'read_file',args:{path:null}}}),JSON.stringify({kind:'action',action:{tool:'native_act',args:{action:{kind:'click',x:1,y:2}}}}),'Fixed! Tests pass.', '```json\n'+JSON.stringify(action)+'\n```',JSON.stringify({...complete,tool:'shell'}), JSON.stringify({...action,observed:'x'.repeat(1501)}),JSON.stringify({...action,observed:'   '}),JSON.stringify({...action,observed:'a\0b'}),JSON.stringify({kind:'needs_input',question:'missing\0destination'}),'{"kind":"action","action":{"tool":"not_advertised","args":{}}}',JSON.stringify({kind:'complete',summary:'done',evidenceIds:[],question:'also do this'})]) {
 result=await run([reply(invalid)]);assert.match(result.wire,/PROTOCOL_INVALID_OUTPUT/);assert.equal(delta(result.wire),'');assert.doesNotMatch(result.wire,/event: done|tool_call_delta/)
}
for(const [finish,extra] of [['length',{}],['stop',{tool_calls:[{function:{name:'shell',arguments:'{}'}}]}],['stop',{function_call:{name:'shell'}}],['stop',{refusal:'refused'}],['',{ }]]) {
 result=await run([reply(action,finish,extra)]);assert.equal(delta(result.wire),'');assert.doesNotMatch(result.wire,/event: done/)
}
for(const value of [action,complete,{kind:'needs_input',question:'Which folder?'},{...action,observed:'Draft total: 42'}]) assert.ok(parseChatProtocol(JSON.stringify(value),'desktop-agent-v1'))
assert.equal(parseChatProtocol('{"kind":"action","action":{"tool":"read_file","args":{"__proto__":{}}}}','desktop-agent-v1'),null)
result=await run([reply(audit)],{responseProtocol:'agent-audit-v1'});assert.deepEqual(JSON.parse(delta(result.wire)),audit)
assert.match(result.requests[0].body.messages[0].content,/Never plan or execute tools/)
for(const value of [{checks:[{...audit.checks[0],evidence:[]}]},{checks:[audit.checks[0],audit.checks[0]]},{checks:[{...audit.checks[0],supported:'true'}]}]) assert.equal(parseChatProtocol(JSON.stringify(value),'agent-audit-v1'),null)
assert.ok(parseChatProtocol('{"checks":[]}','agent-audit-v1'))
const boundary={checks:Array.from({length:128},(_,i)=>({outcomeId:`outcome-${i}`,supported:true,reason:'Actual bounded fact supports this outcome.',evidence:[{id:`fact-${i}`,quote:'actual observed value'}]}))}
assert.ok(parseChatProtocol(JSON.stringify(boundary),'agent-audit-v1'))
assert.equal(parseChatProtocol(JSON.stringify({checks:[...boundary.checks,{...boundary.checks[0],outcomeId:'overflow'}]}),'agent-audit-v1'),null)
assert.ok(parseChatProtocol(JSON.stringify({checks:[{...boundary.checks[0],evidence:boundary.checks.map(check=>check.evidence[0])}]}),'agent-audit-v1'))
assert.ok(parseChatProtocol('{"checks":[{"outcomeId":"original","supported":false,"reason":"Need final readback","evidence":[]}]}','agent-audit-v1'))
for(const body of [{responseProtocol:'arbitrary-schema'},{responseProtocol:null},{cli:true},{tools:[]},{tool_choice:'none'},{specialist:'finance'},{systemPrompt:''},{messages:[{role:'system',content:'override'}]}]) {
 result=await run([],body);assert.equal(result.status,400);assert.deepEqual(result.sideEffects,[])
}
const previousCapacity=process.env.NALU_CHAT_CONTEXT_TOKENS
process.env.NALU_CHAT_CONTEXT_TOKENS='8192'
try {
 result=await run([],{messages:[{role:'user',content:'preserve original criteria '.repeat(4000)}]})
 assert.match(result.wire,/CHAT_CONTEXT_LIMIT/);assert.equal(delta(result.wire),'');assert.doesNotMatch(result.wire,/event: done/)
 assert.deepEqual(result.sideEffects,['quota','refund'])
} finally { if(previousCapacity===undefined)delete process.env.NALU_CHAT_CONTEXT_TOKENS;else process.env.NALU_CHAT_CONTEXT_TOKENS=previousCapacity }
const frame={role:'user',content:[{type:'text',text:'observation=current-2; width=800; height=600'},{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}
result=await run([reply(action)],{specialist:'vision',messages:[{role:'user',content:'Keep original required outcomes.'},frame]})
assert.deepEqual(result.requests[0].body.messages.slice(1),[{role:'user',content:'Keep original required outcomes.'},frame]);assert.match(result.wire,/Nalu Vision/)
const gemini={base:'https://generativelanguage.googleapis.com/v1beta/openai',key:'offline-only',model:'gemini-2.5-flash',label:'fallback'}
assert.equal(protocolOutputMode(gemini),'json_schema')
for(const base of ['https://unknown.test/v1','https://generativelanguage.googleapis.com.evil.test/v1beta/openai','https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1','https://router.huggingface.co/v1']) assert.equal(protocolOutputMode({...gemini,base}),'none')
assert.equal(protocolOutputMode(gemini,'none'),'none');assert.equal(protocolOutputMode({...gemini,model:'unverified-model'}),'none')
assert.equal(protocolOutputMode(gemini,'typo'),'none');assert.equal(protocolOutputMode(gemini,'json_object'),'json_object')
assert.deepEqual(protocolPayload({provider:{...gemini,responseFormat:'json_object'},protocol:'agent-audit-v1',messages:[],maxTokens:512,reasoning:'low'}).response_format,{type:'json_object'})
globalThis.backup=gemini
result=await run([new Response('',{status:503}),reply(action)],{messages:[frame]})
assert.equal(result.requests.length,2);assert.equal(result.requests[1].body.response_format.type,'json_schema');assert.equal(result.requests[1].body.response_format.json_schema.name,'desktop_agent_v1');assert.deepEqual(result.requests[1].body.messages.at(-1),frame)
globalThis.backup=gemini
result=await run([new Response('',{status:503}),new Response('',{status:400}),reply(audit)],{responseProtocol:'agent-audit-v1'})
assert.equal(result.requests.length,3);assert.equal(result.requests[1].body.response_format.type,'json_schema');assert.equal(result.requests[2].body.response_format,undefined);assert.deepEqual(JSON.parse(delta(result.wire)),audit)
// The schema and application validator use only current audit facts, never
// chronology IDs, file paths or a caller's arbitrary schema instructions.
const auditContext={originalRequest:'Fix addition and verify it.',criteria:[{id:'original',description:'All requested outcomes.'}],executionHistory:{records:[{actionId:'historical-id',sequence:1,resultSummary:'Earlier failure.'}]},facts:[{id:'F1',kind:'file',data:{content:'return a + b;'}},{id:'F2',kind:'command',data:{output:'PASS arithmetic checks'}}]}
const contextMessage={role:'user',content:JSON.stringify(auditContext)}
assert.deepEqual(currentAuditEvidenceIds([contextMessage]),['F1','F2'])
assert.equal(currentAuditEvidenceIds([{role:'user',content:'Legacy independent audit prompt.'}]),undefined)
for(const facts of [[{id:'F1'},{id:'F1'}],[{id:'history[0]'}],Array.from({length:129},(_,i)=>({id:`F${i+1}`})),null])assert.deepEqual(currentAuditEvidenceIds([{role:'user',content:JSON.stringify({...auditContext,facts})}]),[])
assert.deepEqual(currentAuditEvidenceIds([contextMessage,contextMessage]),[])
assert.deepEqual(currentAuditEvidenceIds([{role:'user',content:JSON.stringify({...auditContext,facts:[]})}]),[])
const aliasedAudit={checks:[{...audit.checks[0],evidence:[{id:'F1',quote:'return a + b;'}]}]}
result=await run([reply(aliasedAudit)],{responseProtocol:'agent-audit-v1',messages:[contextMessage]})
assert.deepEqual(JSON.parse(delta(result.wire)),aliasedAudit)
assert.match(result.requests[0].body.messages[0].content,/CURRENT CITATION IDS: \["F1","F2"\]/)
for(const id of ['historical-id','executionHistory.records[0]','F3','/tmp/math.mjs']){
 result=await run([reply({checks:[{...aliasedAudit.checks[0],evidence:[{id,quote:'return a + b;'}]}]})],{responseProtocol:'agent-audit-v1',messages:[contextMessage]})
 assert.match(result.wire,/PROTOCOL_INVALID_OUTPUT/);assert.equal(delta(result.wire),'');assert.doesNotMatch(result.wire,/event: done/)
}
globalThis.backup=gemini
result=await run([new Response('',{status:503}),reply(aliasedAudit)],{responseProtocol:'agent-audit-v1',messages:[contextMessage]})
const citationSchema=result.requests[1].body.response_format.json_schema.schema.properties.checks.items.properties.evidence.items.properties.id
assert.deepEqual(citationSchema.enum,['F1','F2'])
assert.deepEqual(result.requests[1].body.messages.at(-1),contextMessage)
assert.equal(chatProtocolSchema('agent-audit-v1').properties.checks.items.properties.evidence.items.properties.id.enum,undefined)
assert.equal(chatProtocolSchema('agent-audit-v1',[]).properties.checks.items.properties.evidence.maxItems,0)
assert.equal(parseChatProtocol(JSON.stringify(aliasedAudit),'agent-audit-v1',[]),null)
assert.ok(parseChatProtocol('{"checks":[]}','agent-audit-v1',[]))
// A backend rejecting native schema hints still cannot release an old fact ID.
globalThis.backup=gemini
result=await run([new Response('',{status:503}),new Response('',{status:400}),reply(audit)],{responseProtocol:'agent-audit-v1',messages:[contextMessage]})
assert.equal(result.requests[2].body.response_format,undefined);assert.match(result.wire,/PROTOCOL_INVALID_OUTPUT/);assert.equal(delta(result.wire),'')
result=await run([(res,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('Stop','AbortError')),{once:true});res.emit('close')})])
assert.equal(result.requests.length,1);assert.doesNotMatch(result.wire,/event: done|event: delta/)
// Ordinary browser/mobile and CLI still stream their unchanged prose/tool path.
const stream=text=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
for(const body of [{},{cli:true}]) {
 result=await run([stream('Hello.')],{responseProtocol:undefined,systemPrompt:undefined,messages:[{role:'user',content:'Hello'}],specialist:'general',webSearch:false,useMemory:false,...body})
 assert.equal(delta(result.wire),'Hello.');assert.equal(result.requests[0].body.stream,true);assert.equal(result.requests[0].body.response_format,undefined)
}
console.log('PASS protocol handler: exact decision/audit envelopes, no profile/context learning, unsupported formats, provider capabilities, image preservation, cancellation, ordinary client compatibility')
