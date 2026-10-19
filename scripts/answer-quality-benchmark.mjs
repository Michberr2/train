// Explicit opt-in, bounded live evaluation of the current chat handler. Never
// trains, changes serving configuration, writes account data or executes tools.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { build } from 'esbuild'
import { readChatStream } from '../client/src/components/workspace/chatStream.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
const fixturePath = process.env.QUALITY_FIXTURE || 'scripts/fixtures/answer-quality-holdout.json'
const fixtureBytes = await readFile(fixturePath, 'utf8')
const fixture = JSON.parse(fixtureBytes)
const selectedIds = process.env.QUALITY_CASES?.split(',').filter(Boolean)
const cases = fixture.cases.filter(c => !selectedIds || selectedIds.includes(c.id))
assert.ok(cases.length && (!selectedIds || cases.length === selectedIds.length), 'Unknown or empty case selection')
const requestedVariants = process.env.QUALITY_VARIANTS?.split(',').filter(Boolean) || (process.env.QUALITY_VARIANT ? [process.env.QUALITY_VARIANT] : ['inkling-low', 'inkling-high', 'inkling-small-high'])
const variants = [
  { id: 'inkling-low', model: 'thinkingmachines/Inkling', reasoning: 'low' },
  { id: 'inkling-high', model: 'thinkingmachines/Inkling', reasoning: 'high' },
  { id: 'inkling-small-high', model: 'thinkingmachines/Inkling-Small', reasoning: 'high' },
  { id: 'kimi', model: 'moonshotai/Kimi-K2.6:peft:131072', reasoning: 'high' },
  { id: 'glm', model: 'zai-org/GLM-5.3:peft:262144', reasoning: 'high' },
].filter(v => requestedVariants.includes(v.id))
assert.ok(variants.length && variants.length === requestedVariants.length, 'Unknown or duplicate variant')
const maxDollars = Number(process.env.QUALITY_MAX_DOLLARS || 5)
assert.ok(Number.isFinite(maxDollars) && maxDollars > 0 && maxDollars <= 10, 'Explicit small evaluation cap must be at most $10')
const maxCalls = cases.length * variants.length * 3
const output = process.env.QUALITY_OUTPUT || 'reports/nalu-ai-fixes-2026-10-18/answer-quality'
const plan = {
  version: 1, fixtureSha256: hash(fixtureBytes), cases: cases.map(c => ({ id: c.id, category: c.category })),
  variants, maximumReservedDollars: maxDollars, maximumProviderCalls: maxCalls,
  maximumOutputTokensPerCall: 14000, maximumPromptBytes: 80000, maximumCallsPerCase: 3, concurrency: 2,
  scope: 'Current source chat pipeline with synthetic identity/quota, no account memory, no web/tools; forced general route isolates model/effort. This is not a deployed endpoint or full-router test.',
  grading: 'Exact JSON semantics for bounded synthetic tasks. Word count is reported separately from quality. Prose is ungraded pending independent blinded review; no model winner or deployment decision is automatic.',
}
if (!process.argv.includes('--live')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0) }

// Only load the one credential needed. Never populate production database or
// alternate provider configuration in this evaluation process.
let key = process.env.TINKER_API_KEY?.trim()
for (const path of ['.env.local', 'training/.env.local']) if (!key) {
  try { key = parseEnv(await readFile(path, 'utf8')).TINKER_API_KEY?.trim() } catch { /* try next source */ }
}
assert.ok(key, 'Tinker credential unavailable')
for (const name of Object.keys(process.env)) if (/^(?:NALU_.*_(?:MODEL|BASE_URL|API_KEY)|NALU_DEFAULT_MODEL|HUGGINGFACE_API_TOKEN|GEMINI_API_KEY|GOOGLE_AI_API_KEY|GOOGLE_GENAI_API_KEY)$/.test(name)) delete process.env[name]
process.env.TINKER_API_KEY = key
process.env.TINKER_BASE_URL = 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
process.env.NALU_DISABLE_EMERGENCY = '1'
const realFetch = globalThis.fetch
const priceUrl = 'https://tinker-docs.thinkingmachines.ai/tinker/models.json'
const pricesResponse = await realFetch(priceUrl, { signal: AbortSignal.timeout(15000) })
assert.ok(pricesResponse.ok, 'Current official price lookup failed; do not spend on unknown rates')
const priceBytes = await pricesResponse.text()
const prices = JSON.parse(priceBytes)
const rates = new Map(prices.map(p => [p.tinker_id, { input: Number(p.prefill.replace('$', '')), output: Number(p.sample.replace('$', '')) }]))
for (const variant of variants) assert.ok(rates.has(variant.model), `Model absent from current official catalogue: ${variant.model}`)
await mkdir(output, { recursive: true })
await writeFile(`${output}/plan.json`, JSON.stringify({ ...plan, pricesSource: priceUrl, pricesSha256: hash(priceBytes), pricesRetrievedAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
await writeFile(`${output}/pricing.json`, priceBytes)
await writeFile(`${output}/fixture.json`, fixtureBytes, { flag: 'wx' })

const stubs = {
  './_accountContext': 'export async function accountContextForUser() { return "" }',
  './web': 'export async function research() { throw new Error("External research is disabled in this fixed-evidence benchmark") }',
  './_db': 'export async function identityForRequest() { return null }; export function identityBlock() { return "" }; export async function saveProfile() {}; export function normalizePhone(v) { return String(v || "") }',
  './_limits': 'export async function reserveDailyQuota() { return { ok:true, release:async()=>{} } }',
}
const bundle = await build({ entryPoints: ['api/chat.ts'], bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', plugins: [{ name: 'evaluation-account-isolation', setup(b) {
  b.onResolve({ filter: /^\.\/(web|_db|_limits|_accountContext)$/ }, ({ path }) => ({ path, namespace: 'evaluation' }))
  b.onLoad({ filter: /.*/, namespace: 'evaluation' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }))
} }] })
const sourceBindings = {}
for (const source of Object.keys(bundle.metafile.inputs).filter(s => !s.startsWith('evaluation:'))) sourceBindings[source] = hash(await readFile(source))
sourceBindings[fixturePath] = hash(fixtureBytes)
sourceBindings['scripts/answer-quality-benchmark.mjs'] = hash(await readFile('scripts/answer-quality-benchmark.mjs'))
await writeFile(`${output}/pipeline-source.mjs`, bundle.outputFiles[0].text, { flag: 'wx' })
const report = { ...plan, startedAt: new Date().toISOString(), executableSha256: hash(bundle.outputFiles[0].text), sourceBindings, results: [], providerCalls: 0, reservedUpperBoundDollars: 0, limitations: [plan.scope, plan.grading, 'Budget is a conservative token-price reservation, not an invoice; failed/ambiguous calls keep their full reservation.', 'Synthetic holdout was authored for this task; passing it cannot certify broad or specialist expertise.', 'Elapsed times include local orchestration and shared-machine load; they are not controlled production latency measurements.'] }
const context = new AsyncLocalStorage()
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(String(url))
  assert.equal(target.href, process.env.TINKER_BASE_URL + '/chat/completions', 'Only the approved inference endpoint is permitted')
  assert.equal(options.method, 'POST')
  const data = JSON.parse(options.body)
  const rate = rates.get(data.model)
  assert.ok(rate && (variants.some(v => v.model === data.model) || data.model === 'thinkingmachines/Inkling'), 'Unknown model/rate')
  const inputBytes = Buffer.byteLength(JSON.stringify({ messages: data.messages, tools: data.tools }))
  assert.ok(inputBytes <= 80000 && Number.isInteger(data.max_tokens) && data.max_tokens > 0 && data.max_tokens <= 14000, 'Evaluation request exceeds input/output cap')
  // UTF-8 bytes plus template allowance conservatively bound tokenized input.
  const reserve = ((inputBytes + 4096) * rate.input + data.max_tokens * rate.output) / 1e6
  assert.ok(context.getStore()?.calls.length < 3 && report.providerCalls < maxCalls && report.reservedUpperBoundDollars + reserve <= maxDollars, 'Evaluation spending/call cap reached')
  report.providerCalls++; report.reservedUpperBoundDollars += reserve
  const trace = { model: data.model, effort: data.reasoning_effort || 'provider-default', maxTokens: data.max_tokens, promptBytes: inputBytes, promptHash: hash(JSON.stringify(data.messages)), reservedDollars: reserve, startedAt: Date.now() }
  context.getStore()?.calls.push(trace)
  try { const response = await realFetch(url, { ...options, redirect: 'error' }); trace.status = response.status; return response }
  catch (error) { trace.error = error.name; throw error }
}
async function run(handler, variant, sample) {
  const row = { variant: variant.id, id: sample.id, category: sample.category, calls: [], startedAt: Date.now(), answer: '' }
  return context.run(row, async () => {
    const req = new EventEmitter(), res = new EventEmitter()
    req.method = 'POST'; req.headers = {}; req.body = { messages: sample.messages || [{ role: 'user', content: sample.prompt }], specialist: 'general', webSearch: false, reasoning: variant.reasoning, maxTokens: sample.maxTokens || 4096 }
    res.statusCode = 200; res.writableEnded = false; res.setHeader = () => {}; res.flushHeaders = () => {}
    res.status = code => { res.statusCode = code; return res }
    let wire = ''
    res.write = value => { wire += value; if (/event: delta/.test(value)) row.firstTokenMs ??= Date.now() - row.startedAt; return true }
    res.json = value => { throw new Error(`Handler returned HTTP${res.statusCode}: ${JSON.stringify(value).slice(0,200)}`) }
    res.end = () => { res.writableEnded = true; res.emit('finish') }
    const timer = setTimeout(() => { res.emit('close') }, 280000)
    try {
      await handler(req, res)
      assert.ok(res.writableEnded, 'Handler did not complete')
      const result = await readChatStream(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(wire)); c.close() } }), { onRoute: (name,kind) => { row.route = {name,kind} } })
      row.answer = result.text; row.finishReason = result.finishReason
      assert.equal(result.error, undefined); assert.equal(result.toolCalls.length, 0, 'No tools authorized for these tasks')
      assert.equal(result.finishReason, 'stop', 'Incomplete generation')
      if (sample.expected) {
        assert.deepEqual(JSON.parse(result.text.trim()), sample.expected)
        row.correct = true
      } else {
        row.words = result.text.trim().split(/\s+/).filter(Boolean).length
        row.requestedLengthMet = row.words >= sample.rubric.words[0] && row.words <= sample.rubric.words[1]
        row.qualityReview = 'pending-blinded-review'
      }
    } catch (error) { row.correct = false; row.error = String(error.message).slice(0,1000) }
    finally { clearTimeout(timer); res.emit('finish'); row.elapsedMs = Date.now() - row.startedAt }
    report.results.push(row)
    await writeFile(`${output}/${variant.id}-${sample.id}.json`, JSON.stringify(row, null, 2))
    console.log(JSON.stringify({ variant: row.variant, id: row.id, correct: row.correct, words: row.words, requestedLengthMet: row.requestedLengthMet, elapsedMs: row.elapsedMs, calls: row.calls.length, error: row.error }))
    return row
  })
}
try {
  for (const variant of variants) {
    process.env.NALU_DEFAULT_MODEL = variant.model
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}#${variant.id}`
    const { default: handler } = await import(moduleUrl)
    for (let index = 0; index < cases.length; index += 2) {
      await Promise.all(cases.slice(index, index + 2).map(sample => run(handler, variant, sample)))
      await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
      if (report.reservedUpperBoundDollars >= maxDollars) break
    }
  }
} finally {
  globalThis.fetch = realFetch
  report.finishedAt = new Date().toISOString()
  report.completedCases = report.results.length
  report.allRequestedCasesCompleted = report.results.length === cases.length * variants.length
  report.pendingProseReviews = report.results.filter(r => r.qualityReview === 'pending-blinded-review').length
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
}
process.exitCode = report.allRequestedCasesCompleted && report.results.every(r => r.correct !== false && r.requestedLengthMet !== false) ? 0 : 1
