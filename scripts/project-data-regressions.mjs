import assert from 'node:assert/strict'
import { database, request } from './fixtures/project-data-database.mjs'
import { projectDataCases } from './fixtures/project-data-cases.mjs'

const savedFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Project regression tests cannot access the network') }
try {
  const db = database()
  const checks = await projectDataCases(body => request(db, body))
  assert.equal(db.connections, db.closes)
  assert.equal(db.locks.size, 0)
  const rollback = database()
  rollback.seed('nalu-chat-projects', [{ id: 'retain', name: 'Retain me' }])
  rollback.beforeQuery = async (sql, params) => {
    if (sql.startsWith('INSERT INTO nalu_user_data') && params[1] === 'nalu-deleted-projects') throw new Error('Fixture write failure')
  }
  assert.equal((await request(rollback, { action: 'set', key: 'nalu-deleted-projects', value: ['retain'] })).code, 500)
  assert.deepEqual(rollback.read('nalu-chat-projects'), [{ id: 'retain', name: 'Retain me' }])
  assert.equal(rollback.read('nalu-deleted-projects'), undefined)
  assert.equal(rollback.locks.size, 0)
  rollback.beforeQuery = null
  assert.equal((await request(rollback, { action: 'set', key: 'nalu-chat-projects', value: [{ id: 'other' }] }, 'fixture-other')).code, 200)
  assert.deepEqual(rollback.read('nalu-chat-projects').map(item => item.id), ['retain'])
  assert.deepEqual(rollback.read('nalu-chat-projects', 'other').map(item => item.id), ['other'])
  assert.equal((await request(rollback, { action: 'load' }, null)).code, 401)
  const html = '<!doctype html><title>Exact saved site</title><script>document.title="Active but isolated"</script><p>🐺 original content</p>'
  const shared = await request(db, { action: 'share', html })
  assert.equal(shared.code, 200)
  assert.equal(db.shares.get(shared.body.id), html)
  const opened = await request(db, {}, null, { share: shared.body.id })
  assert.equal(opened.code, 200)
  assert.match(opened.body, /🐺 original content/)
  assert.match(opened.headers['Content-Security-Policy'], /^sandbox /)
  assert.doesNotMatch(opened.headers['Content-Security-Policy'], /allow-same-origin|allow-popups-to-escape-sandbox/)
  assert.equal(opened.headers['Cache-Control'], 'no-store')
  const shareCount = db.shares.size
  assert.equal((await request(db, { action: 'share', html: 'x'.repeat(800001) })).code, 413)
  assert.equal(db.shares.size, shareCount, 'Oversize publication must not save truncated content')
  console.log(`PASS ${checks + 3} PostgreSQL handler project cases: concurrent creates, revision edits, visible conflict copies, legacy formats, idempotency, atomic deletes/rollback, malformed payloads and owner isolation`)
  console.log('PASS PostgreSQL public-share route isolates existing shares, stores accepted source exactly and rejects oversize without truncation')
} finally { globalThis.fetch = savedFetch }
