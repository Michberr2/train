import assert from 'node:assert/strict'

export async function cloudflareConnectionCases({ api, store, worker, env, db }) {
  const { ConnectionStore, deliverPipelineOnce, readPipelineDelivery, withProvider, accountTokens, encryptConnection, ConnectionProviderError } = api
  const repository = new ConnectionStore(store), owner = 'owner-a'
  process.env.CONN_SECRET = 'cloudflare-isolated-connection-fixture'
  process.env.GOOGLE_CLIENT_ID = 'isolated-google-client'
  process.env.GOOGLE_CLIENT_SECRET = 'isolated-google-secret'
  const originalFetch = globalThis.fetch
  let providerCalls = 0, provider = async () => Response.json({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
  let lostSave = false
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://fixture.invalid/')) {
      const response = await worker.fetch(new Request(url, init), env)
      if (lostSave && String(url).endsWith('/v1/batch') && JSON.parse(init.body).statements.some(item => item.sql.startsWith('UPDATE nalu_connections SET enc_secret='))) { lostSave = false; throw new Error('Simulated lost database acknowledgement') }
      return response
    }
    assert.equal(String(url), 'https://oauth2.googleapis.com/token', 'No actual provider requests')
    providerCalls++; return provider(url, init)
  }
  async function connection(id, options = {}) {
    const tokens = { access_token: 'expired-' + id, refresh_token: 'refresh-' + id, expiresAt: options.fresh ? Date.now() + 3600000 : 1 }
    const row = { id, user_id: owner, app: 'gmail', label: id, method: 'oauth', status: 'connected', username: 'fixture@example.test', meta: { accountId: 'fixture@example.test' }, enc_secret: encryptConnection(JSON.stringify(tokens)) }
    await store.batch([{ sql: 'INSERT INTO nalu_connections(id,user_id,app,label,method,status,username,meta,enc_secret) VALUES(?,?,?,?,?,?,?,?,?)', params: [id, owner, row.app, row.label, row.method, row.status, row.username, JSON.stringify(row.meta), row.enc_secret] }])
    return row
  }
  try {
    const row = await connection('concurrent-refresh')
    const renewed = await Promise.all([1, 2].map(() => withProvider(store, owner, structuredClone(row), async context => context.token)))
    assert.deepEqual(renewed, ['renewed-access', 'renewed-access']); assert.equal(providerCalls, 1)
    assert.equal(accountTokens(await repository.get(owner, row.id)).refresh_token, 'rotated-refresh')
    const forced = await connection('forced-refresh', { fresh: true }); let operations = 0
    assert.equal(await withProvider(store, owner, forced, async context => { operations++; if (context.token.startsWith('expired')) throw new ConnectionProviderError('Expired', 401, 'expired'); return context.token }), 'renewed-access')
    assert.equal(operations, 2); assert.equal(providerCalls, 2)
    const lost = await connection('lost-refresh')
    provider = async () => { throw new Error('Simulated lost provider response') }
    await assert.rejects(withProvider(store, owner, lost, async () => true), /lost provider response/)
    assert.equal(providerCalls, 3)
    await assert.rejects(withProvider(store, owner, lost, async () => true), /Reconnect/)
    assert.equal(providerCalls, 3, 'An uncertain rotating-token exchange is never repeated')
    const acknowledged = await connection('lost-save')
    provider = async () => Response.json({ access_token: 'saved-despite-lost-response', refresh_token: 'new-refresh', expires_in: 3600 })
    lostSave = true
    assert.equal(await withProvider(store, owner, acknowledged, async context => context.token), 'saved-despite-lost-response')
    assert.equal(providerCalls, 4)
    const switched = await connection('switched-account'), replacement = encryptConnection(JSON.stringify({ access_token: 'different-account', refresh_token: 'different-refresh', expiresAt: Date.now() + 3600000 }))
    provider = async () => {
      await store.batch([{ sql: 'UPDATE nalu_connections SET enc_secret=?,meta=? WHERE user_id=? AND id=?', params: [replacement, '{"accountId":"different@example.test"}', owner, switched.id] }])
      return Response.json({ access_token: 'obsolete-account-access', refresh_token: 'obsolete-refresh', expires_in: 3600 })
    }
    await assert.rejects(withProvider(store, owner, switched, async () => { throw new Error('Must not act in a different account') }), /changed accounts/)
    assert.equal((await repository.get(owner, switched.id)).enc_secret, replacement)
    await assert.rejects(withProvider(store, 'owner-b', row, async () => true), /not found/)
    console.log('PASS Cloudflare token rotation has one durable owner, recovers lost database acknowledgements, prevents uncertain re-exchange and protects concurrent reconnects')
    let sends = 0
    const sent = await Promise.all([1, 2].map(() => deliverPipelineOnce(store, owner, 'concurrent-delivery', async () => { sends++; return { ok: true, detail: 'Fixture accepted', receipt: 'fixture-receipt', status: 'accepted' } })))
    assert.equal(sends, 1); assert.ok(sent.some(result => result.ok))
    await deliverPipelineOnce(store, owner, 'concurrent-delivery', async () => { throw new Error('A resume must not send again') })
    assert.equal((await readPipelineDelivery(store, owner, 'concurrent-delivery')).receipt, 'fixture-receipt')
    await repository.queueReview(owner, 'concurrent-delivery', row.id, row.meta.accountId, { filename: 'Fixture.mp4', text: 'Original draft' })
    await repository.queueReview(owner, 'concurrent-delivery', row.id, row.meta.accountId, { filename: 'Changed.mp4', text: 'A retry must not replace the draft' })
    assert.equal((await repository.review(owner, 'concurrent-delivery')).payload.text, 'Original draft')
    assert.ok((await repository.pendingPosts()).some(item => item.delivery_key === 'concurrent-delivery'), 'A saved receipt remains discoverable before the review status is updated')
    const snapshot = await repository.delivery(owner, 'concurrent-delivery')
    assert.equal(await repository.progress(owner, 'concurrent-delivery', snapshot.revision, { ok: true, detail: 'Published', receipt: 'published-receipt', status: 'published' }), true)
    assert.equal(await repository.progress(owner, 'concurrent-delivery', snapshot.revision, { ok: true, detail: 'Older pending response', receipt: 'fixture-receipt', status: 'accepted' }), false)
    assert.equal((await readPipelineDelivery(store, owner, 'concurrent-delivery')).status, 'published')
    assert.equal((await repository.review(owner, 'concurrent-delivery')).result.status, 'published')
    assert.equal(await repository.delivery('owner-b', 'concurrent-delivery'), undefined)
    await deliverPipelineOnce(store, owner, 'uncertain-delivery', async () => { sends++; throw new Error('Lost publisher response') })
    await deliverPipelineOnce(store, owner, 'uncertain-delivery', async () => { throw new Error('Must not resend an uncertain delivery') })
    assert.equal(sends, 2)
    console.log('PASS Cloudflare delivery claims, immutable review drafts, receipt recovery, owner isolation and atomic progress revisions prevent duplicate sends or status regression')
  } finally { globalThis.fetch = originalFetch }
}
