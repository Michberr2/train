import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ stdin: { contents: "export * from './api/_browserDecision.ts'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'providers', setup(b) {
  b.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'providers', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const providerChain=()=>globalThis.browserProviders;' }))
} }] })
const { browserDecision } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const originalFetch = globalThis.fetch
try {
  globalThis.browserProviders = ['primary', 'fallback'].map(label => ({ label, model: label, base: 'https://' + label + '.test', key: 'synthetic-key' }))
  let calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, payload: JSON.parse(opts.body) })
    if (url.includes('primary')) return new Response('', { status: 401 })
    return Response.json({ choices: [{ message: { content: JSON.stringify({ thought: 'Click visible Save', action: { type: 'click', ref: 1 } }) } }] })
  }
  assert.equal(JSON.parse(await browserDecision('system', 'page', 'data:image/png;base64,fixture')).action.ref, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].payload.messages[1].content[1].type, 'image_url')
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'malformed model text' } }], finish_reason: 'stop' })
  assert.equal(await browserDecision('system', 'page', ''), null)
  globalThis.fetch = async () => new Response('', { status: 401 })
  assert.equal(await browserDecision('system', 'page', ''), null)
  globalThis.browserProviders = []
  assert.equal(await browserDecision('system', 'page', ''), null)
  console.log('PASS browser decisions: provider failover with vision, malformed responses rejected, unavailable/missing providers return no action.')
} finally { globalThis.fetch = originalFetch; delete globalThis.browserProviders }
