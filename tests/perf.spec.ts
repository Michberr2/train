import { test, expect } from '@playwright/test'
import { BASE_URL } from './_helpers'

// Scalability signals — measured numbers with a pass/fail threshold so the
// report can flag what won't scale (slow loads, heavy bundles, slow APIs).
test.describe('Scalability', () => {
  test('[perf] @smoke landing loads quickly (DOMContentLoaded budget)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' })
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      return e ? { dcl: e.domContentLoadedEventEnd, load: e.loadEventEnd } : null
    })
    const dcl = Math.round(nav?.dcl ?? 0)
    const load = Math.round(nav?.load ?? 0)
    test.info().annotations.push({ type: 'metric', description: `DOMContentLoaded ${dcl}ms, load ${load}ms` })
    expect(dcl, `DOMContentLoaded ${dcl}ms (budget 5000ms)`).toBeLessThan(5000)
  })

  test('[perf] @smoke main JS bundle stays within a sane size budget', async ({ page, request }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    const scripts = await page.$$eval('script[src]', (els) => els.map((e) => (e as HTMLScriptElement).src))
    let totalKB = 0
    let biggest = { name: '', kb: 0 }
    for (const src of scripts) {
      const res = await request.get(src).catch(() => null)
      if (!res || !res.ok()) continue
      const kb = Math.round((await res.body()).byteLength / 1024)
      totalKB += kb
      if (kb > biggest.kb) biggest = { name: src.split('/').pop() || '', kb }
    }
    test.info().annotations.push({ type: 'metric', description: `entry JS ${totalKB}KB total, biggest ${biggest.name} ${biggest.kb}KB` })
    // The 3D/CAD/heavy chunks are lazy-loaded, so the EAGER entry should be modest.
    expect(totalKB, `eager JS ${totalKB}KB (budget 1200KB raw)`).toBeLessThan(1200)
  })

  test('[perf] @smoke a lightweight API call responds promptly', async ({ request }) => {
    const t0 = Date.now()
    const res = await request.post(`${BASE_URL}/api/auth`, { data: { action: 'me' }, timeout: 15_000 })
    const ms = Date.now() - t0
    test.info().annotations.push({ type: 'metric', description: `/api/auth latency ${ms}ms` })
    expect(res.status(), 'auth me reachable').toBeLessThan(500)
    expect(ms, `auth latency ${ms}ms (budget 4000ms incl cold start)`).toBeLessThan(4000)
  })
})
