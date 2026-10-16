export const videoAborted = () => new DOMException('Video generation stopped.', 'AbortError')
export function checkVideoAbort(signal?: AbortSignal): void { if (signal?.aborted) throw videoAborted() }

/** Cancel active work as well as the wait. Caller cancellation is terminal;
 * a rung's own timeout can still use the existing fallback ladder. */
export async function videoAttempt<T>(run: (signal: AbortSignal) => Promise<T>, caller: AbortSignal | undefined, ms: number, label: string): Promise<T> {
  checkVideoAbort(caller)
  const controller = new AbortController()
  const abort = () => controller.abort(videoAborted())
  caller?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException(`${label} timed out`, 'TimeoutError')), ms)
  let rejectAbort: () => void = () => {}
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectAbort, { once: true })
      }),
      Promise.resolve().then(() => { checkVideoAbort(controller.signal); return run(controller.signal) }),
    ])
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', rejectAbort)
  }
}

// A 12s recording at the configured 6Mbps is about 9MB before audio. Bound
// conversion to 24MiB (at most 32MiB base64), avoiding unbounded string copies.
// Full chat IndexedDB retains these bytes locally; server sync may omit media
// when its existing 3.6MB request budget is exceeded.
export const MAX_SAVED_VIDEO_BYTES = 24 * 1024 * 1024
export function durableVideoUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  checkVideoAbort(signal)
  if (!blob.size) return Promise.reject(new Error('The recording is empty.'))
  if (blob.size > MAX_SAVED_VIDEO_BYTES) return Promise.reject(new Error('This recording is too large to save in chat. Try a shorter clip.'))
  // Recorder codec lists can contain commas, which terminate a data URL's
  // metadata. Keep the container MIME; encoded bytes already carry the codecs.
  const mime = blob.type.split(';')[0].trim().toLowerCase()
  if (!/^video\/[a-z0-9.+-]+$/.test(mime)) return Promise.reject(new Error('The recording has an unsupported video format.'))
  const readable = blob.type === mime ? blob : blob.slice(0, blob.size, mime)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reader.onload = reader.onerror = reader.onabort = null
      if (error) { if (reader.readyState === FileReader.LOADING) reader.abort(); reject(error) }
      else if (typeof reader.result === 'string' && reader.result.startsWith('data:video/')) resolve(reader.result)
      else reject(new Error('The recording could not be saved as video.'))
    }
    const abort = () => finish(videoAborted())
    const timer = setTimeout(() => finish(new Error('Saving the recording timed out. Try a shorter clip.')), 15000)
    signal?.addEventListener('abort', abort, { once: true })
    reader.onload = () => finish()
    reader.onerror = () => finish(new Error('The recording could not be saved.'))
    reader.onabort = abort
    try { reader.readAsDataURL(readable) } catch (error) { finish(error instanceof Error ? error : new Error('The recording could not be read.')) }
  })
}
