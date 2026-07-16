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

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
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
const DEFAULT_MODEL = process.env.NALU_DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V3.1'

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
    // primary's possibly-Tinker-only override), so the failover actually serves.
    model: env('NALU_FALLBACK_MODEL') || DEFAULT_MODEL,
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
  model?: string // primary model override (per endpoint)
  retryPrimary?: boolean // give the primary one retry before failing over
  providers?: Provider[] // explicit chain (otherwise built from env)
  json?: boolean // ask the provider for native JSON output (response_format)
  frequencyPenalty?: number
  presencePenalty?: number
}

export interface CompleteResult {
  content: string
  finishReason: string // 'stop' | 'length' | '' — lets callers detect truncation
}

type Msg = { role: string; content: unknown }

class TimeoutError extends Error {}
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
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { ac.abort() } catch { /* noop */ }
  }, timeoutMs)
  try {
    // Gemini's OpenAI-compat endpoint 400s on the penalty fields — strip them there.
    const isGemini = /generativelanguage\.googleapis/i.test(p.base)
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
        // flash models burn the budget on internal thinking and return EMPTY
        // content unless told to keep reasoning light
        ...(isGemini ? { reasoning_effort: 'low' } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ac.signal,
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new ProviderError(p.label, r.status, t)
    }
    const d = (await r.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> }
      | null
    const content = d?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${p.label}: empty response`)
    return { content, finishReason: d?.choices?.[0]?.finish_reason || '' }
  } catch (e) {
    if (timedOut) throw new TimeoutError(`${p.label}: timed out after ${timeoutMs}ms`)
    throw e
  } finally {
    clearTimeout(timer)
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
  const { timeoutMs = 45000, model, retryPrimary = true } = opts
  const chain = opts.providers || providerChain(model)
  if (!chain.length) throw new Error('Nalu engine is not configured.')
  const baseMax = opts.maxTokens ?? 4000

  let lastErr: unknown = null
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
        return await callOne(p, messages, opts, timeoutMs, curMax)
      } catch (e) {
        lastErr = e
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
          await new Promise((r) => setTimeout(r, 350 * rateTries + Math.floor(Math.random() * 400)))
          continue
        }
        // Genuinely out of credits (or still limited after retries) → fail over.
        if (isQuotaError(e)) break
        // Transient blip → one quick jittered retry (primary only), else next.
        if (transientTries < maxTransient) {
          transientTries++
          await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 380)))
          continue
        }
        break
      }
    }
  }
  throw new Error(safeErrorMessage(lastErr))
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
  const first = await chatCompleteEx(messages, opts)
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
    return first // continuation failed — return what we have rather than erroring
  }
}
