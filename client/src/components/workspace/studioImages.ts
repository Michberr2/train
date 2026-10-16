import { getToken } from '../../lib/localAuth'

export type StudioImageRequest = { prompt: string; size: string; variation?: string }
export type StudioImage = { id: string; requestKey: string; url: string; width: number; height: number; mimeType: string }
export type StudioImageResult = { status: 'ready'; image: StudioImage } | { status: 'missing' | 'pending' }
const cached = new Map<string, StudioImage>()
const inFlight = new Map<string, Promise<StudioImageResult>>()
const MAX_CACHE_BYTES = 24 * 1024 * 1024
let cacheBytes = 0
let session: string | null = null

function token(): string | null {
  try { return getToken() } catch { return null }
}

/** Keeping only the current session also prevents one account from inheriting
 * another account's prepared photos on a same-page sign-in. */
export function studioImageSession(): string | null {
  const current = token()
  if (current !== session) { cached.clear(); inFlight.clear(); cacheBytes = 0; session = current }
  return current
}

function cache(key: string, image: StudioImage) {
  const old = cached.get(key)
  if (old) cacheBytes -= old.url.length
  cached.delete(key)
  cached.set(key, image)
  cacheBytes += image.url.length
  while (cacheBytes > MAX_CACHE_BYTES && cached.size > 1) {
    const oldest = cached.keys().next().value!
    cacheBytes -= cached.get(oldest)!.url.length
    cached.delete(oldest)
  }
}

/** Lookup never generates an image. Generation is an explicit user action and
 * uses the server's durable request key, so multiple views cannot bill twice. */
export async function requestStudioImage(request: StudioImageRequest, action: 'lookup' | 'generate' = 'lookup', signal?: AbortSignal): Promise<StudioImageResult> {
  const owner = studioImageSession()
  if (!owner) {
    if (action === 'lookup') return { status: 'missing' }
    throw new Error('Sign in to generate and save presentation images.')
  }
  if (signal?.aborted) throw new DOMException('Image request cancelled.', 'AbortError')
  const key = JSON.stringify([owner, request.prompt.trim(), request.size, request.variation || ''])
  const existing = cached.get(key)
  if (existing) { cached.delete(key); cached.set(key, existing); return { status: 'ready', image: existing } }
  const flightKey = `${action}:${key}`
  // Cancellable callers own their request; the server still deduplicates work.
  // Sharing an AbortSignal would let one closing view cancel another's request.
  if (!signal && inFlight.has(flightKey)) return inFlight.get(flightKey)!
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, action === 'generate' ? 150000 : 20000)
  const job = (async (): Promise<StudioImageResult> => {
    try {
      const response = await fetch('/api/studio-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
        body: JSON.stringify({ action, ...request }), signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      if (token() !== owner) throw new Error('Your account changed while the image was loading. Open the deck again.')
      if (controller.signal.aborted) throw new DOMException('Image request cancelled or timed out.', 'AbortError')
      if (response.status === 404 && action === 'lookup') return { status: 'missing' }
      if (response.status === 202) return { status: 'pending' }
      if (!response.ok) throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : 'The presentation image could not be loaded. Please try again.'), { status: response.status })
      if (!body || typeof body.id !== 'string' || typeof body.requestKey !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(body.url || '') || body.url.length > 3_000_000 || !(body.width > 0 && body.height > 0)) throw new Error('The image service returned an incomplete image. Please try again.')
      const image: StudioImage = { id: body.id, requestKey: body.requestKey, url: body.url, width: body.width, height: body.height, mimeType: body.mimeType }
      cache(key, image)
      return { status: 'ready', image }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  })()
  if (!signal) {
    inFlight.set(flightKey, job)
    void job.finally(() => { if (inFlight.get(flightKey) === job) inFlight.delete(flightKey) }).catch(() => {})
  }
  return job
}
