// Real Cloudflare client/storage contexts. Every transport is offline.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const bundle=await build({stdin:{contents:"export * from './api/_cloudflareStore';export * from './api/_storageDeadline';export * from './api/_requestCancellation'",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'cjs',platform:'node',packages:'external'})
const mod={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports)
const {CloudflareStore,withStorageDeadline,withCancellationSignal,checkStorageDeadline}=mod.exports
const store=new CloudflareStore('https://fixture.invalid','offline-storage-deadline-secret-123456')
const old={fetch:globalThis.fetch,now:Date.now,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout}
let now=100000,next=0,timers=new Map()
const advance=ms=>{now+=ms;for(const [id,t]of [...timers])if(t.at<=now&&timers.delete(id))t.fn()}
const turn=()=>new Promise(resolve=>old.setTimeout(resolve,0))
try{
 Date.now=()=>now;globalThis.setTimeout=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id};globalThis.clearTimeout=id=>timers.delete(id)
 let calls=0,observedSignal
 globalThis.fetch=async(_u,init)=>{calls++;observedSignal=init.signal;return new Promise(()=>{})}
 const hung=withStorageDeadline(now+1000,()=>store.query('SELECT 1'));const hungCheck=assert.rejects(hung,/deadline/);await turn();advance(1000);await hungCheck
 assert.equal(calls,1);assert.equal(observedSignal.aborted,true);assert.equal(timers.size,0)
 globalThis.fetch=async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})
 const body=withStorageDeadline(now+1500,()=>store.query('SELECT 1'));const bodyCheck=assert.rejects(body,/deadline/);await turn();advance(1500);await bodyCheck
 assert.equal(timers.size,0)
 const normal=store.query('SELECT 1');const normalCheck=assert.rejects(normal,/timed out/);await turn();advance(20000);await normalCheck
 assert.equal(timers.size,0)
 console.log('PASS ignored-abort fetch, stalled response body, and normal20s database timeout all settle without leaked deadline timers')

 await withStorageDeadline(now+5000,async()=>{
   const compute=new AbortController();globalThis.fetch=async()=>new Promise(()=>{})
   const work=withCancellationSignal(compute.signal,()=>store.query('SELECT work'));const checked=assert.rejects(work);await turn();compute.abort();await checked
   await withCancellationSignal(compute.signal,async()=>{assert.throws(()=>checkStorageDeadline());assert.doesNotThrow(()=>checkStorageDeadline(true),'rollback may use the separate storage tail')})
   globalThis.fetch=async()=>Response.json({results:[{saved:true}]})
   assert.deepEqual((await store.query('SELECT cleanup')).results,[{saved:true}],'cleanup survives expired computation scope under remaining storage deadline')
 })
 const cancelledRequest=new AbortController();cancelledRequest.abort()
 await withCancellationSignal(cancelledRequest.signal,async()=>assert.deepEqual((await store.query('SELECT quota_refund')).results,[{saved:true}],'unrelated cancelled request keeps preexisting critical-cleanup semantics'))
 assert.equal(timers.size,0)
 console.log('PASS separate bounded cleanup window after computation cancellation; unrelated request refund semantics remain unchanged')

 const bytes=Buffer.from('"abcdef"'),parts=[bytes.subarray(0,2),bytes.subarray(2,4),bytes.subarray(4)],hash=part=>createHash('sha256').update(part).digest('hex')
 calls=0
 globalThis.fetch=async(url)=>{
   calls++
   if(String(url).endsWith('/documents/read'))return Response.json({revision:'one',entries:[{key:'nalu-agent-flows',manifest:{parts:parts.map(hash),sha256:hash(bytes),byteLength:bytes.length}}]})
   advance(1000)
   return Response.json({parts:parts.slice(0,2).map(part=>({sha256:hash(part),base64:part.toString('base64')}))})
 }
 await assert.rejects(withStorageDeadline(now+1000,()=>store.readDocuments('owner',['nalu-agent-flows'])),/deadline/)
 assert.equal(calls,2,'no later multipart request may start after storage deadline')
 assert.equal(timers.size,0)
 console.log('PASS multipart document reconstruction stops before another network request when deadline expires; no write retry')
}finally{Date.now=old.now;globalThis.fetch=old.fetch;globalThis.setTimeout=old.setTimeout;globalThis.clearTimeout=old.clearTimeout}
