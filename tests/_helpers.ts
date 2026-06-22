import type { APIRequestContext, Page } from '@playwright/test'

export const BASE_URL = process.env.BASE_URL || 'https://n4lu.ai'
export const RUN_FULL = process.env.STUDIO_FULL === '1' // run token-spending generator tests

// A dedicated studio account so runs don't pollute the DB with new users.
const TEST_EMAIL = process.env.STUDIO_EMAIL || 'studio-bot@nalu.test'
const TEST_PW = process.env.STUDIO_PW || 'studio-pw-9f3k2'

async function authCall(request: APIRequestContext, action: string, payload: Record<string, unknown>) {
  const res = await request.post(`${BASE_URL}/api/auth`, { data: { action, ...payload } })
  let body: Record<string, unknown> = {}
  try { body = await res.json() } catch { /* non-json */ }
  return { status: res.status(), body }
}

/** Returns a valid session token, creating the studio account on first run. */
export async function getToken(request: APIRequestContext): Promise<string | null> {
  let r = await authCall(request, 'signin', { email: TEST_EMAIL, password: TEST_PW })
  if (r.body?.ok && typeof r.body.token === 'string') return r.body.token as string
  r = await authCall(request, 'signup', { email: TEST_EMAIL, password: TEST_PW, displayName: 'Studio Bot' })
  if (r.body?.ok && typeof r.body.token === 'string') return r.body.token as string
  return null
}

/** Loads the signed-in workspace by injecting the token before the app boots. */
export async function gotoWorkspace(page: Page, token: string) {
  await page.addInitScript((t) => {
    try { localStorage.setItem('nalu-token', t) } catch { /* */ }
  }, token)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
}

/** Records console + page errors for a test; call assertNoSevereErrors() after. */
export function trackErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

// Console noise we don't care about (third-party image/video hosts, favicons).
const IGNORABLE = /pollinations|hf\.space|gradio|favicon|net::ERR_|Failed to load resource|ResizeObserver/i
export function severeErrors(errors: string[]): string[] {
  return errors.filter((e) => !IGNORABLE.test(e))
}
