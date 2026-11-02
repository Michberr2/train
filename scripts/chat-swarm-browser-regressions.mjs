// Real App/chat/planner/controller/device runner/HTTP handler/SQLite store.
// The GPU engine and account transport are fixtures, not model-quality proof.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'
import { localEngineBrowserFixture, enableFixtureLocalAI } from './lib/local-engine-browser-fixture.mjs'
import { swarmDeviceRouteFixture } from './lib/swarm-device-route-fixture.mjs'

const root = fileURLToPath(new URL('../client/', import.meta.url)), output = '/private/tmp/nalu-chat-swarm-browser'
await mkdir(output, { recursive: true })
const api = await swarmDeviceRouteFixture()
const server = await createServer({ root, configFile: root + 'vite.config.ts', plugins: [localEngineBrowserFixture()], cacheDir: output + '/vite-cache', css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [root + 'src/**/*.{ts,tsx}'] })] } }, server: { host: '127.0.0.1', port: 5202, strictPort: true, hmr: false } })
const origin = 'http://127.0.0.1:5202', report = { checks: [], errors: [], requests: [], forbidden: [] }
const plan = { version: 1, unhandledRequests: [], projects: [
  { key: 'acorn', title: 'Acorn Coffee', brief: 'Coffee roaster in Portland.', tasks: [{ key: 'website', kind: 'website', instructions: 'Build a website for Acorn Coffee in Portland.' }] },
  { key: 'harbor', title: 'Harbor Analytics', brief: 'CSV cleaning guide.', tasks: [{ key: 'document', kind: 'document', instructions: 'Write a document about cleaning CSV data before analysis for Harbor Analytics.' }] },
] }
const prompt = 'Use a swarm to build a website for Acorn Coffee in Portland and write a document about cleaning CSV data before analysis for the unrelated Harbor Analytics project.'
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
let browser, page, plannerHold, enqueueHold, backgroundHold = deferred(), plannerCount = 0, delegateCount = 0
const check = message => { report.checks.push(message); console.log('PASS ' + message) }
try {
  await server.listen(); browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(enableFixtureLocalAI)
  await context.addInitScript(() => { if (!localStorage.getItem('nalu-token')) { localStorage.setItem('nalu-token', 'browser-token'); localStorage.setItem('nalu-data-owner', 'browser-owner') } })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== origin) { if (['http:', 'https:'].includes(url.protocol)) { if (!['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) report.forbidden.push(url.origin); return route.abort() } return route.continue() }
    if (url.pathname === '/__fixture-local-model') {
      const request = req.postDataJSON(), system = request.messages[0].content
      if (system.includes("Organize the user's request")) {
        plannerCount++; const hold = plannerHold; if (hold) await hold.promise
        return route.fulfill({ json: { completion: JSON.stringify(plan) } }).catch(() => {})
      }
      // Leave actual claimed background jobs waiting on the synthetic engine,
      // so the test can stop them without inventing completed creations.
      await backgroundHold.promise
      return route.fulfill({ json: { completion: 'Synthetic reply.' } }).catch(() => {})
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const body = req.method() === 'POST' ? req.postDataJSON() || {} : {}
    report.requests.push({ path: url.pathname, action: body.action })
    if (url.pathname === '/api/swarm') {
      if (body.action === 'delegate-work') { delegateCount++; const hold = enqueueHold; if (hold) await hold.promise }
      const response = await api.call(body, req.headers().authorization?.replace(/^Bearer /, ''))
      return route.fulfill({ status: response.code, json: response.body }).catch(() => {})
    }
    if (url.pathname === '/api/auth') return route.fulfill({ json: { ok: true, user: { id: 'browser-owner', displayName: 'Browser check' } } })
    if (url.pathname === '/api/data') return route.fulfill({ json: { ok: true, data: {}, tasks: [], items: [] } })
    if (['/api/chat', '/api/design', '/api/doc', '/api/sheet', '/api/slides'].includes(url.pathname)) { report.forbidden.push(url.pathname); return route.abort() }
    return route.fulfill({ json: { ok: true, rooms: [], connections: [], reviews: [], configured: [], providers: [], items: [], tasks: [], outputs: [], members: [] } })
  })
  page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin)
  const open = page.getByRole('button', { name: 'Open Nalu chat', exact: true })
  await expect(open).toBeVisible({ timeout: 60000 }); await open.click()
  const input = page.locator('.workspace-chat-popover textarea').first()
  await input.fill(prompt); await input.press('Enter')
  const card = page.getByRole('region', { name: 'Delegated agent work' })
  await expect(card).toContainText('Acorn Coffee', { timeout: 60000 })
  await expect(card).toContainText('Harbor Analytics')
  await expect.poll(async () => (await api.store.read('browser-owner')).state.tasks.length).toBe(2)
  await expect(card.locator('[data-task-status]')).toHaveCount(2)
  await expect(input).toBeEnabled()
  const saved = await api.store.read('browser-owner')
  assert.equal(saved.state.projects.length, 2)
  assert.ok(saved.jobs.every(job => job.executionMode === 'device'))
  const originalRequest = saved.state.projects[0].delegation.requestId
  check('one main-chat request creates two real isolated projects/jobs and renders their live statuses without switching to one Studio tool')
  await page.getByRole('button', { name: 'Close work drawer', exact: true }).click()
  await page.screenshot({ path: output + '/01-live-projects.png' })
  await card.getByRole('button', { name: 'Stop these agents', exact: true }).click()
  await expect.poll(async () => (await api.store.read('browser-owner')).jobs.filter(job => ['queued', 'running', 'waiting'].includes(job.status)).length).toBe(0)
  await expect(card.getByText('Stopped', { exact: false }).first()).toBeVisible()
  await page.reload(); await expect(open).toBeVisible(); await open.click()
  await expect(card).toContainText('Acorn Coffee')
  const metadata = await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-chats')).flatMap(chat => chat.messages).find(message => message.delegation)?.delegation)
  assert.equal(metadata.requestId, originalRequest)
  assert.equal(metadata.plan.projects.length, 2)
  check('the exact plan and request identity survive reload; stopping from its chat card cancels the persisted child jobs')
  const plannedBeforeRetry = plannerCount
  await page.getByRole('button', { name: 'Retry', exact: true }).last().click()
  await expect(page.getByText('This delegation was stopped. Send a new request to start new work.', { exact: true })).toBeVisible()
  assert.equal(plannerCount, plannedBeforeRetry, 'Retry uses the saved manifest instead of new inference')
  assert.equal((await api.store.read('browser-owner')).state.tasks.length, 2)
  check('Retry reuses the exact manifest and refuses to restart a stopped batch')

  // A new chat avoids the existing conversation's same-target turn guard.
  const newChat = async () => {
    await page.getByRole('button', { name: 'New conversation or swarm', exact: true }).click()
    await page.getByRole('button', { name: /New conversation\s*Just you and Nalu/ }).click()
  }
  await newChat(); plannerHold = deferred()
  const plannersBefore = plannerCount, delegatesBefore = delegateCount
  await input.fill(prompt + ' Make this a second batch.'); await input.press('Enter')
  await expect.poll(() => plannerCount).toBe(plannersBefore + 1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  plannerHold.resolve(); plannerHold = undefined
  await expect(page.getByText('Stopped before any jobs were scheduled.', { exact: true })).toBeVisible()
  assert.equal(delegateCount, delegatesBefore)
  check('Stop during local planning starts no jobs')

  await newChat(); enqueueHold = deferred()
  await input.fill(prompt + ' Make this a third batch.'); await input.press('Enter')
  await expect.poll(() => delegateCount).toBe(delegatesBefore + 1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await api.store.read('browser-owner')).delegations.filter(command => command.status === 'cancelled').length).toBe(2)
  enqueueHold.resolve(); enqueueHold = undefined
  await expect(page.getByText('Stopped these agents. Any work already finished is saved.', { exact: true })).toBeVisible()
  assert.equal((await api.store.read('browser-owner')).state.tasks.length, 2)
  check('Stop wins while the scheduling request is delayed; releasing that request cannot create late background work')
  assert.deepEqual(report.errors, []); assert.deepEqual(report.forbidden, [])
} finally {
  if (page && !page.isClosed()) { await page.screenshot({ path: output + '/final-state.png' }).catch(() => {}); await writeFile(output + '/page.txt', await page.locator('body').innerText().catch(() => '')) }
  plannerHold?.resolve(); enqueueHold?.resolve(); backgroundHold.resolve()
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2))
  await browser?.close(); await server.close(); api.close?.()
}
