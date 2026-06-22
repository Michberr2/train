import { defineConfig, devices } from '@playwright/test'

// Nalu Test Studio — runs the whole site every time and reports what works,
// what's a scalability risk, what needs fixing, and a security pass.
//
//   npm run studio          # full studio against prod (BASE_URL overridable)
//   npm run studio:smoke    # fast @smoke subset only (no token-spending gen)
//   npm run studio:full     # also run the heavy generator tests (spends LLM tokens)
//
// BASE_URL defaults to production. Point it at a preview/localhost to test those.
const BASE_URL = process.env.BASE_URL || 'https://n4lu.ai'

export default defineConfig({
  testDir: './tests',
  // Generation endpoints can take 30–90s; give tests room but cap the suite.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [
    ['./tests/studio-reporter.ts'],
    ['list'],
    ['html', { outputFolder: 'tests/.report', open: 'never' }],
    ['json', { outputFile: 'tests/.report/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
})
