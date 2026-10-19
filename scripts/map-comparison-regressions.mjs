import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const root=dirname(dirname(fileURLToPath(import.meta.url))), temp=await mkdtemp(join(root,'scripts','.map-comparison-'))
const oldKey=process.env.TINKER_API_KEY, oldFetch=globalThis.fetch
try {
  process.env.TINKER_API_KEY='offline-only';globalThis.fetch=async()=>{throw new Error('Unexpected external request')}
  const bundled=await build({stdin:{resolveDir:root,contents:"export * from './shared/mapComparison';export {default as handler} from './api/web';"},bundle:true,write:false,platform:'node',format:'esm',packages:'external',plugins:[{name:'offline',setup(build){
    build.onResolve({filter:/^\.\/_db$|^\.\/_mapAi$|^\.\/_webResearch$/},args=>({path:args.path,namespace:'fixture'}))
    build.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='./_db'?'export async function identityForRequest(){return null};export function identityBlock(){return ""}':path==='./_mapAi'?'export async function completeMapAi(options){globalThis.__mapSystem=options.system;if(options.research)await options.research(new AbortController().signal);return JSON.stringify(globalThis.__mapFixture)}':'export async function research(){return globalThis.__mapEvidence}; export async function search(){throw new Error("Unexpected search")};export async function fetchPage(){throw new Error("Unexpected fetch")}'}))
  }}]})
  const path=join(temp,'comparison.mjs');await writeFile(path,bundled.outputFiles[0].text)
  const {normalizeMapComparison,mapComparisonEvidence,handler}=await import(pathToFileURL(path).href)
  const url='https://example.org/city-survey', quote='Orlando median rent was $1,700 per month in September 2026.'
  const evidence=[{url,text:quote,accessedAt:'2026-10-18T12:00:00Z',publishedAt:'2026-10-01'}]
  const plan={title:'Orlando vs Tampa',criteria:['Median rent','Schools'],places:[{name:'Orlando',lat:28.5,lng:-81.3,scores:{'Median rent':10,Schools:10},metrics:{'Median rent':{value:'$1,700 per month',sourceUrl:url,quote}},note:'Research interpretation'},{name:'Tampa',lat:27.9,lng:-82.4,scores:{'Median rent':9,Schools:9},metrics:{'Median rent':{value:'$999',sourceUrl:url,quote}}}],winner:'Orlando'}
  const frozen=JSON.stringify(plan), normalized=normalizeMapComparison(plan,evidence)
  assert.equal(normalized.places[0].metrics['Median rent'].value,'$1,700 per month')
  assert.equal(normalized.places[0].metrics['Median rent'].publishedAt,'2026-10-01')
  assert.equal(normalized.places[0].metrics.Schools.value,null)
  assert.equal(normalized.places[1].metrics['Median rent'].status,'unavailable')
  assert.equal(normalized.winner,undefined);assert.equal(normalized.places[0].scores,undefined)
  assert.equal(JSON.stringify(plan),frozen,'sanitizer must not mutate upstream model data')
  assert.deepEqual(normalizeMapComparison(normalized),normalized,'client normalization must be idempotent')
  for(const patch of [{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://invented.example/survey'},{quote:'Orlando has rent of $1,700 per month everywhere.'},{value:'$17,000 per month'},{value:700},{value:202}]){
    const altered=structuredClone(plan);Object.assign(altered.places[0].metrics['Median rent'],patch)
    assert.equal(normalizeMapComparison(altered,evidence).places[0].metrics['Median rent'].status,'unavailable')
  }
  const missing=normalizeMapComparison(plan,[])
  assert.ok(missing.places.every(p=>Object.values(p.metrics).every(m=>m.status==='unavailable')),'missing research must not produce scores or factual metrics')
  const brief={text:`LIVE RESEARCH\n\n[1] City survey\n${url}\nAccessed: 2026-10-18T12:00:00Z; Published: 2026-10-01; Updated: unknown\n${quote}\n\nSEARCH LEADS ONLY — not read\nhttps://unread.example\nTampa rent is $999.`,sources:[{url,status:'read',accessedAt:'2026-10-18T12:00:00Z',publishedAt:'2026-10-01'},{url:'https://unread.example',status:'unavailable'}]}
  assert.deepEqual(mapComparisonEvidence(brief).map(e=>e.url),[url])
  assert.ok(!mapComparisonEvidence(brief)[0].text.includes('Tampa rent'))
  globalThis.__mapEvidence=brief;globalThis.__mapFixture={answer:'Compare available evidence and the missing information.',comparison:plan,layers:[],shapes:[],center:null,zoom:null,search:null}
  const response={status(n){this.code=n;return this},json(body){this.body=body;return this},setHeader(){}}
  await handler({method:'POST',headers:{},body:{action:'mapai',query:'Compare Orlando vs Tampa'}},response)
  assert.equal(response.code,200);assert.deepEqual(response.body.comparison,normalized)
  assert.ok(!globalThis.__mapSystem.includes('TOTALS MUST NOT TIE'));assert.ok(globalThis.__mapSystem.includes('value:null'))
  console.log('PASS map comparisons: actual handler, source-bound value extraction, missing evidence, unsafe/invented URLs, literal quotes, legacy score removal and client normalization.')
}finally{globalThis.fetch=oldFetch;if(oldKey==null)delete process.env.TINKER_API_KEY;else process.env.TINKER_API_KEY=oldKey;delete globalThis.__mapEvidence;delete globalThis.__mapFixture;delete globalThis.__mapSystem;await rm(temp,{recursive:true,force:true})}
