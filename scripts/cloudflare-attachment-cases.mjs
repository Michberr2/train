import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

class MediaResponse extends EventEmitter {
  code = 200; headers = {}; chunks = []; destroyed = false
  status(code) { this.code = code; return this }
  setHeader(key, value) { this.headers[key] = value; return this }
  flushHeaders() { this.headersSent = true }
  write(bytes) { this.chunks.push(bytes); queueMicrotask(() => this.emit('drain')); return false }
  end() { this.finished = true }
  destroy() { this.destroyed = true; this.emit('close') }
}

export async function cloudflareAttachmentCases({ api, store, worker, env, db, objects }) {
  const { beginAttachment, putAttachmentPart, finishAttachment, storeAttachment, listAttachments, CloudflareAttachments, connectionMediaUrl, serveConnectionMedia, CHUNK_BYTES } = api
  const files = new CloudflareAttachments(store), owner = 'owner-a'
  db.prepare('UPDATE nalu_storage_allowances SET used=0').run()
  const fetchWorker = (url, init) => worker.fetch(new Request(url, init), env)
  globalThis.fetch = fetchWorker
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const begin = (sourceId, bytes, extra = {}) => beginAttachment(store, owner, { sourceId, filename: 'video.mp4', mime: 'video/mp4', size: bytes.length, sha256: hash(bytes), ...extra })
  const bytes = Buffer.alloc(CHUNK_BYTES + 47, 29), meta = await begin('resumable-video', bytes, { taskId: 'task-one', flowId: 'flow-one' })
  await assert.rejects(finishAttachment(store, owner, meta.id), /incomplete/)
  assert.equal(await files.part(owner, meta.id, 0), null)
  await assert.rejects(putAttachmentPart(store, 'owner-b', meta.id, 0, bytes.subarray(0, CHUNK_BYTES)), /not found/)
  await assert.rejects(putAttachmentPart(store, owner, meta.id, 0, Buffer.alloc(3)), /Invalid attachment part/)
  await putAttachmentPart(store, owner, meta.id, 0, bytes.subarray(0, CHUNK_BYTES))
  await assert.rejects(finishAttachment(store, owner, meta.id), /incomplete/)
  assert.equal((await listAttachments(store, owner)).attachments.length, 0)
  await assert.rejects(connectionMediaUrl(store, owner, meta.id, 'video'), /Save the video/)
  assert.equal(await files.part(owner, meta.id, 0), null)

  // The D1 write committed but its acknowledgement disappeared. A retry sees
  // the same immutable part; it cannot replace bytes or create another record.
  let lost = false
  globalThis.fetch = async (url, init) => {
    const response = await fetchWorker(url, init)
    if (!lost && String(url).endsWith('/v1/batch') && init.body.includes('INSERT INTO nalu_attachment_chunks')) { lost = true; throw new Error('Lost attachment acknowledgement') }
    return response
  }
  await assert.rejects(putAttachmentPart(store, owner, meta.id, 1, bytes.subarray(CHUNK_BYTES)), /Lost attachment/)
  globalThis.fetch = fetchWorker
  await putAttachmentPart(store, owner, meta.id, 1, bytes.subarray(CHUNK_BYTES))
  await finishAttachment(store, owner, meta.id)
  assert.deepEqual(Buffer.concat(await Promise.all([0, 1].map(part => files.part(owner, meta.id, part)))), bytes)
  assert.equal(await files.part('owner-b', meta.id, 0), null)
  await putAttachmentPart(store, owner, meta.id, 0, bytes.subarray(0, CHUNK_BYTES))
  await assert.rejects(putAttachmentPart(store, owner, meta.id, 0, Buffer.alloc(CHUNK_BYTES, 30)), /different bytes/)
  assert.deepEqual((await listAttachments(store, owner, 'flow_def_flow-one')).attachments.map(row => row.id), [meta.id])
  assert.equal((await listAttachments(store, 'owner-b')).attachments.length, 0)
  const same = await begin('resumable-video', bytes, { filename: 'changed.mp4' })
  assert.equal(same.filename, 'video.mp4')

  const raceBytes = Buffer.from('Immutable first upload'), race = await begin('race', raceBytes)
  const attempts = await Promise.allSettled([raceBytes, Buffer.alloc(raceBytes.length, 88)].map(value => putAttachmentPart(store, owner, race.id, 0, value)))
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1)
  assert.match(attempts.find(value => value.status === 'rejected').reason.message, /different bytes/)
  const winner = await files.part(owner, race.id, 0, false)
  if (winner.equals(raceBytes)) await finishAttachment(store, owner, race.id)
  else await assert.rejects(finishAttachment(store, owner, race.id), /integrity/)
  const wrong = await begin('wrong-hash', Buffer.from('expected'))
  await putAttachmentPart(store, owner, wrong.id, 0, Buffer.from('wrong!!!'))
  await assert.rejects(finishAttachment(store, owner, wrong.id), /integrity/)
  assert.equal((await files.get(owner, wrong.id)).ready, false)
  const beforeEmpty = objects.size
  const empty = await storeAttachment(store, owner, { sourceId: 'empty', filename: 'Empty.txt', mime: 'text/plain' }, Buffer.alloc(0))
  assert.equal(objects.size, beforeEmpty); assert.deepEqual(await files.part(owner, empty.id, 0), Buffer.alloc(0))
  console.log('PASS Cloudflare attachment resume, lost acknowledgement, conflicting concurrent uploads, completed-file immutability, full-file integrity, empty files and owner-scoped listing/downloads')

  const serve = async (url, method = 'GET', range) => { const res = new MediaResponse(); await serveConnectionMedia(store, { url, method, headers: range ? { range } : {} }, res); return res }
  const url = await connectionMediaUrl(store, owner, meta.id, 'video')
  await assert.rejects(connectionMediaUrl(store, 'owner-b', meta.id, 'video'), /Save the video/)
  await assert.rejects(connectionMediaUrl(store, owner, meta.id, 'image'), /Save the image/)
  const whole = await serve(url)
  assert.equal(whole.code, 200); assert.ok(whole.finished); assert.deepEqual(Buffer.concat(whole.chunks), bytes)
  assert.equal(whole.listenerCount('close'), 0)
  const ranged = await serve(url, 'GET', `bytes=${CHUNK_BYTES - 7}-${CHUNK_BYTES + 18}`)
  assert.equal(ranged.code, 206); assert.equal(ranged.headers['Content-Length'], 26)
  assert.deepEqual(Buffer.concat(ranged.chunks), bytes.subarray(CHUNK_BYTES - 7, CHUNK_BYTES + 19))
  assert.deepEqual(Buffer.concat((await serve(url, 'GET', 'bytes=-9')).chunks), bytes.subarray(-9))
  assert.equal((await serve(url, 'GET', 'bytes=999999999-')).code, 416)
  const head = await serve(url, 'HEAD'); assert.equal(head.chunks.length, 0); assert.equal(head.headers['Content-Length'], bytes.length)
  const token = new URL(url).searchParams.get('file'), tokenHash = hash(token)
  assert.equal(db.prepare('SELECT count(*) AS n FROM nalu_connection_media WHERE token_hash=?').get(token).n, 0)
  db.prepare('UPDATE nalu_connection_media SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00Z', tokenHash)
  assert.equal((await serve(url)).code, 404)
  assert.equal((await serve('https://n4lu.ai/api/connection-media?file=bad')).code, 404)
  const granted = await connectionMediaUrl(store, owner, meta.id, 'video')
  const key = hash(owner) + '/chunks/' + hash(bytes.subarray(0, CHUNK_BYTES)), savedObject = objects.get(key)
  objects.set(key, { ...savedObject, bytes: Buffer.from('damaged object') })
  await assert.rejects(files.part(owner, meta.id, 0), /integrity/)
  await assert.rejects(serve(granted), /integrity/)
  objects.set(key, savedObject)
  console.log('PASS Cloudflare connection media uses private R2 with expiring grants, byte ranges, HEAD, streaming backpressure and corruption rejection')
  let generated = 0
  const identity = { flowId: 'artifact-flow', flowName: 'Saved workflow', nodeId: 'document', nodeLabel: 'Document', runId: 'artifact-run', ts: Date.now() }
  const built = Buffer.from('A saved document with its original text, 🐺 and 🦄. '.repeat(12000))
  const output = await api.storeGeneratedArtifact(store, owner, identity, async () => { generated++; return { kind: 'document', filename: 'Document.txt', mime: 'text/plain', bytes: built, result: 'Saved document result' } })
  assert.deepEqual(output.bytes, built)
  const recovered = await api.storeGeneratedArtifact(store, owner, identity, async () => { throw new Error('A saved artifact must not regenerate') })
  assert.deepEqual(recovered.bytes, built); assert.equal(recovered.result, 'Saved document result'); assert.equal(generated, 1)
  assert.equal(await api.readArtifact(store, 'owner-b', output.meta.id), null)
  assert.equal((await api.listArtifacts(store, owner))[0].id, output.meta.id)
  await api.deleteArtifact(store, 'owner-b', output.meta.id); assert.ok(await api.readArtifact(store, owner, output.meta.id))
  await api.deleteArtifact(store, owner, output.meta.id); assert.equal(await api.readArtifact(store, owner, output.meta.id), null)
  console.log('PASS Cloudflare generated outputs use verified private attachments, preserve original bytes on resume and scope artifact listing/deletion to the owner')
}
