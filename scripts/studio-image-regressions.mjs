// Real private-image HTTP handler, storage/lease SQL and provider renderer with
// controlled in-memory PostgreSQL/provider boundaries. No live services.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import sharp from 'sharp'
const require = createRequire(import.meta.url)
const originalFetch = globalThis.fetch
const originals = Object.fromEntries(['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'NALU_IMAGE_GEMINI_MODELS', 'NALU_IMAGE_BASE_URL', 'NALU_IMAGE_API_KEY', 'ZAI_BASE_URL', 'ZAI_API_KEY', 'TINKER_API_KEY', 'NALU_USER_STUDIO_IMAGE_PER_DAY'].map(key => [key, process.env[key]]))
for (const key of Object.keys(originals)) delete process.env[key]
const png = await sharp({ create: { width: 12, height: 8, channels: 4, background: { r: 30, g: 100, b: 70, alpha: .8 } } }).png().toBuffer()

const compiled = await build({
  stdin: { contents: "export * from './api/_studioImages'; export * from './api/_imageGeneration'; export { default as handler } from './api/studio-image'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'offline-boundaries', setup(build) {
    build.onResolve({ filter: /^\.\/_db$/ }, () => ({ path: 'db', namespace: 'fixture' }))
    build.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    build.onResolve({ filter: /^node:dns\/promises$/ }, () => ({ path: 'dns', namespace: 'fixture' }))
    build.onResolve({ filter: /^node:https$/ }, () => ({ path: 'https', namespace: 'fixture' }))
    // Only the handler generation boundary is mocked; storage normalization and
    // the provider implementation below remain the actual application modules.
    build.onResolve({ filter: /^\.\/_imageGeneration$/ }, args => args.importer.endsWith('/studio-image.ts') ? { path: 'generate', namespace: 'fixture' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: {
      db: `export const normalizePhone=value=> typeof value === 'string' && /^\\+[1-9]\\d{7,14}$/.test(value) ? value : null; export const getClient=()=>globalThis.__imageDatabase.client(); export const readToken=r=>(r.headers.authorization||'').replace(/^Bearer /,'')||null; export const userIdForToken=async(c,t)=>(await c.query('SELECT user_id FROM nalu_sessions WHERE token=$1',[t])).rows[0]?.user_id||null;`,
      llm: `export const chatComplete=(...a)=>globalThis.__imageModel(...a);`,
      dns: `export const lookup=(...a)=>globalThis.__imageDns(...a);`,
      https: `export const request=(...a)=>globalThis.__imageHttps(...a);`,
      generate: `export const generateImage=(...a)=>globalThis.__imageGenerate(...a);`,
    }[path] }))
  } }],
})
const module = new Module(`${process.cwd()}/scripts/.studio-image-fixture.cjs`)
module.filename = `${process.cwd()}/scripts/.studio-image-fixture.cjs`
module.paths = Module._nodeModulePaths(process.cwd())
module._compile(compiled.outputFiles[0].text, module.filename)
const server = module.exports

function database() {
  const state = { images: new Map(), usage: new Map() }
  let lock = Promise.resolve()
  const db = { state, connections: 0, transactions: 0, today: '2026-09-07', beforeQuery: null,
    client() {
      let transaction = null, unlock
      const current = () => transaction || state
      return {
        async connect() { db.connections++ }, async end() {},
        async query(sql, params = []) {
          await db.beforeQuery?.(sql, params)
          const q = sql.trim(), data = current()
          if (q.startsWith('CREATE TABLE')) return { rows: [] }
          if (q === 'BEGIN') {
            const previous = lock; lock = new Promise(resolve => { unlock = resolve }); await previous
            transaction = structuredClone(state); db.transactions++; return { rows: [] }
          }
          if (q === 'COMMIT' || q === 'ROLLBACK') {
            if (transaction) { if (q === 'COMMIT') { state.images = transaction.images; state.usage = transaction.usage }; transaction = null; db.transactions--; unlock() }
            return { rows: [] }
          }
          if (q.includes('FROM nalu_sessions')) return { rows: params[0] === 'owner' ? [{ user_id: 'account-a' }] : params[0] === 'other' ? [{ user_id: 'account-b' }] : [] }
          if (q.startsWith('SELECT * FROM nalu_studio_images')) { const row = data.images.get(params[1]); return { rows: row?.user_id === params[0] ? [structuredClone(row)] : [] } }
          if (q.startsWith('INSERT INTO nalu_studio_images')) {
            const old = data.images.get(params[0])
            if (old && (old.user_id !== params[1] || old.status === 'ready' || old.status === 'pending' && new Date(old.lease_until).getTime() > Date.now())) return { rows: [] }
            data.images.set(params[0], { ...(old || {}), id: params[0], user_id: params[1], request_key: params[2], request: JSON.parse(params[3]), status: 'pending', lease_id: params[4], lease_until: new Date(Date.now() + params[5] * 1000) })
            return { rows: [{ id: params[0] }] }
          }
          if (q.startsWith('INSERT INTO nalu_usage')) {
            const key = `${params[0]}|${db.today}`, count = data.usage.get(key) || 0
            if (count >= params[1]) return { rows: [] }
            data.usage.set(key, count + 1); return { rows: [{ quota_day: db.today }] }
          }
          if (q.startsWith('UPDATE nalu_studio_images SET quota_day')) { data.images.get(params[1]).quota_day = params[2]; return { rows: [] } }
          if (q.startsWith("UPDATE nalu_studio_images SET status='ready'")) {
            const row = data.images.get(params[1])
            if (row?.user_id !== params[0] || row.lease_id !== params[2] || row.status !== 'pending' || new Date(row.lease_until).getTime() <= Date.now()) return { rows: [] }
            Object.assign(row, { status: 'ready', bytes: Buffer.from(params[3]), mime_type: params[4], width: params[5], height: params[6], lease_id: null, lease_until: null })
            return { rows: [structuredClone(row)] }
          }
          if (q.startsWith("UPDATE nalu_studio_images SET status='failed'")) {
            const row = data.images.get(params[1])
            if (row?.user_id !== params[0] || row.lease_id !== params[2] || row.status !== 'pending') return { rows: [] }
            Object.assign(row, { status: 'failed', lease_id: null, lease_until: null }); return { rows: [{ quota_day: row.quota_day }] }
          }
          if (q.startsWith('UPDATE nalu_usage SET count=GREATEST')) {
            const key = `${params[0]}|${params[1]}`; data.usage.set(key, Math.max(0, (data.usage.get(key) || 0) - 1)); return { rows: [] }
          }
          throw new Error(`Unimplemented fixture SQL: ${q}`)
        },
      }
    },
  }
  return db
}
async function request(body = {}, options = {}) {
  const response = { code: 200, headers: {}, body: null, status(code) { this.code = code; return this }, setHeader(key, value) { this.headers[key.toLowerCase()] = String(value) }, json(body) { this.body = body; return this }, end() { return this } }
  await server.handler({ method: options.method || 'POST', headers: options.token === null ? {} : { authorization: `Bearer ${options.token || 'owner'}` }, query: options.id ? { id: options.id } : {}, body }, response)
  return response
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

try {
  globalThis.fetch = async () => { throw new Error('Unexpected network request') }
  globalThis.__imageDns = async () => { throw new Error('Unexpected DNS request') }
  globalThis.__imageHttps = () => { throw new Error('Unexpected HTTPS request') }
  globalThis.__imageModel = () => { throw new Error('Unexpected language-model request') }
  const image = await server.normalizeGeneratedImage(png, 1600, 900)
  assert.equal(image.width, 12); assert.equal(image.height, 8); assert.equal(image.mimeType, 'image/png')
  assert.ok((await sharp(image.bytes).metadata()).hasAlpha, 'transparent imagery must stay transparent')
  await assert.rejects(server.normalizeGeneratedImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"/>'), 128, 128), /raster/)
  await assert.rejects(server.normalizeGeneratedImage(Buffer.alloc(17 * 1024 * 1024), 128, 128), /size/)

  const db = database(); globalThis.__imageDatabase = db
  let calls = 0
  globalThis.__imageGenerate = async () => { calls++; assert.equal(db.transactions, 0, 'no transaction may remain open across a provider call'); return image }
  const body = { action: 'generate', prompt: 'A precise editorial illustration — not a photograph.', size: '1600x900' }
  assert.equal((await request({ ...body, token: 'owner' }, { token: null })).code, 401, 'body tokens cannot authorize private media')
  assert.equal(db.connections, 0, 'missing auth fails before storage')
  assert.equal((await request(body, { token: 'invalid' })).code, 401)
  assert.equal((await request({ ...body, action: 'lookup' })).code, 404)
  assert.equal((await request({ ...body, action: 'other' })).code, 400)
  assert.equal((await request({ ...body, size: '999999x999999' })).code, 400)
  assert.equal((await request('null')).code, 400)
  assert.equal(calls, 0)

  const began = deferred(), release = deferred()
  globalThis.__imageGenerate = async (...args) => { calls++; assert.equal(db.transactions, 0); assert.equal(args[0], body.prompt); assert.equal(args[3].enrich, false); began.resolve(); await release.promise; return image }
  const loading = request(body)
  await began.promise
  const pending = await request(body)
  assert.equal(pending.code, 202); assert.equal(pending.body.retryAfter, 3)
  assert.equal((await request({ ...body, action: 'lookup' })).code, 202)
  assert.equal(calls, 1, 'simultaneous generate/lookup cannot start another paid request')
  release.resolve()
  const saved = await loading
  assert.equal(saved.code, 200); assert.equal(db.state.images.get(saved.body.id).status, 'ready')
  assert.equal(saved.body.url, server.imageDataUrl(image)); assert.equal(saved.headers['cache-control'], 'private, no-store')
  for (const result of [await request({}, { method: 'GET', id: saved.body.id }), await request({ ...body, action: 'lookup' }), await request(body)]) assert.deepEqual(result.body, saved.body, 'reload, export and repeated generate must reuse exact saved bytes')
  assert.equal(calls, 1); assert.equal(db.state.usage.get('user:account-a|2026-09-07'), 1)
  assert.equal((await request({}, { method: 'GET', id: saved.body.id, token: 'other' })).code, 404)
  assert.equal((await request({ ...body, action: 'lookup' }, { token: 'other' })).code, 404)
  assert.notEqual(server.studioImageRequest('account-b', body).id, saved.body.id)
  console.log('PASS: auth first, owner isolation, explicit generation, concurrent lease, durable exact-byte reload, no duplicate billing or transaction held across generation')

  globalThis.__imageGenerate = async () => { calls++; throw new Error('Provider refused') }
  assert.equal((await request({ ...body, variation: 'failed' })).code, 502)
  assert.equal(db.state.usage.get('user:account-a|2026-09-07'), 1, 'failed generation refunded')
  const failedCalls = calls
  assert.equal((await request({ ...body, variation: 'failed', action: 'lookup' })).code, 404)
  assert.equal(calls, failedCalls, 'lookup cannot retry failed work')
  globalThis.__imageGenerate = async () => { calls++; return image }
  assert.equal((await request({ ...body, variation: 'failed' })).code, 200)
  assert.equal(db.state.usage.get('user:account-a|2026-09-07'), 2)
  process.env.NALU_USER_STUDIO_IMAGE_PER_DAY = '2'
  assert.equal((await request({ ...body, variation: 'over-quota' })).code, 429)
  assert.equal((await request(body)).code, 200, 'quota exhaustion cannot hide existing images')
  assert.equal(db.state.images.has(server.studioImageRequest('account-a', { ...body, variation: 'over-quota' }).id), false, 'quota rejection rolls back lease claim')
  delete process.env.NALU_USER_STUDIO_IMAGE_PER_DAY

  const staleRequest = server.studioImageRequest('account-a', { ...body, variation: 'expired' })
  const client = db.client(); await client.connect()
  const oldClaim = await server.claimStudioImage(client, 'account-a', staleRequest)
  db.state.images.get(staleRequest.id).lease_until = new Date(Date.now() - 1000)
  assert.equal((await request({ ...body, variation: 'expired', action: 'lookup' })).code, 404)
  const completed = await request({ ...body, variation: 'expired' })
  assert.equal(completed.code, 200)
  const beforeRefund = db.state.usage.get('user:account-a|2026-09-07')
  await server.failStudioImage(client, 'account-a', staleRequest.id, oldClaim.leaseId)
  assert.equal(db.state.usage.get('user:account-a|2026-09-07'), beforeRefund, 'stale worker cannot refund a replacement request')
  const prior = await server.completeStudioImage(client, 'account-a', staleRequest.id, oldClaim.leaseId, { ...image, bytes: Buffer.from('different') })
  assert.equal(server.studioImageResult(prior).url, completed.body.url, 'late workers cannot replace committed bytes')
  const midnightRequest = server.studioImageRequest('account-a', { ...body, variation: 'midnight-failure' })
  const midnight = await server.claimStudioImage(client, 'account-a', midnightRequest)
  const reservedCount = db.state.usage.get('user:account-a|2026-09-07')
  db.today = '2026-09-08'
  await server.failStudioImage(client, 'account-a', midnightRequest.id, midnight.leaseId)
  await server.failStudioImage(client, 'account-a', midnightRequest.id, midnight.leaseId)
  assert.equal(db.state.usage.get('user:account-a|2026-09-07'), reservedCount - 1, 'refund once against the actual reservation day')
  assert.equal(db.state.usage.has('user:account-a|2026-09-08'), false)
  const failedSave = { ...body, variation: 'storage-failure' }
  let saveFailed = false
  db.beforeQuery = async (sql) => { if (!saveFailed && sql.startsWith("UPDATE nalu_studio_images SET status='ready'")) { saveFailed = true; throw new Error('Temporary storage failure') } }
  assert.equal((await request(failedSave)).code, 502, 'must not claim success before bytes are stored')
  assert.equal(db.state.images.get(server.studioImageRequest('account-a', failedSave).id).status, 'failed')
  assert.equal(db.state.usage.get('user:account-a|2026-09-08'), 0)
  db.beforeQuery = null
  const ambiguousSave = { ...body, variation: 'lost-response-after-commit' }
  const originalRead = db.client
  db.client = () => {
    const client = originalRead(), originalQuery = client.query
    client.query = async (...args) => {
      const result = await originalQuery(...args)
      if (args[0].startsWith("UPDATE nalu_studio_images SET status='ready'")) throw new Error('Connection lost after commit')
      return result
    }
    return client
  }
  assert.equal((await request(ambiguousSave)).code, 502)
  db.client = originalRead
  const beforeRecovery = calls
  assert.equal((await request(ambiguousSave)).code, 200)
  assert.equal(calls, beforeRecovery, 'committed bytes survive a lost response without another paid generation')
  console.log('PASS: failure refunds, no read-triggered retry, daily quota, expired-lease explicit recovery, stale-worker isolation, midnight/idempotent refund')

  // Real provider implementation with mocked transport; model IDs and prompt
  // remain as configured, while complete bodies and image bytes are validated.
  process.env.GEMINI_API_KEY = 'fixture-only'; process.env.NALU_IMAGE_GEMINI_MODELS = 'first-fixture,second-fixture'
  const prompts = [], models = []
  globalThis.fetch = async (url, options) => {
    models.push(String(url).split('/models/')[1].split(':')[0]); prompts.push(JSON.parse(options.body).contents[0].parts[0].text)
    if (models.length === 1) return new Response('unavailable', { status: 503 })
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] })
  }
  assert.equal(server.imageDataUrl(await server.generateImage(body.prompt, 1600, 900, { enrich: false })), server.imageDataUrl(image))
  assert.deepEqual(models, ['first-fixture', 'second-fixture']); assert.deepEqual(prompts, [body.prompt, body.prompt])

  let abortedBody = false, requestCount = 0
  globalThis.fetch = async (_url, options) => {
    requestCount++
    return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => { abortedBody = true; controller.error(new Error('aborted body')) }, { once: true }) } }), { headers: { 'content-type': 'application/json' } })
  }
  const start = Date.now()
  await assert.rejects(server.generateImage('Delayed complete body', 128, 128, { enrich: false, timeoutMs: 30 }), /timed out/)
  assert.ok(abortedBody && Date.now() - start < 1000); assert.equal(requestCount, 1, 'whole deadline must stop fallback calls as well as body reads')

  delete process.env.GEMINI_API_KEY
  process.env.NALU_IMAGE_BASE_URL = 'https://configured.fixture/v1'; process.env.NALU_IMAGE_API_KEY = 'fixture-only'
  globalThis.fetch = async () => Response.json({ data: [{ url: 'https://provider-image.fixture/image.png' }] })
  globalThis.__imageDns = async () => [{ address: '127.0.0.1', family: 4 }]
  let httpsCalls = 0
  globalThis.__imageHttps = () => { httpsCalls++; throw new Error('Must not fetch private addresses') }
  await assert.rejects(server.generateImage('Private address fixture', 128, 128, { enrich: false }), /could not produce/)
  assert.equal(httpsCalls, 0)
  globalThis.__imageDns = async () => new Promise(() => {})
  const dnsStart = Date.now()
  await assert.rejects(server.generateImage('Delayed DNS fixture', 128, 128, { enrich: false, timeoutMs: 30 }), /timed out/)
  assert.ok(Date.now() - dnsStart < 1000, 'the total deadline also bounds DNS resolution')
  globalThis.__imageDns = async () => [{ address: '8.8.8.8', family: 4 }]
  globalThis.__imageHttps = (_url, options, callback) => {
    httpsCalls++
    options.lookup('provider-image.fixture', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]) })
    const emitter = new EventEmitter()
    emitter.end = () => { const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'image/png' }; callback(response); queueMicrotask(() => response.end(png)) }
    return emitter
  }
  assert.equal((await server.generateImage('Pinned provider bytes', 128, 128, { enrich: false })).mimeType, 'image/png')
  assert.equal(httpsCalls, 1)
  console.log('PASS: actual raster validation/transparency, configured model order, unchanged art direction, total body deadline, private-address rejection and DNS-pinned provider download')
} finally {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originals)) if (value == null) delete process.env[key]; else process.env[key] = value
  for (const key of ['__imageDatabase', '__imageGenerate', '__imageDns', '__imageHttps', '__imageModel']) delete globalThis[key]
}
