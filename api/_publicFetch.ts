import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isPublicConnectionAddress } from './_connectionHttp'

export class PublicUrlError extends Error {}

/** Syntactic validation is also used when presenting source links. DNS is
 * checked separately, then pinned to the socket immediately before a request. */
export function publicHttpUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new PublicUrlError('A public HTTP or HTTPS URL is required.') }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !host.includes('.') && !isIP(host) ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa|test|invalid|onion)$/.test(host) ||
      isIP(host) && !isPublicConnectionAddress(host)) {
    throw new PublicUrlError('Only public HTTP or HTTPS destinations are supported.')
  }
  url.hash = ''
  return url
}

type PublicFetchOptions = Omit<RequestInit, 'body'> & {
  body?: string | Uint8Array
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

/** Bounded public-internet transport for user/model supplied URLs. Never uses
 * unchecked fetch redirects, proxy environment variables, or a second DNS lookup.
 * Mutations are sent once and never replayed on a redirect. */
export async function publicFetch(value: string, options: PublicFetchOptions = {}): Promise<Response> {
  const controller = new AbortController()
  const parent = options.signal
  const timeout = setTimeout(() => controller.abort(new Error('The public request timed out.')), Math.max(1, options.timeoutMs ?? 10000))
  const onAbort = () => controller.abort(parent?.reason || new DOMException('Request cancelled', 'AbortError'))
  if (parent?.aborted) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const signal = controller.signal
  const method = (options.method || 'GET').toUpperCase()
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 1500000, 5000000))
  let abortListener: (() => void) | undefined
  try {
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new PublicUrlError('Unsupported HTTP method.')
    const headers = new Headers(options.headers)
    // Socket destination and the HTTP host must agree. Hop-by-hop and proxy
    // credentials must never be controlled by generated node headers.
    for (const key of ['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade']) headers.delete(key)
    headers.set('accept-encoding', 'gzip, deflate, br')
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason || new DOMException('Request cancelled', 'AbortError'))
      if (signal.aborted) abortListener()
      else signal.addEventListener('abort', abortListener, { once: true })
    })
    return await Promise.race([aborted, (async () => {
      let url = publicHttpUrl(value)
      for (let hop = 0; ; hop++) {
        signal.throwIfAborted()
        const host = url.hostname.replace(/^\[|\]$/g, '')
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true })
        signal.throwIfAborted()
        if (!addresses.length || addresses.some(item => !isPublicConnectionAddress(item.address))) {
          throw new PublicUrlError('The destination must resolve only to public internet addresses.')
        }
        const selected = addresses.find(item => item.family === 4) || addresses[0]
        const response = await new Promise<Response>((resolve, reject) => {
          const request = url.protocol === 'https:' ? httpsRequest : httpRequest
          const req = request(url, {
            method, headers: Object.fromEntries(headers), signal,
            lookup: (_hostname, lookupOptions: any, done: any) => lookupOptions.all ? done(null, [selected]) : done(null, selected.address, selected.family),
          }, incoming => {
            try {
            const status = incoming.statusCode || 502
            if (!Number.isInteger(status) || status < 200 || status > 599) {
              incoming.destroy(); reject(new Error('The source returned an unsupported HTTP status.')); return
            }
            const responseHeaders = new Headers()
            for (const [key, values] of Object.entries(incoming.headers)) {
              if (Array.isArray(values)) for (const value of values) responseHeaders.append(key, value)
              else if (values !== undefined) responseHeaders.set(key, values)
            }
            const finish = (body: Uint8Array | null) => {
              try {
                const result = new Response(body === null ? null : new Uint8Array(body), { status, statusText: incoming.statusMessage || '', headers: responseHeaders })
                Object.defineProperty(result, 'url', { value: url.href })
                resolve(result)
              } catch (error) { incoming.destroy(); reject(error) }
            }
            if ([301, 302, 303, 307, 308].includes(status) || method === 'HEAD' || [204, 205, 304].includes(status)) {
              finish(null); incoming.destroy(); return
            }
            const encoding = responseHeaders.get('content-encoding')?.toLowerCase()
            const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined
            if (encoding && encoding !== 'identity' && !decoder) {
              incoming.destroy(); reject(new Error('Unsupported source compression.')); return
            }
            const stream = decoder || incoming
            const chunks: Buffer[] = []
            let size = 0, wireSize = 0
            const fail = (error: Error) => { reject(error); incoming.destroy(); decoder?.destroy() }
            incoming.on('error', fail)
            incoming.on('aborted', () => fail(new Error('The source closed before its response was complete.')))
            if (decoder) {
              responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length')
              incoming.on('data', chunk => { wireSize += chunk.length; if (wireSize > maxBytes) fail(new Error('Source exceeds reading limit.')) })
              incoming.pipe(decoder)
              decoder.on('error', fail)
            }
            stream.on('data', chunk => {
              size += chunk.length
              if (size > maxBytes) { fail(new Error('Source exceeds reading limit.')); return }
              chunks.push(Buffer.from(chunk))
            })
            stream.on('end', () => { if (!signal.aborted && size <= maxBytes) finish(Buffer.concat(chunks)) })
            } catch (error) { incoming.destroy(); reject(error) }
          })
          req.on('error', reject)
          req.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('Protocol upgrades are not supported.')) })
          req.end(options.body)
        })
        if (![301, 302, 303, 307, 308].includes(response.status)) return response
        if (options.redirect === 'manual') return response
        if (options.redirect === 'error' || !['GET', 'HEAD'].includes(method)) throw new PublicUrlError('Redirects are not allowed for this request. Check the destination URL before retrying.')
        if (hop >= (options.maxRedirects ?? 5)) throw new PublicUrlError('The source redirected too many times.')
        const location = response.headers.get('location')
        if (!location) throw new PublicUrlError('The source redirected without a destination.')
        const next = publicHttpUrl(new URL(location, url).href)
        if (next.origin !== url.origin) {
          for (const key of [...headers.keys()]) if (!['accept', 'accept-language', 'accept-encoding', 'user-agent'].includes(key)) headers.delete(key)
        }
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new PublicUrlError('An HTTPS source cannot redirect to an insecure connection.')
        url = next
      }
    })()])
  } finally {
    clearTimeout(timeout)
    parent?.removeEventListener('abort', onAbort)
    if (abortListener) signal.removeEventListener('abort', abortListener)
    controller.abort()
  }
}
