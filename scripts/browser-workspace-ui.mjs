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
  let releaseStartup; const startup = new Promise(resolve => { releaseStartup = resolve })
  let state = { configured: true, active: false, status: 'idle', steps: [], agents: [{ id: 'main', status: 'idle' }] }
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => { localStorage.setItem('nalu-token', 'owner'); localStorage.setItem('device-local-ai-v1', JSON.stringify({ enabled: true })) })
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mAAAAABJRU5ErkJggg=='
  await page.route('**/api/browser', async route => {
   const body = route.request().postDataJSON(); assert.ok(body.action.startsWith('host_')); body.action = body.action.slice(5); calls.push(body); assert.equal(route.request().headers().authorization, 'Bearer owner')
   assert.equal(route.request().headers()['x-nalu-device'], undefined)
   if (body.action === 'workspace_open') { await startup; state = { ...state, active: true, image } }
   if (body.action === 'workspace_run') state = { ...state, active: true, status: 'running', task: body.task }
   if (body.action === 'workspace_takeover') state = { ...state, status: 'paused' }
   if (body.action === 'workspace_close') state = { ...state, active: false, image: null, status: 'idle' }
   await route.fulfill({ json: state })
  })
  await page.goto(`${base}/__browser-test`)
  await page.waitForFunction(()=>Boolean(window.browserTools))
  for (const text of ['browser','open browser','show my browser','please take me to the browser','can you open a browser?']) assert.equal(await page.evaluate(text=>window.browserTools.isBrowserNavigation(text),text),true,text)
  for (const text of ['what is a browser?','do not open browser','open browser and find hotels','explain browser security']) assert.equal(await page.evaluate(text=>window.browserTools.isBrowserNavigation(text),text),false,text)
  await expect(page.getByRole('heading',{name:'Your browser',exact:true})).toBeVisible()
  await expect(page.locator('.nalu-browser')).toHaveAttribute('data-cursor-exempt','true')
  await expect.poll(()=>calls.filter(c=>c.action==='workspace_open').length).toBe(1)
  await page.waitForTimeout(1400)
  assert.deepEqual(calls.map(c=>c.action),['workspace_open'],'polling cannot compete with startup')
  releaseStartup()
  await expect(page.getByAltText('Your private Nalu browser')).toBeVisible()
  assert.equal(calls.filter(c => c.action === 'workspace_open').length, 1, 'StrictMode shares one automatic startup')
  await expect(page.getByLabel('Connect this computer', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Set up this computer')).toHaveCount(0)
  await page.getByLabel('What should this agent do?').fill('Add a monthly expense summary and verify it saved')
  await page.getByRole('checkbox', { name: 'Allow online AI for browser tasks' }).check()
  await page.getByRole('button', { name: 'Run task', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeDisabled()
  await expect(page.getByText('Nalu is working in your private browser.')).toBeVisible()
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
  await expect(page.getByAltText('Your private Nalu browser')).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Allow online AI for browser tasks' }).uncheck()
  await page.evaluate(() => localStorage.setItem('device-local-ai-v1', JSON.stringify({ enabled: true })))
  const beforeLocal = calls.length
  const localResult = await page.evaluate(() => window.browserTools.execBrowserTool({ id: 'local-check', function: { name: 'browser_work', arguments: JSON.stringify({ task: 'Do not send page data online' }) } }))
  assert.match(localResult, /no page data was sent/i)
  assert.equal(calls.length, beforeLocal)
  await page.evaluate(() => localStorage.removeItem('device-local-ai-v1'))
  const defaultResult = await page.evaluate(() => window.browserTools.execBrowserTool({ id: 'default-local-check', function: { name: 'browser_work', arguments: JSON.stringify({ task: 'Keep the default local-only mode' }) } }))
  assert.match(defaultResult, /no page data was sent/i)
  await page.evaluate(() => localStorage.setItem('nalu-token', 'other'))
  await page.getByRole('button', { name: 'Open browser', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Sign in again')
  assert.deepEqual(errors, [])
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  console.log(`PASS ${width}px workspace, account headers, automatic hosted startup, no installation/pairing, ordered input, private tool output, takeover and closure`); await page.close()
 }
 for (const failure of ['server','network']) {
  const page=await browser.newPage()
  await page.addInitScript(()=>localStorage.setItem('nalu-token','owner'))
  await page.route('**/api/browser',route=>{
   if(route.request().postDataJSON().action==='host_workspace_open')return failure==='network'?route.abort():route.fulfill({status:503,json:{error:'Startup unavailable'}})
   return route.fulfill({json:{configured:true,active:false,status:'idle'}})
  })
  await page.goto(`${base}/__browser-test`)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByText('Starting your private browser…',{exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Open browser',exact:true})).toBeEnabled()
  await page.close()
 }
 console.log('PASS startup failures stop loading and leave a usable retry control')
} finally { await browser?.close(); await server.close() }
