import { build } from 'esbuild'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
const dir = await mkdtemp(path.join(os.tmpdir(), 'nalu-device-native-live-'))
const source = await readFile('api/web.ts', 'utf8')
const decisionSource = source.slice(source.indexOf('type AgentEl ='), source.indexOf('// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport default async function handler'))
assert.ok(decisionSource.includes('async function agentStep'))
await build({ stdin: { contents: `import { browserDecision } from './api/_browserDecision'; ${decisionSource}\nexport {agentStep}; export { DeviceRuntime } from './services/browser-device/runtime.mjs'; export {startProxy} from './services/browser-host/proxy.mjs';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'test.cjs'), bundle: true, platform: 'node', format: 'cjs', nodePaths: [path.resolve('services/browser-host/node_modules')],
  plugins: [{ name: 'native-host', setup(b) { b.onResolve({ filter: /browser-host\/adapter\.mjs$/ }, () => ({ path: path.resolve('services/browser-device/native-host.mjs') })) } }], logLevel: 'warning' })
process.env.BROWSER_DATA_DIR = path.join(dir, 'profiles')
process.env.CHROMIUM_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const { DeviceRuntime, agentStep, startProxy } = createRequire(import.meta.url)(path.join(dir, 'test.cjs'))
const proxy = await startProxy(); let steps = 0
const runtime = new DeviceRuntime({ decide: async (_owner, input) => {
  const decision = await agentStep(input)
  console.log('Synthetic page decision', ++steps, JSON.stringify(decision))
  if (decision.error) throw Error(decision.error)
  return decision
} })
try {
  const owner = 'native-live-test'
  await runtime.request(owner, 'workspace_open')
  const a = runtime.agent(owner)
  await a.page.setContent('<html><head><title>Disposable browser test</title></head><body><h1>Document title</h1><label>Title <input aria-label="Title"></label><button onclick="document.querySelector(\'p\').textContent=\'Saved title: \'+document.querySelector(\'input\').value">Save</button><p>No changes saved yet.</p></body></html>')
  await runtime.request(owner, 'workspace_run', { task: 'On this disposable test page, replace Title with Local Nalu Verified, click Save, and verify the page says Saved title: Local Nalu Verified. Do not leave this page.' })
  const deadline = Date.now() + 240000
  while (a.status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
  assert.equal(a.status, 'done', a.detail || 'Timed out')
  assert.equal(await a.page.$eval('p', p => p.textContent), 'Saved title: Local Nalu Verified')
  await a.page.setContent('<html><body><canvas width="600" height="180"></canvas><label>Code <input aria-label="Code"></label><button onclick="document.querySelector(\'p\').textContent=\'Saved code: \'+document.querySelector(\'input\').value">Save</button><p>Not saved</p></body></html>')
  await a.page.evaluate(() => { const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'); ctx.fillStyle = '#163e73'; ctx.fillRect(0, 0, 600, 180); ctx.fillStyle = '#fff'; ctx.font = 'bold 56px Arial'; ctx.fillText('CORAL 7319', 30, 110) })
  await runtime.request(owner, 'workspace_run', { task: 'Read the code displayed inside the blue rectangle. Enter that exact code in the Code field, click Save, and verify the saved code. Do not leave this page.' })
  const visionDeadline = Date.now() + 240000
  while (a.status === 'running' && Date.now() < visionDeadline) await new Promise(r => setTimeout(r, 250))
  assert.equal(a.status, 'done', a.detail || 'Vision timed out')
  assert.equal(await a.page.$eval('p', p => p.textContent), 'Saved code: CORAL 7319')
  const report = { passed: true, modelSteps: steps, platform: process.platform, runtime: 'native Chrome', verification: 'Saved title and image-only canvas code read back from real DOM' }
  await writeFile(path.join(dir, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log('PASS live Nalu providers + native local Chromium:', JSON.stringify(report))
} finally { await runtime.disconnect(); proxy.close() }
