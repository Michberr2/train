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
  let state = { configured: true, active: false, status: 'idle', steps: [], files: [] }
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('nalu-token', 'owner'))
  await page.route('https://live.browser-use.com/**', r => r.fulfill({ contentType: 'text/html', body: '<h1>Isolated remote browser fixture</h1>' }))
  await page.route('**/api/browser', async route => {
   const body = route.request().postDataJSON(); calls.push(body); assert.equal(route.request().headers().authorization, 'Bearer owner')
   if (body.action === 'workspace_open') state = { ...state, active: true, live_url: 'https://live.browser-use.com/private-fixture' }
   if (body.action === 'workspace_run') state = { ...state, active: true, status: 'running', task: body.task, task_id: 'browser-fixture' }
   if (body.action === 'workspace_takeover') state = { ...state, status: 'cancelled' }
   if (body.action === 'workspace_close') state = { ...state, active: false, live_url: '', status: 'cancelled' }
   await route.fulfill({ json: state })
  })
  await page.goto(`${base}/__browser-test`)
  await expect(page.getByRole('heading', { name: 'Your apps, ready for work.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Browser', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Excel', exact: true }).click()
  await expect(page.getByTitle('Your private Nalu browser')).toBeVisible()
  assert.equal(calls.find(c => c.action === 'workspace_open').url, 'https://excel.cloud.microsoft/')
  await page.getByLabel('What should Nalu do?').fill('Add a monthly expense summary and verify it saved')
  await page.getByRole('button', { name: 'Run task', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeDisabled()
  await expect(page.getByText('Nalu is working. Take control to interact.')).toBeVisible()
  assert.equal(await page.getByTitle('Your private Nalu browser').evaluate(e => getComputedStyle(e).pointerEvents), 'none')
  await page.screenshot({ path: `${output}/browser-${width}.png`, fullPage: true })
  await page.getByRole('button', { name: 'Take control', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeEnabled()
  assert.equal(await page.getByTitle('Your private Nalu browser').evaluate(e => getComputedStyle(e).pointerEvents), 'auto')
  const tool = await page.evaluate(() => window.browserTools.execBrowserTool({ id: 'call-1', function: { name: 'browser_status', arguments: '{}' } }))
  assert.ok(!tool.includes('live_url') && !tool.includes('private-fixture'))
  assert.equal(await page.evaluate(() => window.browserTools.explicitlyUsesBrowser('Update my budget in Excel Online')), true)
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  await expect(page.getByTitle('Your private Nalu browser')).toHaveCount(0)
  await page.evaluate(() => localStorage.setItem('nalu-token', 'other'))
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Sign in again')
  assert.deepEqual(errors, [])
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  console.log(`PASS ${width}px workspace, account headers, private tool output, takeover and closure`); await page.close()
 }
} finally { await browser?.close(); await server.close() }
