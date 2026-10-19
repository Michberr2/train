/** Stop awaiting work even when an upstream ignores AbortSignal. The upstream
 * still receives the signal, and late response bodies are released. */
export async function abortableWork<T>(work: () => Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  let stopped = false
  let reject!: (error: Error) => void
  const interrupted = new Promise<never>((_, fail) => { reject = fail })
  const abort = () => { stopped = true; reject(new DOMException('The request was cancelled.', 'AbortError')) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    return await Promise.race([interrupted, (async () => {
      if (stopped) throw new DOMException('The request was cancelled.', 'AbortError')
      const value = await work()
      if (stopped) { discard?.(value); throw new DOMException('The request was cancelled.', 'AbortError') }
      return value
    })()])
  } finally { signal.removeEventListener('abort', abort) }
}

export function fetchChatStream(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  return abortableWork(() => fetch(url, init), init.signal, response => { void response.body?.cancel().catch(() => {}) })
}
