import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import sharp from 'sharp'
import { chatComplete } from './_llm'

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_PROVIDER_BYTES = 16 * 1024 * 1024
export type GeneratedImage = { bytes: Buffer; width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }
const env = (key: string) => process.env[key]?.trim() || ''

export function imageSize(value: unknown): { width: number; height: number; size: string } {
  const match = value == null ? ['1024x1024', '1024', '1024'] : typeof value === 'string' ? /^(\d{2,4})x(\d{2,4})$/i.exec(value.trim()) : null
  if (!match) throw new Error('Use an image size such as 1600x900.')
  const width = Number(match[1]), height = Number(match[2])
  if (width < 128 || height < 128 || width > 2048 || height > 2048) throw new Error('Image dimensions must be between 128 and 2048 pixels.')
  return { width, height, size: `${width}x${height}` }
}

export function imageDataUrl(image: GeneratedImage): string { return `data:${image.mimeType};base64,${image.bytes.toString('base64')}` }

/** Decode real raster bytes, preserve transparency, strip metadata, and keep
 * both the stored object and its JSON data URL below the response size limit. */
export async function normalizeGeneratedImage(bytes: Buffer, width: number, height: number): Promise<GeneratedImage> {
  if (!bytes.length || bytes.length > MAX_PROVIDER_BYTES) throw new Error('The image service returned an invalid image size.')
  const input = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate()
  const metadata = await input.metadata()
  if (!['png', 'jpeg', 'webp', 'gif', 'avif', 'tiff'].includes(metadata.format || '')) throw new Error('The image service did not return a supported raster image.')
  for (const factor of [1, .8, .6, .4]) {
    let output = input.clone().resize(Math.max(128, Math.round(width * factor)), Math.max(128, Math.round(height * factor)), { fit: 'inside', withoutEnlargement: true })
    output = metadata.hasAlpha ? output.png({ compressionLevel: 9 }) : output.jpeg({ quality: 88, mozjpeg: true })
    const result = await output.toBuffer({ resolveWithObject: true })
    if (result.data.length <= MAX_IMAGE_BYTES) return { bytes: result.data, width: result.info.width, height: result.info.height, mimeType: metadata.hasAlpha ? 'image/png' : 'image/jpeg' }
  }
  throw new Error('The generated image is too large to save. Try a smaller image.')
}

function childSignal(parent: AbortSignal, timeout: number) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeout)
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', abort) } }
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`Image service returned HTTP ${response.status}.`)
  if (Number(response.headers.get('content-length')) > MAX_PROVIDER_BYTES || !response.body) throw new Error('The image service returned an invalid response size.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > MAX_PROVIDER_BYTES) throw new Error('The image service response is too large.')
      chunks.push(item.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}

async function providerJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal, timeout: number): Promise<any> {
  const request = childSignal(signal, timeout)
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: request.signal })
    return JSON.parse((await boundedBody(response)).toString('utf8'))
  } finally { request.dispose() }
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) || a === 198 && (b === 18 || b === 19) || a === 100 && b >= 64 && b <= 127 || a >= 224)
  }
  // Only globally routable IPv6; excludes loopback, mapped IPv4, link-local,
  // unique-local and multicast ranges without alternate-encoding bypasses.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(?:db8|0):|^2002:/i.test(address)
}

function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Image generation timed out.'))
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Only provider-returned URLs enter this path. Resolve and pin a public IP
 * during the TLS request; redirects are rejected, not followed into a LAN. */
async function bakeProviderUrl(value: string, signal: AbortSignal): Promise<Buffer> {
  const url = new URL(value)
  if (value.length > 4096 || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('Unsupported image download URL.')
  const addresses = await withinSignal(lookup(url.hostname, { all: true }), signal)
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw new Error('Unsupported image download host.')
  if (signal.aborted) throw new Error('Image generation timed out.')
  const target = addresses[0]
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      signal, headers: { Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8' },
      lookup: ((_hostname: string, options: any, callback: any) => options.all ? callback(null, [target]) : callback(null, target.address, target.family)) as any,
    }, response => {
      const status = response.statusCode || 0, mime = String(response.headers['content-type'] || '')
      if (status !== 200 || !mime.startsWith('image/') || Number(response.headers['content-length']) > MAX_PROVIDER_BYTES) { response.destroy(); reject(new Error('The image download was unavailable.')); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_PROVIDER_BYTES) response.destroy(new Error('The image download is too large.'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

function inlineBytes(value: string): Buffer {
  const match = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value)
  if (!match || match[1].length > MAX_PROVIDER_BYTES * 4 / 3 + 8) throw new Error('The image service returned invalid image data.')
  return Buffer.from(match[1], 'base64')
}

function aspectRatio(width: number, height: number): string {
  const choices: [string, number][] = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3]]
  return choices.reduce((a, b) => Math.abs(b[1] - width / height) < Math.abs(a[1] - width / height) ? b : a)[0]
}

/** One bounded provider ladder. No automatic retries of paid calls. Callers
 * decide whether generation is authorized; previews and lookups never call it. */
export async function generateImage(prompt: string, width: number, height: number, options: { timeoutMs?: number; signal?: AbortSignal; enrich?: boolean } = {}): Promise<GeneratedImage> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(abort, options.timeoutMs ?? 120000)
  const signal = controller.signal
  const finish = async (bytes: Buffer) => {
    if (signal.aborted) throw new Error('Image generation timed out. Please retry.')
    const image = await normalizeGeneratedImage(bytes, width, height)
    if (signal.aborted) throw new Error('Image generation timed out. Please retry.')
    return image
  }
  try {
    let finalPrompt = prompt
    if (options.enrich !== false && env('TINKER_API_KEY')) {
      try {
        const enriched = await chatComplete([
          { role: 'system', content: "Turn the user's request into one image prompt under 90 words. Preserve the requested medium, exact subject, brand constraints and exclusions. Do not invent factual details about real people, products or places. An illustration stays an illustration. Preserve existing detailed art direction. Output only the prompt." },
          { role: 'user', content: prompt },
        ], { model: env('NALU_IMAGE_PROMPT_MODEL') || 'deepseek-ai/DeepSeek-V3.1', maxTokens: 320, timeoutMs: 20000, temperature: .7, signal })
        finalPrompt = enriched.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^["'\s]+|["'\s]+$/g, '').trim() || prompt
      } catch { /* exact original art direction remains a valid prompt */ }
    }
    const geminiKey = env('GEMINI_API_KEY') || env('GOOGLE_AI_API_KEY') || env('GOOGLE_GENAI_API_KEY')
    if (geminiKey) for (const model of (env('NALU_IMAGE_GEMINI_MODELS') || 'gemini-3-pro-image-preview,gemini-2.5-flash-image').split(',').map(value => value.trim()).filter(Boolean)) {
      if (signal.aborted) break
      try {
        const data = await providerJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          contents: [{ parts: [{ text: finalPrompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspectRatio(width, height) } },
        }, { 'x-goog-api-key': geminiKey }, signal, 55000)
        for (const part of data?.candidates?.[0]?.content?.parts || []) {
          const inline = part.inlineData || part.inline_data
          if (inline?.data) return await finish(inlineBytes(`data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}`))
        }
      } catch { /* next configured backend, once each */ }
    }
    const base = (env('NALU_IMAGE_BASE_URL') || env('ZAI_BASE_URL')).replace(/\/+$/, '')
    const key = env('NALU_IMAGE_API_KEY') || env('ZAI_API_KEY')
    if (!signal.aborted && base && key) {
      try {
        const data = await providerJson(`${base}/images/generations`, { model: env('NALU_IMAGE_MODEL') || env('ZAI_IMAGE_MODEL') || 'z-image-turbo', prompt: finalPrompt, size: `${width}x${height}` }, { Authorization: `Bearer ${key}` }, signal, 45000)
        const first = data?.data?.[0]
        if (first?.b64_json) return await finish(inlineBytes(`data:image/png;base64,${first.b64_json}`))
        if (first?.url) return await finish(String(first.url).startsWith('data:') ? inlineBytes(first.url) : await bakeProviderUrl(first.url, signal))
      } catch { /* free fallback below */ }
    }
    if (!signal.aborted) {
      try {
        const base = (env('NALU_IMAGE_FALLBACK_BASE') || 'https://image.pollinations.ai').replace(/\/+$/, '')
        const url = `${base}/prompt/${encodeURIComponent(finalPrompt)}?width=${width}&height=${height}&nologo=true&model=${encodeURIComponent(env('NALU_IMAGE_FALLBACK_MODEL') || 'flux')}&seed=${Math.floor(Math.random() * 1e9)}`
        return await finish(await bakeProviderUrl(url, signal))
      } catch { /* never return a generate-on-load URL */ }
    }
    throw new Error(signal.aborted ? 'Image generation timed out. Please retry.' : 'The image service could not produce a saved image. Please retry.')
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}
