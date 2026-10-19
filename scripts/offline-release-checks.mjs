import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Deterministic source checks and synthetic providers only. Real generation,
// account mutations, provider credentials and public-domain changes are excluded.
const cwd = fileURLToPath(new URL('../', import.meta.url))
const scripts = [
  'deploy-release-regressions.mjs',
  'project-data-regressions.mjs',
  'cloudflare-store-regressions.mjs',
  'chat-handler-regressions.mjs',
  'chat-budget-regressions.mjs',
  'chat-length-regressions.mjs',
  'sheet-correctness-regressions.mjs',
  'cron-regressions.mjs',
  'cron-deadline-regressions.mjs',
  'cron-stop-regressions.mjs',
  'pipeline-continuation-regressions.mjs',
  'storage-deadline-regressions.mjs',
  'reference-document-regressions.mjs',
  'public-fetch-regressions.mjs',
  'quota-regressions.mjs',
  'voice-provider-regressions.mjs',
  'browser-image-cost-regressions.mjs',
  'logo-generation-controls-regressions.mjs',
  'attachment-extraction-regressions.mjs',
  'catalogue-browser-regressions.mjs',
  'web-evidence-regressions.mjs',
  'llm-cancellation-regressions.mjs',
  'website-generation-regressions.mjs',
  'website-edit-preservation.test.mjs',
  'studio-generation-regressions.mjs',
  'design-correctness-regressions.mjs',
  'cad-budget-regressions.mjs',
  'hedge-fund-risk-regressions.mjs',
  'map-comparison-regressions.mjs',
  'map-ai-budget-regressions.mjs',
  'chrome-action-regressions.mjs',
  'chrome-content-regressions.mjs',
  'studio-cancellation-regressions.mjs',
  'video-cancellation-regressions.mjs',
  'studio-runtime-regressions.mjs',
  'swarm-store-regressions.mjs',
  'swarm-service-regressions.mjs',
  'swarm-route-regressions.mjs',
  'swarm-scheduler-regressions.mjs',
  'swarm-cloudflare-contract-regressions.mjs',
  'swarm-execution-regressions.mjs',
  'swarm-generation-regressions.mjs',
  'swarm-studio-regressions.mjs',
  'swarm-studio-hooks-regressions.mjs',
  'swarm-studio-route-regressions.mjs',
  'swarm-studio-worker-regressions.mjs',
  'swarm-studio-media-regressions.mjs',
  'workspace-swarm-controller.test.mjs',
  'workspace-swarm-studio-client.test.mjs',
  'workspace-swarm-presentation.test.mjs',
  'workspace-swarm-studio-browser.mjs',
  'artifact-isolation-browser-regressions.mjs',
  'auth-sync-browser-regressions.mjs',
  'account-project-browser-regressions.mjs',
  'studio-artifact-regressions.mjs',
  'autopilot-output-browser-regressions.mjs',
  'map-browser-verify.mjs',
  ['map-browser-verify.mjs', '--camera'],
  ['map-browser-verify.mjs', '--layers'],
  ['map-browser-verify.mjs', '--comparisons'],
  'workspace-shell-browser-regressions.mjs',
]
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|SECRET|TOKEN|DATABASE_URL|CLOUDFLARE_DATA_URL)$/.test(key)))
// A release always exercises every fixture, even if the parent shell was used
// for an audit-only or single-artifact diagnosis earlier.
for (const key of ['BASE_URL', 'AUDIT_ONLY', 'ARTIFACT_CASE', 'OUTPUT_DIR']) delete env[key]
for (const check of scripts) {
  const [script, ...args] = Array.isArray(check) ? check : [check]
  console.log(`Checking ${[script, ...args].join(' ')}`)
  const result = spawnSync(process.execPath, ['--experimental-strip-types', `scripts/${script}`, ...args], { cwd, env, stdio: 'inherit', timeout: ['cloudflare-store-regressions.mjs', 'studio-artifact-regressions.mjs'].includes(script) ? 300000 : 180000 })
  if (result.error || result.status !== 0) { console.error(`FAIL ${script}: ${result.error?.message || `exit ${result.status}`}`); process.exit(result.status || 1) }
}
const build = spawnSync('npm', ['run', 'build'], { cwd, env, stdio: 'inherit', timeout: 180000 })
if (build.error || build.status !== 0) { console.error(`FAIL production build: ${build.error?.message || `exit ${build.status}`}`); process.exit(build.status || 1) }
console.log('PASS offline release gate. Sibling consistency and public preview checks are separate required release steps.')
