import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const desktop=process.env.NALU_DESKTOP_TEST_ROOT||(process.env.NALU_REPOS_ROOT?path.join(process.env.NALU_REPOS_ROOT,'naludesktop'):null)||fileURLToPath(new URL('../../naludesktop/',import.meta.url))
const apiRoot=fileURLToPath(new URL('../api/',import.meta.url))
const load=async file=>{const bundle=await build({entryPoints:[file],bundle:true,write:false,platform:'node',format:'esm',packages:'external'});return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)}
const {validAgentProtocolArguments,agentProtocolActionSchema,AGENT_PROTOCOL_TOOLS}=await load(path.join(apiRoot,'_agentActionContract.ts'))
const {parseAgentReadOperation}=await load(path.join(desktop,'electron/agentTaskBroker.ts'))
const {parseAgentMutationOperation}=await load(path.join(desktop,'electron/agentTaskTools.ts'))
assert.equal(fs.readFileSync(path.join(apiRoot,'_agentActionContract.ts'),'utf8'),fs.readFileSync(path.join(desktop,'src/lib/agentActionContract.ts'),'utf8'),'The desktop mirror must match the shared v1 transport contract.')
const read=new Set(['read_file','list_dir','search','native_apps','native_observe','browser_snapshot'])
const fixtures={read_file:{path:'math.mjs'},list_dir:{path:'.'},search:{root:'.',query:'add'},write_file:{path:'new.mjs',content:''},edit_file:{path:'math.mjs',find:'a - b',replace:''},shell:{command:'node test.mjs'},native_apps:{},native_observe:{},native_focus:{bundleId:'app.fixture'},native_act:{action:{kind:'press_element',observationId:'current-native',elementId:'element-1'}},browser_snapshot:{},browser_open:{url:'fixture.test'},browser_click:{selector:'#save',observationId:'current-browser'},browser_fill:{selector:'#name',text:'',observationId:'current-browser'},browser_scroll:{x:-2000,y:2000,observationId:'current-browser'},browser_key:{key:'Enter',observationId:'current-browser'},browser_type:{text:'',observationId:'current-browser'}}
const schema=agentProtocolActionSchema()
assert.deepEqual([...AGENT_PROTOCOL_TOOLS].sort(),Object.keys(fixtures).sort());assert.equal(schema.anyOf.length,17)
for(const [tool,args] of Object.entries(fixtures)){
 assert.ok(validAgentProtocolArguments(tool,args),tool)
 assert.doesNotThrow(()=> (read.has(tool)?parseAgentReadOperation:parseAgentMutationOperation)({kind:tool,...args}),tool)
 assert.equal(validAgentProtocolArguments(tool,{...args,unexpected:true}),false,`${tool} extra field`)
 assert.equal(validAgentProtocolArguments(tool,[]),false,`${tool} wrong args type`)
 const variant=schema.anyOf.find(variant=>variant.properties.tool.enum[0]===tool)
 assert.equal(variant.additionalProperties,false);assert.deepEqual(variant.required,['tool','args'])
 const fields=variant.properties.args
 assert.equal(fields.additionalProperties,false);assert.ok(Object.hasOwn(fields,'properties'))
 for(const required of fields.required){
  const missing={...args};delete missing[required];assert.equal(validAgentProtocolArguments(tool,missing),false,`${tool} missing ${required}`)
  assert.equal(validAgentProtocolArguments(tool,{...args,[required]:null}),false,`${tool} null ${required}`)
 }
}
const native=[
 {kind:'press_element',elementId:'e',axAction:'AXPress'}, {kind:'set_value',elementId:'e',text:''},
 {kind:'click',x:0,y:1,button:'right',count:2}, {kind:'drag',x:1,y:2,toX:3,toY:4},
 {kind:'scroll',x:1,y:2,deltaX:-2000,deltaY:2000}, {kind:'type',text:''}, {kind:'key',combo:'CMD+S'},
]
for(const item of native){
 const action={observationId:'current-native',...item},args={action}
 assert.ok(validAgentProtocolArguments('native_act',args));assert.doesNotThrow(()=>parseAgentMutationOperation({kind:'native_act',...args}))
 for(const required of ['observationId',...Object.keys(item).filter(key=>!['axAction','button','count'].includes(key))]){
  const changed={...action};delete changed[required];assert.equal(validAgentProtocolArguments('native_act',{action:changed}),false,`${item.kind} missing ${required}`)
 }
}
for(const [tool,args] of [
 ['shell',{}],['shell',{command:'   '}],['shell',{command:'node test.mjs',timeoutMs:'5000'}],['shell',{command:'node test.mjs',timeoutMs:0}],['shell',{command:'node test.mjs',timeoutMs:300001}],['shell',{command:'node test.mjs',timeoutMs:1.5}],['shell',{command:'node test.mjs',cwd:null}],
 ['read_file',{path:'x\0y'}],['read_file',{path:'a'.repeat(4097)}],['search',{root:'.',query:'q'.repeat(2001)}],['write_file',{path:'x',content:'🦄'.repeat(32769)}],['edit_file',{path:'x',find:'',replace:'ok'}],
 ['native_observe',{displayId:''}],['native_focus',{bundleId:3}],['native_act',{action:{kind:'click',observationId:'o',x:0,y:0,count:3}}],['native_act',{action:{kind:'click',observationId:'o',x:-1,y:0}}],['native_act',{action:{kind:'scroll',observationId:'o',x:1,y:1,deltaX:2001,deltaY:0}}],['native_act',{action:{kind:'key',observationId:'o',combo:'x'.repeat(81)}}],
 ['browser_open',{url:'file:///tmp/private'}],['browser_open',{url:'https://user:secret@fixture.test'}],['browser_scroll',{x:2001,y:0,observationId:'o'}],['browser_click',{selector:'#x'}],['browser_fill',{selector:'#x',text:null,observationId:'o'}],
])assert.equal(validAgentProtocolArguments(tool,args),false,`${tool} ${JSON.stringify(args).slice(0,100)}`)
assert.ok(validAgentProtocolArguments('shell',{command:'node test.mjs',timeoutMs:300000,cwd:'.'}))
assert.ok(validAgentProtocolArguments('write_file',{path:'x',content:'🦄'.repeat(32768)}))
// IDs remain opaque proposals. Validation cannot certify that an old ID is fresh.
assert.ok(validAgentProtocolArguments('browser_key',{key:'Enter',observationId:'syntactically-valid-but-stale'}))
console.log('PASS: all17 tool and7 native argument contracts, generated field schemas, broker conformance, strict malformed-input rejection, byte bounds and desktop mirror parity')
