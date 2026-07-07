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
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3.1'

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

/** Ordered provider chain for a request. */
export function providerChain(model?: string): Provider[] {
  const chain: Provider[] = []
  const p = primaryProvider(model)
  if (p) chain.push(p)
  const f = fallbackProvider()
  if (f) chain.push(f)
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

/** One non-streaming completion against one provider, with a hard timeout. */
async function callOne(p: Provider, messages: Msg[], opts: CompleteOpts, timeoutMs: number): Promise<CompleteResult> {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { ac.abort() } catch { /* noop */ }
  }, timeoutMs)
  try {
    const r = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        messages,
        stream: false,
        max_tokens: opts.maxTokens ?? 4000,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.frequencyPenalty != null ? { frequency_penalty: opts.frequencyPenalty } : {}),
        ...(opts.presencePenalty != null ? { presence_penalty: opts.presencePenalty } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ac.signal,
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error(`${p.label} ${r.status}: ${t.slice(0, 200)}`)
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

/**
 * Non-streaming completion with timeout + multi-provider failover, returning the
 * content AND finish_reason. Throws only if EVERY attempt fails.
 *
 * Failover is smart: a provider that TIMES OUT is abandoned immediately (no point
 * waiting on it twice), while a provider that errors FAST gets one quick retry
 * (covers transient blips) before we move on.
 */
export async function chatCompleteEx(messages: Msg[], opts: CompleteOpts = {}): Promise<CompleteResult> {
  const { timeoutMs = 45000, model, retryPrimary = true } = opts
  const chain = opts.providers || providerChain(model)
  if (!chain.length) throw new Error('Nalu engine is not configured.')

  let lastErr: unknown = null
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]
    const maxTries = i === 0 && retryPrimary ? 2 : 1
    for (let t = 0; t < maxTries; t++) {
      try {
        return await callOne(p, messages, opts, timeoutMs)
      } catch (e) {
        lastErr = e
        // A timeout means this provider is unhealthy now — fail over immediately
        // rather than burning another full timeout window on a retry.
        if (e instanceof TimeoutError) break
        // Before a fast retry, wait a short JITTERED delay so a burst of concurrent
        // requests (high load) doesn't synchronize and re-hammer the provider.
        if (t + 1 < maxTries) await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 380)))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All providers failed')
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
