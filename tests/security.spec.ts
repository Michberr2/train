import { test, expect } from '@playwright/test'
import { BASE_URL } from './_helpers'

// Defensive security pass on the user's OWN site. Each test PASSES when secure
// and FAILS (with the finding) when there's an issue.
test.describe('Security', () => {
  test('[security] @smoke no secrets are exposed in the served JS bundle', async ({ request, page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // Collect every same-origin script URL the page loads.
    const scripts = await page.$$eval('script[src]', (els) =>
      els.map((e) => (e as HTMLScriptElement).src).filter(Boolean),
    )
    expect(scripts.length, 'no scripts found').toBeGreaterThan(0)
    const SECRET = /(tml-[A-Za-z0-9]{8,})|(sk-[A-Za-z0-9]{16,})|GLM_API_KEY|TML_API_KEY|FAL_KEY|NALU_IMAGE_API_KEY|postgres(ql)?:\/\/[^\s"']+|-----BEGIN [A-Z ]*PRIVATE KEY-----/
    const leaks: string[] = []
    for (const src of scripts.slice(0, 12)) {
      const res = await request.get(src).catch(() => null)
      if (!res || !res.ok()) continue
      const text = await res.text()
      const m = text.match(SECRET)
      if (m) leaks.push(`${src.split('/').pop()} → ${m[0].slice(0, 24)}…`)
    }
    expect(leaks, `secret(s) found in client bundle:\n${leaks.join('\n')}`).toHaveLength(0)
  })

  test('[security] @smoke key security response headers are present', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`)
    const h = res.headers()
    const missing: string[] = []
    if (!h['strict-transport-security']) missing.push('Strict-Transport-Security')
    if (!h['x-content-type-options']) missing.push('X-Content-Type-Options: nosniff')
    if (!h['x-frame-options'] && !h['content-security-policy']) missing.push('X-Frame-Options or CSP (clickjacking)')
    test.info().annotations.push({ type: 'metric', description: `headers present: ${Object.keys(h).filter((k) => /security|frame|content-type-opt|referrer|permissions-policy/.test(k)).join(', ') || 'none'}` })
    expect(missing, `missing security headers: ${missing.join(', ')}`).toHaveLength(0)
  })

  test('[security] @smoke auth rejects bad credentials and injection input', async ({ request }) => {
    const bad = await request.post(`${BASE_URL}/api/auth`, { data: { action: 'signin', email: "' OR 1=1 --", password: 'x' } })
    expect(bad.status(), 'injection attempt should not 500').toBeLessThan(500)
    const body = await bad.json().catch(() => ({}))
    expect(body.ok, 'must not authenticate a bogus/injection login').toBeFalsy()
    expect(body.token, 'must not return a token').toBeFalsy()
  })

  test('[security] @smoke API errors do not leak stack traces or env', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/design`, { data: { prompt: '', kind: 'not-a-real-kind' }, timeout: 30_000 })
    const text = await res.text()
    expect(text, 'leaked a Node stack trace').not.toMatch(/\bat \S+ \(.*\.[tj]s:\d+:\d+\)/)
    expect(text, 'leaked an env var name').not.toMatch(/process\.env|GLM_API_KEY|DATABASE_URL/)
  })

  test('[security] @smoke HTTPS is enforced (http → https)', async ({ request }) => {
    const httpUrl = BASE_URL.replace(/^https:/, 'http:')
    const res = await request.get(httpUrl, { maxRedirects: 0 }).catch(() => null)
    if (!res) { test.info().annotations.push({ type: 'metric', description: 'http blocked outright (good)' }); return }
    const status = res.status()
    const loc = res.headers()['location'] || ''
    const secure = status === 0 || (status >= 300 && status < 400 && loc.startsWith('https:'))
    expect(secure, `http did not redirect to https (status ${status}, location ${loc})`).toBeTruthy()
  })
})
