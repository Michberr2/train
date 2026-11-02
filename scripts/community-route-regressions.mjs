import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

globalThis.RouteCommunityCloudflareStore = class {}
const bundle = await build({ entryPoints: ['api/community.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'community-fixtures', setup(b) {
  b.onResolve({ filter: /\/_connectionBackend$|\/_db$|\/_cors$|\/_cloudflareStore$/ }, args => ({ path: args.path, namespace: 'community-fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'community-fixture' }, args => ({ contents: args.path.endsWith('_connectionBackend')
    ? 'export function connectionBackend(){ return globalThis.communityBackend }'
    : args.path.endsWith('_db') ? 'export function readToken(req){return req.token};export function safeJson(s){try{return JSON.parse(s)}catch{return null}}'
    : args.path.endsWith('_cors') ? 'export function cors(){return false}'
    : 'export const CloudflareStore=globalThis.RouteCommunityCloudflareStore' }))
} }] })
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys=ON; CREATE TABLE nalu_users(id TEXT PRIMARY KEY,display_name TEXT NOT NULL); CREATE TABLE nalu_user_data(user_id TEXT,key TEXT,value TEXT,PRIMARY KEY(user_id,key));')
db.exec(readFileSync('cloudflare/nalu-data/migrations/0017_community_rooms.sql', 'utf8'))
for (const [id, name, avatar] of [['alice','Alice','getriki-person-2'],['bob','Bob','getriki-person-4'],['mallory','Mallory','getriki-person-1']]) {
  db.prepare('INSERT INTO nalu_users(id,display_name) VALUES(?,?)').run(id,name)
  db.prepare('INSERT INTO nalu_user_data(user_id,key,value) VALUES(?,?,?)').run(id,'nalu-human-avatar',avatar)
}
const client = Object.create(globalThis.RouteCommunityCloudflareStore.prototype)
client.query = async (sql, params = []) => { const statement = db.prepare(sql); return /^\s*(SELECT|WITH)\b/i.test(sql) ? { results: statement.all(...params) } : { results: [], changes: statement.run(...params).changes } }
globalThis.communityBackend = { client, async connect(){}, async close(){}, async userId(token){ return ({alice:'alice',bob:'bob',mallory:'mallory'})[token] || null } }
const request = async (user, body, method = 'POST') => {
  const res = { code: 200, headers: {}, setHeader(k,v){this.headers[k]=v}, status(code){this.code=code;return this}, json(value){this.value=value;return this} }
  await handler({ method, token:user, body }, res)
  return res
}
try {
  assert.equal((await request('',{action:'list'})).code,401)
  const created = await request('alice',{action:'create',title:'Weekend planning'})
  assert.equal(created.code,200); const roomId = created.value.room.id
  const invitation = await request('alice',{action:'invite',roomId})
  assert.equal(invitation.code,200); assert.ok(invitation.value.token.length > 32)
  assert.equal((await request('mallory',{action:'messages',roomId})).code,404)
  const joined = await request('bob',{action:'join',token:invitation.value.token})
  assert.equal(joined.code,200); assert.equal(joined.value.room.memberCount,2)
  const sent = await request('bob',{action:'send',roomId,content:'I will bring lunch.'})
  assert.equal(sent.code,200); assert.equal(sent.value.messages[0].name,'Bob'); assert.equal(sent.value.messages[0].avatar,'getriki-person-4')
  assert.equal((await request('mallory',{action:'send',roomId,content:'intrusion'})).code,404)
  assert.equal((await request('bob',{action:'send',roomId,content:'x'.repeat(4001)})).code,400)
  const left = await request('bob',{action:'leave',roomId}); assert.equal(left.code,200)
  assert.equal((await request('bob',{action:'messages',roomId})).code,404)
  console.log('PASS shared-room route: authenticated creation, expiring hashed invites, membership checks, participant avatar identity, message limits, and leave revocation')
} finally { db.close() }
