// Shared, robust LLM completion for Nalu's Studio tools + chat fallback.
//
// Why this exists: every Studio endpoint used to fire a single fetch at one
// provider (Tinker). If that provider was slow or down, the whole tool hung
// until the function timed out. This helper makes every call:
//   1. FAIL FAST — a per-attempt AbortController timeout, so a hung upstream is
//      abandoned in seconds instead of stalling the request.
//   2. FAIL OVER — a chain of OpenAI-compatible providers (primary Tinker →
//      secondary HuggingFace router) so one provider's outage never takes a tool
//      down. The secondary reuses the existing HUGGINGFACE_API_TOKEN — no new
//      secret required — and is fully env-overridable.
//   3. RETRY — the primary gets one quick retry (covers transient blips) before
//      we spend latency failing over.
//
// Underscore-prefixed → bundled into the functions that import it, NOT its own
// Vercel route (keeps us under the Hobby 12-function cap).

import { cancellationSignal } from './_requestCancellation'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

// ── Byte-level-BPE repair ─────────────────────────────────────────────────
// Tinker's OAI endpoint for Inkling intermittently returns UNDETOKENIZED text:
// raw GPT-2/Llama byte-level-BPE token strings, where a space is 'Ġ', a newline
// is 'Ċ', and non-ASCII UTF-8 bytes appear as their printable stand-ins (so "—"
// arrives as "âĢĶ" and "'" as "âĢĻ"). The result is unreadable ("AĠunicornĠisâĢ¦").
// This maps those printable stand-ins back to the raw bytes and decodes UTF-8,
// salvaging an otherwise-garbled answer. It is a NO-OP on already-clean text.
//
// The GPT-2 byte↔unicode alphabet: printable codepoint → raw byte (0-255).
const BPE_CP_TO_BYTE: Map<number, number> = (() => {
  const bs: number[] = []
  for (let i = 33; i <= 126; i++) bs.push(i)
  for (let i = 161; i <= 172; i++) bs.push(i)
  for (let i = 174; i <= 255; i++) bs.push(i)
  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++ }
  const m = new Map<number, number>()
  for (let i = 0; i < bs.length; i++) m.set(cs[i], bs[i])
  return m
})()

// True when text carries the byte-BPE space/newline markers (U+0120 'Ġ',
// U+010A 'Ċ') that never occur in real answer text — the tell that a response
// came back undetokenized.
export function looksByteLevelBpe(s: string): boolean {
  return typeof s === 'string' && /[ĠĊ]/.test(s)
}

function bpeCharsToBytes(s: string, out: number[]): void {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    const b = BPE_CP_TO_BYTE.get(cp)
    if (b !== undefined) out.push(b)
    else for (const eb of new TextEncoder().encode(ch)) out.push(eb) // pass real text through
  }
}

// Decode a full byte-BPE string back to UTF-8. No-op if it isn't byte-BPE.
export function repairByteLevelBpe(s: string): string {
  if (!looksByteLevelBpe(s)) return s
  try {
    const bytes: number[] = []
    bpeCharsToBytes(s, bytes)
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
  } catch {
    return s
  }
}

// Streaming repairer for chunked deltas: once byte-BPE is detected it latches on
// for the rest of the stream and decodes each chunk UTF-8-safely, holding any
// incomplete trailing multi-byte sequence until the next chunk (so an em-dash
// split across two deltas still decodes correctly). Returns the repaired chunk.
export function makeStreamingBpeRepair(): (chunk: string) => string {
  let active = false
  const dec = new TextDecoder('utf-8', { fatal: false })
  return (chunk: string): string => {
    if (!chunk) return chunk
    if (!active) {
      if (!looksByteLevelBpe(chunk)) return chunk
      active = true
    }
    const bytes: number[] = []
    bpeCharsToBytes(chunk, bytes)
    return dec.decode(new Uint8Array(bytes), { stream: true })
  }
}

export interface Provider {
  base: string
  key: string
  model: string
  label: string
}

const TINKER_BASE = 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
const HF_ROUTER_BASE = 'https://router.huggingface.co/v1'
// A capable, widely-served default that BOTH the primary (Tinker) and the
// HuggingFace router can run, so failover lands on a real, equivalent model.
// The default served model (baseline when no specialist LoRA matches). Set
// NALU_DEFAULT_MODEL=thinkingmachines/Inkling to make Inkling the serving baseline
// (975B MoE — stronger, but pricier per token, so it's an explicit env flip).
const DEFAULT_MODEL = process.env.NALU_DEFAULT_MODEL || 'thinkingmachines/Inkling'

/** The primary provider (Tinker), if configured. */
export function primaryProvider(model?: string): Provider | null {
  const key = env('TINKER_API_KEY')
  if (!key) return null
  return {
    base: (env('TINKER_BASE_URL') || TINKER_BASE).replace(/\/+$/, ''),
    key,
    model: model || DEFAULT_MODEL,
    label: 'primary',
  }
}

/** The secondary failover provider (HuggingFace router by default). */
export function fallbackProvider(): Provider | null {
  const key = env('NALU_FALLBACK_API_KEY') || env('HUGGINGFACE_API_TOKEN')
  if (!key) return null
  return {
    base: (env('NALU_FALLBACK_BASE_URL') || HF_ROUTER_BASE).replace(/\/+$/, ''),
    key,
    // The fallback model is deliberately a generic, router-served id (NOT the
    // primary's Tinker-only Inkling), so the failover actually serves on HF.
    model: env('NALU_FALLBACK_MODEL') || 'deepseek-ai/DeepSeek-V3.1',
    label: 'fallback',
  }
}

/** Last-resort emergency provider: Gemini's OpenAI-compatible endpoint on the
 *  existing GEMINI key (already a trusted vendor here — it serves vision). Only
 *  reached when the primary AND the fallback are down/limited, so users see an
 *  answer instead of "over capacity". Disable with NALU_DISABLE_EMERGENCY=1. */
export function emergencyProvider(): Provider | null {
  if (env('NALU_DISABLE_EMERGENCY')) return null
  const key = env('GEMINI_API_KEY') || env('GOOGLE_AI_API_KEY') || env('GOOGLE_GENAI_API_KEY')
  if (!key) return null
  return {
    base: (env('NALU_EMERGENCY_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
    key: key.trim(),
    model: env('NALU_EMERGENCY_MODEL') || 'gemini-2.5-flash',
    label: 'emergency',
  }
}

/** Ordered provider chain for a request. */
export function providerChain(model?: string): Provider[] {
  const chain: Provider[] = []
  const p = primaryProvider(model)
  if (p) chain.push(p)
  const f = fallbackProvider()
  if (f) chain.push(f)
  const e = emergencyProvider()
  if (e) chain.push(e)
  return chain
}

export interface CompleteOpts {
  maxTokens?: number
  temperature?: number
  timeoutMs?: number // per-attempt watchdog
  signal?: AbortSignal // caller cancellation stops active work and all later attempts
  model?: string // primary model override (per endpoint)
  retryPrimary?: boolean // give the primary one retry before failing over
  maxAttempts?: number // optional total attempt cap for latency-sensitive callers
  providers?: Provider[] // explicit chain (otherwise built from env)
  json?: boolean // ask the provider for native JSON output (response_format)
  frequencyPenalty?: number
  presencePenalty?: number
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' // Inkling: override the 'low' default (e.g. 'none' for tiny classify calls)
}

export interface CompleteResult {
  content: string
  finishReason: string // 'stop' | 'length' | '' — lets callers detect truncation
}

export type CompletionFailure = { category: 'timeout' | 'rate_limit' | 'quota' | 'input_limit' | 'provider_http' | 'empty_response' | 'unavailable'; status?: number; finishReason?: 'length' | 'stop' | 'other' }
export function completionFailure(error: unknown): CompletionFailure | undefined {
  return error instanceof Error ? (error as Error & { completionFailure?: CompletionFailure }).completionFailure : undefined
}

type Msg = { role: string; content: unknown }

class TimeoutError extends Error {}
const cancellationError = (): DOMException => new DOMException('The request was cancelled.', 'AbortError')
function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError()
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(cancellationError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
// Carries the upstream HTTP status + body so the failover logic can tell a
// "request too big" (shrink & retry) apart from "out of credits" (fail over).
class ProviderError extends Error {
  status: number
  body: string
  label: string
  constructor(label: string, status: number, body: string) {
    super(`${label} ${status}: ${body.slice(0, 200)}`)
    this.label = label
    this.status = status
    this.body = body
  }
}

// The request exceeded THIS provider's per-call token/context cap — shrinking
// max_tokens and retrying the SAME provider usually fixes it (e.g. a 16k-token
// sheet ask that a host caps lower). This is what surfaced as "403 out of tokens".
const SIZE_ERR = /max_?tokens|maximum context|context (?:length|window)|too (?:long|many tokens)|reduce (?:the )?(?:length|tokens|max)|token.{0,14}(?:limit|exceed)|length limit|exceeds?.{0,24}(?:context|limit|maximum)|request too large/i
// The provider is out of credits / rate-limited — no point re-asking IT; fail over.
const QUOTA_ERR = /quota|credit|balance|insufficient|out of (?:credit|quota|token|balance)|billing|payment required|exceeded your|too many requests|rate.?limit|429/i
function isSizeError(e: unknown): boolean {
  return e instanceof ProviderError && [400, 403, 413, 422].includes(e.status) && SIZE_ERR.test(`${e.body} ${e.message}`)
}
function isQuotaError(e: unknown): boolean {
  return e instanceof ProviderError && (e.status === 402 || e.status === 429 || (e.status === 403 && QUOTA_ERR.test(`${e.body} ${e.message}`)))
}
// A 429-style burst rate limit is TRANSIENT — a short backoff on the SAME
// provider usually clears it (this is the #1 cause of user-visible "over
// capacity" under load). Being genuinely out of credits (402) is not.
function isRateLimited(e: unknown): boolean {
  return e instanceof ProviderError && (e.status === 429 || /too many requests|rate.?limit/i.test(`${e.body} ${e.message}`))
}

/** One non-streaming completion against one provider, with a hard timeout. */
async function callOne(p: Provider, messages: Msg[], opts: CompleteOpts, timeoutMs: number, maxTokens: number): Promise<CompleteResult> {
  throwIfCancelled(opts.signal)
  const ac = new AbortController()
  const deadline = Date.now() + timeoutMs
  let response: Response | undefined
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let interruption: Error | undefined
  let rejectInterruption!: (error: Error) => void
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterruption = reject })
  const cancelTransport = () => {
    try { ac.abort() } catch { /* best-effort transport cancellation */ }
    // Own the body reader so a stalled body can be cancelled without waiting
    // for fetch/json to honor AbortSignal. Never await a transport's cleanup.
    const reader = bodyReader
    try { void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}) } catch { /* already closed/locked */ }
    if (reader) {
      try { reader.releaseLock() } catch { /* already released */ }
      if (bodyReader === reader) bodyReader = undefined
    }
  }
  const stop = (error: Error) => {
    if (interruption) return
    interruption = error
    // Reject independently of abort: a custom transport or blocked connection
    // can ignore abort indefinitely. Late work remains observed by the race.
    rejectInterruption(error)
    cancelTransport()
  }
  const timeout = () => new TimeoutError(`${p.label}: timed out after ${timeoutMs}ms`)
  const onAbort = () => stop(cancellationError())
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => stop(timeout()), timeoutMs)
  const check = () => {
    if (opts.signal?.aborted) stop(cancellationError())
    if (!interruption && Date.now() >= deadline) stop(timeout())
    if (interruption) throw interruption
  }
  const readText = async (r: Response): Promise<string> => {
    if (!r.body?.getReader) return r.text()
    const reader = r.body.getReader()
    bodyReader = reader
    const decoder = new TextDecoder()
    let text = ''
    try {
      for (;;) {
        const chunk = await reader.read()
        check()
        if (chunk.done) return text + decoder.decode()
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      if (bodyReader === reader) bodyReader = undefined
      try { reader.releaseLock() } catch { /* interrupted read already released */ }
    }
  }
  const work = async (): Promise<CompleteResult> => {
    check()
    // Gemini's OpenAI-compat endpoint 400s on the penalty fields — strip them there.
    const isGemini = /generativelanguage\.googleapis/i.test(p.base)
    // Inkling (base or a trained Inkling LoRA) is a REASONING model: without a
    // reasoning_effort it dumps its chain-of-thought into `content`. Setting it to
    // 'low' routes reasoning to `reasoning_content` and leaves `content` clean.
    const isInkling = /inkling/i.test(p.model)
    const r = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        messages,
        stream: false,
        max_tokens: maxTokens,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(!isGemini && opts.frequencyPenalty != null ? { frequency_penalty: opts.frequencyPenalty } : {}),
        ...(!isGemini && opts.presencePenalty != null ? { presence_penalty: opts.presencePenalty } : {}),
        // flash / reasoning models burn the budget on internal thinking and leak
        // it into content unless told to keep reasoning light
        ...(isGemini || isInkling ? { reasoning_effort: opts.reasoningEffort || 'low' } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ac.signal,
    })
    response = r
    // Headers can arrive after the race has already rejected. Cancel that late
    // body immediately and never consume or accept its result.
    if (interruption) cancelTransport()
    check()
    if (!r.ok) {
      const t = await readText(r).catch(() => '')
      check()
      throw new ProviderError(p.label, r.status, t)
    }
    // Read each real response body once. The json fallback supports compatible
    // transports without a standard Response body/text API.
    const d = (await (r.body?.getReader ? readText(r).then(text => JSON.parse(text)) : r.json()).catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> }
      | null
    check()
    const content = d?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      const finish = d?.choices?.[0]?.finish_reason
      throw Object.assign(new Error(`${p.label}: empty response`), { completionFailure: { category: 'empty_response', finishReason: finish === 'length' || finish === 'stop' ? finish : 'other' } as CompletionFailure })
    }
    // Salvage the rare undetokenized (byte-level-BPE) response from the primary.
    return { content: repairByteLevelBpe(content), finishReason: d?.choices?.[0]?.finish_reason || '' }
  }
  try {
    return await Promise.race([work(), interrupted])
  } catch (e) {
    throwIfCancelled(opts.signal)
    if (interruption) throw interruption
    throw e
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

// Turn whatever went wrong into a SHORT, user-safe message with NO provider names
// or raw status text — so a tool never surfaces "primary 403: out of tokens".
function safeErrorMessage(e: unknown): string {
  if (e instanceof TimeoutError) return 'The Nalu engine took too long to respond — please try again.'
  if (isQuotaError(e)) return 'The Nalu engine is over capacity right now — please try again in a moment.'
  if (isSizeError(e)) return 'That request was a bit too large to generate — try trimming it and rerun.'
  return 'The Nalu engine is temporarily unavailable — please try again.'
}

// Retain only safe operational facts when the public error is scrubbed. Never
// retain the upstream body, raw message, prompt, credentials or nested cause.
function safeCompletionError(error: unknown): Error {
  const failure: CompletionFailure = completionFailure(error) || {
    category: error instanceof TimeoutError ? 'timeout' : isRateLimited(error) ? 'rate_limit' : isQuotaError(error) ? 'quota' : isSizeError(error) ? 'input_limit' : error instanceof ProviderError ? 'provider_http' : 'unavailable',
    ...(error instanceof ProviderError ? { status: error.status } : {}),
  }
  return Object.assign(new Error(safeErrorMessage(error)), { completionFailure: failure })
}

/**
 * Non-streaming completion with timeout + multi-provider failover, returning the
 * content AND finish_reason. Throws a CLEAN, scrubbed error only if EVERY attempt
 * fails (callers can surface it directly).
 *
 * Failover is smart:
 *  - a provider that TIMES OUT is abandoned immediately (don't burn a second window);
 *  - a request that's TOO BIG for a provider is retried on that SAME provider with
 *    max_tokens halved (down to a floor) — this is the "403 out of tokens" fix;
 *  - a provider that's OUT OF CREDITS / rate-limited is skipped straight to the next;
 *  - an otherwise-transient error gets one quick jittered retry on the primary.
 */
export async function chatCompleteEx(messages: Msg[], opts: CompleteOpts = {}): Promise<CompleteResult> {
  opts = { ...opts, signal: cancellationSignal(opts.signal) }
  throwIfCancelled(opts.signal)
  const { timeoutMs = 45000, model, retryPrimary = true } = opts
  const chain = opts.providers || providerChain(model)
  if (!chain.length) throw new Error('Nalu engine is not configured.')
  const baseMax = opts.maxTokens ?? 4000

  let lastErr: unknown = null
  let attempts = 0
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]
    let curMax = baseMax
    let shrinks = 0
    let transientTries = 0
    let rateTries = 0
    const maxTransient = i === 0 && retryPrimary ? 1 : 0
    // Burst 429s clear in well under a second — retry the SAME provider with
    // jittered backoff before failing over (the fallback may be depleted, so
    // failing over on a transient burst turned load spikes into user errors).
    const maxRate = i === 0 ? 3 : 1
    for (;;) {
      try {
        throwIfCancelled(opts.signal)
        attempts++
        const result = await callOne(p, messages, opts, timeoutMs, curMax)
        throwIfCancelled(opts.signal)
        return result
      } catch (e) {
        throwIfCancelled(opts.signal)
        lastErr = e
        if (attempts >= (opts.maxAttempts ?? Infinity)) throw safeCompletionError(e)
        if (e instanceof TimeoutError) break // unhealthy — next provider
        // Too big for THIS provider → shrink max_tokens and retry the same one.
        if (isSizeError(e) && shrinks < 2 && curMax > 3000) {
          curMax = Math.max(3000, Math.floor(curMax / 2))
          shrinks++
          continue
        }
        // Transient rate limit → backoff and retry this provider.
        if (isRateLimited(e) && rateTries < maxRate) {
          rateTries++
          await retryDelay(350 * rateTries + Math.floor(Math.random() * 400), opts.signal)
          continue
        }
        // Genuinely out of credits (or still limited after retries) → fail over.
        if (isQuotaError(e)) break
        // Transient blip → one quick jittered retry (primary only), else next.
        if (transientTries < maxTransient) {
          transientTries++
          await retryDelay(120 + Math.floor(Math.random() * 380), opts.signal)
          continue
        }
        break
      }
    }
  }
  throwIfCancelled(opts.signal)
  throw safeCompletionError(lastErr)
}

/** Convenience wrapper that returns just the content string. */
export async function chatComplete(messages: Msg[], opts: CompleteOpts = {}): Promise<string> {
  return (await chatCompleteEx(messages, opts)).content
}

/**
 * Like chatCompleteEx, but if the model hit the token ceiling (finish_reason
 * 'length') it issues ONE continuation pass and concatenates — so long, complete
 * outputs (full reports, decks, models) don't get silently chopped.
 */
export async function chatCompleteContinued(messages: Msg[], opts: CompleteOpts = {}): Promise<CompleteResult> {
  opts = { ...opts, signal: cancellationSignal(opts.signal) }
  const first = await chatCompleteEx(messages, opts)
  throwIfCancelled(opts.signal)
  if (first.finishReason !== 'length') return first
  try {
    const cont = await chatCompleteEx(
      [
        ...messages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: 'Continue exactly where you left off. Do not repeat any text already written; output only the remaining content.' },
      ],
      opts,
    )
    return { content: first.content + cont.content, finishReason: cont.finishReason }
  } catch {
    throwIfCancelled(opts.signal)
    return first // continuation failed — return what we have rather than erroring
  }
}
