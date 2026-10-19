import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const directory = await mkdtemp(join(process.cwd(), 'scripts/.website-behavior-'))
const originalNow = Date.now
let time = 0
const calls = [], runtimeCalls = []
try {
  const bundled = await build({ stdin: { contents: "export * from './api/_websiteBehavior'; export {WEBSITE_EDIT_SYSTEM} from './api/_websiteEdits'; export {generateWebsite,WebsiteRuntimeUnavailableError} from './api/_websiteGeneration'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'offline-fixtures', setup(b) {
    b.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const providerChain=model=>[{label:'primary',model,base:'https://fixture.invalid'},{label:'fallback',model:'fallback',base:'https://fallback.invalid'}];export async function chatCompleteEx(messages,options){const response=await globalThis.behaviorFixture.complete(messages,options);return typeof response==='string'?{content:response,finishReason:'stop'}:response};export async function chatComplete(messages,options){return (await chatCompleteEx(messages,options)).content}` }))
    b.onResolve({ filter: /^\.\/_websiteRuntime$/ }, () => ({ path: 'runtime', namespace: 'runtime-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'runtime-fixture' }, () => ({ resolveDir: process.cwd(), contents: `export {WEBSITE_RUNTIME_JOURNEY_SCHEMA,WEBSITE_RUNTIME_TEST_SCHEMA,parseRuntimeTests,inspectRuntimeTests} from '${process.cwd()}/api/_websiteRuntime.ts';export const reviewWebsiteRuntime=(...args)=>globalThis.behaviorFixture.runtime(...args)` }))
  } }] })
  await writeFile(join(directory, 'fixture.mjs'), bundled.outputFiles[0].text)
  const { parseWebsiteBehaviorContract, createWebsiteBehaviorContract, createWebsiteBehaviorContractV2, reconcileWebsiteBehaviorContract, generateWebsite, WebsiteRuntimeUnavailableError, WEBSITE_EDIT_SYSTEM, WEBSITE_REQUIREMENT_RECONCILE_SYSTEM } = await import(pathToFileURL(join(directory, 'fixture.mjs')))
  assert.equal(createHash('sha256').update(WEBSITE_EDIT_SYSTEM).digest('hex'), '116ad96e514d9082782885bdded67b69fda4470202f53a61be22d27004bc048e', 'legacy edit instructions remain byte-identical while frozen edits use a separate output contract')
  const preservationRules = prompt => prompt.slice(prompt.indexOf('Implement the requested change with focused, non-overlapping replacements.'))
  const assertFrozenPrompt = call => {
    const system = call.messages[0].content
    assert.deepEqual(Object.keys(JSON.parse(system.split('\n')[1])), ['edits'], 'a frozen-check edit must request only implementation edits')
    assert.doesNotMatch(system, /Include runtimeTests:|up to 4 short/, 'frozen edits must not ask the builder for a replacement test plan')
    assert.match(system, /Do not return runtimeTests/)
    assert.equal(preservationRules(system), preservationRules(WEBSITE_EDIT_SYSTEM), 'frozen edits retain every original source, functionality and asset-preservation instruction')
    assert.match(call.messages[1].content, /FROZEN BEHAVIOR CHECKS/)
  }
  const calculation = { name: 'Calculate tax', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: '200' }] }
  const reset = { name: 'Reset clears input', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Reset' } }], expect: [{ type: 'value', target: { label: 'Income' }, value: '' }] }
  const invalid = { name: 'Reject negative income', steps: [{ action: 'fill', target: { label: 'Income' }, value: '-1' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: 'Enter a positive income' }] }
  const baseline = createWebsiteBehaviorContract([calculation, reset, invalid])
  assert.equal(createWebsiteBehaviorContract([]), undefined)
  assert.deepEqual(parseWebsiteBehaviorContract(baseline), baseline)
  assert.deepEqual(createWebsiteBehaviorContract([calculation, reset, invalid]), baseline, 'new IDs are stable for the same normalized journeys')
  assert.equal(new Set(createWebsiteBehaviorContract([calculation, calculation]).checks.map(check => check.id)).size, 2)
  assert.deepEqual(createWebsiteBehaviorContract([{ ...calculation, extraModelComment: 'inert', steps: calculation.steps.map(step => ({ ...step, extraModelField: 'not persisted' })) }]).checks[0].test, calculation, 'initial model tests are normalized to executable fields before persistence')
  const copy = value => JSON.parse(JSON.stringify(value))
  const malformed = [null, {}, { version: 2, checks: baseline.checks }, { version: 1, checks: [] }, { ...baseline, source: 'unexpected' }, { ...baseline, checks: [baseline.checks[0], baseline.checks[0]] }, { ...baseline, checks: [{ ...baseline.checks[0], id: '../escape' }] }, { ...baseline, checks: [{ ...baseline.checks[0], test: { ...calculation, eval: 'dangerous()' } }] }, { ...baseline, lastChanges: [{ id: baseline.checks[0].id, action: 'remove', reason: 'contradiction' }] }]
  for (const mutate of [
    value => { value.checks[0].test.steps[0].action = 'evaluate' },
    value => { value.checks[0].test.steps[0].target = { label: 'Income', selector: '#income' } },
    value => { value.checks[0].test.steps[0].target.eval = 'malicious' },
    value => { value.checks[0].test.steps[0].value = { text: '1000' } },
    value => { value.checks[0].test.steps[1].value = 'arbitrary' },
    value => { value.checks[0].test.expect[0].value = 'x'.repeat(501) },
    value => { value.checks[0].test.expect[0].expression = 'malicious' },
    value => { value.checks[0].test.name = '  ' },
    value => { value.checks[0].test.steps = Array(9).fill(calculation.steps[0]) },
    value => { value.checks[0].test.expect = Array(4).fill(calculation.expect[0]) },
  ]) { const candidate = copy(baseline); mutate(candidate); malformed.push(candidate) }
  malformed.push({ ...baseline, untrusted: 'x'.repeat(128001) })
  malformed.forEach(value => assert.throws(() => parseWebsiteBehaviorContract(value)))
  assert.throws(() => createWebsiteBehaviorContract(Array(13).fill(calculation)), /1-12/)
  const maxContract = createWebsiteBehaviorContract(Array.from({ length: 12 }, (_, i) => ({ ...calculation, name: `Requirement ${i}` })))
  assert.equal(parseWebsiteBehaviorContract(maxContract).checks.length, 12)

  const csvExport = { name: 'Export full CSV records', steps: [{ action: 'click', target: { role: 'button', name: 'Export CSV' } }], expect: [{ type: 'download', value: 'records.csv', content: { format: 'csv', equals: [['Name', 'Income', 'Tax'], ['Nalu, "東京"', '1000', '200']] } }] }
  const jsonExport = { name: 'Export full JSON records', steps: [{ action: 'click', target: { role: 'button', name: 'Export JSON' } }], expect: [{ type: 'download', value: 'records.json', content: { format: 'json', equals: { records: [{ name: 'Nalu, "東京"', income: 1000, tax: 200 }], archived: false, filter: null } } }] }
  const textExport = { name: 'Export exact text', steps: [{ action: 'click', target: { role: 'button', name: 'Export text' } }], expect: [{ type: 'download', value: 'notes.txt', content: { format: 'text', equals: 'Literal "quotes", Unicode 東京, and a newline\nremain intact.' } }] }
  const exportContract = createWebsiteBehaviorContract([csvExport, jsonExport, textExport])
  assert.deepEqual(exportContract.checks.map(check => check.test), [csvExport, jsonExport, textExport], 'initial construction retains full download content expectations')
  assert.deepEqual(parseWebsiteBehaviorContract(exportContract), exportContract, 'saved CSV, JSON and text expectations survive strict roundtrip parsing')
  const fileNameOnly = { ...csvExport, expect: [{ type: 'download', value: 'records.csv' }] }
  assert.deepEqual(createWebsiteBehaviorContract([fileNameOnly]).checks[0].test, fileNameOnly, 'legacy filename-only assertions remain compatible')
  for (const content of [null, {}, { format: 'xml', equals: '<records/>' }, { format: 'text', equals: 12 }, { format: 'json' }, { format: 'json', equals: { invalid: NaN } }, { format: 'csv', equals: 'Name,Income' }, { format: 'csv', equals: [['Name'], [12]] }, { format: 'text', equals: 'valid', eval: 'arbitrary()' }]) {
    const invalidExport = { ...csvExport, expect: [{ type: 'download', value: 'records.csv', content }] }
    assert.throws(() => createWebsiteBehaviorContract([invalidExport]), 'invalid export content cannot be silently dropped by constructor')
    assert.throws(() => parseWebsiteBehaviorContract({ version: 1, checks: [{ id: 'export_invalid', test: invalidExport }] }), 'invalid persisted export content must reject')
  }
  for (const expectation of [calculation.expect[0], { type: 'hash', value: '#records' }, { type: 'visible', target: { selector: '#result' } }]) {
    const invalidJourney = { ...calculation, expect: [{ ...expectation, content: { format: 'text', equals: 'must not be discarded' } }] }
    assert.throws(() => createWebsiteBehaviorContract([invalidJourney]), 'content is reserved for download assertions even during model normalization')
    assert.throws(() => parseWebsiteBehaviorContract({ version: 1, checks: [{ id: 'unexpected_content', test: invalidJourney }] }))
  }
  const largeExportTests = Array.from({ length: 4 }, (_, index) => ({ ...textExport, name: `Large export ${index}`, expect: Array.from({ length: 3 }, (_, item) => ({ type: 'download', value: `part-${item}.txt`, content: { format: 'text', equals: 'a'.repeat(12000) } })) }))
  assert.throws(() => createWebsiteBehaviorContract(largeExportTests), /metadata exceeds/, 'valid individual export assertions still obey the aggregate private-contract size limit')

  const request = 'Change tax from 20% to 25%.'
  const updatedTax = { ...calculation, expect: [{ ...calculation.expect[0], value: '250' }] }
  const update = { action: 'update', id: baseline.checks[0].id, reason: 'Tax rate explicitly changed from 20% to 25%.', requestQuote: request, test: updatedTax }
  const reconcile = (changes, contract = baseline, prompt = request) => reconcileWebsiteBehaviorContract(contract, JSON.stringify({ changes }), prompt)
  assert.deepEqual(reconcile([], exportContract).checks, exportContract.checks, 'unrelated edits preserve exact export-content assertions')
  const changedCsv = { ...csvExport, expect: [{ ...csvExport.expect[0], content: { format: 'csv', equals: [['Name', 'Income', 'Tax'], ['Nalu, "東京"', '1000', '250']] } }] }
  const exportRequest = 'Change the CSV export tax from 200 to 250.'
  const exportUpdate = { action: 'update', id: exportContract.checks[0].id, reason: 'The requested CSV value changed.', requestQuote: exportRequest, test: changedCsv }
  const reconciledExport = reconcile([exportUpdate], exportContract, exportRequest)
  assert.deepEqual(reconciledExport.checks[0], { id: exportContract.checks[0].id, test: changedCsv }, 'authorized changes retain the full new content expectation and stable ID')
  assert.deepEqual(reconciledExport.checks.slice(1), exportContract.checks.slice(1), 'a CSV-specific revision does not weaken JSON or text export checks')
  assert.throws(() => reconcile([{ ...exportUpdate, test: { ...changedCsv, expect: [{ type: 'download', value: 'records.csv', content: { format: 'csv', equals: [12] } }] } }], exportContract, exportRequest))
  assert.deepEqual(reconcile([]).checks, baseline.checks)
  assert.throws(() => reconcileWebsiteBehaviorContract(baseline, JSON.stringify({ changes: [], runtimeTests: [calculation] }), 'Make the background ivory.'), /only supported fields/, 'the observed extra-root response remains rejected; fix the prompt instead of accepting replacement suites')
  const revised = reconcile([update])
  assert.equal(revised.checks[0].id, baseline.checks[0].id)
  assert.deepEqual(revised.checks[0].test, updatedTax)
  assert.deepEqual(revised.checks.slice(1), baseline.checks.slice(1))
  assert.deepEqual(baseline.checks[0].test, calculation, 'reconciliation does not mutate saved input')
  for (const changes of [[{ ...update, id: 'unknown' }], [update, update], [{ ...update, reason: '' }], [{ ...update, requestQuote: 'not the actual request' }], [{ ...update, test: undefined }], [{ ...update, action: 'remove' }], [{ ...update, action: 'replaceAll' }], [{ ...update, action: 'add' }]]) assert.throws(() => reconcile(changes))
  const addition = { action: 'add', reason: 'Requested new calculation check', requestQuote: request, test: updatedTax }
  assert.equal(reconcile([addition]).checks.length, 4)
  assert.throws(() => reconcile([addition], maxContract), /1-12/)
  const removals = baseline.checks.map(check => ({ action: 'remove', id: check.id, reason: 'The user removes this tool.', requestQuote: 'Remove the entire calculator.' }))
  assert.equal(reconcile(removals, baseline, 'Remove the entire calculator.'), undefined, 'retiring the last feature leaves no claimed coverage')

  const originalBrief = 'Income accepts an amount. Calculate tax at 20%. Reset clears the form. Reject negative income. Send records to the accounting service.'
  const requirement = (id, quote, goal, coverage) => ({ id, quote, viewports: ['desktop', 'mobile'], goal, coverage })
  const mapped = (check, operation) => ({ state: 'mapped', refs: [{ checkId: baseline.checks[check].id, ...operation }] })
  const inventory = { version: 1, requirements: [
    requirement('income', 'Income accepts an amount.', { kind: 'control', action: 'fill', target: { label: 'Income' } }, mapped(0, { step: 0 })),
    requirement('tax', 'Calculate tax at 20%.', { kind: 'result', expectation: calculation.expect[0] }, mapped(0, { assertion: 0 })),
    requirement('reset', 'Reset clears the form.', { kind: 'control', action: 'click', target: { role: 'button', name: 'Reset' } }, mapped(1, { step: 1 })),
    requirement('validation', 'Reject negative income.', { kind: 'result', expectation: invalid.expect[0] }, mapped(2, { assertion: 0 })),
    requirement('service', 'Send records to the accounting service.', { kind: 'capability', description: 'Remote accounting service delivery' }, { state: 'unsupported', reason: 'This preview cannot verify the external service.' }),
  ] }
  const v2 = createWebsiteBehaviorContractV2(baseline.checks, inventory, originalBrief)
  const originalV2 = copy(v2)
  const reconcileV2 = (changes = [], requirementChanges = [], contract = v2, prompt = request) => reconcileWebsiteBehaviorContract(contract, JSON.stringify({ changes, requirementChanges }), prompt)
  const requirementDelta = (id, fields = {}, authorization = request) => {
    const saved = v2.inventory.requirements.find(item => item.id === id)
    return { action: 'update', id, reason: 'The latest request explicitly authorizes this change.', requestQuote: authorization, viewports: saved.viewports, goal: saved.goal, coverage: saved.coverage, ...fields }
  }
  assert.deepEqual(parseWebsiteBehaviorContract(v2), v2, 'v2 roundtrips the full inventory and evidence independently of check IDs')
  assert.deepEqual(v2.checks, baseline.checks)
  assert.ok(v2.evidence.every(item => item.origin.requestHash === createHash('sha256').update(originalBrief).digest('hex')))
  assert.deepEqual(reconcileV2().inventory, inventory, 'cosmetic changes preserve declared and unsupported requirements')
  assert.deepEqual(reconcileV2().evidence, v2.evidence)
  assert.deepEqual(reconcileWebsiteBehaviorContract(v2, '{"changes":[]}', 'Make the background ivory.').inventory, inventory, 'omitted requirement deltas preserve inventory')
  assert.throws(() => createWebsiteBehaviorContractV2([], { version: 1, requirements: [] }, originalBrief), /1-16/, 'fresh inventories cannot silently start empty')
  const unsupportedOnly = createWebsiteBehaviorContractV2([], { version: 1, requirements: [inventory.requirements[4]] }, originalBrief)
  assert.equal(parseWebsiteBehaviorContract(unsupportedOnly).checks.length, 0, 'unsupported inventory persists even without runnable checks')
  assert.equal(unsupportedOnly.inventory.requirements[0].coverage.state, 'unsupported')
  const v2Changed = reconcileV2([update], [requirementDelta('tax', { quote: request, goal: { kind: 'result', expectation: updatedTax.expect[0] } })])
  assert.deepEqual(v2Changed.checks[0].test, updatedTax)
  assert.deepEqual(v2Changed.inventory.requirements.filter(item => item.id !== 'tax'), inventory.requirements.filter(item => item.id !== 'tax'))
  assert.deepEqual(v2Changed.evidence.find(item => item.id === 'tax').origin, v2.evidence.find(item => item.id === 'tax').origin, 'updates retain immutable initial definition provenance')
  assert.equal(v2Changed.evidence.find(item => item.id === 'tax').current.quote, request)
  assert.equal(v2Changed.lastRequirementChanges[0].requestQuote, request)
  assert.throws(() => reconcileV2([update], [requirementDelta('tax', { goal: { kind: 'result', expectation: updatedTax.expect[0] } })]), /explicit definition quote/, 'changed substantive goals require an explicit choice of definition evidence')
  assert.deepEqual(v2, originalV2, 'successful v2 changes do not mutate baseline or nested goals')
  const checkOnlyUpdate = reconcileV2([update])
  assert.equal(checkOnlyUpdate.inventory.requirements.find(item => item.id === 'tax').coverage.state, 'uncovered', 'changed check expectations do not silently rewrite frozen requirement goals')
  assert.deepEqual(checkOnlyUpdate.inventory.requirements.find(item => item.id === 'tax').goal, inventory.requirements[1].goal)
  assert.equal(checkOnlyUpdate.inventory.requirements.find(item => item.id === 'income').coverage.state, 'mapped', 'an unchanged compatible operation retains its reference')
  const shifted = copy(calculation); shifted.steps.reverse()
  const shiftedContract = reconcileV2([{ ...update, test: shifted }])
  assert.equal(shiftedContract.inventory.requirements[0].coverage.state, 'uncovered', 'positional references cannot silently point at a different operation')
  const noChecks = reconcileV2(removals, [], v2, 'Remove the entire calculator.')
  assert.equal(noChecks.checks.length, 0)
  assert.equal(noChecks.inventory.requirements.length, inventory.requirements.length, 'removing all checks retains every requirement')
  assert.ok(noChecks.inventory.requirements.slice(0, 4).every(item => item.coverage.state === 'uncovered'))
  assert.equal(noChecks.inventory.requirements[4].coverage.state, 'unsupported')
  assert.deepEqual(parseWebsiteBehaviorContract(noChecks), noChecks)
  const retireRequest = 'Remove all calculator and accounting features.'
  const retireRequirements = inventory.requirements.map(item => ({ action: 'remove', id: item.id, reason: 'Explicitly removed by the user.', requestQuote: retireRequest }))
  const retired = reconcileV2(removals.map(item => ({ ...item, requestQuote: retireRequest })), retireRequirements, v2, retireRequest)
  assert.deepEqual(retired.checks, [])
  assert.deepEqual(retired.inventory.requirements, [])
  assert.deepEqual(retired.evidence, [])
  assert.equal(retired.requirementsRetired, true)
  assert.equal(retired.lastRequirementChanges.length, inventory.requirements.length)
  assert.ok(retired.lastRequirementChanges.every(item => item.requestHash === createHash('sha256').update(retireRequest).digest('hex') && item.requestQuote === retireRequest))
  const retiredCosmetic = reconcileV2([], [], retired, 'Make the background ivory.')
  assert.equal(retiredCosmetic.requirementsRetired, true)
  assert.deepEqual(retiredCosmetic.lastRequirementChanges, retired.lastRequirementChanges, 'cosmetic edits retain the explicit all-retired trace')

  const finishRequest = 'Finish the existing form.'
  const restoredIncome = reconcileV2([{ action: 'add', key: 'restored_form', reason: 'Restore the requested form interaction.', requestQuote: finishRequest, test: calculation }], [requirementDelta('income', { coverage: { state: 'mapped', refs: [{ checkKey: 'restored_form', step: 0 }] } }, finishRequest)], noChecks, finishRequest)
  assert.equal(restoredIncome.inventory.requirements[0].quote, inventory.requirements[0].quote, 'mapping-only updates retain the original named-control definition')
  assert.deepEqual(restoredIncome.evidence[0], v2.evidence[0], 'mapping-only authorization does not replace definition provenance')
  assert.equal(restoredIncome.lastRequirementChanges[0].requestQuote, finishRequest)
  assert.equal(restoredIncome.inventory.requirements[0].coverage.refs[0].checkId, restoredIncome.checks[0].id, 'new check aliases resolve to server-assigned stable IDs')
  assert.equal(restoredIncome.inventory.requirements[1].coverage.state, 'uncovered', 'restoring one control does not automatically claim its distinct result')
  const renameRequest = 'Rename Income to Annual income.'
  const renamedTest = copy(calculation); renamedTest.steps[0].target.label = 'Annual income'
  const renameDelta = requirementDelta('income', { quote: renameRequest, goal: { kind: 'control', action: 'fill', target: { label: 'Annual income' } } }, renameRequest)
  const renamed = reconcileV2([{ ...update, test: renamedTest, requestQuote: renameRequest }], [renameDelta], v2, renameRequest)
  assert.equal(renamed.inventory.requirements[0].quote, renameRequest)
  assert.deepEqual(renamed.evidence[0].origin, v2.evidence[0].origin)
  assert.equal(renamed.evidence[0].current.quote, renameRequest)
  const renamedUncovered = reconcileV2([{ action: 'remove', id: baseline.checks[0].id, reason: 'Remove the existing check.', requestQuote: finishRequest }], [], renamed, finishRequest)
  const renameRemap = { ...renameDelta, requestQuote: finishRequest, coverage: { state: 'mapped', refs: [{ checkKey: 'renamed_form', step: 0 }] } }; delete renameRemap.quote
  const repairedRename = reconcileV2([{ action: 'add', key: 'renamed_form', reason: 'Finish the existing form.', requestQuote: finishRequest, test: renamedTest }], [renameRemap], renamedUncovered, finishRequest)
  assert.deepEqual(repairedRename.evidence[0], renamed.evidence[0], 'later mapping repairs preserve the prior renamed-definition source')
  assert.equal(repairedRename.inventory.requirements[0].quote, renameRequest)
  const capabilityIncome = createWebsiteBehaviorContractV2([], { version: 1, requirements: [requirement('income', inventory.requirements[0].quote, { kind: 'capability', description: inventory.requirements[0].quote }, { state: 'uncovered', reason: 'The form still needs executable checks.' })] }, originalBrief)
  const upgradedCapability = reconcileV2([{ action: 'add', key: 'finished_form', reason: 'Finish the existing form.', requestQuote: finishRequest, test: calculation }], [requirementDelta('income', { quote: inventory.requirements[0].quote, coverage: { state: 'mapped', refs: [{ checkKey: 'finished_form', step: 0 }] } }, finishRequest)], capabilityIncome, finishRequest)
  assert.equal(upgradedCapability.inventory.requirements[0].goal.kind, 'control', 'explicitly retaining the original definition allows capability-to-executable completion under a generic request')
  assert.deepEqual(upgradedCapability.evidence[0], capabilityIncome.evidence[0])
  const reorderedGoal = { target: { label: 'Income' }, action: 'fill', kind: 'control' }
  assert.equal(reconcileV2([], [requirementDelta('income', { goal: reorderedGoal }, finishRequest)], v2, finishRequest).inventory.requirements[0].goal.kind, 'control', 'object key ordering does not manufacture a goal change')
  assert.throws(() => reconcileV2([{ ...update, test: renamedTest, requestQuote: renameRequest }], [{ ...renameDelta, quote: 'Invented Annual income definition' }], v2, renameRequest), /literal/, 'renames need a new literal definition quote')
  const noQuoteRename = { ...renameDelta }; delete noQuoteRename.quote
  assert.throws(() => reconcileV2([{ ...update, test: renamedTest, requestQuote: renameRequest }], [noQuoteRename], v2, renameRequest), /exact accessible target/, 'a renamed control cannot borrow an old definition that lacks the new name')

  const addedWithoutMapping = reconcileV2([addition])
  assert.equal(addedWithoutMapping.inventory.requirements.length, inventory.requirements.length + 1)
  assert.equal(addedWithoutMapping.inventory.requirements.at(-1).coverage.state, 'uncovered', 'new checks without declared mappings cannot create a complete coverage claim')
  assert.equal(addedWithoutMapping.inventory.requirements.at(-1).goal.kind, 'capability')
  const resurrected = reconcileV2([{ ...addition, key: 'new_tax' }], [{ action: 'add', reason: 'Add the requested calculation.', requestQuote: request, viewports: ['desktop', 'mobile'], goal: { kind: 'result', expectation: updatedTax.expect[0] }, coverage: { state: 'mapped', refs: [{ checkKey: 'new_tax', assertion: 0 }] } }], retired)
  assert.equal(resurrected.inventory.requirements.length, 1)
  assert.equal(resurrected.requirementsRetired, undefined, 'an explicitly added new requirement ends the retired state')
  assert.match(resurrected.inventory.requirements[0].id, /^requirement_[a-f0-9]{20}/)
  assert.equal(resurrected.lastRequirementChanges[0].action, 'add')

  const v2InvalidMutations = [
    value => { value.extra = true },
    value => { value.inventory.requirements[0].coverage.refs[0].checkId = 'missing' },
    value => { value.inventory.requirements[0].coverage.refs[0].step = 99 },
    value => { value.inventory.requirements[0].coverage.refs[0].checkKey = 'unresolved_alias' },
    value => { value.inventory.requirements[1].goal.expectation.value = '999' },
    value => { value.inventory.requirements[0].quote = 'Fake Income quote.' },
    value => { value.evidence[0].origin.requestHash = 'not-a-hash' },
    value => { value.evidence[0].current = { requestHash: 'a'.repeat(64), quote: 'Unrelated quote.' } },
    value => { value.evidence[0].origin.extra = 'inert' },
    value => { value.evidence.push(value.evidence[0]) },
    value => { value.evidence[1].id = value.evidence[0].id },
    value => { value.requirementsRetired = true },
    value => { value.lastRequirementChanges = [{ id: 'missing', action: 'update', reason: 'invalid', requestHash: 'a'.repeat(64), requestQuote: request }] },
    value => { value.lastRequirementChanges = [{ id: 'income', action: 'remove', reason: 'contradiction', requestHash: 'a'.repeat(64), requestQuote: request }] },
    value => { value.checks = Array(13).fill(value.checks[0]) },
  ]
  for (const mutate of v2InvalidMutations) { const value = copy(v2); mutate(value); assert.throws(() => parseWebsiteBehaviorContract(value)) }
  for (const mutate of [value => { delete value.requirementsRetired }, value => { delete value.lastRequirementChanges }, value => { value.lastRequirementChanges = [] }]) { const value = copy(retired); mutate(value); assert.throws(() => parseWebsiteBehaviorContract(value)) }
  assert.throws(() => parseWebsiteBehaviorContract({ ...v2, metadata: 'x'.repeat(128001) }), /exceeds/)
  let executedGetter = false
  const accessorContract = copy(v2); Object.defineProperty(accessorContract.evidence[0], 'origin', { enumerable: true, get() { executedGetter = true; return v2.evidence[0].origin } })
  assert.throws(() => parseWebsiteBehaviorContract(accessorContract), /ordinary JSON/)
  assert.equal(executedGetter, false, 'v2 metadata validation never invokes getters')
  class ExecutableArray extends Array { map() { executedGetter = true; throw new Error('Must not execute') } }
  const inheritedArray = copy(v2); inheritedArray.inventory.requirements = new ExecutableArray(...inheritedArray.inventory.requirements)
  assert.throws(() => parseWebsiteBehaviorContract(inheritedArray), /ordinary JSON/)
  assert.equal(executedGetter, false, 'inherited executable array methods are rejected before use')
  for (const proposal of [
    { changes: [], requirementChanges: [], runtimeTests: [] },
    { changes: [update], requirementChanges: [{ ...requirementDelta('tax'), id: 'missing' }] },
    { changes: [], requirementChanges: [requirementDelta('income', { coverage: { state: 'mapped', refs: [{ checkKey: 'missing', step: 0 }] } })] },
    { changes: [], requirementChanges: [requirementDelta('tax', { requestQuote: 'Older user context' })] },
    { changes: [], requirementChanges: [requirementDelta('tax'), requirementDelta('tax')] },
    { changes: [addition, { ...addition, key: 'reused' }, { ...addition, key: 'reused' }], requirementChanges: [] },
    { changes: [], requirementChanges: [{ action: 'add', id: 'invented', reason: 'bad', requestQuote: request }] },
    { changes: [], requirementChanges: [{ action: 'remove', id: 'tax', reason: 'bad', requestQuote: request, quote: request }] },
  ]) {
    assert.throws(() => reconcileWebsiteBehaviorContract(v2, JSON.stringify(proposal), request))
    assert.deepEqual(v2, originalV2, 'failed combined proposals never partially mutate saved checks or requirements')
  }
  assert.throws(() => reconcileV2([], [requirementDelta('tax')], v2, request + ' ' + request), /unambiguously/, 'duplicate excerpts cannot ambiguously authorize a change')
  const maxInventory = { version: 1, requirements: Array.from({ length: 16 }, (_, index) => ({ ...inventory.requirements[4], id: `unsupported_${index}` })) }
  const maxV2 = createWebsiteBehaviorContractV2(maxContract.checks, maxInventory, originalBrief)
  assert.throws(() => reconcileV2([addition], [], maxV2), /1-12/)
  const maxRequirements = createWebsiteBehaviorContractV2(baseline.checks, maxInventory, originalBrief)
  assert.throws(() => reconcileV2([addition], [], maxRequirements), /schema or size/, 'conservative declarations obey the same 16-requirement cap atomically')
  const v2ExportBrief = 'Export the full CSV records. Export the full JSON records. Export the exact text notes.'
  const v2ExportInventory = { version: 1, requirements: exportContract.checks.map((check, index) => requirement(`export_${index}`, ['Export the full CSV records.', 'Export the full JSON records.', 'Export the exact text notes.'][index], { kind: 'result', expectation: check.test.expect[0] }, { state: 'mapped', refs: [{ checkId: check.id, assertion: 0 }] })) }
  const v2Exports = createWebsiteBehaviorContractV2(exportContract.checks, v2ExportInventory, v2ExportBrief)
  assert.deepEqual(parseWebsiteBehaviorContract(v2Exports), v2Exports, 'v2 goal and check export-content expectations persist together')
  assert.deepEqual(reconcileV2([], [], v2Exports).inventory, v2ExportInventory)
  const heavyChecks = createWebsiteBehaviorContract(Array.from({ length: 12 }, (_, index) => ({ ...textExport, name: `Bounded export ${index}`, expect: [{ type: 'download', value: 'notes.txt', content: { format: 'text', equals: 'x'.repeat(10200) } }] }))).checks
  const heavyInventory = { version: 1, requirements: maxInventory.requirements.map(item => ({ ...item, goal: { kind: 'capability', description: 'd'.repeat(300) }, coverage: { state: 'unsupported', reason: 'r'.repeat(300) } })) }
  assert.ok(Buffer.byteLength(JSON.stringify({ version: 1, checks: heavyChecks })) < 128000)
  assert.ok(Buffer.byteLength(JSON.stringify(heavyInventory)) < 16000)
  assert.throws(() => createWebsiteBehaviorContractV2(heavyChecks, heavyInventory, originalBrief), /metadata exceeds/, 'individually bounded checks and inventory still obey the whole-contract 128KB cap')

  const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Budget</title></head><body><main><h1>Plan your budget</h1><form><label for="income">Income</label><input id="income" type="number"><button type="submit">Calculate</button><button type="reset">Reset</button><output id="result"></output></form><a href="#income">Edit income</a></main><script>document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const value=Number(document.querySelector('input').value);document.querySelector('output').textContent=value<0?'Enter a positive income':value*0.2})</script></body></html>`
  const patch = (search, replace, runtimeTests = []) => JSON.stringify({ edits: [{ search, replace }], runtimeTests })
  const heading = patch('Plan your budget', 'Family budget', [{ name: 'Weak heading check', steps: [], expect: [{ type: 'text', target: { selector: 'h1' }, value: 'Family budget' }] }])
  const passed = { status: 'passed', widths: [1440, 390], checks: [], issues: [], limitations: ['Synthetic runtime fixture: orchestration checks only; this test does not launch a browser.'] }
  Date.now = () => time
  let model, runtime
  const resetFixture = () => { time = 0; calls.length = 0; runtimeCalls.length = 0; runtime = () => copy(passed) }
  globalThis.behaviorFixture = {
    complete: async (messages, options) => { calls.push({ messages, options, time }); return model(messages, options) },
    runtime: async (candidate, tests, options) => { runtimeCalls.push({ html: candidate, tests: copy(tests), options }); return runtime(candidate, tests, options) },
  }
  const generate = options => generateWebsite({ model: 'builder', plannerModel: 'planner', prompt: 'Change the heading to Family budget.', user: 'Change the heading to Family budget.', previous: html, previousContract: baseline, deadlineMs: 275000, ...options })
  const assertFeatureContext = (call, contract) => {
    const content = call.messages[1].content
    const match = content.match(/FROZEN REQUESTED FEATURES \(JSON data\):\n([^\n]+)\nEND FROZEN REQUESTED FEATURES\./)
    assert.ok(match, 'Every v2 edit/repair receives its saved feature definitions, including unverified features')
    const supplied = JSON.parse(match[1])
    assert.deepEqual(supplied, { inventory: contract.inventory, requirementsRetired: contract.requirementsRetired === true })
    assert.match(content, /verification coverage, not permission to omit/)
  }
  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[]}' : heading
  const cosmetic = await generate()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.providers[0].model, 'planner')
  assert.doesNotMatch(calls[0].messages[0].content, /Include runtimeTests:|up to 4 short/, 'edit reconciliation must not inherit the initial planner output instruction')
  assert.match(calls[0].messages[0].content, /changes as its only root key/)
  assert.match(calls[0].messages[0].content, /one short, contiguous excerpt copied exactly/)
  assert.ok(!calls[0].messages[1].content.includes('<!doctype'), 'independent reconciliation has no implementation source or candidate')
  assert.deepEqual(runtimeCalls[0].tests, baseline.checks.map(check => check.test), 'builder-provided replacement tests cannot weaken preserved coverage')
  assert.deepEqual(cosmetic.behaviorContract.checks, baseline.checks)
  assert.match(calls[1].messages[1].content, /FROZEN BEHAVIOR CHECKS/)
  assertFrozenPrompt(calls[1])
  assert.doesNotMatch(calls[1].messages[1].content, /FROZEN REQUESTED FEATURES/, 'legacy edits cannot invent a requirement inventory')

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: [update] }) : patch('*0.2', '*0.25', [calculation])
  const changed = await generate({ prompt: request, user: 'OLD CONTEXT SAYS TAX 20%.\n' + request })
  assert.equal(changed.html, html.replace('*0.2', '*0.25'))
  assert.deepEqual(changed.behaviorContract, revised)
  assert.deepEqual(runtimeCalls[0].tests, [updatedTax, reset, invalid])
  assert.ok(!calls[0].messages[1].content.includes('OLD CONTEXT'), 'reconciliation sees the latest instruction, not broad chat context')

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: [update] }) : heading
  assert.equal(await generate({ prompt: 'CURRENT: Make the heading blue.\nPRIOR CONTEXT: ' + request, changeRequest: 'Make the heading blue.' }), null, 'a prior-context instruction cannot authorize changed expectations when the latest request is supplied separately')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => !call.messages[1].content.includes(request)))
  assert.equal(runtimeCalls.length, 0)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[]}' : heading
  const currentOnly = await generate({ prompt: 'CURRENT: Make the heading blue.\nPRIOR CONTEXT: ' + request, changeRequest: 'Make the heading blue.' })
  assert.deepEqual(currentOnly.behaviorContract.checks, baseline.checks)
  assert.ok(!calls[0].messages[1].content.includes(request))

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[],"requirementChanges":[]}' : heading
  const v2Cosmetic = await generate({ previousContract: v2 })
  assert.equal(calls[0].messages[0].content, WEBSITE_REQUIREMENT_RECONCILE_SYSTEM)
  assert.ok(!calls[0].messages[1].content.includes('<!doctype'), 'v2 reconciliation remains independent of candidate implementation')
  assert.deepEqual(v2Cosmetic.behaviorContract.inventory, v2.inventory)
  assert.deepEqual(v2Cosmetic.behaviorContract.evidence, v2.evidence)
  assert.deepEqual(runtimeCalls[0].tests, v2.checks.map(item => item.test), 'builder replacement checks cannot weaken frozen v2 checks')
  assert.equal(v2Cosmetic.review.runtime.status, 'partial', 'unsupported declarations preclude a complete runtime claim')
  assertFrozenPrompt(calls[1])
  assertFeatureContext(calls[1], v2)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: [update], requirementChanges: [requirementDelta('tax', { quote: request, goal: { kind: 'result', expectation: updatedTax.expect[0] } })] }) : patch('*0.2', '*0.25', [calculation])
  const v2TaxChange = await generate({ previousContract: v2, prompt: request })
  assert.deepEqual(v2TaxChange.behaviorContract, v2Changed, 'generation persists the same atomic check and requirement revision')
  assert.deepEqual(runtimeCalls[0].tests, [updatedTax, reset, invalid])
  assertFeatureContext(calls[1], v2Changed)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: removals, requirementChanges: [] }) : heading
  const v2RemovedChecks = await generate({ previousContract: v2, prompt: 'Remove the entire calculator.' })
  assert.deepEqual(v2RemovedChecks.behaviorContract, noChecks, 'generation retains uncovered inventory after removing the final check')
  assert.equal(runtimeCalls[0].tests.length, 0)
  assert.equal(v2RemovedChecks.review.runtime.status, 'partial')
  assertFeatureContext(calls[1], noChecks)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[],"requirementChanges":[]}' : heading
  const retiredGeneration = await generate({ previousContract: retired })
  assert.deepEqual(retiredGeneration.behaviorContract, retiredCosmetic)
  assert.equal(runtimeCalls[0].tests.length, 0, 'builder-provided tests cannot resurrect explicitly retired requirements')
  assert.equal(retiredGeneration.review.runtime.status, 'partial')
  assertFeatureContext(calls[1], retiredCosmetic)

  resetFixture()
  model = () => patch('*0.5', '*0.2', [fileNameOnly])
  runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Stored export expectations failed.' }] } : copy(passed)
  const v2PreviewRepair = await generate({ previousContract: v2Exports, previous: html.replace('*0.2', '*0.5'), repairIssues: ['Finish the existing export controls.'] })
  assert.equal(calls.length, 1, 'preview repair never reconciles requirements')
  assert.deepEqual(v2PreviewRepair.behaviorContract, v2Exports, 'preview repair keeps v2 definitions, evidence and full CSV/JSON/text expectations unchanged')
  assert.ok(runtimeCalls.every(call => JSON.stringify(call.tests) === JSON.stringify(v2Exports.checks.map(item => item.test))))
  assertFrozenPrompt(calls[0])
  assertFeatureContext(calls[0], v2Exports)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: [{ ...update, id: 'invented' }] }) : heading
  assert.equal(await generate({ prompt: request }), null)
  assert.equal(calls.length, 2)
  assert.equal(runtimeCalls.length, 0, 'invalid reconciliation never edits or verifies a new candidate')
  resetFixture()
  model = () => ({ content: '{"changes":[]}', finishReason: 'length' })
  assert.equal(await generate(), null, 'parseable but unfinished reconciliation cannot authorize code edits')

  resetFixture()
  model = () => patch('*0.5', '*0.2', [updatedTax])
  runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Saved tax test expected 200, observed 500.' }] } : copy(passed)
  const repaired = await generate({ previous: html.replace('*0.2', '*0.5'), repairIssues: ['Calculation changed unexpectedly.'] })
  assert.equal(repaired.html, html)
  assert.equal(calls.length, 1, 'preview repair bypasses behavior reconciliation')
  assert.deepEqual(repaired.behaviorContract, baseline)
  assert.ok(runtimeCalls.every(call => JSON.stringify(call.tests) === JSON.stringify(baseline.checks.map(check => check.test))))
  assert.match(calls[0].messages[1].content, /FROZEN BEHAVIOR CHECKS/)
  assertFrozenPrompt(calls[0])

  resetFixture()
  model = () => patch('*0.5', '*0.2', [fileNameOnly])
  runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Downloaded tax data is incorrect.' }] } : copy(passed)
  const exportRepair = await generate({ previousContract: exportContract, previous: html.replace('*0.2', '*0.5'), repairIssues: ['The downloaded CSV and JSON contain incorrect tax values.'] })
  assert.equal(exportRepair.html, html)
  assert.deepEqual(exportRepair.behaviorContract, exportContract)
  assert.ok(runtimeCalls.every(call => JSON.stringify(call.tests) === JSON.stringify([csvExport, jsonExport, textExport])), 'frozen repair suites retain full content assertions even if the builder returns filename-only checks')
  assert.equal(calls.length, 1, 'preview repairs do not reconcile or weaken export requirements')
  assert.match(calls[0].messages[1].content, /"content":\{"format":"csv"/)
  assert.match(calls[0].messages[1].content, /"content":\{"format":"json"/)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[]}' : calls.length === 2 ? patch('*0.2', '*0.5') : patch('*0.5', '*0.2', [updatedTax])
  runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Saved tax expectation failed.' }] } : copy(passed)
  const protectedResult = await generate({ prompt: 'Update the styling.' })
  assert.equal(protectedResult.html, html, 'an unrelated broken calculation is repaired under the original frozen test')
  assert.equal(calls.length, 3)
  assert.ok(runtimeCalls.every(call => call.tests[0].expect[0].value === '200'))
  calls.slice(1).forEach(assertFrozenPrompt)

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: [addition] }) : heading
  assert.equal(await generate({ previousContract: maxContract, prompt: request }), null, 'oversized reconciliation cannot silently discard baseline checks')
  assert.equal(runtimeCalls.length, 0)
  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[]}' : heading
  const full = await generate({ previousContract: maxContract })
  assert.equal(full.behaviorContract.checks.length, 12)
  assert.equal(runtimeCalls[0].tests.length, 12, 'all persisted tests reach the runtime; there is no four-test slice')

  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? JSON.stringify({ changes: removals }) : heading
  const removed = await generate({ prompt: 'Remove the entire calculator.' })
  assert.equal(removed.behaviorContract, undefined)
  assert.equal(runtimeCalls[0].tests.length, 0)
  assert.equal(removed.review.runtime.status, 'partial', 'no saved checks means no complete verification claim')
  assertFrozenPrompt(calls[1])
  assert.match(calls[1].messages[1].content, /FROZEN BEHAVIOR CHECKS[^\n]*\n\[\]/, 'an explicitly retired suite remains frozen even though no contract is returned')

  resetFixture()
  model = (messages, options) => { time += options.timeoutMs; throw new Error('planner unavailable') }
  assert.equal(await generate(), null)
  assert.equal(calls.length, 2)
  assert.equal(time, 25000, 'reconciliation attempts share a bounded 25s window')
  resetFixture()
  model = () => heading
  assert.equal(await generate({ deadlineMs: 30000 }), null)
  assert.equal(calls.length, 0, 'short deadline preserves the saved artifact without starting code edits')
  resetFixture()
  model = messages => messages[0].content.includes('reconcile saved website') ? '{"changes":[]}' : heading
  runtime = () => ({ ...copy(passed), status: 'unavailable', widths: [] })
  await assert.rejects(generate(), WebsiteRuntimeUnavailableError, 'an exhausted browser budget cannot become verified output')

  resetFixture()
  model = () => patch('Plan your budget', 'Family budget', [calculation])
  const legacy = await generate({ previousContract: undefined })
  assert.equal(calls.length, 1, 'old clients remain compatible and skip reconciliation without a baseline')
  assert.deepEqual(legacy.behaviorContract.checks[0].test, calculation)
  assert.equal(calls[0].messages[0].content, WEBSITE_EDIT_SYSTEM, 'a legacy first edit still gathers its initial behavior checks')

  resetFixture()
  model = () => calls.length === 1 ? patch('*0.2', '*0.5', [calculation]) : patch('*0.5', '*0.2', [updatedTax])
  runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Initial legacy expectation failed.' }] } : copy(passed)
  const legacyRepair = await generate({ previousContract: undefined })
  assert.equal(legacyRepair.html, html)
  assert.equal(legacyRepair.repaired, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].messages[0].content, WEBSITE_EDIT_SYSTEM)
  assertFrozenPrompt(calls[1])
  assert.ok(runtimeCalls.every(call => JSON.stringify(call.tests) === JSON.stringify([calculation])), 'legacy repairs keep the initial edit checks instead of accepting the repair answer tests')
  assert.deepEqual(legacyRepair.behaviorContract.checks[0].test, calculation)

  resetFixture()
  const initialBrief = 'Calculate tax at 20% for Income 1000 and display 200.'
  const plannedRequirements = [{ id: 'tax_result', quote: initialBrief, goal: { kind: 'result', type: 'text', target: { selector: '#result' } }, refs: [{ test: 0, assertion: 0 }] }]
  model = messages => messages[0].content.includes('planning stage') ? JSON.stringify({ direction: 'Compact budget tool', pages: [{ name: 'Budget' }], runtimeTests: [calculation], requirements: plannedRequirements }) : html
  const initial = await generate({ prompt: initialBrief, user: initialBrief, previous: undefined, previousContract: undefined })
  assert.deepEqual(initial.behaviorContract.checks[0].test, calculation, 'new artifacts persist their independently planned behavior tests')
  assert.equal(initial.behaviorContract.version, 2)
  assert.equal(initial.behaviorContract.inventory.requirements[0].quote, initialBrief)
  assert.equal(initial.behaviorContract.inventory.requirements[0].coverage.refs[0].checkId, initial.behaviorContract.checks[0].id)
  assert.match(calls[0].messages[0].content, /Include runtimeTests: up to 4 short, independent journeys/, 'fresh builds retain their initial planning envelope')

  resetFixture()
  const largeHtml = html.replace('</main>', `<p id="preserved-notes">${'Original field notes. '.repeat(4100)}</p></main>`)
  assert.ok(largeHtml.length > 80000)
  model = messages => messages[0].content.includes('planning stage') ? JSON.stringify({ direction: 'Compact budget tool with full notes', pages: [{ name: 'Budget' }], runtimeTests: [calculation], requirements: plannedRequirements })
    : calls.length === 2 ? largeHtml.replace('*0.2', '*0.5') : patch('*0.5', '*0.2', [updatedTax])
  runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Fresh planned expectation failed.' }] } : copy(passed)
  const largeInitialRepair = await generate({ prompt: initialBrief, user: initialBrief, previous: undefined, previousContract: undefined })
  assert.equal(largeInitialRepair.html, largeHtml, 'a large fresh-build repair keeps every unrelated source byte')
  assert.equal(largeInitialRepair.repaired, true)
  assert.equal(calls.length, 3)
  assert.match(calls[0].messages[0].content, /Include runtimeTests: up to 4 short, independent journeys/)
  assertFrozenPrompt(calls[2])
  assert.ok(runtimeCalls.every(call => JSON.stringify(call.tests) === JSON.stringify([calculation])), 'large fresh repairs keep independently planned tests')
  assert.deepEqual(largeInitialRepair.behaviorContract.checks[0].test, calculation)
  assertFeatureContext(calls[2], largeInitialRepair.behaviorContract)

  for (const repairKind of ['script', 'complete-document']) {
    resetFixture()
    const broken = repairKind === 'script' ? html.replace('*0.2', '*') : html.replace('*0.2', '*0.5')
    model = messages => messages[0].content.includes('planning stage')
      ? JSON.stringify({ direction: 'Compact budget tool', pages: [{ name: 'Budget' }], runtimeTests: [calculation], requirements: plannedRequirements })
      : calls.length === 2 ? broken : repairKind === 'script' ? html.match(/<script>([\s\S]*)<\/script>/)[1] : html
    runtime = candidate => candidate.includes('*0.5') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'The calculated result is incorrect.' }] } : copy(passed)
    const repairedFresh = await generate({ prompt: initialBrief, user: initialBrief, previous: undefined, previousContract: undefined })
    assert.equal(repairedFresh.html, html)
    assert.equal(repairedFresh.repaired, true)
    assert.equal(calls.length, 3)
    assertFeatureContext(calls[2], repairedFresh.behaviorContract)
    assert.ok(!repairedFresh.html.includes('FROZEN REQUESTED FEATURES'), 'Private repair context is not exported into the page')
  }

  resetFixture()
  model = messages => messages[0].content.includes('planning stage')
    ? JSON.stringify({ direction: 'Compact budget tool', pages: [{ name: 'Budget' }], runtimeTests: [calculation], requirements: plannedRequirements })
    : calls.length === 2 ? html.replace(/<\/html>$/, '') : '</html>'
  const continuedFresh = await generate({ prompt: initialBrief, user: initialBrief, previous: undefined, previousContract: undefined })
  assert.equal(continuedFresh.html, html)
  assert.equal(calls.length, 3)
  assertFeatureContext(calls[2], continuedFresh.behaviorContract)

  for (const savedContract of [v2, retired]) {
    resetFixture()
    model = () => calls.length === 1 ? '</html>' : heading
    const continuedSaved = await generate({ previous: html.replace(/<\/html>$/, ''), previousContract: savedContract, repairIssues: ['Finish the incomplete page and update its heading.'] })
    assert.equal(continuedSaved.html, html.replace('Plan your budget', 'Family budget'))
    assert.equal(calls.length, 2)
    assertFeatureContext(calls[0], savedContract)
    assertFeatureContext(calls[1], savedContract)
    assert.deepEqual(continuedSaved.behaviorContract, savedContract, 'Continuation cannot resurrect or rewrite saved feature definitions')
  }

  resetFixture()
  const largeJsonTests = Array.from({ length: 4 }, (_, index) => ({ ...jsonExport, name: `Large JSON export ${index}`, expect: Array.from({ length: 3 }, (_, item) => ({ type: 'download', value: `part-${item}.json`, content: { format: 'json', equals: Array(7).fill('x'.repeat(4000)) } })) }))
  for (const journey of largeJsonTests) assert.equal(createWebsiteBehaviorContract([journey]).checks.length, 1, 'each journey and its bounded JSON expectations are individually valid')
  const diagnosticStages = []
  const exportBrief = 'Export every part of the JSON records.'
  model = messages => messages[0].content.includes('planning stage') ? JSON.stringify({ direction: 'Export workspace', pages: [{ name: 'Exports' }], runtimeTests: largeJsonTests, requirements: [{ id: 'large_export', quote: exportBrief, state: 'uncovered', reason: 'The aggregate expected records exceed saved metadata bounds.' }] }) : html
  const oversizedGeneration = await generate({ prompt: exportBrief, user: exportBrief, previous: undefined, previousContract: undefined, onDiagnostic: stage => diagnosticStages.push(stage) })
  assert.equal(oversizedGeneration, null, 'generation fails closed when valid individual expectations exceed the aggregate saved-contract limit')
  assert.equal(calls.length, 2, 'an unsavable plan gets one bounded correction before failing closed')
  assert.ok(calls.every(call => call.messages[0].content.includes('planning stage')), 'unsavable coverage never reaches the builder')
  assert.equal(runtimeCalls.length, 0, 'cannot run or claim verified output whose regression tests cannot be persisted')
  assert.ok(diagnosticStages.includes('behavior-contract'))

  resetFixture()
  model = () => patch('Plan your budget', 'Family budget')
  const noContract = await generate({ previousContract: undefined })
  assert.equal(noContract.html, html.replace('Plan your budget', 'Family budget'))
  assert.equal(noContract.behaviorContract, undefined)
  assert.equal(runtimeCalls[0].tests.length, 0)
  assert.equal(noContract.review.runtime.status, 'partial', 'empty legacy test coverage remains explicitly partial rather than failing contract persistence')

  resetFixture()
  model = () => calls.length === 1 ? patch('Plan your budget', 'Family budget') : patch('Family budget', 'Finished budget', [calculation])
  runtime = candidate => candidate.includes('Family budget') ? { ...copy(passed), status: 'failed', issues: [{ code: 'runtime-interaction', severity: 'error', detail: 'Synthetic repair finding with no baseline coverage.' }] } : copy(passed)
  const emptyLegacyRepair = await generate({ previousContract: undefined })
  assert.equal(emptyLegacyRepair.html, html.replace('Plan your budget', 'Finished budget'))
  assert.equal(emptyLegacyRepair.repaired, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].messages[0].content, WEBSITE_EDIT_SYSTEM)
  assertFrozenPrompt(calls[1])
  assert.ok(runtimeCalls.every(call => call.tests.length === 0), 'a repair cannot invent verified coverage after an initial edit supplied no checks')
  assert.equal(emptyLegacyRepair.behaviorContract, undefined)
  assert.equal(emptyLegacyRepair.review.runtime.status, 'partial')
  console.log('Website behavior regressions passed: strict bounded v1/v2 contracts; stable IDs; atomic check/requirement changes; original and edited definition provenance; generic completion and renamed-control remapping; cosmetic preservation; zero-check inventory and explicit retirement tombstones; frozen repairs and CSV/JSON/text content expectations; fresh requirement plans; malformed and oversized proposals; full 12-check forwarding; deadline and unavailable-runtime handling. Providers and runtime are synthetic; no browser or paid calls.')
} finally {
  Date.now = originalNow
  delete globalThis.behaviorFixture
  await rm(directory, { recursive: true, force: true })
}
