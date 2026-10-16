import { cancellationSignal, throwIfCancelled } from './_requestCancellation'
import { artifactDocument } from '../shared/artifactIsolation'

type Target = { label?: string; role?: string; name?: string; selector?: string }
type Step = { action: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press'; target: Target; value?: string; viewport?: 'mobile' | 'desktop' }
type Expectation = { type: 'text' | 'value' | 'visible' | 'hidden' | 'count' | 'checked' | 'hash' | 'download'; target?: Target; value?: string | number | boolean }
export type WebsiteRuntimeTest = { name: string; steps: Step[]; expect: Expectation[] }
export type WebsiteRuntimeReview = {
  status: 'passed' | 'partial' | 'failed' | 'unavailable'
  widths: number[]
  checks: { name: string; width: number; passed: boolean; detail?: string }[]
  issues: { code: string; detail: string; severity: 'error' | 'warning' }[]
  limitations: string[]
}

export const WEBSITE_RUNTIME_TEST_SCHEMA = `Include runtimeTests: up to 4 short, independent journeys, each {"name":"user requirement being checked","steps":[{"action":"fill","target":{"label":"exact accessible field label"},"value":"1000"},{"action":"click","target":{"role":"button","name":"Calculate"}}],"expect":[{"type":"text","target":{"selector":"#result"},"value":"200"}]}. Each journey starts with a fresh page. Max 8 steps and 3 assertions per journey. Actions: click, fill, select (option value), check, uncheck, press (Enter/Escape/Tab/ArrowDown/ArrowUp). A step may specify viewport:"mobile" or viewport:"desktop" when a responsive control (such as the mobile menu) exists only at that width; otherwise every step runs at both widths. Targets use exact label, role+name, or simple CSS selector. Assertions: text (exact visible normalized text, including units/currency), value (exact input value), visible, hidden, count, checked, hash (exact), download (filename contains). Use specific computed expectations derived from the user's request, including a working calculation/form/data change or route when requested; an unchanged heading is not an interaction test. Include an invalid-input case when applicable. Avoid external network and real submissions. For a static page test its requested content/navigation. These tests are run in a real opaque sandbox at desktop and mobile widths. They cannot execute arbitrary JavaScript. Preserve the named controls/selectors when building; do not weaken assertions to match a broken implementation.`

const roles = new Set(['button', 'link', 'textbox', 'spinbutton', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'heading', 'status', 'dialog', 'option'])
function validTarget(value: any): value is Target {
  return !!value && typeof value === 'object' && (
    typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 120 ||
    roles.has(value.role) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 120 ||
    typeof value.selector === 'string' && value.selector.length > 0 && value.selector.length <= 160 && !value.selector.includes('>>')
  )
}
export function parseRuntimeTests(value: unknown): WebsiteRuntimeTest[] {
  if (!Array.isArray(value) || value.length > 4) return []
  const valid = value.filter((test): test is WebsiteRuntimeTest => {
    if (!test || typeof test.name !== 'string' || !test.name || test.name.length > 160 || !Array.isArray(test.steps) || test.steps.length > 8 || !Array.isArray(test.expect) || !test.expect.length || test.expect.length > 3) return false
    return test.steps.every((step: any) => ['click', 'fill', 'select', 'check', 'uncheck', 'press'].includes(step?.action) && validTarget(step.target) && (step.viewport === undefined || ['mobile', 'desktop'].includes(step.viewport)) && (['fill', 'select', 'press'].includes(step.action) ? typeof step.value === 'string' && step.value.length <= 500 && (step.action !== 'press' || ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'].includes(step.value)) : true)) &&
      test.expect.every((expect: any) => ['text', 'value', 'visible', 'hidden', 'count', 'checked', 'hash', 'download'].includes(expect?.type) && (['hash', 'download'].includes(expect.type) || validTarget(expect.target)) && (['visible', 'hidden'].includes(expect.type) || expect.type === 'count' && Number.isInteger(expect.value) && expect.value >= 0 && expect.value <= 10000 || expect.type === 'checked' && typeof expect.value === 'boolean' || typeof expect.value === 'string' && expect.value.length <= 500))
  })
  // A malformed journey cannot disappear while the remaining subset is
  // reported as a fully executed plan. Fall back to explicitly partial smoke.
  return valid.length === value.length ? valid : []
}

// The host controls this CSP; a generated <meta> can only add restrictions.
// No app cookies, storage, origins, authenticated resources, service workers,
// network requests, popups or top-level navigation reach the page under test.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'"
function offlineHtml(html: string): string {
  // Use the same private-storage/fragment-navigation shim as the delivered
  // iframe. Offline network restrictions are an explicit test limitation.
  const document = artifactDocument(html)
  const policy = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
  return /<head\b[^>]*>/i.test(document) ? document.replace(/<head\b[^>]*>/i, head => head + policy) : policy + document
}

async function launchBrowser(deadline: number, signal: AbortSignal | undefined, stopped: () => boolean) {
  const launchTimeout = () => {
    throwIfCancelled(signal)
    if (stopped() || Date.now() >= deadline) throw new Error('The browser verification deadline was reached.')
    return Math.min(10000, Math.max(1, deadline - Date.now()))
  }
  launchTimeout()
  const { chromium: playwright } = await import('playwright-core')
  const browserEnv = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'FONTCONFIG_PATH', 'LD_LIBRARY_PATH'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []))
  if (process.platform === 'linux') {
    const { default: chromium } = await import('@sparticuz/chromium')
    const executablePath = await chromium.executablePath()
    return playwright.launch({ executablePath, args: [...chromium.args, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], headless: true, timeout: launchTimeout(), env: browserEnv() })
  }
  // Local developer/test Chromium; production always uses the bundled Linux
  // binary above, never a model-provided executable or remote debugging URL.
  return playwright.launch({ args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], headless: true, timeout: launchTimeout(), env: browserEnv() })
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
function locator(frame: any, target: Target) {
  if (target.label) return frame.getByLabel(target.label, { exact: true })
  if (target.role) return frame.getByRole(target.role, { name: target.name, exact: true })
  return frame.locator(target.selector!)
}

/** Runs fixed operations, never model-authored eval code, against a disposable
 * real Chromium renderer. A hard wall-clock watchdog also closes pages stuck
 * in an infinite loop. Every source revision gets a fresh browser/context. */
export async function reviewWebsiteRuntime(html: string, tests: WebsiteRuntimeTest[], options: { deadlineMs: number; signal?: AbortSignal } ): Promise<WebsiteRuntimeReview> {
  const signal = cancellationSignal(options.signal)
  throwIfCancelled(signal)
  const report: WebsiteRuntimeReview = { status: 'unavailable', widths: [], checks: [], issues: [], limitations: ['External services, images and fonts are disabled during isolated checks. These bounded journeys are not exhaustive verification.'] }
  const budget = Math.min(22000, options.deadlineMs - Date.now())
  if (budget < 1500) { report.limitations.push('The request deadline left insufficient time for browser checks.'); return report }
  let browser: any
  let timer: ReturnType<typeof setTimeout>
  let stopped = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    stopped = true
    if (!browser) return Promise.resolve()
    if (!closing) closing = browser.close().catch(() => {})
    return closing!
  }
  let rejectStop: (error: Error) => void = () => {}
  const onAbort = () => { void close(); rejectStop(new DOMException('The request was cancelled.', 'AbortError')) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const deadline = Date.now() + budget
  const limited = new Promise<never>((_, reject) => { rejectStop = reject; timer = setTimeout(() => { void close(); reject(new Error('The browser verification deadline was reached.')) }, budget) })
  const run = async () => {
    browser = await launchBrowser(deadline, signal, () => stopped)
    if (stopped) { await close(); throw new Error('Browser checks were stopped.') }
    for (const width of [1440, 390]) {
      throwIfCancelled(signal)
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', acceptDownloads: true, offline: true })
      // Peer connections/QUIC are not ordinary routed HTTP requests. Disable
      // their constructors in every new frame before generated code executes.
      await context.addInitScript(() => {
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false })
      })
      await context.route('**/*', (route: any) => route.abort())
      if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket: any) => socket.close())
      context.setDefaultTimeout(1200)
      const page = await context.newPage()
      const runtimeErrors: string[] = []
      let downloads: string[] = []
      page.on('pageerror', (error: Error) => { const message = error.message.slice(0, 400); if (!runtimeErrors.includes(message)) runtimeErrors.push(message) })
      page.on('dialog', (dialog: any) => dialog.dismiss().catch(() => {}))
      page.on('download', (download: any) => { downloads.push(download.suggestedFilename()) })
      context.on('page', (popup: any) => { if (popup !== page) void popup.close() })
      const load = async () => {
        throwIfCancelled(signal)
        downloads = []
        await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe title="Isolated build" sandbox="allow-scripts allow-forms allow-downloads"></iframe>', { waitUntil: 'domcontentloaded', timeout: 1500 })
        await page.locator('iframe').evaluate((node: HTMLIFrameElement, content: string) => { node.srcdoc = content }, offlineHtml(html))
        const frame = page.frameLocator('iframe')
        await frame.locator('body').waitFor({ state: 'visible', timeout: 1800 })
        await page.waitForTimeout(100)
        return frame
      }
      try {
        let frame = await load()
        const overflow = await frame.locator('html').evaluate((node: HTMLElement) => node.scrollWidth > node.clientWidth + 2)
        report.checks.push({ name: 'Page renders without horizontal overflow', width, passed: !overflow })
        if (overflow) report.issues.push({ code: 'runtime-layout', detail: `The document overflows horizontally at ${width}px.`, severity: 'error' })
        // Exercise real exposed controls even when the planner could not provide
        // a valid DSL. This catches click-only null targets as well as load errors.
        if (!tests.length) {
          const selectors = await frame.locator('button,summary,a[href^="#"]').evaluateAll((nodes: Element[]) => nodes.filter(node => (node as HTMLElement).getClientRects().length).slice(0, 5).map(node => ({ tag: node.tagName.toLowerCase(), text: (node.textContent || '').trim().slice(0, 100), href: node.getAttribute('href') })))
          for (const target of selectors) {
            frame = await load()
            const control = target.tag === 'a' ? frame.locator('a').filter({ hasText: target.text }).first() : frame.locator(target.tag).filter({ hasText: target.text }).first()
            try { await control.click({ timeout: 800 }); await page.waitForTimeout(30) } catch { /* exact interactions are explicitly unverified without a valid plan */ }
          }
        }
        for (const test of tests) {
          throwIfCancelled(signal)
          if (Date.now() > deadline - 500) throw new Error('The browser verification deadline was reached.')
          try {
            frame = await load()
            for (const step of test.steps) {
              throwIfCancelled(signal)
              if (step.viewport && step.viewport !== (width < 600 ? 'mobile' : 'desktop')) continue
              const target = locator(frame, step.target)
              if (step.action === 'click') await target.click()
              else if (step.action === 'fill') await target.fill(step.value)
              else if (step.action === 'select') await target.selectOption(step.value)
              else if (step.action === 'press') await target.press(step.value)
              else if (step.action === 'check') await target.check()
              else await target.uncheck()
            }
            await page.waitForTimeout(60)
            for (const expected of test.expect) {
              const target = expected.target ? locator(frame, expected.target) : null
              let actual: unknown
              let passed = false
              if (expected.type === 'text') { actual = clean(await target.innerText()); passed = actual === clean(String(expected.value)) }
              else if (expected.type === 'value') { actual = await target.inputValue(); passed = actual === expected.value }
              else if (expected.type === 'visible') { actual = await target.isVisible(); passed = actual === true }
              else if (expected.type === 'hidden') { actual = await target.isVisible(); passed = actual === false }
              else if (expected.type === 'count') { actual = await target.count(); passed = actual === expected.value }
              else if (expected.type === 'checked') { actual = await target.isChecked(); passed = actual === expected.value }
              else if (expected.type === 'hash') { actual = await frame.locator('html').evaluate(() => location.hash); passed = actual === expected.value }
              else { actual = downloads.join(', '); passed = downloads.some(name => name.includes(String(expected.value))) }
              if (!passed) throw new Error(`${expected.type} expected ${JSON.stringify(expected.value ?? true)}, observed ${JSON.stringify(actual)} at ${JSON.stringify(expected.target || '')}`)
            }
            report.checks.push({ name: test.name, width, passed: true })
          } catch (error) {
            throwIfCancelled(signal)
            const detail = (error instanceof Error ? error.message : 'Interaction failed').split('\n').slice(0, 3).join(' ').slice(0, 550)
            report.checks.push({ name: test.name, width, passed: false, detail })
            report.issues.push({ code: 'runtime-interaction', severity: 'error', detail: `${width}px / ${test.name}: ${detail}` })
          }
        }
        report.checks.push({ name: 'No uncaught JavaScript errors while loading/interacting', width, passed: !runtimeErrors.length })
        for (const error of runtimeErrors.slice(0, 4)) report.issues.push({ code: 'runtime-script', severity: 'error', detail: `${width}px: ${error}` })
        report.widths.push(width)
      } finally { await context.close().catch(() => {}) }
    }
    report.status = report.issues.length ? 'failed' : tests.length ? 'passed' : 'partial'
    if (!tests.length) report.limitations.push('Only page load and generic control smoke checks ran; no valid user-specific interaction plan was available.')
    return report
  }
  try { return await Promise.race([run(), limited]) }
  catch (error) {
    throwIfCancelled(signal)
    report.status = report.issues.length ? 'failed' : 'unavailable'
    report.limitations.push(error instanceof Error ? error.message.slice(0, 400) : 'The isolated browser could not run.')
    return report
  } finally {
    clearTimeout(timer!)
    signal?.removeEventListener('abort', onAbort)
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([close(), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1000) })])
    if (cleanupTimer) clearTimeout(cleanupTimer)
  }
}
