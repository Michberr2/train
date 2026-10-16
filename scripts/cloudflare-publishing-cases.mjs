import assert from 'node:assert/strict'

export async function cloudflarePublishingCases({ api, store, worker, env }) {
  const { ConnectionStore, encryptConnection, deliverPipelineOnce, refreshConnectionPost, readPipelineDelivery } = api
  const owner = 'owner-a', repository = new ConnectionStore(store)
  const previousFetch = globalThis.fetch
  let provider
  globalThis.fetch = (url, init) => String(url).startsWith('https://fixture.invalid/')
    ? worker.fetch(new Request(url, init), env) : provider(new URL(url), init)
  const ready = async (app, id) => {
    const row = { id, app, user_id: owner, method: 'oauth', label: id, status: 'connected', username: 'fixture', meta: { accountId: 'fixture-account' }, enc_secret: encryptConnection(JSON.stringify({ access_token: 'fixture-access', expiresAt: Date.now() + 30 * 86400000 })) }
    await store.batch([{ sql: 'INSERT INTO nalu_connections(id,user_id,app,label,method,status,username,meta,enc_secret) VALUES(?,?,?,?,?,?,?,?,?)', params: [id, owner, app, id, row.method, row.status, row.username, JSON.stringify(row.meta), row.enc_secret] }])
    await repository.queueReview(owner, id, id, row.meta.accountId, { filename: 'fixture.mp4' })
    await deliverPipelineOnce(store, owner, id, async () => ({ ok: true, detail: 'Processing', receipt: 'container-' + id, status: 'accepted' }))
    return row
  }
  const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
  try {
    const row = await ready('instagram', 'instagram-finalize'), entered = gate(), release = gate()
    let publishes = 0
    provider = async (url, init) => {
      assert.equal(url.hostname, 'graph.instagram.com')
      if (url.pathname.endsWith('/media_publish')) { publishes++; entered.resolve(); await release.promise; return Response.json({ id: 'published-fixture' }) }
      assert.equal(init.method, undefined); return Response.json({ status_code: 'FINISHED' })
    }
    const first = refreshConnectionPost(store, owner, structuredClone(row), row.id)
    await entered.promise
    const second = await refreshConnectionPost(store, owner, structuredClone(row), row.id)
    assert.equal(second.status, 'accepted'); assert.equal(second.ok, true)
    assert.ok((await repository.pendingPosts()).some(item => item.delivery_key === row.id), 'Concurrent publish remains discoverable')
    release.resolve(); assert.equal((await first).status, 'published'); assert.equal(publishes, 1)
    assert.equal((await readPipelineDelivery(store, owner, row.id)).status, 'published')
    assert.equal((await repository.review(owner, row.id)).result.status, 'published')
    await refreshConnectionPost(store, owner, row, row.id); assert.equal(publishes, 1)

    const lost = await ready('instagram', 'instagram-lost-publish')
    let status = 'FINISHED', lostPublishes = 0
    provider = async url => {
      assert.equal(url.hostname, 'graph.instagram.com')
      if (url.pathname.endsWith('/media_publish')) { lostPublishes++; throw new Error('Simulated response lost after publication') }
      return Response.json({ status_code: status })
    }
    assert.equal((await refreshConnectionPost(store, owner, lost, lost.id)).status, 'accepted')
    await refreshConnectionPost(store, owner, lost, lost.id); assert.equal(lostPublishes, 1)
    status = 'PUBLISHED'
    assert.equal((await refreshConnectionPost(store, owner, lost, lost.id)).status, 'published')
    assert.equal(lostPublishes, 1)

    const tik = await ready('tiktok', 'tiktok-stale-poll'), staleEntered = gate(), staleRelease = gate()
    let polls = 0
    provider = async (url, init) => {
      assert.equal(url.href, 'https://open.tiktokapis.com/v2/post/publish/status/fetch/')
      assert.equal(JSON.parse(init.body).publish_id, 'container-' + tik.id)
      if (++polls === 1) { staleEntered.resolve(); await staleRelease.promise; return Response.json({ data: { status: 'PROCESSING_UPLOAD' } }) }
      return Response.json({ data: { status: 'PUBLISH_COMPLETE' } })
    }
    const older = refreshConnectionPost(store, owner, structuredClone(tik), tik.id)
    await staleEntered.promise
    assert.equal((await refreshConnectionPost(store, owner, structuredClone(tik), tik.id)).status, 'published')
    staleRelease.resolve(); assert.equal((await older).status, 'published')
    assert.equal((await repository.review(owner, tik.id)).result.status, 'published')
    console.log('PASS Cloudflare provider polling finalizes Instagram once, recovers a lost publish response and prevents stale TikTok processing from overwriting publication')
  } finally { globalThis.fetch = previousFetch }
}
