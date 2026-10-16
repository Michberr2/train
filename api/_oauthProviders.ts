import crypto from 'node:crypto'

const env = (name: string) => (process.env[name] || '').trim()
export const META_VERSION = () => env('META_GRAPH_VERSION') || 'v24.0'
export type OAuthTokens = { access_token: string; refresh_token?: string; expiresAt?: number; scope?: string; token_type?: string; open_id?: string; obtainedAt?: number }
export type OAuthProvider = { id: string; app: string; name: string; authUrl: string; tokenUrl: string; scope: string; clientId: string; clientSecret: string; extra?: Record<string, string>; pkce?: boolean; basic?: boolean; keyName?: string }
export function oauthProvider(id: string): OAuthProvider | null {
  const defs: Record<string, Omit<OAuthProvider, 'clientId' | 'clientSecret'>> = {
    google: { id, app: 'gmail', name: 'Google', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly', extra: { access_type: 'offline', prompt: 'consent' } },
    microsoft: { id, app: 'outlook', name: 'Microsoft', authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'offline_access User.Read Mail.Send Mail.Read' },
    linkedin: { id, app: 'linkedin', name: 'LinkedIn', authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', scope: 'openid profile w_member_social' },
    reddit: { id, app: 'reddit', name: 'Reddit', authUrl: 'https://www.reddit.com/api/v1/authorize', tokenUrl: 'https://www.reddit.com/api/v1/access_token', scope: 'submit read identity mysubreddits', basic: true, extra: { duration: 'permanent' } },
    slack: { id, app: 'slack', name: 'Slack', authUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access', scope: 'chat:write,channels:read,groups:read,channels:history,groups:history' },
    github: { id, app: 'github', name: 'GitHub', authUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', scope: 'repo read:user' },
    x: { id, app: 'x', name: 'X', authUrl: 'https://x.com/i/oauth2/authorize', tokenUrl: 'https://api.x.com/2/oauth2/token', scope: 'tweet.read tweet.write users.read offline.access', pkce: true, basic: true },
    instagram: { id, app: 'instagram', name: 'Instagram', authUrl: 'https://www.instagram.com/oauth/authorize', tokenUrl: 'https://api.instagram.com/oauth/access_token', scope: 'instagram_business_basic,instagram_business_content_publish', extra: { enable_fb_login: '0', force_authentication: '1' } },
    facebook: { id, app: 'facebook', name: 'Facebook', authUrl: `https://www.facebook.com/${META_VERSION()}/dialog/oauth`, tokenUrl: `https://graph.facebook.com/${META_VERSION()}/oauth/access_token`, scope: 'pages_show_list,pages_read_engagement,pages_manage_posts' },
    tiktok: { id, app: 'tiktok', name: 'TikTok', authUrl: 'https://www.tiktok.com/v2/auth/authorize/', tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/', scope: 'user.info.basic,video.publish,video.list', keyName: 'client_key' },
  }
  const def = defs[id]
  if (!def) return null
  const prefix = id.toUpperCase()
  const clientId = env(`${prefix}_CLIENT_ID`) || env(`OAUTH_${prefix}_CLIENT_ID`) || (id === 'x' ? env('TWITTER_CLIENT_ID') : id === 'tiktok' ? env('TIKTOK_CLIENT_KEY') : '')
  const clientSecret = env(`${prefix}_CLIENT_SECRET`) || env(`OAUTH_${prefix}_CLIENT_SECRET`) || (id === 'x' ? env('TWITTER_CLIENT_SECRET') : '')
  return clientId && clientSecret ? { ...def, clientId, clientSecret } : null
}
export const oauthConfigured = () => ['google', 'microsoft', 'linkedin', 'reddit', 'slack', 'github', 'x', 'instagram', 'facebook', 'tiktok'].filter(id => oauthProvider(id))
export const providerForApp = (app: string) => oauthProvider(app === 'gmail' ? 'google' : app === 'outlook' ? 'microsoft' : app)
export function authorizationUrl(p: OAuthProvider, redirect: string, state: string, verifier?: string): string {
  const params = new URLSearchParams({ response_type: 'code', [p.keyName || 'client_id']: p.clientId, redirect_uri: redirect, scope: p.scope, state, ...p.extra })
  if (p.pkce) {
    if (!verifier) throw new Error('The sign-in challenge is missing. Please start again.')
    params.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url')); params.set('code_challenge_method', 'S256')
  }
  return `${p.authUrl}?${params}`
}

async function tokenRequest(p: OAuthProvider, values: Record<string, string>): Promise<OAuthTokens> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'Nalu/1.0 (https://n4lu.ai)' }
  const params = new URLSearchParams({ [p.keyName || 'client_id']: p.clientId, ...values })
  if (p.basic) headers.Authorization = `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`
  else params.set('client_secret', p.clientSecret)
  const response = await fetch(p.tokenUrl, { method: 'POST', headers, body: params.toString(), signal: AbortSignal.timeout(15000) })
  const body = await response.json().catch(() => ({})) as any
  if (!response.ok || body.ok === false || body.error || typeof body.access_token !== 'string' || !body.access_token) throw new Error(`${p.name} could not authorize this connection. Check app permissions and reconnect.`)
  return { access_token: body.access_token, ...(body.refresh_token ? { refresh_token: String(body.refresh_token) } : {}), ...(Number(body.expires_in) > 0 ? { expiresAt: Date.now() + Number(body.expires_in) * 1000 } : {}), ...(body.scope ? { scope: String(body.scope) } : {}), ...(body.open_id ? { open_id: String(body.open_id) } : {}), obtainedAt: Date.now() }
}
export async function exchangeOAuthCode(p: OAuthProvider, code: string, redirect: string, verifier?: string): Promise<OAuthTokens> {
  let tokens = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirect, ...(p.pkce && verifier ? { code_verifier: verifier } : {}) })
  if (tokens.scope) {
    const normalize = (scope: string) => scope.replace(/^https:\/\/graph.microsoft.com\//i, '').toLowerCase()
    const granted = new Set(tokens.scope.split(/[ ,]+/).map(normalize))
    const missing = p.scope.split(/[ ,]+/).filter(scope => {
      if (scope === 'offline_access') return false // Providers can omit this from the returned scope string.
      if (granted.has('*') || granted.has(normalize(scope))) return false
      if (p.id === 'google' && granted.has('https://mail.google.com/')) return false
      if (p.id === 'github' && scope === 'read:user' && granted.has('user')) return false
      return true
    })
    if (missing.length) throw new Error(`${p.name} did not grant all requested account permissions. Reconnect and allow the requested access.`)
  }
  if (p.id === 'instagram' || p.id === 'facebook') {
    const url = p.id === 'instagram' ? new URL('https://graph.instagram.com/access_token') : new URL(`https://graph.facebook.com/${META_VERSION()}/oauth/access_token`)
    const params = p.id === 'instagram' ? { grant_type: 'ig_exchange_token', client_secret: p.clientSecret, access_token: tokens.access_token } : { grant_type: 'fb_exchange_token', client_id: p.clientId, client_secret: p.clientSecret, fb_exchange_token: tokens.access_token }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) }), body = await response.json().catch(() => ({})) as any
    if (!response.ok || !body.access_token) throw new Error(`${p.name} could not create a persistent connection. Reconnect after checking app access.`)
    tokens = { ...tokens, access_token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 5184000) * 1000 }
  }
  return tokens
}
export async function refreshOAuthTokens(p: OAuthProvider, tokens: OAuthTokens): Promise<OAuthTokens> {
  if (p.id === 'instagram') {
    const url = new URL('https://graph.instagram.com/refresh_access_token'); url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: tokens.access_token }).toString()
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) }), body = await response.json().catch(() => ({})) as any
    if (!response.ok || !body.access_token) throw new Error('Reconnect Instagram to renew access.')
    return { ...tokens, access_token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 5184000) * 1000, obtainedAt: Date.now() }
  }
  if (!tokens.refresh_token) throw new Error(`Reconnect ${p.name} to renew access.`)
  return { ...tokens, ...await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) }
}
