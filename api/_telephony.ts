// Telnyx TeXML transport. No legacy carrier credentials or fallback are used.
// Required: TELNYX_API_KEY, TELNYX_ACCOUNT_SID, TELNYX_APPLICATION_SID,
// TELNYX_PHONE_NUMBER, TELNYX_PUBLIC_KEY. PUBLIC_BASE_URL defaults to n4lu.ai.
import crypto from 'node:crypto'
import { TEAM_VOICES } from './_team'
import { phoneVoiceName } from './_phoneVoice'
export type PhoneVoice = 'britishWoman' | 'britishMan' | `Polly.${string}-Neural`

export function phoneConfigured(): boolean {
  return !!(process.env.TELNYX_API_KEY && process.env.TELNYX_ACCOUNT_SID &&
    process.env.TELNYX_APPLICATION_SID && process.env.TELNYX_PUBLIC_KEY &&
    /^\+[1-9]\d{7,14}$/.test(process.env.TELNYX_PHONE_NUMBER || ''))
}

export function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL || 'https://n4lu.ai').replace(/\/$/, '')
}

// ---- TeXML ------------------------------------------------------------------

// Clean a text reply for speaking aloud: strip markdown, collapse whitespace and
// bullet lists into flat prose, and cap length so a phone reply stays short.
export function forSpeech(text: string, maxChars = 600): string {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')            // code blocks
    .replace(/`([^`]+)`/g, '$1')                 // inline code
    .replace(/\*\*|__|\*|_|#+|>/g, '')           // bold/italic/headings/quotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links → link text
    .replace(/https?:\/\/\S+/g, '')              // bare URLs (unspeakable)
    .replace(/^\s*[-*•]\s+/gm, ', ')             // bullets → commas
    .replace(/\r?\n+/g, '. ')                     // newlines → sentence breaks
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.,]){2,}/g, '$1')
    .trim()
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    s = (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim()
  }
  return s
}

export function xmlEscape(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Send a TeXML document as the response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sendCallXml(res: any, inner: string): void {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8')
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`)
}

/** Use carrier speech by default so calls do not depend on a separate TTS API.
 *  Opt in to the app's neural voice with NALU_PHONE_TTS=neural. */
export function speak(text: string, voice: PhoneVoice = 'britishWoman'): string {
  if (voice.startsWith('Polly.') || process.env.NALU_PHONE_TTS !== 'neural') return sayPolly(text, voice)
  const url = `${publicBase()}/api/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text.slice(0, 1500))}`
  return `<Play>${xmlEscape(url)}</Play>`
}

/** Carrier-hosted speech. The legacy helper name is retained for callers.
 *  Ultra is a reversible quality upgrade; stored agent voice identities stay stable. */
export function sayPolly(text: string, voice: PhoneVoice = 'britishWoman'): string {
  const name = TEAM_VOICES.includes(voice) ? voice : voice === 'britishMan' ? 'Polly.Brian-Neural' : 'Polly.Amy-Neural'
  return `<Say voice="${phoneVoiceName(name)}" language="en-GB">${xmlEscape(text)}</Say>`
}

// ---- Inbound webhook signature validation -----------------------------------

/** Verify the original bytes before parsing. Reject absent keys, bad signatures,
 *  and stale/future timestamps; a parsed/reserialized object is never accepted. */
export function validateSignature(raw: Buffer, timestamp: string | undefined, signature: string | undefined): boolean {
  const publicKey = process.env.TELNYX_PUBLIC_KEY
  if (!publicKey || !signature || !timestamp || !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  try {
    const bytes = Buffer.from(publicKey, 'base64')
    const sig = Buffer.from(signature, 'base64')
    if (bytes.length !== 32 || sig.length !== 64) return false
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp + '|'), raw]), key, sig)
  } catch { return false }
}

export async function readWebhookBody(req: any): Promise<Buffer> {
  const limit = 65536
  // Vercel installs a lazy parsed `body` getter and restores the original bytes
  // through data/end listeners. Read that stream before touching the getter.
  // Its IncomingMessage may already report readableEnded, so async iteration
  // alone does not reliably consume the restored stream.
  if (typeof req.on === 'function') {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let failed = false
      req.on('error', (error: Error) => { failed = true; reject(error) })
      req.on('aborted', () => { failed = true; reject(new Error('Webhook aborted')) })
      req.on('data', (chunk: Buffer | string) => {
        if (failed) return
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > limit) {
          failed = true
          chunks.length = 0
          reject(new Error('Webhook too large'))
          return
        }
        chunks.push(bytes)
      })
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    })
  }
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    const raw = Buffer.from(req.body)
    if (raw.length > limit) throw new Error('Webhook too large')
    return raw
  }
  if (req.body != null) throw new Error('Webhook raw body unavailable')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new Error('Webhook too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

/** Reconstruct the exact URL Telnyx signed (it signs the URL it requested). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requestUrl(req: any): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https'
  const host = (req.headers['x-forwarded-host'] as string) || (req.headers['host'] as string) || 'n4lu.ai'
  return `${proto}://${host}${req.url}`
}

/** Parse a Telnyx webhook body (application/x-www-form-urlencoded). Vercel may
 *  hand us an already-parsed object or the raw string — handle both. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseForm(req: any): Record<string, string> {
  const out: Record<string, string> = {}
  const b = req.body
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) {
    for (const [k, v] of Object.entries(b)) out[k] = Array.isArray(v) ? String(v[0]) : String(v)
    return out
  }
  const raw = Buffer.isBuffer(b) ? b.toString('utf-8') : typeof b === 'string' ? b : ''
  if (raw) for (const [k, v] of new URLSearchParams(raw)) out[k] = v
  return out
}

// ---- Outbound: Telnyx TeXML REST API -----------------------------------------
export async function placeCall(to: string, instructionUrl: string): Promise<{ ok: boolean; sid?: string; error?: string }> {
  if (!phoneConfigured()) return { ok: false, error: 'Telnyx phone service is not configured. Add the account, TeXML application, API/public keys and voice number.' }
  try {
    // Never retry an ambiguous carrier result: the first request may have rung.
    const r = await fetch(`https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(process.env.TELNYX_ACCOUNT_SID!)}/Calls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ApplicationSid: process.env.TELNYX_APPLICATION_SID, To: to, From: process.env.TELNYX_PHONE_NUMBER, Url: instructionUrl, UrlMethod: 'POST' }),
      signal: AbortSignal.timeout(10_000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: `Telnyx rejected the call (HTTP ${r.status}). Check the provider configuration and account balance.` }
    // Some TeXML API versions return only status/from/to. The signed answer
    // webhook supplies CallSid and binds it to the pending question in that case.
    const sid = j.sid || j.call_sid
    if (typeof sid === 'string' && sid) return { ok: true, sid }
    if (['queued', 'initiated', 'ringing', 'in-progress'].includes(j.status)) return { ok: true }
    return { ok: false, error: 'Telnyx returned an unrecognized call result. Delivery is uncertain; check the provider call log before retrying.' }
  } catch {
    return { ok: false, error: 'Telnyx call delivery could not be confirmed. Check the provider call log before retrying.' }
  }
}

// ---- HMAC signing for outbound TeXML context (tamper-proof query params) -----

function secret(): string {
  const key = process.env.NALU_SESSION_SECRET || process.env.TELNYX_API_KEY
  if (!key) throw new Error('Phone signing secret is not configured.')
  return key
}
export function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex').slice(0, 32)
}
export function verifySig(value: string, sig: string): boolean {
  const expected = sign(value)
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig || ''))
  } catch {
    return false
  }
}

// ---- Get a chat reply as plain text (drains the /api/chat SSE stream) --------

/** Ask Inkling for a reply and return the plain text (spoken over the phone).
 *  Sends the user's Bearer token so the reply is personalized to the account. */
export async function chatReply(messages: { role: string; content: string }[], token?: string): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let full = ''
  try {
    const r = await fetch(`${publicBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      // Keep it snappy: Telnyx drops a voice webhook that doesn't answer in ~15s,
      // and a phone reply should be short and spoken anyway. Execution is queued
      // by phone.ts; this request only provides a bounded conversational reply.
      body: JSON.stringify({
        messages, reasoning: 'none', webSearch: false, maxTokens: 200,
        systemPrompt: "You are Nalu on a phone call. Plain spoken text, no markdown or URLs. Answer the actual question in natural spoken language. Use earlier details and the latest correction; do not ask for information already supplied. Handle short follow-ups such as 'why', 'the second one', or 'what about tomorrow' in context. Discuss ordinary life and general topics as readily as work. Start with the useful answer, not a repeated acknowledgment or description of your capabilities. Do not repeat your previous answer, introduce yourself again, or end every turn with a question. Ask a follow-up only when it changes what you need to do. Usually use two or three concise sentences; give more detail when asked. Do not claim to be human or claim an action happened without evidence.",
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!r.ok || !r.body) return ''
    reader = (r.body as unknown as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = '', event = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1)
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
        if (!line.startsWith('data:')) continue
        try {
          const d = JSON.parse(line.slice(5).trim())
          if (event === 'delta' && typeof d.text === 'string') full += d.text
        } catch { /* skip */ }
      }
    }
    return full.trim()
  } catch {
    return full.trim()
  } finally {
    await reader?.cancel().catch(() => {})
  }
}
