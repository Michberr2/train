import type { Readable } from 'node:stream'
import { MAX_WEBSITE_DOWNLOAD_BYTES } from './_websiteDownloadContent'

type WebsiteDownload = { createReadStream(): Promise<Readable | null>; cancel(): Promise<void> }

/** Read one browser download without trusting its length or completion time. */
export function readWebsiteDownload(download: WebsiteDownload, options: { deadlineMs: number; signal?: AbortSignal }): Promise<Uint8Array> {
  const deadlineMs = Math.min(options.deadlineMs, Date.now() + 2500)
  return new Promise((resolve, reject) => {
    let stream: Readable | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let cancelled = false
    let total = 0
    let chunks: Buffer[] = []
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      // Cancellation itself can hang or fail after the browser has closed.
      // Observe it without extending the read deadline or leaking a rejection.
      void Promise.resolve().then(() => download.cancel()).catch(() => {})
    }
    const destroy = (value: Readable) => {
      // A stream's asynchronous _destroy callback may emit an error after the
      // operation has settled. Observe that error until its final close event.
      const ignore = () => {}
      const closed = () => { value.removeListener('error', ignore) }
      value.on('error', ignore)
      value.once('close', closed)
      try { value.destroy() } catch { value.removeListener('error', ignore); value.removeListener('close', closed) }
    }
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', aborted)
      if (stream) {
        stream.removeListener('data', data)
        stream.removeListener('end', ended)
        stream.removeListener('error', sourceFailed)
        stream.removeListener('close', closed)
      }
    }
    const failed = (error: unknown, alreadyClosed = false) => {
      if (settled) return
      settled = true
      cleanup()
      chunks = []
      cancel()
      if (stream && !alreadyClosed) destroy(stream)
      reject(error instanceof Error ? error : new Error('The website download stream failed.'))
    }
    const expired = () => failed(new Error('The website download did not finish before its deadline.'))
    // Browser transport errors can contain provider URLs, credentials, or
    // request details. Only our fixed diagnostic enters artifact repair logs.
    const sourceFailed = () => failed(new Error('The website download stream failed.'))
    const aborted = () => {
      const error = new Error('Website download reading was cancelled.')
      error.name = 'AbortError'
      failed(error)
    }
    const active = () => {
      if (settled) return false
      if (options.signal?.aborted) { aborted(); return false }
      if (Date.now() >= deadlineMs) { expired(); return false }
      return true
    }
    const data = (chunk: unknown) => {
      if (!active()) return
      try {
        let bytes: Uint8Array | string
        let length: number
        if (typeof chunk === 'string') { bytes = chunk; length = Buffer.byteLength(chunk, 'utf8') }
        else if (chunk instanceof ArrayBuffer) { bytes = new Uint8Array(chunk); length = chunk.byteLength }
        else if (ArrayBuffer.isView(chunk)) { bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength); length = chunk.byteLength }
        else throw new Error('The website download returned an unsupported byte chunk.')
        if (length > MAX_WEBSITE_DOWNLOAD_BYTES - total) throw new Error('The website download exceeds the 1 MiB verification limit.')
        // Copy each accepted chunk: a producer may reuse or mutate its buffer.
        chunks.push(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes))
        total += length
      } catch (error) { failed(error) }
    }
    const ended = () => {
      if (!active()) return
      settled = true
      cleanup()
      const bytes = Buffer.concat(chunks, total)
      chunks = []
      // Also observe an asynchronous teardown error after an otherwise valid
      // end; success has already captured every byte and needs no open stream.
      if (stream) destroy(stream)
      resolve(bytes)
    }
    const closed = () => failed(new Error('The website download closed before all bytes arrived.'), true)

    if (!Number.isFinite(deadlineMs) || !active()) { if (!settled) expired(); return }
    options.signal?.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(expired, Math.max(1, deadlineMs - Date.now()))
    void Promise.resolve().then(() => settled ? null : download.createReadStream()).then(value => {
      if (settled) { if (value) destroy(value); return }
      if (!value) { failed(new Error('The website download did not provide a readable stream.')); return }
      stream = value
      if (!active()) return
      stream.on('error', sourceFailed)
      stream.once('end', ended)
      stream.once('close', closed)
      if (stream.readableEnded) { ended(); return }
      if (stream.destroyed) { failed(new Error('The website download stream was already destroyed.')); return }
      stream.on('data', data)
    }).catch(sourceFailed)
  })
}
