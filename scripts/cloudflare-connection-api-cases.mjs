import assert from 'node:assert/strict'

export async function cloudflareConnectionApiCases({ api, store, worker, env, db }) {
  const previousEnv = { ...process.env }, previousFetch = globalThis.fetch
  Object.assign(process.env, { NALU_STORAGE_BACKEND: 'cloudflare', CLOUDFLARE_DATA_URL: 'https://fixture.invalid', CLOUDFLARE_DATA_SECRET: env.NALU_DATA_SECRET, GOOGLE_CLIENT_ID: 'fixture-google-id', GOOGLE_CLIENT_SECRET: 'fixture-google-secret', NALU_PUBLIC_BASE: 'https://n4lu.ai' })
  const repository = new api.ConnectionStore(store)
  db.prepare('INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)').run('connection-api-owner', 'owner-a')
  db.prepare('INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)').run('connection-api-other', 'owner-b')
  class ResponseFixture {
    code = 200; headers = {}
    status(code) { this.code = code; return this }
    setHeader(key, value) { this.headers[key] = value; return this }
    json(body) { this.body = body; return this }
    send(body) { this.body = body; return this }
    end() { this.finished = true }
    writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); return this }
  }
  const invoke = async (body, token = 'connection-api-owner', url = '/api/connect') => {
    const response = new ResponseFixture()
    await api.connectionHandler({ method: 'POST', url, body, headers: { authorization: `Bearer ${token}`, host: 'n4lu.ai' } }, response)
    return response
  }
  const oauth = async (url, options = {}) => {
    const response = new ResponseFixture()
    await api.oauthHandler({ method: options.body ? 'POST' : 'GET', url, body: options.body, headers: { host: options.host || 'n4lu.ai', authorization: 'Bearer connection-api-owner', ...options.headers } }, response)
    return response
  }
  let provider
  globalThis.fetch = (url, init) => String(url).startsWith('https://fixture.invalid/') ? worker.fetch(new Request(url, init), env) : provider(new URL(url), init)
  try {
    const auth = async (body, token) => {
      const response = new ResponseFixture()
      await api.authHandler({ method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} }, response)
      return response
    }
    const signup = await auth({ action: 'signup', email: 'Fresh-Cloudflare', displayName: 'Fresh account', password: 'New Cloudflare password' })
    assert.equal(signup.code, 200); assert.equal(signup.body.user.id, 'fresh-cloudflare'); assert.ok(signup.body.recoveryCode)
    assert.equal((await auth({ action: 'signin', email: 'fresh-cloudflare', password: 'wrong' })).code, 401)
    const login = await auth({ action: 'signin', email: 'fresh-cloudflare', password: 'New Cloudflare password' })
    assert.equal(login.code, 200); assert.equal((await auth({ action: 'me' }, login.body.token)).body.user.displayName, 'Fresh account')
    const profile = await auth({ action: 'update-profile', displayName: 'Remembered account', phone: '+14155550123' }, login.body.token)
    assert.equal(profile.code, 200); assert.equal(profile.body.user.phone, '+14155550123')
    const reset = await auth({ action: 'reset-with-code', email: 'fresh-cloudflare', code: signup.body.recoveryCode, password: 'Changed Cloudflare password' })
    assert.equal(reset.code, 200); assert.equal((await auth({ action: 'me' }, login.body.token)).body.user, null)
    assert.equal((await auth({ action: 'me' }, reset.body.token)).body.user.displayName, 'Remembered account')
    await auth({ action: 'signout' }, reset.body.token); assert.equal((await auth({ action: 'me' }, reset.body.token)).body.user, null)
    console.log('PASS real Cloudflare auth route supports fresh signup, login, profile updates, recovery and session revocation with the existing account contract')
    assert.equal((await invoke({ action: 'list' }, 'no-session')).code, 401)
    let issues = 0
    provider = async (url, init) => {
      assert.equal(url.hostname, 'api.github.com')
      if (url.pathname === '/user') return Response.json({ id: 901, login: 'fixture-user' })
      if (url.pathname === '/user/repos') return Response.json([{ full_name: 'fixture/repository', has_issues: true, permissions: { push: true } }])
      if (url.pathname.endsWith('/issues')) { issues++; return Response.json({ html_url: 'https://github.com/fixture/repository/issues/1' }) }
      assert.equal(init.method, undefined)
      return Response.json({ full_name: 'fixture/repository', has_issues: true })
    }
    const saved = await invoke({ action: 'save', id: 'api-github', app: 'github', method: 'apikey', secret: 'private-fixture-key', meta: { accountId: 'forged', destination: 'fixture/repository' } })
    assert.equal(saved.code, 200, JSON.stringify(saved.body)); assert.equal(saved.body.connection.status, 'connected')
    assert.equal(saved.body.connection.meta.accountId, '901')
    assert.ok(!JSON.stringify(saved.body).includes('private-fixture-key')); assert.ok(!JSON.stringify(saved.body).includes('enc_secret'))
    const edited = await invoke({ action: 'save', id: 'api-github', app: 'github', label: 'Remembered repository' })
    assert.equal(edited.code, 200); assert.equal(edited.body.connection.label, 'Remembered repository')
    assert.equal((await invoke({ action: 'test', id: 'api-github' }, 'connection-api-other')).code, 404)
    assert.equal((await invoke({ action: 'destinations', id: 'api-github' })).body.items[0].id, 'fixture/repository')
    const publish = { action: 'pipeline-send', id: 'api-github', deliveryKey: 'api-github-post', payload: { title: 'Fixture issue', text: 'Provider requests stay inside this test.' } }
    const concurrent = await Promise.all([invoke(publish), invoke(publish)])
    assert.ok(concurrent.some(response => response.body.ok)); assert.equal(issues, 1)
    assert.equal((await invoke(publish)).body.status, 'published'); assert.equal(issues, 1)
    const stale = await repository.get('owner-a', 'api-github')
    const replacement = api.encryptConnection('replacement-fixture-key')
    await store.batch([{ sql: 'UPDATE nalu_connections SET enc_secret=? WHERE user_id=? AND id=?', params: [replacement, 'owner-a', stale.id] }])
    await assert.rejects(repository.saveManual([stale.id, 'owner-a', stale.app, stale.label, stale.method, stale.username, null, stale.enc_secret, stale.meta, 'unused-ingest'], stale), /changed while/)
    await assert.rejects(repository.verified('owner-a', stale, 'error'), /changed while/)
    await repository.verificationStatus('owner-a', stale.id, 'error', { detail: 'Old verification failed' }, stale)
    assert.equal((await repository.get('owner-a', stale.id)).status, 'connected')
    assert.equal((await repository.get('owner-a', stale.id)).enc_secret, replacement)
    const ingestToken = new URL(edited.body.connection.ingestUrl).searchParams.get('ingest')
    assert.equal((await invoke({ from: 'fixture', text: 'Inbound note' }, '', `/api/connect?ingest=${ingestToken}`)).code, 200)
    const inbox = await invoke({ action: 'inbox' }); assert.equal(inbox.body.items[0].body, 'Inbound note')
    assert.equal((await invoke({ action: 'inbox' }, 'connection-api-other')).body.items.length, 0)
    await invoke({ action: 'delete', id: 'api-github' }, 'connection-api-other'); assert.ok(await repository.get('owner-a', 'api-github'))
    await invoke({ action: 'delete', id: 'api-github' }); assert.equal(await repository.get('owner-a', 'api-github'), undefined)
    console.log('PASS real Cloudflare connection handler authenticates sessions, saves/edits verified accounts, scopes inbox/delete, redacts credentials and claims a pipeline send once')

    let grants = 0
    provider = async (url, init) => {
      if (url.href === 'https://oauth2.googleapis.com/token') {
        grants++; assert.equal(new URLSearchParams(init.body).get('redirect_uri'), 'https://n4lu.ai/api/oauth')
        return Response.json({ access_token: 'fixture-oauth-access', ...(grants === 1 ? { refresh_token: 'preserved-refresh' } : {}), expires_in: 3600 })
      }
      assert.equal(url.href, 'https://gmail.googleapis.com/gmail/v1/users/me/profile')
      return Response.json({ emailAddress: 'oauth-fixture@example.test' })
    }
    const consent = async connectionId => {
      const opened = await oauth('/api/oauth', { body: { provider: 'google', returnTo: 'https://n4lu.com', ...(connectionId ? { connectionId } : {}) } })
      assert.equal(opened.code, 200, JSON.stringify(opened.body))
      assert.match(opened.body.url, /^https:\/\/n4lu\.ai\/api\/oauth\?start=[a-f0-9]{64}$/)
      const canonical = await oauth(opened.body.url, { host: 'n4lu.com' }); assert.equal(canonical.code, 302); assert.equal(canonical.headers['Set-Cookie'], undefined)
      const launched = await oauth(opened.body.url), state = new URL(opened.body.url).searchParams.get('start')
      assert.equal(launched.code, 302); assert.match(launched.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax/)
      assert.equal((await oauth(opened.body.url)).code, 400)
      const callback = `/api/oauth?state=${state}&code=fixture-code`
      assert.equal((await oauth(callback)).code, 400)
      return { callback, headers: { cookie: launched.headers['Set-Cookie'].split(';')[0] } }
    }
    const flow = await consent()
    const callbacks = await Promise.all([oauth(flow.callback, flow), oauth(flow.callback, flow)])
    assert.deepEqual(callbacks.map(response => response.code).sort(), [200, 400]); assert.equal(grants, 1)
    const connected = (await repository.forApp('owner-a', 'gmail')).find(row => row.username === 'oauth-fixture@example.test')
    assert.ok(connected); assert.equal(api.accountTokens(connected).refresh_token, 'preserved-refresh')
    const reconnect = await consent(connected.id)
    assert.equal((await oauth(reconnect.callback, reconnect)).code, 200)
    const current = await repository.get('owner-a', connected.id)
    assert.equal(api.accountTokens(current).refresh_token, 'preserved-refresh'); assert.equal(grants, 2)
    const listing = await invoke({ action: 'list' })
    assert.ok(listing.body.connections.some(row => row.id === current.id)); assert.ok(!JSON.stringify(listing.body).includes('preserved-refresh'))
    console.log('PASS real Cloudflare OAuth handler preserves native launch URLs, canonical-domain cookies, single-use callback claims, reconnect identity and same-account refresh credentials')
  } finally {
    globalThis.fetch = previousFetch
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
  }
}
