// Nalu Connections — the non-technical "connect your apps" backend for AutoPilot.
// A user connects Gmail / Outlook / LinkedIn / Reddit / Instagram / X / Slack /
// a generic webhook ONCE; the secret is encrypted (AES-256-GCM) and stored
// server-side ONLY (never returned to the browser, never synced). Agents then do
// real work in those apps by referencing the connection id — the user never sees
// an API key, webhook, or token again.
//
// Actions (POST { action, ... } with the user's bearer token):
//   list                                   → connections (metadata only, no secrets)
//   save   { id?, app, label, method, username?, secret?, endpoint? }
//   delete { id }
//   test   { id }                          → verify the saved secret actually works
//   send   { id, kind:'email'|'post', to?, subject?, body?, text?, meta? }
//
// method ∈ 'resend' (Nalu-sent) | 'webhook' (user's Zapier/Make/native hook) |
//          'smtp' | 'apikey' | 'oauth'. The UI picks the friendliest available.
import { cors } from './_cors'
import { readToken, safeJson } from './_db'
import { sendEmail, emailConfigured } from './_email'
import { deliverPipelineOnce, readPipelineDelivery, type DeliveryResult } from './_pipelineDelivery'
import { ConnectionStore, type ConnectionClient } from './_connectionStore'
import { connectionBackend } from './_connectionBackend'
import crypto from 'node:crypto'
import { encryptConnection as encrypt, decryptConnection as decrypt } from './_connectionSecrets'
import { connectionApp, cleanConnectionMetadata } from '../shared/connectionCatalog'
import { providerDestinations, publishProvider, readProviderInbox, tiktokCreator, validateTikTokReview } from './_connectionAdapters'
import { usesProvider, withProvider, verifyStoredAccount, type ConnectionRow } from './_connectionRuntime'
import { connectionMediaUrl, storePostGraphic } from './_connectionMedia'
import { ensureConnectionReviews, queueConnectionReview } from './_connectionReviews'
import { requestWebhook, webhookUrl } from './_connectionHttp'
import { refreshConnectionPost } from './_connectionPublishing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any
export async function ensureConnTable(c: Client): Promise<void> {
  if (new ConnectionStore(c).cloudflare) return
  await c.query(`
    CREATE TABLE IF NOT EXISTS nalu_connections (
      id         TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      app        TEXT NOT NULL,
      label      TEXT NOT NULL,
      method     TEXT NOT NULL DEFAULT 'webhook',
      username   TEXT,
      endpoint   TEXT,
      enc_secret TEXT,
      status     TEXT NOT NULL DEFAULT 'connected',
      meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    );
    -- Inbound READING: each connection gets a secret ingest token; the user's app
    -- (or a Zap/forwarding rule) POSTs new items here and Nalu reads them.
    ALTER TABLE nalu_connections ADD COLUMN IF NOT EXISTS ingest_token TEXT;
    CREATE TABLE IF NOT EXISTS nalu_inbound (
      id         TEXT PRIMARY KEY,
      conn_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      sender     TEXT,
      subject    TEXT,
      body       TEXT,
      meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS nalu_inbound_conn ON nalu_inbound (conn_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS nalu_conn_ingest ON nalu_connections (ingest_token);`)
}
const INGEST_BASE = () => (process.env.NALU_PUBLIC_BASE || 'https://n4lu.ai').replace(/\/+$/, '')

const uid = () => crypto.randomBytes(9).toString('hex')
// metadata the browser is allowed to see (NEVER the secret)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicRow = (r: any) => {
  const meta = Object.fromEntries(['destination', 'destinationName', 'accountId', 'verifiedAt', 'detail', 'privacy', 'capabilities'].filter(key => r.meta?.[key] != null).map(key => [key, r.meta[key]]))
  const incomplete = r.method === 'managed' || (!r.endpoint && !r.enc_secret && r.method !== 'resend') || (usesProvider(r) && r.method !== 'oauth' && !r.meta?.verifiedAt)
  return { id: r.id, app: r.app, label: r.label, method: r.method, username: r.username || '', endpoint: !!r.endpoint, status: incomplete && r.status !== 'error' ? 'pending' : r.status, hasSecret: !!r.enc_secret, meta, createdAt: r.created_at, ingestUrl: r.ingest_token ? `${INGEST_BASE()}/api/connect?ingest=${r.ingest_token}` : '' }
}

async function doSend(row: { app: string; method: string; username?: string; endpoint?: string; enc_secret?: string }, kind: string, payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const secret = row.enc_secret ? (() => { try { return decrypt(row.enc_secret!) } catch { return '' } })() : ''
  // 0b) Gmail / Outlook via an APP PASSWORD → send over SMTP (their real account).
  if (kind === 'email' && row.app === 'gmail' && secret && ['smtp', 'apikey'].includes(row.method)) {
    const to = String(payload.to || '')
    if (!to) return { ok: false, detail: 'no recipient' }
    try {
      const nodemailer = (await import('nodemailer')).default
      const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: row.username || '', pass: secret.replace(/\s+/g, '') }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 })
      try { await t.sendMail({ from: row.username || undefined, to, subject: String(payload.subject || 'From Nalu'), text: String(payload.text || payload.body || ''), ...(typeof payload.html === 'string' ? {html:payload.html} : {}) }) } finally { t.close() }
      return { ok: true, detail: `sent from your ${row.app} to ${to}` }
    } catch (e) {
      const m = e instanceof Error ? e.message : 'smtp failed'
      // 535 = the app-password is wrong; ETIMEDOUT/ECONNREFUSED = host blocks SMTP.
      return { ok: false, detail: /535|BadCredentials/.test(m) ? 'that Gmail/Outlook password was rejected — use an App Password (16 chars, with 2FA on)' : m.slice(0, 130) }
    }
  }
  // 1) A connected endpoint (the user's Zapier/Make/native webhook, or a platform
  //    ingest URL) — the universal non-technical path: POST the work to it.
  if (row.endpoint && /^https?:\/\//.test(row.endpoint)) {
    try {
      const r = await requestWebhook(row.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ app: row.app, kind, at: new Date().toISOString(), ...payload }),
      })
      return r.ok ? { ok: true, detail: `delivered to your ${row.app}` } : { ok: false, detail: `${row.app} endpoint returned ${r.status}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : 'endpoint unreachable' }
    }
  }
  // 2) Email with no endpoint → send via Nalu's transactional sender (Resend).
  if (kind === 'email' && ['resend', 'transactional'].includes(row.method) && emailConfigured()) {
    const to = String(payload.to || '')
    const subject = String(payload.subject || 'From Nalu')
    const text = String(payload.text || payload.body || '')
    if (!to) return { ok: false, detail: 'no recipient' }
    const html = typeof payload.html === 'string' ? payload.html : `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;white-space:pre-wrap">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`
    const res = await sendEmail({ to, subject, html, text })
    if (res.ok) return { ok: true, detail: `email sent to ${to}` }
    const err = res as { reason?: string; detail?: string }
    return { ok: false, detail: err.reason === 'not-configured' ? 'email sender not configured' : err.detail || 'send failed' }
  }
  return { ok: false, detail: 'this connection has no way to send yet — add a login or endpoint' }
}

async function dispatchConnection(c: ConnectionClient, userId: string, row: ConnectionRow, kind: string, payload: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  if (usesProvider(row)) {
    try {
      const result = await withProvider(c, userId, row, ctx => publishProvider(ctx, kind, payload))
      return result
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'The provider could not confirm delivery.' } }
  }
  if (row.method === 'managed') return { ok: false, detail: 'This saved connection has no account access. Open Connections and finish setup.' }
  return doSend(row, kind, payload)
}

async function verifyConnection(c: ConnectionClient, userId: string, row: ConnectionRow): Promise<{ ok: boolean; detail: string }> {
  if (usesProvider(row)) return verifyStoredAccount(c, userId, row)
  let result: { ok: boolean; detail: string }
  try {
    if (row.endpoint) {
      const response = await requestWebhook(row.endpoint, { method: 'HEAD', headers: row.enc_secret ? { Authorization: `Bearer ${decrypt(row.enc_secret)}` } : {} })
      result = response.ok || [405, 501].includes(response.status)
        ? { ok: true, detail: 'Webhook is reachable. Delivery will be confirmed when a pipeline sends work.' }
        : { ok: false, detail: `The webhook returned HTTP ${response.status}. Check its URL and authorization.` }
    } else if (row.app === 'gmail' && row.enc_secret && ['smtp', 'apikey'].includes(row.method)) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.username || '')) throw new Error('Enter your Gmail address.')
      const nodemailer = (await import('nodemailer')).default
      const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: row.username, pass: decrypt(row.enc_secret).replace(/\s+/g, '') }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 })
      try { await transport.verify() } finally { transport.close() }
      result = { ok: true, detail: 'Gmail app password verified. This connection can send email.' }
    } else if (row.method === 'resend' && emailConfigured()) {
      result = { ok: true, detail: 'Nalu sending service is configured. This sends from Nalu, not from your personal mailbox.' }
    } else result = { ok: false, detail: 'Finish connecting this account with provider sign-in or a supported token.' }
  } catch (error) { result = { ok: false, detail: error instanceof Error ? error.message : 'Connection verification failed.' } }
  await new ConnectionStore(c).verificationStatus(userId, row.id, result.ok ? 'connected' : 'error', { detail: result.detail, ...(result.ok ? { verifiedAt: Date.now() } : {}) }, row)
  return result
}

export async function sendPipelineOutput(c: ConnectionClient, userId: string, key: string, target: { connectionId?: string; webhook?: string }, kind: 'email' | 'post', payload: Record<string, unknown>): Promise<DeliveryResult> {
  if (!key || key.length > 400) return { ok: false, detail: 'Invalid pipeline delivery ID.' }
  // Scope saved credentials to the owner of this flow, including scheduled runs.
  const store = new ConnectionStore(c)
  const row = target.connectionId ? await store.get(userId, target.connectionId) : null
  if (target.connectionId && !row) return { ok: false, detail: 'The selected connection was not found. Reconnect it and start a new run.' }
  if (!row && !/^https?:\/\//.test(target.webhook || '')) return { ok: false, detail: 'Add a valid publisher connection or webhook.' }
  if (kind === 'email' && (!String(payload.to || '').trim() || /[\r\n]/.test(String(payload.to || '') + String(payload.subject || '')))) return { ok: false, detail: 'Add a valid email recipient and subject.' }
  if (row && usesProvider(row) && row.app === 'tiktok') {
    const prior = await readPipelineDelivery(c, userId, key)
    if (prior) return prior
    if (!payload.videoUrl || !payload.outputId) return { ok: false, detail: 'TikTok needs a saved video. Set this social step to Video and run it again.' }
    return queueConnectionReview(c, userId, key, row.id, row.meta?.accountId || '', payload)
  }
  if (row && usesProvider(row) && ['instagram', 'facebook'].includes(row.app) && !payload.videoUrl && !payload.image) {
    payload = { ...payload, image: await storePostGraphic(c, userId, key, payload) }
  }
  if (row && usesProvider(row) && row.app === 'instagram' && payload.outputId && payload.videoUrl) {
    payload = { ...payload, videoUrl: await connectionMediaUrl(c, userId, String(payload.outputId), 'video') }
  }
  // Save the job before the provider call. If the request ends after the durable
  // receipt is written, cron can still find and finish this exact container.
  if (row?.app === 'instagram' && usesProvider(row)) await queueConnectionReview(c, userId, key, row.id, row.meta?.accountId || '', payload)
  const result = await deliverPipelineOnce(c, userId, key, async () => {
    if (row) return dispatchConnection(c, userId, row as ConnectionRow, kind, payload)
    const response = await requestWebhook(target.webhook!, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ ...payload, kind, at: new Date().toISOString() }) })
    return response.ok ? { ok: true, detail: 'Delivered to your publisher' } : { ok: false, detail: `Publisher returned HTTP ${response.status}. The draft is saved. Fix the connection and start a new run.` }
  })
  if (row?.app === 'instagram' && usesProvider(row) && result.ok && result.status === 'accepted') {
    await store.completeReview(userId, key, result)
  }
  return result
}

export async function connectedEmailSender(c: Client, uid: string):Promise<{available:boolean;label:string}> {
  await ensureConnTable(c)
  const row=await new ConnectionStore(c).emailAccount(uid, true)
  if(row)return {available:true,label:row.username || (row.app==='gmail'?'Your connected Gmail account':'Your connected Outlook account')}
  return emailConfigured() ? {available:true,label:process.env.RESET_FROM || 'Nalu <noreply@n4lu.ai>'} : {available:false,label:'Connect Gmail or Outlook in Nalu to send directly.'}
}

// Call follow-ups may use a connected mail account, never an arbitrary webhook.
export async function sendConnectedEmail(c: Client, uid: string, payload: {to:string;subject:string;text:string;html?:string}):Promise<{ok:boolean;detail:string}> {
  if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(payload.to) || /[\r\n]/.test(payload.subject)) return {ok:false,detail:'Invalid email destination.'}
  await ensureConnTable(c)
  const row=await new ConnectionStore(c).emailAccount(uid)
  if (!row && !emailConfigured()) return {ok:false,detail:'Connect Gmail or Outlook in Nalu to email this follow-up. The details are saved in Nalu.'}
  let timer:ReturnType<typeof setTimeout>|undefined
  try { return await Promise.race([row ? dispatchConnection(c, uid, row as ConnectionRow, 'email', payload) : doSend({app:'email',method:'transactional'},'email',payload),new Promise<{ok:boolean;detail:string}>(resolve=>{timer=setTimeout(()=>resolve({ok:false,detail:'Email acceptance is unconfirmed. Check your sent mail before retrying.'}),18000)})]) }
  finally {if(timer)clearTimeout(timer)}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (cors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {})
  // Inbound READ: external apps POST new items to ?ingest=<token> — no login (the
  // token IS the auth). This is how Nalu "reads" your inbox/feed/mentions.
  const ingestTok = (() => { const m = /(?:\?|&)ingest=([a-f0-9]+)/.exec(req.url || ''); return m ? m[1] : (typeof body.ingest === 'string' ? body.ingest : '') })()
  const action = ingestTok ? 'ingest' : String(body.action || 'list')
  const token = readToken(req)
  const backend = connectionBackend(), c = backend.client, store = new ConnectionStore(c)
  try {
    await backend.connect()
    await ensureConnTable(c)
    if (action === 'ingest') {
      const account = await store.ingestAccount(ingestTok)
      if (!account) { res.status(404).json({ error: 'unknown ingest token' }); return }
      await store.ingest(uid(), account.id, account.user_id, String(body.from || body.sender || ''), String(body.subject || ''), String(body.body || body.text || ''), body.meta && typeof body.meta === 'object' ? body.meta : {})
      res.status(200).json({ ok: true, received: true })
      return
    }
    const userId = await backend.userId(token)
    if (!userId) { res.status(401).json({ error: 'sign in to manage connections' }); return }

    if (action === 'list') {
      res.status(200).json({ connections: (await store.list(userId)).map(publicRow) })
      return
    }
    if (action === 'inbox') {
      if (body.id) {
        const row = await store.get(userId, String(body.id))
        if (!row) { res.status(404).json({ error: 'Connection not found.' }); return }
        if (usesProvider(row)) {
          const items = await withProvider(c, userId, row, ctx => readProviderInbox(ctx, Number(body.limit) || 20))
          res.status(200).json({ items: items.map(item => ({ ...item, connId: row.id })) }); return
        }
      }
      // Read recent inbound items for a connection (what Nalu received FROM the app).
      const limit = Math.max(1, Math.min(Math.floor(Number(body.limit) || 25), 100))
      const items = await store.inbox(userId, body.id ? String(body.id) : undefined, limit)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.status(200).json({ items: items.map((x: any) => ({ id: x.id, connId: x.conn_id, from: x.sender || '', subject: x.subject || '', body: x.body || '', receivedAt: x.received_at })) })
      return
    }
    if (action === 'save') {
      const id = String(body.id || uid())
      const app = String(body.app || 'app').toLowerCase()
      const definition = connectionApp(app)
      const prior = body.id ? await store.get(userId, id) : undefined
      if (!definition || !id || id.length > 200 || (prior && prior.app !== app)) { res.status(400).json({ error: 'Choose a supported connection.' }); return }
      const label = String(body.label || definition.name).trim().slice(0, 150)
      const method = String(body.method || prior?.method || 'apikey')
      if (!['oauth', 'apikey', 'smtp', 'endpoint', 'webhook'].includes(method) || (method === 'oauth' && (!prior || body.secret))) { res.status(400).json({ error: 'Use provider sign-in, a supported access token, or a webhook to connect this app.' }); return }
      if (app === 'outlook' && method !== 'oauth' && !['endpoint', 'webhook'].includes(method)) { res.status(400).json({ error: 'Use Microsoft sign-in to connect Outlook. Password-based mailbox access is not supported.' }); return }
      const username = body.username != null ? String(body.username).trim().slice(0, 320) : prior?.username || null
      const isWebhook = ['endpoint', 'webhook'].includes(method)
      const endpoint = isWebhook ? (body.endpoint != null ? String(body.endpoint).trim() : prior?.endpoint || null) : null
      if (endpoint) {
        try { webhookUrl(endpoint) } catch { res.status(400).json({ error: 'Enter a valid public HTTPS webhook URL.' }); return }
      }
      if (['endpoint', 'webhook'].includes(method) && !endpoint) { res.status(400).json({ error: 'Add the webhook URL.' }); return }
      const meta = { ...(prior?.meta || {}), ...cleanConnectionMetadata(body.meta) }
      // Only re-encrypt when a NEW secret is provided; blank keeps the existing one.
      const hasNew = body.secret != null && String(body.secret) !== ''
      const encSecret = hasNew ? encrypt(String(body.secret).trim()) : prior?.method === method && (prior.endpoint || null) === endpoint ? prior.enc_secret || null : null
      if (!endpoint && !encSecret) { res.status(400).json({ error: `Sign in to ${definition.name} or provide a supported access token before connecting.` }); return }
      const ingest = crypto.randomBytes(16).toString('hex') // only used for brand-new rows
      await store.saveManual([id, userId, app, label, method, username, endpoint, encSecret, meta, ingest], prior)
      const saved = await store.get(userId, id)
      if (!saved) { res.status(409).json({ error: 'This connection was removed while it was being saved.' }); return }
      const verified = await verifyConnection(c, userId, saved)
      const current = await store.get(userId, id)
      if (!current) { res.status(409).json({ error: 'This connection was removed while it was being checked.' }); return }
      res.status(verified.ok ? 200 : 400).json({ ok: verified.ok, ...(!verified.ok ? { error: verified.detail } : {}), detail: verified.detail, connection: publicRow(current) })
      return
    }
    if (action === 'destinations') {
      const row = await store.get(userId, String(body.id))
      if (!row) { res.status(404).json({ error: 'Connection not found.' }); return }
      if (!usesProvider(row)) { res.status(200).json({ items: [] }); return }
      const result = await withProvider(c, userId, row, ctx => providerDestinations(ctx, String(body.cursor || '').slice(0, 500)))
      res.status(200).json(result); return
    }
    if (action === 'delete') {
      await store.remove(userId, String(body.id))
      res.status(200).json({ ok: true })
      return
    }
    if (['reviews', 'review', 'review-publish', 'review-status', 'pipeline-status'].includes(action)) {
      await ensureConnectionReviews(c)
      if (action === 'reviews') {
        const rows = await store.reviews(userId)
        res.status(200).json({ reviews: rows }); return
      }
      const key = String(body.deliveryKey || '')
      if (!key || key.length > 400) { res.status(400).json({ error: 'Invalid delivery ID.' }); return }
      const review = await store.review(userId, key)
      if (action === 'pipeline-status') {
        const delivery = review ? await readPipelineDelivery(c, userId, key) : null
        res.status(200).json({ delivery: delivery || (review ? { ok: false, reviewRequired: true, detail: 'Video saved. Open Connections to review this TikTok post, then resume the pipeline.' } : null), summary: review?.payload?.resultSummary || review?.payload?.text || '' }); return
      }
      if (!review) { res.status(404).json({ error: 'Post review not found.' }); return }
      const row = await store.get(userId, review.connection_id)
      if (!row || !['instagram', 'tiktok'].includes(row.app) || row.meta?.accountId !== review.account_id) { res.status(409).json({ error: 'This post belongs to a different connected account. Restore that account or start a new run.' }); return }
      if (action === 'review-status') {
        res.status(200).json({ delivery: await refreshConnectionPost(c, userId, row, key) }); return
      }
      if (row.app !== 'tiktok') { res.status(400).json({ error: 'This media is already queued for processing. Use Check status.' }); return }
      if (action === 'review') {
        const creator = await withProvider(c, userId, row, tiktokCreator)
        const videoUrl = review.payload.outputId ? await connectionMediaUrl(c, userId, String(review.payload.outputId), 'video') : review.payload.videoUrl
        res.status(200).json({ creator, videoUrl, title: String(review.payload.text || review.payload.caption || review.payload.filename || '').slice(0, 2200) }); return
      }
      if (body.settings?.consent !== true) { res.status(400).json({ error: 'Review the video and agree to TikTok’s posting terms before publishing.' }); return }
      const prior = await readPipelineDelivery(c, userId, key)
      if (prior) { res.status(200).json(prior); return }
      const creator = await withProvider(c, userId, row, tiktokCreator)
      validateTikTokReview({ data: creator }, body.settings)
      const videoUrl = review.payload.outputId ? await connectionMediaUrl(c, userId, String(review.payload.outputId), 'video') : review.payload.videoUrl
      const payload = { ...review.payload, videoUrl, text: String(body.title || '').slice(0, 2200), tiktok: body.settings }
      const delivery = await deliverPipelineOnce(c, userId, key, () => dispatchConnection(c, userId, row, 'post', payload))
      await store.completeReview(userId, key, delivery)
      res.status(200).json(delivery); return
    }
    if (action === 'pipeline-send') {
      const out = await sendPipelineOutput(c, userId, String(body.deliveryKey || ''), { connectionId: body.id ? String(body.id) : undefined, webhook: body.webhook ? String(body.webhook) : undefined }, body.kind === 'email' ? 'email' : 'post', body.payload && typeof body.payload === 'object' ? body.payload : {})
      res.status(out.ok || out.reviewRequired ? 200 : 502).json(out)
      return
    }
    if (action === 'test' || action === 'send') {
      const row = await store.get(userId, String(body.id))
      if (!row) { res.status(404).json({ error: 'connection not found' }); return }
      if (action === 'test') {
        const out = await verifyConnection(c, userId, row)
        res.status(out.ok ? 200 : 502).json(out)
        return
      }
      const out = await dispatchConnection(c, userId, row as ConnectionRow, String(body.kind || 'post'), { to: body.to, subject: body.subject, body: body.body, text: body.text, ...(body.meta || {}) })
      res.status(out.ok ? 200 : 502).json(out)
      return
    }
    res.status(400).json({ error: 'unknown action' })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'connection error' })
  } finally {
    await backend.close().catch(() => {})
  }
}
