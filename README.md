# Train — Nalu web app and shared API

This repository serves the public Nalu website, the signed-in browser workspace,
and the shared API used by the browser, iPhone app, Mac app and CLI. Production
domains are `n4lu.ai`, `www.n4lu.ai`, `n4lu.com` and `www.n4lu.com`.

Authentication and saved account data are server-backed. The browser keeps an
account-scoped working cache and session token; it is not the authority for
authentication. Never add provider keys or database credentials to browser code.

## Repository map

| Path | Responsibility |
| --- | --- |
| `client/` | React, TypeScript, Vite and Tailwind public pages and signed-in workspace |
| `api/` | Vercel Node routes for accounts, streamed chat, Studio, data, tasks, team, voice, attachments and connected services |
| `api/_*.ts` | Shared server modules; underscore files are not public routes |
| `shared/` | Portable contracts and helpers used by the browser, server and tests |
| `cloudflare/nalu-data/` | Signed internal data worker, D1 migrations and R2 file storage |
| `scripts/` and `tests/` | Deterministic regressions, browser fixtures and explicit live integration checks |
| `training/` | Model training/evaluation tools; separate from the web deployment |
| `../nalumobile/` | Separate Expo/iOS client implementation |
| `../naludesktop/` | Separate Electron/Mac client and authoritative CLI/installer source |

Read [AGENTS.md](AGENTS.md) before cross-repository changes. Published CLI files
under `client/public/` must come from `sh cli/publish.sh` in `naludesktop` after
its CLI tests pass. Do not edit those copies independently.

## Install and develop

Use Node 24 LTS and npm with the committed lockfile. Some offline fixtures use
Node's built-in SQLite and TypeScript support. Keep sibling repositories beside
this checkout under the names above; the synchronization check fails if they are
missing, rather than reporting incomplete verification as success.

```sh
npm ci
npx playwright install chromium
npm run dev
```

The Vite UI runs on port 5180. `npm run dev` first checks sibling consistency.
Vite alone does not implement `/api/*`; browser fixtures mock those routes, while
full account/provider integration requires a configured API environment.

For the full local Vercel environment, install the tested Vercel CLI 50.4.0, log
in, link this checkout to the intended Nalu project, and pull development
configuration into ignored `.env.local`:

```sh
vercel login
vercel link
vercel env pull .env.local
vercel dev --listen 3000
```

Use the linked project's development command to serve the Vite app with its API
routes. Do not point a development session at production account storage unless
the task explicitly calls for it. If local API routing is not configured, use a
separate preview environment for integration checks; a Vite-only page is not an
API test.

## Server configuration

Store secrets in Vercel environment configuration or a local ignored environment
file. Configure preview and production independently. These are the main service
boundaries, not an exhaustive list of every optional provider setting:

| Capability | Server settings |
| --- | --- |
| PostgreSQL account/data backend | `DATABASE_URL`; backend selected when `NALU_STORAGE_BACKEND` is not `cloudflare` |
| Cloudflare account/data backend | `NALU_STORAGE_BACKEND=cloudflare`, `CLOUDFLARE_DATA_URL`, `CLOUDFLARE_DATA_SECRET`; the worker requires matching secret, D1 and R2 bindings |
| Primary model | `TINKER_API_KEY`; optional `TINKER_BASE_URL`, `NALU_DEFAULT_MODEL` |
| Model fallback | `NALU_FALLBACK_API_KEY` or `HUGGINGFACE_API_TOKEN`, optional fallback URL/model; Gemini emergency provider where configured |
| Studio images | Gemini/FAL or configured image provider keys; inspect `api/_imageGeneration.ts` for supported settings |
| Email and scheduled tasks | `RESEND_API_KEY`, `CRON_SECRET`; only configured schedulers should invoke cron routes |
| Voice and transcription | Provider settings in `api/tts.ts`, `api/transcribe.ts` and `api/_telephony.ts` |
| OAuth and connected services | Provider registrations and settings in `api/_oauthProviders.ts` and connection modules |

Cloudflare schema changes are a separate release step: review and apply the
versioned migrations in `cloudflare/nalu-data/migrations/` with the worker's
configured D1 database before deploying code that requires them. Do not switch
backends as a rollback strategy; that can split account data between stores.

`GET /api/health` checks configuration and database access without paid model
generation. `?deep=1` also makes a real model request. Health is a narrow service
check, not proof that every account or generated artifact workflow works.

## Required checks

```sh
node scripts/offline-release-checks.mjs
node scripts/check-nalu-sync.mjs
node --experimental-strip-types scripts/native-chat-contract-regressions.mjs
node scripts/preview-release-checks.mjs https://your-deployment.vercel.app
BASE_URL=https://your-deployment.vercel.app npm run studio:smoke
```

The offline gate builds the production app and runs deterministic regressions
for deployment failures, project conflicts, Cloudflare storage, chat, Studio
generation/cancellation/runtime checks, artifact isolation, sharing and account
switching. Its model providers and account mutations are synthetic. It does not
need production credentials. Install Playwright Chromium before running it.
`npm run check:release` combines the offline and sibling checks;
`npm run check:preview -- https://your-deployment.vercel.app` runs the read-only
preview check on an existing deployment.

The separate sibling checks verify published CLI bytes, API origins, route
presence and native stream contracts. They do not prove full feature parity.

The preview checker makes read-only requests. It requires healthy database/model
configuration, a real JavaScript entry, and exact JSON error contracts from
existing API handlers. A 404 route, SPA HTML fallback, 5xx response or degraded
health fails. It does not sign in or generate paid content. Use designated test
accounts for authenticated integration tests and explicitly opt into paid suites
with `STUDIO_FULL=1`; the default smoke suite does not prove generation quality.

The workflow in `.github/workflows/release-checks.yml` runs the offline gate on
pull requests and pushes. Its sibling job needs read access to all three repos;
configure `NALU_REPO_READ_TOKEN` if the default GitHub token cannot read the native
repositories. A manually supplied preview URL enables the preview checks without
deploying or changing aliases. CI failing to fetch a sibling is incomplete
verification and must be resolved before release.
Set `NALU_MOBILE_REVIEWED_REF` and `NALU_DESKTOP_REVIEWED_REF` repository variables
to the reviewed sibling commit IDs. They default to `main`; that branch must
contain the coordination files and tested native consumers. Local uncommitted
native files do not satisfy remote CI. Publish only the reviewed sibling changes
and run the workflow before claiming that the clean multi-repository gate passed.

## Publish and rollback

Release from a clean checkout containing only reviewed, committed source. Do not
bulk-stage an existing dirty workspace to satisfy the gate. The release script
rejects uncommitted or untracked source, and never stages or commits anything.
Keep the local `.vercel/project.json` linked to the intended project.

```sh
./deploy.sh
```

The script runs offline and sibling gates, creates a production candidate with
`--skip-domain`, checks its READY deployment ID, project and source-commit
metadata, and verifies its app/API responses before changing any public domain.
Deployment identity and project ownership come from the authenticated Vercel API;
the script uses the current CLI login or `VERCEL_TOKEN`. A source change during
the checks or candidate build stops publication.
It then assigns all four domains, verifies each alias against the intended
deployment ID, checks health and exact JavaScript entry bytes, and verifies the
aliases again before reporting success. A failed command or check exits nonzero.

For a change that needs authenticated, paid or host-specific acceptance checks,
create the candidate separately from the clean reviewed checkout:

```sh
vercel deploy --prod --skip-domain --yes --meta "naluSourceCommit=$(git rev-parse HEAD)"
```

Run the relevant acceptance checks against the returned deployment URL, including
the real Studio browser request when its runtime changed, then publish that exact
candidate:

```sh
./deploy.sh --publish https://verified-candidate.vercel.app
```

This mode repeats the source/offline/sibling/preview gates, requires the candidate
metadata to identify the checkout's HEAD, and verifies all domains. It records a
publication operation and does not create a replacement candidate. Paid generation
is never silently added to the routine offline gate.

The ignored `.vercel/last-release.json` records the intended deployment, previous
domain targets, verified domains, checks and any partial-release error. It never
contains API credentials. Domain assignment is not atomic: a later failure may
leave earlier domains on the candidate. Inspect this receipt before retrying or
rolling back, and never infer success from a candidate build alone.

To restore a reviewed existing deployment, use its exact URL from the prior
receipt or Vercel deployment history:

```sh
./deploy.sh --rollback https://previous-deployment.vercel.app
```

Rollback performs the same health, route, project, alias and app-byte checks; it
does not rebuild the old release or reverse database migrations. Check migration
compatibility before selecting an older API release. Keep evidence of the exact
source commit and deployment ID with release reviews.

Mac installers and updater metadata are released from `naludesktop`, after
signing, notarization and runtime acceptance. Changing the website download link
alone does not publish an accepted desktop release or update installed devices.

## Generated content boundaries

Generated HTML previews, Open windows and public shares run with an opaque
sandbox. Scripts, forms, internal navigation and downloads remain available;
generated code cannot read the account's storage or cookies. Its storage shim is
private and ephemeral. Do not add `allow-same-origin` or popup sandbox escape.

Logo SVG is decoded as an image rather than inserted into the workspace DOM.
SVG exports retain a vector image wrapper; external resources and scripts inside
the supplied SVG are intentionally inactive. Sharing creates a labeled snapshot
of the current revision and reports oversized content instead of silently
truncating it. Download HTML when the public-sharing size limit is exceeded.

Studio website generation runs a separate Chromium browser before returning a
build. It checks JavaScript failures, overflow and the requested interaction
steps at desktop and phone widths, then performs bounded repairs against the
same expectations. Missing interaction coverage is reported as partial; browser
unavailability or unresolved failures return an error instead of a verified
build. External integrations and images are not validated by the offline browser.

Production needs the pinned `@sparticuz/chromium` binary and matching
`playwright-core` package included in the design function. Its configuration in
`vercel.json` reserves memory and enables request cancellation. Stop aborts model,
research and browser work, and incomplete requests release their reserved quota.
After changing browser packages or function configuration, exercise a real
candidate `/api/design` request and inspect its runtime results before publishing;
a successful bundle does not prove Chromium can launch on the deployment host.
