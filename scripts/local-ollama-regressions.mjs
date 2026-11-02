import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Real local runtime/queue/SSE/protocol with a recording companion transport.
// These are integration checks, not evidence of CPU/GPU model quality.
const directory = await mkdtemp(join(tmpdir(), 'nalu-ollama-test-'))
const output = join(directory, 'runtime.mjs')
const bundle = await build({ stdin: { contents: ["export * from './client/src/lib/localAI'", "export * from './client/src/lib/localOllama'", "export * from './client/src/lib/localOllamaSetup'", "export * from './client/src/components/workspace/chatStream'"].join(';'), resolveDir: process.cwd() }, outfile: output, bundle: true, format: 'esm', platform: 'browser', write: true,
  plugins: [{ name: 'forbid-browser-engine', setup(builder) { builder.onResolve({ filter: /^@mlc-ai\/web-llm$/ }, () => ({ path: 'browser-engine', namespace: 'forbidden' })); builder.onLoad({ filter: /.*/, namespace: 'forbidden' }, () => ({ contents: 'throw Error("Browser engine must not load for the companion");' })) } }] })
globalThis.window = new EventTarget(); window.isSecureContext = true
const storage = new Map([['nalu-token', 'ACCOUNT_TOKEN_MUST_STAY_HERE']])
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} })
globalThis.Worker = class { constructor() { throw Error('No GPU worker allowed in companion mode') } }
const originalFetch = globalThis.fetch, requests = []
const models = ['qwen3.5:2b', 'qwen3.5:4b', 'qwen2.5-coder:3b', 'qwen3.5:0.8b', 'qwen3.5:0.8b-q8_0']
let cloudDisabled = true, statusCode = 200, missing = '', remote = false, showRemote = false, mlx = false, completion = 'Café 🐺', finish = 'stop', unfinished = false, responseRemote = false, hold = false, release, activeSignal
const tick = () => new Promise(resolve => setImmediate(resolve))
const json = value => Response.json(value)
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined
  assert.equal(new URL(url).origin, 'http://127.0.0.1:11434'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.referrerPolicy, 'no-referrer')
  assert.ok(!new Headers(init.headers).has('Authorization')); assert.ok(!JSON.stringify({ url, body, headers: init.headers }).includes('ACCOUNT_TOKEN_MUST_STAY_HERE'))
  requests.push({ path, body, signal: init.signal })
  if (path === '/api/status') return statusCode === 200 ? json({ cloud: { disabled: cloudDisabled } }) : new Response('', { status: statusCode })
  if (path === '/api/tags') return json({ models: models.filter(name => name !== missing).map(name => ({ name, size: 1024, digest: 'a'.repeat(64), ...(remote ? { remote_host: 'https://ollama.com' } : {}) })) })
  if (path === '/api/show') return json({ details: mlx ? { format: 'safetensors', runner: 'mlx' } : { format: 'gguf' }, capabilities: ['completion'], ...(showRemote ? { remote_model: 'remote-model' } : {}) })
  assert.equal(path, '/api/chat'); assert.equal(body.keep_alive, 0); assert.equal(body.options.num_ctx, 8192)
  activeSignal = init.signal
  let controller
  const stream = new ReadableStream({ start(value) {
    controller = value
    const emit = () => {
      if (init.signal.aborted) return
      const frame = { model: body.model, message: { role: 'assistant', content: completion, thinking: 'PRIVATE_REASONING' }, done: !unfinished, ...(!unfinished ? { done_reason: finish } : {}), ...(responseRemote ? { remote_host: 'https://ollama.com' } : {}) }
      const bytes = new TextEncoder().encode(JSON.stringify(frame) + '\n')
      for (let offset = 0; offset < bytes.length; offset += 3) value.enqueue(bytes.slice(offset, offset + 3))
      value.close()
    }
    init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Cancelled', 'AbortError')) } catch {} }, { once: true })
    if (hold) release = emit; else emit()
  } })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
}
const local = await import(pathToFileURL(output).href)
const answer = (text = 'Say hello', extra = {}, signal) => local.readChatStream(local.requestLocalChat({ messages: [{ role: 'user', content: text }], ...extra }, signal).body, { signal })
const chats = () => requests.filter(request => request.path === '/api/chat')
const check = text => console.log('PASS ' + text)
try {
  local.setLocalPreferences({ enabled: true, profile: 'balanced', provider: 'ollama' })
  await local.prepareLocalCrew()
  assert.equal(chats().length, 0)
  assert.deepEqual(requests.filter(request => request.path === '/api/show').map(request => request.body.model), models.slice(0, 3))
  assert.equal(local.getLocalAIState().phase, 'ready')
  check('The companion verifies local-only mode and all three installed models without downloading, generating, accessing WebGPU, or forwarding account credentials')
  for (const [role, model] of Object.entries(local.OLLAMA_MODELS)) {
    assert.equal((await answer('Say hello', { localRole: role })).text, 'Café 🐺')
    assert.equal(chats().at(-1).body.model, model)
  }
  assert.equal(chats().find(request => request.body.model === 'qwen2.5-coder:3b').body.think, undefined)
  assert.equal(chats().at(-1).body.think, true)
  check('Four roles use the selected small models and stream split UTF-8 through the real Nalu SSE adapter without exposing private thinking')
  const tool = { type: 'function', function: { name: 'sum', parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false } } }
  completion = JSON.stringify({ message: 'Adding it.', actions: [{ name: 'sum', arguments: { a: 2 } }] })
  const action = await answer('Add two', { tools: [tool] })
  assert.equal(action.toolCalls[0].function.name, 'sum'); assert.ok(chats().at(-1).body.format)
  completion = JSON.stringify({ message: 'Do something else.', actions: [{ name: 'unapproved', arguments: {} }] })
  assert.match((await answer('Add two', { tools: [tool] })).error, /invalid action|Invalid local action/i)
  check('The companion uses the same allowlisted, schema-checked action protocol; unapproved actions do not execute')
  completion = 'Café 🐺'
  const before = chats().length
  cloudDisabled = false; assert.match((await answer()).error, /Turn off Ollama cloud/)
  cloudDisabled = true; statusCode = 404; assert.match((await answer()).error, /Update Ollama/)
  statusCode = 200; missing = 'qwen3.5:2b'; assert.match((await answer()).error, /Install qwen3.5:2b/)
  missing = ''; remote = true; assert.match((await answer()).error, /not a verified model/)
  remote = false; showRemote = true; assert.match((await answer()).error, /cannot be verified/)
  showRemote = false; assert.equal(chats().length, before)
  check('Cloud-enabled, unsupported, missing, remote catalogue and remote model configurations fail before any prompt is sent')
  responseRemote = true; const rejected = await answer(); assert.equal(rejected.text, ''); assert.match(rejected.error, /remote model/)
  responseRemote = false; unfinished = true; assert.match((await answer()).error, /disconnected before finishing/)
  unfinished = false; finish = 'length'; assert.equal((await answer()).finishReason, 'length'); finish = 'stop'
  check('Remote response frames and incomplete streams cannot claim success; real truncation remains explicit')
  hold = true
  const stop = new AbortController(), cancelled = answer('Hold this reply', {}, stop.signal).catch(error => ({ error: error.message }))
  while (!release) await tick()
  const oldSignal = activeSignal, survivor = answer('A separate queued request')
  hold = false; stop.abort(); await cancelled; assert.equal(oldSignal.aborted, true)
  assert.equal((await survivor).text, 'Café 🐺')
  check('Stopping one active companion request aborts its HTTP generation and preserves an independently queued peer')
  release = undefined; hold = true
  const stale = answer('Old account reply'); while (!release) await tick()
  storage.set('nalu-token', 'NEW_ACCOUNT'); local.resetLocalAI(); hold = false; assert.equal((await stale).text, '')
  assert.equal((await answer('New account reply')).text, 'Café 🐺')
  check('Account changes fence stale companion output and leave the next account’s local request usable')
  local.setLocalPreferences({ enabled: true, profile: 'compact', provider: 'ollama', cpuOnly: true })
  await answer(); assert.equal(chats().at(-1).body.model, 'qwen3.5:0.8b-q8_0'); assert.equal(chats().at(-1).body.options.num_gpu, 0)
  const cpuRequests = chats().length
  mlx = true; assert.match((await answer()).error, /cannot guarantee CPU-only/); assert.equal(chats().length, cpuRequests)
  local.setLocalPreferences({ enabled: true, profile: 'compact', provider: 'ollama' })
  assert.equal((await answer()).text, 'Café 🐺'); assert.equal(chats().at(-1).body.options.num_gpu, undefined)
  mlx = false
  assert.deepEqual(local.ollamaCrewModels('balanced', true), ['qwen3.5:2b-q4_K_M', 'qwen3.5:4b-q4_K_M', 'qwen2.5-coder:3b'])
  assert.match(local.ollamaSetup('compact', 'unix', 'https://n4lu.ai', true).pull, /0\.8b-q8_0/)
  check('CPU mode selects GGUF variants and refuses an MLX runner before prompting; automatic mode supports locally installed MLX models')
  const setup = local.ollamaSetup('balanced', 'unix', 'http://127.0.0.1:5182')
  assert.match(setup.start, /OLLAMA_NO_CLOUD=1/); assert.match(setup.start, /OLLAMA_HOST=127\.0\.0\.1:11434/)
  assert.match(setup.start, /http:\/\/127\.0\.0\.1:5182/); assert.equal(setup.pull.split('\n').length, 3)
  assert.doesNotMatch(local.ollamaSetup('compact', 'windows', 'https://evil.example').start, /evil|0\.0\.0\.0|\*/)
  check('Compact routing and setup instructions use only the selected models, known Nalu origins, and a loopback-only server')
} finally { local.resetLocalAI(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }) }
