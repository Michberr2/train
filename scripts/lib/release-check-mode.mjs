import assert from 'node:assert/strict'

// Reviewed executable suites, not filename heuristics: browser-image-cost and
// synthetic website-runtime tests do not launch a browser and must still run.
export const BROWSER_EXECUTING_SCRIPTS = Object.freeze([
  'logo-generation-controls-regressions.mjs',
  'attachment-extraction-regressions.mjs',
  'catalogue-browser-regressions.mjs',
  'chrome-content-regressions.mjs',
  'studio-runtime-regressions.mjs',
  'workspace-swarm-studio-browser.mjs',
  'artifact-isolation-browser-regressions.mjs',
  'auth-sync-browser-regressions.mjs',
  'account-project-browser-regressions.mjs',
  'studio-artifact-regressions.mjs',
  'autopilot-output-browser-regressions.mjs',
  'map-browser-verify.mjs',
  'workspace-shell-browser-regressions.mjs',
  'flow-cross-client-integration.mjs',
])
const browserScripts = new Set(BROWSER_EXECUTING_SCRIPTS)

export function browserTestPolicy(browserTestSkipReason) {
  if (browserTestSkipReason === undefined) return { mode: 'full' }
  assert.ok(typeof browserTestSkipReason === 'string', 'Browser-test waiver requires a nonempty recorded reason')
  const reason = browserTestSkipReason.trim()
  assert.ok(reason.length > 0 && reason.length <= 500 && !/[\u0000-\u001f\u007f]/.test(reason), 'Browser-test waiver requires a nonempty recorded reason of at most 500 characters without control characters')
  return { mode: 'no-browser', reason }
}

export function selectReleaseChecks(checks, browserTestSkipReason) {
  const policy = browserTestPolicy(browserTestSkipReason)
  const run = [], skipped = []
  for (const check of checks) {
    const command = Array.isArray(check) ? [...check] : [check]
    assert.ok(command.length && command.every(part => typeof part === 'string' && part.length), 'Release checks require nonempty command arguments')
    ;(policy.mode === 'no-browser' && browserScripts.has(command[0]) ? skipped : run).push(command)
  }
  return { ...policy, run, skipped }
}

export function parseReleaseArguments(args, { offline = false } = {}) {
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    assert.ok(flag === '--no-browser' || !offline && ['--publish', '--rollback'].includes(flag), `Unknown release argument: ${flag}`)
    const key = flag === '--no-browser' ? 'browserTestSkipReason' : flag === '--publish' ? 'publish' : 'target'
    assert.ok(!Object.hasOwn(options, key), `Duplicate release argument: ${flag}`)
    const value = args[++index]
    assert.ok(typeof value === 'string' && value.trim() && !value.startsWith('--'), `${flag} requires ${flag === '--no-browser' ? 'a nonempty recorded reason' : 'a deployment URL'}`)
    options[key] = value
  }
  assert.ok(!(options.target && options.publish), 'Choose publication or rollback, not both')
  const policy = browserTestPolicy(options.browserTestSkipReason)
  if (policy.mode === 'no-browser') options.browserTestSkipReason = policy.reason
  return options
}
