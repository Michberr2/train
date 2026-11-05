/** Retry one failed connection before any response bytes or tool calls are read. */
export async function requestChat(body: string, signal?: AbortSignal): Promise<Response> {
  const owner = localStorage.getItem('nalu-token')
  const { requestLocalAnswer } = await import('../../lib/localAnswerReview')
  if (signal?.aborted || owner !== localStorage.getItem('nalu-token')) throw new DOMException('Cancelled', 'AbortError')
  return requestLocalAnswer(JSON.parse(body), signal)
}

/** Explicit legacy cloud transport, retained only for compatibility tests. */
export async function requestCloudChat(body: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal })
      if (attempt > 0 || ![502, 503, 504].includes(response.status)) return response
      void response.body?.cancel().catch(() => {})
    } catch (error) {
      if (attempt > 0 || signal?.aborted) throw error
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 450)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}
