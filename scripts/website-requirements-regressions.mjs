import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Import the real validator and its production journey/download parsers. This
// script does not launch a browser, call providers, or write bundled artifacts.
const bundle = await build({ entryPoints: ['api/_websiteRequirements.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'absolute-package-import', setup(build) {
  build.onResolve({ filter: /^@vercel\/functions$/ }, args => ({ path: import.meta.resolve(args.path), external: true }))
} }] })
const { parseWebsiteRequirementInventory: parse, parsePlannedWebsiteRequirements: planned, summarizeWebsiteInventoryCoverage: summarize, MAX_WEBSITE_REQUIREMENTS, MAX_WEBSITE_REQUIREMENT_BYTES, MAX_WEBSITE_REQUIREMENT_QUOTE } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const copy = value => JSON.parse(JSON.stringify(value))
const note = 'Review "cedar", then send a local copy.'
const brief = 'Name and Email lead to Next. Selecting Organization reveals the required Organization name field. Show the complete Transfer note in history. Export history downloads every note as JSON. Sort items offers Name A–Z. Menu opens the navigation at both widths. Send real email through an external service.'
const checks = [
  { id: 'organization', test: { name: 'Organization branch', steps: [
    { action: 'fill', target: { label: 'Name' }, value: 'Lee' },
    { action: 'fill', target: { label: 'Email' }, value: 'lee@example.test' },
    { action: 'click', target: { role: 'button', name: 'Next' } },
    { action: 'select', target: { label: 'Request type' }, value: 'organization' },
    { action: 'fill', target: { label: 'Organization name' }, value: 'Cedar Co' },
    { action: 'click', target: { role: 'button', name: 'Next' } },
  ], expect: [{ type: 'text', target: { selector: '#review-organization' }, value: 'Cedar Co' }] } },
  { id: 'history', test: { name: 'History displays literal notes and exports them', steps: [
    { action: 'fill', target: { label: 'Transfer note' }, value: note },
    { action: 'click', target: { role: 'button', name: 'Record transfer' } },
    { action: 'click', target: { role: 'button', name: 'Export history' } },
  ], expect: [
    { type: 'text', target: { selector: '#history-note' }, value: note },
    { type: 'download', value: 'history.json', content: { format: 'json', equals: [{ id: 'M1', note }] } },
  ] } },
  { id: 'sort', test: { name: 'Sort by name', steps: [{ action: 'select', target: { label: 'Sort items' }, value: 'name-asc' }], expect: [{ type: 'text', target: { selector: '#sort option[value="name-asc"]' }, value: 'Name A–Z' }] } },
  { id: 'menu', test: { name: 'Responsive menu', steps: [
    { action: 'click', target: { role: 'button', name: 'Menu' }, viewport: 'mobile' },
    { action: 'click', target: { role: 'button', name: 'Menu' }, viewport: 'desktop' },
  ], expect: [{ type: 'visible', target: { selector: '#navigation' } }] } },
]
const control = { id: 'organization_name', quote: 'Selecting Organization reveals the required Organization name field.', viewports: ['desktop', 'mobile'], goal: { kind: 'control', action: 'fill', target: { label: 'Organization name' } }, coverage: { state: 'mapped', refs: [{ checkId: 'organization', step: 4 }] } }
const displayedNote = { id: 'displayed_note', quote: 'Show the complete Transfer note in history.', viewports: ['desktop', 'mobile'], goal: { kind: 'result', expectation: copy(checks[1].test.expect[0]) }, coverage: { state: 'mapped', refs: [{ checkId: 'history', assertion: 0 }] } }
const exportedNote = { id: 'exported_note', quote: 'Export history downloads every note as JSON.', viewports: ['desktop', 'mobile'], goal: { kind: 'result', expectation: copy(checks[1].test.expect[1]) }, coverage: { state: 'mapped', refs: [{ checkId: 'history', assertion: 1 }] } }
const inventory = { version: 1, requirements: [control, displayedNote, exportedNote] }
const context = { brief, checks }
let count = 0
function passes(value = inventory, input = context) { const result = parse(value, input); count++; return result }
function rejects(value, input = context, pattern) { assert.throws(() => parse(value, input), pattern); count++ }
function change(value, edit) { const next = copy(value); edit(next); return next }

assert.deepEqual(passes(), inventory); count++
assert.deepEqual(summarize(passes()), { status: 'mapped', total: 3, mapped: 3, unsupported: 0, uncovered: 0 }); count++
assert.equal(summarize(passes()).status === 'passed', false); count++
// Legacy contracts contain only checks: passing those checks cannot fabricate
// an extracted inventory or make natural-language coverage complete.
const legacy = { version: 1, checks: copy(checks) }
assert.deepEqual(summarize(legacy.inventory), { status: 'unknown', total: 0, mapped: 0, unsupported: 0, uncovered: 0 }); count++

// Conditional controls bind to actions after their setup, not the initial DOM.
assert.equal(passes().requirements[0].coverage.refs[0].step, 4); count++
rejects(change(inventory, x => { x.requirements[0].coverage.refs[0].step = 0 }))
rejects(change(inventory, x => { x.requirements[0].coverage.refs[0] = { checkId: 'organization', assertion: 0 } }))
rejects(change(inventory, x => { x.requirements[0].goal.target = { selector: '#organization' } }))
rejects(change(inventory, x => { x.requirements[0].goal.target.label = 'Organization' }))
rejects(change(inventory, x => { x.requirements[0].goal.action = 'click' }))
rejects(change(inventory, x => { x.requirements[0].goal.value = 'Different organization' }))
passes(change(inventory, x => { x.requirements[0].goal.value = 'Cedar Co' }))

// History's visible text has a distinct assertion from an export containing the
// same data. Existing valid export evidence cannot hide a missing UI result.
rejects(change(inventory, x => { x.requirements[1].coverage.refs[0] = { checkId: 'history', assertion: 1 } }))
rejects(change(inventory, x => { x.requirements[1].coverage.refs[0] = { checkId: 'history', step: 1 } }))
rejects(inventory, { brief, checks: change(checks, x => { x[1].test.expect[0] = { type: 'visible', target: { selector: '#history-note' } } }) })
rejects(change(inventory, x => { x.requirements[1].goal.expectation = { type: 'visible', target: { selector: '#history-note' } } }))
rejects(inventory, { brief, checks: change(checks, x => { x[1].test.expect[0].value = 'M1' }) })
rejects(inventory, { brief, checks: change(checks, x => { x[1].test.expect[0].target.selector = '#export-status' }) })
rejects(inventory, { brief, checks: change(checks, x => { x[1].test.expect.reverse() }) })
rejects(inventory, { brief, checks: change(checks, x => { x[1].test.expect[1].content.equals[0].note = 'wrong data' }) })
passes(inventory, { brief, checks: change(checks, x => { x[1].test.expect[1].content.equals[0] = { note, id: 'M1' } }) })
const noContents = change(inventory, x => { delete x.requirements[2].goal.expectation.content })
rejects(noContents, { brief, checks: change(checks, x => { delete x[1].test.expect[1].content }) })

const sortRequirement = { id: 'sort_name', quote: 'Sort items offers Name A–Z.', viewports: ['desktop', 'mobile'], goal: { kind: 'control', action: 'select', target: { label: 'Sort items' }, value: 'name-asc' }, coverage: { state: 'mapped', refs: [{ checkId: 'sort', step: 0 }] } }
const sortInventory = { version: 1, requirements: [sortRequirement, { id: 'sort_option_label', quote: sortRequirement.quote, viewports: ['desktop', 'mobile'], goal: { kind: 'result', expectation: copy(checks[2].test.expect[0]) }, coverage: { state: 'mapped', refs: [{ checkId: 'sort', assertion: 0 }] } }] }
passes(sortInventory)
rejects(sortInventory, { brief, checks: change(checks, x => { x[2].test.steps[0].value = 'original' }) })
rejects(sortInventory, { brief, checks: change(checks, x => { x[2].test.expect[0].value = 'Name A-Z' }) })
rejects(change(sortInventory, x => { x.requirements[1].coverage.refs[0] = { checkId: 'sort', step: 0 } }))

const responsive = { version: 1, requirements: [{ id: 'responsive_menu', quote: 'Menu opens the navigation at both widths.', viewports: ['desktop', 'mobile'], goal: { kind: 'control', action: 'click', target: { role: 'button', name: 'Menu' } }, coverage: { state: 'mapped', refs: [{ checkId: 'menu', step: 0 }, { checkId: 'menu', step: 1 }] } }] }
passes(responsive)
rejects(change(responsive, x => { x.requirements[0].coverage.refs.pop() }))
rejects(change(responsive, x => { x.requirements[0].viewports = ['desktop']; x.requirements[0].coverage.refs.pop() }))
passes(change(responsive, x => { x.requirements[0].viewports = ['mobile']; x.requirements[0].coverage.refs.pop() }))
assert.deepEqual(passes(change(responsive, x => { x.requirements[0].viewports.reverse() })).requirements[0].viewports, ['desktop', 'mobile']); count++
const stateRequirement = { version: 1, requirements: [{ id: 'menu_visible', quote: responsive.requirements[0].quote, viewports: ['desktop', 'mobile'], goal: { kind: 'state', expectation: copy(checks[3].test.expect[0]) }, coverage: { state: 'mapped', refs: [{ checkId: 'menu', assertion: 0 }] } }] }
passes(stateRequirement)
rejects(change(stateRequirement, x => { x.requirements[0].goal.kind = 'result' }))
rejects(change(inventory, x => { x.requirements[1].goal.kind = 'state' }))

// Unverified items are retained separately from checks and survive deletion of
// all checks. No stale/deleted reference is tolerated on a mapped item.
const unverified = { version: 1, requirements: [
  { id: 'external_email', quote: 'Send real email through an external service.', viewports: ['desktop', 'mobile'], goal: { kind: 'capability', description: 'Actual external email delivery' }, coverage: { state: 'unsupported', reason: 'External services are outside isolated verification.' } },
  { ...copy(displayedNote), coverage: { state: 'uncovered', reason: 'The bounded plan has not supplied this history assertion.' } },
] }
assert.deepEqual(passes(unverified, { brief, checks: [] }), unverified); count++
assert.deepEqual(summarize(passes(unverified, { brief, checks: [] })), { status: 'partial', total: 2, mapped: 0, unsupported: 1, uncovered: 1 }); count++
rejects(change(unverified, x => { x.requirements[0].coverage = { state: 'mapped', refs: [{ checkId: 'history', assertion: 1 }] } }))
rejects(change(unverified, x => { x.requirements[1].coverage.refs = [] }))
rejects(change(unverified, x => { x.requirements[1].coverage.reason = ' ' }))
rejects(change(unverified, x => { delete x.requirements[1].coverage.reason }))
rejects(inventory, { brief, checks: checks.filter(check => check.id !== 'history') })
passes(inventory, { brief, checks: change(checks, x => { x.reverse(); for (const check of x) check.test.name = 'Harmless renamed description' }) })
rejects(inventory, { brief, checks: change(checks, x => { x[1].id = 'new_id_same_name' }) })

// Evidence is literal, contiguous, case/punctuation-preserving and unambiguous.
rejects(change(inventory, x => { x.requirements[0].quote = 'Organization requires a name.' }))
rejects(change(inventory, x => { x.requirements[0].quote = 'Selecting Organization Organization name field.' }))
rejects(change(inventory, x => { x.requirements[0].quote = x.requirements[0].quote.toLowerCase() }))
rejects(inventory, { brief: brief + ' ' + control.quote, checks }, /ambiguous/)
rejects(change(unverified, x => { x.requirements = [x.requirements[0]]; x.requirements[0].quote = 'aa' }), { brief: 'aaa', checks: [] }, /ambiguous/)
rejects(change(inventory, x => { x.requirements[0].quote = '' }))
const evidenceBoundary = change(unverified, x => { x.requirements = [x.requirements[0]]; x.requirements[0].quote = 'Q'.repeat(MAX_WEBSITE_REQUIREMENT_QUOTE) })
passes(evidenceBoundary, { brief: evidenceBoundary.requirements[0].quote, checks: [] })
const evidenceTooLong = change(evidenceBoundary, x => { x.requirements[0].quote += 'Q' })
rejects(evidenceTooLong, { brief: evidenceTooLong.requirements[0].quote, checks: [] })

for (const malformed of [undefined, null, [], {}, { version: 2, requirements: [] }, { version: 1, requirements: [] }, { contracts: [{ kind: 'label', literal: 'Organization name', behavior: 'Fill it' }] }, { version: 1, requirements: [{ kind: 'label', literal: 'Organization name', behavior: 'Fill it' }] }, { ...inventory, passed: true }]) rejects(malformed)
for (const mutate of [
  x => { x.requirements.push(copy(x.requirements[0])) },
  x => { x.requirements[0].id = 'bad id' },
  x => { x.requirements[0].id = 'x'.repeat(65) },
  x => { x.requirements[0].eval = 'arbitrary code' },
  x => { x.requirements[0].goal.kind = 'label' },
  x => { x.requirements[0].goal.target = { label: 'Organization name', selector: '#organization' } },
  x => { x.requirements[0].viewports = [] },
  x => { x.requirements[0].viewports = ['mobile', 'mobile'] },
  x => { x.requirements[0].viewports = ['tablet'] },
  x => { x.requirements[0].coverage.state = 'passed' },
  x => { x.requirements[0].coverage.refs = [] },
  x => { x.requirements[0].coverage.refs.push(copy(x.requirements[0].coverage.refs[0])) },
  x => { x.requirements[0].coverage.refs[0].step = -1 },
  x => { x.requirements[0].coverage.refs[0].step = 4.5 },
  x => { x.requirements[0].coverage.refs[0].step = 6 },
  x => { x.requirements[0].coverage.refs[0].step = '4' },
  x => { x.requirements[0].coverage.refs[0].assertion = 0 },
  x => { delete x.requirements[0].coverage.refs[0].step },
  x => { x.requirements[0].coverage.refs[0].checkId = 'missing' },
  x => { x.requirements[0].coverage.refs[0].name = 'Organization branch' },
  x => { x.requirements[0].coverage.refs = Array.from({ length: 5 }, () => ({ checkId: 'organization', step: 4 })) },
]) rejects(change(inventory, mutate))
passes(change(inventory, x => { x.requirements[0].id = 'x'.repeat(64) }))
rejects(inventory, { brief, checks: [...checks, copy(checks[0])] })
rejects(inventory, { brief, checks: change(checks, x => { x[0].test.steps[4].target = { label: 'Organization name', selector: '#organization' } }) })
rejects(inventory, { brief, checks: change(checks, x => { x[0].test.steps[4].value = 123 }) })
rejects(inventory, { brief, checks: change(checks, x => { x[0].test.extra = true }) })
rejects(inventory, { brief, checks: {} })
rejects(inventory, { brief: '', checks })

const maxItems = { version: 1, requirements: Array.from({ length: MAX_WEBSITE_REQUIREMENTS }, (_, index) => ({ ...copy(control), id: `control_${index}` })) }
passes(maxItems)
rejects({ version: 1, requirements: [...maxItems.requirements, { ...copy(control), id: 'too_many' }] })
const largeExport = copy(exportedNote)
largeExport.goal.expectation = { type: 'download', value: 'history.txt', content: { format: 'text', equals: '' } }
largeExport.coverage.refs = [{ checkId: 'large', assertion: 0 }]
const boundedExport = { version: 1, requirements: [largeExport] }
const overhead = Buffer.byteLength(JSON.stringify(boundedExport), 'utf8')
largeExport.goal.expectation.content.equals = 'x'.repeat(MAX_WEBSITE_REQUIREMENT_BYTES - overhead)
const exportChecks = value => [{ id: 'large', test: { name: 'Exact export', steps: [{ action: 'click', target: { role: 'button', name: 'Export history' } }], expect: [copy(value.requirements[0].goal.expectation)] } }]
assert.equal(Buffer.byteLength(JSON.stringify(boundedExport), 'utf8'), MAX_WEBSITE_REQUIREMENT_BYTES); count++
passes(boundedExport, { brief, checks: exportChecks(boundedExport) })
const tooLarge = change(boundedExport, x => { x.requirements[0].goal.expectation.content.equals += 'x' })
rejects(tooLarge, { brief, checks: exportChecks(tooLarge) }, /byte limit/)
const unicodeTooLarge = change(boundedExport, x => { x.requirements[0].goal.expectation.content.equals = 'é'.repeat(MAX_WEBSITE_REQUIREMENT_BYTES - overhead) })
rejects(unicodeTooLarge, { brief, checks: exportChecks(unicodeTooLarge) }, /byte limit/)

// JSON data only, safe diagnostics, no mutable aliases to incoming metadata.
const cyclic = copy(inventory); cyclic.requirements[0].extra = cyclic; rejects(cyclic)
const symbol = copy(inventory); symbol[Symbol('secret')] = true; rejects(symbol)
const hidden = copy(inventory); Object.defineProperty(hidden, 'extra', { value: true }); rejects(hidden)
const sparse = copy(inventory); delete sparse.requirements[1]; rejects(sparse)
const extraArray = copy(inventory); extraArray.requirements.extra = true; rejects(extraArray)
let invoked = false
const getter = copy(inventory); Object.defineProperty(getter, 'requirements', { enumerable: true, get() { invoked = true; return [] } }); rejects(getter); assert.equal(invoked, false); count++
class ExecutableArray extends Array { map() { invoked = true; return [] } }
const inheritedMethod = copy(inventory); inheritedMethod.requirements = new ExecutableArray(...inheritedMethod.requirements); rejects(inheritedMethod); assert.equal(invoked, false); count++
const unsafeGoal = change(inventory, x => { x.requirements[1].goal.expectation.value = Infinity }); rejects(unsafeGoal)
const secret = 'PRIVATE_REQUIREMENT_VALUE'
try { parse(change(inventory, x => { x.requirements[0].quote = secret }), context); assert.fail('Expected failure') } catch (error) { assert.doesNotMatch(error.message, /PRIVATE_REQUIREMENT_VALUE/); count++ }
const callerInventory = copy(inventory), callerChecks = copy(checks)
const normalized = passes(callerInventory, { brief, checks: callerChecks })
callerInventory.requirements[2].goal.expectation.content.equals[0].note = 'changed'
callerInventory.requirements[0].coverage.refs[0].step = 0
callerChecks[1].test.expect[1].content.equals[0].id = 'changed'
assert.deepEqual(normalized, inventory); count++
assert.deepEqual(passes(JSON.parse(JSON.stringify(normalized))), inventory); count++

// The planner repeats only the assertion's identity. The adapter resolves its
// array position to the server ID and freezes the full pre-build expectation.
const compact = [
  { id: control.id, quote: control.quote, goal: copy(control.goal), refs: [{ test: 0, step: 4 }] },
  { id: displayedNote.id, quote: displayedNote.quote, goal: { kind: 'result', type: 'text', target: { selector: '#history-note' } }, refs: [{ test: 1, assertion: 0 }] },
  { id: exportedNote.id, quote: exportedNote.quote, goal: { kind: 'result', type: 'download' }, refs: [{ test: 1, assertion: 1 }] },
]
const planPass = (value = compact, input = context) => { const result = planned(value, input); count++; return result }
const planReject = (value, input = context, pattern) => { assert.throws(() => planned(value, input), pattern); count++ }
assert.deepEqual(planPass(), inventory); count++
assert.deepEqual(planPass().requirements[2].goal.expectation.content, checks[1].test.expect[1].content); count++
const reorderedPlan = change(compact, x => { x[0].refs[0].test = 1; x[1].refs[0].test = 0; x[2].refs[0].test = 0 })
assert.deepEqual(planPass(reorderedPlan, { brief, checks: [checks[1], checks[0], checks[2], checks[3]] }), inventory); count++
const namedChecks = change(checks, x => { x[1].id = 'server_assigned_other_id'; x[1].test.name = 'Different descriptive name' })
assert.equal(planPass(compact, { brief, checks: namedChecks }).requirements[1].coverage.refs[0].checkId, 'server_assigned_other_id'); count++
const compactUnverified = unverified.requirements.map(requirement => ({ id: requirement.id, quote: requirement.quote, state: requirement.coverage.state, reason: requirement.coverage.reason }))
const expandedUnverified = planPass(compactUnverified, { brief, checks: [] })
assert.equal(expandedUnverified.requirements[1].goal.kind, 'capability'); count++
assert.equal(expandedUnverified.requirements[1].goal.description, displayedNote.quote); count++
assert.deepEqual(summarize(expandedUnverified), { status: 'partial', total: 2, mapped: 0, unsupported: 1, uncovered: 1 }); count++
const compactResponsive = [{ id: 'responsive_menu', quote: responsive.requirements[0].quote, goal: copy(responsive.requirements[0].goal), refs: [{ test: 3, step: 0 }, { test: 3, step: 1 }] }]
assert.deepEqual(planPass(compactResponsive), responsive); count++
planReject(change(compactResponsive, x => { x[0].refs.pop() }))
assert.deepEqual(planPass(change(compactResponsive, x => { x[0].viewport = 'mobile'; x[0].refs.pop() })).requirements[0].viewports, ['mobile']); count++
planReject(change(compactResponsive, x => { x[0].viewport = 'desktop'; x[0].refs.pop() }))
planPass([{ id: 'menu_visible', quote: responsive.requirements[0].quote, goal: { kind: 'state', type: 'visible', target: { selector: '#navigation' } }, refs: [{ test: 3, assertion: 0 }] }])
for (const malformed of [undefined, null, {}, [], { requirements: compact }, inventory, [{ kind: 'label', literal: 'Name', behavior: 'Fill it' }]]) planReject(malformed)
for (const mutate of [
  x => { x[1].goal.value = note },
  x => { x[2].goal.content = copy(checks[1].test.expect[1].content) },
  x => { x[1].goal.target.selector = '#export-status' },
  x => { delete x[1].goal.target },
  x => { x[2].goal.target = { selector: '#export-status' } },
  x => { x[1].goal.type = 'value' },
  x => { x[1].goal.kind = 'state' },
  x => { x[0].goal.action = 'click' },
  x => { x[0].refs[0].test = -1 },
  x => { x[0].refs[0].test = 0.5 },
  x => { x[0].refs[0].test = '0' },
  x => { x[0].refs[0].test = checks.length },
  x => { x[0].refs[0].step = 0 },
  x => { x[0].refs[0].step = 100 },
  x => { x[0].refs[0].assertion = 0 },
  x => { x[0].refs[0] = { checkId: 'organization', step: 4 } },
  x => { x[1].refs[0] = { test: 1, step: 1 } },
  x => { x[1].refs[0].assertion = 1 },
  x => { x[1].refs = [] },
  x => { x[0].viewport = 'both' },
  x => { x[0].quote = 'Nonliteral evidence' },
  x => { x.push(copy(x[0])) },
]) planReject(change(compact, mutate))
planReject(compact, { brief: brief + ' ' + control.quote, checks }, /ambiguous/)
planReject(change(compactUnverified, x => { x[0].refs = [{ test: 1, assertion: 1 }] }))
planReject(change(compactUnverified, x => { x[0].goal = { kind: 'capability', description: 'Claim' } }))
planReject(change(compactUnverified, x => { x[0].state = 'mapped' }))
planReject(change(compactUnverified, x => { delete x[0].reason }))
planReject(compact, { brief, checks: change(checks, x => { delete x[1].test.expect[1].content }) })
planReject(Array.from({ length: MAX_WEBSITE_REQUIREMENTS + 1 }, (_, index) => ({ ...copy(compact[0]), id: `entry_${index}` })))
const matchingExtraCheck = { id: 'history_again', test: copy(checks[1].test) }
const twoReferences = change(compact, x => { x[1].refs.push({ test: 4, assertion: 0 }) })
planPass(twoReferences, { brief, checks: [...checks, matchingExtraCheck] })
planReject(twoReferences, { brief, checks: [...checks, change(matchingExtraCheck, x => { x.test.expect[0].value = 'Wrong note' })] })
const compactLargeExport = [{ id: exportedNote.id, quote: exportedNote.quote, goal: { kind: 'result', type: 'download' }, refs: [{ test: 0, assertion: 0 }] }]
// Compact input can fit while copying its full frozen export fixture exceeds
// the persisted limit. Reject instead of dropping or shortening that fixture.
planReject(compactLargeExport, { brief, checks: exportChecks(tooLarge) }, /byte limit/)
const plannedCaller = copy(compact), plannedChecks = copy(checks)
const plannedCopy = planPass(plannedCaller, { brief, checks: plannedChecks })
plannedChecks[1].test.expect[1].content.equals[0].note = 'changed'
plannedCaller[0].refs[0].step = 0
assert.deepEqual(plannedCopy, inventory); count++
console.log(`Website requirement inventory regressions passed: ${count} checks for compact planner expansion, exact executable references, conditional controls, results versus exports, responsive coverage, explicit unsupported/uncovered states, legacy unknown coverage, literal evidence, schema/byte limits and private-data preservation. No browser or model calls.`)
