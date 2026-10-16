import { projectDataCases } from './fixtures/project-data-cases.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function cloudflareDataApiCases({ api, store, worker, env }) {
  const previousEnv = { ...process.env }, previousFetch = globalThis.fetch
  Object.assign(process.env, { NALU_STORAGE_BACKEND: 'cloudflare', CLOUDFLARE_DATA_URL: 'https://fixture.invalid', CLOUDFLARE_DATA_SECRET: env.NALU_DATA_SECRET })
  globalThis.fetch = (url, init) => { assert.ok(String(url).startsWith('https://fixture.invalid/'), 'No provider requests in data tests'); return worker.fetch(new Request(url, init), env) }
  const owner = 'data-api-owner', other = 'data-api-other'
  await store.batch([
    { sql: 'INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)', params: [owner, 'Data fixture', 'salt', 'hash'] },
    { sql: 'INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)', params: [other, 'Other data fixture', 'salt', 'hash'] },
    { sql: 'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)', params: [owner, owner] },
    { sql: 'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)', params: [other, other] },
  ])
  const invoke = async (body, token = owner, query) => {
    const res = { code: 200, headers: {}, status(code) { this.code = code; return this }, setHeader(key, value) { this.headers[key] = value; return this }, json(value) { this.body = value; return this }, send(value) { this.body = value; return this }, end() {} }
    await api.dataHandler({ method: query ? 'GET' : 'POST', body, query, headers: { authorization: `Bearer ${token}` } }, res)
    return res
  }
  const set = (key, value) => invoke({ action: 'set', key, value })
  try {
    assert.equal((await invoke({ action: 'load' }, 'bad-session')).code, 401)
    assert.deepEqual((await invoke({ action: 'load' })).body.data, {})
    const chat = id => ({ id, title: id, messages: [{ id: id + '-message', role: 'user', content: 'Save ' + id }] })
    const results = await Promise.all([set('nalu-chats', JSON.stringify([chat('device-a')])), set('nalu-chats', JSON.stringify([chat('device-b')]))])
    assert.ok(results.every(result => result.code === 200))
    const loaded = () => invoke({ action: 'load' })
    assert.equal(JSON.parse((await loaded()).body.data['nalu-chats']).length, 2)
    await set('nalu-chats', JSON.stringify([{ ...chat('device-b'), title: 'My remembered chat', titleUpdatedAt: Date.now() }]))
    await set('nalu-chats', JSON.stringify([chat('device-b')]))
    assert.equal(JSON.parse((await loaded()).body.data['nalu-chats']).find(row => row.id === 'device-b').title, 'My remembered chat')
    await set('nalu-chats', '[]'); assert.equal(JSON.parse((await loaded()).body.data['nalu-chats']).length, 2)
    await set('nalu-deleted-chats', '["device-a"]'); await set('nalu-chats', JSON.stringify([chat('device-a'), chat('device-b')]))
    assert.deepEqual(JSON.parse((await loaded()).body.data['nalu-chats']).map(row => row.id), ['device-b'])
    const large = JSON.stringify([{ ...chat('large'), messages: [{ id: 'large-message', role: 'assistant', content: 'A wolf 🐺 and a unicorn 🦄. '.repeat(100000) }] }])
    assert.equal((await set('nalu-chats', large)).code, 200)
    assert.equal(JSON.parse((await loaded()).body.data['nalu-chats']).find(row => row.id === 'large').messages[0].content.length, JSON.parse(large)[0].messages[0].content.length)
    assert.deepEqual((await invoke({ action: 'load' }, other)).body.data, {})
    const entries = Object.fromEntries(Array.from({ length: 25 }, (_, index) => ['setting-' + index, { index, active: true, empty: null }]))
    assert.equal((await invoke({ action: 'setMany', entries })).code, 200)
    const data = (await loaded()).body.data; for (const [key, value] of Object.entries(entries)) assert.deepEqual(data[key], value)
    await invoke({ action: 'remove', key: 'setting-0' }); assert.equal((await loaded()).body.data['setting-0'], undefined)
    const turn = { action: 'conversation-turn', source: 'desktop', chatId: 'desktop-' + randomUUID(), turnId: randomUUID(), user: 'Remember this desktop turn', assistant: 'Saved across devices.' }
    assert.ok((await Promise.all([invoke(turn), invoke(turn)])).every(response => response.body.saved))
    let history = JSON.parse((await loaded()).body.data['nalu-chats'])
    assert.equal(history.find(row => row.id === turn.chatId).messages.length, 2)
    await set('nalu-deleted-chats', JSON.stringify([turn.chatId])); assert.equal((await invoke(turn)).body.saved, false)
    const projectChecks = await projectDataCases(body => invoke(body))
    console.log(`PASS ${projectChecks} real Cloudflare data API project cases: concurrent creates, optimistic revisions, conflict preservation, tombstones and wire compatibility`)
    console.log('PASS real Cloudflare data API preserves concurrent and multi-megabyte chats, explicit deletion, JSON types, paged account loading and idempotent desktop conversation turns')

    const task = { action: 'task-log', id: 'cloudflare-task', title: 'Remembered task', status: 'running', event: 'Started', meta: { replace: { old: 1 }, preserve: true } }
    assert.equal((await invoke(task)).code, 200)
    const update = await invoke({ action: 'task-log', id: task.id, event: 'Updated', meta: { replace: { current: 2 }, nullable: null, flag: false, array: [1, true] } })
    assert.equal(update.code, 200, JSON.stringify(update.body))
    assert.deepEqual(update.body.task.meta, { replace: { current: 2 }, preserve: true, nullable: null, flag: false, array: [1, true] })
    assert.equal(update.body.task.events.length, 2)
    assert.equal((await invoke({ ...task, title: 'Other owner' }, other)).code, 409)
    assert.equal((await invoke({ action: 'task-clear', id: task.id })).code, 409)
    await invoke({ action: 'task-log', id: task.id, status: 'done', progress: 1 })
    assert.equal((await invoke({ action: 'task-feed' })).body.tasks[0].status, 'done')
    const flow = { id: 'saved-flow', name: 'Saved run', run: { startedAt: 100, status: 'done' }, results: { first: 'Retain first result', object: { before: 1 } } }
    assert.equal((await set('nalu-agent-flows', JSON.stringify([flow]))).code, 200)
    assert.equal((await set('nalu-agent-flows', JSON.stringify([{ ...flow, run: { ...flow.run, status: 'running' }, results: { second: 'Next result', object: { after: 2 }, flag: false } }]))).code, 200)
    const ledger = (await invoke({ action: 'task-feed' })).body.tasks.find(row => row.id === 'flow_saved-flow_100')
    assert.equal(ledger.status, 'done'); assert.deepEqual(ledger.meta.results, { first: 'Retain first result', second: 'Next result', object: { after: 2 }, flag: false })
    const activity = await invoke({ action: 'activity' }); assert.ok(activity.body.chats.length); assert.equal(activity.body.pipelines[0].id, 'flow_def_saved-flow')
    await api.saveProfile(owner, 'Prefers whimsical unicorn stories')
    const identity = await api.identityForRequest({ headers: { authorization: `Bearer ${owner}` } })
    assert.equal(identity.id, owner); assert.equal(identity.profile, 'Prefers whimsical unicorn stories')
    await api.saveProfile(owner, 'Prefers concise emails', identity.profile)
    await api.saveProfile(owner, 'Stale overwrite must not win', identity.profile)
    assert.equal((await api.identityForRequest({ headers: { authorization: `Bearer ${owner}` } })).profile, 'Prefers concise emails')
    await api.saveProfile(owner, 'Prefers whimsical unicorn stories')
    const context = await api.accountContextForUser(owner, [{ role: 'user', content: 'What was my remembered task and saved run?' }])
    assert.match(context, /Remembered task/); assert.match(context, /Saved run/); assert.match(context, /whimsical unicorn/)
    assert.equal(await api.identityForRequest({ headers: { authorization: 'Bearer bad-session' } }), null)
    assert.equal((await invoke({ action: 'task-clear', id: task.id })).code, 200)
    const share = await invoke({ action: 'share', html: '<!doctype html><title>Saved website</title><main>Cloudflare preview</main>' })
    assert.equal(share.code, 200)
    const opened = await invoke({}, '', { share: share.body.id })
    assert.match(opened.body, /Cloudflare preview/)
    assert.match(opened.headers['Content-Security-Policy'], /^sandbox /)
    assert.doesNotMatch(opened.headers['Content-Security-Policy'], /allow-same-origin|allow-popups-to-escape-sandbox/)
    assert.equal(opened.headers['Cache-Control'], 'no-store')
    assert.equal((await invoke({ action: 'share', html: 'x'.repeat(800001) })).code, 413)
    assert.equal((await store.query('SELECT html FROM nalu_shares WHERE id=?', [share.body.id])).results[0].html, '<!doctype html><title>Saved website</title><main>Cloudflare preview</main>')
    console.log('PASS Cloudflare activity retains task ownership, events, shallow metadata values and past pipeline results, protects running tasks, serves saved websites and loads authenticated chat memory')
  } finally {
    globalThis.fetch = previousFetch
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
}
