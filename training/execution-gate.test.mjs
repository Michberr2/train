import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {qualifiesExecution,evaluateExecutionGate} from './execution-gate.mjs'
import {runCycle} from './flywheel.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
const result=model=>({passed:true,simulated:false,modelSha256:hash(model),requestCount:2,generation:{code:0,timedOut:false},qualification:{code:0,timedOut:false,passed:true}})
test('execution eligibility rejects replay, wrong model, missing evidence and timeout',()=>{
 assert.equal(qualifiesExecution(result('candidate'),'candidate'),true)
 for(const invalid of [{...result('candidate'),simulated:true},result('other'),{passed:true},{...result('candidate'),requestCount:0},{...result('candidate'),generation:{code:0,timedOut:true}}])assert.equal(qualifiesExecution(invalid,'candidate'),false)
})
test('gate runs selected identities and never accepts a simulated candidate',async()=>{
 const models=[]
 const gate=await evaluateExecutionGate({candidate:'candidate',incumbent:'incumbent',run:async({model})=>{models.push(model);return result(model)}})
 assert.equal(gate.qualified,true);assert.deepEqual(models,['candidate','incumbent'])
 const rejected=await evaluateExecutionGate({candidate:'candidate',incumbent:'incumbent',run:async({model})=>({...result(model),simulated:true})})
 assert.equal(rejected.qualified,false);assert.equal(rejected.incumbent,null)
})
async function cycle({qualification={qualified:false},deployment=false,throws=false}={}){
 let saved,deployments=0,error
 const state={trainedAt:{},rowCounts:{},deployed:{agent:{model:'incumbent'}},history:[]}
 const provider='https://fixture.invalid',apiKey='offline-fixture'
 const rows=Array.from({length:61},(_,i)=>({training:{split:i===60?'validation':'train'}}))
 try{await runCycle({getLanes:()=>({agent:rows}),getProductionEnv:()=>({TINKER_API_KEY:apiKey,TINKER_BASE_URL:provider,NALU_CLI_MODEL:'incumbent'}),candidateBackend:{provider,apiKey},load:()=>state,save:value=>{saved=JSON.parse(JSON.stringify(value))},force:'agent',dry:false,readBattery:()=>[],train:()=>({ok:true,path:'candidate'}),score:async model=>({score:model.model==='candidate'?100:79}),execute:async()=>{if(throws)throw Error('missing evaluator');return qualification},deploy:()=>{deployments++;return deployment}})}catch(e){error=e}
 return {saved,deployments,error}
}
test('actual flywheel main rejects perfect format scores without execution qualification',async()=>{
 const value=await cycle();assert.equal(value.deployments,0);assert.equal(value.saved.history[0].deployed,false)
})
test('unavailable execution runner fails closed',async()=>{assert.equal((await cycle({throws:true})).deployments,0)})
test('actual deployment failure does not record a deployed release',async()=>{
 const value=await cycle({qualification:{qualified:true},deployment:false});assert.ok(value.error);assert.equal(value.deployments,1);assert.equal(value.saved.history[0].deployed,false);assert.equal(value.saved.deployed.agent.model,'incumbent')
})
test('successful qualified deployment records the new release',async()=>{
 const value=await cycle({qualification:{qualified:true},deployment:true});assert.equal(value.deployments,1);assert.equal(value.saved.history[0].deployed,true);assert.equal(value.saved.deployed.agent.model,'candidate')
})
