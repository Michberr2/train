import { test, expect, type Page } from '@playwright/test'
import { trackErrors, severeErrors } from './_helpers'

async function visitLanding(page: Page) {
  const response = await page.goto('/', { waitUntil: 'load' })
  await expect(page.locator('.nalu-opening')).toHaveCount(0)
  return response
}

// Public scrolling introduction (signed-out). Cheap, no tokens.
test.describe('Landing', () => {
  test('[ux] the Nalu logo intro plays again on every visit', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nalu-opening')).toBeVisible()
    if (process.env.NALU_CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('nalu-intro.png') })
    await page.getByRole('button', { name: 'Skip intro' }).click()
    await expect(page.locator('.nalu-opening')).toHaveCount(0)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.nalu-opening')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skip intro' })).toBeVisible()
  })

  test('[ux] recovery keeps the shared dialog style and keyboard focus', async ({ page }, testInfo) => {
    await visitLanding(page)
    const trigger = page.getByRole('button', { name: 'Sign in', exact: true })
    await trigger.click()
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    const dialog = page.getByRole('dialog', { name: 'Reset password', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Recovery code', exact: true }).click()
    await expect(dialog.getByLabel('Confirm new password', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Back to sign in' }).press('Tab')
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    if (process.env.NALU_CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('nalu-recovery.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('.nalu-landing')).not.toHaveAttribute('inert')
  })

  test('[health] @smoke landing page loads with no severe console errors', async ({ page }) => {
    const errors = trackErrors(page)
    const resp = await visitLanding(page)
    expect(resp?.status(), 'HTTP status').toBeLessThan(400)
    await expect(page).toHaveTitle(/nalu/i)
    // give the SPA a beat to hydrate
    await page.waitForTimeout(1500)
    const severe = severeErrors(errors)
    expect(severe, `console errors:\n${severe.join('\n')}`).toHaveLength(0)
  })

  test('[ux] @smoke primary nav is reachable', async ({ page }, testInfo) => {
    await visitLanding(page)
    // Desktop shows anchor links; smaller viewports use a menu.
    const isMobile = (testInfo.project.use.viewport?.width ?? 1366) <= 900
    if (isMobile) {
      const menuBtn = page.getByRole('button', { name: /open menu|menu/i })
      await expect(menuBtn.first()).toBeVisible()
    } else {
      await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('link', { name: 'The core' })).toBeVisible()
    }
  })

  test('[ux] @smoke no horizontal overflow at this viewport', async ({ page }) => {
    await visitLanding(page)
    await page.waitForTimeout(800)
    const overflow = await page.evaluate(() => {
      const d = document.documentElement
      return d.scrollWidth - d.clientWidth
    })
    expect(overflow, 'horizontal scroll (px past viewport)').toBeLessThanOrEqual(2)
  })

  test('[ux] core follows scroll in both directions and stages can be selected', async ({ page }, testInfo) => {
    await visitLanding(page)
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.nalu-landing')!
      const story = document.querySelector<HTMLElement>('.nalu-manifesto')!
      const top = story.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
      host.scrollTo({ top: top + (story.offsetHeight - host.clientHeight) * .98, behavior: 'instant' })
    })
    await expect.poll(() => page.locator('.nalu-reveal-fill').last().evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(.99)
    const scrollToStage = async (fraction: number) => {
      await page.evaluate(value => {
        const host = document.querySelector<HTMLElement>('.nalu-landing')!
        const core = document.getElementById('platform')!
        const top = core.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
        host.scrollTo({ top: top + (core.offsetHeight - host.clientHeight) * value, behavior: 'instant' })
      }, fraction)
    }
    await scrollToStage(.05)
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '0')
    await expect.poll(() => page.locator('.nalu-node-result .nalu-node-symbol').evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(.05)
    await scrollToStage(.56)
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '2')
    await scrollToStage(.86)
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '3')
    await scrollToStage(.3)
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '1')
    await expect.poll(() => page.locator('.nalu-node-result .nalu-node-symbol').evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(.05)
    await page.getByRole('button', { name: 'Explore persistence and sync', exact: true }).click()
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '3')
    await expect.poll(() => page.locator('.nalu-node-result .nalu-node-symbol').evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(.99)
    if (process.env.NALU_CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('nalu-core.png') })
  })

  test('[ux] sign-in and signup remain available from the new introduction', async ({ page }, testInfo) => {
    await visitLanding(page)
    if (process.env.NALU_CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('nalu-hero.png') })
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Sign in', exact: true })).toBeVisible()
    if (process.env.NALU_CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('nalu-signin.png') })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Meet your Nalu', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create account', exact: true })).toBeVisible()
    if (process.env.NALU_CAPTURE_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('nalu-signup.png') })
  })

  test('[ux] reduced motion skips the intro and keeps core controls usable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await visitLanding(page)
    await expect(page.locator('.nalu-opening')).toHaveCount(0)
    await expect(page.locator('#platform')).toHaveAttribute('data-reduced-motion', 'true')
    await page.getByRole('button', { name: 'Explore persistence and sync', exact: true }).click()
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '3')
    await page.getByRole('button', { name: 'Explore input ingestion', exact: true }).click()
    await expect(page.locator('.nalu-core-diagram')).toHaveAttribute('data-stage', '0')
  })

  test('[ux] capability cards move horizontally with scroll and the rail selects a card', async ({ page }, testInfo) => {
    await visitLanding(page)
    const scrollCapabilities = async (fraction: number) => page.evaluate(value => {
      const host = document.querySelector<HTMLElement>('.nalu-landing')!
      const section = document.getElementById('possibilities')!
      const top = section.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop
      host.scrollTo({ top: top + (section.offsetHeight - host.clientHeight) * value, behavior: 'instant' })
    }, fraction)
    await scrollCapabilities(0)
    await expect(page.locator('#nalu-capability-0')).toHaveClass(/is-active/)
    await scrollCapabilities(.25)
    await expect(page.locator('#nalu-capability-1')).toHaveClass(/is-active/)
    await expect.poll(() => page.locator('.nalu-capabilities-track').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)).toBeLessThan(-200)
    if (process.env.NALU_CAPTURE_SCREENSHOTS) {
      await page.locator('#nalu-capability-1 .nalu-capability-title-fill').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
      await page.screenshot({ path: testInfo.outputPath('nalu-capabilities.png') })
    }
    await page.getByRole('navigation', { name: 'Explore Nalu capabilities' }).getByRole('button', { name: /05 Workspace/ }).click()
    await expect(page.locator('#nalu-capability-4')).toHaveClass(/is-active/)
    await page.getByRole('button', { name: 'Try workspace with Nalu' }).click()
    await expect(page.getByRole('dialog', { name: 'Create account', exact: true })).toBeVisible()
  })
})
