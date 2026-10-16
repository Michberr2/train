import type { ArtifactClient } from './_autopilotArtifacts'
import { encryptConnection, decryptConnection } from './_connectionSecrets'
import { providerForApp, refreshOAuthTokens, type OAuthTokens } from './_oauthProviders'
import { ConnectionProviderError, verifyProvider, verifyDestination, type ProviderContext } from './_connectionAdapters'
import { connectionApp, type ConnectionMetadata } from '../shared/connectionCatalog'
import { createHash, randomUUID } from 'node:crypto'
import { ConnectionStore, type ConnectionClient } from './_connectionStore'

export type ConnectionRow = { id: string; user_id: string; app: string; label: string; method: string; username?: string; endpoint?: string; enc_secret?: string; status: string; meta?: ConnectionMetadata }
export function accountTokens(row: ConnectionRow): OAuthTokens {
  if (!row.enc_secret) throw new Error('Reconnect this account to add its credentials.')
  const secret = decryptConnection(row.enc_secret)
  if (row.method !== 'oauth') return { access_token: secret }
  try {
    const tokens = JSON.parse(secret)
    if (typeof tokens.access_token === 'string' && tokens.access_token) return tokens
  } catch { /* reconnect below */ }
  throw new Error('Reconnect this account to restore its access token.')
}
export const usesProvider = (row: Pick<ConnectionRow, 'app' | 'method'>) => row.method === 'oauth' || (row.method === 'apikey' && !['gmail', 'outlook', 'webhook'].includes(row.app))

/** Rotating refresh tokens need one owner across browser, mobile and cron.
 * Refresh under a connection-scoped lock and commit before using the new token. */
function currentAccount(row: ConnectionRow, current: ConnectionRow | undefined): ConnectionRow {
  if (!current) throw new Error('This connection was removed. Reconnect it before running the pipeline.')
  const changedAccount = row.meta?.accountId ? current.meta?.accountId !== row.meta.accountId : !!row.username && current.username !== row.username
  if (current.app !== row.app || current.method !== row.method || changedAccount) throw new Error('This connection changed accounts. Select the intended account before running the pipeline.')
  return current
}
async function refreshCloudflareAccount(store: ConnectionStore, userId: string, row: ConnectionRow, force: boolean, earlyRefresh: number): Promise<OAuthTokens> {
  const current = currentAccount(row, await store.get(userId, row.id)), latest = accountTokens(current)
  const accept = (saved: ConnectionRow) => { currentAccount(row, saved); Object.assign(row, saved); return accountTokens(saved) }
  if (current.enc_secret !== row.enc_secret || (!force && (!latest.expiresAt || latest.expiresAt > Date.now() + earlyRefresh))) return accept(current)
  const provider = providerForApp(row.app)
  if (!provider) throw new Error(`Nalu's ${connectionApp(row.app)?.name || row.app} sign-in is not configured. Contact the workspace owner.`)
  const original = current.enc_secret!, source = createHash('sha256').update(original).digest('hex'), claim = randomUUID()
  const claimed = await store.claimRefresh(userId, row.id, original, source, claim)
  if (!claimed) {
    const deadline = Date.now() + 30000
    while (true) {
      const saved = currentAccount(row, await store.get(userId, row.id))
      if (saved.enc_secret !== original) return accept(saved)
      const state = await store.refreshState(userId, row.id, source)
      if (state?.state !== 'pending') {
        const after = currentAccount(row, await store.get(userId, row.id))
        if (after.enc_secret !== original) return accept(after)
        throw new Error('Account refresh could not be confirmed. Reconnect this account to restore access.')
      }
      if (Date.now() - Date.parse(state.created_at) > 45000) throw new Error('Account refresh was interrupted. Reconnect this account to restore access.')
      if (Date.now() >= deadline) throw new Error('This account is still refreshing its access. Try again shortly.')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  let renewed: OAuthTokens
  try { renewed = await refreshOAuthTokens(provider, latest) }
  catch (error) { await store.failRefresh(userId, row.id, source, claim).catch(() => {}); throw error }
  const encrypted = encryptConnection(JSON.stringify(renewed))
  try {
    if (await store.finishRefresh(userId, row.id, source, claim, original, encrypted)) { row.enc_secret = encrypted; return renewed }
  } catch {
    // The write may have committed even if its response was lost. Read it back;
    // never repeat the provider's rotating-token exchange to guess what happened.
    const saved = await store.get(userId, row.id).catch(() => undefined)
    if (saved?.enc_secret === encrypted) return accept(saved)
    throw new Error('Account refresh could not be confirmed. Reconnect this account to restore access.')
  }
  const saved = currentAccount(row, await store.get(userId, row.id))
  if (saved.enc_secret !== original) return accept(saved)
  throw new Error('The refreshed account could not be saved. Reconnect to restore access.')
}
async function refreshAccount(client: ConnectionClient, userId: string, row: ConnectionRow, force: boolean): Promise<OAuthTokens> {
  const original = accountTokens(row)
  const earlyRefresh = row.app === 'instagram' ? 7 * 86400000 : 60000
  if (!force && (!original.expiresAt || original.expiresAt > Date.now() + earlyRefresh)) return original
  const store = new ConnectionStore(client)
  if (store.cloudflare) return refreshCloudflareAccount(store, userId, row, force, earlyRefresh)
  const postgres = client as ArtifactClient
  const key = JSON.stringify(['connection-refresh', userId, row.id])
  await postgres.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key])
  try {
    const current = currentAccount(row, await store.get(userId, row.id))
    const latest = accountTokens(current)
    if (current.enc_secret !== row.enc_secret || (!force && (!latest.expiresAt || latest.expiresAt > Date.now() + earlyRefresh))) { Object.assign(row, current); return latest }
    const provider = providerForApp(row.app)
    if (!provider) throw new Error(`Nalu's ${connectionApp(row.app)?.name || row.app} sign-in is not configured. Contact the workspace owner.`)
    const renewed = await refreshOAuthTokens(provider, latest)
    const encrypted = encryptConnection(JSON.stringify(renewed))
    await postgres.query('UPDATE nalu_connections SET enc_secret=$3,updated_at=NOW() WHERE user_id=$1 AND id=$2', [userId, row.id, encrypted])
    row.enc_secret = encrypted
    return renewed
  } finally { await postgres.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {}) }
}

export async function withProvider<T>(client: ConnectionClient, userId: string, row: ConnectionRow, operation: (ctx: ProviderContext) => Promise<T>): Promise<T> {
  if (row.user_id && row.user_id !== userId) throw new Error('Connection not found.')
  const signal = AbortSignal.timeout(45000)
  let tokens = row.method === 'oauth' ? await refreshAccount(client, userId, row, false) : accountTokens(row)
  const context = () => ({ app: row.app, token: tokens.access_token, username: row.username, meta: row.meta || {}, signal })
  try { return await operation(context()) }
  catch (error) {
    // Authentication rejection means no action was accepted. A timeout or a
    // generic provider error must never automatically repeat a publication.
    if (!(error instanceof ConnectionProviderError) || error.status !== 401 || row.method !== 'oauth') throw error
    tokens = await refreshAccount(client, userId, row, true)
    return operation(context())
  }
}

export async function verifyStoredAccount(client: ConnectionClient, userId: string, row: ConnectionRow): Promise<{ ok: boolean; detail: string; needsDestination?: boolean }> {
  try {
    const identity = await withProvider(client, userId, row, verifyProvider)
    row.meta = { ...row.meta, accountId: identity.accountId, capabilities: identity.capabilities, verifiedAt: Date.now() }
    row.username = identity.username
    const needsDestination = !!connectionApp(row.app)?.destination && !row.meta.destination
    if (!needsDestination) {
      const name = await withProvider(client, userId, row, verifyDestination)
      if (name) row.meta.destinationName = name
    }
    const detail = needsDestination ? `Account verified. Choose a ${connectionApp(row.app)!.destination} to finish setup.` : `Account access verified${row.meta.destinationName ? ` · ${row.meta.destinationName}` : ''}`
    row.meta.detail = detail
    await new ConnectionStore(client).verified(userId, row, needsDestination ? 'pending' : 'connected')
    return { ok: true, detail, needsDestination }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Could not verify this account. Try again.'
    await new ConnectionStore(client).verificationStatus(userId, row.id, 'error', { detail }, row)
    return { ok: false, detail }
  }
}
