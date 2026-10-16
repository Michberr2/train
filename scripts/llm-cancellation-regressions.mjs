// Real completion/retry/continuation helper, fake providers and virtual timers.
// No network, credentials, quota consumption, or wall-clock timeout waits.
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['api/_llm.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { chatComplete, chatCompleteEx, chatCompleteContinued, completionFailure } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now }
const providers = [
  { base: 'https://primary.invalid', key: 'offline', model: 'fixture', label: 'primary' },
  { base: 'https://fallback.invalid', key: 'offline', model: 'fixture', label: 'fallback' },
]
const messages = [{ role: 'user', content: 'Return a fixture answer.' }]
const options = (signal, extra = {}) => ({ providers, timeoutMs: 45000, signal, ...extra })
const completion = (content = 'Finished.', finish_reason = 'stop') => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason }] }) })
const failure = (status, text = 'fixture provider failure') => ({ ok: false, status, text: async () => text })
const aborted = (error) => error?.name === 'AbortError' && error.message === 'The request was cancelled.'
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
let timers = new Map(), sequence = 0, requests = [], implementation
const reset = (fetch) => {
  assert.equal(timers.size, 0, 'previous case left a watchdog/backoff running')
  requests = []
  implementation = fetch
}
const cleanSignal = (signal) => {
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'caller abort listeners must be removed on every exit')
  assert.equal(timers.size, 0, 'abort/success must clear watchdog and retry timers')
}
const waitForBackoff = async () => {
  for (let i = 0; i < 30; i++) {
    const timer = [...timers.entries()].find(([, value]) => value.ms < 2000)
    if (timer) return timer
    await Promise.resolve()
  }
  assert.fail('expected a retry backoff')
}
const fire = ([id, timer]) => { timers.delete(id); timer.callback() }
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
const settles = async (promise) => {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  await flush()
  assert.equal(settled, true, 'deadline/cancel must settle independently of the ignored transport abort')
}
try {
  globalThis.setTimeout = (callback, ms) => { const id = ++sequence; timers.set(id, { callback, ms }); return id }
  globalThis.clearTimeout = (id) => timers.delete(id)
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return implementation(url, init) }

  let controller = new AbortController()
  controller.abort()
  reset(() => assert.fail('pre-aborted call contacted a provider'))
  await assert.rejects(chatComplete(messages, options(controller.signal)), aborted)
  assert.equal(requests.length, 0)
  cleanSignal(controller.signal)

  // Cancel an active fetch with both primary retries and fallback configured.
  controller = new AbortController()
  let entered = deferred(), upstreamAborted = false
  reset((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { upstreamAborted = true; reject(new DOMException('fixture abort', 'AbortError')) }, { once: true })
    entered.resolve()
  }))
  let result = chatCompleteEx(messages, options(controller.signal))
  await entered.promise
  controller.abort(new Error('private caller reason'))
  await assert.rejects(result, aborted)
  assert.equal(upstreamAborted, true, 'caller cancellation must reach the actual fetch signal')
  assert.equal(requests.length, 1, 'cancellation must never retry or fail over')
  cleanSignal(controller.signal)

  // Fetch headers can arrive before a stalled JSON body. Cancellation must also
  // stop that body read and must not be mistaken for an empty provider response.
  controller = new AbortController()
  entered = deferred()
  reset((_url, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('body aborted', 'AbortError')), { once: true })
    entered.resolve()
  }) }))
  result = chatCompleteEx(messages, options(controller.signal))
  await entered.promise
  controller.abort()
  await assert.rejects(result, aborted)
  assert.equal(requests.length, 1)
  cleanSignal(controller.signal)

  // Both rate-limit and generic transient retry delays are interruptible.
  for (const status of [429, 503]) {
    controller = new AbortController()
    reset(() => failure(status))
    result = chatCompleteEx(messages, options(controller.signal))
    await waitForBackoff()
    controller.abort()
    await assert.rejects(result, aborted)
    assert.equal(requests.length, 1, `cancel during ${status} delay must not start the next attempt`)
    cleanSignal(controller.signal)
  }

  // Abort while consuming an error body: neither size shrinking nor an immediate
  // quota failover may start after the caller has gone away.
  for (const [status, body] of [[400, 'maximum context exceeded'], [402, 'out of credits']]) {
    controller = new AbortController()
    reset(() => ({ ok: false, status, text: async () => { controller.abort(); return body } }))
    await assert.rejects(chatCompleteEx(messages, options(controller.signal, { maxTokens: 16000 })), aborted)
    assert.equal(requests.length, 1)
    cleanSignal(controller.signal)
  }

  // Watchdog expiry remains a timeout, and still reaches the fallback even when
  // a live caller signal is present. It must not cancel that caller's signal.
  controller = new AbortController()
  entered = deferred()
  reset((_url, { signal }) => requests.length === 1 ? new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('watchdog', 'AbortError')), { once: true })
    entered.resolve()
  }) : completion())
  result = chatCompleteEx(messages, options(controller.signal))
  await entered.promise
  fire([...timers.entries()][0])
  assert.equal((await result).content, 'Finished.')
  assert.equal(controller.signal.aborted, false)
  assert.deepEqual(requests.map(({ url }) => new URL(url).hostname), ['primary.invalid', 'fallback.invalid'])
  cleanSignal(controller.signal)

  // An upstream can ignore AbortSignal before headers. The deadline must still
  // settle and fail over; a late response body must be cancelled without reads.
  controller = new AbortController()
  const lateHeaders = deferred()
  let lateCancelled = 0
  reset(() => requests.length === 1 ? lateHeaders.promise : completion('Timely fallback.'))
  result = chatCompleteEx(messages, options(controller.signal))
  fire([...timers.entries()][0])
  await settles(result)
  assert.equal((await result).content, 'Timely fallback.')
  assert.equal(requests[0].init.signal.aborted, true)
  assert.equal(requests.length, 2)
  cleanSignal(controller.signal)
  lateHeaders.resolve({ ok: true, body: { cancel: () => { lateCancelled++; return new Promise(() => {}) } }, json: () => assert.fail('late response content must never be consumed') })
  await flush()
  assert.equal(lateCancelled, 1, 'late headers release their body even after the attempt returned')
  assert.equal(requests.length, 2)

  // Caller cancellation is equally decisive with an ignored pre-header abort;
  // it cannot wait for the fetch, retry, or accept its eventual answer.
  controller = new AbortController()
  const cancelledHeaders = deferred()
  reset(() => cancelledHeaders.promise)
  result = chatCompleteEx(messages, options(controller.signal))
  controller.abort(new Error('private ignored-transport reason'))
  await settles(result)
  await assert.rejects(result, aborted)
  assert.equal(requests.length, 1)
  cleanSignal(controller.signal)
  cancelledHeaders.resolve(completion('Too late.'))
  await flush()
  assert.equal(requests.length, 1)

  // Real readable bodies may have a cancellation hook that never resolves.
  // Cancellation and lock release are best-effort, never part of the deadline.
  for (const callerCancel of [false, true]) for (const status of [200, 402]) {
    controller = new AbortController()
    let bodyCancelled = 0
    const response = new Response(new ReadableStream({ cancel() { bodyCancelled++; return new Promise(() => {}) } }), { status })
    reset(() => response)
    result = chatCompleteEx(messages, options(controller.signal, { maxAttempts: 1 }))
    await flush()
    assert.equal(response.body.locked, true, 'completion must own the body reader')
    if (callerCancel) controller.abort()
    else fire([...timers.entries()][0])
    await settles(result)
    await assert.rejects(result, callerCancel ? aborted : error => {
      assert.deepEqual(completionFailure(error), { category: 'timeout' })
      assert.match(error.message, /took too long/)
      return true
    })
    assert.equal(bodyCancelled, 1)
    assert.equal(response.body.locked, false, 'ignored cancellation must still release the owned reader lock')
    assert.equal(requests.length, 1)
    cleanSignal(controller.signal)
  }

  // A compatible custom JSON reader may also ignore abort. It cannot return a
  // successful answer after either the watchdog or caller cancellation wins.
  for (const callerCancel of [false, true]) {
    controller = new AbortController()
    const lateBody = deferred()
    reset(() => ({ ok: true, json: () => lateBody.promise }))
    result = chatCompleteEx(messages, options(controller.signal, { maxAttempts: 1 }))
    await flush()
    if (callerCancel) controller.abort()
    else fire([...timers.entries()][0])
    await settles(result)
    await assert.rejects(result, callerCancel ? aborted : error => completionFailure(error)?.category === 'timeout')
    lateBody.resolve({ choices: [{ message: { content: 'Late private body.' }, finish_reason: 'stop' }] })
    await flush()
    assert.equal(requests.length, 1)
    cleanSignal(controller.signal)
  }

  // A delayed timer (for example after machine suspension) cannot make an
  // already expired response valid merely because its callback ran too late.
  let now = 1000
  Date.now = () => now
  const expiredHeaders = deferred()
  reset(() => expiredHeaders.promise)
  result = chatCompleteEx(messages, options(undefined, { maxAttempts: 1 }))
  now = 1000 + 45001
  expiredHeaders.resolve(completion('Expired response.'))
  await settles(result)
  await assert.rejects(result, error => completionFailure(error)?.category === 'timeout')
  assert.equal(timers.size, 0)
  Date.now = original.now

  // The owned single body read preserves split multibyte UTF-8 and the existing
  // response contract on ordinary real Response objects.
  const bytes = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'Wolf — café 🐺' }, finish_reason: 'stop' }] }))
  reset(() => new Response(new ReadableStream({ start(stream) { for (const byte of bytes) stream.enqueue(Uint8Array.of(byte)); stream.close() } })))
  assert.deepEqual(await chatCompleteEx(messages, options(undefined)), { content: 'Wolf — café 🐺', finishReason: 'stop' })
  assert.equal(timers.size, 0)

  // No-signal callers retain transient retry and provider failover behavior.
  reset(() => requests.length === 1 ? failure(503) : requests.length === 2 ? failure(402) : completion())
  result = chatComplete(messages, options(undefined))
  fire(await waitForBackoff())
  assert.equal(await result, 'Finished.')
  assert.deepEqual(requests.map(({ url }) => new URL(url).hostname), ['primary.invalid', 'primary.invalid', 'fallback.invalid'])
  assert.equal(timers.size, 0)

  // Operational metadata survives scrubbing without retaining private error
  // bodies, raw messages or nested causes. Public wording remains unchanged.
  for (const [status, body, category, wording] of [
    [429, 'rate limited PRIVATE_SECRET', 'rate_limit', /over capacity/],
    [402, 'out of credits PRIVATE_SECRET', 'quota', /over capacity/],
    [400, 'maximum context exceeded PRIVATE_SECRET', 'input_limit', /too large/],
    [503, 'upstream PRIVATE_SECRET', 'provider_http', /temporarily unavailable/],
  ]) {
    reset(() => failure(status, body))
    await assert.rejects(chatCompleteEx(messages, options(undefined, { maxAttempts: 1 })), error => {
      assert.match(error.message, wording)
      assert.deepEqual(completionFailure(error), { category, status })
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_SECRET/)
      assert.equal(error.cause, undefined)
      return true
    })
  }
  reset(() => completion('', 'length'))
  await assert.rejects(chatCompleteEx(messages, options(undefined, { maxAttempts: 1 })), error => {
    assert.deepEqual(completionFailure(error), { category: 'empty_response', finishReason: 'length' })
    assert.match(error.message, /temporarily unavailable/)
    return true
  })

  reset(() => failure(429))
  await assert.rejects(chatCompleteEx(messages, options(undefined, { maxAttempts: 1 })), /over capacity/)
  assert.equal(requests.length, 1, 'Studio deadline helper attempt cap must still forbid hidden retries')
  assert.equal(timers.size, 0)

  // Continued generation must reject cancellation, not return the partial first
  // completion from its ordinary best-effort continuation error handler.
  controller = new AbortController()
  entered = deferred()
  reset((_url, { signal }) => requests.length === 1 ? completion('First part ', 'length') : new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('continuation abort', 'AbortError')), { once: true })
    entered.resolve()
  }))
  result = chatCompleteContinued(messages, options(controller.signal))
  await entered.promise
  controller.abort()
  await assert.rejects(result, aborted)
  assert.equal(requests.length, 2)
  cleanSignal(controller.signal)

  reset(() => requests.length === 1 ? completion('First part ', 'length') : failure(503))
  assert.deepEqual(await chatCompleteContinued(messages, options(undefined, { maxAttempts: 1 })), { content: 'First part ', finishReason: 'length' }, 'ordinary continuation failure keeps existing partial-result semantics')
  assert.equal(requests.length, 2)
  assert.equal(timers.size, 0)
  // Also exercise the real event-loop timer against a fetch that never settles;
  // no virtual clock or cooperative AbortSignal implementation can mask a hang.
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  controller = new AbortController()
  reset(() => new Promise(() => {}))
  const realStarted = performance.now()
  await assert.rejects(chatCompleteEx(messages, options(controller.signal, { timeoutMs: 20, maxAttempts: 1 })), error => completionFailure(error)?.category === 'timeout')
  assert.ok(performance.now() - realStarted < 1000, 'real watchdog must not wait for the ignored fetch abort')
  assert.equal(requests[0].init.signal.aborted, true)
  cleanSignal(controller.signal)
  console.log('PASS: decisive timeout/caller-cancel races against ignored fetch/body abort, late response disposal, reader cleanup, absolute deadlines and split UTF-8; preserved retry/failover/error metadata and continuation cancellation.')
} finally {
  globalThis.fetch = original.fetch
  globalThis.setTimeout = original.setTimeout
  globalThis.clearTimeout = original.clearTimeout
  Date.now = original.now
}
