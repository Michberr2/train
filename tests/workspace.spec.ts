import { test, expect } from '@playwright/test'
import { getToken, gotoWorkspace, trackErrors, severeErrors, RUN_FULL } from './_helpers'

// Signed-in workspace. Requires the studio account (auto-created on first run).
test.describe('Workspace', () => {
  test('[health] @smoke signed-in workspace loads (composer present)', async ({ page, request }) => {
    const token = await getToken(request)
    test.skip(!token, 'auth unavailable — cannot sign in')
    const errors = trackErrors(page)
    await gotoWorkspace(page, token!)
    // The composer textarea is the heart of the workspace.
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1000)
    const severe = severeErrors(errors)
    expect(severe, `console errors:\n${severe.join('\n')}`).toHaveLength(0)
  })

  test('[mobile] @smoke right drawer is hidden + no horizontal scroll on phone', async ({ page, request }, testInfo) => {
    test.skip((testInfo.project.use.viewport?.width ?? 1366) >= 768, 'mobile project only')
    const token = await getToken(request)
    test.skip(!token, 'auth unavailable')
    await gotoWorkspace(page, token!)
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
    // No element should be a fixed right-side drawer wider than 0 on mobile.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    test.info().annotations.push({ type: 'metric', description: `horizontal overflow ${overflow}px` })
    expect(overflow, 'horizontal scroll on mobile').toBeLessThanOrEqual(2)
    // The attachment drawer aside (border-l / w-80) must not be visible on phones.
    const drawer = page.locator('aside.w-80')
    if (await drawer.count()) await expect(drawer.first()).toBeHidden()
  })

  test('[health] generating a shopping list renders a card', async ({ page, request }, testInfo) => {
    test.skip(!RUN_FULL, 'token-spending — run with npm run studio:full')
    test.skip((testInfo.project.use.viewport?.width ?? 1366) < 768, 'desktop project only')
    const token = await getToken(request)
    test.skip(!token, 'auth unavailable')
    await gotoWorkspace(page, token!)
    const composer = page.locator('textarea').first()
    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    await composer.fill('shopping list for a small home office')
    await composer.press('Enter')
    // The card surfaces a "Shop" link once the list renders.
    await expect(page.getByText(/shop/i).first()).toBeVisible({ timeout: 110_000 })
  })
})
