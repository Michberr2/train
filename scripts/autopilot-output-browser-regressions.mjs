// Current real AgentsPanel + real attachment HTTP handler, isolated in-memory
// storage/model responses. No provider calls, user accounts, sends or publishes.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'
import ExcelJS from 'exceljs'
import { attachmentFixture } from './autopilot-output-fixture.mjs'

const root = fileURLToPath(new URL('../client', import.meta.url)), output = '/tmp/nalu-autopilot-output-audit'
await mkdir(output, { recursive: true })
const kinds = ['calendar', 'contacts', 'mailrules', 'csv', 'sheet', 'json', 'markdown', 'website', 'image', 'social', 'textfile']
const flow = { id: 'output-audit', name: 'Output fixture', enabled: false, schedule: 'manual', nodes: [
  { id: 'source', type: 'trigger', label: 'Source', prompt: 'Fictional source — Café 🐺, revenue 12, cost 5.', x: 20, y: 20 },
  ...kinds.map((type, index) => ({ id: type, type, label: `Fixture ${type}`, prompt: 'Preserve the source exactly: {{input}}', x: 360 + index % 3 * 320, y: 20 + Math.floor(index / 3) * 240 })),
], edges: kinds.map(to => ({ from: 'source', to })) }
const attachments = await attachmentFixture(flow)
const workbook = { title: 'Fixture workbook', sheets: [{ name: 'Data', columns: ['Item', 'Amount', 'Total'], rows: [['Café, 🐺', 12, '=B2*2'], ['Cost', 5, '=B3+1']] }] }
const carousel = { kind: 'carousel', name: 'Fixture social', platform: 'Instagram', ratio: '4:5', theme: { bg: '#102238', bg2: '#102238', ink: '#ffffff', accent: '#e8b95c', headingFont: 'Arial', bodyFont: 'Arial' }, slides: [{ kind: 'cover', headline: 'Café 🐺', sub: 'Preserve the complete source.' }], caption: 'Fixture caption.', hashtags: ['#Fixture'] }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const entry = `import React from'react';import{createRoot}from'react-dom/client';import AgentsPanel from'/src/components/workspace/AgentsPanel.tsx';import'/src/globals.css';createRoot(document.getElementById('root')).render(React.createElement(AgentsPanel));`
const server = await createServer({ configFile: false, root, css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [`${root}/src/**/*.{js,ts,jsx,tsx}`] })] } }, plugins: [react(), {
  name: 'autopilot-output-fixture', resolveId(id) { if (id === '/@output-fixture') return '\0output-fixture' }, load(id) { if (id === '\0output-fixture') return entry },
  configureServer(vite) { vite.middlewares.use('/__output-fixture', async (_, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__output-fixture', '<!doctype html><html><body><main id="root" style="height:100vh"></main><script type="module" src="/@output-fixture"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 5197, strictPort: true } })
const origin = 'http://127.0.0.1:5197', report = { checks: [], findings: [], errors: [], calls: [], checksPassed: false }
let browser
try {
  await server.listen(); browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (/download|disallowed|blocked/i.test(message.text())) report.findings.push(message.text()) })
  await page.addInitScript(flow => {
    if (!localStorage.getItem('nalu-agent-flows')) localStorage.setItem('nalu-agent-flows', JSON.stringify([flow]))
    localStorage.setItem('nalu-token', 'fixture-owner')
    localStorage.setItem('nalu-deleted-flows', JSON.stringify(['nalu-labs', 'autoposter', 'nalu-fund']))
  }, flow)
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const body = request.method() === 'POST' ? request.postDataJSON() : {}
    report.calls.push({ path: url.pathname, action: body?.action })
    if (url.pathname === '/api/task-attachments') {
      const response = await attachments.request({ method: request.method(), token: request.headers().authorization?.replace(/^Bearer /, ''), body, query: Object.fromEntries(url.searchParams) })
      return route.fulfill({ status: response.code, headers: response.headers, json: response.body })
    }
    if (url.pathname === '/api/chat') {
      const prompt = body.messages.at(-1).content
      const result = /meetings\/reservations/.test(prompt) ? [{ title: 'Café, review; plan 🐺', start: '2026-09-10T09:30', end: '2026-09-10T10:15', description: 'Exact source.\nKeep details.' }] : /CONTACTS/.test(prompt) ? [{ name: 'Café Wolf', org: 'R&D, LLC', email: 'wolf@example.test', phone: '+15555550123' }] : /inbox-organization/.test(prompt) ? [{ name: 'Receipts & invoices', from: 'receipts@example.test', subject: 'R&D <invoice>', label: 'Finance/Receipts', archive: true }] : { name: 'Café 🐺', revenue: 12, cost: 5 }
      return route.fulfill({ contentType: 'text/event-stream', body: frame('delta', { text: JSON.stringify(result) }) + frame('finish', { reason: 'stop' }) + frame('done', { ok: true }) })
    }
    if (url.pathname === '/api/sheet') return route.fulfill({ json: workbook })
    if (url.pathname === '/api/design') return route.fulfill({ json: body.kind === 'carousel' ? carousel : { kind: 'webpage', html: '<!doctype html><html><body><h1>Café 🐺</h1><p>12 revenue,5 cost</p></body></html>' } })
    if (url.pathname === '/api/image') return route.fulfill({ json: { url: `data:image/png;base64,${png.toString('base64')}` } })
    if (url.pathname === '/api/artifacts') return route.fulfill({ json: { outputs: [] } })
    if (url.pathname === '/api/data') return route.fulfill({ json: { ok: true, data: { 'nalu-agent-flows': JSON.stringify([flow]) } } })
    if (url.pathname === '/api/oauth' || url.pathname === '/api/connect' || url.pathname === '/api/team') return route.fulfill({ json: { ok: true, configured: [], connections: [], members: [] } })
    return route.fulfill({ json: { ok: true, tasks: [], events: [] } })
  })
  const downloads = []
  page.on('download', download => downloads.push(download))
  await page.goto(`${origin}/__output-fixture`)
  await page.getByRole('button', { name: 'Run', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const storedFlow = () => page.evaluate(() => JSON.parse(localStorage.getItem('nalu-agent-flows'))[0])
  await expect.poll(async () => (await storedFlow()).run?.status, { timeout: 90000 }).toBe('done')
  const metas = await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-agent-output-meta') || '[]'))
  assert.equal(metas.length, kinds.length)
  assert.equal(attachments.db.attachments.size, kinds.length)
  const savedFlow = await storedFlow(), bodies = new Map()
  report.automaticDownloads = downloads.map(item => item.suggestedFilename())
  report.savedFiles = metas
  report.checkpoint = savedFlow
  // The browser can rate-limit a burst of more than10 automatic downloads.
  // Reopen before checking on-demand downloads so that limit is not mistaken
  // for missing IndexedDB/account bytes.
  await page.reload()
  await page.getByRole('button', { name: 'Run', exact: true }).waitFor()
  if (await page.getByRole('button', { name: 'Your workflows', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'Your workflows', exact: true }).click()
  for (const meta of metas) {
    const file = [...attachments.db.attachments.values()].find(file => file.meta.sourceId === meta.id)
    assert.ok(file?.ready, `${meta.kind} must finish authenticated upload before its flow completes`)
    let download = downloads.find(item => item.suggestedFilename() === meta.filename)
    if (!download) {
      report.findings.push(`${meta.filename}: automatic download absent; testing explicit download from Outputs`)
      const all = page.getByRole('button', { name: 'Show all 11 outputs', exact: true })
      if (await all.count()) await all.click()
      try {
        [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: meta.filename, exact: true }).click({ timeout: 10000 })])
      } catch (error) {
        report.findings.push((await page.locator('body').innerText()).slice(-5000))
        await page.screenshot({ path: `${output}/download-failure.png`, fullPage: true })
        throw error
      }
    }
    const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    assert.deepEqual(Buffer.concat([...file.parts.values()]), bytes, 'actual handler retains the exact downloaded bytes')
    const owned = await attachments.request({ method: 'GET', query: { id: file.meta.id, part: '0' } })
    assert.deepEqual(Buffer.from(owned.body.base64, 'base64'), bytes)
    assert.equal((await attachments.request({ method: 'GET', token: 'fixture-other', query: { id: file.meta.id, part: '0' } })).code, 404)
    bodies.set(meta.filename, bytes)
    await writeFile(`${output}/${meta.filename}`, bytes)
    const nodeId = meta.nodeLabel.replace('Fixture ', '')
    if (savedFlow.artifacts[nodeId]?.id !== meta.id) report.findings.push(`${nodeId}: checkpoint ID differs from actual saved/downloadable file ID`)
  }
  const findBody = suffix => [...bodies].find(([name]) => name.endsWith(suffix))[1]
  assert.match(findBody('.ics').toString(), /DTSTART:20260910T093000\r\n/)
  assert.match(findBody('.vcf').toString(), /ORG:R&D\\, LLC/)
  assert.match(findBody('.xml').toString(), /R&amp;D &lt;invoice&gt;/)
  assert.match(findBody('.csv').toString(), /"Café, 🐺",12,24/)
  const downloadedWorkbook = new ExcelJS.Workbook()
  await downloadedWorkbook.xlsx.load(Buffer.from(findBody('.xlsx')))
  const cell = downloadedWorkbook.getWorksheet('Data').getCell('C2').value
  assert.equal(cell.formula, 'B2*2'); assert.equal(cell.result, 24)
  assert.equal(JSON.parse(findBody('.json').toString()).name, 'Café 🐺')
  assert.deepEqual(findBody('.png'), png)
  assert.match(findBody('.md').toString(), /Fictional source — Café 🐺/)
  report.checks.push('11 actual output node paths finish with exact local+account bytes', 'calendar/contact/filter/CSV/Excel/JSON/image/markdown content assertions', 'real attachment handler owner isolation')
  const before = downloads.length
  await page.reload()
  await page.getByRole('button', { name: 'Run', exact: true }).waitFor()
  assert.equal(downloads.length, before, 'reopening never downloads or reruns automatically')
  for (const suffix of ['.ics', '.vcf', '.xml', '.xlsx']) {
    const [name, bytes] = [...bodies].find(([name]) => name.endsWith(suffix))
    if (await page.getByRole('button', { name: 'Your workflows', exact: true }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: 'Your workflows', exact: true }).click()
    const downloading = page.waitForEvent('download')
    const all = page.getByRole('button', { name: 'Show all 11 outputs', exact: true })
    if (await all.count()) await all.click()
    await page.getByRole('button', { name, exact: true }).click()
    const download = await downloading, chunks = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), bytes, 'fresh component reads identical IndexedDB bytes')
  }
  const xml = await page.evaluate(text => { const doc = new DOMParser().parseFromString(text, 'application/xml'); return { errors: doc.getElementsByTagName('parsererror').length, rules: doc.getElementsByTagName('entry').length } }, findBody('.xml').toString())
  assert.deepEqual(xml, { errors: 0, rules: 1 })
  await page.screenshot({ path: `${output}/outputs-reopened.png`, fullPage: true })
  assert.deepEqual(report.errors, [])
  report.checks.push('four non-text outputs reopen and download exact original bytes without rerunning', 'Gmail filter XML parses in the real browser')
  report.checksPassed = true
  console.log(JSON.stringify({ output, checks: report.checks, findings: report.findings }))
} finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser?.close(); await server.close() }
