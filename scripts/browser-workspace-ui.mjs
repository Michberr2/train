import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import { chromium, expect } from '@playwright/test'
const output = '/tmp/nalu-browser-workspace-ui'; await mkdir(output, { recursive: true })
const root = fileURLToPath(new URL('../client', import.meta.url))
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import Panel from '/src/components/workspace/BrowserWorkspacePanel.tsx';import Dock from '/src/components/workspace-preview/real/WorkspaceAppDock.tsx';import * as tools from '/src/components/workspace/browserWorkspace.ts';window.browserTools=tools;createRoot(document.getElementById('root')).render(<React.StrictMode><div className="nalu-design-review" data-workspace-design><Panel token="owner"/><Dock currentView="browser" launcherOpen={false} onOpen={()=>{}}/></div></React.StrictMode>);`
const server = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`, plugins: [react(), {
 name: 'fixture', resolveId(id) { if (id === '/@fixture') return '\0browser-fixture' }, load(id) { if (id === '\0browser-fixture') return fixture },
 transform(code, id) { if (id === '\0browser-fixture') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
 configureServer(v) { v.middlewares.use('/__browser-test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await v.transformIndexHtml('/__browser-test', '<html><body style="margin:0;font-family:Arial"><div id="root"></div><script type="module" src="/@fixture"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 0, hmr: false } })
let browser
try {
 await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}`; browser = await chromium.launch()
 for (const width of [390, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } }); const calls = [], errors = []
  let state = { configured: true, active: false, status: 'idle', steps: [], agents: [{ id: 'main', status: 'idle' }] }
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('nalu-token', 'owner'))
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mAAAAABJRU5ErkJggg=='
  await page.route('http://127.0.0.1:8877/device', async route => {
   const body = route.request().postDataJSON(); calls.push(body); assert.equal(route.request().headers().authorization, 'Bearer owner')
   if (body.action === 'pair') return route.fulfill({ json: { device: 'test-private-device-capability' } })
   assert.equal(route.request().headers()['x-nalu-device'], 'test-private-device-capability')
   if (body.action === 'workspace_open') state = { ...state, active: true, image }
   if (body.action === 'workspace_run') state = { ...state, active: true, status: 'running', task: body.task }
   if (body.action === 'workspace_takeover') state = { ...state, status: 'paused' }
   if (body.action === 'workspace_close') state = { ...state, active: false, image: null, status: 'idle' }
   await route.fulfill({ json: state })
  })
  await page.goto(`${base}/__browser-test`)
  await page.getByLabel('Connect this computer', { exact: true }).fill('fixture-code')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Open a website to begin.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Browser', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await expect(page.getByAltText('Live browser on this computer')).toBeVisible()
  await page.getByLabel('What should this agent do?').fill('Add a monthly expense summary and verify it saved')
  await page.getByRole('button', { name: 'Run task', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeDisabled()
  await expect(page.getByText('Nalu is working on this computer.')).toBeVisible()
  assert.equal(await page.getByRole('application').getAttribute('tabindex'), '-1')
  await page.screenshot({ path: `${output}/browser-${width}.png`, fullPage: true })
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue task', exact: true })).toBeVisible()
  assert.equal(await page.getByRole('application').getAttribute('tabindex'), '0')
  await page.getByRole('application').focus()
  await page.keyboard.type('rapid typing')
  await expect.poll(() => calls.filter(c => c.action === 'workspace_input').map(c => c.text || '').join('')).toBe('rapid typing')
  const tool = await page.evaluate(() => window.browserTools.execBrowserTool({ id: 'call-1', function: { name: 'browser_status', arguments: '{}' } }))
  assert.ok(!tool.includes('test-private-device-capability'))
  assert.equal(await page.evaluate(() => window.browserTools.explicitlyUsesBrowser('Update my budget in Excel Online')), true)
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  await expect(page.getByAltText('Live browser on this computer')).toHaveCount(0)
  await page.evaluate(() => localStorage.setItem('device-local-ai-v1', JSON.stringify({ enabled: true })))
  const beforeLocal = calls.length
  const localResult = await page.evaluate(() => window.browserTools.execBrowserTool({ id: 'local-check', function: { name: 'browser_work', arguments: JSON.stringify({ task: 'Do not send page data online' }) } }))
  assert.match(localResult, /No page data was sent/)
  assert.equal(calls.length, beforeLocal)
  await page.evaluate(() => localStorage.removeItem('device-local-ai-v1'))
  await page.evaluate(() => localStorage.setItem('nalu-token', 'other'))
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Sign in again')
  assert.deepEqual(errors, [])
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  console.log(`PASS ${width}px workspace, account headers, device pairing, ordered input, private tool output, takeover and closure`); await page.close()
 }
} finally { await browser?.close(); await server.close() }
