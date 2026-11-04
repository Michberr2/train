# Account browser workspace

The web workspace now exposes a Browser app and `browser_work` / `browser_status` chat tools. The browser runs through the existing Browser Use v2 integration. Each authenticated account gets its own provider profile and at most one active task. Users sign in to Microsoft Word/Excel web apps or other sites in the live view. Nalu login does not import local Chrome cookies or grant Microsoft access.

## Activation and release

- Set `BROWSER_USE_API_KEY` in the production Nalu Vercel project. It must belong to a funded Browser Use project supporting saved profiles. Do not put it in a `VITE_` variable or chat.
- Apply `cloudflare/nalu-data/migrations/0018_browser_workspaces.sql` to production D1 before activation if `NALU_STORAGE_BACKEND=cloudflare`. The PostgreSQL path initializes this table on first authenticated browser request.
- Release from a clean checkout containing the approved UI and latest fixes via `./deploy.sh`. The main development checkout contains extensive unrelated work and must not be committed wholesale.
- Verify n4lu.com, n4lu.ai, and both www aliases with the checked release workflow. Then test two distinct Nalu accounts, manual Microsoft login/MFA, a disposable Word document and Excel workbook, saved-file readback, takeover, closure, profile reuse and private downloads. Synthetic tests do not prove provider availability or successful work in Office.

## Behavior and contracts

`POST /api/browser` retains the original `run`, `status`, `cancel` contract for existing callers. New account-scoped actions: `workspace_status`, `workspace_open`, `workspace_run`, `workspace_takeover`, `workspace_close`, `workspace_download`. Clients never choose provider session/profile IDs. Browser work is executed by the provider and continues independently of the requesting tab. Polling updates the shared task ledger; without an open client the ledger can lag provider completion.

`workspace_takeover` stops the AI task while keeping the browser open. The next task is an explicit follow-up; this is not a paused task resumed at the same step. `workspace_close` stops the session and allows the provider to save the profile. Keep-alive sessions incur provider browser usage until closed or expired by the provider. Login state can expire at any website.

Private live-view URLs are returned only to authenticated owners, never put in model context or synced chat history, and embedded only from the browser provider’s HTTPS domain. The new table is server-owned rather than user-editable synced data. A 90-second database lease serializes requests; requests time out after 60 seconds. Task starts reserve the existing browser daily quota and are capped at 60 steps. Recordings and cross-task conversation memory are disabled. The current task’s output files can be downloaded with owner checks; files from older tasks are not yet browsable from this panel.

A lost POST response remains uncertain; it is never automatically retried. Task submission can be reconciled using the server-generated task receipt in the known session. A lost profile/session creation response requires an operator to inspect the provider dashboard, stop orphan sessions if present, and repair that account’s server-owned state before retrying. Provider acceptance or an agent’s success report is not independent proof that a file saved correctly.

On-device AI mode cannot start cloud browser work. Status, takeover, close, and downloads remain available to manage previously authorized tasks.

## Validation

- `node scripts/browser-workspace-regressions.mjs`: real handlers and SQL with isolated SQLite/provider fixtures; D1 and PostgreSQL paths, account isolation, quota, leases, takeover, output ownership and uncertain submission recovery.
- `node scripts/browser-workspace-ui.mjs`: real React components and isolated browser; mobile/desktop layout, controls, token headers, no live URL in tool output, account changes.
- `node scripts/browser-image-cost-regressions.mjs`: existing browser API compatibility.
- `npm run build`, `node scripts/check-nalu-sync.mjs`, native chat contract and cross-client integration checks.

As of implementation, production has no browser service key. Live browser/Office execution has not been verified or claimed.
