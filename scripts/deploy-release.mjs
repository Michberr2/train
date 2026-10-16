import { spawnSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import { checkPreview } from './preview-release-checks.mjs'

export const RELEASE_DOMAINS = ['n4lu.ai', 'www.n4lu.ai', 'n4lu.com', 'www.n4lu.com']
const root = fileURLToPath(new URL('../', import.meta.url))
function runProcess(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1', VERCEL_TELEMETRY_DISABLED: '1' } })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`)
  return result.stdout.trim()
}
function deploymentInfo(text, target) {
  let result
  try { result = JSON.parse(text) } catch { throw new Error(`${target}: Vercel inspect did not return valid JSON`) }
  const id = result.id || result.uid
  assert.match(id || '', /^dpl_[a-zA-Z0-9]+$/, `${target}: missing deployment ID`)
  assert.equal(result.readyState || result.state || result.status, 'READY', `${target}: deployment is not READY`)
  assert.ok(typeof result.url === 'string' && /^[a-zA-Z0-9.-]+\.vercel\.app$/.test(result.url.replace(/^https:\/\//, '')), `${target}: invalid deployment URL`)
  return { ...result, id }
}

async function cliToken() {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN
  const location = process.platform === 'darwin' ? resolve(homedir(), 'Library/Application Support/com.vercel.cli/auth.json')
    : resolve(process.env.XDG_DATA_HOME || resolve(homedir(), '.local/share'), 'com.vercel.cli/auth.json')
  try {
    const auth = JSON.parse(await readFile(location, 'utf8'))
    if (typeof auth.token === 'string' && auth.token) return auth.token
  } catch { /* Use an explicit credential error without exposing auth files. */ }
  throw new Error('Vercel API verification needs a current CLI login or VERCEL_TOKEN. Run vercel login before releasing.')
}

export async function verifyDeploymentMetadata(deploymentId, project, { fetchImpl = globalThis.fetch, readToken = cliToken } = {}) {
  const response = await fetchImpl(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}?teamId=${encodeURIComponent(project.orgId)}`, { headers: { Authorization: `Bearer ${await readToken()}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25000) })
  assert.equal(response.status, 200, `${deploymentId}: cannot verify authenticated deployment metadata (HTTP ${response.status})`)
  const metadata = await response.json()
  assert.equal(metadata.id, deploymentId, `${deploymentId}: metadata deployment ID mismatch`)
  assert.equal(metadata.projectId || metadata.project?.id, project.projectId, `${deploymentId}: wrong Vercel project`)
  assert.equal(metadata.readyState, 'READY', `${deploymentId}: authenticated deployment state is not READY`)
  assert.equal(metadata.target, 'production', `${deploymentId}: deployment was not built with production environment settings`)
  // Retain only nonsecret identity fields; never persist raw deployment/env data.
  return { sourceCommit: metadata.meta?.naluSourceCommit }
}

/** Injected runner/fetch are only used by deterministic local regressions. No
 * environment switch can bypass source, test, preview or domain checks. */
export async function release({ cwd = root, target, publish, run = runProcess, fetchImpl = globalThis.fetch, readToken = cliToken, log = console.log, writeReceipt = true } = {}) {
  assert.ok(!(target && publish), 'Choose publication or rollback, not both')
  const operation = publish ? 'publish' : target ? 'rollback' : 'deploy'
  const call = (command, args) => run(command, args, cwd)
  assert.equal(call('git', ['status', '--porcelain']).trim(), '', 'Release from a clean, reviewed checkout. Commit only the intended source first.')
  const commit = call('git', ['rev-parse', 'HEAD']).trim()
  assert.match(commit, /^[a-f0-9]{40}$/i, 'A committed source revision is required')
  const project = JSON.parse(await readFile(resolve(cwd, '.vercel/project.json'), 'utf8'))
  assert.ok(project.projectId && project.orgId, 'Link the intended Vercel project before deploying')
  log('Checking source, offline regressions, build and sibling compatibility…')
  call(process.execPath, ['scripts/offline-release-checks.mjs'])
  call(process.execPath, ['scripts/check-nalu-sync.mjs'])
  call(process.execPath, ['--experimental-strip-types', 'scripts/native-chat-contract-regressions.mjs'])
  assert.equal(call('git', ['status', '--porcelain']).trim(), '', 'Checks changed tracked or untracked source; inspect it before release')
  assert.equal(call('git', ['rev-parse', 'HEAD']).trim(), commit, 'Source commit changed while checks ran')
  const cli = (args) => call('vercel', [...args, '--scope', project.orgId, ...(process.env.VERCEL_TOKEN ? ['--token', process.env.VERCEL_TOKEN] : [])])
  // Refresh short-lived CLI login credentials before reading the auth file for
  // API metadata verification. CI can instead supply an explicit scoped token.
  cli(['whoami'])
  const deploymentMetadata = new Map()
  const inspect = async value => {
    const info = deploymentInfo(cli(['inspect', value, '--json']), value)
    if (!deploymentMetadata.has(info.id)) {
      deploymentMetadata.set(info.id, await verifyDeploymentMetadata(info.id, project, { fetchImpl, readToken }))
    }
    return { ...info, ...deploymentMetadata.get(info.id) }
  }
  const previous = {}
  for (const domain of RELEASE_DOMAINS) previous[domain] = (await inspect(domain)).id
  let deploymentUrl = target || publish
  if (!deploymentUrl) {
    log('Building production candidate without moving public domains…')
    const text = cli(['deploy', '--prod', '--skip-domain', '--yes', '--meta', `naluSourceCommit=${commit}`])
    const urls = [...new Set(text.split(/\s+/).filter(value => /^https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?$/.test(value)))]
    assert.equal(urls.length, 1, 'Deployment did not return one unambiguous deployment URL')
    deploymentUrl = urls[0]
  } else {
    assert.match(deploymentUrl, /^https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?$/, 'Publication or rollback requires the exact reviewed deployment URL')
  }
  const deployment = await inspect(deploymentUrl)
  if (operation !== 'rollback') assert.equal(deployment.sourceCommit, commit, 'Candidate does not identify the checked source commit')
  assert.equal(call('git', ['status', '--porcelain']).trim(), '', 'Source changed while the candidate was built; inspect it before publication')
  assert.equal(call('git', ['rev-parse', 'HEAD']).trim(), commit, 'Source commit changed while the candidate was built')
  log(`Verifying candidate ${deployment.id}…`)
  const candidate = await checkPreview(deploymentUrl, { fetchImpl })
  const receipt = { at: new Date().toISOString(), operation, sourceCommit: commit, projectId: project.projectId, deploymentId: deployment.id, deploymentUrl, previous, candidate, domains: [], complete: false }
  const persist = async () => {
    if (!writeReceipt) return
    await mkdir(resolve(cwd, '.vercel'), { recursive: true })
    await writeFile(resolve(cwd, '.vercel/last-release.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  await persist()
  try {
    for (const domain of RELEASE_DOMAINS) {
      // Do not overwrite a concurrent deployment that happened during checks.
      const before = (await inspect(domain)).id
      assert.ok(before === previous[domain] || before === deployment.id, `${domain}: changed to another release; stop and reconcile`)
      log(`Assigning and verifying ${domain}…`)
      cli(['alias', 'set', deploymentUrl, domain])
      assert.equal((await inspect(domain)).id, deployment.id, `${domain}: alias points to the wrong deployment`)
      const verified = await checkPreview('https://' + domain, { fetchImpl, expectedEntrySha256: candidate.entrySha256 })
      receipt.domains.push({ domain, deploymentId: deployment.id, verified })
      await persist()
    }
    // A final pass catches aliases changed during the sequence, before success.
    for (const domain of RELEASE_DOMAINS) assert.equal((await inspect(domain)).id, deployment.id, `${domain}: changed before release verification completed`)
    receipt.complete = true
    await persist()
    log(`Live and verified: ${RELEASE_DOMAINS.map(domain => 'https://' + domain).join(' ')} (${deployment.id})`)
    return receipt
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error)
    await persist()
    throw new Error(`Release incomplete: ${receipt.error}. Verified ${receipt.domains.length}/${RELEASE_DOMAINS.length} domains. Inspect .vercel/last-release.json before retrying or rolling back.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && !(args.length === 2 && ['--rollback', '--publish'].includes(args[0]))) throw new Error('Usage: ./deploy.sh [--publish https://verified-candidate.vercel.app | --rollback https://previous-deployment.vercel.app]')
    await release({ target: args[0] === '--rollback' ? args[1] : undefined, publish: args[0] === '--publish' ? args[1] : undefined })
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
