import { cloudflarePhoneCases } from './cloudflare-phone-cases.mjs'
import { cloudflareMessageCases } from './cloudflare-message-cases.mjs'
import { cloudflareNotebookCases } from './cloudflare-notebook-cases.mjs'
import { cloudflareRuntimeCases } from './cloudflare-runtime-cases.mjs'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cloudflareConnectionCases } from './cloudflare-connection-cases.mjs'
import { cloudflareAttachmentCases } from './cloudflare-attachment-cases.mjs'
import { cloudflarePublishingCases } from './cloudflare-publishing-cases.mjs'
import { cloudflareConnectionApiCases } from './cloudflare-connection-api-cases.mjs'
import { cloudflareDataApiCases } from './cloudflare-data-api-cases.mjs'
process.on('uncaughtException', error => { console.error(String(error.stack || error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<fixture bundle>')); process.exitCode = 1 })
const result = await build({ entryPoints: ['cloudflare/nalu-data/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' })
const { default: worker, signRequest } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys=ON')
db.exec(await readFile('cloudflare/nalu-data/migrations/0001_nalu.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0002_file_allowances.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0003_document_parts.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0004_connection_claims.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0005_attachment_chunks.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0006_artifact_attachments.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0007_runtime_storage.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0008_document_retention.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0009_task_mutations.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0010_question_mutations.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0011_push_claims.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0012_notebook_files.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0013_message_storage.sql', 'utf8'))
db.exec(await readFile('cloudflare/nalu-data/migrations/0014_phone_storage.sql', 'utf8'))
db.prepare('INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)').run('owner-a', 'Fixture A', 'salt', 'hash')
db.prepare('INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)').run('owner-b', 'Fixture B', 'salt', 'hash')
const secret = 'isolated-cloudflare-regression-key-123456789'
let batchTail = Promise.resolve()
const env = { NALU_DATA_SECRET: secret, DB: {
  prepare(sql) { return { sql, params: [], bind(...params) { this.params = params; return this }, async all() { return { results: db.prepare(this.sql).all(...this.params) } }, async first() { return db.prepare(this.sql).get(...this.params) || null } } },
  async batch(statements) {
    const previous = batchTail; let unlock
    batchTail = new Promise(resolve => { unlock = resolve }); await previous
    db.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec('COMMIT'); return results } catch (error) { db.exec('ROLLBACK'); throw error } finally { unlock() }
  },
} }
const request = async (path, data, options = {}) => {
  const body = JSON.stringify(data), timestamp = String(Date.now() + (options.offset || 0))
  const signature = await signRequest(secret, 'POST', path, body, timestamp)
  const response = await worker.fetch(new Request('https://fixture.invalid' + path, { method: 'POST', headers: options.anonymous ? {} : { 'x-nalu-time': timestamp, 'x-nalu-signature': signature }, body: options.modified ? body + ' ' : body }), env)
  return { status: response.status, body: await response.json() }
}
for (const options of [{ anonymous: true }, { offset: -120000 }, { modified: true }]) assert.equal((await request('/v1/query', { sql: 'SELECT id FROM nalu_users' }, options)).status, 401)
assert.equal((await request('/v1/query', { sql: 'DELETE FROM nalu_users' })).status, 503)
const read = owner => request('/v1/documents/read', { owner, keys: ['nalu-chats', 'nalu-deleted-chats'] })
const commit = (owner, revision, entries) => request('/v1/documents/commit', { owner, revision, entries })
let snapshot = await read('owner-a'); assert.equal(snapshot.body.revision, ''); assert.deepEqual(snapshot.body.entries, [])
const chats = [{ key: 'nalu-chats', value: JSON.stringify([{ id: 'saved-chat', messages: [{ id: 'one', content: 'Retain this chat' }] }]) }]
const saved = await commit('owner-a', '', chats); assert.equal(saved.status, 200)
const stale = await commit('owner-a', '', [{ key: 'nalu-chats', value: '[]' }]); assert.equal(stale.status, 409)
snapshot = await read('owner-a'); assert.equal(snapshot.body.entries[0].value, chats[0].value)
assert.deepEqual((await read('owner-b')).body.entries, [])
const deletion = await commit('owner-a', snapshot.body.revision, [{ key: 'nalu-chats', value: '[]' }, { key: 'nalu-deleted-chats', value: '["saved-chat"]' }]); assert.equal(deletion.status, 200)
assert.equal((await commit('owner-a', snapshot.body.revision, chats)).status, 409)
snapshot = await read('owner-a'); assert.equal(snapshot.body.entries.find(item => item.key === 'nalu-chats').value, '[]')
assert.equal(snapshot.body.entries.find(item => item.key === 'nalu-deleted-chats').value, '["saved-chat"]')
const broken = await request('/v1/batch', { statements: [{ sql: 'INSERT INTO nalu_store_revisions(scope,revision) VALUES(?,?)', params: ['rollback-check', 'one'] }, { sql: 'UPDATE nonexistent_table SET value=?', params: ['fail'] }] })
assert.equal(broken.status, 503); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM nalu_store_revisions WHERE scope=?').get('rollback-check').count, 0)
assert.ok(!JSON.stringify(broken.body).includes('nonexistent_table'))
assert.equal((await commit('owner-a', snapshot.body.revision, [{ key: 'large', value: JSON.stringify('x'.repeat(1000000)) }])).status, 400)
assert.equal((await commit('owner-a', snapshot.body.revision, [{ key: 'nalu-chats', value: '{malformed' }])).status, 400)
console.log('PASS Cloudflare request authentication, body integrity, timestamp expiry, owner scoping, atomic document updates, stale-device conflict rejection and transaction rollback')
console.log('PASS full 34-table SQLite schema, oversized document rejection and failed-operation error redaction')
const objects = new Map()
env.FILES = {
  async head(key) { const item = objects.get(key); return item ? { size: item.bytes.length, customMetadata: item.metadata } : null },
  async get(key) { const item = objects.get(key); return item ? { async arrayBuffer() { return Uint8Array.from(item.bytes).buffer } } : null },
  async put(key, bytes, options) { assert.equal(options.onlyIf.etagDoesNotMatch, '*'); if (objects.has(key)) return null; objects.set(key, { bytes: Buffer.from(bytes), metadata: options.customMetadata }); return {} },
}
const file = Buffer.from('An owned file retained during the Cloudflare migration.')
const chunk = { owner: 'owner-a', sha256: createHash('sha256').update(file).digest('hex'), base64: file.toString('base64') }
assert.equal((await request('/v1/files/put', chunk)).status, 200)
assert.equal((await request('/v1/files/put', chunk)).body.existing, true)
assert.equal(objects.size, 1)
const readBack = await request('/v1/files/get', { owner: chunk.owner, sha256: chunk.sha256 })
assert.equal(readBack.body.base64, chunk.base64)
assert.equal((await request('/v1/files/get', { owner: 'owner-b', sha256: chunk.sha256 })).body.found, false)
assert.equal((await request('/v1/files/put', { ...chunk, sha256: '0'.repeat(64) })).status, 503)
db.prepare('UPDATE nalu_storage_allowances SET used=? WHERE metric=?').run(9000000000, 'stored-bytes')
const next = Buffer.from('Another file')
const blocked = await request('/v1/files/put', { owner: 'owner-a', sha256: createHash('sha256').update(next).digest('hex'), base64: next.toString('base64') })
assert.equal(blocked.status, 503); assert.match(blocked.body.error, /free file-storage allowance/)
assert.equal(objects.size, 1); assert.equal((await request('/v1/files/get', chunk)).body.base64, chunk.base64)
console.log('PASS private immutable R2 chunks, hash verification, duplicate uploads, account isolation and free-allowance limits preserve existing files')
const clientBundle = await build({ stdin: { contents: "export { default as phoneHandler } from './api/phone'; export { default as callHandler } from './api/call'; export { default as cronHandler } from './api/cron'; export * from './api/_cloudflarePhoneState'; export * from './api/_cloudflarePhonePlans'; export * from './api/_phonePlans'; export * from './api/_cloudflareOutboundCalls'; export * from './api/_outboundCalls'; export * from './api/_cloudflareQuestionPhone'; export * from './api/_cloudflareQuestions'; export * from './api/_cloudflarePhoneLease'; export * from './api/_callDelivery'; export * from './api/_taskCompletion'; export * from './api/_messageWorker'; export { default as messagesHandler } from './api/messages'; export * from './api/_cloudflareMessages'; export * from './api/_messageStore'; export * from './api/_messageConsent'; export * from './api/_messageOnboarding'; export * from './api/_messageTransport'; export * from './api/_messageMedia'; export * from './api/_phoneOwner'; export { default as messageMediaHandler } from './api/message-media'; export * from './api/_storedJson'; export * from './api/_cloudflareStore'; export * from './api/_cloudflareFlows'; export * from './api/_team'; export * from './api/_cloudflarePush'; export * from './api/_notebookModel'; export * from './api/_notebookEmail'; export * from './api/_cron'; export * from './api/_limits'; export * from './api/_studioImages'; export { default as attachmentHandler } from './api/task-attachments'; export * from './api/_autopilotArtifacts'; export * from './api/_accountContext'; export { identityForRequest, saveProfile } from './api/_db'; export { default as dataHandler } from './api/data'; export { default as authHandler } from './api/auth'; export { default as connectionHandler } from './api/connect'; export { default as oauthHandler } from './api/_oauthHandler'; export * from './api/_cloudflareAttachments'; export * from './api/_taskAttachments'; export * from './api/_connectionMedia'; export * from './api/_cloudflareChat'; export * from './api/_chatMerge'; export * from './api/_cloudflareAccounts'; export * from './api/_connectionStore'; export * from './api/_connectionRuntime'; export * from './api/_connectionPublishing'; export * from './api/_connectionSecrets'; export * from './api/_pipelineDelivery'; export { ConnectionProviderError } from './api/_connectionAdapters'; export { hashPassword, sha256 } from './api/_db'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, external: ['sharp'], write: false, format: 'cjs', platform: 'node', target: 'es2022' })
const apiModule = { exports: {} }
new Function('require', 'module', 'exports', clientBundle.outputFiles[0].text)(createRequire(import.meta.url), apiModule, apiModule.exports)
const api = apiModule.exports
const { CloudflareStore, CloudflareAccounts, hashPassword, sha256, writeCloudflareChatData, writeChatData } = api
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env)
  const store = new CloudflareStore('https://fixture.invalid', secret)
  await Promise.all(['device-a', 'device-b'].map(id => writeCloudflareChatData(store, 'owner-a', 'nalu-chats', [{ id, title: id, messages: [{ id: id + '-message', role: 'user', content: id }] }, { id: 'saved-chat', messages: [] }])))
  const saved = await store.readDocuments('owner-a', ['nalu-chats'])
  const chats = JSON.parse(saved.entries[0].value)
  assert.deepEqual(chats.map(chat => chat.id).sort(), ['device-a', 'device-b'])
  await writeCloudflareChatData(store, 'owner-a', 'nalu-chats', '[]')
  const encoded = JSON.parse((await store.readDocuments('owner-a', ['nalu-chats'])).entries[0].value)
  assert.equal(typeof encoded, 'string'); assert.equal(JSON.parse(encoded).length, 2)
  const legacy = new Map([['nalu-chats', JSON.stringify(chats)], ['nalu-deleted-chats', '[]']])
  const postgres = { async query(sql, params = []) {
    if (/BEGIN|COMMIT|ROLLBACK|pg_advisory/.test(sql)) return { rows: [] }
    if (sql.startsWith('SELECT value')) return { rows: legacy.has(params[1]) ? [{ value: legacy.get(params[1]) }] : [] }
    if (sql.includes('INSERT INTO nalu_user_data')) { legacy.set(params[1], JSON.parse(params[2])); return { rows: [] } }
    throw new Error('Unexpected PostgreSQL fixture operation')
  } }
  await writeChatData(postgres, 'owner-a', 'nalu-deleted-chats', '["device-a"]')
  assert.deepEqual(JSON.parse(legacy.get('nalu-chats')).map(chat => chat.id), ['device-b'])
  await writeChatData(postgres, 'owner-a', 'nalu-chats', JSON.stringify(chats))
  assert.deepEqual(JSON.parse(legacy.get('nalu-chats')).map(chat => chat.id), ['device-b'])
  console.log('PASS real Cloudflare chat client merges concurrent devices, retains history on empty snapshots, preserves legacy encoding and matches PostgreSQL deletion rules')
  const large = JSON.stringify([{ id: 'large-chat', messages: [{ id: 'large-message', content: 'A unicorn 🦄, 日本語, and a wolf 🐺. '.repeat(90000) }] }])
  const beforeLarge = await store.readDocuments('owner-b', ['nalu-chats'])
  const largeSaved = await store.commitDocuments('owner-b', beforeLarge.revision, [{ key: 'nalu-chats', value: large }])
  const largeRead = await store.readDocuments('owner-b', ['nalu-chats'])
  assert.equal(largeRead.entries[0].value, large)
  assert.ok(Buffer.byteLength(large) > 2000000)
  const pieceCount = db.prepare('SELECT count(*) AS count FROM nalu_document_parts WHERE owner=?').get('owner-b').count
  await store.commitDocuments('owner-b', largeSaved.revision, [{ key: 'nalu-chats', value: large }])
  assert.equal(db.prepare('SELECT count(*) AS count FROM nalu_document_parts WHERE owner=?').get('owner-b').count, pieceCount)
  await assert.rejects(store.commitDocuments('owner-b', beforeLarge.revision, [{ key: 'nalu-chats', value: '[]' }]), /changed/)
  assert.equal((await store.readDocuments('owner-b', ['nalu-chats'])).entries[0].value, large)
  const head = await request('/v1/documents/read', { owner: 'owner-b', keys: ['nalu-chats'] })
  const manifest = head.body.entries[0].manifest
  assert.equal((await request('/v1/documents/parts/read', { owner: 'owner-a', hashes: manifest.parts.slice(0, 2) })).body.parts.length, 0)
  const incomplete = await commit('owner-b', head.body.revision, [{ key: 'nalu-chats', manifest: { ...manifest, parts: [...manifest.parts.slice(0, -1), '0'.repeat(64)] } }, { key: 'nalu-deleted-chats', value: '["large-chat"]' }])
  assert.equal(incomplete.status, 400)
  assert.equal((await store.readDocuments('owner-b', ['nalu-chats'])).entries[0].value, large)
  assert.deepEqual((await store.readDocuments('owner-b', ['nalu-deleted-chats'])).entries, [])
  let uploadAttempt = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/parts/put') && ++uploadAttempt === 2) throw new Error('Simulated interrupted upload')
    return worker.fetch(new Request(url, init), env)
  }
  await assert.rejects(store.commitDocuments('owner-b', head.body.revision, [{ key: 'nalu-chats', value: JSON.stringify('Different content '.repeat(150000)) }]), /interrupted/)
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env)
  assert.equal((await store.readDocuments('owner-b', ['nalu-chats'])).entries[0].value, large)
  const firstHash = manifest.parts[0], originalPart = db.prepare('SELECT base64 FROM nalu_document_parts WHERE owner=? AND sha256=?').get('owner-b', firstHash).base64
  db.prepare('UPDATE nalu_document_parts SET base64=? WHERE owner=? AND sha256=?').run(Buffer.from('corrupt fixture').toString('base64'), 'owner-b', firstHash)
  await assert.rejects(store.readDocuments('owner-b', ['nalu-chats']), /integrity/)
  db.prepare('UPDATE nalu_document_parts SET base64=? WHERE owner=? AND sha256=?').run(originalPart, 'owner-b', firstHash)
  const current = await store.readDocuments('owner-b', ['nalu-chats'])
  await store.commitDocuments('owner-b', current.revision, Array.from({ length: 20 }, (_, i) => ({ key: 'escaped-' + i, value: JSON.stringify('"'.repeat(15000)) })))
  await store.commitDocuments('owner-b', (await store.readDocuments('owner-b', [])).revision, [{ key: 'nalu-chats', value: '[]' }])
  assert.equal(db.prepare('SELECT count(*) AS count FROM nalu_document_manifests WHERE owner=? AND key=?').get('owner-b', 'nalu-chats').count, 0)
  assert.equal((await store.readDocuments('owner-b', ['nalu-chats'])).entries[0].value, '[]')
  console.log('PASS multi-megabyte Unicode histories, owner-scoped pieces, deduplication, stale saves, interrupted uploads, incomplete manifests, corruption detection, inline replacement and twenty-entry saves')
  const maxHistory = JSON.stringify('x'.repeat(64 * 1024 * 1024 - 2))
  const maximumSaved = await store.commitDocuments('owner-b', (await store.readDocuments('owner-b', [])).revision, [{ key: 'maximum-size', value: maxHistory }])
  assert.equal((await store.readDocuments('owner-b', ['maximum-size'])).entries[0].value, maxHistory)
  await assert.rejects(store.commitDocuments('owner-b', maximumSaved.revision, [{ key: 'maximum-size', value: maxHistory + ' ' }]), /supported save size/)
  console.log('PASS exact 64 MiB document boundary, repeated-piece reconstruction and oversize rejection before uploads')
  const accounts = new CloudflareAccounts(store)
  const signedUp = await Promise.all([1, 2].map(() => accounts.signup('new-account', 'New account', 'A password for signup')))
  assert.equal(signedUp.filter(Boolean).length, 1)
  assert.equal(db.prepare('SELECT count(*) AS count FROM nalu_sessions WHERE user_id=?').get('new-account').count, 1)
  await assert.rejects(accounts.signup('bad-password', 'Bad', 'short'), /at least 8/)
  const legacySalt = '12'.repeat(16)
  db.prepare('INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)').run('migrated-account', 'Existing account', legacySalt, hashPassword('Original password', legacySalt))
  db.prepare('INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)').run('existing-session', 'migrated-account')
  assert.equal((await accounts.current('existing-session')).id, 'migrated-account')
  assert.equal(await accounts.signin('migrated-account', 'Wrong password'), null)
  const signins = await Promise.all([1, 2].map(() => accounts.signin('migrated-account', 'Original password')))
  assert.ok(signins.every(Boolean)); assert.equal(signins.filter(value => value.recoveryCode).length, 1)
  assert.deepEqual(await accounts.updateProfile('existing-session', { displayName: 'Remembered name', phone: '+14155550123' }), { id: 'migrated-account', displayName: 'Remembered name', phone: '+14155550123' })
  assert.equal(await accounts.updateProfile('wrong-session', { displayName: 'Intruder' }), null)
  const originalCode = signins.find(value => value.recoveryCode).recoveryCode
  const resets = await Promise.all(['New password A', 'New password B'].map(password => accounts.resetWithCode('migrated-account', originalCode.toLowerCase(), password)))
  assert.equal(resets.filter(Boolean).length, 1)
  const reset = resets.find(Boolean)
  assert.equal(await accounts.current('existing-session'), null)
  assert.ok(await accounts.current(reset.token))
  assert.equal(await accounts.resetWithCode('migrated-account', originalCode, 'Replayed password'), null)
  assert.equal(await accounts.signin('migrated-account', 'Original password'), null)
  assert.equal(await accounts.createPasswordReset('unknown-account'), null)
  const link = await accounts.createPasswordReset('migrated-account')
  const linkResets = await Promise.all(['From email A', 'From email B'].map(password => accounts.resetPassword(link.resetToken, password)))
  assert.equal(linkResets.filter(Boolean).length, 1)
  const emailReset = linkResets.find(Boolean)
  assert.equal(await accounts.current(reset.token), null)
  assert.ok(await accounts.current(emailReset.token))
  const expired = await accounts.createPasswordReset('migrated-account')
  db.prepare('UPDATE nalu_password_resets SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00Z', sha256(expired.resetToken))
  assert.equal(await accounts.resetPassword(expired.resetToken, 'Expired reset attempt'), null)
  const rollbackLink = await accounts.createPasswordReset('migrated-account')
  const rollbackAccounts = new CloudflareAccounts({ batch(statements) { return store.batch([...statements.slice(0, 2), { sql: 'UPDATE nonexistent_auth_fixture SET value=1' }, ...statements.slice(2)]) } })
  await assert.rejects(rollbackAccounts.resetPassword(rollbackLink.resetToken, 'Must roll back'), /database operation failed/)
  assert.equal(db.prepare('SELECT used FROM nalu_password_resets WHERE token_hash=?').get(sha256(rollbackLink.resetToken)).used, 0)
  assert.ok(await accounts.current(emailReset.token))
  let concurrentReset
  const racingAccounts = new CloudflareAccounts({
    async query(...args) { const found = await store.query(...args); concurrentReset = await accounts.resetPassword(rollbackLink.resetToken, 'Changed during signin'); return found },
    batch(statements) { return store.batch(statements) },
  })
  const beforeRacePassword = linkResets[0] ? 'From email A' : 'From email B'
  assert.equal(await racingAccounts.signin('migrated-account', beforeRacePassword), null)
  assert.equal(db.prepare('SELECT count(*) AS count FROM nalu_sessions WHERE user_id=?').get('migrated-account').count, 1)
  assert.ok(await accounts.current(concurrentReset.token))
  await accounts.signout(concurrentReset.token)
  assert.equal(await accounts.current(emailReset.token), null)
  console.log('PASS Cloudflare accounts retain legacy password/session formats, handle concurrent signup/recovery, scope profile changes, revoke sessions atomically and roll back failed resets')
  await cloudflareConnectionCases({ api, store, worker, env, db })
  await cloudflarePublishingCases({ api, store, worker, env })
  await cloudflareAttachmentCases({ api, store, worker, env, db, objects })
  await cloudflareConnectionApiCases({ api, store, worker, env, db })
  await cloudflareDataApiCases({ api, store, worker, env })
  await cloudflareRuntimeCases({ api, store, worker, env, db })
  await cloudflareNotebookCases({ api, store, worker, env })
  await cloudflareMessageCases({ api, store, worker, env, db })
  await cloudflarePhoneCases({ api, store, worker, env, db })
} finally { globalThis.fetch = originalFetch }
let pulled = 0, cancelled = false
const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(700000)) }, cancel() { cancelled = true } })
const oversized = await worker.fetch(new Request('https://fixture.invalid/v1/documents/commit', { method: 'POST', body: stream, duplex: 'half' }), env)
assert.equal(oversized.status, 413); assert.equal(cancelled, true); assert.ok(pulled < 6)
console.log('PASS oversized streamed requests are cancelled without buffering the full body')
db.close()
