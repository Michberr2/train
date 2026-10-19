// Deterministic Node streams only; never launches Chromium or calls providers.
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['api/_websiteDownloadStream.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { readWebsiteDownload } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const bound = 1024 * 1024
const options = () => ({ deadlineMs: Date.now() + 1000 })
const fixture = (acquire, cancelImpl) => {
  const calls = { acquire: 0, cancel: 0 }
  return { calls, download: { createReadStream() { calls.acquire++; return acquire() }, async cancel() { calls.cancel++; await cancelImpl?.() } } }
}
const idle = () => new Readable({ read() {} })
const flush = () => new Promise(resolve => setImmediate(resolve))
const unhandled = []
const capture = error => unhandled.push(error)
process.on('unhandledRejection', capture)
try {
  // Binary fragments can split UTF-8 code points; preserve exact bytes for the
  // separate decoder. A typed view must not expose bytes outside its range.
  const utf8 = Buffer.from('東京 🌊\n', 'utf8')
  const viewBuffer = Uint8Array.from([0, 65, 66, 0])
  const source = Readable.from([utf8.subarray(0, 2), utf8.subarray(2), 'Café', new DataView(viewBuffer.buffer, 1, 2), Uint8Array.from([67]).buffer])
  const valid = fixture(async () => source)
  assert.deepEqual(Buffer.from(await readWebsiteDownload(valid.download, options())), Buffer.concat([utf8, Buffer.from('CaféABC')]))
  assert.equal(valid.calls.cancel, 0)
  assert.equal(source.destroyed, true)
  assert.equal(source.listenerCount('data'), 0)

  const empty = fixture(async () => Readable.from([]))
  assert.equal((await readWebsiteDownload(empty.download, options())).length, 0)
  const maximum = fixture(async () => Readable.from([Buffer.alloc(bound - 1), Buffer.from([42])]))
  const bytes = await readWebsiteDownload(maximum.download, options())
  assert.equal(bytes.length, bound)
  assert.equal(bytes.at(-1), 42)

  for (const chunks of [[Buffer.alloc(bound), Buffer.from([1])], ['é'.repeat(bound / 2 + 1)], [{ not: 'bytes' }]]) {
    const stream = Readable.from(chunks)
    const test = fixture(async () => stream)
    await assert.rejects(readWebsiteDownload(test.download, options()), /limit|unsupported byte chunk/)
    await flush()
    assert.equal(test.calls.cancel, 1)
    assert.equal(stream.destroyed, true)
    assert.equal(stream.listenerCount('data'), 0)
  }

  for (const acquire of [async () => null, async () => { throw new Error('PRIVATE acquisition rejected') }, () => { throw new Error('PRIVATE acquisition threw') }]) {
    const test = fixture(acquire, async () => { throw new Error('Cancel also failed') })
    await assert.rejects(readWebsiteDownload(test.download, options()), error => {
      assert.match(error.message, /readable stream|download stream failed/)
      assert.doesNotMatch(String(error), /PRIVATE/)
      assert.equal(error.cause, undefined)
      return true
    })
    await flush()
    assert.equal(test.calls.cancel, 1)
  }

  const brokenStream = new Readable({ read() { this.push(Buffer.from('partial')); this.destroy(new Error('PRIVATE stream details')) } })
  const broken = fixture(async () => brokenStream)
  await assert.rejects(readWebsiteDownload(broken.download, options()), error => {
    assert.equal(error.message, 'The website download stream failed.')
    assert.doesNotMatch(String(error), /PRIVATE/)
    assert.equal(error.cause, undefined)
    return true
  })
  await flush()
  assert.equal(broken.calls.cancel, 1)
  assert.equal(brokenStream.destroyed, true)
  const earlyCloseStream = new Readable({ read() { this.push(Buffer.from('partial')); this.destroy() } })
  const earlyClose = fixture(async () => earlyCloseStream)
  await assert.rejects(readWebsiteDownload(earlyClose.download, options()), /closed before/)
  await flush()
  assert.equal(earlyCloseStream.listenerCount('error'), 0)
  assert.equal(earlyCloseStream.listenerCount('close'), 0)

  const neverEndingStream = idle()
  const neverEnding = fixture(async () => neverEndingStream)
  await assert.rejects(readWebsiteDownload(neverEnding.download, { deadlineMs: Date.now() + 25 }), /deadline/)
  await flush()
  assert.equal(neverEnding.calls.cancel, 1)
  assert.equal(neverEndingStream.destroyed, true)

  const controller = new AbortController()
  const abortStream = idle()
  const abortRead = fixture(async () => abortStream)
  const pendingAbort = readWebsiteDownload(abortRead.download, { ...options(), signal: controller.signal })
  await flush()
  controller.abort()
  await assert.rejects(pendingAbort, error => error.name === 'AbortError')
  await flush()
  assert.equal(abortRead.calls.cancel, 1)
  assert.equal(abortStream.destroyed, true)
  const alreadyAborted = fixture(async () => { throw new Error('Must not acquire after abort') })
  await assert.rejects(readWebsiteDownload(alreadyAborted.download, { ...options(), signal: controller.signal }), error => error.name === 'AbortError')
  await flush()
  assert.equal(alreadyAborted.calls.acquire, 0)
  assert.equal(alreadyAborted.calls.cancel, 1)

  // Acquisition can resolve after its deadline. Its late stream must still be
  // destroyed, including when teardown itself reports an asynchronous error.
  let resolveLate
  const lateStream = new Readable({ read() {}, destroy(error, callback) { queueMicrotask(() => callback(new Error('Late teardown failure'))) } })
  const late = fixture(() => new Promise(resolve => { resolveLate = resolve }))
  await assert.rejects(readWebsiteDownload(late.download, { deadlineMs: Date.now() + 25 }), /deadline/)
  resolveLate(lateStream)
  await flush()
  assert.equal(late.calls.cancel, 1)
  assert.equal(lateStream.destroyed, true)
  assert.equal(lateStream.listenerCount('error'), 0)

  // A cancel operation that never resolves cannot extend the read deadline.
  const stuck = fixture(() => new Promise(() => {}), () => new Promise(() => {}))
  await assert.rejects(readWebsiteDownload(stuck.download, { deadlineMs: Date.now() + 25 }), /deadline/)
  assert.equal(stuck.calls.cancel, 1)
  const expired = fixture(async () => { throw new Error('Must not acquire after deadline') })
  await assert.rejects(readWebsiteDownload(expired.download, { deadlineMs: Date.now() - 1 }), /deadline/)
  assert.equal(expired.calls.acquire, 0)
  assert.equal(expired.calls.cancel, 1)

  // The per-download 2.5-second cap holds even with a much larger caller budget.
  const capped = fixture(async () => idle())
  const started = Date.now()
  await assert.rejects(readWebsiteDownload(capped.download, { deadlineMs: started + 60000 }), /deadline/)
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 2400 && elapsed < 5000, `Expected the 2500ms hard cap; observed ${elapsed}ms`)
  await delay(10)
  assert.deepEqual(unhandled, [], 'Acquisition, cancellation and teardown must not leak rejected promises')
  console.log('PASS: download byte limits, exact UTF-8 bytes, failed/late acquisition, stream errors, cancellation, closed streams, stalled streams, and the 2.5-second cap.')
} finally { process.removeListener('unhandledRejection', capture) }
