import { CONNECTION_APPS, type ConnectionApp, type ConnectionMetadata, type ConnectionDestination } from '../../../shared/connectionCatalog'
import { getToken } from './localAuth'

// Client helpers for Nalu Connections — the "connect your apps once" system.
// The secret never lives here; it's sent once to /api/connect (which encrypts +
// stores it server-side) and thereafter only referenced by connection id. Every
// /api/* fetch is auto-authed with the user's token by the sync layer.

export type ConnMethod = 'resend' | 'webhook' | 'endpoint' | 'apikey' | 'oauth' | 'smtp' | 'managed'
export type Connection = {
  id: string
  app: string
  label: string
  method: ConnMethod
  username: string
  endpoint: boolean
  status: 'connected' | 'pending' | 'error'
  hasSecret: boolean
  meta: ConnectionMetadata
  createdAt: string
  ingestUrl: string // point your app's forwarding here so Nalu can READ inbound items
}
export type InboxItem = { id: string; connId: string; from: string; subject: string; body: string; receivedAt: string }

// The apps a user can connect, in friendly terms — no "API/webhook/token" jargon.
export type AppDef = ConnectionApp
export const CONNECT_APPS = CONNECTION_APPS
export const appDef = (app: string): AppDef => CONNECT_APPS.find((a) => a.app === app) || CONNECT_APPS[CONNECT_APPS.length - 1]

export class ConnectionSetupError extends Error {
  constructor(message: string, public connection?: Connection) { super(message) }
}
export type ConnectionDelivery = { ok: boolean; detail: string; reviewRequired?: boolean; receipt?: string; status?: 'accepted' | 'published' }
export type ConnectionReview = { delivery_key: string; connection_id: string; filename: string; label: string; created_at: string; result?: ConnectionDelivery }
export type TikTokCreator = { creator_username?: string; creator_nickname?: string; privacy_level_options: string[]; max_video_post_duration_sec: number; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean }
export type TikTokReview = { creator: TikTokCreator; videoUrl: string; title: string }
export const listConnectionReviews = async () => (await call('reviews')).reviews as ConnectionReview[]
export const getConnectionReview = async (deliveryKey: string) => await call('review', { deliveryKey }) as TikTokReview
export const publishConnectionReview = async (deliveryKey: string, title: string, settings: Record<string, unknown>) => await call('review-publish', { deliveryKey, title, settings }) as ConnectionDelivery
export const connectionReviewStatus = async (deliveryKey: string) => (await call('review-status', { deliveryKey })).delivery as ConnectionDelivery
export const pipelineReviewStatus = async (deliveryKey: string) => await call('pipeline-status', { deliveryKey }) as { delivery: ConnectionDelivery | null; summary: string }

async function call(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const token = getToken()
  if (!token) throw new Error('Sign in to manage connections.')
  const r = await fetch('/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra }),
    signal: AbortSignal.timeout(70000),
  })
  if (getToken() !== token) throw new Error('Your account changed. Open Connections again.')
  const j = await r.json().catch(() => ({}))
  // Surface the server's human message (error OR the send/test `detail`, e.g.
  // "use an App Password") instead of a bare "connect 502".
  if (!r.ok) throw new ConnectionSetupError(j.error || j.detail || `connect ${r.status}`, action === 'save' ? j.connection : undefined)
  return j as Record<string, unknown>
}

export async function listConnections(): Promise<Connection[]> {
  return ((await call('list')).connections as Connection[]) || []
}
export async function saveConnection(c: {
  id?: string; app: string; label: string; method: ConnMethod; username?: string; endpoint?: string; secret?: string; meta?: ConnectionMetadata
}): Promise<Connection> {
  return (await call('save', c)).connection as Connection
}
export async function deleteConnection(id: string): Promise<void> {
  await call('delete', { id })
}
export async function testConnection(id: string, opts: { kind?: 'email' | 'ping'; to?: string } = {}): Promise<{ ok: boolean; detail: string }> {
  try {
    const j = await call('test', { id, ...opts })
    return { ok: !!j.ok, detail: String(j.detail || 'ok') }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'test failed' }
  }
}
export async function sendVia(id: string, kind: 'email' | 'post', payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  try {
    const j = await call('send', { id, kind, ...payload })
    return { ok: !!j.ok, detail: String(j.detail || 'sent') }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'send failed' }
  }
}
export async function sendPipelineVia(deliveryKey: string, target: { connectionId?: string; webhook?: string }, kind: 'email' | 'post', payload: Record<string, unknown>): Promise<ConnectionDelivery> {
  try {
    const j = await call('pipeline-send', { deliveryKey, id: target.connectionId, webhook: target.webhook, kind, payload })
    return { ok: !!j.ok, detail: String(j.detail || 'Delivered'), reviewRequired: j.reviewRequired === true, receipt: typeof j.receipt === 'string' ? j.receipt : undefined, status: j.status as ConnectionDelivery['status'] }
  } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : 'Delivery could not be confirmed. Check your publisher before starting a new run.' } }
}
// Read what came IN to a connection (inbox / feed / mentions the user forwarded).
export async function getInbox(id?: string, limit = 25): Promise<InboxItem[]> {
  return ((await call('inbox', { id, limit })).items as InboxItem[]) || []
}

export async function listConnectionDestinations(id: string, cursor?: string): Promise<{ items: ConnectionDestination[]; nextCursor?: string }> {
  return await call('destinations', { id, cursor }) as { items: ConnectionDestination[]; nextCursor?: string }
}
export async function availableConnectionProviders(): Promise<string[]> {
  const response = await fetch('/api/oauth?list=1', { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Could not load account sign-in options. Try again.')
  const data = await response.json()
  if (!Array.isArray(data.configured)) throw new Error('Could not load account sign-in options. Try again.')
  return data.configured
}
export async function beginConnectionSignIn(provider: string, connectionId?: string): Promise<string> {
  const token = getToken()
  if (!token) throw new Error('Sign in to Nalu first.')
  const response = await fetch('/api/oauth', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ provider, connectionId, returnTo: window.location.origin }), signal: AbortSignal.timeout(20000) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Could not start account sign-in.')
  if (getToken() !== token) throw new Error('Your account changed. Open Connections again.')
  if (!/^https:\/\/(?:www\.)?n4lu\.(?:ai|com)\/api\/oauth\?start=[a-f0-9]{64}$/.test(data.url || '')) throw new Error('The sign-in link is invalid. Please try again.')
  return data.url
}
