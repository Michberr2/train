import { spawnSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import { checkPreview } from './preview-release-checks.mjs'

export const RELEASE_DOMAINS = ['n4lu.ai', 'www.n4lu.ai', 'n4lu.com', 'www.n4lu.com']
const root = fileURLToPath(new URL('../', import.meta.url))
export async function assertCanonicalWebDesign(cwd) {
  // The redesigned landing/workspace is now the product baseline. Keep this
  // guard in the release path so a clean checkout cannot silently publish the
  // retired slide-based frontend again.
  const app = await readFile(resolve(cwd, 'client/src/App.tsx'), 'utf8').catch(() => '')
  const workspace = await readFile(resolve(cwd, 'client/src/components/workspace/design/DesignedWorkspace.tsx'), 'utf8').catch(() => '')
  const appUsesDesign = /import\s+LandingPage\s+from\s+['"]\.\/components\/landing\/LandingPage['"]/.test(app)
    && /<LandingPage\b/.test(app)
    && /import\(\s*['"]\.\/components\/workspace\/design\/DesignedWorkspace['"]\s*\)/.test(app)
    && /<Workspace\b/.test(app)
  const wrapperEnablesDesign = /import\s+Workspace\s+from\s+['"]\.\.\/Workspace['"]/.test(workspace)
    && /import\s+WorkspaceDesignSurface\s+from\s+['"]\.\/WorkspaceDesignSurface['"]/.test(workspace)
    && /<WorkspaceDesignSurface>\s*<Workspace\b[^>]*\sdesignEnabled(?:\s|\/?>)/.test(workspace)
    && /<\/WorkspaceDesignSurface>/.test(workspace)
  if (!appUsesDesign || !wrapperEnablesDesign) {
    throw new Error('Release blocked: canonical Nalu redesign is missing from the web frontend.')
  }
}
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
  const customSource = metadata.meta?.naluSourceCommit
  const gitSource = metadata.meta?.gitCommitSha
  // Vercel's Git integration supplies gitCommitSha when the release was not
  // created by this helper. Accept its authenticated identity with the same
  // strict revision validation, and never hide conflicting source claims.
  for (const [field, source] of [['naluSourceCommit', customSource], ['gitCommitSha', gitSource]]) {
    if (source != null) assert.match(source, /^[a-f0-9]{40}$/i, `${deploymentId}: no valid ${field} in authenticated deployment metadata. Reconcile the source identity before releasing.`)
  }
  if (customSource != null && gitSource != null) assert.equal(customSource.toLowerCase(), gitSource.toLowerCase(), `${deploymentId}: naluSourceCommit and gitCommitSha identify different sources. Reconcile the deployment metadata before releasing.`)
  // Retain only nonsecret identity fields; never persist raw deployment/env data.
  return { sourceCommit: (customSource ?? gitSource)?.toLowerCase() }
}

export function verifyReleaseAncestry({ currentSource, candidateSource, domain, operation, git }) {
  for (const [label, source] of [['live', currentSource], ['candidate', candidateSource]]) {
    assert.match(source || '', /^[a-f0-9]{40}$/i, `${domain}: ${label} deployment has no valid naluSourceCommit. Reconcile its source metadata before releasing.`)
    try { git(['cat-file', '-e', `${source}^{commit}`]) } catch {
      throw new Error(`${domain}: ${label} source ${source} is unavailable in this checkout. Fetch the source history from the intended repository, reconcile it, and retry; no domains were changed by this check.`)
    }
  }
  const ancestor = operation === 'rollback' ? candidateSource : currentSource
  const descendant = operation === 'rollback' ? currentSource : candidateSource
  try { git(['merge-base', '--is-ancestor', ancestor, descendant]) } catch {
    throw new Error(operation === 'rollback'
      ? `${domain}: rollback source ${candidateSource} is not an ancestor of live source ${currentSource}. Fetch complete history and select a reviewed ancestor; unrelated releases cannot be used as rollbacks.`
      : `${domain}: candidate source ${candidateSource} does not include live source ${currentSource}. Fetch and merge the deployed source into this release before retrying; refusing to replace newer or unrelated work.`)
  }
}

/** Injected runner/fetch are only used by deterministic local regressions. No
 * environment switch can bypass source, test, preview or domain checks. */
export async function release({ cwd = root, target, publish, run = runProcess, fetchImpl = globalThis.fetch, readToken = cliToken, log = console.log, writeReceipt = true } = {}) {
  assert.ok(!(target && publish), 'Choose publication or rollback, not both')
  const operation = publish ? 'publish' : target ? 'rollback' : 'deploy'
  const call = (command, args) => run(command, args, cwd)
  assert.equal(call('git', ['status', '--porcelain']).trim(), '', 'Release from a clean, reviewed checkout. Commit only the intended source first.')
  await assertCanonicalWebDesign(cwd)
  const commit = call('git', ['rev-parse', 'HEAD']).trim()
  assert.match(commit, /^[a-f0-9]{40}$/i, 'A committed source revision is required')
  const project = JSON.parse(await readFile(resolve(cwd, '.vercel/project.json'), 'utf8'))
  assert.ok(project.projectId && project.orgId, 'Link the intended Vercel project before deploying')
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
  let deploymentUrl = target || publish
  let reviewedDeployment
  if (deploymentUrl) {
    assert.match(deploymentUrl, /^https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?$/, 'Publication or rollback requires the exact reviewed deployment URL')
    reviewedDeployment = await inspect(deploymentUrl)
    if (operation !== 'rollback') assert.equal(reviewedDeployment.sourceCommit, commit, 'Candidate does not identify the checked source commit')
  }
  const candidateSource = reviewedDeployment ? reviewedDeployment.sourceCommit : commit
  const verifyAncestry = (info, domain) => verifyReleaseAncestry({ currentSource: info.sourceCommit, candidateSource, domain, operation, git: args => call('git', args) })
  const previous = {}
  log('Checking that the release preserves the source currently live on every domain…')
  for (const domain of RELEASE_DOMAINS) {
    const current = await inspect(domain)
    verifyAncestry(current, domain)
    previous[domain] = current.id
  }
  log('Checking source, offline regressions, build and sibling compatibility…')
  call(process.execPath, ['scripts/offline-release-checks.mjs'])
  call(process.execPath, ['scripts/check-nalu-sync.mjs'])
  call(process.execPath, ['--experimental-strip-types', 'scripts/native-chat-contract-regressions.mjs'])
  call(process.execPath, ['scripts/flow-cross-client-integration.mjs'])
  assert.equal(call('git', ['status', '--porcelain']).trim(), '', 'Checks changed tracked or untracked source; inspect it before release')
  assert.equal(call('git', ['rev-parse', 'HEAD']).trim(), commit, 'Source commit changed while checks ran')
  if (!deploymentUrl) {
    log('Building production candidate without moving public domains…')
    const text = cli(['deploy', '--prod', '--skip-domain', '--yes', '--meta', `naluSourceCommit=${commit}`])
    const urls = [...new Set(text.split(/\s+/).filter(value => /^https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?$/.test(value)))]
    assert.equal(urls.length, 1, 'Deployment did not return one unambiguous deployment URL')
    deploymentUrl = urls[0]
  }
  const deployment = reviewedDeployment || await inspect(deploymentUrl)
  if (operation !== 'rollback') assert.equal(deployment.sourceCommit, commit, 'Candidate does not identify the checked source commit')
  assert.equal(call('git', ['status', '--porcelain']).trim(), '', 'Source changed while the candidate was built; inspect it before publication')
  assert.equal(call('git', ['rev-parse', 'HEAD']).trim(), commit, 'Source commit changed while the candidate was built')
  log(`Verifying candidate ${deployment.id}…`)
  const candidate = await checkPreview(deploymentUrl, { fetchImpl })
  const receipt = { at: new Date().toISOString(), operation, sourceCommit: deployment.sourceCommit, releaseCheckoutCommit: commit, projectId: project.projectId, deploymentId: deployment.id, deploymentUrl, previous, candidate, domains: [], complete: false }
  const persist = async () => {
    if (!writeReceipt) return
    await mkdir(resolve(cwd, '.vercel'), { recursive: true })
    await writeFile(resolve(cwd, '.vercel/last-release.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  await persist()
  try {
    for (const domain of RELEASE_DOMAINS) {
      // Do not overwrite a concurrent deployment that happened during checks.
      const before = await inspect(domain)
      assert.ok(before.id === previous[domain] || before.id === deployment.id, `${domain}: changed to another release; stop and reconcile`)
      verifyAncestry(before, domain)
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
