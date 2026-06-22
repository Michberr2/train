# Nalu Test Studio

End-to-end + security + scalability checks that run against the **whole live
site** and print one categorized report: what works, what's a scalability risk,
security findings, and what needs fixing.

## Run it

```bash
npm install                 # first time (installs Playwright)
npx playwright install chromium   # first time (downloads the browser)

npm run studio:smoke        # FAST — no LLM tokens spent (recommended default)
npm run studio              # all non-token checks, desktop + mobile
npm run studio:full         # also generates real doc/sheet/slides/logo/image/video (spends tokens, ~5–10 min)
npm run studio:report       # open the HTML report
```

Point it anywhere with `BASE_URL` (defaults to production):

```bash
BASE_URL=http://localhost:5173 npm run studio:smoke      # against vite dev
BASE_URL=https://<preview>.vercel.app npm run studio     # against a preview
```

## What it checks

| Tag | File | Covers |
|-----|------|--------|
| `[health]` | api-health, workspace | every API endpoint is reachable & never 500s; (full) each generator builds a valid artifact; signed-in workspace loads |
| `[ux]` | landing | nav reachable, no horizontal overflow |
| `[mobile]` | workspace | right drawer hidden on phones, no horizontal scroll |
| `[perf]` | perf | landing load budget, eager-JS bundle budget, API latency |
| `[security]` | security | no secrets in the JS bundle, security headers, auth rejects injection, no stack-trace/env leaks, HTTPS enforced |

`@smoke` = the cheap subset (no tokens). The token-spending generation tests are
gated behind `STUDIO_FULL=1` (`npm run studio:full`) so a normal run is free.

## Notes
- A dedicated `studio-bot@nalu.test` account is auto-created on first run (override with `STUDIO_EMAIL`/`STUDIO_PW`) so runs don't pollute the user table.
- Security tests are **defensive** checks on your own site. They pass when secure and fail with the specific finding when not.
