import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { release, RELEASE_DOMAINS } from './deploy-release.mjs'
import { checkPreview } from './preview-release-checks.mjs'

const directory = await mkdtemp(join(tmpdir(), 'nalu-release-regression-'))
const commit = '1'.repeat(40), deploymentId = 'dpl_new123', previousId = 'dpl_old456', candidateUrl = 'https://nalu-fixture.vercel.app'
const report = []
try {
  await mkdir(join(directory, '.vercel'))
  await writeFile(join(directory, '.vercel/project.json'), JSON.stringify({ projectId: 'prj_fixture', orgId: 'team_fixture' }))
  function fixture(options = {}) {
    const calls = [], logs = [], aliases = Object.fromEntries(RELEASE_DOMAINS.map(domain => [domain, previousId]))
    let statusCalls = 0, commitCalls = 0
    const inspections = {}
    const run = (command, args) => {
      calls.push({ command, args })
      if (command === 'git') {
        if (args[0] === 'status') {
          statusCalls++
          return options.dirty || options.sourceChangedAt === statusCalls ? ' M api/data.ts' : ''
        }
        commitCalls++
        return options.commitChangedAt === commitCalls ? '2'.repeat(40) : commit
      }
      if (command === process.execPath) {
        if (options.gateFailure) throw new Error('offline check failed')
        if (options.flowFailure && args.includes('scripts/flow-cross-client-integration.mjs')) throw new Error('cross-client integration failed')
        return 'PASS fixtures'
      }
      assert.equal(command, 'vercel', 'Tests must never invoke a real command')
      if (args[0] === 'whoami') return 'synthetic-release-user'
      if (args[0] === 'deploy') {
        assert.ok(args.includes('--skip-domain'), 'Candidate creation must not automatically move aliases')
        if (options.deployFailure) throw new Error('build failed')
        return options.ambiguous ? candidateUrl + '\nhttps://other-fixture.vercel.app' : candidateUrl
      }
      if (args[0] === 'alias') {
        const domain = args[3]
        if (options.aliasFailure === domain) throw new Error(domain + ': assignment failed')
        aliases[domain] = options.wrongAlias === domain ? previousId : deploymentId
        return 'assigned'
      }
      assert.equal(args[0], 'inspect')
      inspections[args[1]] = (inspections[args[1]] || 0) + 1
      if (options.concurrentAlias === args[1] && inspections[args[1]] === 2 || options.finalAliasRace === args[1] && inspections[args[1]] === 4) aliases[args[1]] = 'dpl_concurrent789'
      const id = args[1] === candidateUrl ? deploymentId : aliases[args[1]]
      // Vercel CLI 50.4.0 omits project/commit metadata here. The authenticated
      // API below must supply those fields; the tests must not assume otherwise.
      return JSON.stringify({ id, readyState: options.notReady && id === deploymentId ? 'ERROR' : 'READY', url: id === deploymentId ? new URL(candidateUrl).host : 'nalu-old.vercel.app' })
    }
    const fetchImpl = async input => {
      const url = new URL(input)
      const hostname = url.hostname
      const response = (body, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } })
      if (options.networkFailure) throw new Error('fixture network failure')
      if (hostname === 'api.vercel.com') return response({ id: options.wrongMetadataId ? 'dpl_unexpected' : url.pathname.split('/').pop(), readyState: options.metadataNotReady ? 'ERROR' : 'READY', target: url.pathname.endsWith(deploymentId) && Object.hasOwn(options, 'candidateTarget') ? options.candidateTarget : 'production', projectId: options.wrongProject ? 'prj_other' : 'prj_fixture', meta: { naluSourceCommit: options.wrongCommit ? '2'.repeat(40) : commit } }, options.metadataUnauthorized ? 401 : 200)
      if (url.pathname === '/api/health') return response({ ok: options.badHealth !== hostname, checks: { db: { ok: true } }, config: { llmPrimary: true, llmModel: 'fixture' } })
      if (url.pathname === '/') return response('<!doctype html><script type="module" src="/assets/app.js"></script>', 200, 'text/html')
      if (url.pathname === '/assets/app.js') return response(options.wrongEntry === hostname ? 'wrong release' : 'verified app', 200, 'application/javascript')
      if (url.pathname === '/api/data') return options.missingData ? response('<html>Not found</html>', 404, 'text/html') : response('Missing share id', 400, 'text/plain')
      if (options.missingRoute && url.pathname === '/api/design') return response('<html>Not found</html>', 404, 'text/html')
      if (options.spaFallback && url.pathname === '/api/design') return response('<html>App fallback</html>', 200, 'text/html')
      if (options.route500 && url.pathname === '/api/design') return response({ error: 'failed' }, 500)
      return response({ error: 'Expected fixture response' }, ['artifacts', 'task-attachments', 'studio-image'].includes(url.pathname.split('/').pop()) ? 401 : 405)
    }
    return { calls, logs, aliases, run, fetchImpl, readToken: async () => 'synthetic-token-never-sent' }
  }
  const success = fixture()
  const receipt = await release({ cwd: directory, ...success, log: line => success.logs.push(line) })
  assert.equal(receipt.complete, true)
  assert.equal(receipt.domains.length, 4)
  assert.deepEqual(Object.values(success.aliases), Array(4).fill(deploymentId))
  assert.equal(JSON.parse(await readFile(join(directory, '.vercel/last-release.json'), 'utf8')).complete, true)
  assert.match(success.logs.at(-1), /^Live and verified:/)
  assert.deepEqual(success.calls.filter(call => call.command === process.execPath).map(call => call.args), [
    ['scripts/offline-release-checks.mjs'],
    ['scripts/check-nalu-sync.mjs'],
    ['--experimental-strip-types', 'scripts/native-chat-contract-regressions.mjs'],
    ['scripts/flow-cross-client-integration.mjs'],
  ], 'publication requires the flow integration after existing offline/sibling/native gates')
  assert.ok(success.calls.findIndex(call => call.args.includes('scripts/flow-cross-client-integration.mjs')) < success.calls.findIndex(call => call.command === 'vercel'), 'all compatibility gates run before any deployment tooling')
  report.push('successful release verifies all four aliases, exact deployment IDs, health and app bytes')
  const failures = [
    ['dirty source', { dirty: true }, /clean, reviewed checkout/, false],
    ['offline gate', { gateFailure: true }, /offline check failed/, false],
    ['cross-client workflow gate', { flowFailure: true }, /cross-client integration failed/, false],
    ['source edited by checks', { sourceChangedAt: 2 }, /Checks changed/, false],
    ['commit changed by checks', { commitChangedAt: 2 }, /Source commit changed while checks/, false],
    ['source edited during build', { sourceChangedAt: 3 }, /Source changed while the candidate/, false],
    ['commit changed during build', { commitChangedAt: 3 }, /Source commit changed while the candidate/, false],
    ['build failure', { deployFailure: true }, /build failed/, false],
    ['ambiguous deploy URL', { ambiguous: true }, /unambiguous/, false],
    ['wrong project', { wrongProject: true }, /wrong Vercel project/, false],
    ['metadata unauthorized', { metadataUnauthorized: true }, /cannot verify authenticated deployment metadata/, false],
    ['metadata identity mismatch', { wrongMetadataId: true }, /metadata deployment ID mismatch/, false],
    ['metadata state mismatch', { metadataNotReady: true }, /authenticated deployment state is not READY/, false],
    ['preview environment candidate', { candidateTarget: 'preview' }, /not built with production environment settings/, false],
    ['missing candidate environment', { candidateTarget: null }, /not built with production environment settings/, false],
    ['wrong source revision', { wrongCommit: true }, /checked source commit/, false],
    ['deployment not ready', { notReady: true }, /not READY/, false],
    ['candidate health', { badHealth: new URL(candidateUrl).host }, /health is degraded/, false],
    ['missing API route', { missingRoute: true }, /expected 405, got 404/, false],
    ['missing share handler', { missingData: true }, /api\/data: expected missing-share validation, got 404/, false],
    ['SPA route fallback', { spaFallback: true }, /expected 405, got 200/, false],
    ['server error', { route500: true }, /expected 405, got 500/, false],
    ['network failure', { networkFailure: true }, /network failure/, false],
    ['alias failure', { aliasFailure: 'n4lu.ai' }, /n4lu.ai: assignment failed/, true],
    ['partial alias failure', { aliasFailure: 'n4lu.com' }, /n4lu.com: assignment failed/, true],
    ['wrong alias target', { wrongAlias: 'www.n4lu.ai' }, /www.n4lu.ai: alias points to the wrong deployment/, true],
    ['public health failure', { badHealth: 'n4lu.com' }, /n4lu.com: health is degraded/, true],
    ['public source mismatch', { wrongEntry: 'www.n4lu.com' }, /www.n4lu.com: served JavaScript differs/, true],
    ['concurrent publication before alias assignment', { concurrentAlias: 'n4lu.ai' }, /changed to another release/, false],
    ['concurrent publication before final verification', { finalAliasRace: 'n4lu.ai' }, /changed before release verification completed/, true],
  ]
  for (const [name, options, message, mayAssign] of failures) {
    const test = fixture(options)
    await assert.rejects(release({ cwd: directory, ...test, log: line => test.logs.push(line) }), message)
    assert.ok(!test.logs.some(line => line.startsWith('Live and verified:')), name + ': never print false success')
    if (!mayAssign) assert.equal(test.calls.filter(call => call.command === 'vercel' && call.args[0] === 'alias').length, 0, name + ': no domains changed before validation')
    if (options.flowFailure) assert.equal(test.calls.filter(call => call.command === 'vercel').length, 0, 'failed flow integration stops before deployment tooling')
    report.push(name + ' fails without reporting live')
  }
  const rollback = fixture()
  const rolled = await release({ cwd: directory, target: candidateUrl, ...rollback, log: () => {}, writeReceipt: false })
  assert.equal(rolled.operation, 'rollback')
  assert.equal(rollback.calls.filter(call => call.command === 'vercel' && call.args[0] === 'deploy').length, 0)
  report.push('rollback verifies reviewed existing release and all aliases without rebuilding')
  const publication = fixture()
  const published = await release({ cwd: directory, publish: candidateUrl, ...publication, log: () => {}, writeReceipt: false })
  assert.equal(published.operation, 'publish')
  assert.equal(published.sourceCommit, commit)
  assert.equal(published.domains.length, 4)
  assert.equal(publication.calls.filter(call => call.command === 'vercel' && call.args[0] === 'deploy').length, 0)
  report.push('explicit publication verifies the already-tested candidate against HEAD and all aliases without rebuilding')
  const unrelatedCandidate = fixture({ wrongCommit: true })
  await assert.rejects(release({ cwd: directory, publish: candidateUrl, ...unrelatedCandidate, log: () => {}, writeReceipt: false }), /checked source commit/)
  assert.equal(unrelatedCandidate.calls.filter(call => call.command === 'vercel' && call.args[0] === 'alias').length, 0)
  report.push('publication rejects an existing candidate from another commit before changing domains')
  for (const mode of ['publish', 'target']) for (const candidateTarget of ['preview', null]) {
    const wrongEnvironment = fixture({ candidateTarget })
    await assert.rejects(release({ cwd: directory, [mode]: candidateUrl, ...wrongEnvironment, log: line => wrongEnvironment.logs.push(line), writeReceipt: false }), /not built with production environment settings/)
    assert.equal(wrongEnvironment.calls.filter(call => call.command === 'vercel' && call.args[0] === 'alias').length, 0)
    assert.ok(!wrongEnvironment.logs.some(line => line.startsWith('Live and verified:')))
    report.push(`${mode === 'target' ? 'rollback' : 'publication'} rejects ${candidateTarget === null ? 'missing' : 'preview'} environment metadata even when the project and commit match`)
  }
  await assert.rejects(release({ cwd: directory, publish: candidateUrl, target: candidateUrl, ...fixture(), writeReceipt: false }), /Choose publication or rollback/)
  report.push('ambiguous publication and rollback modes are rejected')

  // Exercise deploy.sh itself with a local node stub: exec must preserve failures.
  const bin = join(directory, 'bin'); await mkdir(bin)
  await writeFile(join(bin, 'node'), '#!/bin/sh\necho "synthetic deployment failure" >&2\nexit 23\n', { mode: 0o755 })
  const shell = spawnSync('bash', ['deploy.sh'], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } })
  assert.equal(shell.status, 23); assert.doesNotMatch(shell.stdout, /live/i)
  report.push('shell wrapper preserves exact nonzero release exit status')
  const preview = fixture({ missingRoute: true })
  await assert.rejects(checkPreview(candidateUrl, { fetchImpl: preview.fetchImpl }), /got 404/)
  if (process.env.OUTPUT_DIR) { await mkdir(process.env.OUTPUT_DIR, { recursive: true }); await writeFile(join(process.env.OUTPUT_DIR, 'release-regressions.json'), JSON.stringify({ passed: true, checks: report }, null, 2)) }
  console.log(`PASS ${report.length} deterministic release checks; no deployment, network or credentials used.`)
} finally { await rm(directory, { recursive: true, force: true }) }
