import assert from 'node:assert/strict'
import {build} from 'esbuild'
import Module from 'node:module'
const code=await build({entryPoints:['api/_hostedBrowser.ts'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',plugins:[{name:'boundaries',setup(b){
 const sources={'./_db':`export const readToken=r=>(r.headers.authorization||'').replace(/^Bearer /,'')`,'./_connectionBackend':`export const connectionBackend=()=>{throw Error('Unexpected real database')}`,'./_limits':`export const reserveDailyQuota=()=>{throw Error('Unexpected real quota')}`}
 b.onResolve({filter:/.*/},a=>a.path in sources?{path:a.path,namespace:'fixture'}:undefined)
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:sources[a.path],loader:'js'}))
}}]})
const mod=new Module(process.cwd()+'/scripts/.hosted-test.cjs');mod.filename=process.cwd()+'/scripts/.hosted-test.cjs';mod.paths=Module._nodeModulePaths(process.cwd());mod._compile(code.outputFiles[0].text,mod.filename)
const {hostedBrowser,hostedIdentity}=mod.exports
const savedFetch=globalThis.fetch,savedSecret=process.env.NALU_SESSION_SECRET,savedSnapshot=process.env.NALU_BROWSER_SNAPSHOT_ID
process.env.NALU_SESSION_SECRET='fixture-secret-'.repeat(3);process.env.NALU_BROWSER_SNAPSHOT_ID='fixture-snapshot'
const machines=new Map(),calls=[];let creates=0,quotas=0,releases=0,quotaOK=true,claimOK=true,failCreate=false
class Store{async init(){}async claim(owner){calls.push(['lease',owner]);return claimOK?{lease:'lease-'+owner,state:{legacy:'preserved'}}:null}async release(owner,lease){assert.equal(lease,'lease-'+owner);calls.push(['release',owner])}}
const provider={async get({name}){if(!machines.has(name))throw {response:{status:404}};return machines.get(name)},async getOrCreate(options){if(failCreate)throw {response:{status:503},message:'PROVIDER_SECRET_MUST_NOT_LEAK'};let m=machines.get(options.name),fresh=!m;if(!m){creates++;m={name:options.name,status:'running',expiresAt:new Date(Date.now()+900000),domain:()=>`https://${options.name}.vercel.run`,writeFiles:async files=>assert.ok(files[0].content.length),runCommand:async command=>{assert.equal(command.detached,true);assert.equal(command.env.BROWSER_MAX_SESSIONS,'2');assert.ok(!Object.values(command.env).includes('fixture-owner-a-token'))},stop:async()=>{m.status='stopped'}};machines.set(m.name,m)};m.status='running';if(fresh)await options.onCreate(m);else await options.onResume(m);return m}}
const deps={Sandbox:provider,Store,connectionBackend:()=>({client:{},connect:async()=>{},close:async()=>{},userId:async token=>({'fixture-owner-a-token':'owner-a','fixture-owner-b-token':'owner-b'}[token]||null)}),reserveDailyQuota:async()=>{quotas++;return {ok:quotaOK,status:429,release:async()=>{releases++}}},readFile:async()=>Buffer.from('test-runtime'),wait:async()=>{}}
globalThis.fetch=async(url,opts)=>{const body=JSON.parse(opts.body),identity=hostedIdentity(body.owner,process.env.NALU_SESSION_SECRET);assert.equal(url,`https://${identity.name}.vercel.run/browser`);assert.equal(opts.headers.Authorization,'Bearer '+identity.key);assert.match(body.token,/fixture-owner-[ab]-token/);calls.push(['action',body.owner,body.action,body.data.agent_id]);return Response.json({configured:true,runtime:'hosted',active:['workspace_open','workspace_screen'].includes(body.action),...(body.action==='workspace_screen'?{image:'first-frame'}:{}),status:body.action==='workspace_run'?'running':'idle',agents:[]})}
async function request(action,data={},token='fixture-owner-a-token'){const result={code:200};await hostedBrowser({headers:{authorization:token?'Bearer '+token:''}},{status(code){result.code=code;return this},json(value){result.value=value;return value}},{action:'host_'+action,...data},deps);return result}
try{
 assert.equal((await request('workspace_open',{},'')).code,401);assert.equal(creates,0)
 assert.equal((await request('workspace_open',{agent_id:'../../other'})).code,400);assert.equal(creates,0)
 assert.equal((await request('workspace_status')).value.active,false);assert.equal(creates,0)
 const opened=await request('workspace_open');assert.equal(opened.code,200);assert.equal(opened.value.image,'first-frame');assert.equal(creates,1);assert.equal(quotas,1)
 await request('workspace_screen');assert.equal(creates,1);assert.equal(quotas,1)
 await request('workspace_open',{},'fixture-owner-b-token');assert.equal(creates,2)
 assert.notEqual(hostedIdentity('owner-a',process.env.NALU_SESSION_SECRET).name,hostedIdentity('owner-b',process.env.NALU_SESSION_SECRET).name)
 await request('workspace_run',{task:'Read the page',owner:'owner-b',agent_id:'separate-agent'})
 assert.deepEqual(calls.filter(c=>c[0]==='action').at(-1).slice(1),['owner-a','workspace_run','separate-agent'])
 assert.ok(!JSON.stringify((await request('workspace_status')).value).includes('.vercel.run'))
 claimOK=false;assert.equal((await request('workspace_open')).code,409);assert.equal((await request('workspace_screen')).code,200,'screen reads never contend with the mutation lease');claimOK=true
 await request('disconnect');const before=quotas;await request('workspace_screen');assert.equal(quotas,before)
 quotaOK=false;assert.equal((await request('workspace_open')).code,429);quotaOK=true
 await request('workspace_open');assert.equal(creates,2,'resume reuses the owned machine')
 await request('disconnect');failCreate=true;const failed=await request('workspace_open');assert.equal(failed.code,503);assert.ok(!JSON.stringify(failed).includes('PROVIDER_SECRET'));assert.equal(releases,0,'uncertain provider acceptance keeps the session reservation')
 const normalFetch=globalThis.fetch
 globalThis.fetch=async(url,opts)=>{
  const response=await normalFetch(url,opts), value=await response.json()
  return Response.json({...value,active:true,status:'running'})
 }
 const opensBefore=calls.filter(c=>c[0]==='action'&&c[2]==='workspace_open').length
 failCreate=false
 const reattached=await request('workspace_open',{},'fixture-owner-b-token')
 assert.equal(reattached.value.status,'running')
 assert.equal(calls.filter(c=>c[0]==='action'&&c[2]==='workspace_open').length,opensBefore,'reopening a working agent only reads status and screen')
 globalThis.fetch=normalFetch
 console.log('PASS hosted browser authentication, owner-derived machine identity, private transport, startup leases, quota before allocation, no polling resumes, bounded lifecycle and sanitized failures.')
}finally{globalThis.fetch=savedFetch;if(savedSecret===undefined)delete process.env.NALU_SESSION_SECRET;else process.env.NALU_SESSION_SECRET=savedSecret;if(savedSnapshot===undefined)delete process.env.NALU_BROWSER_SNAPSHOT_ID;else process.env.NALU_BROWSER_SNAPSHOT_ID=savedSnapshot}
