// Optional live model check on a disposable, synthetic page. No user logins.
import assert from 'node:assert/strict'
import { DeviceRuntime } from './runtime.mjs'
import { startProxy } from '../browser-host/proxy.mjs'
await startProxy()
let calls = 0
const runtime = new DeviceRuntime({ decide: async (_owner, input, signal) => {
  calls++
  const response = await fetch('https://n4lu.com/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, action: 'agentstep' }), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) })
  if (!response.ok) throw Error('Live model HTTP ' + response.status)
  const result = await response.json(); console.log('Synthetic fixture decision:', JSON.stringify(result)); return result
} })
try {
  const owner = 'live-model-fixture-' + Date.now()
  await runtime.request(owner, 'workspace_open')
  const a = runtime.agent(owner)
  await a.page.setContent('<html><head><title>Disposable browser test</title></head><body><h1>Document title test</h1><label>Title <input aria-label="Title"></label><button onclick="document.querySelector(\'p\').textContent=\'Saved title: \'+document.querySelector(\'input\').value">Save</button><p>No changes saved yet.</p></body></html>')
  await runtime.request(owner, 'workspace_run', { task: 'In this disposable test page, replace Title with Local Nalu Verified, click Save, and verify the page says Saved title: Local Nalu Verified. Only work on this page.' })
  const deadline = Date.now() + 150000
  while (a.status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
  assert.equal(a.status, 'done', a.detail || 'Live model timed out')
  assert.equal(await a.page.$eval('p', p => p.textContent), 'Saved title: Local Nalu Verified')
  console.log(`PASS live Nalu AI + real local Chromium: typed, clicked Save, and confirmed saved text (${calls} model steps).`)
} finally { await runtime.disconnect() }
process.exit()
