import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const directory = await mkdtemp(tmpdir() + '/nalu-model-download-')
await build({ entryPoints: ['client/src/lib/browserModelDownload.ts'], outfile: directory + '/download.mjs', bundle: true, format: 'esm', platform: 'browser' })
const { downloadBrowserModel } = await import(pathToFileURL(directory + '/download.mjs'))
const url = 'https://huggingface.co/author/model/resolve/immutable/onnx/model_q4.onnx'
const data = Uint8Array.from({ length: 307 }, (_, index) => index % 251), options = { chunkBytes: 64, parallel: 4 }
let mode = 'ranges', calls = [], failures = 0
const cache = new Map()
globalThis.caches = { open: async () => ({ match: async key => cache.get(key)?.clone(), put: async (key, value) => { cache.set(key, new Response(await value.arrayBuffer())) }, delete: async key => cache.delete(key) }) }
const request = async (_url, init) => {
  init.signal?.throwIfAborted()
  const range = new Headers(init.headers).get('Range'); calls.push(range)
  if (!range || mode === 'full') return new Response(data.slice())
  const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range), start = Number(from), end = Math.min(Number(to), data.length - 1)
  if (mode === 'retry' && start === 64 && failures++ < 2) throw new Error('Temporary model connection error')
  if (mode === 'corrupt' && start > 0) return new Response(data.slice(), { status: 200 })
  const headers = mode === 'hidden' ? {} : { 'Content-Range': `bytes ${start}-${end}/${data.length}` }
  return new Response(data.slice(start, end + 1), { status: 206, headers })
}
const run = async () => new Uint8Array(await (await downloadBrowserModel(url, { credentials: 'omit' }, request, options)).arrayBuffer())
try {
  assert.deepEqual(await run(), data)
  assert.equal(calls.length, Math.ceil(data.length / 64))
  console.log('PASS Parallel model ranges assemble in order, validate their boundaries, and return every original byte')
  calls = []; mode = 'full'; assert.deepEqual(await run(), data); assert.equal(calls.length, 1)
  calls = []; mode = 'hidden'; assert.deepEqual(await run(), data); assert.deepEqual(calls, ['bytes=0-63', null])
  console.log('PASS Servers that ignore ranges or hide Content-Range use a complete response; partial bytes never impersonate a complete model')
  cache.clear(); calls = []; mode = 'retry'; failures = 0
  assert.deepEqual(await run(), data); assert.equal(calls.filter(range => range === 'bytes=64-127').length, 3)
  cache.clear(); mode = 'corrupt'; await assert.rejects(run(), /inconsistent byte range/)
  console.log('PASS Interrupted parts have bounded retries, while inconsistent range responses fail without claiming a completed model')
  cache.clear(); mode = 'ranges'; calls = []
  const response = await downloadBrowserModel(url, {}, request, options), reader = response.body.getReader()
  assert.equal((await reader.read()).value.length, 64); await reader.cancel()
  assert.ok(cache.size > 0, 'Completed parts survive an interrupted download')
  mode = 'ranges'; calls = []; assert.deepEqual(await run(), data)
  assert.ok(calls.length < Math.ceil(data.length / 64), 'A retry reuses completed cached parts')
  console.log('PASS Cancellation retains completed model parts and a retry resumes from cached bytes')
} finally { delete globalThis.caches; await rm(directory, { recursive: true, force: true }) }
