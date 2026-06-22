import { test, expect } from '@playwright/test'
import { trackErrors, severeErrors } from './_helpers'

// Public landing deck (signed-out). Cheap, no tokens.
test.describe('Landing', () => {
  test('[health] @smoke landing page loads with no severe console errors', async ({ page }) => {
    const errors = trackErrors(page)
    const resp = await page.goto('/', { waitUntil: 'load' })
    expect(resp?.status(), 'HTTP status').toBeLessThan(400)
    await expect(page).toHaveTitle(/nalu/i)
    // give the SPA a beat to hydrate
    await page.waitForTimeout(1500)
    const severe = severeErrors(errors)
    expect(severe, `console errors:\n${severe.join('\n')}`).toHaveLength(0)
  })

  test('[ux] @smoke primary nav is reachable', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Desktop shows the section tabs; mobile shows a hamburger toggle.
    const isMobile = (testInfo.project.use.viewport?.width ?? 1366) < 768
    if (isMobile) {
      const menuBtn = page.getByRole('button', { name: /open menu|menu/i })
      await expect(menuBtn.first()).toBeVisible()
    } else {
      await expect(page.getByRole('tab').first()).toBeVisible()
    }
  })

  test('[ux] @smoke no horizontal overflow at this viewport', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' })
    await page.waitForTimeout(800)
    const overflow = await page.evaluate(() => {
      const d = document.documentElement
      return d.scrollWidth - d.clientWidth
    })
    expect(overflow, 'horizontal scroll (px past viewport)').toBeLessThanOrEqual(2)
  })
})
