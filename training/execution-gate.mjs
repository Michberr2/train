import {createHash} from 'node:crypto'
const hash=value=>createHash('sha256').update(value).digest('hex')
export function qualifiesExecution(result,model){
 return result?.passed===true&&result.simulated===false&&result.modelSha256===hash(model)&&Number.isInteger(result.requestCount)&&result.requestCount>0&&result.generation?.code===0&&result.generation.timedOut===false&&result.qualification?.code===0&&result.qualification.timedOut===false&&result.qualification.passed===true
}
export async function evaluateExecutionGate({candidate,incumbent,provider,apiKey,run}){
 // Load lazily: missing evaluator checkout is a failed gate, never permission to deploy.
 const execute=run||(await import('../../naludesktop/tests/benchmarks/run-model-fullstack.mjs')).runModelFullstack
 const candidateResult=await execute({model:candidate,provider,apiKey})
 if(!qualifiesExecution(candidateResult,candidate))return {qualified:false,candidate:candidateResult,incumbent:null,reason:'candidate failed bound execution qualification'}
 const incumbentResult=await execute({model:incumbent,provider,apiKey})
 return {qualified:true,candidate:candidateResult,incumbent:incumbentResult,incumbentQualified:qualifiesExecution(incumbentResult,incumbent)}
}
