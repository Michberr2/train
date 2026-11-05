import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'

// Real setup UI, sync/auth fetch wrapper, local runtime and SSE adapter.
// Only Ollama's HTTP responses are synthetic; no model quality claim.
const root = fileURLToPath(new URL('../client/', import.meta.url)), output = '/private/tmp/nalu-ollama-browser-check'
await mkdir(output, { recursive: true })
const cacheDir = await mkdtemp(join(tmpdir(), 'nalu-ollama-browser-'))
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import ThemeProvider from'/src/components/ThemeProvider';import LocalAIControl from'/src/components/workspace/LocalAIControl';import{requestLocalChat}from'/src/lib/localAI';import{readChatStream}from'/src/components/workspace/chatStream';import{installSync}from'/src/lib/sync';import'/src/globals.css';installSync();function App(){const[answer,setAnswer]=useState('');return <ThemeProvider><main style={{maxWidth:640,margin:'auto',padding:24}}><LocalAIControl panel/><button onClick={async()=>{try{const result=await readChatStream(requestLocalChat({messages:[{role:'user',content:'Say hello from the local companion.'}]}).body,{});setAnswer(result.error||result.text)}catch(error){setAnswer(error.message)}}}>Ask local Nalu</button><output aria-label="Local answer">{answer}</output></main></ThemeProvider>};createRoot(document.getElementById('root')).render(<App/>);`
const server = await createServer({ root, configFile: false, cacheDir, css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [root + 'src/**/*.{ts,tsx}'] })] } }, plugins: [react(), {
  name: 'ollama-ui-fixture', resolveId(id) { if (id === '/@ollama-ui') return '\0ollama-ui' }, load(id) { if (id === '\0ollama-ui') return entry },
  transform(source, id) { if (id === '\0ollama-ui') return transform(source, { loader: 'jsx', jsx: 'automatic' }) },
  configureServer(vite) { vite.middlewares.use('/__ollama-ui', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__ollama-ui', '<!doctype html><html><body><div id="root"></div><script type="module" src="/@ollama-ui"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
const report = { checks: [], errors: [], requests: [], forbidden: [] }
let browser, cloudDisabled = false
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch(); const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } })
  await context.addInitScript(() => {
    if (!localStorage.getItem('nalu-token')) { localStorage.setItem('nalu-token', 'BROWSER_ACCOUNT_TOKEN'); localStorage.setItem('nalu-data-owner', 'browser-owner'); localStorage.setItem('device-local-ai-v1', JSON.stringify({ enabled: false, provider: 'ollama', profile: 'balanced' })) }
    Object.defineProperty(navigator, 'gpu', { configurable: true, get() { throw Error('Companion mode must not require WebGPU') } })
  })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === 'http://127.0.0.1:11434') {
      const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      assert.equal(request.headers().authorization, undefined); assert.equal(request.headers().cookie, undefined); assert.equal(request.headers().referer, undefined)
      assert.ok(!String(request.postData()).includes('BROWSER_ACCOUNT_TOKEN'))
      report.requests.push({ path: url.pathname, body: request.postData() ? request.postDataJSON() : undefined })
      if (url.pathname === '/api/status') return route.fulfill({ headers, json: { cloud: { disabled: cloudDisabled } } })
      if (url.pathname === '/api/tags') return route.fulfill({ headers, json: { models: ['qwen3.5:2b', 'qwen3.5:4b', 'qwen2.5-coder:3b', 'qwen3.5:2b-q4_K_M', 'qwen3.5:4b-q4_K_M'].map(name => ({ name, size: 1024, digest: 'a'.repeat(64) })) } })
      if (url.pathname === '/api/show') return route.fulfill({ headers, json: { details: { format: 'gguf' }, capabilities: ['completion'] } })
      assert.equal(url.pathname, '/api/chat')
      const body = request.postDataJSON(); assert.equal(body.options.num_gpu, 0)
      return route.fulfill({ headers, contentType: 'application/x-ndjson', body: JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'Local companion fixture reply.' }, done: true, done_reason: 'stop' }) + '\n' })
    }
    if (url.origin !== origin || url.pathname.startsWith('/api/')) { report.forbidden.push(url.origin + url.pathname); return route.abort() }
    return route.continue()
  })
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(origin + '/__ollama-ui')
  await page.getByText('Advanced AI settings', {exact:true}).click()
  await expect(page.getByRole('combobox', { name: 'Local AI engine' })).toHaveValue('ollama')
  await page.getByRole('button', { name: 'Connect local crew', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Turn off Ollama cloud features')
  assert.equal(report.requests.filter(request => request.path === '/api/chat').length, 0)
  cloudDisabled = true
  await page.getByRole('button', { name: 'Connect local crew', exact: true }).click()
  await expect(page.getByText('Ollama is ready on this computer. Cloud inference is disabled.', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Companion compute' }).selectOption('cpu')
  await page.getByRole('button', { name: 'Ask local Nalu', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Local answer' })).toHaveText('Local companion fixture reply.')
  await page.reload()
  await page.getByText('Advanced AI settings', {exact:true}).click()
  await expect(page.getByRole('combobox', { name: 'Local AI engine' })).toHaveValue('ollama')
  await expect(page.getByRole('combobox', { name: 'Companion compute' })).toHaveValue('cpu')
  await page.getByText('Set up Ollama on this computer', { exact: true }).click()
  await expect(page.locator('pre').first()).toContainText('OLLAMA_NO_CLOUD=1')
  await page.getByRole('combobox', { name: 'Companion setup platform' }).selectOption('windows')
  await expect(page.locator('pre').first()).toContainText('$env:OLLAMA_NO_CLOUD="1"')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await page.screenshot({ path: output + '/companion-setup-mobile.png', fullPage: true })
  assert.deepEqual(report.errors, []); assert.deepEqual(report.forbidden, [])
  report.checks.push('The real setup panel connects without WebGPU, refuses cloud-enabled Ollama before prompting, and verifies the three-model crew', 'CPU-only replies use the real SSE runtime with credentials omitted; device preferences survive reload without account sync', 'Setup instructions cover macOS/Linux and PowerShell and fit a phone viewport')
  for (const check of report.checks) console.log('PASS ' + check)
} finally { await writeFile(output + '/report.json', JSON.stringify(report, null, 2)); await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }) }
