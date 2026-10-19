// Actual CAD endpoint with a virtual provider clock; no inference or network.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
const originalNow=Date.now
let state
const fixtures={
  './_llm':`export const providerChain=()=>[{label:'one'},{label:'two'},{label:'three'}];export async function chatCompleteContinued(messages,options){const s=globalThis.__cad;s.calls.push(options);s.time+=s.fail?options.timeoutMs*2:10;if(s.cancel)s.cancel();if(s.fail)throw Error('provider failed');return {content:'cube([10,20,30]);',finishReason:s.truncated?'length':'stop'}}`,
  './_limits':`export async function reserveStudioQuota(_req,kind){const s=globalThis.__cad;s.kind=kind;return {ok:!s.denied,status:s.denied,release:async()=>{s.refunds++}}};export const studioLimitMessage=()=>"Usage unavailable";`,
  './_publicFetch':`export async function publicFetch(){globalThis.__cad.references++;throw Error('offline source')}`,
}
const built=await build({entryPoints:['api/cad.ts'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',plugins:[{name:'cad-fixture',setup(b){b.onResolve({filter:/^\.\/(_llm|_limits|_publicFetch)$/},({path})=>({path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:fixtures[path],loader:'js'}))}}]})
const module={exports:{}}
new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
async function invoke(body,flags={}){
  state=globalThis.__cad={time:0,calls:[],references:0,refunds:0,...flags}
  const controller=new AbortController()
  if(flags.abort)state.cancel=()=>controller.abort()
  const req=Object.assign(new EventEmitter(),{method:'POST',headers:{},body,signal:controller.signal})
  const res=Object.assign(new EventEmitter(),{writableEnded:false,status(code){this.code=code;return this},setHeader(){},json(body){this.body=body;this.writableEnded=true;return this}})
  await module.exports.default(req,res)
  return res
}
try{
  Date.now=()=>state?.time || 0
  for(const body of [{prompt:'Create a box'},{prompt:'Fix the box',code:'cube(10)',error:'Missing semicolon'}]){
    const success=await invoke(body)
    assert.equal(success.code,200);assert.equal(success.body.quality.compilation,'pending-client');assert.equal(state.refunds,0)
    assert.equal(state.kind,body.code?'cad-repair':'cad','repair cannot bypass its own allowance')
    const failed=await invoke(body,{fail:true})
    assert.equal(failed.code,502);assert.equal(state.refunds,1);assert.ok(state.time<=255000)
    assert.ok(state.calls.every(c=>c.maxAttempts===1&&c.providers.length===1))
    const cutoff=await invoke(body,{truncated:true})
    assert.equal(cutoff.code,502);assert.equal(state.refunds,1,'truncated CAD is not a completed model')
  }
  const denied=await invoke({prompt:'Create a box'},{denied:503})
  assert.equal(denied.code,503);assert.equal(state.calls.length,0);assert.equal(state.references,0)
  const cancelled=await invoke({prompt:'Create a box'},{abort:true})
  assert.equal(cancelled.code,undefined);assert.equal(state.calls.length,1);assert.equal(state.refunds,1)
  const invalid=await invoke({prompt:'x'.repeat(16001)})
  assert.equal(invalid.code,413);assert.equal(state.kind,undefined)
  console.log('PASS CAD creation/edit-repair allowances, bounded failover/continuation, honest truncation and compile status, cancellation refunds and input limits.')
}finally{Date.now=originalNow;delete globalThis.__cad}
