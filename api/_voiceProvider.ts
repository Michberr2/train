// Provider I/O bounds shared by synthesis and transcription. These helpers do
// not authenticate or charge accounts; route-level policy owns that separately.
export const MAX_VOICE_AUDIO_BYTES = 8 * 1024 * 1024
export const MAX_TRANSCRIPTION_INPUT_BYTES = 3 * 1024 * 1024

export async function withVoiceDeadline<T>(parent: AbortSignal, timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  let rejectAbort!: (error: Error) => void
  const interrupted = new Promise<never>((_, reject) => {rejectAbort = reject})
  const abort = () => {controller.abort(); rejectAbort(new DOMException('Voice request interrupted.', 'AbortError'))}
  parent.addEventListener('abort', abort, {once: true})
  const timer = setTimeout(abort, Math.max(1, timeoutMs))
  try {
    if (parent.aborted) abort()
    return await Promise.race([task(controller.signal), interrupted])
  } finally {clearTimeout(timer); parent.removeEventListener('abort', abort); controller.abort()}
}

export async function fetchVoice(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted()
  const response = await fetch(url, {...init, signal})
  if (signal.aborted || !response.ok) {
    void response.body?.cancel().catch(() => {})
    signal.throwIfAborted()
    throw new Error('Voice provider unavailable.')
  }
  return response
}

export function boundedVoiceStream(response: Response, maximum: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const advertised = Number(response.headers.get('content-length') || 0)
  if (!response.body || advertised > maximum) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Voice provider response exceeded its limit or was empty.')
  }
  const reader = response.body.getReader()
  let bytes = 0, finished = false
  const abort = () => {void reader.cancel().catch(() => {})}
  signal.addEventListener('abort', abort, {once: true})
  const cleanup = () => {if (!finished) {finished = true; signal.removeEventListener('abort', abort); reader.releaseLock()}}
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) {cleanup(); controller.close(); return}
        bytes += chunk.value.byteLength
        if (bytes > maximum) throw new Error('Voice provider response exceeded its limit.')
        controller.enqueue(chunk.value)
      } catch (error) {void reader.cancel().catch(() => {}); cleanup(); controller.error(error)}
    },
    async cancel() {try {await reader.cancel()} finally {cleanup()}},
  })
}

export async function readVoiceBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const reader = boundedVoiceStream(response, maximum, signal).getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally {void reader.cancel().catch(() => {}); reader.releaseLock()}
}

export function validateMp3(bytes: Buffer): void {
  if (bytes.length < 1000 || bytes.length > MAX_VOICE_AUDIO_BYTES) throw new Error('Voice audio was empty or too large.')
  const id3 = bytes.subarray(0, 3).toString('ascii') === 'ID3'
  const mpeg = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
  if (!id3 && !mpeg) throw new Error('Voice provider returned an invalid audio format.')
}

export async function readVoiceJson(response: Response, signal: AbortSignal): Promise<any> {
  return JSON.parse((await readVoiceBytes(response, 256 * 1024, signal)).toString('utf8'))
}
