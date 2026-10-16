// Actual AuthProvider + sync + IndexedDB, with synthetic accounts and mocked APIs.
// Covers ownership before online hydration, unowned-cache quarantine/recovery,
// stale recovery, and atomic archive failure. Never contacts an account/provider.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'

const output = process.env.OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'nalu-auth-legacy-'))
await mkdir(output, { recursive: true })
const root = fileURLToPath(new URL('../client', import.meta.url))
const fixture = `import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import AuthProvider,{useAuth}from'/src/components/AuthProvider.tsx';import*as auth from'/src/lib/localAuth.ts';import*as sync from'/src/lib/sync.ts';import*as chats from'/src/lib/chatStore.ts';import'/src/globals.css';
window.authLegacyFixture={auth,sync,chats};
function Probe(){const{user,signOut,openAuth}=useAuth();const[active,setActive]=useState('[]');useEffect(()=>{let live=true;const read=async()=>{const value=user?await chats.idbGetChats()||localStorage.getItem('nalu-chats')||'[]':'[]';if(live)setActive(value)};void read();window.addEventListener('nalu-hydrated',read);window.addEventListener('nalu-session-cleared',read);return()=>{live=false;window.removeEventListener('nalu-hydrated',read);window.removeEventListener('nalu-session-cleared',read)}},[user]);return <><output aria-label="Current user">{user?.id||'signed out'}</output><pre aria-label="Active chats">{active}</pre><button onClick={signOut}>Sign out fixture</button><button onClick={()=>openAuth('signin')}>Open signin</button></>};
createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><Probe/></AuthProvider></React.StrictMode>);`
const server = await createServer({ configFile: false, root, cacheDir: join(output, 'vite-cache'),
  css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [`${root}/src/**/*.{ts,tsx}`] })] } },
  plugins: [react(), {
    name: 'auth-legacy-fixture',
    resolveId(id) { if (id === '/@auth-legacy-fixture') return '\0auth-legacy-fixture' },
    load(id) { if (id === '\0auth-legacy-fixture') return fixture },
    transform(code, id) { if (id === '\0auth-legacy-fixture') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
    configureServer(vite) {
      vite.middlewares.use('/__auth-legacy-seed', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Offline fixture seed</body></html>') })
      vite.middlewares.use('/__auth-legacy-test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__auth-legacy-test', '<html><body><div id="root"></div><script type="module" src="/@auth-legacy-fixture"></script></body></html>')) })
    },
  }], server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false },
})
let browser, base, activePage
const report = { passed: false, checks: [], output }
const record = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`) }
const latch = () => { let release; const wait = new Promise(resolve => { release = resolve }); return { wait, release } }
const user = token => ({ id: token, displayName: `User ${token}` })
const chat = id => ({ id, title: `Private ${id}`, createdAt: 1, messages: [{ role: 'user', content: `Private ${id} question` }] })
const richA = { ...chat('A-known'), messages: [
  { role: 'user', content: 'Private A-known question' },
  { role: 'assistant', content: 'Complete saved reply', doc: { title: 'Recovered document', blocks: [{ type: 'paragraph', text: 'ARTIFACT_END: preserve this supplied document.' }] } },
  { role: 'user', content: 'A later unsynced follow-up' },
] }
const unknown = chat('A-unmatched')
const knownProject = { id: 'project-known', name: 'Local project rename', notes: 'Preserve locally edited notes.' }
const unknownProject = { id: 'project-unmatched', name: 'Private unmatched project' }
const legacyEntries = {
  'nalu-chats': JSON.stringify([chat('A-known'), unknown]),
  'nalu-chat-projects': JSON.stringify([knownProject, unknownProject]),
  'nalu-private-fixture': 'Private unowned setting',
}
const legacyFull = JSON.stringify([richA, unknown])
const knownServer = { 'nalu-chats': JSON.stringify([chat('A-known')]), 'nalu-chat-projects': JSON.stringify([{ id: 'project-known', name: 'Old server name' }]) }

async function setup({ token = 'B', owner, entries = legacyEntries, full = legacyFull, fault, handler = async () => null } = {}) {
  const context = await browser.newContext()
  const calls = [], errors = [], blockedExternal = []
  await context.route(url => url.origin !== base, route => { blockedExternal.push(route.request().url()); return route.abort() })
  await context.route('**/api/**', async route => {
    const body = route.request().postDataJSON() || {}
    calls.push({ ...body, authorization: route.request().headers().authorization })
    let response = await handler(body, calls)
    if (!response) response = body.action === 'me' ? { user: user(body.token) }
      : body.action === 'signin' ? { ok: true, token: body.email, user: user(body.email) }
      : body.action === 'load' ? { data: {} } : { ok: true }
    const { status = 200, ...json } = response
    await route.fulfill({ status, json }).catch(() => {})
  })
  const page = await context.newPage(); activePage = page
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/__auth-legacy-seed`)
  await page.evaluate(async ({ token, owner, entries, full }) => {
    localStorage.clear()
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
    if (token) localStorage.setItem('nalu-token', token)
    if (owner) localStorage.setItem('nalu-data-owner', owner)
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('nalu', 1)
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv') }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('kv', 'readwrite')
        if (full != null) tx.objectStore('kv').put(full, 'chats-full')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
  }, { token, owner, entries, full })
  // Fail or delay only the archive's real IDB operations. App functions and API
  // responses stay intact; a failed put must roll back the real transaction.
  await page.addInitScript(fault => {
    if (window.top !== window) return
    const control = window.legacyIDB = { failArchive: fault === 'archive-failure', holdRecovery: fault === 'delayed-A-recovery', held: [], archiveFailures: 0, delayedReads: 0 }
    const put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'kv' && key === 'chats-unowned-v1' && control.failArchive) {
        control.archiveFailures++
        throw new DOMException('Synthetic archive quota failure', 'QuotaExceededError')
      }
      return put.call(this, value, key)
    }
    IDBObjectStore.prototype.get = function(key) {
      if (this.name === 'kv' && key === 'chats-unowned-v1' && this.transaction.mode === 'readonly'
        && control.holdRecovery && localStorage.getItem('nalu-token') === 'A') {
        const tx = this.transaction, completed = tx.oncomplete
        tx.oncomplete = event => { control.delayedReads++; control.held.push(() => completed?.call(tx, event)) }
      }
      return get.call(this, key)
    }
    control.release = () => { control.holdRecovery = false; for (const finish of control.held.splice(0)) finish() }
  }, fault)
  await page.goto(`${base}/__auth-legacy-test`)
  await page.waitForFunction(() => window.authLegacyFixture)
  return { context, page, calls, errors, blockedExternal, current: page.getByLabel('Current user') }
}
async function state(page) {
  return page.evaluate(async () => {
    const read = key => new Promise((resolve, reject) => {
      const open = indexedDB.open('nalu', 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => { const db = open.result, tx = db.transaction('kv', 'readonly'), req = tx.objectStore('kv').get(key); let value = null; req.onsuccess = () => { value = req.result ?? null }; tx.oncomplete = () => { db.close(); resolve(value) }; tx.onabort = tx.onerror = () => { db.close(); reject(tx.error) } }
    })
    return { owner: localStorage.getItem('nalu-data-owner'), local: localStorage.getItem('nalu-chats'), projects: localStorage.getItem('nalu-chat-projects'), privateSetting: localStorage.getItem('nalu-private-fixture'), active: await read('chats-full'), archive: await read('chats-unowned-v1') }
  })
}
function emptyActive(value) {
  for (const key of ['local', 'active', 'projects']) assert.equal(value[key] == null || value[key] === '[]', true, `${key} contains unowned records`)
  assert.equal(value.privateSetting, null)
}
function archived(value) {
  const records = typeof value.archive === 'string' ? JSON.parse(value.archive) : value.archive
  assert.ok(Array.isArray(records) && records.some(record => record.chats === legacyFull), 'the complete unmatched history must survive in the archive')
  const record = records.find(record => record.chats === legacyFull)
  for (const [key, entry] of Object.entries(legacyEntries)) assert.equal(record.entries[key], entry, `archive lost original ${key}`)
  assert.equal(record.entries['nalu-token'], undefined)
  assert.equal(record.entries['nalu-data-owner'], undefined)
  return records
}
function noAUploads(calls) {
  const uploads = calls.filter(call => call.action === 'setMany' && call.token === 'B')
  assert.ok(uploads.every(call => ['A-known', 'A-unmatched', 'project-known', 'project-unmatched', 'Private unowned'].every(marker => !JSON.stringify(call.entries).includes(marker))), 'private A data was uploaded with B credentials')
}
async function signin(page, account) {
  await page.getByRole('button', { name: 'Open signin', exact: true }).click()
  const form = page.locator('form')
  await form.getByPlaceholder('Email or username').fill(account)
  await form.getByPlaceholder('Password', { exact: true }).fill('fixture-password')
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Current user')).toHaveText(account)
}
async function finish(s) { assert.deepEqual(s.errors, []); assert.deepEqual(s.blockedExternal, []); await s.context.close() }

try {
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
  {
    const held = latch()
    const s = await setup({ owner: 'A', handler: async body => { if (body.action === 'me') { await held.wait; return { user: user('B') } } } })
    await expect.poll(() => s.calls.some(call => call.action === 'me')).toBe(true)
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')))
    await s.page.waitForTimeout(900)
    assert.equal(s.calls.some(call => call.action === 'load' || call.action === 'setMany'), false, 'online must not authorize hydration before identity/owner verification')
    assert.equal((await state(s.page)).owner, 'A')
    held.release(); await expect(s.current).toHaveText('B')
    emptyActive(await state(s.page)); noAUploads(s.calls)
    record('Online before held identity cannot load or upload the previous owner’s data')
    await finish(s)
  }
  {
    const s = await setup()
    await expect(s.current).toHaveText('B')
    const before = await state(s.page)
    assert.equal(before.owner, 'B'); emptyActive(before); archived(before)
    await expect(s.page.getByLabel('Active chats')).not.toContainText('A-known')
    await s.page.waitForTimeout(800); noAUploads(s.calls)
    await s.page.reload(); await expect(s.current).toHaveText('B')
    const after = await state(s.page)
    emptyActive(after); assert.deepEqual(after.archive, before.archive)
    record('Empty B account quarantines legacy A history without exposing, uploading, or discarding it')
    await finish(s)
  }
  {
    const s = await setup({ token: 'A', handler: async body => body.action === 'load' ? { data: knownServer } : null })
    await expect(s.current).toHaveText('A')
    const recovered = await state(s.page)
    assert.deepEqual(JSON.parse(recovered.active), [richA])
    assert.deepEqual(JSON.parse(recovered.local), [richA])
    assert.deepEqual(JSON.parse(recovered.projects).map(({ _projectSync, ...project }) => project), [knownProject])
    archived(recovered)
    await expect(s.page.getByLabel('Active chats')).toContainText('ARTIFACT_END')
    await expect(s.page.getByLabel('Active chats')).not.toContainText('A-unmatched')
    await s.page.evaluate(async () => window.authLegacyFixture.sync.pushChatsFull(await window.authLegacyFixture.chats.idbGetChats()))
    await expect.poll(() => s.calls.some(call => call.action === 'setMany' && call.entries?.['nalu-chats'])).toBe(true)
    const uploads = s.calls.filter(call => call.action === 'setMany')
    assert.ok(uploads.every(call => call.token === 'A' && call.authorization === 'Bearer A' && !JSON.stringify(call.entries).includes('unmatched')))
    assert.deepEqual(JSON.parse(uploads.find(call => call.entries?.['nalu-chats']).entries['nalu-chats']), [richA])
    record('Only server-known IDs recover full artifacts and the local project rename; unmatched records stay archived')
    await finish(s)
  }
  {
    const s = await setup({ token: 'A', fault: 'delayed-A-recovery', handler: async body => body.action === 'load' && body.token === 'A' ? { data: knownServer } : null })
    await expect.poll(() => s.page.evaluate(() => window.legacyIDB.delayedReads)).toBeGreaterThan(0)
    await signin(s.page, 'B')
    await s.page.evaluate(() => window.legacyIDB.release())
    await s.page.waitForTimeout(800)
    await expect(s.current).toHaveText('B')
    emptyActive(await state(s.page)); archived(await state(s.page)); noAUploads(s.calls)
    await expect(s.page.getByLabel('Active chats')).not.toContainText('A-known')
    record('A recovery finishing after a B sign-in cannot enter B UI, active caches, or uploads')
    await finish(s)
  }
  {
    const s = await setup({ fault: 'archive-failure' })
    await expect.poll(() => s.page.evaluate(() => window.legacyIDB.archiveFailures)).toBeGreaterThan(0)
    await expect(s.current).toHaveText('signed out')
    const failed = await state(s.page)
    assert.equal(failed.owner, null)
    assert.equal(failed.local, legacyEntries['nalu-chats'])
    assert.equal(failed.projects, legacyEntries['nalu-chat-projects'])
    assert.equal(failed.active, legacyFull)
    assert.equal(failed.privateSetting, legacyEntries['nalu-private-fixture'])
    assert.equal(s.calls.some(call => call.action === 'load' || call.action === 'setMany'), false)
    await expect(s.page.getByRole('alert')).toBeVisible()
    await s.page.screenshot({ path: join(output, 'archive-failure.png') })
    await s.page.evaluate(() => { window.legacyIDB.failArchive = false })
    await s.page.getByRole('button', { name: /retry/i }).click()
    await expect(s.current).toHaveText('B')
    const retried = await state(s.page)
    emptyActive(retried); archived(retried); noAUploads(s.calls)
    record('Failed quarantine preserves originals and blocks account activation; visible retry completes safely')
    await finish(s)
  }
  report.passed = true
} catch (error) {
  report.error = error.stack || error.message
  await activePage?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser?.close(); await server.close()
  console.log(`Auth legacy evidence: ${output}`)
}
