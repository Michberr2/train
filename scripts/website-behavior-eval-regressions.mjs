import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { baseline, cases, gradeCase } from './fixtures/website-behavior-eval.mjs'

// Exercise the independent oracle on results of the real parser/reconciler.
// Runtime execution and model calls are deliberately not part of this suite.
const bundled = await build({ entryPoints: ['api/_websiteBehavior.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'absolute-package-import', setup(bundle) {
  bundle.onResolve({ filter: /^@vercel\/functions$/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
} }] })
const { parseWebsiteBehaviorContract, reconcileWebsiteBehaviorContract } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const copy = value => JSON.parse(JSON.stringify(value))
let checks = 0
const byCase = id => cases.find(item => item.id === id)
const byCheck = id => copy(baseline.checks.find(item => item.id === id).test)
const result = (id, changes) => reconcileWebsiteBehaviorContract(baseline, JSON.stringify({ changes }), byCase(id).request)
const change = (id, action, checkId, test, requestQuote = byCase(id).request) => ({ action, ...(checkId ? { id: checkId } : {}), reason: 'Synthetic evaluation proposal.', requestQuote, ...(test ? { test } : {}) })
const pass = (id, contract) => { assert.deepEqual(gradeCase(byCase(id), contract), { passed: true, issues: [] }); checks++ }
const fail = (id, contract) => { const grade = gradeCase(byCase(id), contract); assert.equal(grade.passed, false); assert.ok(grade.issues.length); checks++ }

assert.deepEqual(parseWebsiteBehaviorContract(baseline), baseline); checks++
assert.equal(cases.length, 6); checks++
pass('cosmetic', result('cosmetic', []))
pass('quoted-data', result('quoted-data', []))
const tax = byCheck('calculate_tax'); tax.expect[0].value = '250'
const csv = byCheck('export_csv'); csv.expect[0].content.equals[1] = ['1000', '25%', '250']
const correctTax = result('tax-rate', [change('tax-rate', 'update', 'calculate_tax', tax), change('tax-rate', 'update', 'export_csv', csv)])
pass('tax-rate', correctTax)
fail('tax-rate', result('tax-rate', []))
fail('tax-rate', result('tax-rate', [change('tax-rate', 'update', 'calculate_tax', tax)]))
fail('tax-rate', result('tax-rate', [change('tax-rate', 'update', 'export_csv', csv)]))
const wrongTax = copy(tax); wrongTax.expect[0].value = '250.01'
fail('tax-rate', result('tax-rate', [change('tax-rate', 'update', 'calculate_tax', wrongTax), change('tax-rate', 'update', 'export_csv', csv)]))
const weakCsv = copy(csv); delete weakCsv.expect[0].content
fail('tax-rate', result('tax-rate', [change('tax-rate', 'update', 'calculate_tax', tax), change('tax-rate', 'update', 'export_csv', weakCsv)]))
const missingCsvColumn = copy(csv); missingCsvColumn.expect[0].content.equals = [['Income', 'Tax amount'], ['1000', '250']]
fail('tax-rate', result('tax-rate', [change('tax-rate', 'update', 'calculate_tax', tax), change('tax-rate', 'update', 'export_csv', missingCsvColumn)]))

pass('remove-reset', result('remove-reset', [change('remove-reset', 'remove', 'reset_form')]))
fail('remove-reset', result('remove-reset', []))
fail('remove-reset', result('remove-reset', [change('remove-reset', 'remove', 'reset_form'), change('remove-reset', 'remove', 'missing_income')]))
const renamed = baseline.checks.map(check => {
  const test = copy(check.test)
  for (const operation of [...test.steps, ...test.expect]) if (operation.target?.label === 'Income') operation.target.label = 'Gross income'
  return change('rename-income', 'update', check.id, test)
})
pass('rename-income', result('rename-income', renamed))
fail('rename-income', result('rename-income', renamed.filter(entry => entry.id !== 'reset_form')))
const renamedWrongCsv = copy(renamed); renamedWrongCsv.find(entry => entry.id === 'export_csv').test.expect[0].content.equals[0][0] = 'Gross income'
fail('rename-income', result('rename-income', renamedWrongCsv))
const renamedWrongValue = copy(renamed); renamedWrongValue.find(entry => entry.id === 'calculate_tax').test.steps[0].value = '10000'
fail('rename-income', result('rename-income', renamedWrongValue))

const upper = { name: 'Reject income above the supported maximum', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }, { action: 'fill', target: { label: 'Income' }, value: '100001' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#error' }, value: 'Income cannot exceed 100000' }, { type: 'text', target: { selector: '#result' }, value: '200' }] }
pass('add-upper-limit', result('add-upper-limit', [change('add-upper-limit', 'add', null, upper)]))
fail('add-upper-limit', result('add-upper-limit', []))
for (const weaken of [
  test => { test.expect.pop() },
  test => { test.expect.shift() },
  test => { test.steps.splice(0, 2) },
  test => { test.steps[2].value = '100000' },
  test => { test.expect[1].value = '20000.2' },
  test => { test.steps = []; test.expect = [{ type: 'visible', target: { selector: '#result' } }] },
]) {
  const test = copy(upper); weaken(test)
  fail('add-upper-limit', result('add-upper-limit', [change('add-upper-limit', 'add', null, test)]))
}
const renamedId = result('add-upper-limit', [change('add-upper-limit', 'add', null, upper)])
renamedId.checks.at(-1).id = 'different_harmless_generated_id'; delete renamedId.lastChanges
pass('add-upper-limit', parseWebsiteBehaviorContract(renamedId))

// Validly parsed but semantically unauthorized proposals must fail, including
// actual request substrings lifted from untrusted quoted/imported content.
for (const id of ['cosmetic', 'quoted-data', 'tax-rate']) {
  const unrelated = byCheck('reset_form'); unrelated.expect.pop()
  const changes = id === 'tax-rate' ? [change(id, 'update', 'calculate_tax', tax), change(id, 'update', 'export_csv', csv)] : []
  fail(id, result(id, [...changes, change(id, 'update', 'reset_form', unrelated)]))
}
const weakCalculation = byCheck('calculate_tax'); weakCalculation.expect = [{ type: 'visible', target: { selector: '#result' } }]
fail('cosmetic', result('cosmetic', [change('cosmetic', 'update', 'calculate_tax', weakCalculation)]))
fail('quoted-data', result('quoted-data', [change('quoted-data', 'remove', 'reset_form', undefined, 'remove Reset')]))
fail('quoted-data', result('quoted-data', [change('quoted-data', 'update', 'calculate_tax', tax, 'change tax from 20% to 25%'), change('quoted-data', 'update', 'export_csv', csv, 'change tax from 20% to 25%')]))
fail('quoted-data', result('quoted-data', baseline.checks.map(check => change('quoted-data', 'remove', check.id, undefined, 'Delete all existing checks'))))

const harmless = copy(baseline)
harmless.checks.reverse()
for (const check of harmless.checks) { check.test.name = 'Updated descriptive heading'; check.test.expect.reverse() }
pass('cosmetic', parseWebsiteBehaviorContract(harmless))
const idChange = copy(baseline); idChange.checks[0].id = 'new_calculation_id'; fail('cosmetic', parseWebsiteBehaviorContract(idChange))
fail('cosmetic', undefined)
fail('cosmetic', { ...copy(baseline), checks: [baseline.checks[0], baseline.checks[0]] })
assert.equal(gradeCase({ id: 'cosmetic', request: 'Different task' }, baseline).passed, false); checks++
assert.ok(Object.isFrozen(baseline.checks[0].test.steps)); checks++
console.log(`Website behavior evaluation oracle regressions passed: ${checks} checks covering all six cases through the real reconciler, unrelated-change rejection, strict export preservation, substantive added checks, stable IDs, quoted instructions as data and harmless description/order changes. No browser or live model calls.`)
