import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer as httpServer } from 'node:http'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'
import { localEngineBrowserFixture, enableFixtureLocalAI } from './lib/local-engine-browser-fixture.mjs'
import { swarmDeviceRouteFixture } from './lib/swarm-device-route-fixture.mjs'

const root = fileURLToPath(new URL('../client', import.meta.url)), output = '/private/tmp/nalu-local-swarm-browser'
await mkdir(output, { recursive: true })
const api = await swarmDeviceRouteFixture()
const seed = await api.call({ action: 'create', executionMode: 'device', requestId: 'browser-project-01', title: 'Device launch', brief: 'Shared launch fact: review the copy.' })
assert.equal(seed.code, 200)
const projectId = seed.body.projectId
await api.store.mutate('browser-owner', draft => {
  for (const thread of ['Rocky', 'Milo']) draft.state.messages.push({ id: `private-${thread}`, projectId, thread, speaker: 'You', content: `${thread.toUpperCase()}_PRIVATE_CANARY`, createdAt: Date.now() - 1000 })
})
for (const [thread, title, requestId] of [['Rocky', 'Write a concise launch checklist.', 'browser-checklist-01'], ['Milo', 'Create a document about our launch.', 'browser-document-01']]) assert.equal((await api.call({ action: 'add-task', executionMode: 'device', projectId, thread, title, assignee: thread, requestId })).code, 200)
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import useSwarm from'/src/components/workspace/design/useSwarm.ts';import WorkspaceSwarm from'/src/components/workspace-preview/real/WorkspaceSwarm.tsx';import'/src/globals.css';
function App(){const[owner,setOwner]=useState('browser-owner');const swarm=useSwarm({accountId:owner,active:true});return React.createElement('div',{'data-workspace-design':'',className:'nalu-design-review',style:{height:'100dvh',padding:12}},React.createElement('button',{onClick:()=>{localStorage.setItem('nalu-token','other-token');localStorage.setItem('nalu-data-owner','other-owner');setOwner('other-owner');window.dispatchEvent(new Event('nalu-hydrated'))}},'Switch test account'),React.createElement(WorkspaceSwarm,{swarm,navigationKey:0,availableChatIds:[],onOpenChat:()=>{throw Error('Ordinary chat must stay separate')}}))};createRoot(document.getElementById('root')).render(React.createElement(App));`
const vite = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`, css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [`${root}/src/**/*.{ts,tsx}`] })] } }, plugins: [react(), localEngineBrowserFixture(), { name: 'local-swarm-entry', resolveId(id) { if (id === '/@local-swarm') return '\0local-swarm' }, load(id) { if (id === '\0local-swarm') return entry }, configureServer(server) { server.middlewares.use('/__local-swarm', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__local-swarm', '<html><body><div id="root"></div><script type="module" src="/@local-swarm"></script></body></html>')) }) } }], server: { middlewareMode: true, hmr: false } })
const host = httpServer((req, res) => vite.middlewares(req, res))
const report = { passed: false, checks: [], errors: [], forbidden: [], modelRequests: [] }
const check = message => { report.checks.push(message); console.log(`PASS ${message}`) }
let browser, releaseHeld, heldStarted
try {
  await new Promise((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${host.address().port}`
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(enableFixtureLocalAI)
  await context.addInitScript(() => { if (!localStorage.getItem('nalu-token')) { localStorage.setItem('nalu-token', 'browser-token'); localStorage.setItem('nalu-data-owner', 'browser-owner') } })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== origin && !['blob:', 'data:'].includes(url.protocol)) { report.forbidden.push(url.origin); return route.abort() }
    if (url.pathname === '/api/swarm') {
      const response = await api.call(req.postDataJSON(), req.headers().authorization?.replace(/^Bearer /, ''))
      return route.fulfill({ status: response.code, json: response.body }).catch(() => {})
    }
    if (url.pathname === '/__fixture-local-model') {
      const request = req.postDataJSON(), text = JSON.stringify(request.messages)
      report.modelRequests.push({ text })
      if (text.includes('Hold this local reply.')) { heldStarted?.(); await new Promise(resolve => { releaseHeld = resolve }) }
      const system = request.messages[0].content
      let completion
      if (system.includes('independent factual and instruction-following reviewer')) completion = JSON.stringify({ assessment: 'The draft uses only the supplied launch facts.', issues: [], passed: true })
      else if (system.includes('Choose headings, paragraphs')) completion = JSON.stringify({ title: 'Device launch document', subtitle: '', cover: '', blocks: [{ type: 'paragraph', text: 'The local document preserves the shared launch fact: review the copy.' }] })
      else if (system.includes('Select how to carry out the current task')) completion = JSON.stringify({ action: 'write', deliverable: 'A launch checklist', query: '', studioKind: '', dependency: '' })
      else if (system.includes('Review and correct the supplied draft')) completion = JSON.stringify({ status: 'done', content: '- Review the launch copy.\n- Confirm the checklist.', dependency: '' })
      else if (system.includes('Produce the complete requested text deliverable')) completion = '- Review the launch copy.\n- Confirm the checklist.'
      else completion = `${system.match(/You are (Nalu|Rocky|Milo), a collaborator/)?.[1] || 'Nalu'} local reply.`
      return route.fulfill({ json: { completion } }).catch(() => {})
    }
    if (url.pathname.startsWith('/api/')) { report.forbidden.push(url.pathname); return route.abort() }
    return route.continue()
  })
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(`${origin}/__local-swarm`)
  await expect(page.getByRole('heading', { name: 'Device launch', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Chat with Rocky about Device launch' }).click()
  await page.getByRole('textbox', { name: 'Message Rocky', exact: true }).fill('Use our launch facts to write a short reply.')
  await page.getByRole('button', { name: 'Send Swarm message' }).click()
  await expect(page.getByText('Rocky local reply.', { exact: true })).toBeVisible({ timeout: 30000 })
  const replyCall = report.modelRequests[0].text
  assert.match(replyCall, /ROCKY_PRIVATE_CANARY/); assert.doesNotMatch(replyCall, /MILO_PRIVATE_CANARY/)
  check('Real Swarm UI claims a saved reply, runs the local runtime, and commits only its permitted private context')
  const groupStart = report.modelRequests.length
  await page.getByRole('button', { name: 'Group', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message the Swarm group', exact: true }).fill('@Nalu @Milo compare the shared launch fact.')
  await page.getByRole('button', { name: 'Send Swarm message' }).click()
  await expect(page.getByText('Nalu local reply.', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('Milo local reply.', { exact: true })).toBeVisible({ timeout: 30000 })
  assert.equal(report.modelRequests.length - groupStart, 2)
  assert.ok(report.modelRequests.slice(groupStart).every(call => !call.text.includes('PRIVATE_CANARY')))
  check('Mentioned group teammates each generate their own saved local reply without receiving private-branch messages')
  await page.getByRole('button', { name: 'Chat with Rocky about Device launch' }).click()
  await page.getByRole('button', { name: 'Start Write a concise launch checklist.' }).click()
  await expect.poll(async () => (await api.store.read('browser-owner')).state.tasks.find(task => task.title === 'Write a concise launch checklist.').status).toBe('done')
  await expect(page.getByText('Review the launch copy.', { exact: true }).first()).toBeVisible()
  check('Real task planning, writing, review, and saved text artifact finish through the browser executor')
  await page.getByRole('button', { name: 'Chat with Milo about Device launch' }).click()
  await page.getByRole('button', { name: 'Start Create a document about our launch.' }).click()
  await page.getByRole('button', { name: 'Continue Create a document about our launch. in Studio' }).click({ timeout: 30000 })
  await page.getByRole('button', { name: 'View creation', exact: true }).click({ timeout: 30000 })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('The local document preserves the shared launch fact: review the copy.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Word', exact: true })).toBeVisible()
  await page.screenshot({ path: `${output}/local-swarm-document.png` })
  await dialog.getByRole('button', { name: 'Close creation' }).click()
  check('A pinned Studio handoff generates locally, persists the real document, and opens its existing Word export control')
  const held = new Promise(resolve => { heldStarted = resolve })
  await page.getByRole('textbox', { name: 'Message Milo', exact: true }).fill('Hold this local reply.')
  await page.getByRole('button', { name: 'Send Swarm message' }).click()
  await held
  await page.getByRole('button', { name: 'Stop reply', exact: true }).click()
  await expect.poll(async () => (await api.store.read('browser-owner')).jobs.filter(job => job.input === 'Hold this local reply.').map(job => job.status)).toEqual(['cancelled'])
  releaseHeld()
  await expect(page.getByText('Milo local reply.', { exact: true })).toHaveCount(0)
  check('Stop cancels the saved lease and fences a late local model result')
  await page.getByRole('button', { name: 'Switch test account', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Device launch', exact: true })).toHaveCount(0)
  assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_CANARY'))
  assert.deepEqual((await api.store.read('other-owner')).state.messages, [])
  assert.equal(api.state.cloud, 0); assert.equal(api.state.quota, 0)
  assert.ok(api.state.calls.every(call => call.executionMode === 'device'))
  assert.ok(report.modelRequests.every(call => !/leaseToken|browser-token|deviceReceipt/.test(call.text)), 'Model prompts never include transport credentials')
  assert.deepEqual(report.forbidden, []); assert.deepEqual(report.errors, [])
  check('Account switching preserves isolation; no cloud worker, quota reservation, or ordinary model API was used')
  report.passed = true
} finally {
  releaseHeld?.(); await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser?.close(); await new Promise(resolve => host.close(resolve)); await vite.close(); api.close()
}
