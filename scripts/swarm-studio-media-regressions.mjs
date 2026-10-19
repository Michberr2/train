import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
const bundle = await build({stdin:{resolveDir:process.cwd(),contents:`export {prepareSwarmStudioMedia} from './api/_swarmStudioMedia';export {resolveSwarmGenerationScope} from './api/_swarmGeneration';export {validateSwarmStudioArtifact} from './api/_swarmStudioArtifact'`},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'private-storage',setup(b){
  b.onResolve({filter:/^\.\/_(swarmStore|taskAttachments|publicFetch)$/},args=>({path:args.path,namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='./_swarmStore'?`export const SWARM_MAX_STATE_BYTES=3000000;export const SWARM_MAX_SNAPSHOT_BYTES=12000000;export class SwarmStore{read(owner){return globalThis.mediaFixture.read(owner)}}`:
    path==='./_publicFetch'?`export const publicFetch=(url,options)=>globalThis.mediaFixture.fetch(url,options);`:
    `export const CHUNK_BYTES=786432;export const beginAttachment=(...a)=>globalThis.mediaFixture.begin(...a);export const putAttachmentPart=(...a)=>globalThis.mediaFixture.put(...a);export const finishAttachment=(...a)=>globalThis.mediaFixture.finish(...a);`}))
}}]})
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Media tests cannot use network')}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4k0AAAAASUVORK5CYII=','base64')
function fixture(kind='image',owner='owner'){
  const stamp=Date.now(),source={id:'source',projectId:'project',thread:'Rocky',taskId:'task',kind:'task',speaker:'Rocky',status:'waiting',input:'Create this media.',requestId:'r1',createdAt:stamp-300,updatedAt:stamp-200,attempts:1,artifact:{type:'needs-workspace',workspace:'studio',studioKind:kind,prompt:'Create this media.'}}
  const snapshot={revision:1,state:{version:1,mode:'live',projects:[{id:'project',title:'Media',brief:'Approved',members:['Rocky'],createdAt:stamp-500,updatedAt:stamp-500}],tasks:[{id:'task',projectId:'project',title:'Media',summary:'Generating',assignee:'Rocky',threads:['Rocky'],status:'running',executionId:'job',updatedAt:stamp}],messages:[],turns:[]},jobs:[source,{...source,id:'job',status:'running',requestId:'r2',createdAt:stamp-100,leaseToken:'lease',leaseUntil:stamp+60000,artifact:{type:'studio-generation',sourceJobId:'source',studioKind:kind}}]}
  const f={owner,snapshot,reads:0,begins:[],parts:[],finishes:0,fetches:[],cancelAtPart:-1,video:Buffer.alloc(6*1024*1024),changed:false,noValidator:false,wrongHash:false,
    async read(readOwner){assert.equal(readOwner,owner);this.reads++;return structuredClone(snapshot)},
    async begin(_client,uid,meta){assert.equal(uid,owner);this.begins.push(meta);this.meta={...meta,id:`att_${createHash('sha256').update(uid+meta.sourceId+meta.sha256).digest('hex')}`,parts:Math.ceil(meta.size/786432),createdAt:new Date().toISOString()};if(this.wrongHash)this.meta.sha256='0'.repeat(64);return this.meta},
    async put(_client,uid,id,part,bytes){assert.equal(uid,owner);assert.equal(id,this.meta.id);this.parts.push({part,bytes:Buffer.from(bytes)});if(part===this.cancelAtPart)snapshot.jobs[1].status='cancelled'},
    async finish(_client,uid,id){assert.equal(uid,owner);assert.equal(id,this.meta.id);this.finishes++;const bytes=Buffer.concat(this.parts.map(p=>p.bytes));assert.equal(bytes.length,this.meta.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),this.meta.sha256);return this.meta},
    async fetch(url,options){assert.ok(url.startsWith('https://media.example.com/'),'all remote bytes pass through the approved public transport');assert.ok(options.signal instanceof AbortSignal);assert.ok(options.maxBytes<=5000000);this.fetches.push(options);const match=options.headers.Range.match(/^bytes=(\d+)-(\d+)$/);const start=Number(match[1]),end=Math.min(this.video.length-1,Number(match[2]));return new Response(this.video.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${this.video.length}`,...(!this.noValidator?{etag:this.changed&&start>0?'"changed"':'"stable"'}:{})}})},
  }
  f.video.writeUInt32BE(24,0);f.video.write('ftypisom',4)
  globalThis.mediaFixture=f
  const scope=()=>api.resolveSwarmGenerationScope({read:uid=>f.read(uid)},owner,{sourceJobId:'source',taskId:'task',expectedStudioKind:kind,executionId:'job',leaseToken:'lease'})
  const artifact=url=>api.validateSwarmStudioArtifact(kind,{url,name:'Nalu media'})
  return {f,scope,artifact}
}
let count=0;const check=async(name,fn)=>{await fn();count++;console.log(`PASS ${name}`)}
try{
  await check('image bytes become a private task descriptor without inline/provider URL',async()=>{
    const {f,scope,artifact}=fixture();const result=await api.prepareSwarmStudioMedia({},await scope(),artifact(`data:image/png;base64,${png.toString('base64')}`),new AbortController().signal)
    assert.equal(result.payload.url,undefined);assert.equal(result.payload.media.mime,'image/png');assert.equal(result.payload.media.size,png.length)
    assert.equal(f.finishes,1);assert.equal(f.begins[0].taskId,'task');assert.match(f.begins[0].sourceId,/^swarm:[a-f0-9]{64}$/)
    assert.ok(f.reads>=5);assert.deepEqual(api.validateSwarmStudioArtifact('image',result.payload).payload,result.payload)
  })
  await check('ranged video is bounded, stable, complete and saved as private chunks',async()=>{
    const {f,scope,artifact}=fixture('video');const result=await api.prepareSwarmStudioMedia({},await scope(),artifact('https://media.example.com/output.mp4'),new AbortController().signal)
    assert.equal(f.fetches.length,2);assert.equal(f.fetches[1].headers['If-Range'],'"stable"');assert.equal(result.payload.media.size,f.video.length)
    assert.equal(result.payload.media.parts,8);assert.equal(f.parts.length,8);assert.equal(result.payload.url,undefined);assert.equal(f.finishes,1)
    assert.equal(result.payload.media.sha256,createHash('sha256').update(f.video).digest('hex'))
  })
  await check('cancelled lease stops subsequent chunks and never finishes an attachment',async()=>{
    const {f,scope,artifact}=fixture('video');f.cancelAtPart=1
    await assert.rejects(api.prepareSwarmStudioMedia({},await scope(),artifact('https://media.example.com/output.mp4'),new AbortController().signal),/stopped or changed/)
    assert.equal(f.parts.length,2);assert.equal(f.finishes,0)
  })
  await check('changed/missing range validators reject partial remote media',async()=>{
    for(const mode of ['changed','noValidator']){
      const {f,scope,artifact}=fixture('video');f[mode]=true
      await assert.rejects(api.prepareSwarmStudioMedia({},await scope(),artifact('https://media.example.com/output.mp4'),new AbortController().signal),/changed|stable/)
      assert.equal(f.begins.length,0)
    }
  })
  await check('oversized, malformed, and fake image bytes are rejected before storage',async()=>{
    for(const url of ['data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,AAAA',`data:image/png;base64,${Buffer.alloc(2*1024*1024+1).toString('base64')}`]){
      const {f,scope,artifact}=fixture();await assert.rejects(api.prepareSwarmStudioMedia({},await scope(),artifact(url),new AbortController().signal));assert.equal(f.begins.length,0)
    }
  })
  await check('stored metadata mismatch and pre-abort cannot publish media',async()=>{
    const {f,scope,artifact}=fixture();f.wrongHash=true
    await assert.rejects(api.prepareSwarmStudioMedia({},await scope(),artifact(`data:image/png;base64,${png.toString('base64')}`),new AbortController().signal),/does not match/)
    assert.equal(f.parts.length,0);assert.equal(f.finishes,0)
    const ctrl=new AbortController();ctrl.abort();f.wrongHash=false
    await assert.rejects(api.prepareSwarmStudioMedia({},await scope(),artifact(`data:image/png;base64,${png.toString('base64')}`),ctrl.signal),{name:'AbortError'})
  })
  await check('media descriptor validation rejects mismatched kind, size, count and hash',async()=>{
    const {scope,artifact}=fixture();const result=await api.prepareSwarmStudioMedia({},await scope(),artifact(`data:image/png;base64,${png.toString('base64')}`),new AbortController().signal)
    for(const patch of [{mime:'video/mp4'},{parts:999},{size:0},{sha256:'bad'},{attachmentId:'other'}])assert.throws(()=>api.validateSwarmStudioArtifact('image',{media:{...result.payload.media,...patch}}))
  })
  console.log(`${count} private Swarm media regression groups passed.`)
}finally{globalThis.fetch=oldFetch;delete globalThis.mediaFixture}
