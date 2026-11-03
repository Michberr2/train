const CHUNK = 32 * 1024 * 1024
const PARALLEL = 4
const weights = (url: string) => /\/onnx\/[^/?]+\.onnx(?:_data(?:_\d+)?)?(?:\?|$)/.test(url)

/** Download immutable model files in bounded, resumable parts. This transfers
 * only public model bytes; it never sends a conversation or inference request. */
export async function downloadBrowserModel(url: string, init: RequestInit, request: typeof fetch = fetch, options: { chunkBytes?: number; parallel?: number } = {}): Promise<Response> {
  const chunk = options.chunkBytes ?? CHUNK, parallel = options.parallel ?? PARALLEL
  if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > 64 * 1024 * 1024 || !Number.isSafeInteger(parallel) || parallel < 1 || parallel > 4) throw new Error('Invalid model download configuration.')
  if (!weights(url) || init.method && init.method !== 'GET') return request(url, init)
  const controller = new AbortController(), signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  const headers = new Headers(init.headers); headers.set('Range', `bytes=0-${chunk - 1}`)
  const first = await request(url, { ...init, headers, signal, cache: 'no-store' })
  if (first.status === 200) return first
  const match = /^bytes 0-(\d+)\/(\d+)$/.exec(first.headers.get('content-range') || '')
  const size = Number(match?.[2])
  if (first.status !== 206 || !match || !Number.isSafeInteger(size) || size <= 0 || Number(match[1]) !== Math.min(size, chunk) - 1) {
    void first.body?.cancel().catch(() => {})
    return request(url, init)
  }
  let cache: Cache | undefined
  try { if (typeof caches !== 'undefined') cache = await caches.open('nalu-model-parts-v1') } catch { /* Private browsing may disable persistent caches. */ }
  const count = Math.ceil(size / chunk), pending = new Map<number, Promise<Uint8Array>>()
  let next = 0, cancelled = false
  const key = (index: number) => { const value = new URL(url); value.searchParams.set('nalu_model_part', `${chunk}:${size}:${index}`); return value.href }
  const read = async (index: number) => {
    const start = index * chunk, end = Math.min(size, start + chunk) - 1, length = end - start + 1
    try {
      const stored = await cache?.match(key(index))
      if (stored) { const bytes = new Uint8Array(await stored.arrayBuffer()); if (bytes.byteLength === length) { if (!index) void first.body?.cancel().catch(() => {}); return bytes }; await cache?.delete(key(index)) }
    } catch { /* Use the real immutable resource if its cached part is unavailable. */ }
    let response = index === 0 ? first : undefined
    for (let attempt = 0; ; attempt++) {
      try {
        signal.throwIfAborted()
        if (!response) { const range = new Headers(init.headers); range.set('Range', `bytes=${start}-${end}`); response = await request(url, { ...init, headers: range, signal, cache: 'no-store' }) }
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) { void response.body?.cancel().catch(() => {}); throw new Error('The model download returned an inconsistent byte range.') }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength !== length) throw new Error('The model download was interrupted.')
        try { await cache?.put(key(index), new Response(bytes.slice())) } catch { /* Download remains usable without persistent storage. */ }
        return bytes
      } catch (error) {
        signal.throwIfAborted()
        if (attempt >= 2) throw error
        response = undefined
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
  }
  const fill = () => {
    for (let index = next; index < Math.min(count, next + parallel); index++) if (!pending.has(index)) {
      const part = read(index); part.catch(() => {}); pending.set(index, part)
    }
  }
  fill()
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      if (cancelled) return
      try {
        const bytes = await pending.get(next)!
        if (cancelled) return
        pending.delete(next++); stream.enqueue(bytes)
        if (next === count) {
          stream.close()
          // Transformers stores the complete immutable file in its normal
          // cache. Partial checkpoints are only needed for interrupted loads.
          for (let index = 0; index < count; index++) void cache?.delete(key(index)).catch(() => {})
        } else fill()
      } catch (error) { cancelled = true; controller.abort(); stream.error(error) }
    },
    cancel() { cancelled = true; controller.abort(); void first.body?.cancel().catch(() => {}) },
  })
  return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } })
}
