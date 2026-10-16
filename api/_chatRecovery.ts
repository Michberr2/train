import type { Provider } from './_llm'

export type RecoveryDiagnostic = { provider: string; attempt: number; elapsedMs: number; category: string; status?: number }

/** Bound headers AND body reads, including transports that ignore abort. */
export async function requestCompletion(url: string, key: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; data: any }> {
  const ac = new AbortController()
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let stopped = false
  let reject!: (error: Error) => void
  const interrupted = new Promise<never>((_, fail) => { reject = fail })
  const stop = (name: string) => {
    if (stopped) return
    stopped = true
    reject(new DOMException(name === 'AbortError' ? 'Cancelled' : 'Response timed out', name))
    ac.abort()
    void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {})
  }
  const abort = () => stop('AbortError')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('TimeoutError'), Math.max(1, timeoutMs))
  if (signal?.aborted) abort()
  try {
    return await Promise.race([interrupted, (async () => {
      if (stopped) throw new DOMException('Cancelled', 'AbortError')
      response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ac.signal })
      if (stopped) { void response.body?.cancel().catch(() => {}); throw new DOMException('Cancelled', 'AbortError') }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return { status: response.status, data: null } }
      let data: unknown
      if (response.body?.getReader) {
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let text = ''
        for (;;) {
          const chunk = await reader.read()
          if (stopped) throw new DOMException('Cancelled', 'AbortError')
          if (chunk.done) break
          text += decoder.decode(chunk.value, { stream: true })
          if (text.length > 4_000_000) throw new Error('Response exceeded size limit')
        }
        data = JSON.parse(text + decoder.decode())
      } else data = await response.json()
      return { status: response.status, data }
    })()])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    try { reader?.releaseLock() } catch { /* cancelled read */ }
  }
}

/** Each distinct provider gets time before any retry. Never log request content. */
export async function recoverCompletion(options: {
  providers: Provider[]; deadlineMs: number; signal: AbortSignal
  payload: (provider: Provider) => unknown
  accept: (data: any) => boolean
  onDiagnostic?: (event: RecoveryDiagnostic) => void
}): Promise<any | null> {
  const seen = new Set<string>()
  const providers = options.providers.filter(p => {
    const id = `${p.base}/${p.model}`
    if (!p.key || seen.has(id)) return false
    seen.add(id); return true
  })
  const retry: Provider[] = []
  for (let i = 0; i < providers.length + retry.length; i++) {
    if (options.signal.aborted) return null
    const remaining = options.deadlineMs - Date.now()
    if (remaining < 1000) break
    const provider = i < providers.length ? providers[i] : retry[i - providers.length]
    const untried = Math.max(1, providers.length - i)
    // An early provider cannot consume the last provider's completion window.
    const timeoutMs = Math.min(65000, Math.floor(remaining / untried))
    const started = Date.now()
    let category = 'unavailable', status: number | undefined
    try {
      const result = await requestCompletion(`${provider.base}/chat/completions`, provider.key, options.payload(provider), timeoutMs, options.signal)
      status = result.status
      if (status >= 200 && status < 300 && options.accept(result.data)) {
        options.onDiagnostic?.({ provider: provider.label, attempt: i + 1, elapsedMs: Date.now() - started, category: 'success', status })
        return result.data
      }
      category = status === 429 ? 'rate_limit' : status === 402 ? 'quota' : status >= 500 ? 'provider_unavailable' : status >= 400 ? 'request_rejected' : 'incomplete_response'
      if (i < providers.length && (status === 429 || status >= 500 || (category === 'incomplete_response' && !result.data?.choices?.[0]?.finish_reason))) retry.push(provider)
    } catch (error) {
      if (options.signal.aborted) return null
      category = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connection_error'
      // A timeout has already consumed its window. Retry only quick transport errors.
      if (i < providers.length && category !== 'timeout') retry.push(provider)
    }
    options.onDiagnostic?.({ provider: provider.label, attempt: i + 1, elapsedMs: Date.now() - started, category, ...(status ? { status } : {}) })
  }
  return null
}
