// Real AuthProvider, modal, sync and IndexedDB; only account/data APIs are fixtures.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'

const output = '/tmp/nalu-auth-sync-regressions'
await mkdir(output, { recursive: true })
const root = fileURLToPath(new URL('../client', import.meta.url))
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import AuthProvider,{useAuth}from'/src/components/AuthProvider.tsx';import*as auth from'/src/lib/localAuth.ts';import*as sync from'/src/lib/sync.ts';import*as chats from'/src/lib/chatStore.ts';import'/src/globals.css';
window.authFixture={auth,sync,chats};function Probe(){const{user,signOut,openAuth,updateUser}=useAuth();return <><output aria-label="Current user">{user?.id||'signed out'}</output><button onClick={signOut}>Sign out fixture</button><button onClick={()=>openAuth('signin')}>Open signin</button><button onClick={async()=>{const r=await auth.updateProfile({displayName:'Updated'});if(r.ok)updateUser(r.user)}}>Update profile fixture</button></>};createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><Probe/></AuthProvider></React.StrictMode>);`
const server = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`,
  css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [`${root}/src/**/*.{ts,tsx}`] })] } },
  plugins: [react(), {
  name: 'auth-fixture', resolveId(id) { if (id === '/@auth-fixture') return '\0auth-fixture' },
  load(id) { if (id === '\0auth-fixture') return fixture },
  transform(code, id) { if (id === '\0auth-fixture') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
  configureServer(vite) { vite.middlewares.use('/__auth-test', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__auth-test', '<html><body><div id="root"></div><script type="module" src="/@auth-fixture"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false } })
let browser, base
const report = { passed: false, checks: [] }
const record = name => { report.checks.push(name); console.log(`PASS ${name}`) }
function latch() { let release; const wait = new Promise(r => { release = r }); return { wait, release } }
const user = token => ({ id: token, displayName: `User ${token}` })
const chat = id => ({ id, title: id, createdAt: 1, messages: [{ role: 'assistant', content: `Private ${id}` }] })
async function setup(token = 'A', handler = async () => null) {
  const context = await browser.newContext()
  await context.addInitScript(token => { if (window.top === window && token && !localStorage.getItem('nalu-token')) localStorage.setItem('nalu-token', token) }, token)
  const calls = [], errors = []
  await context.route('**/api/**', async route => {
    const body = route.request().postDataJSON() || {}
    calls.push({ ...body, authorization: route.request().headers().authorization })
    let response = await handler(body, calls)
    if (!response) response = body.action === 'me' ? { user: user(body.token) }
      : body.action === 'signin' ? { ok: true, token: body.email, user: user(body.email) }
      : body.action === 'load' ? { data: { 'nalu-chats': JSON.stringify([chat(body.token)]) } } : { ok: true }
    const { status = 200, ...json } = response
    await route.fulfill({ status, json }).catch(() => {})
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/__auth-test`)
  await page.waitForFunction(() => window.authFixture)
  return { context, page, calls, errors, current: page.getByLabel('Current user') }
}
async function signin(page, account) {
  await page.getByRole('button', { name: 'Open signin', exact: true }).click()
  const form = page.locator('form')
  await form.getByPlaceholder('Email or username').fill(account)
  await form.getByPlaceholder('Password', { exact: true }).fill('fixture-password')
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByLabel('Current user')).toHaveText(account)
}
try {
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
  {
    const held = latch()
    const s = await setup('A', async body => { if (body.action === 'me') { await held.wait; return { user: user('A') } } })
    await s.page.getByRole('button', { name: 'Sign out fixture' }).click()
    held.release()
    await s.page.waitForTimeout(300)
    await expect(s.current).toHaveText('signed out')
    assert.equal(await s.page.evaluate(() => localStorage.getItem('nalu-token')), null)
    assert.deepEqual(s.errors, [])
    record('Late startup identity cannot sign a logged-out user back in')
    await s.context.close()
  }
  {
    const held = latch()
    const s = await setup('A', async body => { if (body.action === 'load' && body.token === 'A') { await held.wait; return { data: { 'nalu-chats': JSON.stringify([chat('A')]), 'nalu-secret-fixture': 'A' } } } })
    await expect.poll(() => s.calls.some(c => c.action === 'load' && c.token === 'A')).toBe(true)
    await s.page.getByRole('button', { name: 'Sign out fixture' }).click()
    await signin(s.page, 'B')
    held.release()
    await s.page.waitForTimeout(700)
    await expect(s.current).toHaveText('B')
    const stores = await s.page.evaluate(async () => ({ local: localStorage.getItem('nalu-chats'), secret: localStorage.getItem('nalu-secret-fixture'), idb: await window.authFixture.chats.idbGetChats() }))
    assert.deepEqual(JSON.parse(stores.local).map(c => c.id), ['B'])
    assert.deepEqual(JSON.parse(stores.idb).map(c => c.id), ['B'])
    assert.equal(stores.secret, null)
    assert.deepEqual(s.errors, [])
    record('Late account-A hydration cannot replace B UI, local data, or full chat cache')
    await s.context.close()
  }
  {
    const s = await setup('A', async body => body.action === 'load' && body.token === 'B' ? { data: {} } : null)
    await expect(s.current).toHaveText('A')
    assert.ok((await s.page.evaluate(() => window.authFixture.chats.idbGetChats())).includes('Private A'))
    await s.page.getByRole('button', { name: 'Sign out fixture' }).click()
    await signin(s.page, 'B')
    assert.equal(await s.page.evaluate(() => window.authFixture.chats.idbGetChats()), null)
    assert.deepEqual(s.errors, [])
    record('An empty new account cannot inherit the previous account’s IndexedDB history')
    await s.context.close()
  }
  {
    const s = await setup('A', async body => body.action === 'load' ? { status: 503, error: 'Temporarily unavailable' } : null)
    await expect(s.current).toHaveText('A')
    await s.page.evaluate(() => window.authFixture.sync.pushChatsFull('[{"id":"incomplete"}]'))
    await s.page.waitForTimeout(850)
    assert.equal(s.calls.some(c => c.action === 'setMany' && c.entries?.['nalu-chats']), false)
    record('Failed hydration never authorizes uploading incomplete chat history')
    await s.context.close()
  }
  {
    let attempts = 0
    const s = await setup('A', async body => body.action === 'setMany' && body.entries?.['nalu-retry-fixture'] && ++attempts === 1 ? { status: 503, error: 'Retry later' } : null)
    await expect(s.current).toHaveText('A')
    await s.page.evaluate(() => localStorage.setItem('nalu-retry-fixture', 'saved value'))
    await expect.poll(() => attempts, { timeout: 6000 }).toBeGreaterThanOrEqual(2)
    assert.ok(s.calls.filter(c => c.entries?.['nalu-retry-fixture']).every(c => c.authorization === 'Bearer A'))
    record('A failed data save retries the exact pending value under its original account')
    await s.context.close()
  }
  {
    const s = await setup('A')
    await expect(s.current).toHaveText('A')
    const second = await s.context.newPage()
    await second.goto(`${base}/__auth-test`)
    await expect(second.getByLabel('Current user')).toHaveText('A')
    await second.getByRole('button', { name: 'Sign out fixture' }).click()
    await expect(s.current).toHaveText('signed out')
    await signin(second, 'B')
    await expect(s.current).toHaveText('B')
    const currentCache = await s.page.evaluate(() => window.authFixture.chats.idbGetChats())
    assert.deepEqual(JSON.parse(currentCache).map(c => c.id), ['B'])
    assert.deepEqual(s.errors, [])
    record('Other tabs follow sign-out and account switching without retaining A’s UI')
    await s.context.close()
  }
  {
    const held = latch()
    const s = await setup('A', async body => {
      if (body.action === 'update-profile') { await held.wait; return { ok: true, user: user('A') } }
    })
    await expect(s.current).toHaveText('A')
    await s.page.getByRole('button', { name: 'Update profile fixture' }).click()
    await expect.poll(() => s.calls.some(c => c.action === 'update-profile')).toBe(true)
    await s.page.getByRole('button', { name: 'Sign out fixture' }).click()
    await signin(s.page, 'B')
    held.release(); await s.page.waitForTimeout(250)
    await expect(s.current).toHaveText('B')
    record('An old profile response cannot replace the current account')
    await s.context.close()
  }
  {
    const s = await setup('A', async body => body.action === 'load' ? { data: { 'nalu-token': 'forged', 'foreign-key': 'ignored', 'nalu-chats': JSON.stringify([chat('A')]) } } : null)
    await expect(s.current).toHaveText('A')
    assert.deepEqual(await s.page.evaluate(() => [localStorage.getItem('nalu-token'), localStorage.getItem('foreign-key')]), ['A', null])
    record('Data hydration cannot overwrite the session token or unrelated browser keys')
    await s.context.close()
  }
  {
    const s = await setup('A')
    await expect(s.current).toHaveText('A')
    await s.page.evaluate(() => localStorage.setItem('nalu-token', 'B'))
    await s.page.reload()
    await expect(s.current).toHaveText('B')
    assert.deepEqual(await s.page.evaluate(async () => ({ owner: localStorage.getItem('nalu-data-owner'), ids: JSON.parse(await window.authFixture.chats.idbGetChats()).map(c => c.id) })), { owner: 'B', ids: ['B'] })
    record('Reload after a token switch clears the old owner before restoring the new account')
    await s.context.close()
  }
  {
    const s = await setup(null, async body => body.action === 'signin' ? { ok: true, token: 'A', user: user('A'), recoveryCode: 'FIXTURE-RECOVERY' } : null)
    await s.page.getByRole('button', { name: 'Open signin', exact: true }).click()
    const form = s.page.locator('form')
    await form.getByPlaceholder('Email or username').fill('A')
    await form.getByPlaceholder('Password', { exact: true }).fill('fixture-password')
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(s.page.getByText('Save your recovery code', { exact: true })).toBeVisible()
    await s.page.evaluate(() => localStorage.setItem('nalu-token', 'B'))
    await s.page.getByRole('button', { name: "I've saved it — continue" }).click()
    await expect(s.page.getByText('The account changed. Please sign in again.')).toBeVisible()
    await expect(s.current).toHaveText('signed out')
    assert.equal(s.calls.some(c => c.action === 'load'), false)
    record('A stale recovery-code confirmation cannot activate a different session')
    await s.context.close()
  }
  {
    const s = await setup(null, async body => body.action === 'request-reset' ? { status: 503, error: 'Unavailable' } : null)
    await s.page.getByRole('button', { name: 'Open signin', exact: true }).click()
    await s.page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
    await s.page.getByPlaceholder('Email or username').fill('fixture@example.test')
    await s.page.getByRole('button', { name: 'Send reset link', exact: true }).click()
    await expect(s.page.getByText('Could not send the reset link. Please try again.')).toBeVisible()
    await expect(s.page.getByText("we've sent a", { exact: false })).toHaveCount(0)
    record('Reset-link failures stay actionable and do not claim an email was sent')
    await s.context.close()
  }
  {
    const s = await setup('A')
    await expect(s.current).toHaveText('A')
    await s.page.goto(base)
    await expect(s.page.getByText('User A', { exact: true })).toBeVisible({ timeout: 30000 })
    await s.page.getByText('A', { exact: true }).first().click()
    await expect(s.page.getByText('Private A', { exact: true })).toBeVisible()
    await s.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await s.page.getByLabel('Main navigation').getByRole('button', { name: 'Sign in', exact: true }).click()
    const form = s.page.locator('form')
    await form.getByPlaceholder('Email or username').fill('B')
    await form.getByPlaceholder('Password', { exact: true }).fill('fixture-password')
    await form.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(s.page.getByText('User B', { exact: true })).toBeVisible()
    await s.page.getByText('B', { exact: true }).first().click()
    await expect(s.page.getByText('Private B', { exact: true })).toBeVisible()
    await expect(s.page.getByText('Private A', { exact: true })).toHaveCount(0)
    await s.page.waitForTimeout(1200)
    const bWrites = s.calls.filter(c => c.action === 'setMany' && c.token === 'B' && c.entries?.['nalu-chats'])
    assert.ok(bWrites.length, 'Actual Workspace must persist B’s history')
    assert.ok(bWrites.every(c => JSON.parse(c.entries['nalu-chats']).every(chat => chat.id === 'B')), 'Old unmount/debounce must not write A’s chat as B')
    await s.page.screenshot({ path: `${output}/workspace-account-b.png` })
    await s.page.reload()
    await expect(s.page.getByText('Private B', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(s.page.getByText('Private A', { exact: true })).toHaveCount(0)
    assert.deepEqual(s.errors, [])
    record('Actual Workspace sign-out/sign-in, debounce, unmount and reload keep A and B histories separate')
    await s.context.close()
  }
  report.passed = true
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser?.close(); await server.close()
}
