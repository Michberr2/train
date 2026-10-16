import assert from 'node:assert/strict'
import { build } from 'esbuild'
async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { consumeChatStream } = await load('../naludesktop/src/lib/chatStream.ts')
const { createSSEParser } = await load('../nalumobile/src/sse.ts')
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const text = 'Who is this website for? 🐺'
const wire = ': keepalive\n\n' + frame('route', { name: 'Nalu', kind: 'general' }) + frame('delta', { text }) + ': keepalive\n\n' + frame('finish', { reason: 'stop' }) + frame('done', { ok: true })
function response(value) {
  const bytes = new TextEncoder().encode(value); let offset = 0
  return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) return c.close(); c.enqueue(bytes.slice(offset, ++offset)) } }))
}
let answer = ''
await consumeChatStream(response(wire), { onDelta: part => { answer += part } })
assert.equal(answer, text)
const events = []
const mobile = createSSEParser((event, data) => events.push({ event, data: JSON.parse(data) }))
for (let i = 0; i < wire.length; i += 3) mobile.push(wire.slice(i, i + 3))
mobile.finish()
assert.equal(events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), text)
assert.equal(events.at(-1).data.ok, true)
const failure = frame('error', { code: 'MODELS_UNAVAILABLE', retryable: true, message: 'Your request is saved. Tap Retry.' })
await assert.rejects(consumeChatStream(response(failure), { onDelta() {} }), /Your request is saved/)
await assert.rejects(consumeChatStream(response(frame('delta', { text: 'Partial' })), { onDelta() {} }), /before completion/)
console.log('PASS: desktop and mobile SSE consumers accept heartbeats, question text, UTF-8, finish/done, and actionable errors')
