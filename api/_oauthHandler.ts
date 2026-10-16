import crypto from 'node:crypto'
import { readToken, ensureSchema } from './_db'
import { connectionBackend } from './_connectionBackend'
import { ConnectionStore } from './_connectionStore'
import { ensureConnTable } from './connect'
import { authorizationUrl, exchangeOAuthCode, oauthProvider, oauthConfigured } from './_oauthProviders'
import { verifyProvider, verifyDestination } from './_connectionAdapters'
import { accountTokens, type ConnectionRow } from './_connectionRuntime'
import { encryptConnection } from './_connectionSecrets'
import { connectionApp } from '../shared/connectionCatalog'

const BASE = () => (process.env.NALU_PUBLIC_BASE || 'https://n4lu.ai').trim().replace(/\/+$/, '')
const REDIRECT = () => `${BASE()}/api/oauth`
const COOKIE = '__Host-nalu-oauth'
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const cookies = (req: any) => Object.fromEntries(String(req.headers?.cookie || '').split(';').map((part: string) => { const i = part.indexOf('='); return i < 0 ? ['', ''] : [part.slice(0, i).trim(), part.slice(i + 1)] }))
const cookieName = (state: string) => `${COOKIE}-${state.slice(0, 16)}`
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
function returnUrl(value: unknown): string {
  if (value === 'nalu://' || !value) return 'nalu://'
  try { const url = new URL(String(value)); if (['https://n4lu.com', 'https://n4lu.ai', 'https://www.n4lu.com', 'https://www.n4lu.ai'].includes(url.origin) && !url.username && !url.password) return url.origin + '/' } catch { /* invalid return address */ }
  return BASE() + '/'
}
async function ensureStates(c: any) {
  if (new ConnectionStore(c).cloudflare) return
  await ensureSchema(c)
  await c.query(`CREATE TABLE IF NOT EXISTS nalu_oauth_states(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES nalu_users(id) ON DELETE CASCADE,provider TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'launch',expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '10 minutes');
    ALTER TABLE nalu_oauth_states ADD COLUMN IF NOT EXISTS return_to TEXT;
    ALTER TABLE nalu_oauth_states ADD COLUMN IF NOT EXISTS code_verifier TEXT;
    ALTER TABLE nalu_oauth_states ADD COLUMN IF NOT EXISTS connection_id TEXT`)
}
async function launch(c: any, userId: string, provider: string, returnTo: string, connectionId?: string) {
  const id = crypto.randomBytes(32).toString('hex'), verifier = crypto.randomBytes(32).toString('base64url')
  await new ConnectionStore(c).launchOAuth(id, userId, provider, returnTo, verifier, connectionId)
  return id
}

/** Consent always starts on the canonical callback host. Both websites and
 * native clients receive a single-use launch URL without session credentials. */
export default async function handler(req: any, res: any) {
  const url = new URL(req.url, BASE())
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer')
  if (url.searchParams.has('list')) { res.status(200).json({ configured: oauthConfigured() }); return }
  if (!['GET', 'POST'].includes(req.method)) { res.status(405).send('GET or POST only'); return }
  const backend = connectionBackend(), client = backend.client, store = new ConnectionStore(client)
  try {
    await backend.connect(); await ensureStates(client)
    if (req.method === 'POST') {
      let body: any
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {} } catch { res.status(400).json({ error: 'Invalid request.' }); return }
      const userId = await backend.userId(readToken(req))
      if (!userId) { res.status(401).json({ error: 'Sign in to Nalu before connecting an account.' }); return }
      const provider = oauthProvider(String(body.provider || ''))
      if (!provider) { res.status(400).json({ error: 'Sign-in for this provider has not been configured for Nalu yet.' }); return }
      if (body.connectionId) {
        await ensureConnTable(client)
        const existing = await store.get(userId, String(body.connectionId))
        if (!existing || existing.app !== provider.app) { res.status(404).json({ error: 'Connection not found.' }); return }
      }
      const id = await launch(client, userId, provider.id, returnUrl(body.returnTo), body.connectionId ? String(body.connectionId) : undefined)
      res.status(200).json({ url: `${BASE()}/api/oauth?start=${id}` }); return
    }
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code')
    if (code || url.searchParams.has('error')) {
      const jar = cookies(req), supplied = jar[cookieName(state)] || jar[COOKIE] || ''
      if (!/^[a-f0-9]{64}$/.test(state) || !same(supplied, state)) { res.status(400).send('This sign-in attempt belongs to another browser or has expired. Start again from Nalu.'); return }
      const record = await store.consumeOAuth(state)
      res.setHeader('Set-Cookie', [`${cookieName(state)}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`])
      if (!record) { res.status(400).send('This sign-in attempt has already been used or expired. Start again from Nalu.'); return }
      if (!code) { res.status(400).send('The account was not connected. You can try again from Nalu.'); return }
      const provider = oauthProvider(record.provider)
      if (!provider) { res.status(400).send('This provider is not configured.'); return }
      const tokens = await exchangeOAuthCode(provider, code, REDIRECT(), record.code_verifier)
      const identity = await verifyProvider({ app: provider.app, token: tokens.access_token, meta: {} })
      await ensureConnTable(client)
      const existing = await store.forApp(record.user_id, provider.app)
      const previous = existing.find(row => row.id === record.connection_id) || existing.find(row => row.method === 'oauth' && (row.meta?.accountId === identity.accountId || row.username === identity.username))
      // Repeated Google consent can omit refresh_token. Retain it only for the
      // same verified account, never for a different mailbox or profile.
      const sameAccount = previous && (previous.meta?.accountId ? previous.meta.accountId === identity.accountId : previous.username === identity.username)
      if (sameAccount && !tokens.refresh_token) { try { tokens.refresh_token = accountTokens(previous!).refresh_token } catch { /* fresh access remains valid */ } }
      const id = previous?.id || `oauth_${provider.id}_${crypto.createHash('sha256').update(identity.accountId).digest('hex').slice(0, 16)}`
      const meta = { ...previous?.meta, accountId: identity.accountId, capabilities: identity.capabilities, verifiedAt: Date.now(), detail: 'Account access verified' }
      let pending = !!connectionApp(provider.app)?.destination && !meta.destination
      if (connectionApp(provider.app)?.destination && meta.destination) {
        try { meta.destinationName = await verifyDestination({ app: provider.app, token: tokens.access_token, meta }) }
        catch { pending = true; meta.detail = 'Account connected. Choose a destination this account can publish to.' }
      }
      await store.saveOAuth([id, record.user_id, provider.app, previous?.label || connectionApp(provider.app)?.name || provider.name, identity.username, pending ? 'pending' : 'connected', JSON.stringify(meta), crypto.randomBytes(16).toString('hex'), encryptConnection(JSON.stringify(tokens))])
      const back = returnUrl(record.return_to), targetOrigin = back.startsWith('nalu:') ? BASE() : new URL(back).origin
      const result = JSON.stringify({ type: 'nalu:connection', provider: provider.id, connectionId: id, ok: true }).replace(/</g, '\\u003c')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.status(200).send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(provider.name)} connected · Nalu</title><body style="font-family:system-ui;background:#f0f5f0;color:#173e38;display:grid;place-items:center;min-height:100vh;margin:0"><main style="padding:32px;max-width:440px"><h1>${escape(provider.name)} connected</h1><p>${escape(identity.username)}</p><p>${pending ? 'Return to Nalu and choose where this account should publish.' : 'Your account is connected. You can return to Nalu.'}</p><a href="${escape(back)}" style="color:#1769a0">Return to Nalu</a></main><script>if(window.opener){window.opener.postMessage(${result},${JSON.stringify(targetOrigin)});window.close()}</script></body></html>`); return
    }
    let id = url.searchParams.get('start') || ''
    if (!id) {
      // Compatibility for existing web/desktop links: redirect to the canonical
      // host BEFORE setting the cookie used by the provider callback.
      const userId = await backend.userId(url.searchParams.get('token') || '')
      if (!userId) { res.status(401).send('Sign in to Nalu first.'); return }
      const provider = oauthProvider(url.searchParams.get('provider') || '')
      if (!provider) { res.status(400).json({ error: 'This provider is not configured.', configured: oauthConfigured() }); return }
      id = await launch(client, userId, provider.id, returnUrl(`https://${req.headers?.host || 'n4lu.ai'}`))
      res.writeHead(302, { Location: `${BASE()}/api/oauth?start=${id}` }); res.end(); return
    }
    if (!/^[a-f0-9]{64}$/.test(id)) { res.status(400).send('Invalid sign-in link.'); return }
    if (req.headers?.host && req.headers.host !== new URL(BASE()).host) { res.writeHead(302, { Location: `${BASE()}/api/oauth?start=${id}` }); res.end(); return }
    const record = await store.startOAuth(id)
    const provider = record && oauthProvider(record.provider)
    if (!provider) { res.status(400).send('This sign-in link expired. Start again from Nalu.'); return }
    res.setHeader('Set-Cookie', `${cookieName(id)}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`)
    res.writeHead(302, { Location: authorizationUrl(provider, REDIRECT(), id, record.code_verifier) }); res.end()
  } catch (error) {
    const message = error instanceof Error && !/password|secret|token=|postgres|SELECT|INSERT/i.test(error.message) ? error.message : 'Could not connect this account. Please start again from Nalu.'
    if (req.method === 'POST') res.status(502).json({ error: message }); else res.status(502).send(message)
  } finally { await backend.close().catch(() => {}) }
}
