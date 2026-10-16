import { gzipSync } from 'node:zlib'
// Actual /api/data handler with isolated in-memory SQL/session services. Never
// connects to a database/provider. --reproduce documents the unpatched failures.
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const services = {
  './_cloudflareData': 'export const cloudflareData=()=>{throw new Error("Cloudflare is covered by its separate real SQLite/Worker suite")}',
  './_db': `export const getClient=()=>globalThis.__chatMergeStore.client();
    export async function ensureSchema(){}
    export async function userIdForToken(_client,token){return token==='fixture-owner'?'owner':token==='fixture-other'?'other':null}
    export const readToken=req=>(req.headers.authorization||'').replace(/^Bearer /,'');
    export const safeJson=value=>{try{return JSON.parse(value)}catch{return {}}};
    export const newToken=()=>{throw new Error('Unexpected token generation')};`,
  './_notebook': 'export const handleNotebook=async()=>false',
  './_notes': 'export const extractNotes=()=>{throw new Error("No model calls")}',
  './_limits': 'export const reserveDailyQuota=()=>{throw new Error("No provider actions")}',
  './_push': 'export const handlePushAction=async()=>false',
  './_tasks': 'export const handleTaskAction=async()=>false',
  './_cron': 'export const runDueCrons=()=>{throw new Error("No cron calls")}; export const runOneFlow=runDueCrons',
  './_messageMedia': 'export const mediaLink=()=>""',
  './_phoneOwner': 'export const ownsPhone=()=>false',
}
const bundled = await build({ entryPoints: ['api/data.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'isolated-data-services', setup(build) {
    build.onResolve({ filter: /^\.\/_/ }, ({ path }) => {
      if (path === './_chatMerge' || path === './_syncPayload' || path === './_projectData' || path === './_artifactIsolation') return undefined // Exercise the actual focused merge helper.
      assert.ok(path in services, `Unexpected service ${path}`)
      return { path, namespace: 'fixture' }
    })
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: services[path], loader: 'js' }))
  } }],
})
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const clone = value => structuredClone(value)
const decode = value => {
  for (let i = 0; i < 6 && typeof value === 'string'; i++) value = JSON.parse(value)
  return value
}
function database() {
  const values = new Map(), locks = new Map(), events = []
  let beforeQuery = null, connections = 0, closes = 0
  const storeKey = (owner, key) => `${owner}\0${key}`
  return {
    values, events, locks,
    set beforeQuery(value) { beforeQuery = value },
    get connections() { return connections }, get closes() { return closes },
    seed(key, value, owner = 'owner') { values.set(storeKey(owner, key), clone(value)) },
    read(key = 'nalu-chats', owner = 'owner') { const value = values.get(storeKey(owner, key)); return value === undefined ? undefined : decode(clone(value)) },
    client() {
      connections++
      let unlock = null, transaction = false
      const undo = new Map()
      const release = () => { unlock?.(); unlock = null }
      const remember = key => { if (transaction && !undo.has(key)) undo.set(key, values.has(key) ? clone(values.get(key)) : undefined) }
      return {
        async connect() {}, async end() { release(); closes++ },
        async query(sql, params = []) {
          const q = sql.trim().replace(/\s+/g, ' ')
          events.push({ q, params: clone(params) })
          await beforeQuery?.(q, params)
          if (q === 'BEGIN') { assert.equal(transaction, false, 'no transaction interleaving on a shared client'); transaction = true; return { rows: [] } }
          if (q === 'COMMIT' || q === 'ROLLBACK') {
            if (q === 'ROLLBACK') for (const [key, value] of undo) { if (value === undefined) values.delete(key); else values.set(key, value) }
            undo.clear(); transaction = false; release(); return { rows: [] }
          }
          if (q.includes('pg_advisory_xact_lock')) {
            const key = params.join('|'), previous = locks.get(key)
            let resolve
            const current = new Promise(done => { resolve = done })
            locks.set(key, current)
            if (previous) await previous
            unlock = () => { if (locks.get(key) === current) locks.delete(key); resolve() }
            return { rows: [] }
          }
          if (q.startsWith('SELECT value FROM nalu_user_data')) {
            const value = values.get(storeKey(params[0], params[1]))
            return { rows: value === undefined ? [] : [{ value: clone(value) }] }
          }
          if (q.startsWith('SELECT key, value FROM nalu_user_data')) {
            return { rows: [...values.entries()].filter(([key]) => key.startsWith(params[0] + '\0')).map(([key, value]) => ({ key: key.split('\0')[1], value: clone(value) })) }
          }
          if (q.startsWith('INSERT INTO nalu_user_data')) {
            const key = storeKey(params[0], params[1]); remember(key)
            values.set(key, JSON.parse(params[2])); return { rows: [] }
          }
          if (q.startsWith('DELETE FROM nalu_user_data')) { values.delete(storeKey(params[0], params[1])); return { rows: [] } }
          throw new Error(`Unexpected SQL: ${q}`)
        },
      }
    },
  }
}
async function request(db, body, token = 'fixture-owner') {
  globalThis.__chatMergeStore = db
  const res = { code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
  await handler({ method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} }, res)
  return res
}
const set = (db, value) => request(db, { action: 'set', key: 'nalu-chats', value })
const chat = (id, messages = [{ role: 'user', content: `Question ${id}` }]) => ({ id, title: `Chat ${id}`, messages, createdAt: 100 })
const ids = db => db.read().map(value => value.id).sort()
const savedFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Offline fixture must never use a provider or network') }
try {
  if (process.argv.includes('--reproduce')) {
    const db = database()
    await set(db, [chat('A')])
    await set(db, [chat('B')])
    assert.deepEqual(ids(db), ['B'])
    const malformed = database()
    malformed.seed('nalu-chats', [chat('A', [{ role: 'assistant', content: 'Saved answer' }])])
    const response = await set(malformed, [chat('A', [null])])
    assert.equal(response.code, 500)
    const deleted = database()
    deleted.seed('nalu-chats', [chat('A')]); deleted.seed('nalu-deleted-chats', ['A'])
    await set(deleted, [])
    assert.deepEqual(ids(deleted), ['A'])
    console.log('REPRODUCED actual handler: stale nonempty B drops A; null message returns500; empty history ignores final-chat tombstone')
    process.exitCode = 0
  } else {
    let groups = 0
    const db = database()
    assert.equal((await set(db, [chat('A')])).code, 200)
    assert.equal((await set(db, JSON.stringify([chat('B')]))).code, 200)
    assert.deepEqual(ids(db), ['A', 'B'], 'stale device B must preserve device A’s new chat')
    assert.equal((await set(db, [chat('A')])).code, 200)
    assert.deepEqual(ids(db), ['A', 'B'], 'stale device A must preserve device B’s new chat')
    assert.equal(typeof db.values.get('owner\0nalu-chats'), 'object', 'direct array writes remain arrays')
    await set(db, JSON.stringify([chat('A')]))
    assert.equal(typeof db.values.get('owner\0nalu-chats'), 'string', 'browser string writes remain string-encoded for existing readers')
    groups++

    const generated = { role: 'assistant', content: 'Full answer 🐺', reasoning: 'Saved reasoning',
      doc: { title: 'Original document', blocks: [{ type: 'paragraph', text: 'Full document bytes' }] },
      sheet: { sheets: [{ rows: [['Original cell']] }] }, deck: { slides: [{ title: 'Original slide' }] },
      design: { kind: 'webpage', html: '<h1>Original website</h1>' }, cad: 'cube([3,4,5]);',
      video: 'data:video/mp4;base64,AAAA', image: 'data:image/png;base64,AAAA',
      email: { to: 'synthetic@example.invalid', subject: 'Draft', body: 'No real delivery' },
      attachments: [{ id: 'attached', name: 'source.txt', dataUrl: 'data:text/plain;base64,VVRGOCBzb3VyY2U=' }],
    }
    const full = chat('A', [chat('A').messages[0], generated, { role: 'user', content: 'Tail question' }, { role: 'assistant', content: 'Tail answer' }])
    full.attachments = [{ id: 'chat-source', name: 'reference.txt', text: 'Saved source' }]
    const history = database(); history.seed('nalu-chats', JSON.stringify([full, chat('B')]))
    const before = clone(full)
    const response = await set(history, [chat('A', [null, { role: 'assistant', content: '', reasoning: '' }, 42])])
    assert.equal(response.code, 200, 'null/primitive messages cannot crash the handler')
    const restored = history.read().find(value => value.id === 'A')
    assert.deepEqual(restored.messages, full.messages, 'restore the exact generated fields, readable text, null slots, and full stored tail')
    assert.deepEqual(restored.attachments, full.attachments)
    assert.deepEqual(full, before, 'merge does not mutate source data')
    assert.deepEqual(ids(history), ['A', 'B'])
    for (const messages of [undefined, null, 'bad', [], [null, false, 42, []]]) {
      assert.equal((await set(history, [{ id: 'A', title: 'Renamed A', messages }])).code, 200)
      assert.deepEqual(history.read().find(value => value.id === 'A').messages, full.messages)
    }
    groups++

    const metadata = database()
    metadata.seed('nalu-chats', [{ ...full, projectId: 'old-folder', notes: 'Old notes' }])
    await set(metadata, [{ ...chat('A', [{ role: 'user', content: 'Question A' }]), title: 'Renamed', notes: '', attachments: [] }])
    assert.equal(metadata.read()[0].title, 'Renamed')
    assert.equal(metadata.read()[0].projectId, undefined, 'moving out of a project omits projectId on the wire; do not restore it')
    assert.equal(metadata.read()[0].notes, '', 'explicit note clearing remains authoritative')
    assert.deepEqual(metadata.read()[0].attachments, [], 'explicit attachment removal remains authoritative')
    assert.deepEqual(metadata.read()[0].messages[1], generated)
    groups++

    const renamed = database()
    renamed.seed('nalu-chats', [{ ...full, title: 'Unicorn book ideas', titleUpdatedAt: 200 }])
    await set(renamed, [chat('A')])
    assert.equal(renamed.read()[0].title, 'Unicorn book ideas', 'a legacy device cannot overwrite an explicit rename')
    assert.equal(renamed.read()[0].titleUpdatedAt, 200)
    await set(renamed, [{ ...chat('A'), title: 'New book direction', titleUpdatedAt: 300 }])
    await set(renamed, [{ ...full, title: 'Old device title', titleUpdatedAt: 200 }])
    assert.equal(renamed.read()[0].title, 'New book direction', 'a richer stale history cannot revert a newer title')
    assert.deepEqual(renamed.read()[0].messages, full.messages)
    groups++

    const malformed = database()
    malformed.seed('nalu-chats', [null, 'bad', { id: {} }, chat('A', [null, { role: 'assistant', content: 'After gap', doc: generated.doc }])])
    assert.equal((await set(malformed, [chat('A', [null, { role: 'assistant', content: '' }]), null, 42, chat('new', [false, { role: 'user', content: 'Valid' }])])).code, 200)
    assert.deepEqual(malformed.read().find(value => value.id === 'A').messages, [{ role: 'assistant', content: 'After gap', doc: generated.doc }], 'stored null must not shift index alignment before merging')
    assert.deepEqual(malformed.read().find(value => value.id === 'new').messages, [{ role: 'user', content: 'Valid' }])
    assert.deepEqual(ids(malformed), ['A', 'new'])
    const sparse = [null, { role: 'assistant', content: 'Saved', doc: { title: 'Retained artifact' } }, null, { role: 'user', content: 'Tail' }]
    const repeated = database()
    await set(repeated, [chat('sparse', sparse)])
    const normalized = clone(repeated.read())
    for (let i = 0; i < 4; i++) {
      await set(repeated, [chat('sparse', sparse)])
      assert.deepEqual(repeated.read(), normalized, 'replaying malformed snapshots must never duplicate saved turns or artifacts')
    }
    for (let i = 0; i < 3; i++) {
      await set(history, [chat('A', [null, { role: 'assistant', content: '', reasoning: '' }, 42])])
      assert.deepEqual(history.read().find(value => value.id === 'A').messages, full.messages, 'repeated partial malformed saves preserve their complete original context without duplication')
    }
    const distinctTurns = [
      { role: 'user', content: 'Question A' }, { role: 'assistant', content: 'Answer A', doc: { title: 'Doc A' } },
      { role: 'user', content: 'Question B' }, { role: 'assistant', content: 'Answer B', doc: { title: 'Doc B' } },
    ]
    const droppedTurn = database(); droppedTurn.seed('nalu-chats', [chat('turns', distinctTurns)])
    for (let i = 0; i < 4; i++) {
      await set(droppedTurn, [chat('turns', [null, null, { role: 'user', content: 'Question B' }, { role: 'assistant', content: 'Answer B' }])])
      assert.deepEqual(droppedTurn.read()[0].messages, distinctTurns, 'a missing earlier turn cannot attach Doc A to Answer B or duplicate the later turn')
    }
    groups++

    for (const next of [{ role: 'user', content: 'Different role' }, { role: 'assistant', id: 'new-message', content: 'Different explicit message' }]) {
      const differing = database(); differing.seed('nalu-chats', [chat('A', [{ ...generated, id: 'old-message' }])])
      await set(differing, [chat('A', [next])])
      const messages = differing.read()[0].messages
      assert.deepEqual(messages.find(m => m.content === next.content), next, 'known different messages must not inherit old artifacts')
      if (next.id) assert.equal(messages.some(m => m.id === 'old-message'), true, 'a concurrently appended identified message must not delete saved work')
    }
    groups++

    const duplicates = database(); duplicates.seed('nalu-chats', [chat('A', [generated]), chat('B')])
    await set(duplicates, [chat('A', [{ role: 'assistant', content: '' }]), chat('A', [{ role: 'assistant', content: 'Updated' }])])
    assert.deepEqual(ids(duplicates), ['A', 'B'])
    assert.equal(duplicates.read()[0].messages[0].content, 'Updated')
    assert.deepEqual(duplicates.read()[0].messages[0].doc, generated.doc)
    groups++

    for (const tombstonesFirst of [true, false]) {
      const deletion = database(); deletion.seed('nalu-chats', [chat('A'), chat('B'), chat('C')])
      const entries = tombstonesFirst ? { 'nalu-deleted-chats': ['B'], 'nalu-chats': [chat('A')] } : { 'nalu-chats': [chat('A')], 'nalu-deleted-chats': ['B'] }
      assert.equal((await request(deletion, { action: 'setMany', entries })).code, 200)
      assert.deepEqual(ids(deletion), ['A', 'C'], 'tombstone removes only its target regardless of batch key order')
      await set(deletion, [chat('B')])
      assert.deepEqual(ids(deletion), ['A', 'C'], 'stale device cannot revive deleted chat')
      await request(deletion, { action: 'set', key: 'nalu-deleted-chats', value: [] })
      assert.deepEqual(deletion.read('nalu-deleted-chats'), ['B'], 'stale tombstone snapshot cannot undo deletion')
    }
    const last = database(); last.seed('nalu-chats', [chat('A')])
    await request(last, { action: 'setMany', entries: { 'nalu-chats': [], 'nalu-deleted-chats': [{ id: 'A' }] } })
    assert.deepEqual(last.read(), [], 'deleting final chat removes server history without a later nonempty save')
    await set(last, [chat('A')]); assert.deepEqual(last.read(), [])
    groups++

    for (const initiallyPresent of [false, true]) {
      const concurrent = database()
      if (initiallyPresent) concurrent.seed('nalu-chats', [chat('seed')])
      const responses = await Promise.all([set(concurrent, [chat('A')]), set(concurrent, [chat('B')])])
      assert.ok(responses.every(response => response.code === 200))
      assert.deepEqual(ids(concurrent), initiallyPresent ? ['A', 'B', 'seed'] : ['A', 'B'], 'simultaneous read/modify/write must retain both creates, including missing initial row')
      assert.equal(concurrent.connections, 2, 'each handler uses its own connected client')
      assert.equal(concurrent.closes, 2)
      assert.equal(concurrent.locks.size, 0)
    }
    groups++

    for (const deleteFirst of [true, false]) {
      const concurrent = database(); concurrent.seed('nalu-chats', [chat('A'), chat('B')])
      const deletion = () => request(concurrent, { action: 'set', key: 'nalu-deleted-chats', value: ['A'] })
      const stale = () => set(concurrent, [chat('A'), chat('C')])
      const responses = await Promise.all(deleteFirst ? [deletion(), stale()] : [stale(), deletion()])
      assert.ok(responses.every(response => response.code === 200))
      assert.deepEqual(ids(concurrent), ['B', 'C'], 'concurrent deletion and stale upload cannot resurrect or lose unrelated chats')
    }
    const deletions = database(); deletions.seed('nalu-chats', [chat('A'), chat('B'), chat('C')])
    await Promise.all(['A', 'B'].map(id => request(deletions, { action: 'set', key: 'nalu-deleted-chats', value: [id] })))
    assert.deepEqual(ids(deletions), ['C'])
    assert.deepEqual(deletions.read('nalu-deleted-chats').sort(), ['A', 'B'])
    groups++

    const rollback = database(); rollback.seed('nalu-chats', [chat('A')])
    rollback.beforeQuery = async (q, params) => { if (q.startsWith('INSERT INTO nalu_user_data') && params[1] === 'nalu-chats') throw new Error('Controlled write failure') }
    const failed = await request(rollback, { action: 'set', key: 'nalu-deleted-chats', value: ['A'] })
    assert.equal(failed.code, 500)
    assert.equal(rollback.read('nalu-deleted-chats'), undefined, 'failed prune must roll back its tombstone too')
    assert.deepEqual(ids(rollback), ['A']); assert.equal(rollback.locks.size, 0); assert.equal(rollback.closes, 1)
    rollback.beforeQuery = null
    await set(rollback, [chat('B')]); assert.deepEqual(ids(rollback), ['A', 'B'])
    groups++

    const owned = database(); owned.seed('nalu-chats', [chat('A')])
    assert.equal((await request(owned, { action: 'set', key: 'nalu-chats', value: [chat('other')] }, 'fixture-other')).code, 200)
    assert.deepEqual(ids(owned), ['A']); assert.deepEqual(owned.read('nalu-chats', 'other').map(value => value.id), ['other'])
    assert.equal((await request(owned, { action: 'set', key: 'nalu-chats', value: [chat('bad')] }, null)).code, 401)
    assert.deepEqual(ids(owned), ['A'])
    const loaded = await request(owned, { action: 'load' })
    assert.deepEqual(decode(loaded.body.data['nalu-chats']), [chat('A')])
    groups++

    const encoded = database(); encoded.seed('nalu-chats', JSON.stringify(JSON.stringify([chat('A')])))
    await set(encoded, JSON.stringify(JSON.stringify([chat('B')]))); assert.deepEqual(ids(encoded), ['A', 'B'])
    for (const value of [null, {}, 'broken JSON', JSON.stringify({ messages: [] })]) {
      assert.equal((await set(encoded, value)).code, 400)
      assert.deepEqual(ids(encoded), ['A', 'B'], 'invalid nonarray payload cannot replace valid server history')
    }
    groups++
    const packed = database()
    const packedValue = JSON.stringify([chat('compressed', [{ role: 'assistant', content: 'Saved exactly', design: { html: '<h1>Saved artifact</h1>' } }])])
    const encodedEntries = gzipSync(JSON.stringify({ 'nalu-chats': packedValue })).toString('base64')
    assert.equal((await request(packed, { action: 'setMany', encoding: 'gzip-base64', compressedEntries: encodedEntries })).code, 200)
    assert.deepEqual(packed.read(), JSON.parse(packedValue))
    assert.equal((await request(packed, { action: 'setMany', encoding: 'gzip-base64', compressedEntries: 'invalid' })).code, 400)
    assert.deepEqual(packed.read(), JSON.parse(packedValue))
    assert.equal((await request(packed, { action: 'setMany', encoding: 'gzip-base64', compressedEntries: encodedEntries }, null)).code, 401)
    groups++

    const conversations=database();conversations.seed('nalu-chats',[full])
    const turn={action:'conversation-turn',chatId:'voice-11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',source:'voice',user:'Juniper budget is 42000.',assistant:'I have your budget.'}
    assert.equal((await request(conversations,turn)).code,200)
    assert.equal((await request(conversations,turn)).code,200)
    const second={...turn,turnId:'33333333-3333-4333-8333-333333333333',user:'Delivery is October 14.'}
    await Promise.all([request(conversations,second),set(conversations,[full])])
    assert.equal(conversations.read().find(c=>c.id===turn.chatId).messages.length,4)
    assert.deepEqual(conversations.read().find(c=>c.id===full.id),full)
    const unauthorized=await request(conversations,turn,null);assert.equal(unauthorized.code,401)
    const other=await request(conversations,{...turn,userId:'owner'},'fixture-other');assert.equal(other.code,200)
    assert.equal(conversations.read('nalu-chats','other')[0].messages.length,2)
    assert.equal(conversations.read().find(c=>c.id===turn.chatId).messages.length,4)
    await request(conversations,{action:'set',key:'nalu-deleted-chats',value:[turn.chatId]})
    assert.equal((await request(conversations,second)).body.saved,false)
    assert(!conversations.read().some(c=>c.id===turn.chatId))
    assert.equal((await request(conversations,{...turn,chatId:'arbitrary-id'})).code,400)
    groups++
    console.log(`PASS ${groups} actual data-handler groups: stale/concurrent device union, explicit final deletion, full artifacts/tail, malformed messages, transaction rollback, account isolation, and array/string compatibility`)
  }
} finally { globalThis.fetch = savedFetch; delete globalThis.__chatMergeStore }
