import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseReleaseArguments, selectReleaseChecks } from './lib/release-check-mode.mjs'

// Deterministic source checks and synthetic providers only. Real generation,
// account mutations, provider credentials and public-domain changes are excluded.
const cwd = fileURLToPath(new URL('../', import.meta.url))
export const OFFLINE_RELEASE_CHECKS = [
  'deploy-release-regressions.mjs',
  'offline-release-checks-regressions.mjs',
  'project-data-regressions.mjs',
  'cloudflare-store-regressions.mjs',
  'chat-handler-regressions.mjs',
  'chat-verifier-regressions.mjs',
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
  'website-behavior-regressions.mjs',
  'website-behavior-eval-regressions.mjs',
  'website-download-content-regressions.mjs',
  'website-download-stream-regressions.mjs',
  'website-download-runtime-regressions.mjs',
  'website-requirements-regressions.mjs',
  'website-requirement-review-regressions.mjs',
  'website-artifact-sync-regressions.mjs',
  'chat-save-payload-regressions.mjs',
  'studio-generation-regressions.mjs',
  'design-correctness-regressions.mjs',
  'cad-budget-regressions.mjs',
  'hedge-fund-risk-regressions.mjs',
  'map-comparison-regressions.mjs',
  'map-ai-budget-regressions.mjs',
  'map-plan-regressions.mjs',
  'map-places-recovery-regressions.mjs',
  'map-search-recovery-regressions.mjs',
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
  'workspace-loading-regressions.mjs',
  'workspace-memory-regressions.mjs',
  'writing-memory-regressions.mjs',
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
export function runOfflineReleaseChecks({ browserTestSkipReason, run = spawnSync, log = console.log, sourceEnv = process.env } = {}) {
  const plan = selectReleaseChecks(OFFLINE_RELEASE_CHECKS, browserTestSkipReason)
  const env = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !/(?:API_KEY|SECRET|TOKEN|DATABASE_URL|CLOUDFLARE_DATA_URL)$/.test(key)))
  // Fixture selection from a diagnostic shell never narrows a release. Only
  // the explicit, recorded CLI/API waiver can omit browser-executing suites.
  for (const key of ['BASE_URL', 'AUDIT_ONLY', 'ARTIFACT_CASE', 'CAROUSEL_ONLY', 'OUTPUT_DIR']) delete env[key]
  for (const command of plan.skipped) log(`NOT RUN browser check ${command.join(' ')}: ${plan.reason}`)
  const execute = (command, args, timeout, label) => {
    const result = run(command, args, { cwd, env, stdio: 'inherit', timeout })
    if (result.error || result.status !== 0) {
      const error = new Error(`FAIL ${label}: ${result.error?.message || `exit ${result.status}`}`)
      error.exitCode = result.status || 1
      throw error
    }
  }
  for (const [script, ...args] of plan.run) {
    log(`Checking ${[script, ...args].join(' ')}`)
    execute(process.execPath, ['--experimental-strip-types', `scripts/${script}`, ...args], ['cloudflare-store-regressions.mjs', 'studio-artifact-regressions.mjs'].includes(script) ? 300000 : 180000, script)
  }
  execute('npm', ['run', 'build'], 180000, 'production build')
  log(plan.mode === 'full' ? 'PASS offline release gate. Sibling consistency and public preview checks are separate required release steps.' : `PASS non-browser release checks and production build. Browser tests NOT RUN: ${plan.reason}. Sibling consistency and HTTP preview checks remain required.`)
  return { mode: plan.mode, ...(plan.reason ? { reason: plan.reason } : {}), checked: plan.run, skipped: plan.skipped, buildPassed: true }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runOfflineReleaseChecks(parseReleaseArguments(process.argv.slice(2), { offline: true })) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = error.exitCode || 1 }
}
