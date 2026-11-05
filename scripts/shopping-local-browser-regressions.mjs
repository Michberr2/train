// Real ShoppingCard rendering, CPU-only Chromium, and an all-network-denied
// browser. No API mocks, model generation, source photos, or cloud requests.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const cardPath = resolve(root, 'client/src/components/workspace/StudioCards.tsx')
const cardSource = await readFile(cardPath, 'utf8')
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ShoppingCard } from './client/src/components/workspace/StudioCards';
const root = createRoot(document.getElementById('root'));
let sequence = 0;
window.renderShopping = (art, reopen = false) => {
  if (reopen) sequence++;
  flushSync(() => root.render(<ShoppingCard key={sequence} art={art} />));
};
`
const compiled = await build({ stdin: { contents: harness, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const css = (await postcss([tailwind({ ...tailwindConfig, content: [{ raw: cardSource, extension: 'tsx' }] })]).process(await readFile(resolve(root, 'client/src/globals.css'), 'utf8'), { from: resolve(root, 'client/src/globals.css') })).css + '\n' + await readFile(resolve(root, 'client/src/components/workspace/workspace-avatar.css'), 'utf8')
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-webgpu'] })
const output = process.env.SHOPPING_TEST_OUTPUT
if (output) await mkdir(output, { recursive: true })
const art = {
  kind: 'shopping', title: 'Quiet reading room', summary: 'A warm corner for reading.', budget: '$640',
  items: [
    { name: 'Sage reading chair', category: 'Seating', reason: 'Compact seat beside the window.', price: '$400', retailer: 'IKEA', query: 'sage chair & cushion' },
    { name: 'Oak side table', category: 'Tables', reason: 'A place for a book.', price: '$240', retailer: 'Example shop', query: 'oak side table' },
  ],
}
try {
  for (const [name, preferences] of [['fresh', null], ['enabled', { enabled: true, profile: 'automatic' }], ['paused', { enabled: false, profile: 'balanced' }]]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, serviceWorkers: 'block' })
    const requests = [], errors = []
    // This route handles the fixture document entirely in-process. All other
    // attempted requests are recorded and aborted before any external I/O.
    await context.route('**/*', route => {
      if (route.request().isNavigationRequest() && route.request().url() === 'http://shopping-card.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Shopping regression</title></head><body><main id="root" class="nalu-workspace" data-workspace-theme="light" style="max-width:900px;margin:24px auto"></main></body></html>' })
      requests.push({ url: route.request().url(), type: route.request().resourceType() })
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://shopping-card.test/')
    await page.evaluate(preferences => {
      if (preferences) localStorage.setItem('device-local-ai-v1', JSON.stringify(preferences))
      window.resourceAttributes = []
      const record = element => {
        if (!(element instanceof Element)) return
        // Include SVG href/image and CSS url() additions, including attributes
        // removed before assertions. Anchors are deliberately user actions.
        for (const node of [element, ...element.querySelectorAll('*')]) for (const attribute of node.attributes) {
          if (['src', 'srcset', 'poster', 'data'].includes(attribute.name) || (attribute.name.endsWith('href') && node.tagName.toLowerCase() !== 'a') || (attribute.name === 'style' && /url\(/i.test(attribute.value))) window.resourceAttributes.push(attribute.value)
        }
      }
      new MutationObserver(records => { for (const recordEntry of records) { if (recordEntry.type === 'attributes') record(recordEntry.target); else for (const node of recordEntry.addedNodes) record(node) } }).observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true })
    }, preferences)
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    await page.evaluate(art => window.renderShopping(art), art)
    await expect(page.getByRole('img', { name: 'Room planning illustration' })).toBeVisible()
    await expect(page.getByText('2 items · 2 categories', { exact: true })).toBeVisible()
    await expect(page.getByText(art.summary, { exact: true })).toBeVisible()
    await expect(page.locator('[data-shopping-item-placeholder]')).toHaveCount(2)
    assert.equal(await page.locator('#root img').count(), 0, 'Viewing a text-only shopping plan must not invent photo URLs')
    const chair = page.getByRole('link', { name: 'Find Sage reading chair', exact: true })
    assert.equal(await chair.getAttribute('href'), 'https://www.ikea.com/us/en/search/?q=sage%20chair%20%26%20cushion')
    assert.equal(await chair.getAttribute('target'), '_blank')
    assert.equal(await chair.getAttribute('rel'), 'noopener noreferrer')
    assert.equal(await page.getByRole('link', { name: 'Find Oak side table', exact: true }).getAttribute('href'), 'https://www.google.com/search?tbm=shop&q=oak%20side%20table')
    await expect(page.getByRole('button', { name: 'Copy list' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Walk the room in 3D/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Walkthrough video/ })).toBeVisible()
    if (output && name === 'fresh') {
      await page.screenshot({ path: resolve(output, 'shopping-light.png'), fullPage: true })
      await page.evaluate(() => { document.documentElement.classList.add('dark'); document.getElementById('root').dataset.workspaceTheme = 'dark' })
      await page.screenshot({ path: resolve(output, 'shopping-dark.png'), fullPage: true })
    }
    // Editing and reopening saved artifacts used to issue new remote prompts.
    const updated = { ...art, title: 'Reopened room', items: [{ name: '<img src="https://image.pollinations.ai/prompt/private">', category: 'Notes', query: 'chair & <script>' }] }
    await page.evaluate(art => window.renderShopping(art), updated)
    await expect(page.getByText(updated.items[0].name, { exact: true })).toBeVisible()
    await page.evaluate(art => window.renderShopping(art, true), updated)
    await expect(page.locator('[data-shopping-item-placeholder]')).toHaveCount(1)
    assert.equal(await page.locator('#root img').count(), 0)
    assert.equal(await page.getByRole('link', { name: `Find ${updated.items[0].name}`, exact: true }).getAttribute('href'), 'https://www.google.com/search?tbm=shop&q=chair%20%26%20%3Cscript%3E')
    await page.evaluate(() => window.renderShopping({ kind: 'shopping', items: [] }, true))
    await expect(page.getByText('0 items · 0 categories', { exact: true })).toBeVisible()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await page.evaluate(() => window.resourceAttributes), [], 'No resource URL should be formed even when no network request is sent')
    assert.deepEqual(requests, [], 'Mount, edit, reopen, and empty state must make no automatic network request')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`PASS ${name}: real ShoppingCard retains links and controls, forms no resource URLs, makes no network requests`)
  }
  console.log('PASS ShoppingCard local preview regression; Chromium GPU disabled; no model inference or remote calls')
} finally {
  await browser.close()
}
