import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: `export * from './api/_websiteRequirementReview'; export {createWebsiteBehaviorContract} from './api/_websiteBehavior'; export {parsePlannedWebsiteRequirements} from './api/_websiteRequirements'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'absolute-package-import', setup(build) { build.onResolve({ filter: /^@vercel\/functions$/ }, args => ({ path: import.meta.resolve(args.path), external: true })) } }] })
const { reviewWebsiteRequirements: review, applyWebsiteRequirementReview: apply, createWebsiteBehaviorContract: create, parsePlannedWebsiteRequirements: parse } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const copy = value => JSON.parse(JSON.stringify(value))
const brief = 'Use Menu on both screens. Show the total. Send a real email. Export the records.'
const tests = [
  { name: 'Same description', steps: [{ action: 'click', target: { role: 'button', name: 'Menu' }, viewport: 'desktop' }, { action: 'click', target: { role: 'button', name: 'Menu' }, viewport: 'mobile' }], expect: [{ type: 'visible', target: { selector: '#nav' } }] },
  { name: 'Same description', steps: [{ action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#total' }, value: '250' }] },
]
const checks = create(tests).checks
const inventory = parse([
  { id: 'menu', quote: 'Use Menu on both screens.', goal: { kind: 'control', action: 'click', target: { role: 'button', name: 'Menu' } }, refs: [{ test: 0, step: 0 }, { test: 0, step: 1 }] },
  { id: 'total', quote: 'Show the total.', goal: { kind: 'result', type: 'text', target: { selector: '#total' } }, refs: [{ test: 1, assertion: 0 }] },
], { brief, checks })
const contract = { checks, inventory }
const runtime = { status: 'passed', widths: [1440, 390], checks: [1440, 390].flatMap(width => [
  { name: 'Same description', journeyIndex: 0, width, passed: true, executedSteps: [width === 1440 ? 0 : 1], passedAssertions: [0] },
  { name: 'Same description', journeyIndex: 1, width, passed: true, executedSteps: [0], passedAssertions: [0] },
]), issues: [], limitations: [] }
const full = review(contract, runtime)
assert.equal(full.status, 'checked')
assert.equal(full.scope, 'declared-inventory')
assert.equal(full.verified, 2)
assert.deepEqual(full.items.map(item => item.verifiedViewports), [['desktop','mobile'],['desktop','mobile']])
for (const mutate of [
  r => { r.checks = r.checks.filter(check => check.width !== 390) },
  r => { r.checks[2].executedSteps = [] },
  r => { r.checks[2].executedSteps = [0] }, // desktop-only action cannot verify mobile
  r => { r.checks[2].passed = false },
  r => { r.checks[3].passedAssertions = [] },
  r => { r.checks[3].passed = false },
  r => { delete r.checks[3].journeyIndex }, // equal journey names are not IDs
  r => { r.checks.push(copy(r.checks[3])) }, // ambiguous duplicate evidence
]) {
  const altered = copy(runtime); mutate(altered)
  assert.equal(review(contract, altered).status, 'partial')
  apply(contract, altered)
  assert.equal(altered.status, 'partial')
}
const generic = { ...copy(runtime), checks: [{ name: 'Same description', width: 1440, passed: true }, { name: 'Same description', width: 390, passed: true }] }
assert.equal(review(contract, generic).verified, 0, 'legacy or generic browser success cannot fabricate indexed execution')
const noActions = copy(runtime); noActions.checks[0].executedSteps=[]; noActions.checks[2].executedSteps=[]
assert.deepEqual(review(contract, noActions).items.map(item => item.status), ['unverified','verified'], 'display evidence does not stand in for a skipped action')
const noAssert = copy(runtime); noAssert.checks[1].passedAssertions=[]; noAssert.checks[3].passedAssertions=[]
assert.deepEqual(review(contract, noAssert).items.map(item => item.status), ['verified','unverified'], 'executing an action does not prove a requested result')
const missingCheck = { checks: [checks[0]], inventory }
assert.equal(review(missingCheck, runtime).items[1].status, 'unverified')
const declared = parse([
  { id: 'email', quote: 'Send a real email.', state: 'unsupported', reason: 'Real delivery is outside the isolated browser.' },
  { id: 'export', quote: 'Export the records.', state: 'uncovered', reason: 'No export journey was supplied.' },
], { brief, checks: [] })
const uncovered = review({ checks: [], inventory: declared }, runtime)
assert.equal(uncovered.status, 'partial')
assert.equal(uncovered.verified, 0)
assert.deepEqual(uncovered.items.map(item=>item.status), ['unsupported','uncovered'])
for (const legacy of [undefined, { checks }, { checks: [], inventory: { version: 1, requirements: [] } }]) {
  const status = copy(runtime)
  apply(legacy, status)
  assert.equal(status.status, 'partial')
  assert.equal(status.requirements.status, 'unknown')
  assert.equal(status.requirements.verified, 0)
}
for (const status of ['failed','unavailable','partial']) {
  const existing = { ...copy(runtime), status }
  apply(contract, existing)
  assert.equal(existing.status, status, 'requirement evidence cannot erase other runtime findings')
}
const successful = copy(runtime); apply(contract, successful)
assert.equal(successful.status, 'passed')
assert.match(successful.limitations[0], /does not prove that every requirement/)
assert.deepEqual(contract.inventory, inventory, 'review must not mutate saved requirements')
console.log('PASS exact executed requirement evidence, viewport skips, duplicate names/records, missing assertions/checks, unsupported/uncovered retention, legacy unknown coverage and honest runtime status. Synthetic evidence only; no browser or provider calls.')
