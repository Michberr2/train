# Account browser workspace

The web workspace now exposes a Browser app and `browser_work` / `browser_status` chat tools. The browser supports the existing Browser Use v2 integration and the dedicated Cloudflare Browser Run adapter in `cloudflare/nalu-browser`. Each authenticated account gets its own provider profile and at most one active task. Users sign in to Microsoft Word/Excel web apps or other sites in the live view. Nalu login does not import local Chrome cookies or grant Microsoft access.

## Activation and release

- For Cloudflare, deploy `cloudflare/nalu-browser/wrangler.jsonc` with the existing Nalu account. Configure a dedicated `SERVICE_KEY` Worker secret and the matching server-only `NALU_BROWSER_SERVICE_KEY` in the Vercel project. The endpoint is pinned to `https://nalu-browser.nalu.workers.dev`; callers cannot supply its URL or owner identity. Never use a `VITE_` variable. Alternatively, configure `BROWSER_USE_API_KEY` for Browser Use saved profiles.
- Apply `cloudflare/nalu-data/migrations/0018_browser_workspaces.sql` to production D1 before activation if `NALU_STORAGE_BACKEND=cloudflare`. The PostgreSQL path initializes this table on first authenticated browser request.
- Release from a clean checkout containing the approved UI and latest fixes via `./deploy.sh`. The main development checkout contains extensive unrelated work and must not be committed wholesale.
- Verify n4lu.com, n4lu.ai, and both www aliases with the checked release workflow. Then test two distinct Nalu accounts, manual Microsoft login/MFA, a disposable Word document and Excel workbook, saved-file readback, takeover, closure, profile reuse and private downloads. Synthetic tests do not prove provider availability or successful work in Office.

## Behavior and contracts

`POST /api/browser` retains the original `run`, `status`, `cancel` contract for existing callers. New account-scoped actions: `workspace_status`, `workspace_open`, `workspace_run`, `workspace_takeover`, `workspace_close`, `workspace_download`. Clients never choose provider session/profile IDs. Browser work is executed by the provider and continues independently of the requesting tab. Polling updates the shared task ledger; without an open client the ledger can lag provider completion.

`workspace_takeover` stops the AI task while keeping the browser open. The next task is an explicit follow-up; this is not a paused task resumed at the same step. `workspace_close` stops the session and allows the provider to save the profile. Keep-alive sessions incur provider browser usage until closed or expired by the provider. Login state can expire at any website.

Private live-view URLs are returned only to authenticated owners, never put in model context or synced chat history, and embedded only from the browser provider’s HTTPS domain. The new table is server-owned rather than user-editable synced data. A 90-second database lease serializes requests; requests time out after 60 seconds. Task starts reserve the existing browser daily quota. Browser Use caps tasks at 60 steps; the Cloudflare adapter caps them at 40 steps or 15 minutes. Recordings and cross-task conversation memory are disabled. Browser Use task output files can be downloaded with owner checks; the Cloudflare adapter currently saves work in the destination web app and does not export browser downloads; files from older tasks are not yet browsable from this panel.

A lost POST response remains uncertain; it is never automatically retried. Task submission can be reconciled using the server-generated task receipt in the known session. A lost profile/session creation response requires an operator to inspect the provider dashboard, stop orphan sessions if present, and repair that account’s server-owned state before retrying. Provider acceptance or an agent’s success report is not independent proof that a file saved correctly.

The Cloudflare adapter stores each owner’s cookies and visited origins’ local storage in that owner’s Durable Object, with bounded, chunked storage. It does not persist IndexedDB, session storage, browser extensions, or the full Chromium profile. Some sites will require a fresh login. It uses visible DOM text and bounded keyboard/click actions; canvas-only editors and cross-origin editor frames are not yet verified. Durable alarms continue tasks while the website is closed. A persisted interrupted action fails for human review instead of being replayed. The browser expires after ten idle minutes; an active live connection or polling can keep it alive.

On-device AI mode cannot start cloud browser work. Status, takeover, close, and downloads remain available to manage previously authorized tasks.

## Validation

- `node scripts/cloudflare-browser-regressions.mjs`: service authentication, owner/session binding, restricted actions, restart recovery, monitoring during execution, and takeover during inference.
- `node scripts/browser-workspace-regressions.mjs`: real handlers and SQL with isolated SQLite/provider fixtures; D1 and PostgreSQL paths, account isolation, quota, leases, takeover, output ownership and uncertain submission recovery.
- `node scripts/browser-workspace-ui.mjs`: real React components and isolated browser; mobile/desktop layout, controls, token headers, no live URL in tool output, account changes.
- `node scripts/browser-image-cost-regressions.mjs`: existing browser API compatibility.
- `npm run build`, `node scripts/check-nalu-sync.mjs`, native chat contract and cross-client integration checks.

## Activation status (2026-11-04)

The private Cloudflare backend has been deployed, but the website has NOT been released or connected to it. Its dedicated service key is configured only on the Worker. No user credentials were imported.

Verified against the actual Cloudflare account: Chrome 152 launch, website navigation, typing/clicking in an isolated test page, standalone Workers AI inference, owner-isolated live sessions, denial of a different synthetic account, and session closure. End-to-end autonomous task execution has NOT passed: the first test failed before taking an action, then Cloudflare began rejecting new sessions with HTTP 429, including direct REST calls. Capacity reported no active sessions and 847.245 seconds used. This suggests the free browser-time allowance may be involved, but the billing-plan API returned 403, so the account plan is unconfirmed. Do not infer that the code is production-ready or that Word/Excel editing works from the standalone tests.

Next: restore/confirm browser capacity, finish the autonomous task and takeover/profile tests, validate Microsoft login and disposable Word/Excel saves, configure the Vercel service secret, apply the D1 migration, then use the checked web release workflow. Browser Run pricing: https://developers.cloudflare.com/browser-run/pricing/ . No subscription upgrade has been made.

The dependency audit reports issues in Node-only browser-download/proxy dependencies of `@cloudflare/puppeteer` 1.4.0. The checked Worker bundle does not contain `extract-zip`, `basic-ftp`, or `proxy-agent`; no browser installer or archive extraction is run in the Worker. Recheck dependency updates before release.
