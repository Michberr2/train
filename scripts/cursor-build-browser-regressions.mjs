import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'vite'
import { transform } from 'esbuild'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../client', import.meta.url))
const output = process.env.NALU_CURSOR_OUTPUT || '/private/tmp/nalu-cursor-build-regressions'
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import LandingPage from '/src/components/landing/LandingPage.tsx';import AuthProvider from '/src/components/AuthProvider.tsx';import ThemeProvider from '/src/components/ThemeProvider.tsx';import '/src/globals.css';createRoot(document.getElementById('root')).render(<ThemeProvider><AuthProvider><LandingPage/></AuthProvider></ThemeProvider>);`
const server = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`,
  css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [`${root}/src/**/*.{ts,tsx}`] })] } },
  plugins: [react(), { name: 'real-cursor-build-check',
    resolveId(id) { if (id === '/@cursor-check') return '\0cursor-check' },
    load(id) { if (id === '\0cursor-check') return entry },
    transform(code, id) { if (id === '\0cursor-check') return transform(code, { loader: 'jsx', jsx: 'automatic' }) },
    configureServer(vite) { vite.middlewares.use('/__cursor-check', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__cursor-check', '<html><body><div id="root"></div><script type="module" src="/@cursor-check"></script></body></html>'))
    }) },
  }], server: { middlewareMode: true, hmr: false },
})
const host = createHttpServer((req, res) => server.middlewares(req, res))
let browser
const report = { passed: false, checks: [], screenshots: [], errors: [], unexpectedNetwork: [] }
const record = text => { report.checks.push(text); console.log(`PASS ${text}`) }
try {
  await mkdir(output, { recursive: true })
  await new Promise((resolve, reject) => { host.once('error', reject); host.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${host.address().port}`
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === base || url.protocol === 'data:') return route.continue()
    report.unexpectedNetwork.push(url.origin + url.pathname); return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(`${base}/__cursor-check`)
  await expect(page.locator('.nalu-landing')).toHaveAttribute('data-motion', 'full')
  await expect(page.locator('.nalu-intro-layer')).toHaveCount(0, { timeout: 10000 })
  const photo = page.locator('.nalu-hero > .nalu-scene')
  const copy = page.locator('.nalu-hero h1 .nalu-build-written')
  const typed = () => copy.evaluateAll(elements => elements.map(el => el.textContent).join('').length)
  report.crewSize = Number(await page.locator('.nalu-cursor-builders').getAttribute('data-crew-size'))
  assert.ok(report.crewSize >= 200, 'Hundreds of agent jobs must be assigned to actual page pieces')
  await expect.poll(() => photo.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
  assert.equal(await typed(), 0)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  const header = page.locator('.nalu-landing-header'), headerBox = await header.boundingBox()
  assert.equal(await header.evaluate(el => getComputedStyle(el).backdropFilter), 'none', 'The fixed header does not sample moving construction layers')
  assert.ok(await header.evaluate(el => Number(getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.[3] ?? 1) <= .3), 'The header remains visibly transparent over the scene')
  await page.screenshot({ path: `${output}/01-header-only.png` }); report.screenshots.push('01-header-only.png')
  record('After the retained loading screen, only the header and scroll cue are visible')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  record('Sign-in remains reachable before the page is constructed')
  await page.locator('.nalu-landing').evaluate(el => { el.scrollTop = 64 })
  await expect.poll(() => photo.evaluate(el => Number(getComputedStyle(el).opacity)), { timeout: 4000 }).toBeGreaterThan(.9)
  const firstWidth = await photo.evaluate(el => el.getBoundingClientRect().width)
  assert.ok(firstWidth < 1440 * .6, 'The imported background begins as a real thumbnail-sized element')
  await page.screenshot({ path: `${output}/02-background-import.png` }); report.screenshots.push('02-background-import.png')
  await expect.poll(typed, { timeout: 6000 }).toBeGreaterThan(1)
  const firstTyped = await typed()
  await expect.poll(typed, { timeout: 6000 }).toBeGreaterThan(firstTyped)
  assert.equal(await page.locator('.nalu-landing').evaluate(el => el.scrollTop), 64)
  await page.screenshot({ path: `${output}/03-agents-typing.png` }); report.screenshots.push('03-agents-typing.png')
  record('Independent agent clocks continue typing after scrolling stops')
  await expect.poll(() => photo.evaluate(el => el.getBoundingClientRect().width), { timeout: 6000 }).toBeGreaterThan(1435)
  await expect.poll(typed, { timeout: 10000 }).toBe('You dream it.Nalu does it.'.replace(/\s/g, '').length)
  await expect.poll(() => page.locator('.nalu-hero-actions button').first().evaluate(el => el.inert)).toBe(false)
  await expect.poll(() => page.locator('.nalu-hero .nalu-build-copy').evaluateAll(elements => elements.every(el => el.getAttribute('aria-label').replace(/\s/g, '') === Array.from(el.querySelectorAll('.nalu-build-written')).map(word => word.textContent).join(''))), { timeout: 20000 }).toBe(true)
  await expect(page.locator('.nalu-hero .nalu-build-word[data-alignment="placing"]')).toHaveCount(0)
  await page.screenshot({ path: `${output}/04-built-hero.png` }); report.screenshots.push('04-built-hero.png')
  record('The background is dragged and resized into place; text and controls finish as the actual interactive page')
  assert.deepEqual(await header.boundingBox(), headerBox, 'The header keeps its geometry while agents resize the page')
  await page.locator('.nalu-landing').evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.getByRole('link', { name: 'Nalu home', exact: true }).click()
  await expect.poll(() => page.locator('.nalu-landing').evaluate(el => el.scrollTop)).toBe(0)
  assert.deepEqual(await header.boundingBox(), headerBox)
  record('The header stays fixed and its home link returns to the actual top of the construction scene')
  const pointer = await readFile(`${root}/public/cursors/nalu-pointer.svg`, 'utf8')
  assert.match(pointer, /fill="#090b0d"/); assert.match(pointer, /stroke="#fff"/)
  assert.ok(!/blue|#0af|#00f|#3b82f6/i.test(pointer))
  assert.match(await page.locator('.nalu-header-signin').evaluate(el => getComputedStyle(el).cursor), /nalu-pointer\.svg/)
  record('The landing cursor uses the shared rounded black pointer with a white outline')
  await page.locator('.nalu-motion-toggle').click()
  await expect(page.locator('.nalu-cursor-builders')).toHaveCount(0)
  assert.equal(await typed(), 'Youdreamit.Naludoesit.'.length)
  record('Pausing motion reveals complete content and clears construction effects')
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedNetwork, [])
  await context.close()
  const crewContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' })
  const crewPage = await crewContext.newPage()
  crewPage.on('pageerror', error => report.errors.push(error.message))
  await crewPage.clock.install()
  await crewPage.goto(`${base}/__cursor-check`)
  await expect(crewPage.locator('.nalu-landing')).toBeVisible()
  await crewPage.clock.runFor(3000)
  const scroll = async (selector, fraction = 0) => {
    await crewPage.locator(selector).evaluate((target, fraction) => {
      const host = document.querySelector('.nalu-landing')
      const top = target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
      host.scrollTop = top + Math.max(0, target.offsetHeight - host.clientHeight) * fraction
      host.dispatchEvent(new Event('scroll'))
    }, fraction)
    await crewPage.clock.runFor(100)
    await crewPage.clock.fastForward(20000)
    await crewPage.clock.runFor(32)
  }
  await crewPage.locator('.nalu-landing').evaluate(el => { el.scrollTop = 64; el.dispatchEvent(new Event('scroll')) })
  await crewPage.clock.runFor(100)
  await crewPage.clock.fastForward(20000)
  await crewPage.clock.runFor(32)
  await scroll('.nalu-manifesto')
  await scroll('.nalu-process')
  for (const fraction of [0, .25, .5, .75, 1]) await scroll('.nalu-capabilities', fraction)
  await scroll('.nalu-landing-footer')
  report.remainingBySection = await crewPage.locator('.nalu-build-word[data-alignment="placing"]').evaluateAll(elements => elements.reduce((counts, element) => { const section = element.closest('section,footer'); const name = section?.id || section?.className || 'unknown'; counts[name] = (counts[name] || 0) + 1; return counts }, {}))
  await expect(crewPage.locator('.nalu-build-word[data-alignment="placing"]')).toHaveCount(0)
  const complete = await crewPage.locator('.nalu-build-copy').evaluateAll(elements => elements.every(el =>
    el.getAttribute('aria-label').replace(/\s/g, '') === Array.from(el.querySelectorAll('.nalu-build-written')).map(word => word.textContent).join('')))
  assert.equal(complete, true)
  await crewPage.screenshot({ path: `${output}/06-built-footer.png` }); report.screenshots.push('06-built-footer.png')
  record('Hundreds of real text/layout jobs complete across the whole scroll story and every capability card')
  await crewContext.close()
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', isMobile: true })
  const small = await mobile.newPage()
  small.on('pageerror', error => report.errors.push(error.message))
  await small.goto(`${base}/__cursor-check`)
  await expect(small.locator('.nalu-cursor-builders')).toHaveCount(0)
  await expect(small.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(small.locator('.nalu-hero h1')).toBeVisible()
  assert.ok(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
  await small.screenshot({ path: `${output}/05-mobile-reduced-motion.png` }); report.screenshots.push('05-mobile-reduced-motion.png')
  record('Mobile and reduced-motion visitors get immediate, readable content without overflow')
  assert.deepEqual(report.errors, [])
  await mobile.close(); report.passed = true
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser?.close()
  if (host.listening) await new Promise(resolve => host.close(resolve))
  await server.close()
}
