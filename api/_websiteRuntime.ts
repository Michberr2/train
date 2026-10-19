import { cancellationSignal, throwIfCancelled } from './_requestCancellation'
import { artifactDocument } from '../shared/artifactIsolation'
import type { Download } from 'playwright-core'
import { parseWebsiteDownloadContent, compareWebsiteDownloadContent } from './_websiteDownloadContent'
import { readWebsiteDownload } from './_websiteDownloadStream'
import type { WebsiteTestTarget as Target, WebsiteRuntimeTest } from '../shared/websiteBehavior'
import type { WebsiteRequirementsReview } from './_websiteRequirementReview'
export type { WebsiteRuntimeTest } from '../shared/websiteBehavior'

export type WebsitePlanningAttempt = {
  attempt: number
  provider: 'primary' | 'fallback' | 'emergency' | 'other'
  elapsedMs: number
  finishReason?: 'stop' | 'length' | 'other'
  contentChars?: number
  result: 'valid' | 'invalid-json' | 'invalid-design' | 'invalid-journeys' | 'invalid-requirements' | 'provider-error'
  issues: string[]
  failureCategory?: string
}
export type WebsiteRuntimeReview = {
  status: 'passed' | 'partial' | 'failed' | 'unavailable'
  widths: number[]
  checks: { name: string; width: number; passed: boolean; detail?: string; journeyIndex?: number; executedSteps?: number[]; passedAssertions?: number[] }[]
  issues: { code: string; detail: string; severity: 'error' | 'warning' }[]
  limitations: string[]
  timings?: { stage: string; durationMs: number; width?: number }[]
  planning?: { attempts: WebsitePlanningAttempt[] }
  requirements?: WebsiteRequirementsReview
}

// A journey schema is shared without importing the initial planner's output envelope.
export const WEBSITE_RUNTIME_JOURNEY_SCHEMA = `{"name":"user requirement being checked","steps":[{"action":"fill","target":{"label":"exact accessible field label"},"value":"1000"},{"action":"click","target":{"role":"button","name":"Calculate"}}],"expect":[{"type":"text","target":{"selector":"#result"},"value":"200"}]}. Each journey starts with a fresh page in the initial state required by the product brief. No data, selections, totals or navigation carry over between journeys. Include every setup action needed by that journey (create records before filtering or deleting them), and calculate its expected results from the product's requested initial state plus only this journey's actions. Never assume another journey ran or add unrequested seed data to satisfy a test; preserve any initial records explicitly requested by the product brief. Max 8 steps and 3 assertions per journey. Actions: click, fill, select, check, uncheck, press (Enter/Escape/Tab/ArrowDown/ArrowUp). Every fill, select or press step requires a string field named value. A select step is {"action":"select","target":{"label":"Category"},"value":"food"}; value is the HTML option value string, never an object or a field named optionValue, option, label or values. Preserve that option value in the built HTML. A press step uses value:"Enter" (or another listed key). A step may specify viewport:"mobile" or viewport:"desktop" when a responsive control (such as the mobile menu) exists only at that width; otherwise every step runs at both widths. Targets use exact label, role+name, or simple CSS selector. Assertions: text (exact visible normalized text, including units/currency), value (exact input value), visible, hidden, count, checked, hash (exact), download (filename contains, with file contents checked when supplied). For CSV/JSON/text exports, include content on the download assertion, for example {"type":"download","value":"expenses.csv","content":{"format":"csv","equals":[["description","amount"],["Coffee","5.00"]]}}. CSV equals is the complete ordered table including its header; use actual string cell values and preserve commas, quotes and line breaks. JSON content uses {"format":"json","equals":{"total":5,"items":["Coffee"]}} with exact values/types (object key order is irrelevant, array order matters). Text content uses {"format":"text","equals":"exact file text"}; only line-ending conventions and an initial UTF-8 BOM are normalized. Derive all exported rows and values from this journey's own setup and requested behavior, including whether exports contain all or filtered records. Keep content expectations compact (at most 32000 UTF-8 bytes; JSON depth8, 2000 nodes and strings up to4000 characters); downloads must be nonempty UTF-8 files up to1MiB. A filename-only assertion is compatible with unsupported binary exports but records partial verification, never proof of correct contents. Use specific computed expectations derived from the user's request, including a working calculation/form/data change or route when requested; an unchanged heading is not an interaction test. Include an invalid-input case when applicable. Avoid external network and real submissions. For a static page test its requested content/navigation. These tests are run in a real opaque sandbox at desktop and mobile widths. They cannot execute arbitrary JavaScript. Preserve the named controls/selectors when building; do not weaken assertions to match a broken implementation.`

export const WEBSITE_RUNTIME_TEST_SCHEMA = `Include runtimeTests: up to 4 short, independent journeys, each ${WEBSITE_RUNTIME_JOURNEY_SCHEMA}`

const roles = new Set(['button', 'link', 'textbox', 'spinbutton', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'heading', 'status', 'dialog', 'option'])
function validTarget(value: any): value is Target {
  return !!value && typeof value === 'object' && (
    typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 120 ||
    roles.has(value.role) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 120 ||
    typeof value.selector === 'string' && value.selector.length > 0 && value.selector.length <= 160 && !value.selector.includes('>>')
  )
}
// Use the runtime locator's precedence, never guessed equivalence between a
// label, role and CSS selector. Invalid effective targets have no identity.
function observationTarget(value: any): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const text = (input: unknown, max: number): input is string => typeof input === 'string' && input.length > 0 && input.length <= max
  if (value.label) return text(value.label, 120) ? JSON.stringify(['label', value.label]) : undefined
  if (value.role) return roles.has(value.role) && text(value.name, 120) ? JSON.stringify(['role', value.role, value.name]) : undefined
  return text(value.selector, 160) && !value.selector.includes('>>') ? JSON.stringify(['selector', value.selector]) : undefined
}
function postActionObservation(expect: any): { key: string; value: string | number | boolean } | undefined {
  const kind = expect?.type
  let value: string | number | boolean
  if (kind === 'text' || kind === 'value' || kind === 'hash') {
    if (typeof expect.value !== 'string' || expect.value.length > 500) return undefined
    value = kind === 'text' ? clean(expect.value) : expect.value
  } else if (kind === 'count') {
    if (!Number.isInteger(expect.value) || expect.value < 0 || expect.value > 10000) return undefined
    value = expect.value
  } else if (kind === 'checked') {
    if (typeof expect.value !== 'boolean') return undefined
    value = expect.value
  } else if (kind === 'visible' || kind === 'hidden') value = kind === 'visible'
  else return undefined
  const target = kind === 'hash' ? 'document hash' : observationTarget(expect.target)
  return target === undefined ? undefined : { key: JSON.stringify([kind === 'visible' || kind === 'hidden' ? 'visibility' : kind, target]), value }
}
export function inspectRuntimeTests(value: unknown): { tests: WebsiteRuntimeTest[]; issues: string[] } {
  const issues: string[] = []
  const add = (path: string, detail: string) => { if (issues.length < 12) issues.push(`${path}: ${detail}`) }
  const target = (value: unknown, path: string) => { if (!validTarget(value)) add(path, 'use an exact label (1-120 characters), allowed role+exact name (1-120), or CSS selector (1-160, no >>). Allowed roles: button, link, textbox, spinbutton, combobox, checkbox, radio, tab, menuitem, heading, status, dialog, option') }
  if (!Array.isArray(value) || !value.length || value.length > 4) return { tests: [], issues: ['runtimeTests: expected 1-4 independent journeys'] }
  value.forEach((test: any, index) => {
    const path = `runtimeTests[${index}]`
    if (!test || typeof test !== 'object') { add(path, 'expected a journey object'); return }
    if (typeof test.name !== 'string' || !test.name || test.name.length > 160) add(`${path}.name`, 'expected a nonempty string of at most 160 characters')
    if (!Array.isArray(test.steps) || test.steps.length > 8) add(`${path}.steps`, 'expected at most 8 steps; split longer flows into independent journeys')
    else test.steps.forEach((step: any, index: number) => {
      const stepPath = `${path}.steps[${index}]`
      if (!['click', 'fill', 'select', 'check', 'uncheck', 'press'].includes(step?.action)) add(`${stepPath}.action`, 'expected click, fill, select, check, uncheck or press')
      target(step?.target, `${stepPath}.target`)
      if (step?.viewport !== undefined && !['mobile', 'desktop'].includes(step.viewport)) add(`${stepPath}.viewport`, 'expected mobile or desktop, or omit for both')
      if (['fill', 'select', 'press'].includes(step?.action) && (typeof step.value !== 'string' || step.value.length > 500)) add(`${stepPath}.value`, 'expected a string of at most 500 characters; select uses an option value')
      if (step?.action === 'press' && !['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'].includes(step.value)) add(`${stepPath}.value`, 'expected Enter, Escape, Tab, ArrowDown or ArrowUp')
    })
    const observations = new Map<string, { index: number; value: string | number | boolean }>()
    if (!Array.isArray(test.expect) || !test.expect.length || test.expect.length > 3) add(`${path}.expect`, 'expected 1-3 assertions')
    else test.expect.forEach((expect: any, index: number) => {
      const expectedPath = `${path}.expect[${index}]`
      if (!['text', 'value', 'visible', 'hidden', 'count', 'checked', 'hash', 'download'].includes(expect?.type)) add(`${expectedPath}.type`, 'expected text, value, visible, hidden, count, checked, hash or download')
      if (!['hash', 'download'].includes(expect?.type)) target(expect?.target, `${expectedPath}.target`)
      if (expect?.type === 'count') { if (!Number.isInteger(expect.value) || expect.value < 0 || expect.value > 10000) add(`${expectedPath}.value`, 'expected an integer from 0 to 10000') }
      else if (expect?.type === 'checked') { if (typeof expect.value !== 'boolean') add(`${expectedPath}.value`, 'expected a boolean') }
      else if (!['visible', 'hidden'].includes(expect?.type) && (typeof expect?.value !== 'string' || expect.value.length > 500)) add(`${expectedPath}.value`, 'expected a string of at most 500 characters; text/value must match exactly, including units')
      if (expect?.type === 'download' && typeof expect.value === 'string' && !expect.value.trim()) add(`${expectedPath}.value`, 'expected a nonempty filename fragment')
      if (expect?.content !== undefined) {
        if (expect.type !== 'download') add(`${expectedPath}.content`, 'file contents can be checked only on download assertions')
        else try { parseWebsiteDownloadContent(expect.content) } catch { add(`${expectedPath}.content`, 'expected bounded text, JSON, or CSV contents with format and equals fields') }
      }
      // All assertions observe the state after all journey actions. Different
      // exact values for the same observation cannot be a valid frozen goal.
      const observation = postActionObservation(expect)
      if (observation) {
        const previous = observations.get(observation.key)
        if (previous && previous.value !== observation.value) add(expectedPath, `conflicts with expect[${previous.index}]: post-action assertions for the same target must agree`)
        else if (!previous) observations.set(observation.key, { index, value: observation.value })
      }
    })
  })
  // Reject the entire invalid plan: never discard a failing journey while
  // reporting the remaining subset as fully verified. Issues contain schema
  // paths and fixed messages only, not generated text or user values.
  return { tests: issues.length ? [] : value as WebsiteRuntimeTest[], issues }
}
export function parseRuntimeTests(value: unknown): WebsiteRuntimeTest[] {
  return inspectRuntimeTests(value).tests
}

// Lambda's single-process/no-zygote flags are retained, but origin isolation
// must never be disabled for untrusted generated code. The library defaults
// are intended for trusted rendering jobs and include these unsafe overrides.
export function websiteBrowserArgs(args: string[]): string[] {
  return args.filter(arg => !['--disable-web-security', '--disable-site-isolation-trials', '--allow-running-insecure-content'].includes(arg))
    .map(arg => arg.startsWith('--disable-features=') ? '--disable-features=' + arg.slice('--disable-features='.length).split(',').filter(feature => !['IsolateOrigins', 'site-per-process'].includes(feature)).join(',') : arg)
    .filter(arg => arg !== '--disable-features=')
    .concat('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
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
    return playwright.launch({ executablePath, args: websiteBrowserArgs(chromium.args), headless: true, timeout: launchTimeout(), env: browserEnv() })
  }
  // Local developer/test Chromium; production always uses the bundled Linux
  // binary above, never a model-provided executable or remote debugging URL.
  return playwright.launch({ args: websiteBrowserArgs([]), headless: true, timeout: launchTimeout(), env: browserEnv() })
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
function containsSeparateText(actual: string, expected: string): boolean {
  if (!expected || actual === expected) return false
  const boundary = (character: string) => !character || /^[\s:;|()[\]{}"'“”‘’–—,.!?]$/u.test(character)
  for (let offset = actual.indexOf(expected); offset >= 0; offset = actual.indexOf(expected, offset + 1)) {
    const end = offset + expected.length, before = actual[offset - 1] || '', after = actual[end] || ''
    if (!boundary(before) || !boundary(after)) continue
    // A matching substring inside a decimal/grouped number or percentage is
    // still a different scalar, not evidence of a surrounding field label.
    if (/^\p{N}/u.test(expected) && /[.,]/.test(before)) continue
    if (/\p{N}$/u.test(expected) && /^\s*(?:[.,]\p{N}|[%‰])/u.test(actual.slice(end))) continue
    return true
  }
  return false
}
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
  const report: WebsiteRuntimeReview = { status: 'unavailable', widths: [], checks: [], issues: [], timings: [], limitations: ['External services, images and fonts are disabled during isolated checks. These bounded journeys are not exhaustive verification.'] }
  let stage = 'launch'
  let stageStarted = Date.now()
  let stageWidth: number | undefined
  const mark = (next: string, width?: number) => {
    report.timings!.push({ stage, durationMs: Date.now() - stageStarted, ...(stageWidth ? { width: stageWidth } : {}) })
    stage = next; stageStarted = Date.now(); stageWidth = width
  }
  const budget = Math.min(22000, options.deadlineMs - Date.now())
  if (budget < 1500) { report.limitations.push('The request deadline left insufficient time for browser checks.'); return report }
  let browser: any
  let cancelDownloads = () => {}
  let timer: ReturnType<typeof setTimeout>
  let stopped = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    stopped = true
    cancelDownloads()
    if (!browser) return Promise.resolve()
    if (!closing) closing = (async () => {
      // Chromium's serverless single-process mode can hang while disposing an
      // incognito context. Close its pages first, then the request-owned browser;
      // never dispose/recreate contexts between viewport checks.
      let pageTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.all(browser.contexts().flatMap((context: any) => context.pages()).map((page: any) => page.close({ runBeforeUnload: false }).catch(() => {}))), new Promise<void>(resolve => { pageTimer = setTimeout(resolve, 300) })])
      } finally { if (pageTimer) clearTimeout(pageTimer) }
      await browser.close().catch(() => {})
    })()
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
    mark('context')
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: true, offline: true })
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
    let downloads: { name: string; download: Download; bytes?: Promise<Uint8Array> }[] = []
    let downloadOverflow = false
    cancelDownloads = () => {
      for (const record of downloads) void record.download.cancel().catch(() => {})
      downloads = []
    }
    page.on('pageerror', (error: Error) => { const message = error.message.slice(0, 400); if (!runtimeErrors.includes(message)) runtimeErrors.push(message) })
    page.on('dialog', (dialog: any) => dialog.dismiss().catch(() => {}))
    page.on('download', (download: Download) => {
      if (stopped || downloads.length >= 8) {
        downloadOverflow = true
        void download.cancel().catch(() => {})
        return
      }
      downloads.push({ name: download.suggestedFilename(), download })
    })
    context.on('page', (popup: any) => { if (popup !== page) void popup.close() })
    const load = async () => {
      throwIfCancelled(signal)
      cancelDownloads()
      downloadOverflow = false
      await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe title="Isolated build" sandbox="allow-scripts allow-forms allow-downloads"></iframe>', { waitUntil: 'domcontentloaded', timeout: 1500 })
      await page.locator('iframe').evaluate((node: HTMLIFrameElement, content: string) => { node.srcdoc = content }, offlineHtml(html))
      const frame = page.frameLocator('iframe')
      await frame.locator('body').waitFor({ state: 'visible', timeout: 1800 })
      await page.waitForTimeout(100)
      return frame
    }
    const unexercisedWidths: number[] = []
    mark('viewport', 1440)
    for (const width of [1440, 390]) {
      throwIfCancelled(signal)
      runtimeErrors.length = 0
      await page.setViewportSize({ width, height: 900 })
      mark('load', width)
      let frame = await load()
      const overflow = await frame.locator('html').evaluate((node: HTMLElement) => node.scrollWidth > node.clientWidth + 2)
      report.checks.push({ name: 'Page renders without horizontal overflow', width, passed: !overflow })
      if (overflow) report.issues.push({ code: 'runtime-layout', detail: `The document overflows horizontally at ${width}px.`, severity: 'error' })
      // Content assertions alone cannot establish interactive behavior. Track
      // this per viewport: desktop-only steps do not exercise mobile controls.
      const hasControls = await frame.locator('button,summary,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[contenteditable="true"]').evaluateAll((nodes: Element[]) => nodes.some(node =>
        (node as HTMLElement).getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.matches(':disabled,[aria-disabled="true"]')))
      const hasSteps = tests.some(test => test.steps.some(step => !step.viewport || step.viewport === (width < 600 ? 'mobile' : 'desktop')))
      if (hasControls && !hasSteps) unexercisedWidths.push(width)
      // Exercise real exposed controls even when the planner could not provide
      // a valid DSL. This catches click-only null targets as well as load errors.
      if (!tests.length) {
        mark('smoke', width)
        const selectors = await frame.locator('button,summary,a[href^="#"]').evaluateAll((nodes: Element[]) => nodes.filter(node => (node as HTMLElement).getClientRects().length).slice(0, 5).map(node => ({ tag: node.tagName.toLowerCase(), text: (node.textContent || '').trim().slice(0, 100), href: node.getAttribute('href') })))
        for (const target of selectors) {
          frame = await load()
          const control = target.tag === 'a' ? frame.locator('a').filter({ hasText: target.text }).first() : frame.locator(target.tag).filter({ hasText: target.text }).first()
          try { await control.click({ timeout: 800 }); await page.waitForTimeout(30) } catch { /* exact interactions are explicitly unverified without a valid plan */ }
        }
        // A planner timeout must not reduce verification to clicks alone. Run a
        // bounded, fresh form smoke pass using only native controls. This does
        // not invent expected business results; it catches null handlers,
        // broken validation paths, and uncaught errors in the most common app
        // interaction while leaving the page contract to explicit journeys.
        const fields = await frame.locator('input:not([type="hidden"]),select,textarea').evaluateAll((nodes: Element[]) => nodes
          .filter(node => (node as HTMLElement).getClientRects().length)
          .slice(0, 8)
          .map(node => ({ tag: node.tagName.toLowerCase(), type: node.getAttribute('type') || '', name: node.getAttribute('name') || '', id: node.getAttribute('id') || '' })))
        if (fields.length) {
          frame = await load()
          for (const field of fields) {
            try {
              const target = field.id ? frame.locator(`#${field.id}`) : field.name ? frame.locator(`[name="${field.name}"]`).first() : frame.locator(field.tag).first()
              if (field.tag === 'select') {
                const value = await target.locator('option').evaluateAll((options: HTMLOptionElement[]) => options.find(option => !option.disabled && option.value !== '')?.value || '')
                if (value) await target.selectOption(value)
              } else if (field.type === 'checkbox' || field.type === 'radio') {
                await target.check()
              } else {
                const value = field.type === 'email' ? 'test@example.com' : field.type === 'date' ? '2028-01-15' : field.type === 'number' ? '1' : 'Smoke test'
                await target.fill(value)
              }
              await page.waitForTimeout(20)
            } catch { /* optional fields can be conditional; page errors are recorded below */ }
          }
          const submit = frame.locator('button[type="submit"],input[type="submit"],button').filter({ hasText: /submit|save|add|create|calculate|continue|send|transfer/i }).first()
          try { if (await submit.count()) await submit.click({ timeout: 800 }); await page.waitForTimeout(40) } catch { /* validation may intentionally block incomplete forms */ }
        }
      }
      for (const [journeyIndex, test] of tests.entries()) {
        throwIfCancelled(signal)
        if (Date.now() > deadline - 500) throw new Error('The browser verification deadline was reached.')
        const executedSteps: number[] = [], passedAssertions: number[] = []
        try {
          mark('journey', width)
          frame = await load()
          for (const [stepIndex, step] of test.steps.entries()) {
            throwIfCancelled(signal)
            if (step.viewport && step.viewport !== (width < 600 ? 'mobile' : 'desktop')) continue
            const target = locator(frame, step.target)
            if (step.action === 'click') await target.click()
            else if (step.action === 'fill') await target.fill(step.value)
            else if (step.action === 'select') await target.selectOption(step.value)
            else if (step.action === 'press') await target.press(step.value)
            else if (step.action === 'check') await target.check()
            else await target.uncheck()
            executedSteps.push(stepIndex)
          }
          await page.waitForTimeout(60)
          for (const [assertionIndex, expected] of test.expect.entries()) {
            const target = expected.target ? locator(frame, expected.target) : null
            let actual: unknown
            let passed = false
            if (expected.type === 'text') {
              actual = clean(await target.innerText())
              if (!await target.isVisible()) throw new Error(`The text result at ${JSON.stringify(expected.target)} is not visible. Show the requested output; expected visible text ${JSON.stringify(expected.value)}.`)
              passed = actual === clean(String(expected.value))
            }
            else if (expected.type === 'value') { actual = await target.inputValue(); passed = actual === expected.value }
            else if (expected.type === 'visible') { actual = await target.isVisible(); passed = actual === true }
            else if (expected.type === 'hidden') { actual = await target.isVisible(); passed = actual === false }
            else if (expected.type === 'count') { actual = await target.count(); passed = actual === expected.value }
            else if (expected.type === 'checked') { actual = await target.isChecked(); passed = actual === expected.value }
            else if (expected.type === 'hash') { actual = await frame.locator('html').evaluate(() => location.hash); passed = actual === expected.value }
            else {
              const matches = () => downloads.filter(record => record.name.includes(String(expected.value)))
              if (!matches().length) {
                // The download event can follow the click response. Wait for
                // it within the same browser budget instead of a fixed sleep.
                await page.waitForEvent('download', {
                  predicate: (download: Download) => download.suggestedFilename().includes(String(expected.value)),
                  timeout: Math.max(1, Math.min(1200, deadline - Date.now() - 100)),
                })
              }
              if (downloadOverflow) throw new Error('The export produced too many files to verify safely.')
              const matching = matches()
              actual = matching.length ? 'matching download received' : 'no matching download'
              passed = matching.length > 0
              if (expected.content) {
                if (matching.length !== 1) throw new Error('The export must produce one unambiguous matching file for content verification.')
                const record = matching[0]
                record.bytes ||= readWebsiteDownload(record.download, { deadlineMs: deadline - 100, signal })
                const bytes = await record.bytes
                if (downloadOverflow || matches().length !== 1) throw new Error('Additional downloads arrived while the export was being verified.')
                const comparison = compareWebsiteDownloadContent(bytes, expected.content)
                if (!comparison.passed) throw new Error(comparison.detail || 'Downloaded file contents did not match the expected export.')
              }
            }
            if (!passed) {
              const exactText = expected.type === 'text' ? clean(String(expected.value)) : ''
              const scopeHint = typeof actual === 'string' && containsSeparateText(actual, exactText)
                ? 'Possible container-versus-field target scope mismatch. Preserve requested neighboring fields; do not remove them or weaken the exact check. '
                : ''
              throw new Error(`${scopeHint}${expected.type} expected ${JSON.stringify(expected.value ?? true)}, observed ${JSON.stringify(actual)} at ${JSON.stringify(expected.target || '')}`)
            }
            passedAssertions.push(assertionIndex)
          }
          if (downloadOverflow) throw new Error('The export produced too many files to verify safely.')
          for (const expected of test.expect) {
            if (expected.type === 'download' && expected.content && downloads.filter(record => record.name.includes(String(expected.value))).length !== 1) {
              throw new Error('Additional matching downloads arrived before the journey completed.')
            }
          }
          report.checks.push({ name: test.name, width, passed: true, journeyIndex, executedSteps, passedAssertions })
        } catch (error) {
          throwIfCancelled(signal)
          const detail = (error instanceof Error ? error.message : 'Interaction failed').split('\n').slice(0, 3).join(' ').slice(0, 550)
          report.checks.push({ name: test.name, width, passed: false, detail, journeyIndex, executedSteps, passedAssertions })
          report.issues.push({ code: 'runtime-interaction', severity: 'error', detail: `${width}px / ${test.name}: ${detail}` })
        }
      }
      report.checks.push({ name: 'No uncaught JavaScript errors while loading/interacting', width, passed: !runtimeErrors.length })
      for (const error of runtimeErrors.slice(0, 4)) report.issues.push({ code: 'runtime-script', severity: 'error', detail: `${width}px: ${error}` })
      report.widths.push(width)
      mark('viewport', width === 1440 ? 390 : undefined)
    }
    const filenameOnlyDownloads = tests.some(test => test.expect.some(expected => expected.type === 'download' && !expected.content))
    report.status = report.issues.length ? 'failed' : tests.length && !unexercisedWidths.length && !filenameOnlyDownloads ? 'passed' : 'partial'
    if (filenameOnlyDownloads) report.limitations.push('Some export checks verified only filenames. Downloaded file contents were not checked for those assertions.')
    if (unexercisedWidths.length) report.limitations.push(`The page exposes interactive controls at ${unexercisedWidths.map(width => `${width}px`).join(', ')}, but no interaction steps ran at those widths. Passing content assertions do not verify those controls.`)
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
    mark('cleanup')
    clearTimeout(timer!)
    signal?.removeEventListener('abort', onAbort)
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([close(), new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1000) })])
    if (cleanupTimer) clearTimeout(cleanupTimer)
    mark('complete')
  }
}
