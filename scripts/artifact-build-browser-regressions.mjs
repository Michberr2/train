import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

// Test the actual minified embedded builder in an opaque artifact iframe.
// No model, provider, account, browser storage, or network is involved.
const bundle = await build({ entryPoints: ['client/src/components/workspace/agentBuiltPreview.ts'], bundle: true, write: false, format: 'esm', minify: true })
const { agentBuiltPreview } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const output = '/private/tmp/nalu-artifact-build-check', report = { checks: [], errors: [] }
await mkdir(output, { recursive: true })
const original = `<!doctype html><html><head><style>body{margin:0;font:16px system-ui;background:#f9f3e9;color:#173e39}header{padding:24px;background:#173e39;color:white}main{padding:40px}h1{font-size:52px}section{min-height:650px}button{padding:12px;border-radius:12px}input{padding:12px}p{max-width:600px}</style></head><body><header>ACORN COFFEE</header><main><section><h1>Fresh coffee. Good company.</h1><p>Roasted in Portland. A place to slow down, find your favorite cup, and stay a while.</p><button onclick="document.querySelector('#result').textContent='Ordered locally'">Order coffee</button><p id="result"></p><input aria-label="Your name" value="Keep this value"></section><section id="second"><h2>Meet your next favorite roast.</h2>${Array.from({ length: 12 }, (_, i) => `<p>Roast ${i + 1}: real product copy kept in the saved artifact.</p>`).join('')}</section></main></body></html>`
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="90"><rect width="150" height="90" fill="#c49161"/><circle cx="75" cy="45" r="25" fill="#173e39"/></svg>')
const document = agentBuiltPreview(original.replace('</h1>', `</h1><img src="${image}" width="150" height="90" alt="Coffee artwork">`))
assert.equal(original.includes('naluOutputCursors'), false)
const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
let browser
try {
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message))
  await context.route('**/*', route => route.abort())
  await page.setContent(`<iframe title="Real generated page" sandbox="allow-scripts allow-forms" style="width:100%;height:800px;border:0" srcdoc="${escape(document)}"></iframe>`)
  const frame = page.frameLocator('iframe'), canvas = frame.locator('[data-nalu-output-cursors]')
  await expect(canvas).toHaveCount(1)
  await expect.poll(() => canvas.getAttribute('data-jobs')).not.toBe('0')
  await page.screenshot({ path: output + '/01-cursors-building.png' })
  await expect(frame.getByRole('heading', { name: 'Fresh coffee. Good company.' })).toBeVisible()
  await expect(frame.locator('html')).toHaveAttribute('data-nalu-output-building', 'false')
  assert.equal(await frame.getByRole('textbox', { name: 'Your name' }).inputValue(), 'Keep this value')
  await expect(frame.getByRole('img', { name: 'Coffee artwork' })).toHaveCSS('scale', 'none')
  await expect(frame.getByRole('img', { name: 'Coffee artwork' })).toHaveCSS('width', '150px')
  await frame.locator('main').dispatchEvent('pointerdown')
  await expect(canvas).toHaveCount(1)
  const count = Number(await canvas.getAttribute('data-jobs'))
  await frame.locator('#second').scrollIntoViewIfNeeded()
  await expect.poll(async () => Number(await canvas.getAttribute('data-jobs'))).toBeGreaterThan(count)
  await expect(frame.getByRole('heading', { name: 'Meet your next favorite roast.' })).toBeVisible()
  await expect(frame.locator('html')).toHaveAttribute('data-nalu-output-building', 'false')
  assert.equal(await frame.locator('#second p').count(), 12)
  report.checks.push('The minified builder assembles real text and images as they enter the viewport, preserves copy/form values/image size, and keeps building after touching page space to scroll')
  await frame.getByRole('button', { name: 'Order coffee' }).click()
  await expect(canvas).toHaveCount(0)
  await expect(frame.locator('#result')).toHaveText('Ordered locally')
  report.checks.push('User interaction immediately restores the page and stops the cursors; authored button behavior still works')
  await page.screenshot({ path: output + '/02-finished-page.png' })
  await context.close()
  const reduced = await browser.newContext({ reducedMotion: 'reduce' })
  const reducedPage = await reduced.newPage(); reducedPage.on('pageerror', error => report.errors.push(error.message))
  await reducedPage.setContent(`<iframe sandbox="allow-scripts" srcdoc="${escape(document)}"></iframe>`)
  await expect(reducedPage.frameLocator('iframe').getByRole('heading', { name: 'Fresh coffee. Good company.' })).toBeVisible()
  await expect(reducedPage.frameLocator('iframe').locator('[data-nalu-output-cursors]')).toHaveCount(0)
  report.checks.push('Reduced motion shows the complete real page immediately without animated cursors')
  assert.deepEqual(report.errors, [])
  for (const check of report.checks) console.log('PASS ' + check)
} finally { await writeFile(output + '/report.json', JSON.stringify(report, null, 2)); await browser?.close() }
