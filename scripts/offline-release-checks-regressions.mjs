// Deterministic orchestration tests only: injected runner never starts another
// process, a browser, a build, a provider call, or deployment tooling.
import assert from 'node:assert/strict'
import { OFFLINE_RELEASE_CHECKS, runOfflineReleaseChecks } from './offline-release-checks.mjs'
import { BROWSER_EXECUTING_SCRIPTS, browserTestPolicy, parseReleaseArguments, selectReleaseChecks } from './lib/release-check-mode.mjs'

const reason = 'User explicitly requested release checks without browser testing.'
let checks = 0
const test = (name, verify) => { verify(); checks++ }
const commands = OFFLINE_RELEASE_CHECKS.map(check => Array.isArray(check) ? check : [check])
const browserNames = new Set(BROWSER_EXECUTING_SCRIPTS)
const fixture = (options = {}) => {
  const calls = [], logs = []
  const run = (command, args, settings) => {
    calls.push({ command, args, settings })
    if (options.fail === 'build' && command === 'npm' || options.fail && args.some(arg => arg.endsWith('/' + options.fail))) return { status: 23 }
    return { status: 0 }
  }
  return { calls, logs, run, log: line => logs.push(line) }
}

test('default policy does not waive browser checks', () => {
  assert.deepEqual(browserTestPolicy(), { mode: 'full' })
  assert.deepEqual(parseReleaseArguments([]), {})
  const plan = selectReleaseChecks(OFFLINE_RELEASE_CHECKS)
  assert.deepEqual(plan.run, commands)
  assert.deepEqual(plan.skipped, [])
})
test('explicit mode requires and preserves a bounded reason', () => {
  assert.deepEqual(parseReleaseArguments(['--no-browser', `  ${reason}  `]), { browserTestSkipReason: reason })
  assert.deepEqual(parseReleaseArguments(['--publish', 'https://candidate.vercel.app', '--no-browser', reason]), { publish: 'https://candidate.vercel.app', browserTestSkipReason: reason })
  assert.deepEqual(parseReleaseArguments(['--no-browser', reason, '--rollback', 'https://old.vercel.app']), { browserTestSkipReason: reason, target: 'https://old.vercel.app' })
  assert.deepEqual(parseReleaseArguments(['--no-browser', reason], { offline: true }), { browserTestSkipReason: reason })
})
for (const args of [
  ['--no-browser'], ['--no-browser', ''], ['--no-browser', '   '], ['--no-browser', '--publish', 'https://candidate.vercel.app'],
  ['--no-browser', 'x'.repeat(501)], ['--no-browser', 'line\nline'], ['--no-browser', reason, '--no-browser', reason],
  ['--skip-tests'], ['--publish'], ['--publish', 'a', '--publish', 'b'], ['--publish', 'a', '--rollback', 'b'], ['unexpected'],
]) test('reject malformed release arguments ' + JSON.stringify(args), () => assert.throws(() => parseReleaseArguments(args)))
for (const value of ['', '  ', null, false, 1, {}, 'x'.repeat(501), 'line\nline']) test('invalid API reason stops before execution', () => {
  const f = fixture()
  assert.throws(() => runOfflineReleaseChecks({ ...f, browserTestSkipReason: value }), /recorded reason/)
  assert.equal(f.calls.length, 0)
})
test('offline CLI cannot accept publication arguments', () => assert.throws(() => parseReleaseArguments(['--publish', 'https://candidate.vercel.app'], { offline: true }), /Unknown release argument/))

test('all default checks and production build execute in their original order', () => {
  const f = fixture(), result = runOfflineReleaseChecks(f)
  assert.deepEqual(f.calls.slice(0, -1).map(call => call.args), commands.map(command => ['--experimental-strip-types', 'scripts/' + command[0], ...command.slice(1)]))
  assert.equal(f.calls.at(-1).command, 'npm')
  assert.deepEqual(f.calls.at(-1).args, ['run', 'build'])
  assert.deepEqual(result.checked, commands)
  assert.equal(result.buildPassed, true)
  assert.deepEqual(result.skipped, [])
})
test('waiver skips every reviewed browser invocation, including all map variants, and nothing else', () => {
  const f = fixture(), result = runOfflineReleaseChecks({ ...f, browserTestSkipReason: reason })
  assert.deepEqual(result.skipped, commands.filter(command => browserNames.has(command[0])))
  assert.deepEqual(result.checked, commands.filter(command => !browserNames.has(command[0])))
  assert.equal(result.skipped.filter(command => command[0] === 'map-browser-verify.mjs').length, 4)
  for (const command of result.checked) assert.ok(!browserNames.has(command[0]))
  for (const name of ['browser-image-cost-regressions.mjs', 'chrome-action-regressions.mjs', 'website-download-runtime-regressions.mjs', 'website-generation-regressions.mjs', 'website-behavior-regressions.mjs']) assert.ok(result.checked.some(command => command[0] === name), name + ' remains a required non-browser regression')
  for (const name of ['attachment-extraction-regressions.mjs', 'logo-generation-controls-regressions.mjs', 'chrome-content-regressions.mjs', 'studio-runtime-regressions.mjs']) assert.ok(result.skipped.some(command => command[0] === name), name + ' launches a real browser despite its name')
  assert.equal(f.calls.length, result.checked.length + 1)
  assert.equal(f.calls.at(-1).command, 'npm')
  assert.deepEqual(f.calls.at(-1).args, ['run', 'build'])
  assert.ok(f.logs.at(-1).includes('Browser tests NOT RUN: ' + reason))
  assert.equal(result.reason, reason)
})
test('separate cross-client integration is explicitly classified as browser-executing', () => {
  assert.deepEqual(selectReleaseChecks(['flow-cross-client-integration.mjs'], reason).skipped, [['flow-cross-client-integration.mjs']])
  assert.deepEqual(selectReleaseChecks(['flow-cross-client-integration.mjs']).run, [['flow-cross-client-integration.mjs']])
})
test('environment flags do not waive tests or narrow fixtures', () => {
  const f = fixture()
  const result = runOfflineReleaseChecks({ ...f, sourceEnv: { PATH: '/fixture', NO_BROWSER: '1', SKIP_BROWSER_TESTS: '1', BASE_URL: 'https://invalid', AUDIT_ONLY: '1', ARTIFACT_CASE: 'one', CAROUSEL_ONLY: '1', OUTPUT_DIR: '/fixture', TINKER_API_KEY: 'secret', DATABASE_URL: 'secret' } })
  assert.equal(result.mode, 'full')
  assert.deepEqual(result.checked, commands)
  assert.equal(f.calls[0].settings.env.PATH, '/fixture')
  for (const key of ['BASE_URL', 'AUDIT_ONLY', 'ARTIFACT_CASE', 'CAROUSEL_ONLY', 'OUTPUT_DIR', 'TINKER_API_KEY', 'DATABASE_URL']) assert.equal(f.calls[0].settings.env[key], undefined)
})
for (const browserTestSkipReason of [undefined, reason]) {
  test('non-browser regression failures still stop the gate in ' + (browserTestSkipReason ? 'waived' : 'full') + ' mode', () => {
    const f = fixture({ fail: 'project-data-regressions.mjs' })
    assert.throws(() => runOfflineReleaseChecks({ ...f, browserTestSkipReason }), /FAIL project-data-regressions/)
    assert.ok(!f.calls.some(call => call.command === 'npm'))
  })
  test('production build failure still fails in ' + (browserTestSkipReason ? 'waived' : 'full') + ' mode', () => {
    const f = fixture({ fail: 'build' })
    assert.throws(() => runOfflineReleaseChecks({ ...f, browserTestSkipReason }), /FAIL production build/)
    assert.ok(!f.logs.some(line => line.startsWith('PASS ')))
  })
}
console.log(`PASS ${checks} offline release-mode checks; no browsers, child processes, network or deployment used.`)
