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
  'llm-cancellation-regressions.mjs',
  'website-generation-regressions.mjs',
  'website-edit-preservation.test.mjs',
  'studio-generation-regressions.mjs',
  'studio-cancellation-regressions.mjs',
  'studio-runtime-regressions.mjs',
  'artifact-isolation-browser-regressions.mjs',
  'auth-sync-browser-regressions.mjs',
  'account-project-browser-regressions.mjs',
]
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|SECRET|TOKEN|DATABASE_URL|CLOUDFLARE_DATA_URL)$/.test(key)))
for (const script of scripts) {
  console.log(`Checking ${script}`)
  const result = spawnSync(process.execPath, ['--experimental-strip-types', `scripts/${script}`], { cwd, env, stdio: 'inherit', timeout: 180000 })
  if (result.error || result.status !== 0) { console.error(`FAIL ${script}: ${result.error?.message || `exit ${result.status}`}`); process.exit(result.status || 1) }
}
const build = spawnSync('npm', ['run', 'build'], { cwd, env, stdio: 'inherit', timeout: 180000 })
if (build.error || build.status !== 0) { console.error(`FAIL production build: ${build.error?.message || `exit ${build.status}`}`); process.exit(build.status || 1) }
console.log('PASS offline release gate. Sibling consistency and public preview checks are separate required release steps.')
