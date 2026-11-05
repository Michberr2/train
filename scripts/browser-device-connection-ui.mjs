import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import { chromium, expect } from '@playwright/test'
const output = '/tmp/nalu-browser-device-connection-ui'; await mkdir(output, { recursive: true })
const root = fileURLToPath(new URL('../client', import.meta.url))
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import Panel from '/src/components/workspace/BrowserWorkspacePanel.tsx';import Dock from '/src/components/workspace-preview/real/WorkspaceAppDock.tsx';import * as tools from '/src/components/workspace/browserWorkspace.ts';window.browserTools=tools;createRoot(document.getElementById('root')).render(<React.StrictMode><div className="nalu-design-review" data-workspace-design><Panel token="fixture-owner-a"/><Dock currentView="browser" launcherOpen={false} onOpen={()=>{}}/></div></React.StrictMode>);`
const server = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`, plugins: [react(), {
 name: 'fixture', resolveId(id) { if (id === '/@fixture') return '\0browser-fixture' }, load(id) { if (id === '\0browser-fixture') return fixture },
 transform(code, id) { if (id === '\0browser-fixture') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
 configureServer(v) { v.middlewares.use('/__browser-test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await v.transformIndexHtml('/__browser-test', '<html><body style="margin:0;font-family:Arial"><div id="root"></div><script type="module" src="/@fixture"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 0, hmr: false } })

const profile = await mkdtemp(path.join(os.tmpdir(), 'nalu-connection-fixture-'))
const child = spawn(process.execPath, ['--import', path.resolve('services/browser-device/auth-fixture.mjs'), path.resolve('client/public/nalu-browser-device.cjs')], {
 env: { ...process.env, BROWSER_DATA_DIR: profile, CHROMIUM_EXECUTABLE: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, stdio: ['ignore','pipe','pipe']
})
let browser, errors = ''
child.stderr.on('data', chunk => { errors += chunk })
try {
 const code = await new Promise((resolve, reject) => {
  let output = ''; const timeout = setTimeout(() => reject(Error('Companion startup timed out: ' + errors)), 15000)
  child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Connection code: ([a-f0-9]+)/); if(match){clearTimeout(timeout);resolve(match[1])} })
  child.once('exit', () => { clearTimeout(timeout);reject(Error('Companion exited: ' + errors)) })
 })
 await server.listen(); const base = `http://127.0.0.1:${server.httpServer.address().port}`
 browser = await chromium.launch()
 const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
 await context.grantPermissions(['local-network-access'], { origin: 'https://n4lu.com' })
 // Only this isolated browser receives fixture UI at the production origin.
 // The loopback companion and real Chrome browser are not mocked.
 await context.route('https://n4lu.com/**', async route => {
  const url = new URL(route.request().url())
  await route.fulfill({ response: await route.fetch({ url: base + url.pathname + url.search }) })
 })
 await context.addInitScript(() => localStorage.setItem('nalu-token','fixture-owner-a'))
 const page = await context.newPage(); await page.goto('https://n4lu.com/__browser-test')
 await page.getByLabel('Connect this computer', { exact: true }).fill(code)
 await page.getByRole('button', { name:'Connect', exact:true }).click()
 await expect(page.getByRole('heading', {name:'Open a website to begin.'})).toBeVisible({timeout:15000})
 await page.getByLabel('Website address').fill('https://example.com/')
 await page.getByRole('button', {name:'Open browser',exact:true}).click()
 await expect(page.getByAltText('Live browser on this computer')).toBeVisible({timeout:35000})
 await page.screenshot({path:output+'/connection.png',fullPage:true})
 await page.getByRole('button',{name:'Close browser',exact:true}).click()
 await expect(page.getByAltText('Live browser on this computer')).toHaveCount(0)
 console.log('PASS HTTPS website origin -> actual loopback companion -> actual isolated local Chrome -> screenshot viewer and close. Nalu identity response mocked; local-network permission explicitly granted as the user would allow it.')
} finally {
 await browser?.close(); await server.close()
 if (child.exitCode === null) { const exited = once(child,'exit'); child.kill('SIGTERM'); await exited }
}
