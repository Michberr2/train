// Real application, account lifecycle and stream decoder; isolated transport only.
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { localEngineBrowserFixture, enableFixtureLocalAI } from './lib/local-engine-browser-fixture.mjs'
let base = process.env.GENERATIVE_TEST_URL, server
if (!base) {
 const root = fileURLToPath(new URL('../client/', import.meta.url))
 process.chdir(root)
 server = await createServer({ root, configFile: root + 'vite.config.ts', plugins: [localEngineBrowserFixture()], cacheDir: '/tmp/nalu-generative-browser-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
 await server.listen()
 base = `http://127.0.0.1:${server.httpServer.address().port}`
}
const output = '/tmp/nalu-generative-browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const calls = [], errors = [], remote = []
const blockA = { id: 'returns', type: 'calculator', title: 'Editable returns', width: 'half', fields: [{ id: 'price', label: 'Purchase price', type: 'number', value: '400000' }, { id: 'noi', label: 'Annual NOI', type: 'number', value: '24000' }], calculations: [{ label: 'Cap rate', formula: 'noi/price', format: 'percent' }] }
const blockB = { id: 'tasks', type: 'checklist', title: 'Due diligence', width: 'half', items: [{ id: 'leases', label: 'Verify leases' }, { id: 'expenses', label: 'Verify expenses' }] }
const blockC = { id: 'comparison', type: 'table', title: 'Comparison', width: 'full', columns: ['Property','Price'], rows: [['B','$500000'],['A','$400000']] }
const layouts = { initial: { title: 'Your property workspace', description: 'Based on your supplied figures.', blocks: [blockA, blockB, blockC] }, update: { title: 'Updated property workspace', blocks: [blockA, blockB, blockC, { id: 'action', type: 'form', title: 'Next step', width: 'full', fields: [{ id: 'note', label: 'Your instructions', type: 'text' }], actions: [{ label: 'Continue with Nalu', prompt: 'Use these instructions for the next step.' }] }] } }
await context.addInitScript(enableFixtureLocalAI)
await context.addInitScript(() => { window.__uiCalls = [] })
await context.route('**/*', async route => {
 const request = route.request(), url = new URL(request.url())
 if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7QAAAABJRU5ErkJggg==', 'base64') })
 if (url.origin === 'http://127.0.0.1:8834' && /health/.test(url.pathname)) return route.fulfill({ status: 503, json: { error: 'Local GPU fixture is offline.' } })
 if (url.origin !== base && !['data:', 'blob:'].includes(url.protocol)) { if (url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com') remote.push(url.origin); return route.abort() }
 if (url.pathname === '/__nalu_local_entry') return route.fulfill({ json: { ok: true, token: 'isolated-generative-test', user: { id: 'isolated-generative-owner', displayName: 'Local test' } } })
 if (url.pathname === '/__fixture-local-model') {
  const body = request.postDataJSON()
  await page.evaluate(value => window.__uiCalls.push(value), body)
  if (!body.messages?.some(m => m.role === 'system' && m.content.includes('generative Nalu workspace'))) return route.fulfill({json:{completion:'Fixture helper'}})
  const turn = body.messages.filter(m => m.role === 'user').length
  const layout = turn === 1 ? layouts.initial : layouts.update
  const raw = '```nalu_ui\n' + JSON.stringify(layout) + '\n```\nYour workspace is ready.'
  const firstBlock = raw.indexOf('},{"id":"tasks"') + 1
  return route.fulfill({json:{completion:raw,chunks:[raw.slice(0,firstBlock),raw.slice(firstBlock)],delayMs:3000}})
 }
 if (!url.pathname.startsWith('/api/')) return route.continue()
 const body = request.postData() ? JSON.parse(request.postData()) : {}; calls.push({ path: url.pathname, action: body.action })
 let json = { ok: true }
 if (url.pathname === '/api/auth') json = { ok: true, user: { id: 'isolated-generative-owner', displayName: 'Local test' } }
 else if (url.pathname === '/api/data') json = body.action === 'load' ? { data: {} } : { ok: true, items: [], tasks: [] }
 else if (url.pathname === '/api/swarm') json = { state: { version: 1, mode: 'live', projects: [], tasks: [], messages: [], turns: [] }, revision: 1 }
 else if (url.pathname === '/api/web' && body.action === 'intent') json = { kind: 'chat', mode: 'chat', additionalKinds: [] }
 else if (url.pathname === '/api/web' && body.action === 'places') json = { source: 'osm', results: [{ name: 'Fixture Dallas restaurant', address: 'Dallas, Texas', lat: 32.78, lng: -96.8 }] }
 else if (url.pathname === '/api/team') json = { members: [], teams: [], invites: [] }
 else if (url.pathname === '/api/artifacts') json = { outputs: [] }
 else if (url.pathname === '/api/community') json = { rooms: [] }
 return route.fulfill({ json })
})
let page
try {
 page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
 await page.goto(base)
 await page.getByRole('button', { name: 'Enter local workspace' }).click()
 const home = page.getByRole('region', { name: 'Your generative workspace' })
 await expect(home).toBeVisible({ timeout: 45000 })
 await page.waitForFunction(() => Number(document.querySelector('[data-workspace-cursors]')?.getAttribute('data-active-jobs')) > 0)
 await page.waitForTimeout(1500)
 await page.screenshot({ path: output + '/00-cursors.png' })
 await page.getByRole('button', { name: 'Pause cursor construction', exact: true }).click()
 assert.equal(await page.locator('.workspace-chat-trigger,.workspace-app-dock,.workspace-agent-tray,.workspace-chat-popover').count(), 0)
 const logo = await page.getByRole('button', { name: 'Nalu home', exact: true }).boundingBox()
 assert.ok(logo.x >= 30 && logo.y > 10 && logo.y < 70)
 await home.locator('textarea').fill('Compare two properties with editable inputs and a checklist.')
 await home.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.locator('[data-block-id="returns"]')).toBeVisible()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','true')
 assert.equal(await page.locator('[data-block-id="tasks"]').count(), 0)
 await page.screenshot({ path: output + '/01-streaming.png' })
 await expect(page.locator('[data-block-id="tasks"]')).toBeVisible()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','false')
 await expect(page.locator('output')).toHaveText('6%')
 await page.getByRole('spinbutton', { name: 'Purchase price', exact: true }).fill('500000')
 await expect(page.locator('output')).toHaveText('4.8%')
 await page.getByRole('checkbox', { name: 'Verify leases', exact: true }).check()
 await page.getByRole('button', { name: 'Property', exact: true }).click()
 await expect(page.locator('.generative-table tbody tr').first()).toContainText('A')
 await page.getByRole('button', { name: 'Play cursor construction', exact: true }).click()
 await page.waitForFunction(() => Number(document.querySelector('[data-workspace-cursors]')?.getAttribute('data-active-jobs')) > 0)
 for (const selector of ['input[type=number]', 'input[type=checkbox]', 'th', 'td', '.generative-block', '.nalu-build-copy']) assert.ok(await page.locator(selector + '[data-build-piece]').count(), `cursor covers ${selector}`)
 await page.waitForTimeout(1200)
 await page.screenshot({ path: output + '/02-cursor-construction.png' })
 await page.getByRole('button', { name: 'Pause cursor construction', exact: true }).click()
 await expect(page.getByRole('spinbutton', { name: 'Purchase price', exact: true })).toHaveValue('500000')
 await page.screenshot({ path: output + '/02-edited.png' })
 await page.waitForTimeout(500)
 await page.reload()
 await expect(home).toBeVisible({ timeout: 45000 })
 await page.getByRole('button', { name: 'Pause cursor construction', exact: true }).click()
 await page.getByRole('navigation', { name: 'Recent work' }).getByRole('button').first().click()
 await expect(page.getByRole('spinbutton', { name: 'Purchase price', exact: true })).toHaveValue('500000')
 await expect(page.getByRole('checkbox', { name: 'Verify leases', exact: true })).toBeChecked()
 const canvas = page.getByRole('region', { name: 'Generated workspace' })
 await canvas.locator('textarea').fill('Add a next step form and keep my inputs.')
 await canvas.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.getByRole('heading', { name: 'Updated property workspace', exact: true })).toBeVisible()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','false')
 await expect(page.getByRole('spinbutton', { name: 'Purchase price', exact: true })).toHaveValue('500000')
 await expect(page.getByRole('checkbox', { name: 'Verify leases', exact: true })).toBeChecked()
 await page.getByRole('textbox', { name: 'Your instructions', exact: true }).fill('Review the leases first')
 await page.getByRole('button', { name: 'Continue with Nalu', exact: true }).click()
 await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
 await page.getByRole('button', { name: 'Stop', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','false')
 const modelCalls = await page.evaluate(() => window.__uiCalls)
 assert.ok(modelCalls.some(call => call.messages.some(m => typeof m.content === 'string' && m.content.includes('Review the leases first'))))
 await page.getByRole('region', { name: 'Generated workspace' }).getByRole('button', { name: 'Conversation', exact: true }).click()
 await expect(page.locator('.generative-conversation')).toBeVisible()
 assert.equal(await page.getByRole('dialog', { name: 'Nalu chat' }).count(), 0)
 await page.getByRole('button', { name: 'Back to workspace' }).click()
 await page.setViewportSize({ width: 390, height: 844 })
 await page.screenshot({ path: output + '/03-mobile.png' })
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
 await page.setViewportSize({ width: 1440, height: 1000 })
 await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Capabilities', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Nalu capabilities' })).toBeVisible()
 assert.equal(await page.getByRole('region', { name: 'Choose a workspace', exact: true }).count(), 0)
 await page.screenshot({ path: output + '/04-capabilities.png' })
 await page.getByRole('button', { name: 'Work with numbers', exact: false }).click()
 await expect(home).toBeVisible()
 await expect(home.locator('textarea')).toHaveValue('Help me analyze ')
 await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Saved work', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Saved workspaces' })).toBeVisible()
 await page.getByLabel('Search saved work', { exact: true }).fill('Compare two properties')
 await expect(page.locator('.generative-library-card')).toHaveCount(1)
 await page.screenshot({ path: output + '/05-saved-work.png' })
 await page.locator('.generative-library-card').click()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toBeVisible()
 await page.getByRole('button', { name: 'Account options', exact: true }).click()
 await page.getByRole('button', { name: 'Settings', exact: true }).click()
 await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
 await page.screenshot({ path: output + '/06-settings.png' })
 await page.getByRole('button', { name: 'Nalu home', exact: true }).click()
 await expect(home).toBeVisible()
 const beforeMapCalls = await page.evaluate(() => window.__uiCalls.length)
 await home.locator('textarea').fill('show me best places to eat in dallas on a map')
 await home.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.locator('[data-block-type="map"]')).toBeVisible()
 await expect(page.getByRole('textbox', { name: 'Map search', exact: true })).toHaveValue('best restaurants in dallas')
 assert.equal(await page.evaluate(() => window.__uiCalls.length), beforeMapCalls, 'explicit map requests do not wait on chat generation')
 assert.deepEqual(errors, [])
 assert.deepEqual(remote, [])
 console.log('PASS cursor coverage across text/layout/controls, dynamic registration and Motion pause/resume without lost edits; progressive UI before stream completion; live calculation, checklist and sorting edits; reload restoration; follow-up preservation; form continuation; Stop; full-page conversation; mobile layout; new capability/library navigation and settings; no legacy carousel, floating icons or remote fixture traffic')
} catch(error) { await page?.screenshot({path: output+'/failure.png'}).catch(()=>{}); await writeFile(output+'/failure.json',JSON.stringify({errors,text:await page?.locator('body').innerText()},null,2)); throw error } finally { await context.close(); await browser.close(); await server?.close() }
