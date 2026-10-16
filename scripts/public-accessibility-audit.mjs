// Public sections and authentication surfaces, normal animation enabled. API
// traffic is isolated; no test creates or modifies a real account.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const base = process.argv[2] || 'http://127.0.0.1:5180'
const output = process.env.OUTPUT_DIR || '/tmp/nalu-public-accessibility'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch(), report = []
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    await context.addInitScript(theme => { if (window === top) localStorage.setItem('nalu-theme', theme) }, theme)
    await context.route('**/api/**', route => route.fulfill({ json: { user: null, data: {}, items: [], ok: true } }))
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base, { waitUntil: 'load' })
    await page.getByRole('heading', { name: 'Your AI. Your screen.', exact: true }).waitFor()
    const scan = async state => {
      // Include both speakers and the demo's reasoning labels, which arrive
      // after the opening typewriter sequence.
      if (state === 'solutions') await page.getByText('Writing...', { exact: true }).first().waitFor()
      // The public entry sequence ends after 1.3s, including the company link.
      // Scan its settled appearance; do not disable or hide low-contrast text.
      await page.waitForTimeout(1600)
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark')
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      const violations = results.violations.map(value => ({ id: value.id, impact: value.impact, help: value.help, nodes: value.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary, checks: node.any.map(check => ({ id: check.id, data: check.data })) })) }))
      const row = { base, width, theme, state, violations, incomplete: results.incomplete.map(value => ({ id: value.id, nodes: value.nodes.length })), errors: [...errors] }
      report.push(row)
      await page.screenshot({ path: `${output}/${width}-${theme}-${state}.png` })
      await fs.writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ width, theme, state, violations: violations.map(value => ({ id: value.id, impact: value.impact, nodes: value.nodes.length })) }))
    }
    for (let index = 0; index < 5; index++) {
      if (index) await page.getByRole('button', { name: `Go to page ${index + 1}`, exact: true }).click()
      if (index === 3 && width < 768) {
        const region = page.getByRole('region', { name: 'Pricing', exact: true })
        await region.focus()
        await page.keyboard.press('ArrowDown')
        await page.waitForFunction(() => (document.querySelector('[aria-labelledby="pricing-title"]')?.scrollTop || 0) > 0)
        await region.evaluate(element => { element.scrollTop = 0; element.blur() })
      }
      await scan(['meet', 'platform', 'solutions', 'pricing', 'learn'][index])
    }
    if (width < 768) {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click()
      await scan('mobile-menu')
      await page.getByRole('button', { name: 'Close menu', exact: true }).click()
    }
    await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click()
    await scan('signin')
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create account', exact: true }).click()
    await scan('signup')
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).first().click()
    await dialog.getByRole('button', { name: 'Forgot password?', exact: true }).click()
    await scan('password-reset')
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally {
  await fs.writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
process.exitCode = report.length !== 34 || report.some(row => row.violations.some(value => ['serious', 'critical'].includes(value.impact))) ? 1 : 0
