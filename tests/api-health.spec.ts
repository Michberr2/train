import { test, expect } from '@playwright/test'
import { BASE_URL, RUN_FULL } from './_helpers'

// API health. The "reachability" checks are cheap (bad/empty input → graceful
// error, no 500). The "generation" checks actually build artifacts and spend
// LLM tokens, so they only run under STUDIO_FULL=1.
test.describe('API', () => {
  test.describe.configure({ mode: 'parallel' })

  // ---- cheap reachability: endpoints must exist and fail gracefully ----
  const endpoints = ['/api/doc', '/api/sheet', '/api/slides', '/api/design', '/api/image', '/api/video', '/api/chat']
  for (const ep of endpoints) {
    test(`[health] @smoke ${ep} rejects empty input through its JSON handler`, async ({ request }) => {
      const res = await request.post(`${BASE_URL}${ep}`, { data: {}, timeout: 30_000 }).catch(() => null)
      // Reachable (not a network failure / 404) and not a server crash (5xx).
      expect(res, 'no response').not.toBeNull()
      const status = res!.status()
      expect([400, 401, 422], `${ep} returned ${status}; a missing route, HTML fallback or exhausted quota is not a healthy validation response`).toContain(status)
      expect(res!.headers()['content-type']).toMatch(/application\/json/i)
      const body = await res!.json()
      expect(typeof body.error).toBe('string')
      expect(body.error.length).toBeGreaterThan(0)
    })
  }

  test('[health] @smoke /api/data share lookup handles a bogus id without leaking', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/data?share=__nope__${Date.now()}`)
    expect(res.status()).toBe(404)
    const body = await res.text()
    expect(body).toBe('This Nalu site was not found.')
    expect(body, 'must not leak a stack trace').not.toMatch(/at \w+ \(.*:\d+:\d+\)/)
  })

  // ---- generation: real artifacts (spends tokens) ----
  const gen = [
    { name: 'doc (Word)', url: '/api/doc', data: { prompt: 'a one-paragraph memo about punctuality' }, ok: (b: any) => Array.isArray(b.blocks) && b.blocks.length },
    { name: 'sheet (Excel)', url: '/api/sheet', data: { prompt: 'a 3-row expenses table with a SUM' }, ok: (b: any) => Array.isArray(b.sheets) && b.sheets.length },
    { name: 'slides (PowerPoint)', url: '/api/slides', data: { prompt: 'a 3-slide intro deck' }, ok: (b: any) => Array.isArray(b.slides) && b.slides.length },
    { name: 'blueprint', url: '/api/design', data: { prompt: 'a small 2-bedroom floor plan', kind: 'blueprint' }, ok: (b: any) => 'floors' in b || 'shapes' in b },
    { name: 'logo', url: '/api/design', data: { prompt: 'a logo for Acme', kind: 'logo' }, ok: (b: any) => 'initials' in b || 'options' in b },
    { name: 'shopping', url: '/api/design', data: { prompt: 'shopping list for a reading nook', kind: 'shopping' }, ok: (b: any) => Array.isArray(b.items) && b.items.length },
    { name: 'image', url: '/api/image', data: { prompt: 'a red apple on a table' }, ok: (b: any) => typeof b.url === 'string' && /^https?:/.test(b.url) },
    { name: 'video', url: '/api/video', data: { prompt: 'a calm ocean wave, slow motion' }, ok: (b: any) => typeof b.url === 'string' && /^https?:/.test(b.url) },
  ]
  for (const g of gen) {
    test(`[health] generates ${g.name} end-to-end`, async ({ request }) => {
      test.skip(!RUN_FULL, 'token-spending — run with npm run studio:full')
      const t0 = Date.now()
      const res = await request.post(`${BASE_URL}${g.url}`, { data: g.data, timeout: 110_000 })
      const ms = Date.now() - t0
      expect(res.ok(), `${g.name} HTTP ${res.status()}`).toBeTruthy()
      const body = await res.json().catch(() => ({}))
      expect(g.ok(body), `${g.name} returned an invalid/empty payload`).toBeTruthy()
      test.info().annotations.push({ type: 'metric', description: `${g.name}: ${(ms / 1000).toFixed(1)}s` })
    })
  }
})
