import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const port = 5298, origin = `http://127.0.0.1:${port}`, output = '/private/tmp/nalu-adaptive-workspace-check'
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
  const home = page.getByRole('region', { name: 'Your generative workspace' })
  await expect(home).toBeVisible({ timeout: 45000 })
  await expect(page.getByRole('button', { name: 'Open Nalu chat', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Choose a workspace' })).toHaveCount(0)
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(home.locator('textarea')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Nalu home', exact: true })).toBeVisible()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: no horizontal overflow`)
  }
  report.checks.push('Generative home and real composer fit desktop, tablet and phone without retired lip or carousel')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: `${output}/01-home.png` })
  await page.getByRole('button', { name: 'Account options' }).click()
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click()
  await expect(page.locator('[data-workspace-theme=dark]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('[data-workspace-theme=dark]')).toHaveCount(1)
  report.checks.push('Theme preference survives reload in the generative workspace')
  await page.getByRole('button', { name: 'Account options' }).click()
  await page.getByRole('button', { name: 'Track all agent work', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'All agent work', exact: true })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: 'Everything', exact: true }).click()
  await expect.poll(() => drawer.locator('article').count()).toBeGreaterThan(0)
  await page.screenshot({ path: `${output}/02-work-drawer.png` })
  await drawer.getByRole('button', { name: 'Close work drawer' }).click()
  report.checks.push('Merged Work drawer retains owner-visible jobs, filters, and close behavior')
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Nalu capabilities' })).toBeVisible()
  await page.getByRole('button', { name: /Explore a place/ }).click()
  await expect(home.locator('textarea')).toHaveValue('Show me a map of ')
  await home.locator('textarea').fill('Show me restaurants in Savannah on a map')
  await home.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('[data-block-type=map]')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Map search', exact: true })).toHaveValue('restaurants in Savannah')
  await expect(page.getByRole('button', { name: 'Show Forsyth Park on map', exact: true })).toBeVisible({timeout:30000})
  await page.screenshot({ path: `${output}/03-map.png` })
  await page.getByRole('button', { name: 'Nalu home', exact: true }).click()
  await expect(home).toBeVisible({ timeout: 45000 })
  report.checks.push('Capabilities routes into the real generative map, returns isolated API results, and home preserves the conversation')
  assert.deepEqual(report.errors, [])
  for (const check of report.checks) console.log(`PASS ${check}`)
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser?.close(); server.kill('SIGTERM')
}
