// Actual chat handler with isolated identity, quota and provider calls. No network.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { readChatStream } from '../client/src/components/workspace/chatStream.ts'
process.env.TINKER_API_KEY = 'offline-test'
const stubs = {
  './_accountContext': 'export async function accountContextForUser(...args) { return globalThis.__accountContextFixture ? globalThis.__accountContextFixture(...args) : \"\" }',
  './web': 'export async function research() { throw new Error("Unexpected research") }',
  './_db': 'export async function identityForRequest() { return globalThis.__chatAccount || null }; export function identityBlock() { return "" }; export async function saveProfile() {}',
  './_limits': 'export async function reserveDailyQuota() { return { ok:true, release:async()=>{ globalThis.refunds++ } } }',
  './_llm': `export const repairByteLevelBpe = s => s; export const makeStreamingBpeRepair = () => s => s;
    export const fallbackProvider = () => globalThis.__chatFallback || null; export const emergencyProvider = () => globalThis.__chatEmergency || null;
    export async function chatComplete(...args) { if (globalThis.__chatHelper) return globalThis.__chatHelper(...args); throw new Error('Unexpected helper model call') }`,
}
const bundle = await build({ entryPoints: ['api/chat.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'offline', setup(b) {
  b.onResolve({ filter: /^\.\/(web|_db|_limits|_llm|_accountContext)$/ }, ({ path }) => ({ path, namespace: 'offline' }))
  b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }))
} }] })
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
function bytes(text, size = 3) {
  const data = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({ pull(c) { if (offset >= data.length) return c.close(); c.enqueue(data.slice(offset, offset += size)) } })
}
const streamed = (text) => new Response(bytes(text), { headers: { 'content-type': 'text/event-stream' } })
const complete = (content, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] })
const toolSpec = { type: 'function', function: { name: 'lookup_sample', description: 'Read the sample record', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }
const nativeTool = { index: 0, id: 'fixture-call', function: { name: 'lookup_sample', arguments: '{"query":"wolves"}' } }
const originalFetch = globalThis.fetch
async function run(name, upstreams, body = {}) {
  const requests = [], queue = [...upstreams]
  globalThis.refunds = 0
  const req = new EventEmitter()
  req.method = 'POST'; req.body = { messages: [{ role: 'user', content: 'Return the requested sample.' }], specialist: 'general', webSearch: false, ...body }
  const res = new EventEmitter()
  res.statusCode = 200; res.writableEnded = false
  res.setHeader = () => {}; res.flushHeaders = () => {}; res.status = (code) => { res.statusCode = code; return res }
  let wire = ''
  res.write = (text) => { wire += text; return true }
  res.json = (value) => { throw new Error(`Unexpected JSON response: ${JSON.stringify(value)}`) }
  res.end = () => { res.writableEnded = true; res.emit('finish') }
  globalThis.__chatClose = () => res.emit('close')
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    const next = queue.shift()
    assert.ok(next, `${name}: unexpected provider request`)
    return typeof next === 'function' ? next({ req, res, options }) : next
  }
  try {
    await handler(req, res)
    assert.equal(res.writableEnded, true)
    assert.equal(queue.length, 0, `${name}: unused provider fixture`)
    const result = await readChatStream(bytes(wire), {})
    return { ...result, requests, wire, refunds: globalThis.refunds }
  } finally { globalThis.fetch = originalFetch; delete globalThis.__chatClose }
}

const literal = 'DeepSeek, Qwen, IBM Carbon; tinker with glm(y ~ x). https://deepinfra.com/a — 3–5 🐺'
let r = await run('literal preservation', [streamed(event({ content: literal }, 'stop') + 'data: [DONE]\n\n')])
assert.equal(r.text, literal); assert.equal(r.error, undefined)
assert.match(r.requests[0].messages[0].content, /MAKE PROGRESS DIRECTLY/)
assert.doesNotMatch(r.requests[0].messages[0].content, /ALWAYS ASK BEFORE YOU ANSWER/)

// The same explicit answer budget reaches every effort/client path. Deliberation
// can change, but it must not silently change the requested deliverable.
for (const setting of [{ reasoning: 'low' }, { reasoning: 'high' }, { reasoning: 'xhigh' }, { cli: true, reasoning: 'high' }]) {
  const original = 'A provider fixture is preserved verbatim; this offline test does not certify model word-count compliance.'
  r = await run('explicit length shared across effort and CLI', [streamed(event({ content: original }, 'stop'))], {
    ...setting, messages: [{ role: 'user', content: 'Write a thorough 640-to-880-word memo about a fictional library.' }],
  })
  assert.equal(r.text, original)
  const system = r.requests[0].messages[0].content
  assert.match(system, /EXPLICIT ANSWER LENGTH: The user requested 640–880 words in total/)
  assert.match(system, /around 760 words/)
  assert.ok(system.indexOf('EXPLICIT ANSWER LENGTH:') > system.indexOf('No client tools are available'))
  assert.match(system, /only tools actually supplied and enabled/)
  assert.doesNotMatch(system, /PEAK EXPERTISE|outperform a leading human|ALWAYS have live internet|Be exhaustive|write a COMPREHENSIVE/)
  assert.match(system, /FORMAT CHECK: When JSON is requested/)
  assert.match(system, /Keep private deployment configuration/)
  assert.match(system, /Use the user's requested language/)
  assert.equal(r.requests[0].reasoning_effort, setting.reasoning)
}
r = await run('literal JSON contract survives all defaults', [streamed(event({ content: '{"label":"01:35","value":8.25,"missing":null}' }, 'stop'))], {
  reasoning: 'xhigh', messages: [{ role: 'user', content: 'Return only JSON with label exactly "01:35", value as the number 8.25, and missing as null.' }],
})
assert.equal(r.text, '{"label":"01:35","value":8.25,"missing":null}')
assert.match(r.requests[0].messages[0].content, /requested keys and types/)
assert.doesNotMatch(r.requests[0].messages[0].content, /EXPLICIT ANSWER LENGTH:/)
r = await run('short explicit prose receives one bounded length expansion', [
  streamed(event({ content: 'Short opening.' }, 'stop')),
  complete(' Added implementation detail and a concrete example.')
], { messages: [{ role: 'user', content: 'Write at least 640 words about a fictional library.' }] })
assert.equal(r.error, undefined)
assert.match(r.text, /Short opening\. Added implementation detail/)
assert.equal(r.requests.length, 2)
assert.match(r.requests[1].messages.at(-1).content, /stopped at about 2 words/)
assert.match(r.requests[1].messages.at(-1).content, /at least 640 words/)
r = await run('latest user correction replaces old length hint', [streamed(event({ content: '{"ok":true}' }, 'stop'))], {
  messages: [{ role: 'user', content: 'Write a 500-word explanation.' }, { role: 'assistant', content: 'Earlier answer.' }, { role: 'user', content: 'Actually return only JSON with ok set to true.' }],
})
assert.doesNotMatch(r.requests[0].messages[0].content, /EXPLICIT ANSWER LENGTH:/)
assert.equal(r.text, '{"ok":true}')
r = await run('quoted example does not become a global length rule', [streamed(event({ content: 'That quoted instruction asks for an essay.' }, 'stop'))], {
  messages: [{ role: 'user', content: 'Critique this prompt: "Write a 500-word essay."' }],
})
assert.doesNotMatch(r.requests[0].messages[0].content, /EXPLICIT ANSWER LENGTH:/)

const split = ': ping\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"狼"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
r = await run('multiline provider SSE', [streamed(split)])
assert.equal(r.text, '狼'); assert.equal(r.error, undefined)

r = await run('native tool completion', [streamed(event({ tool_calls: [nativeTool] }, 'tool_calls') + 'data: [DONE]\n\n')], { tools: [toolSpec] })
assert.equal(r.toolCalls.length, 1); assert.equal(r.error, undefined)
assert.deepEqual(r.requests[0].tools, [toolSpec])

for (const [name, wire] of [
  ['silent EOF', event({ content: 'An incomplete answer with enough text' })],
  ['tool EOF', event({ tool_calls: [nativeTool] }) + 'data: [DONE]\n\n'],
  ['tool length', event({ tool_calls: [nativeTool] }, 'length')],
  ['malformed frame', event({ content: 'An incomplete answer with enough text' }) + 'data: {broken}\n\n' + event({}, 'stop')],
  ['explicit provider failure', event({ content: 'An incomplete answer with enough text' }) + 'data: {"error":{"message":"failed"}}\n\n'],
  ['content filtered', event({ content: 'A refused partial output' }, 'content_filter')],
]) {
  r = await run(name, [streamed(wire)])
  assert.ok(r.error, `${name} must visibly fail`)
  assert.equal(r.toolCalls.length, 0)
  assert.doesNotMatch(r.wire, /event: done/)
  assert.equal(r.requests.length, 1, `${name} must not replay a partial action`)
}

r = await run('reasoning alone recovers', [streamed(event({ reasoning_content: 'Considering the question' }, 'stop')), complete('The actual answer.')])
assert.equal(r.text, 'The actual answer.'); assert.equal(r.error, undefined)

for (const [name, first, recovered] of [
  ['separate to inline reasoning', { reasoning_content: 'Considering' }, '<think>Private fallback analysis.</think>Public recovered answer.'],
  ['unclosed think to plain answer', { content: '<think>Private initial analysis' }, 'Public recovered answer.'],
]) {
  r = await run(name, [streamed(event(first, 'stop')), complete(recovered)])
  assert.equal(r.text, 'Public recovered answer.'); assert.equal(r.error, undefined)
}
r = await run('missing optional deep-think marker', [streamed(event({ content: 'The whole final answer must survive without a marker.' }, 'stop'))], { think: true })
assert.equal(r.text, 'The whole final answer must survive without a marker.'); assert.equal(r.error, undefined)

r = await run('prose continuation completes', [streamed(event({ content: 'First half ' }, 'length')), complete('and the rest.')])
assert.equal(r.text, 'First half and the rest.'); assert.equal(r.error, undefined)
assert.equal(r.requests[1].tools, undefined); assert.equal(r.finishReason, 'stop')
r = await run('continuation shares combined answer budget', [streamed(event({ content: 'First half ' }, 'length')), complete('and the rest.')], {
  messages: [{ role: 'user', content: 'Write a 640-to-880-word memo.' }],
})
assert.equal(r.text, 'First half and the rest.')
assert.match(r.requests[1].messages[0].content, /640–880 words in total/)
assert.match(r.requests[1].messages.at(-1).content, /constraints apply to the combined answer/)
r = await run('continuation inline reasoning stays private', [streamed(event({ content: 'First half ' }, 'length')), complete('<think>Private calculation</think>and the rest.')])
assert.equal(r.text, 'First half and the rest.'); assert.equal(r.error, undefined)

r = await run('prose continuation still truncated', [streamed(event({ content: 'First half ' }, 'length')), complete('unfinished again', 'length')])
assert.match(r.error, /limit/); assert.equal(r.toolCalls.length, 0)

r = await run('fallback refuses missing finish', [new Response('', { status: 503 }), complete('unconfirmed', ''), complete('Confirmed complete.')])
assert.equal(r.text, 'Confirmed complete.'); assert.equal(r.error, undefined)

r = await run('client Stop cancels upstream without retry', [({ res, options }) => new Promise((_resolve, reject) => {
  options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
  res.emit('close')
})])
assert.equal(r.requests.length, 1); assert.doesNotMatch(r.wire, /event: done/)
for (const call of [nativeTool, { ...nativeTool, function: { name: 'lookup_sample', arguments: '{bad' } }]) {
  r = await run('unadvertised or malformed tool', [streamed(event({ tool_calls: [call] }, 'tool_calls'))], { tools: call === nativeTool ? [] : [toolSpec] })
  assert.ok(r.error); assert.equal(r.toolCalls.length, 0)
}

globalThis.__chatFallback = { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'offline', model: 'gemini-2.5-flash' }
try {
  const history = [{ role: 'user', content: 'Read sample.' }, { role: 'assistant', content: null, tool_calls: [nativeTool] }, { role: 'tool', tool_call_id: nativeTool.id, content: 'Known sample value.' }]
  r = await run('Gemini fallback tools and provenance', [new Response('', { status: 400 }), complete('Used the sample value.')], { tools: [toolSpec], messages: history })
  assert.deepEqual(r.requests[1].tools, [toolSpec])
  assert.deepEqual(r.requests[1].messages.slice(1), history)
} finally { delete globalThis.__chatFallback }

const sourceMessages = [{ role: 'user', content: 'Original source: Cedar weighs 12 kg. Keep its name.' }, { role: 'assistant', content: 'Cedar weighs 12 kg.' }, { role: 'user', content: 'Rewrite it as one sentence.' }]
const helpers = []
globalThis.__chatHelper = async (messages, options) => { helpers.push({ messages, options }); return helpers.length === 2 ? 'OK' : 'Cedar weighs 12 kg.' }
try {
  r = await run('refine retains conversation and contract', [], { messages: sourceMessages, think: true, thinkLevel: 2, memory: 'Cedar belongs to the sample project.' })
  assert.equal(r.text, 'Cedar weighs 12 kg.'); assert.equal(r.error, undefined)
  assert.equal(helpers.length, 3)
  for (const helper of helpers) {
    assert.match(JSON.stringify(helper.messages), /Original source: Cedar weighs 12 kg/)
    assert.match(JSON.stringify(helper.messages), /RESPONSE CONTRACT/)
    assert.match(JSON.stringify(helper.messages), /Cedar belongs to the sample project/)
    assert.ok(helper.options.signal instanceof AbortSignal)
    assert.equal(helper.options.maxAttempts, 1)
  }
} finally { delete globalThis.__chatHelper }
const lengthHelpers = []
globalThis.__chatHelper = async (messages, options) => { lengthHelpers.push({ messages, options }); return lengthHelpers.length === 2 ? 'OK' : 'The final fixture.' }
try {
  r = await run('refine preserves explicit answer budget', [], { messages: [{ role: 'user', content: 'Write a 640-to-880-word memo.' }], thinkLevel: 2, maxTokens: 10000 })
  assert.equal(r.text, 'The final fixture.')
  assert.equal(lengthHelpers.length, 3)
  for (const helper of lengthHelpers) assert.match(JSON.stringify(helper.messages), /640–880 words in total/)
  assert.equal(lengthHelpers[0].options.maxTokens, 10000)
  assert.equal(lengthHelpers[2].options.maxTokens, 10000)
} finally { delete globalThis.__chatHelper }
let helpersAfterStop = 0
globalThis.__chatHelper = async () => { helpersAfterStop++; globalThis.__chatClose(); return 'A draft completed as Stop arrived.' }
try {
  r = await run('Stop prevents later refine helpers', [], { messages: sourceMessages, think: true, thinkLevel: 2 })
  assert.equal(helpersAfterStop, 1); assert.doesNotMatch(r.wire, /event: done/)
} finally { delete globalThis.__chatHelper }
globalThis.__chatAccount = {id:'owner@example.test',name:'Owner',profile:''}
globalThis.__accountContextFixture = async (id, messages) => {
  assert.equal(id,'owner@example.test')
  assert.equal(messages.at(-1).content,'What is my saved Juniper budget?')
  return 'ACCOUNT RECORDS: Juniper budget is 42000, from the saved project.'
}
try {
  r = await run('shared account context reaches desktop and web completions', [streamed(event({content:'Your saved Juniper budget is 42000.'},'stop')+'data: [DONE]\n\n')], {messages:[{role:'user',content:'What is my saved Juniper budget?'}],userId:'different@example.test'})
  assert.match(r.requests[0].messages[0].content,/ACCOUNT RECORDS: Juniper budget is 42000/)
  assert.equal(r.error,undefined)
} finally {delete globalThis.__chatAccount;delete globalThis.__accountContextFixture}
console.log('PASS: exact text, provider framing, completion/continuation, decoder recovery, advertised tools and Gemini provenance, deep-think context/contract, Stop through helpers')

// CLI preferences must reach native inference without the prose-only depth and
// marker protocol. Desktop/mobile/web callers keep their existing response path.
for (const setting of [
  {body:{cli:true,reasoning:'high',maxTokens:12000,think:true,thinkLevel:3},effort:'xhigh',tokens:12000},
  {body:{cli:true,reasoning:'none',maxTokens:512},effort:'none',tokens:512},
  {body:{cli:true,reasoning:'medium',maxTokens:8192},effort:'medium',tokens:8192},
  {body:{cli:true},effort:'medium',tokens:4096},
  {body:{reasoning:'high',maxTokens:512},effort:'high',tokens:512},
  {body:{reasoning:'xhigh',maxTokens:8192},effort:'xhigh',tokens:8192},
  {body:{reasoning:'min',maxTokens:512},effort:'minimal',tokens:512},
  {body:{thinkLevel:1,reasoning:'low',maxTokens:4096},effort:'medium',tokens:4096},
  {body:{thinkLevel:2,reasoning:'low',maxTokens:12000},effort:'high',tokens:12000},
  {body:{thinkLevel:3,reasoning:'none',maxTokens:22000},effort:'xhigh',tokens:22000},
]) {
  r = await run('CLI/native reasoning and capacity compatibility', [streamed(event({tool_calls:[nativeTool]},'tool_calls')+'data: [DONE]\n\n')], {tools:[toolSpec],specialist:'code',...setting.body})
  assert.equal(r.error,undefined)
  assert.equal(r.toolCalls.length,1)
  assert.equal(r.requests[0].reasoning_effort,setting.effort)
  assert.equal(r.requests[0].max_tokens,setting.tokens)
  assert.deepEqual(r.requests[0].tools,[toolSpec])
  if(setting.body.cli) assert.doesNotMatch(r.requests[0].messages[0].content,/ANSWER DEPTH — HIGH|\[\[NALU_ANSWER\]\]/)
}
console.log('PASS: CLI native effort, explicit capacity, tool continuation and non-CLI compatibility')

// Image fallback must preserve the actual image bytes and use a compatible
// provider. Text-only fallbacks are never sent an invented visual description.
const imageMessages = [{ role: 'user', content: [{ type: 'text', text: 'Read the exact label in this image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,c2FtcGxl' } }] }]
globalThis.__chatFallback = { base: 'https://text.invalid', key: 'offline', model: 'deepseek-ai/DeepSeek-V3.1', label: 'fallback' }
globalThis.__chatEmergency = { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'offline', model: 'gemini-2.5-flash', label: 'emergency' }
try {
  r = await run('vision keeps inputs on image-capable backup', [new Response('', { status: 503 }), complete('The label reads Sample.')], { messages: imageMessages, specialist: 'vision' })
  assert.equal(r.error, undefined)
  assert.equal(r.requests[1].model, 'gemini-2.5-flash')
  for (const request of r.requests) assert.deepEqual(request.messages.slice(1), imageMessages)
  assert.doesNotMatch(r.requests[0].messages[0].content, /Never hedge with "I cannot see images"/)
  delete globalThis.__chatEmergency
  r = await run('vision unavailable never degrades to text-only', [new Response('', { status: 503 }), new Response('', { status: 400 })], { messages: imageMessages, specialist: 'vision' })
  assert.match(r.error, /image-capable/)
  assert.equal(r.requests.length, 2)
  assert.ok(r.requests.every(request => /inkling/i.test(request.model)))
  assert.doesNotMatch(r.wire, /event: done/)
} finally { delete globalThis.__chatFallback; delete globalThis.__chatEmergency }

// Partial or invalid native calls never leave the server, even if another call
// in the same parallel batch is valid.
for (const [name, calls, finish = 'tool_calls'] of [
  ['missing ID', [{ ...nativeTool, id: undefined }]],
  ['empty arguments', [{ ...nativeTool, function: { name: 'lookup_sample', arguments: '' } }]],
  ['missing required argument', [{ ...nativeTool, function: { name: 'lookup_sample', arguments: '{}' } }]],
  ['wrong argument type', [{ ...nativeTool, function: { name: 'lookup_sample', arguments: '{"query":5}' } }]],
  ['duplicate IDs', [nativeTool, { ...nativeTool, index: 1 }]],
  ['negative tool index', [{ ...nativeTool, index: -1 }]],
  ['wrong finish for tools', [nativeTool], 'stop'],
  ['partial parallel batch', [nativeTool, { ...nativeTool, index: 1, id: 'second', function: { name: 'lookup_sample', arguments: '{"query":' } }]],
]) {
  r = await run(name, [streamed(event({ tool_calls: calls }, finish))], { tools: [toolSpec] })
  assert.ok(r.error, name)
  assert.equal(r.toolCalls.length, 0, name)
  assert.doesNotMatch(r.wire, /event: tool_call_delta/, name)
  assert.doesNotMatch(r.wire, /event: done/, name)
}
r = await run('fragmented parallel calls remain complete', [streamed(
  event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'lookup_', arguments: '{"query":' } }, { index: 1, id: 'b', function: { name: 'lookup_sample', arguments: '{"query":"birch"}' } }] }) +
  event({ tool_calls: [{ index: 0, function: { name: 'sample', arguments: '"cedar"}' } }] }, 'tool_calls'))], { tools: [toolSpec] })
assert.equal(r.error, undefined); assert.equal(r.toolCalls.length, 2)
assert.equal(r.toolCalls[0].function.arguments, '{"query":"cedar"}')
console.log('PASS: image-capable failover, unavailable-image honesty, complete/schema-valid parallel tools and no partial tool events')

const originalTimer = globalThis.setTimeout
let fireDeadline
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms >= 249000 && ms <= 250000) fireDeadline = callback
  return originalTimer(callback, ms, ...args)
}
try {
  r = await run('absolute deadline settles ignored transport abort', [() => { fireDeadline(); return new Promise(() => {}) }])
  assert.match(r.error, /processing deadline/)
  assert.equal(r.requests.length, 1)
  assert.doesNotMatch(r.wire, /event: done/)
} finally { globalThis.setTimeout = originalTimer }

process.env.NALU_CHAT_CONTEXT_TOKENS = '16384'
try {
  const oldCall = { ...nativeTool, id: 'old-result' }
  const history = [
    { role: 'user', content: 'Always keep Project Cedar confidential and answer in French.' },
    { role: 'assistant', content: null, tool_calls: [oldCall] },
    { role: 'tool', tool_call_id: oldCall.id, content: 'Old evidence '.repeat(12000) },
    { role: 'user', content: 'Summarize the current evidence only.' },
    { role: 'assistant', content: null, tool_calls: [nativeTool] },
    { role: 'tool', tool_call_id: nativeTool.id, content: 'Current evidence: Cedar is ready.' },
  ]
  r = await run('token budget preserves instructions and active tool pairs', [streamed(event({ content: 'Cedar est prêt.' }, 'stop'))], { messages: history, maxTokens: 4096, tools: [toolSpec] })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.requests[0].messages.slice(1), [history[0], ...history.slice(3)])
  assert.match(r.requests[0].messages[0].content, /CONTEXT COVERAGE/)
  r = await run('oversize current task fails without truncation', [], { messages: [{ role: 'user', content: 'Exact data '.repeat(15000) }], maxTokens: 4096 })
  assert.match(r.error, /context/)
  assert.equal(r.requests.length, 0)
  assert.doesNotMatch(r.wire, /event: done/)
} finally { delete process.env.NALU_CHAT_CONTEXT_TOKENS }

const refineCapacities = []
globalThis.__chatHelper = async (_messages, options) => { refineCapacities.push(options); return refineCapacities.length === 2 ? 'OK' : 'Complete response.' }
try {
  r = await run('refine honors output capacity and effective effort', [], { thinkLevel: 2, reasoning: 'low', maxTokens: 14000 })
  assert.equal(r.error, undefined)
  assert.deepEqual([refineCapacities[0].maxTokens, refineCapacities[2].maxTokens], [14000, 14000])
  assert.deepEqual([refineCapacities[0].reasoningEffort, refineCapacities[2].reasoningEffort], ['high', 'high'])
} finally { delete globalThis.__chatHelper }
console.log('PASS: whole-request deadline, bounded history with instruction/tool-pair preservation, and full-capacity refinement')
