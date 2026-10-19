// Real _db/_limits/doc/writingContext; only DB/provider transports are synthetic.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(':memory:')
db.function('GREATEST', { varargs: true }, (...values) => Math.max(...values))
db.exec('CREATE TABLE nalu_usage(subject TEXT,day TEXT,kind TEXT,count INTEGER,PRIMARY KEY(subject,day,kind));CREATE TABLE nalu_usage_reservations(id TEXT PRIMARY KEY,subject TEXT,day TEXT,kind TEXT,released BOOLEAN DEFAULT FALSE,counted INTEGER DEFAULT 0)')
const savedEnv = Object.fromEntries(['DATABASE_URL','NALU_STORAGE_BACKEND'].map(key=>[key,process.env[key]]))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('No network in Swarm hook tests') }
process.env.DATABASE_URL = 'postgres://synthetic.invalid/offline'
delete process.env.NALU_STORAGE_BACKEND
const f = globalThis.swarmHookFixture = { subjects: [], queries: [], prompts: [], accountReads: 0, fail: false, waits: [], tokenReads: 0,
  async query(sql, params = []) {
    if (this.fail) throw new Error('Synthetic database outage')
    this.queries.push(sql)
    if (sql.includes('nalu_sessions')) { this.tokenReads++; return {rows:sql.includes('display_name')?[{id:'personal-owner',display_name:'Personal Name'}]:[{user_id:'personal-owner'}]} }
    if (sql.includes('nalu_user_data')) return {rows:[{value:'PRIVATE_PERSONAL_PROFILE'}]}
    if (sql.includes('INSERT INTO nalu_usage (')) this.subjects.push(params[0])
    const text = sql.replace(/\$(\d+)::date/g,'?$1').replace(/\$(\d+)/g,'?$1').replace(/day::text/g,'CAST(day AS TEXT)').replace(/CURRENT_DATE/g,"'2026-10-18'")
    if (/CREATE TABLE|^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) { db.exec(text); return {rows:[]} }
    return {rows:db.prepare(text).all(...params)}
  },
  async batch(statements) {
    if (this.fail) throw new Error('Synthetic D1 outage')
    db.exec('BEGIN')
    try {
      const results = statements.map(({sql,params=[]})=>{
        if (sql.includes('INSERT INTO nalu_usage(')) this.subjects.push(params[0])
        return {results:db.prepare(sql).all(...params)}
      })
      db.exec('COMMIT'); return {results}
    } catch(error) { db.exec('ROLLBACK'); throw error }
  },
}
const bundle = await build({stdin:{resolveDir:process.cwd(),contents:`export * from './api/_swarmStudioContext';export {identityForRequest} from './api/_db';export {reserveDailyQuota} from './api/_limits';export {default as doc} from './api/doc';export {swarmStudioHandlers} from './api/_swarmStudioHandlers'`},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'transports',setup(b){
  b.onResolve({filter:/^\.\/(doc|slides|sheet|design|cad|image|video)$/},args=>args.importer.endsWith('/_swarmStudioHandlers.ts')?{path:'unused-handler',namespace:'fixture'}:undefined)
  b.onResolve({filter:/^pg$|^@vercel\/functions$|^\.\/_(cloudflareStore|connectionBackend|accountContext|llm|grounding|studioGeneration)$/},args=>({path:args.path,namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:
    path==='unused-handler'?`export default ()=>{throw Error('Unexpected handler')}`:
    path==='pg'?`export class Client{async connect(){if(globalThis.swarmHookFixture.fail)throw Error('DB unavailable')}async end(){}query(...args){return globalThis.swarmHookFixture.query(...args)}}`:
    path==='./_cloudflareStore'?`export class CloudflareConflict extends Error{};export class CloudflareStore{async query(sql,params){const r=await globalThis.swarmHookFixture.query(sql,params);return {results:r.rows}}batch(s){return globalThis.swarmHookFixture.batch(s)}async readDocuments(){throw Error('Private account records must not load in this test')}}`:
    path==='./_connectionBackend'?`export const connectionBackend=()=>({client:{batch:s=>globalThis.swarmHookFixture.batch(s)},userId:async()=>{globalThis.swarmHookFixture.tokenReads++;return 'personal-owner'}});`:
    path==='./_accountContext'?`export const accountContextForUser=async()=>{globalThis.swarmHookFixture.accountReads++;return 'PRIVATE_ACCOUNT_MEMORY'};`:
    path==='./_llm'?`export const providerChain=()=>[{}];`:
    path==='./_grounding'?`export const groundResearch=async()=>({text:'',status:'not-needed',sources:[],checkedAt:'2026-10-18'});`:
    path==='@vercel/functions'?`export const waitUntil=p=>globalThis.swarmHookFixture.waits.push(p);`:
    `export const generateStudioJson=async o=>{globalThis.swarmHookFixture.prompts.push(o.messages(0));if(globalThis.swarmHookFixture.generationFailure)return null;return o.parse(JSON.stringify(globalThis.swarmHookFixture.email?{to:'',subject:'Project update',body:'Here is the approved direction.'}:{title:'Scoped brief',blocks:[{type:'p',text:'Approved project content.'}]}))};`
  }))
}}]})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const scope = ownerId=>({ownerId,projectId:'p',taskId:'t',executionId:'e'})
const request = {headers:{authorization:'Bearer personal-session'},body:{ownerId:'forged-owner',swarm:{ownerId:'forged-owner'}}}
let cases=0
const check=async(name,fn)=>{await fn();cases++;console.log(`PASS ${name}`)}
try {
  await check('ordinary identity and bearer quota behavior stay unchanged',async()=>{
    const identity=await api.identityForRequest(request)
    assert.equal(identity.id,'personal-owner');assert.equal(identity.profile,'PRIVATE_PERSONAL_PROFILE')
    const quota=await api.reserveDailyQuota(request,'ordinary',{userPerDay:5})
    assert.equal(quota.ok,true);assert.equal(quota.signedIn,true);assert.equal(f.subjects.at(-1),'user:personal-owner')
  })
  await check('real Swarm identity hook skips all account/profile queries before token lookup',async()=>{
    const before=f.queries.length
    await api.withSwarmStudioInvocation(scope('swarm-owner'),async()=>{
      assert.equal(await api.identityForRequest(request),null)
      assert.equal(f.queries.length,before)
      const quota=await api.reserveDailyQuota(request,'doc',{userPerDay:5})
      assert.equal(quota.ok,true);assert.equal(f.subjects.at(-1),'user:swarm-owner')
      api.assertSwarmStudioPolicyApplied('doc',true)
    })
  })
  await check('real PG receipt refunds once on failed Swarm work and original day',async()=>{
    await assert.rejects(api.withSwarmStudioInvocation(scope('refund-owner'),async()=>{
      const quota=await api.reserveDailyQuota(request,'image',{userPerDay:5});await quota.release();throw Error('Cancelled')
    }),/Cancelled/)
    assert.equal(db.prepare("SELECT count FROM nalu_usage WHERE subject='user:refund-owner' AND kind='image'").get().count,0)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM nalu_usage_reservations WHERE subject='user:refund-owner' AND released=TRUE").get().n,1)
  })
  await check('metering outages remain fail-closed, not anonymous or unlimited',async()=>{
    f.fail=true
    await api.withSwarmStudioInvocation(scope('outage-owner'),async()=>{
      const quota=await api.reserveDailyQuota(request,'video');assert.equal(quota.ok,false);assert.equal(quota.status,503)
      assert.throws(()=>api.assertSwarmStudioPolicyApplied('video',false))
    })
    f.fail=false
  })
  await check('the real document handler includes scope evidence without any account memory',async()=>{
    const before=f.accountReads, tokenReads=f.tokenReads
    await api.withSwarmStudioInvocation(scope('doc-owner'),async()=>{
      let payload,status=200
      const res={setHeader(){},status(code){status=code;return this},json(value){payload=value;return this}}
      await api.doc({method:'POST',headers:request.headers,body:{prompt:'Write a short project brief.',messages:[{role:'user',content:'APPROVED_THREAD_EVIDENCE'}],material:'APPROVED_PROJECT_BRIEF',memory:''}},res)
      assert.equal(status,200);assert.ok(payload.blocks.length)
      api.assertSwarmStudioPolicyApplied('doc',true)
    })
    assert.equal(f.accountReads,before);assert.equal(f.tokenReads,tokenReads)
    const prompts=JSON.stringify(f.prompts)
    assert.match(prompts,/APPROVED_THREAD_EVIDENCE/);assert.match(prompts,/APPROVED_PROJECT_BRIEF/)
    assert.doesNotMatch(prompts,/PRIVATE_PERSONAL_PROFILE|PRIVATE_ACCOUNT_MEMORY|Personal Name|forged-owner/)
  })
  await check('Cloudflare uses the same owner guard and preserves async task isolation',async()=>{
    process.env.NALU_STORAGE_BACKEND='cloudflare';const before=f.tokenReads
    await Promise.all(['alpha','beta'].map(owner=>api.withSwarmStudioInvocation(scope(owner),async()=>{
      await Promise.resolve();assert.equal(await api.identityForRequest(request),null)
      const quota=await api.reserveDailyQuota(request,'design',{userPerDay:4});assert.equal(quota.ok,true)
      await Promise.resolve();assert.equal(api.swarmStudioInvocation().ownerId,owner)
      api.assertSwarmStudioPolicyApplied('design',true)
    })))
    assert.equal(f.tokenReads,before);assert.ok(f.subjects.includes('user:alpha'));assert.ok(f.subjects.includes('user:beta'))
    assert.equal(api.swarmStudioInvocation(),undefined)
  })
  await check('registry email wrapper meters the real draft handler and refunds failed drafts',async()=>{
    delete process.env.NALU_STORAGE_BACKEND;f.email=true
    for(const failure of [false,true]){
      f.generationFailure=failure;const owner=failure?'email-failed':'email-owner'
      await api.withSwarmStudioInvocation(scope(owner),async()=>{
        let payload,status=200;const res={setHeader(){},status(code){status=code;return this},json(value){payload=value;return this}}
        await api.swarmStudioHandlers.email({method:'POST',headers:request.headers,body:{prompt:'Draft an update.',messages:[{role:'user',content:'APPROVED_EMAIL_CONTEXT'}],material:'APPROVED_EMAIL_BRIEF',memory:''}},res)
        assert.equal(status,failure?502:200)
        if(!failure){assert.equal(payload.subject,'Project update');api.assertSwarmStudioPolicyApplied('email',true)}
      })
      assert.equal(db.prepare('SELECT count FROM nalu_usage WHERE subject=? AND kind=\'email\'').get(`user:${owner}`).count,failure?0:1)
    }
    assert.equal(f.accountReads,0);assert.doesNotMatch(JSON.stringify(f.prompts),/PRIVATE_PERSONAL_PROFILE|PRIVATE_ACCOUNT_MEMORY/)
    f.email=false;f.generationFailure=false
  })
  await check('unlimited configured owner allowance is still scoped and observed',async()=>{
    await api.withSwarmStudioInvocation(scope('unlimited-owner'),async()=>{
      const quota=await api.reserveDailyQuota(request,'doc',{userPerDay:0});assert.equal(quota.ok,true);assert.equal(quota.signedIn,true)
      api.assertSwarmStudioPolicyApplied('doc',false)
    })
  })
  console.log(`${cases} real Swarm identity/quota integration regressions passed.`)
} finally {
  for(const[key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value
  globalThis.fetch=originalFetch;delete globalThis.swarmHookFixture;db.close()
}
