// Current SlidesCard/Studio UI, representative local pitch fixture, no providers.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
const base = process.env.BASE_URL || 'http://127.0.0.1:5180'
const origin = new URL(base).origin
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname))
const output = '/tmp/nalu-slide-audit'
await mkdir(output, { recursive: true })
import { deck, brand } from './slide-browser-fixture.mjs'
const browser = await chromium.launch()
const report = []
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = [], blocked = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(({ deck, brand }) => {
      localStorage.setItem('nalu-token', 'offline-slide-audit')
      localStorage.setItem('nalu-theme', 'dark')
      localStorage.setItem('nalu-view', 'studio')
      localStorage.setItem('nalu-active-brand', JSON.stringify(brand))
      localStorage.setItem('nalu-chats', JSON.stringify([{ id: 'slide-audit', title: deck.title, createdAt: Date.now(), messages: [{ role: 'user', content: 'Show the saved pitch fixture.' }, { role: 'assistant', content: '', deck }] }]))
    }, { deck, brand })
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) { blocked.push(url.hostname); return route.abort() }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (url.pathname === '/api/auth') return route.fulfill({ json: { ok: true, user: { id: 'slide-fixture', displayName: 'Slide audit' } } })
      if (url.pathname === '/api/data') return route.fulfill({ json: { ok: true, data: {}, activity: [] } })
      if (['/api/chat', '/api/slides', '/api/image', '/api/design'].includes(url.pathname)) { blocked.push(url.pathname); return route.abort() }
      return route.fulfill({ json: { ok: true, outputs: [], items: [], connections: [] } })
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const gallery = page.getByRole('button').filter({ has: page.getByText(deck.title, { exact: true }) }).last()
    await gallery.waitFor({ timeout: 25000 })
    await gallery.click()
    await page.getByRole('button', { name: 'Download PDF', exact: true }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    const overlay = page.locator('div.fixed.inset-0.z-50').last()
    const card = overlay.locator('div.my-4.border-y').last()
    const metrics = await card.evaluate((card) => {
      const panels = [...card.querySelectorAll('[class*="aspect-"]')]
      return {
        controls: [...card.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') || button.innerText),
        editors: card.querySelectorAll('input,textarea,[contenteditable="true"]').length,
        images: [...card.querySelectorAll('img')].map((img) => ({ alt: img.alt, isBrand: img.src.startsWith('data:image/svg'), filter: getComputedStyle(img).filter })),
        panels: panels.map((panel, index) => {
          const box = panel.getBoundingClientRect()
          const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
          const outside = []
          let node
          while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue
            const range = document.createRange(); range.selectNodeContents(node)
            for (const rect of range.getClientRects()) if (rect.right > box.right + 1 || rect.left < box.left - 1 || rect.bottom > box.bottom + 1 || rect.top < box.top - 1) { outside.push(node.textContent.trim().slice(0, 80)); break }
          }
          return { index, width: Math.round(box.width), height: Math.round(box.height), aspect: +(box.width / box.height).toFixed(2), outside }
        }),
      }
    })
    await page.screenshot({ path: `${output}/${viewport.width}-cover.png` })
    const panels = card.locator('[class*="aspect-"]')
    await panels.nth(2).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${output}/${viewport.width}-kpis.png` })
    await panels.nth(4).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${output}/${viewport.width}-chart.png` })
    const dialogRole = await overlay.getAttribute('role')
    await page.keyboard.press('Escape')
    const escapeCloses = !(await overlay.isVisible())
    if (!escapeCloses) {
      await page.evaluate((brand) => {
        localStorage.setItem('nalu-active-brand', JSON.stringify({ ...brand, dark: 'F5F5EF' }))
        window.dispatchEvent(new StorageEvent('storage', { key: 'nalu-active-brand' }))
      }, brand)
      await panels.first().scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${output}/${viewport.width}-light-cover-brand.png` })
      metrics.lightCoverLogo = await panels.first().locator('img').evaluate((img) => ({ background: getComputedStyle(img.parentElement).backgroundColor, filter: getComputedStyle(img).filter }))
    }
    report.push({ viewport, metrics, dialogRole, escapeCloses, errors, blocked: [...new Set(blocked)] })
    await page.close()
  }
  await writeFile(`${output}/report.json`, JSON.stringify({ deck, report }, null, 2))
  console.log(JSON.stringify({ output, report }, null, 2))
} finally { await browser.close() }
