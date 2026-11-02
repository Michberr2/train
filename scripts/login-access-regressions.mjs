import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const bundle = await build({ stdin: { contents: `export * from './api/_loginAccess'; export { userIdForToken, hashPassword } from './api/_db'; export { default as authHandler } from './api/auth'; export { CloudflareAccounts } from './api/_cloudflareAccounts'; export { CloudflareStore } from './api/_cloudflareStore'; export { connectionBackend } from './api/_connectionBackend'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', target: 'es2022' })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const api = module.exports, owner = 'owner@example.test', other = 'other@example.test'
const previous = { ...process.env }
try {
  delete process.env.NALU_ALLOWED_LOGIN_EMAIL
  assert.equal(api.loginAllowed(other), true)
  assert.equal(api.blockedAccountAction('signup', other), false)
  process.env.NALU_ALLOWED_LOGIN_EMAIL = ` ${owner.toUpperCase()} `
  assert.equal(api.loginAllowed(owner.toUpperCase()), true)
  assert.equal(api.loginAllowed(other), false)
  assert.equal(api.loginAllowed(null), false)
  for (const backend of ['postgres', 'cloudflare']) {
    process.env.NALU_STORAGE_BACKEND = backend
    for (const action of ['signup', 'request-reset', 'reset-password', 'reset-with-code', 'signin']) {
      const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }
      await api.authHandler({ method: 'POST', headers: {}, body: { action, email: other, password: 'fixture-password', token: 'old-reset-token', code: 'old-code' } }, res)
      assert.equal(res.code, 403, `${backend} ${action} blocked before storage access`)
      assert.equal(res.body.ok, false)
    }
  }
  assert.equal(api.blockedAccountAction('signin', owner), false)
  assert.equal(api.blockedAccountAction('signup', owner), true)
  assert.equal(api.blockedAccountAction('reset-password', owner), true)
  let activeId = other
  const pg = { async query() { return { rows: [{ user_id: activeId }] } } }
  assert.equal(await api.userIdForToken(pg, 'existing-session'), null)
  activeId = owner
  assert.equal(await api.userIdForToken(pg, 'owner-session'), owner)
  process.env.NALU_STORAGE_BACKEND = 'cloudflare'
  process.env.CLOUDFLARE_DATA_URL = 'https://fixture.invalid'
  process.env.CLOUDFLARE_DATA_SECRET = 'fixture-secret-with-at-least-32-characters'
  const store = { async query() { return { results: [{ id: activeId, display_name: 'Fixture', phone: null }] } } }
  const accounts = new api.CloudflareAccounts(store)
  activeId = other
  assert.equal(await accounts.current('existing-session'), null)
  activeId = owner
  assert.equal((await accounts.current('owner-session')).id, owner)
  const original = api.CloudflareStore.prototype.query
  api.CloudflareStore.prototype.query = store.query
  try {
    activeId = other
    assert.equal(await api.connectionBackend().userId('existing-session'), null)
    activeId = owner
    assert.equal(await api.connectionBackend().userId('owner-session'), owner)
  } finally { api.CloudflareStore.prototype.query = original }
  console.log('PASS owner-only sign-in, signup/recovery rejection, and existing PostgreSQL/Cloudflare session rejection; unrestricted compatibility retained')
} finally { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous) }
