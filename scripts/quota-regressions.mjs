// Real quota code and SQL counter behavior, isolated from accounts/providers.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const require = createRequire(import.meta.url)
const original = { VERCEL:process.env.VERCEL,NALU_STORAGE_BACKEND:process.env.NALU_STORAGE_BACKEND }
const db = new DatabaseSync(':memory:')
db.function('GREATEST', {varargs:true}, (...values) => Math.max(...values))
let fail = '', uid = null, day = '2026-10-18', refunds = 0, subjects = [], loseCommitAcknowledgement = false
globalThis.__quota = {
  readToken:req => req.headers?.authorization || null,
  async userIdForToken() { if (fail === 'identity') throw new Error('identity unavailable'); return uid },
  getClient() {
    if (fail === 'config') throw new Error('no configuration')
    return {
      async connect() { if (fail === 'connect') throw new Error('database unavailable') },
      async end() {},
      async query(sql,params=[]) {
        if (fail === 'query') throw new Error('database unavailable')
        if (sql.includes('INSERT INTO nalu_usage (')) subjects.push(params[0])
        if (sql.includes('UPDATE nalu_usage SET count')) refunds++
        const translated = sql.replace(/\$(\d+)::date/g,'?$1').replace(/\$(\d+)/g,'?$1').replace(/day::text/g,'CAST(day AS TEXT)').replace(/CURRENT_DATE/g,`'${day}'`)
        if (/CREATE TABLE|^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
          db.exec(translated)
          if (sql === 'COMMIT' && loseCommitAcknowledgement) {loseCommitAcknowledgement=false;throw new Error('Committed but connection closed before acknowledgement')}
          return {rows:[]}
        }
        return {rows:db.prepare(translated).all(...params)}
      },
    }
  },
  connectionBackend() { if (fail) throw new Error('cloud unavailable'); return {client:{},userId:async()=>uid} },
  reserveCloudflareQuota:async(_store,subject,_kind,limit)=>{subjects.push(subject);return {ok:true,used:1,limit,release:async()=>{}}},
}
const bundle = await build({entryPoints:['api/_limits.ts'],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',plugins:[{name:'quota-storage',setup(build){
  build.onResolve({filter:/^\.\/_(db|connectionBackend|cloudflareQuota)$/},args=>({path:args.path,namespace:'quota-fixture'}))
  build.onLoad({filter:/.*/,namespace:'quota-fixture'},({path})=>({contents:path==='./_db'?'export const {getClient,readToken,userIdForToken}=globalThis.__quota':path==='./_connectionBackend'?'export const {connectionBackend}=globalThis.__quota':'export const {reserveCloudflareQuota}=globalThis.__quota',loader:'js'}))
}}]})
const module = {exports:{}}
new Function('require','module','exports',bundle.outputFiles[0].text)(require,module,module.exports)
const {reserveDailyQuota,studioLimitMessage} = module.exports
const req = headers => ({headers:headers || {},socket:{remoteAddress:'198.51.100.2'}})
try {
  delete process.env.VERCEL; delete process.env.NALU_STORAGE_BACKEND
  for (const phase of ['config','connect','query','identity']) {
    fail=phase
    const q=await reserveDailyQuota(req(),'outage',{anonPerDay:3,userPerDay:5})
    assert.equal(q.ok,false);assert.equal(q.status,503);assert.equal(q.reason,'unavailable')
    assert.match(studioLimitMessage('design',q),/temporarily unavailable/)
    await q.release()
  }
  fail=''
  const a=await reserveDailyQuota(req({'x-nalu-device':'device1','user-agent':'one','cookie':'nalu_did=a','x-forwarded-for':'1.1.1.1'}),'guest',{anonPerDay:2})
  const b=await reserveDailyQuota(req({'x-nalu-device':'device2','user-agent':'two','cookie':'nalu_did=%broken','accept-language':'fr','x-forwarded-for':'8.8.8.8'}),'guest',{anonPerDay:2})
  const denied=await reserveDailyQuota(req(),'guest',{anonPerDay:2})
  assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(denied.ok,false);assert.equal(denied.status,429)
  assert.equal(new Set(subjects).size,1,'rotated client headers cannot reset allowance')
  const before=refunds
  day='2026-10-19'
  await Promise.all([a.release(),a.release(),a.release()]);await a.release()
  assert.equal(refunds-before,1,'concurrent/repeated failure cleanup refunds once')
  assert.equal(db.prepare("SELECT count FROM nalu_usage WHERE kind='guest' AND day='2026-10-18'").get().count,1,'refund targets original reservation day')
  const beforeLostAck=refunds
  loseCommitAcknowledgement=true
  await b.release()
  assert.equal(refunds-beforeLostAck,1,'a lost commit acknowledgement must not apply the refund twice')
  assert.equal(db.prepare("SELECT count FROM nalu_usage WHERE kind='guest' AND day='2026-10-18'").get().count,0)
  uid='account-one'
  assert.equal((await reserveDailyQuota(req(),'guest',{anonPerDay:2,userPerDay:5})).signedIn,true)
  assert.equal(subjects.at(-1),'user:account-one')
  uid=null;process.env.VERCEL='1'
  await reserveDailyQuota(req({'x-forwarded-for':'1.1.1.1'}),'edge',{anonPerDay:2})
  await reserveDailyQuota(req({'x-forwarded-for':'8.8.8.8'}),'edge',{anonPerDay:2})
  assert.notEqual(subjects.at(-1),subjects.at(-2),'trusted Vercel edge separates networks')
  process.env.NALU_STORAGE_BACKEND='cloudflare';fail='cloud'
  const cloud=await reserveDailyQuota(req(),'cloud')
  assert.equal(cloud.ok,false);assert.equal(cloud.status,503)
  fail='';uid='cloud-user'
  assert.equal((await reserveDailyQuota(req(),'cloud')).ok,true)
  assert.equal(subjects.at(-1),'user:cloud-user')
  console.log('PASS metering/identity outages fail closed, guest rotation cannot mint allowance, account/edge separation, exact-day concurrent refunds, Cloudflare availability behavior.')
} finally {
  for (const [key,value] of Object.entries(original)) { if (value===undefined) delete process.env[key]; else process.env[key]=value }
  delete globalThis.__quota;db.close()
}
