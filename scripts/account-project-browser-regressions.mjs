// Real sync/IndexedDB/brand subscriptions/project UI and the real data handler;
// only identity and database I/O are isolated synthetic fixtures.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import { database, request } from './fixtures/project-data-database.mjs'

const output = process.env.OUTPUT_DIR || '/tmp/nalu-account-project-regressions'
await mkdir(output, { recursive: true })
const root = fileURLToPath(new URL('../client', import.meta.url))
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import*as sync from'/src/lib/sync.ts';import*as brand from'/src/components/workspace/brandKit.ts';import Projects from'/src/components/workspace/ProjectsPanel.tsx';
sync.installSync();window.fixture={sync,brand,async login(owner){localStorage.setItem('nalu-token',owner==='owner'?'fixture-owner':'fixture-other');if(!await sync.prepareAccount(owner))throw new Error('Preparation failed');await sync.loadFromServer()},async logout(){if(!await sync.clearLocal())throw new Error('Archive failed');localStorage.removeItem('nalu-token')}};
function Probe(){const current=brand.useBrand();return <><output aria-label="Active brand">{current?.name||'No brand'}</output><Projects/></>};createRoot(document.getElementById('root')).render(<Probe/>);`
const server = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`, plugins: [react(), {
  name: 'account-project-fixture', resolveId(id) { if (id === '/@fixture') return '\0fixture' },
  load(id) { if (id === '\0fixture') return fixture },
  transform(code, id) { if (id === '\0fixture') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
  configureServer(vite) { vite.middlewares.use('/__fixture', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__fixture', '<html><body><div id="root"></div><script type="module" src="/@fixture"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 0, hmr: false } })
let browser, base, held = null
const db = database(), calls = [], errors = [], checks = []
const record = name => { checks.push(name); console.log('PASS ' + name) }
async function page() {
  const context = await browser.newContext()
  await context.route('**/api/data', async route => {
    const body = route.request().postDataJSON(), token = route.request().headers().authorization?.replace(/^Bearer /, '')
    calls.push({ body, token })
    const wait = held?.(body, token)
    if (wait) await wait
    const response = await request(db, body, token)
    await route.fulfill({ status: response.code, json: response.body }).catch(() => {})
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/__fixture'); await page.waitForFunction(() => window.fixture)
  return page
}
const login = (page, owner = 'owner') => page.evaluate(owner => window.fixture.login(owner), owner)
const refresh = page => page.evaluate(() => window.fixture.sync.loadFromServer())
const selectBrand = (page, name) => page.evaluate(name => window.fixture.brand.setBrand({ ...window.fixture.brand.DEFAULT_BRAND, name, primary: '123456' }), name)
const settled = page => expect.poll(() => page.evaluate(() => window.fixture.sync.getSyncState())).toBe('saved')
const rows = page => page.evaluate(() => JSON.parse(localStorage.getItem('nalu-projects') || '[]'))
const save = (page, items) => page.evaluate(items => localStorage.setItem('nalu-projects', JSON.stringify(items)), items)
try {
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
  const a = await page()
  await a.evaluate(() => localStorage.setItem('nalu.brandkit.v2', JSON.stringify({ name: 'Unknown old private brand', primary: '112233' })))
  await login(a, 'other'); await settled(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Nalu')
  assert.equal(await a.evaluate(() => localStorage.getItem('nalu.brandkit.v2')), null)
  assert.match(await a.evaluate(() => localStorage.getItem('nalu.brandkit.unowned.v1')), /Unknown old private brand/)
  assert.equal(JSON.stringify(calls).includes('Unknown old private brand'), false)
  record('Ownerless legacy brand is retained locally without displaying or uploading it to the next account')
  await selectBrand(a, 'Brand B'); await settled(a)
  await a.evaluate(() => window.fixture.logout()); await login(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Nalu')
  await selectBrand(a, 'Brand A'); await settled(a)
  await a.evaluate(() => window.fixture.logout()); await login(a, 'other')
  await expect(a.getByLabel('Active brand')).toHaveText('Brand B')
  await a.evaluate(() => window.fixture.logout()); await login(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Brand A')
  record('A to B to A restores each account’s brand without disclosure or loss')
  const b = await page(); await login(b)
  await expect(b.getByLabel('Active brand')).toHaveText('Brand A')
  await selectBrand(b, 'Device two brand'); await settled(b); await refresh(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Device two brand')
  record('Brand selection synchronizes through the actual account API to independent browser storage')
  await a.evaluate(() => window.fixture.logout()); await login(a, 'other')
  await selectBrand(b, 'Changed while signed out'); await settled(b)
  await a.evaluate(() => window.fixture.logout()); await login(a); await settled(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Changed while signed out')
  assert.equal(db.read('nalu-active-brand').name, 'Changed while signed out')
  record('Already-saved archived settings cannot overwrite a newer device selection when signing back in')
  await b.evaluate(() => window.fixture.brand.setBrand(null)); await settled(b); await refresh(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Nalu')
  record('Explicit brand clearing on another device clears the old local selection')
  let release
  held = body => body.action === 'setMany' ? new Promise(done => { release = done }) : null
  await selectBrand(a, 'Offline pending brand')
  await expect.poll(() => !!release).toBe(true)
  await a.evaluate(() => window.fixture.logout())
  held = null; release(); await login(a, 'other')
  await expect(a.getByLabel('Active brand')).toHaveText('Brand B')
  await a.evaluate(() => window.fixture.logout()); await login(a); await settled(a)
  await expect(a.getByLabel('Active brand')).toHaveText('Offline pending brand')
  record('An unsent brand selection is archived for its owner and survives account switching')
  await refresh(b)
  await a.getByRole('button', { name: 'New project', exact: true }).first().click()
  await a.getByPlaceholder('Project name', { exact: true }).fill('Project A')
  await a.getByRole('button', { name: 'Create', exact: true }).click()
  await b.getByRole('button', { name: 'New project', exact: true }).first().click()
  await b.getByPlaceholder('Project name', { exact: true }).fill('Project B')
  await b.getByRole('button', { name: 'Create', exact: true }).click()
  await settled(a); await settled(b); await refresh(a); await refresh(b)
  await expect(a.getByRole('heading', { name: 'Project A', exact: true })).toBeVisible()
  await expect(a.getByRole('heading', { name: 'Project B', exact: true })).toBeVisible()
  assert.equal((await rows(a)).length, 2)
  record('Actual project UI creates from two stale devices both survive and appear after hydration')
  const original = await rows(a), id = original.find(item => item.name === 'Project A').id
  await save(a, original.map(item => item.id === id ? { ...item, name: 'A first edit' } : item)); await settled(a)
  await save(b, original.map(item => item.id === id ? { ...item, name: 'A competing edit' } : item)); await settled(b); await refresh(a)
  await expect(a.getByRole('heading', { name: 'A first edit', exact: true })).toBeVisible()
  await expect(a.getByRole('heading', { name: 'A competing edit (conflicting edit)', exact: true })).toBeVisible()
  assert.equal((await rows(a)).length, 3)
  record('Competing same-ID edits appear as a labeled conflict copy instead of overwriting either version')
  await save(a, (await rows(a)).map(item => item.id === id ? { ...item, name: 'Project A' } : item)); await settled(a)
  await refresh(a); await refresh(b)
  await expect(a.getByRole('heading', { name: 'Project A', exact: true })).toBeVisible()
  await expect(b.getByRole('heading', { name: 'Project A', exact: true })).toBeVisible()
  assert.equal((await rows(a)).length, 3)
  await save(a, (await rows(a)).map(item => item.id === id ? { ...item, name: 'A first edit' } : item)); await settled(a)
  await refresh(a)
  await expect(a.getByRole('heading', { name: 'A first edit', exact: true })).toBeVisible()
  assert.equal((await rows(a)).length, 3)
  record('Current-revision reverts to earlier names survive sync and hydration without producing conflicts')
  await a.getByRole('button', { name: 'Delete A first edit', exact: true }).click(); await settled(a)
  await save(b, await rows(b)); await settled(b); await refresh(a); await refresh(b)
  assert.equal((await rows(a)).some(item => item.id === id), false)
  assert.equal((await rows(b)).some(item => item.id === id), false)
  record('UI deletion creates a tombstone and a stale device cannot resurrect the project')
  // A second edit made while the first save is pending is causally newer, not a
  // competing device edit; acknowledge/rebase it before sending the next batch.
  const chosen = (await rows(a)).find(item => item.name === 'Project B')
  let resume, waiting = false
  held = body => body.action === 'setMany' && body.entries?.['nalu-projects'] && !waiting ? (waiting = true, new Promise(done => { resume = done })) : null
  await save(a, (await rows(a)).map(item => item.id === chosen.id ? { ...item, name: 'B edit one' } : item))
  await expect.poll(() => !!resume).toBe(true)
  await save(a, (await rows(a)).map(item => item.id === chosen.id ? { ...item, name: 'B edit two' } : item))
  held = null; resume(); await settled(a)
  await refresh(a)
  assert.equal((await rows(a)).find(item => item.id === chosen.id).name, 'B edit two')
  assert.equal((await rows(a)).some(item => item.name === 'B edit two (conflicting edit)'), false)
  record('A newer local edit during an in-flight save rebases without manufacturing a conflict')
  await settled(a); await settled(b)
  const count = calls.length
  await a.waitForTimeout(1300)
  assert.equal(calls.length, count, 'Hydration notifications must not create a project autosave loop')
  assert.deepEqual(errors, [])
  await a.screenshot({ path: `${output}/projects-and-brand.png` })
  record('Subscriptions settle without an autosave loop or browser exceptions')
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify({ passed: checks.length === 12 && !errors.length, checks, errors }, null, 2))
  await browser?.close(); await server.close()
}
