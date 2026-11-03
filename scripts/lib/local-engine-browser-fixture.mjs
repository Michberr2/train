import { prebuiltAppConfig } from '@mlc-ai/web-llm'

// Browser UI suites run the real local runtime, queue, schemas and SSE adapter.
// Only the GPU engine is synthetic; this is not evidence of model quality.
export function localEngineBrowserFixture() {
  return {
    name: 'synthetic-local-browser-engine', enforce: 'pre',
    config() { return { optimizeDeps: { exclude: ['@mlc-ai/web-llm'] } } },
    resolveId(id) { if (id === '@mlc-ai/web-llm') return '\0synthetic-local-engine' },
    load(id) {
      if (id !== '\0synthetic-local-engine') return
      return `export const prebuiltAppConfig=${JSON.stringify(prebuiltAppConfig)};
export class WebWorkerMLCEngineHandler {onmessage(){}}
export class WebWorkerMLCEngine {
 constructor(worker,options){this.options=options;this.chat={completions:{create:async request=>this.generate(request)}}}
 async reload(){this.options.initProgressCallback({progress:1,text:'Synthetic local engine ready'})}
 async unload(){} async resetChat(){} interruptGenerate(){}
 async *generate(request){
  const response=await fetch('/__fixture-local-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  if(!response.ok)throw Error('Synthetic local model fixture failed');
  let {completion,chunks,delayMs}=await response.json();
  const schema=request.response_format?.schema?JSON.parse(request.response_format.schema):null;
  let parts=chunks||[completion];
  if(schema?.properties?.message&&schema?.properties?.actions){
   if(chunks)parts=chunks.map((text,index)=>(index===0?'{"message":"':'')+JSON.stringify(text).slice(1,-1)+(index===chunks.length-1?'","actions":[]}':''));
   else parts=[JSON.stringify({message:completion,actions:[]})];
  }
  if(request.extra_body?.enable_thinking)yield{choices:[{delta:{content:'Internal fixture assessment.</think>\\n\\n'}}]};
  for(let i=0;i<parts.length;i++){if(i&&delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));yield{choices:[{delta:{content:parts[i]}}]}}yield{choices:[{delta:{},finish_reason:'stop'}]};
 }
}`
    },
  }
}

export function enableFixtureLocalAI() {
  localStorage.setItem('device-local-ai-v1', JSON.stringify({ enabled: true, profile: 'balanced' }))
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 1024 ** 3 } }) } })
}
