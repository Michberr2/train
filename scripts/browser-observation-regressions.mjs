import assert from 'node:assert/strict'
import {DeviceRuntime} from '../services/browser-device/runtime.mjs'
const runtime=new DeviceRuntime({host:{}})
let reads=0,executions=0
runtime.observe=async()=>{if(++reads===1)throw Error('Attempted to use detached Frame');return {handles:[],input:{url:'https://example.com/'}}}
runtime.execute=async(a)=>{executions++;a.status='done'}
runtime.decide=async()=>({action:{type:'finish',summary:'Read verified'}})
const a={status:'running',epoch:0,chain:Promise.resolve(),page:{url:()=> 'https://example.com/'},history:[],controller:new AbortController()}
await runtime.run(a,0)
assert.equal(reads,2);assert.equal(executions,1);assert.equal(a.status,'done')
reads=0;runtime.observe=async()=>{reads++;throw Error('Execution context was destroyed')}
await assert.rejects(runtime.observeStable(a),/context/);assert.equal(reads,4)
reads=0;runtime.observe=async()=>{reads++;throw Error('Unexpected browser failure')}
await assert.rejects(runtime.observeStable(a),/Unexpected/);assert.equal(reads,1)
console.log('PASS bounded observation recovery; no action replay; unrelated errors preserved')
