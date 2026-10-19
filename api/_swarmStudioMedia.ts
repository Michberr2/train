import { createHash } from 'node:crypto'
import { publicFetch } from './_publicFetch'
import { beginAttachment, putAttachmentPart, finishAttachment, CHUNK_BYTES, type AttachmentClient } from './_taskAttachments'
import { SwarmStore } from './_swarmStore'
import { requireLeasedSwarmGeneration, resolveSwarmGenerationScope, type SwarmGenerationScope } from './_swarmGeneration'
import type { SwarmStudioArtifact, SwarmStudioMedia } from './_swarmStudioArtifact'

const IMAGE_LIMIT = 2 * 1024 * 1024
const VIDEO_LIMIT = 24 * 1024 * 1024
const DOWNLOAD_CHUNK = 4 * 1024 * 1024

function check(signal: AbortSignal): void { signal.throwIfAborted() }
function contentRange(response: Response, bytes: Buffer, start: number, total?: number) {
  const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  if (!match) throw new Error('The video provider did not return a verifiable byte range.')
  const from = Number(match[1]), end = Number(match[2]), size = Number(match[3])
  if (from !== start || end < from || end - from + 1 !== bytes.length || size <= end || size > VIDEO_LIMIT
    || (total !== undefined && size !== total)) throw new Error('The video download was incomplete or exceeds the supported size.')
  return size
}

/** Reuse the existing DNS-pinned public transport without raising its5MB cap.
 * Larger clips need stable, explicit byte-range support from the provider. */
async function downloadVideo(url: string, signal: AbortSignal): Promise<Buffer> {
  const headers: Record<string, string> = { Accept: 'video/mp4,video/webm,application/octet-stream', Range: `bytes=0-${DOWNLOAD_CHUNK - 1}` }
  const fetchPart = (requestHeaders: Record<string, string>) => publicFetch(url, { headers: requestHeaders, signal, timeoutMs: 60000, maxBytes: DOWNLOAD_CHUNK, maxRedirects: 4 })
  const first = await fetchPart(headers)
  check(signal)
  if (![200, 206].includes(first.status)) throw new Error('The video provider did not return a downloadable clip.')
  const initial = Buffer.from(await first.arrayBuffer())
  if (!initial.length || initial.length > DOWNLOAD_CHUNK) throw new Error('The video provider returned an empty or oversized download.')
  if (first.status === 200) return initial
  const total = contentRange(first, initial, 0), chunks = [initial]
  let offset = initial.length
  const etag = first.headers.get('etag'), modified = first.headers.get('last-modified')
  const validator = etag && !etag.startsWith('W/') ? etag : modified && Number.isFinite(Date.parse(modified)) ? modified : undefined
  if (offset < total && !validator) throw new Error('This video provider cannot verify a stable multi-part download. Retry with a smaller clip.')
  while (offset < total) {
    check(signal)
    const response = await fetchPart({ ...headers, Range: `bytes=${offset}-${Math.min(total - 1, offset + DOWNLOAD_CHUNK - 1)}`, 'If-Range': validator! })
    if (response.status !== 206 || (etag && !etag.startsWith('W/') ? response.headers.get('etag') !== etag : response.headers.get('last-modified') !== modified)) {
      throw new Error('The video changed during download. No partial clip was saved.')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > DOWNLOAD_CHUNK) throw new Error('The video provider returned an invalid download part.')
    contentRange(response, bytes, offset, total)
    chunks.push(bytes); offset += bytes.length
  }
  return Buffer.concat(chunks)
}

function inlineImage(url: string): Buffer {
  const match = url.match(/^data:image\/(?:png|jpeg);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/)
  if (!match || match[1].length > Math.ceil(IMAGE_LIMIT / 3) * 4) throw new Error('The image generator did not return supported, bounded raster bytes.')
  const bytes = Buffer.from(match[1], 'base64')
  if (!bytes.length || bytes.length > IMAGE_LIMIT || bytes.toString('base64') !== match[1]) throw new Error('The image bytes were invalid or too large.')
  return bytes
}

function mediaType(kind: 'image' | 'video', bytes: Buffer): { mime: SwarmStudioMedia['mime']; extension: string } {
  if (kind === 'image') {
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return { mime: 'image/png', extension: 'png' }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) return { mime: 'image/jpeg', extension: 'jpg' }
  } else {
    if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') return { mime: 'video/mp4', extension: 'mp4' }
    if (bytes.length >= 16 && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return { mime: 'video/webm', extension: 'webm' }
  }
  throw new Error('The media response was not a supported image or video file.')
}

/** Persist actual generated media in the existing private attachment transport.
 * Only the final leased Swarm artifact commit publishes this descriptor. Uploads
 * are immutable and idempotent; cancellation may leave unreferenced private
 * chunks, but cannot create a completed Swarm result or ordinary chat entry. */
export async function prepareSwarmStudioMedia(client: AttachmentClient, scope: SwarmGenerationScope,
  artifact: SwarmStudioArtifact, signal: AbortSignal): Promise<SwarmStudioArtifact> {
  requireLeasedSwarmGeneration(scope)
  if (!['image', 'video'].includes(scope.studioKind) || artifact.studioKind !== scope.studioKind || typeof artifact.payload.url !== 'string') throw new Error('This media result does not match its Studio work item.')
  const store = new SwarmStore(client)
  const fresh = async () => {
    check(signal)
    await resolveSwarmGenerationScope(store, scope.ownerId, { sourceJobId: scope.sourceJobId, taskId: scope.taskId,
      expectedStudioKind: scope.studioKind, executionId: scope.lease!.jobId, leaseToken: scope.lease!.token })
    check(signal)
  }
  await fresh()
  const kind = scope.studioKind as 'image' | 'video'
  const bytes = kind === 'image' ? inlineImage(artifact.payload.url) : await downloadVideo(artifact.payload.url, signal)
  if (bytes.length > (kind === 'image' ? IMAGE_LIMIT : VIDEO_LIMIT)) throw new Error('The generated media exceeds the supported save size.')
  const type = mediaType(kind, bytes), sha256 = createHash('sha256').update(bytes).digest('hex')
  const sourceId = `swarm:${createHash('sha256').update(JSON.stringify([scope.projectId, scope.taskId, scope.lease!.jobId])).digest('hex')}`
  await fresh()
  const saved = await beginAttachment(client, scope.ownerId, { sourceId, taskId: scope.taskId, title: typeof artifact.payload.name === 'string' ? artifact.payload.name : `Nalu ${kind}`,
    filename: `Nalu-${kind}.${type.extension}`, mime: type.mime, size: bytes.length, sha256 })
  if (saved.sourceId !== sourceId || saved.taskId !== scope.taskId || saved.sha256 !== sha256 || saved.size !== bytes.length || saved.mime !== type.mime) throw new Error('The stored attachment does not match this generated media.')
  for (let part = 0; part < saved.parts; part++) {
    await fresh()
    await putAttachmentPart(client, scope.ownerId, saved.id, part, bytes.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES))
  }
  await fresh()
  const ready = await finishAttachment(client, scope.ownerId, saved.id)
  await fresh()
  const media: SwarmStudioMedia = { attachmentId: ready.id, filename: ready.filename, mime: type.mime, size: ready.size, parts: ready.parts, sha256: ready.sha256 }
  const { url: _providerUrl, ...payload } = artifact.payload
  return { ...artifact, payload: { ...payload, media } }
}
