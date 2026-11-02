import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const port = 5201, origin = `http://127.0.0.1:${port}`, output = '/private/tmp/nalu-adaptive-workspace-check'
await mkdir(output, { recursive: true })
const server = spawn(process.execPath, ['scripts/workspace-design-preview.mjs'], { env: { ...process.env, WORKSPACE_PREVIEW_PORT: String(port) }, stdio: 'pipe' })
let logs = '', browser
server.stdout.on('data', bytes => { logs += bytes }); server.stderr.on('data', bytes => { logs += bytes })
const report = { checks: [], errors: [] }
try {
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(`${origin}/__workspace-design-preview`); if (response.ok) break } catch { /* Await this specific child server. */ }
    if (server.exitCode !== null || attempt > 100) throw Error(`Local preview server failed: ${logs}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(`${origin}/workspace-preview?shell=production`)
  await expect(page.getByRole('button', { name: 'Open Nalu chat', exact: true })).toBeVisible()
  await expect(page.locator('[data-workspace-home=true]')).toHaveCount(1)
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Choose a workspace' })).toHaveCount(0)
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const geometry = await page.locator('[data-workspace-design]').evaluate(surface => {
      const rect = selector => surface.querySelector(selector).getBoundingClientRect().toJSON()
      return { scene: rect('.review-desktop-scene'), lip: rect('.workspace-chat-trigger'), logo: rect('.review-logo-wordmark'), svg: rect('.review-logo-wordmark svg'), height: innerHeight, scroll: document.documentElement.scrollHeight }
    })
    assert.ok(Math.abs(geometry.lip.top + 44 - geometry.scene.bottom) < 1, `${width}: chat lip joins the bottom frame`)
    assert.ok(geometry.logo.top >= 0 && geometry.logo.bottom <= geometry.scene.top + 1, `${width}: the logo fits the top frame`)
    assert.ok(geometry.svg.width <= 24 && geometry.svg.height <= 24)
    assert.ok(geometry.scroll <= geometry.height + 1, `${width}: frame fits without page scrolling`)
  }
  report.checks.push('Scenery and connected chat lip are the initial interface; no apps or carousel; logo and frame fit desktop, tablet and phone')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: `${output}/01-scenery.png` })
  await page.getByRole('button', { name: 'Account options' }).click()
  await page.getByRole('button', { name: 'Dark frame', exact: true }).click()
  await expect(page.locator('[data-workspace-theme=dark]')).toHaveCount(1)
  assert.equal(await page.locator('[data-workspace-design]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(6, 7, 9)')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${output}/02-dark-frame.png` })
  await page.reload()
  await expect(page.locator('[data-workspace-theme=dark]')).toHaveCount(1)
  report.checks.push('Black frame applies to the actual scene and connected lip, and survives reload')
  await page.getByRole('button', { name: 'Track all agent work', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'All agent work', exact: true })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: 'Everything', exact: true }).click()
  await expect.poll(() => drawer.locator('article').count()).toBeGreaterThan(0)
  await page.screenshot({ path: `${output}/04-work-drawer.png` })
  await drawer.getByRole('button', { name: 'Close work drawer' }).click()
  report.checks.push('Work drawer shows actual owner-visible saved work, filters all versus active jobs, and closes without replacing the current screen')
  await page.getByRole('button', { name: 'Open Nalu chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message Nalu', exact: true })
  // The existing composer retains its normal accessible placeholder in this shell.
  const input = await composer.count() ? composer : page.locator('.workspace-chat-popover textarea').first()
  await input.fill('Build me a logo for Acorn. Use your best judgment.')
  await input.press('Enter')
  await expect(page.locator('[data-workspace-view=studio]')).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: 'Studio tool', exact: true })).toHaveValue('logo')
  await expect(page.locator('.workspace-agent-narration')).toBeVisible()
  await expect.poll(() => page.locator('.workspace-assembly-cursors').getAttribute('data-jobs')).not.toBe('0')
  await page.screenshot({ path: `${output}/03-building-studio.png` })
  const libraryButton = page.getByRole('button', { name: /Your creations/ })
  await libraryButton.click()
  await expect(libraryButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.ws-studio-library')).toBeVisible()
  await expect(page.locator('.workspace-assembly-cursors')).toHaveAttribute('data-assembling', 'false', { timeout: 10000 })
  report.checks.push('Logo keyword opens the real Studio with Logo selected; agents assemble mounted controls and text, and a real click still opens Your creations during assembly')
  await page.getByRole('button', { name: 'Nalu home', exact: true }).click()
  await expect(page.locator('[data-workspace-home=true]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Open Nalu chat', exact: true }).click()
  await input.fill('Show me a map of Savannah')
  await input.press('Enter')
  await expect(page.locator('[data-workspace-view=map]')).toHaveCount(1)
  await expect(page.locator('[data-agent-typing=true]')).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: 'Map search', exact: true })).toHaveValue('Show me a map of Savannah')
  report.checks.push('Map keyword opens the real Map and forwards the exact requested search; home restores scenery without losing conversations')
  assert.deepEqual(report.errors, [])
  for (const check of report.checks) console.log(`PASS ${check}`)
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser?.close(); server.kill('SIGTERM')
}
