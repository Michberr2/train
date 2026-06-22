import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { getToken, gotoWorkspace } from './_helpers'

// ADA / WCAG 2.1 AA accessibility scan via axe-core. Reports concrete
// violations (rule + where) so non-compliant spots are actionable.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

function summarize(violations: { id: string; impact?: string; nodes: unknown[]; help: string }[]) {
  return violations
    .map((v) => `${v.id} [${v.impact || 'n/a'}] ×${v.nodes.length} — ${v.help}`)
    .join('\n')
}

test.describe('Accessibility (ADA / WCAG 2.1 AA)', () => {
  test('[a11y] @smoke landing page has no serious/critical WCAG violations', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' })
    await page.waitForTimeout(1200)
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    test.info().annotations.push({ type: 'metric', description: `${results.violations.length} total, ${serious.length} serious/critical` })
    expect(serious, `serious/critical WCAG violations:\n${summarize(serious)}`).toHaveLength(0)
  })

  test('[a11y] landing — full WCAG report (all impacts)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' })
    await page.waitForTimeout(1200)
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    test.info().annotations.push({ type: 'metric', description: results.violations.length ? summarize(results.violations).replace(/\n/g, ' | ') : 'clean' })
    // Informational: minor/moderate items shouldn't fail the build, only report.
    expect(results.violations.filter((v) => v.impact === 'critical')).toHaveLength(0)
  })

  test('[a11y] signed-in workspace has no serious/critical WCAG violations', async ({ page, request }) => {
    const token = await getToken(request)
    test.skip(!token, 'auth unavailable')
    await gotoWorkspace(page, token!)
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(800)
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    test.info().annotations.push({ type: 'metric', description: `${results.violations.length} total, ${serious.length} serious/critical` })
    expect(serious, `serious/critical WCAG violations:\n${summarize(serious)}`).toHaveLength(0)
  })
})
