/** Decode provider SSE without assuming a network chunk is a complete event. */
export async function readProviderStream(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = '', lines: string[] = [], ended = false
  let rejectAbort!: (error: Error) => void
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => {
    rejectAbort(new DOMException('Stream interrupted', 'AbortError'))
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const dispatch = () => {
    const data = lines.join('\n')
    lines = []
    if (!data || ended) return
    if (data.trim() === '[DONE]') { ended = true; return }
    const message = JSON.parse(data)
    if (message?.error) throw new Error('Provider reported a stream error')
    onMessage(message)
  }
  const line = (value: string) => {
    if (value === '') { dispatch(); return }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    if (value.slice(0, colon) === 'data') lines.push(value.slice(colon + 1).replace(/^ /, ''))
  }
  const consume = (flush = false) => {
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== '\r' && buffer[i] !== '\n') continue
      if (!flush && buffer[i] === '\r' && i === buffer.length - 1) break
      line(buffer.slice(start, i))
      if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++
      start = i + 1
      if (ended) break
    }
    buffer = buffer.slice(start)
    if (flush && buffer && !ended) { line(buffer); buffer = '' }
  }
  try {
    while (!ended) {
      const chunk = await Promise.race([reader.read(), interrupted])
      if (signal?.aborted) throw new DOMException('Stream interrupted', 'AbortError')
      if (chunk.done) { buffer += decoder.decode(); consume(true); dispatch(); break }
      buffer += decoder.decode(chunk.value, { stream: true })
      consume()
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
