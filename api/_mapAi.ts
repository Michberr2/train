import { chatComplete, type Provider } from './_llm'

const MAP_AI_BUDGET_MS = 18_000
const RESEARCH_BUDGET_MS = 5_000
const IDENTITY_BUDGET_MS = 2_000

/** Settle independently of work/transport cooperation, and ignore late work. */
async function withinMapBudget<T>(milliseconds: number, parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const deadline = Date.now() + milliseconds
  let stopped: Error | undefined
  let rejectStopped!: (error: Error) => void
  const interrupted = new Promise<never>((_resolve, reject) => { rejectStopped = reject })
  const stop = (error: Error) => {
    if (stopped) return
    stopped = error
    rejectStopped(error)
    controller.abort()
  }
  const onAbort = () => stop(new DOMException('Map AI request cancelled.', 'AbortError'))
  const timeout = () => new DOMException('Map AI search budget expired.', 'TimeoutError')
  parent?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => stop(timeout()), milliseconds)
  const check = () => {
    if (parent?.aborted) onAbort()
    if (!stopped && Date.now() >= deadline) stop(timeout())
    if (stopped) throw stopped
  }
  const run = async () => { check(); const value = await work(controller.signal); check(); return value }
  try { return await Promise.race([run(), interrupted]) }
  finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

/** Leave room for the client's existing Places fallback inside its45s budget. */
export async function completeMapAi(options: {
  provider: Provider
  system: string
  user: string
  research?: (signal: AbortSignal) => Promise<string>
  identity?: (signal: AbortSignal) => Promise<string>
}): Promise<string | null> {
  const deadline = Date.now() + MAP_AI_BUDGET_MS
  try {
    return await withinMapBudget(MAP_AI_BUDGET_MS, undefined, async signal => {
      // Research and identity are independent, best-effort preparation. The
      // legacy research helper may ignore cancellation; its late answer never
      // blocks the model or gets appended after the5s slice has expired.
      const [research, identity] = await Promise.all([
        options.research ? withinMapBudget(RESEARCH_BUDGET_MS, signal, options.research).catch(() => '') : '',
        options.identity ? withinMapBudget(IDENTITY_BUDGET_MS, signal, options.identity).catch(() => '') : '',
      ])
      if (signal.aborted || Date.now() >= deadline) return null
      return chatComplete([
        { role: 'system', content: options.system + identity },
        { role: 'user', content: options.user + research + '\n\nJSON:' },
      ], {
        providers: [options.provider], model: options.provider.model, maxTokens: 3200,
        timeoutMs: Math.max(1, deadline - Date.now()), signal,
        maxAttempts: 1, retryPrimary: false,
      })
    })
  } catch { return null }
}
