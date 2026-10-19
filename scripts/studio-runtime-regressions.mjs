// Real Chromium + real generation/repair code; model responses are deterministic
// fixtures. No provider/account calls, external navigation or saved user data.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import serverlessChromium from '@sparticuz/chromium'

const directory = await mkdtemp(join(process.cwd(), 'scripts/.runtime-regression-'))
const lifecycles = []
globalThis.runtimeLaunch = async options => {
  const browser = await chromium.launch(options)
  const lifecycle = { contexts: 0, pages: 0, contextDisposals: 0, widths: [], openPagesAtBrowserClose: null }
  lifecycles.push(lifecycle)
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async options => {
    lifecycle.contexts++
    const context = await newContext(options)
    const newPage = context.newPage.bind(context)
    context.newPage = async () => {
      lifecycle.pages++
      const page = await newPage()
      const resize = page.setViewportSize.bind(page)
      page.setViewportSize = size => { lifecycle.widths.push(size.width); return resize(size) }
      return page
    }
    // Reproduce the documented serverless context-disposal hang while still
    // executing every page/interaction in real Chromium. The pre-fix runner
    // finishes desktop then stalls here until its 22s watchdog expires.
    context.close = () => { lifecycle.contextDisposals++; return new Promise(() => {}) }
    return context
  }
  const close = browser.close.bind(browser)
  browser.close = () => {
    lifecycle.openPagesAtBrowserClose = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed()).length
    return close()
  }
  return browser
}
try {
  const bundle = await build({ stdin: { contents: "export * from './api/_websiteRuntime'; export * from './api/_websiteGeneration'; export * from './api/_websiteRequirements'; export * from './api/_websiteRequirementReview'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'synthetic-model', setup(build) {
    build.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const providerChain=()=>[{label:"primary",model:"fixture"}];export const chatComplete=(messages,options)=>globalThis.runtimeModel(messages,options);export const chatCompleteEx=async(messages,options)=>{const result=await chatComplete(messages,options);return typeof result==="string"?{content:result,finishReason:"stop"}:result}' }))
    build.onResolve({ filter: /^playwright-core$/ }, () => ({ path: 'browser', namespace: 'lifecycle' }))
    build.onLoad({ filter: /.*/, namespace: 'lifecycle' }, () => ({ contents: 'export const chromium={launch:options=>globalThis.runtimeLaunch(options)}' }))
  } }] })
  const modulePath = join(directory, 'runtime.mjs')
  await writeFile(modulePath, bundle.outputFiles[0].text)
  const { reviewWebsiteRuntime, parseRuntimeTests, reviewWebsite, generateWebsite, websiteBrowserArgs, parsePlannedWebsiteRequirements, reviewWebsiteRequirements } = await import(pathToFileURL(modulePath))
  const linuxArgs = websiteBrowserArgs(serverlessChromium.args)
  for (const unsafe of ['--disable-web-security', '--disable-site-isolation-trials', '--allow-running-insecure-content']) assert.ok(!linuxArgs.includes(unsafe), `Untrusted renderer must not use ${unsafe}`)
  const disabledFeatures = linuxArgs.filter(arg => arg.startsWith('--disable-features=')).flatMap(arg => arg.slice('--disable-features='.length).split(','))
  assert.ok(!disabledFeatures.includes('IsolateOrigins'))
  assert.ok(!disabledFeatures.includes('site-per-process'))
  for (const required of ['--single-process', '--no-zygote', '--no-sandbox']) assert.ok(linuxArgs.includes(required), `Keep documented Lambda flag ${required}`)
  const script = `document.getElementById('calculator').addEventListener('submit',e=>{e.preventDefault();const income=Number(document.getElementById('income').value);document.getElementById('result').textContent=income<0?'Use a positive amount':String(income*0.2)});let n=0;document.getElementById('add').onclick=()=>document.getElementById('count').textContent=String(++n);document.getElementById('menu').onclick=()=>document.querySelector('nav').classList.toggle('open');`
  const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Budget</title><style>body{font:16px sans-serif;margin:16px}input,button{max-width:100%;padding:12px}main{max-width:800px}@media(min-width:600px){#menu{display:none}}@media(max-width:599px){nav:not(.open){display:none}}</style></head><body><main><h1>Budget worksheet</h1><form id="calculator"><label for="income">Income</label><input id="income" type="number"><button>Calculate</button><output id="result" aria-label="Result">0</output></form><button id="add">Add</button><output id="count" aria-label="Count">0</output><button id="menu">Menu</button><nav><a href="#about">About</a></nav><section id="about"><h2>How it works</h2><p>Calculate twenty percent of the income.</p></section></main><script>${script}</script></body></html>`
  const tests = parseRuntimeTests([
    { name: 'Income 1000 computes 200', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: '200' }] },
    { name: 'Negative income is rejected', steps: [{ action: 'fill', target: { label: 'Income' }, value: '-20' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: 'Use a positive amount' }] },
    { name: 'Add increments the count', steps: [{ action: 'click', target: { role: 'button', name: 'Add' } }], expect: [{ type: 'text', target: { selector: '#count' }, value: '1' }] },
    { name: 'About navigates to its section', steps: [{ action: 'click', target: { role: 'button', name: 'Menu' }, viewport: 'mobile' }, { action: 'click', target: { role: 'link', name: 'About' } }], expect: [{ type: 'hash', value: '#about' }, { type: 'visible', target: { role: 'heading', name: 'How it works' } }] },
  ])
  assert.equal(tests.length, 4)
  const productPrompt = 'Income accepts an amount. Calculate twenty percent. Reject negative amounts. Add increments a count. About navigates to its section. Menu opens navigation on mobile.'
  const requirements = [
    { id: 'income', quote: 'Income accepts an amount.', goal: { kind: 'control', action: 'fill', target: { label: 'Income' } }, refs: [{ test: 0, step: 0 }] },
    { id: 'calculation', quote: 'Calculate twenty percent.', goal: { kind: 'result', type: 'text', target: { selector: '#result' } }, refs: [{ test: 0, assertion: 0 }] },
    { id: 'validation', quote: 'Reject negative amounts.', goal: { kind: 'result', type: 'text', target: { selector: '#result' } }, refs: [{ test: 1, assertion: 0 }] },
    { id: 'counter', quote: 'Add increments a count.', goal: { kind: 'result', type: 'text', target: { selector: '#count' } }, refs: [{ test: 2, assertion: 0 }] },
    { id: 'navigation', quote: 'About navigates to its section.', goal: { kind: 'result', type: 'hash' }, refs: [{ test: 3, assertion: 0 }] },
    { id: 'mobile_menu', quote: 'Menu opens navigation on mobile.', goal: { kind: 'control', action: 'click', target: { role: 'button', name: 'Menu' } }, refs: [{ test: 3, step: 0 }], viewport: 'mobile' },
  ]
  const freshPlan = { direction: 'Useful worksheet', pages: [{ name: 'Budget' }], runtimeTests: tests, requirements }
  const fixtureChecks = tests.map((test, index) => ({ id: `fixture_${index}`, test }))
  const fixtureContract = { checks: fixtureChecks, inventory: parsePlannedWebsiteRequirements(requirements, { brief: productPrompt, checks: fixtureChecks }) }
  const evidence = (report, journeyIndex, width) => {
    const matching = report.checks.filter(check => check.journeyIndex === journeyIndex && check.width === width)
    assert.equal(matching.length, 1, 'Each executed journey has exactly one indexed evidence record per viewport')
    return matching[0]
  }
  assert.deepEqual(parseRuntimeTests([{ name: 'execute code', steps: [{ action: 'evaluate', value: 'fetch("https://example.com")' }], expect: [] }]), [])
  assert.deepEqual(parseRuntimeTests([{...tests[0],expect:[tests[0].expect[0],{...tests[0].expect[0],value:'250'}]}]),[],'Conflicting post-action values are rejected before any browser verification')
  assert.equal(parseRuntimeTests([{...tests[0],expect:[tests[0].expect[0],{...tests[0].expect[0],value:' 200\n'}]}]).length,1,'Text normalization does not invent a conflict')
  const run = (source, journeys = tests, milliseconds = 22000) => reviewWebsiteRuntime(source, journeys, { deadlineMs: Date.now() + milliseconds })
  const good = await run(html)
  assert.equal(good.status, 'passed', JSON.stringify(good))
  assert.deepEqual(good.widths, [1440, 390])
  assert.equal(good.checks.filter(check => !check.passed).length, 0)
  assert.equal(good.checks.length, 12)
  assert.deepEqual(lifecycles[0], { contexts: 1, pages: 1, contextDisposals: 0, widths: [1440, 390], openPagesAtBrowserClose: 0 }, 'Both widths finish in one request-owned context/page; close pages before the browser without the hanging context boundary')
  assert.ok(good.timings.some(timing => timing.stage === 'journey' && timing.width === 390))
  assert.ok(good.timings.every(timing => timing.durationMs >= 0))
  for (const width of [1440, 390]) {
    assert.deepEqual(evidence(good, 0, width).executedSteps, [0, 1])
    assert.deepEqual(evidence(good, 0, width).passedAssertions, [0])
    assert.deepEqual(evidence(good, 3, width).executedSteps, width === 1440 ? [1] : [0, 1], 'Desktop navigation must not claim the skipped mobile Menu action')
    assert.deepEqual(evidence(good, 3, width).passedAssertions, [0, 1])
  }
  const verifiedRequirements = reviewWebsiteRequirements(fixtureContract, good)
  assert.equal(verifiedRequirements.status, 'checked')
  assert.equal(verifiedRequirements.scope, 'declared-inventory')
  assert.equal(verifiedRequirements.verified, requirements.length)
  assert.deepEqual(verifiedRequirements.items.find(item => item.id === 'mobile_menu').verifiedViewports, ['mobile'])

  const broken = html.replace("getElementById('calculator')", "getElementById('missing')")
  assert.deepEqual(reviewWebsite(broken).issues, [], 'reproduce the original static-validator false acceptance')
  const bad = await run(broken)
  assert.equal(bad.status, 'failed')
  assert.ok(bad.issues.some(issue => issue.code === 'runtime-script' && /null|addEventListener/.test(issue.detail)), JSON.stringify(bad))
  assert.ok(bad.checks.some(check => !check.passed && check.name === tests[0].name))

  const wrong = await run(html.replace('income*0.2', 'income*2'))
  assert.equal(wrong.status, 'failed', 'syntactically valid but wrong calculations must fail actual expected output')
  assert.ok(wrong.issues.some(issue => issue.code === 'runtime-interaction'))
  for (const width of [1440, 390]) {
    assert.deepEqual(evidence(wrong, 0, width).executedSteps, [0, 1], 'Failed calculations retain the actions that actually completed')
    assert.deepEqual(evidence(wrong, 0, width).passedAssertions, [], 'Incorrect results must not be recorded as passing assertions')
  }
  const failedRequirements = reviewWebsiteRequirements(fixtureContract, wrong)
  assert.equal(failedRequirements.status, 'partial')
  for (const id of ['income', 'calculation']) {
    const item = failedRequirements.items.find(item => item.id === id)
    assert.equal(item.status, 'unverified', 'A completed field action cannot verify a requirement when its containing journey fails')
    assert.deepEqual(item.verifiedViewports, [])
  }

  const partiallyPassingTest = { ...tests[0], expect: [...tests[0].expect, { type: 'text', target: { selector: '#count' }, value: '1' }] }
  const partiallyPassingJourney = await run(html, [partiallyPassingTest])
  assert.equal(partiallyPassingJourney.status, 'failed')
  for (const width of [1440, 390]) {
    assert.deepEqual(evidence(partiallyPassingJourney, 0, width).executedSteps, [0, 1])
    assert.deepEqual(evidence(partiallyPassingJourney, 0, width).passedAssertions, [0], 'Retain the first passing assertion when a later assertion fails')
  }
  const partiallyPassingChecks = [{ id: 'partial_fixture', test: partiallyPassingTest }]
  const partiallyPassingContract = { checks: partiallyPassingChecks, inventory: parsePlannedWebsiteRequirements([requirements[1]], { brief: productPrompt, checks: partiallyPassingChecks }) }
  const partiallyPassingRequirements = reviewWebsiteRequirements(partiallyPassingContract, partiallyPassingJourney)
  assert.equal(partiallyPassingRequirements.verified, 0, 'A passing assertion within an ultimately failed journey is not verified requirement evidence')
  assert.equal(partiallyPassingRequirements.items[0].status, 'unverified')

  const hiddenResult = await run(html.replace('<output id="result"', '<output hidden id="result"'), [tests[0], { name: 'An explicitly hidden result is hidden', steps: tests[0].steps, expect: [{ type: 'hidden', target: { selector: '#result' } }] }])
  assert.equal(hiddenResult.status, 'failed', 'Correct text in a hidden output cannot satisfy a visible text result')
  assert.ok(hiddenResult.issues.every(issue => /not visible/.test(issue.detail)), 'Repair feedback distinguishes a hidden correct result from an incorrect calculation')
  for (const width of [1440, 390]) {
    assert.equal(evidence(hiddenResult, 0, width).passed, false)
    assert.deepEqual(evidence(hiddenResult, 0, width).executedSteps, [0, 1])
    assert.deepEqual(evidence(hiddenResult, 0, width).passedAssertions, [])
    assert.equal(evidence(hiddenResult, 1, width).passed, true, 'Explicit hidden-state assertions retain their intended meaning')
    assert.deepEqual(evidence(hiddenResult, 1, width).passedAssertions, [0])
  }
  const historyHtml=html.replace('</main>','<section id="history"><span id="history-id">M1</span> <span id="history-details">C10 North→South qty 2 Move cable [undone]</span></section></main>')
  const historyTest={name:'Transfer ID remains visible with its neighboring fields',steps:tests[0].steps,expect:[{type:'text',target:{selector:'#history'},value:'M1'}]}
  const historyScope=await run(historyHtml,[historyTest])
  assert.equal(historyScope.status,'failed','A scalar expectation does not pass against a larger composite result')
  assert.ok(historyScope.issues.every(issue=>issue.detail.includes('Possible container-versus-field target scope mismatch')&&issue.detail.includes('Preserve requested neighboring fields')))
  const scopedHistory=await run(historyHtml,[{...historyTest,expect:[{type:'text',target:{selector:'#history-id'},value:'M1'},{type:'text',target:{selector:'#history-details'},value:'C10 North→South qty 2 Move cable [undone]'}]}])
  assert.equal(scopedHistory.status,'passed','Separately scoped exact fields retain all history details without weakening assertions or deleting visible content')
  for(const width of [1440,390])assert.deepEqual(evidence(scopedHistory,0,width).passedAssertions,[0,1])
  const partial = await run(html, [])
  assert.equal(partial.status, 'partial', 'generic control smoke must not masquerade as user-specific verification')

  const contentOnly = [{ name: 'Heading is present', steps: [], expect: [{ type: 'text', target: { role: 'heading', name: 'Budget worksheet' }, value: 'Budget worksheet' }] }]
  const unexercised = await run(html, contentOnly)
  assert.equal(unexercised.status, 'partial', 'a heading assertion cannot verify an interactive calculator')
  assert.ok(unexercised.checks.every(check => check.passed), 'passing content assertions remain recorded accurately')
  assert.match(unexercised.limitations.join('\n'), /interactive controls.*1440.*390.*no interaction steps/i)
  const desktopOnly = [{ name: 'Desktop menu toggles', steps: [{ action: 'click', target: { role: 'button', name: 'Add' }, viewport: 'desktop' }], expect: [{ type: 'visible', target: { role: 'heading', name: 'Budget worksheet' } }] }]
  const uncoveredMobile = await run(html, desktopOnly)
  assert.equal(uncoveredMobile.status, 'partial', 'desktop actions must not count as mobile interaction coverage')
  assert.ok(uncoveredMobile.limitations.some(limit => /interactive controls.*390.*no interaction steps/i.test(limit) && !limit.includes('1440')))
  assert.deepEqual(evidence(uncoveredMobile, 0, 1440).executedSteps, [0])
  assert.deepEqual(evidence(uncoveredMobile, 0, 390).executedSteps, [], 'The mobile evidence records no action when the desktop-only step is skipped')
  assert.deepEqual(evidence(uncoveredMobile, 0, 390).passedAssertions, [0], 'Passing a heading assertion remains distinct from exercising the mobile control')
  const staticHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>Budget worksheet</h1><p>A short explanation without interactive controls.</p></main></body></html>'
  const staticReview = await run(staticHtml, contentOnly)
  assert.equal(staticReview.status, 'passed', 'content assertions are sufficient for a static page without interactions')

  // Actual captured planner journeys assumed state survived between tests.
  // Correcting only select syntax must not make those false expectations pass.
  const captured = JSON.parse(await readFile(new URL('./fixtures/studio-planner-output.json', import.meta.url), 'utf8'))
  const dependentTests = JSON.parse(captured.invalidSelectPlan).runtimeTests
  for (const test of dependentTests) for (const step of test.steps) if (step.action === 'select') { step.value = step.optionValue; delete step.optionValue }
  assert.equal(parseRuntimeTests(dependentTests).length, 3)
  const expenseHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{font:16px sans-serif;margin:12px}input,select,button{display:block;max-width:100%;margin:8px 0}li{overflow-wrap:anywhere}</style></head><body><main><h1>Expense fixture</h1><form><label>Description<input id="description" required></label><label>Amount<input id="amount" type="number" min="0.01" step="0.01" required></label><label for="category">Category</label><select id="category"><option>Food</option><option>Transport</option><option>Other</option></select><button>Add expense</button></form><label for="filter">Filter category</label><select id="filter"><option>All</option><option>Food</option><option>Transport</option><option>Other</option></select><output aria-label="Total spent">0.00</output><ul></ul><button id="export">Export CSV</button></main><script>
const rows=[];const field=id=>document.getElementById(id);function render(){const list=document.querySelector('ul');list.replaceChildren();document.querySelector('output').textContent=(rows.reduce((sum,row)=>sum+row.cents,0)/100).toFixed(2);for(const row of rows){if(field('filter').value!=='All'&&field('filter').value!==row.category)continue;const item=document.createElement('li');item.append(row.description);const remove=document.createElement('button');remove.textContent='Delete';remove.onclick=()=>{rows.splice(rows.indexOf(row),1);render()};item.append(remove);list.append(item)}}document.querySelector('form').onsubmit=event=>{event.preventDefault();const description=field('description').value.trim(),amount=Number(field('amount').value);if(!description||!Number.isFinite(amount)||amount<=0)return;rows.push({description,cents:Math.round(amount*100),category:field('category').value});event.target.reset();render()};field('filter').onchange=render;field('export').onclick=()=>{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['description,amount,category\\n'+rows.map(row=>[row.description,(row.cents/100).toFixed(2),row.category].map(value=>'"'+value.replaceAll('"','""')+'"').join(',')).join('\\n')],{type:'text/csv'}));link.download='pocket-ledger.csv';link.click()};
</script></body></html>`
  assert.deepEqual(reviewWebsite(expenseHtml).issues, [])
  const dependent = await run(expenseHtml, dependentTests)
  assert.equal(dependent.status, 'failed', 'a valid app cannot satisfy plans that invent carry-over state')
  assert.deepEqual(dependent.widths, [1440, 390])
  assert.equal(dependent.checks.filter(check => !check.passed).length, 4, 'filter/delete dependencies fail at both widths: ' + JSON.stringify(dependent))
  assert.ok(dependent.checks.some(check => !check.passed && check.detail?.includes('8.00') && check.detail?.includes('3.00')))
  const setup = dependentTests[0].steps
  const independentTests = parseRuntimeTests([
    { ...dependentTests[0], steps: [...setup, { action: 'fill', target: { label: 'Description' }, value: 'Invalid zero amount' }, { action: 'fill', target: { label: 'Amount' }, value: '0' }, { action: 'click', target: { role: 'button', name: 'Add expense' } }] },
    { ...dependentTests[1], steps: [...setup.filter(step => step.action !== 'select'), ...dependentTests[1].steps.slice(1), dependentTests[1].steps[0]], expect: [...dependentTests[1].expect, { type: 'count', target: { selector: 'li' }, value: 1 }] },
    { ...dependentTests[2], steps: [...setup, ...dependentTests[2].steps], expect: [{ ...dependentTests[2].expect[0], value: '0.00' }, { ...dependentTests[2].expect[1], content: { format: 'csv', equals: [['description', 'amount', 'category']] } }] },
  ])
  assert.equal(independentTests.length, 3)
  const independent = await run(expenseHtml, independentTests)
  assert.equal(independent.status, 'passed', JSON.stringify(independent))
  assert.deepEqual(independent.widths, [1440, 390])
  assert.equal(independent.checks.length, 10, 'fresh setup verifies add/invalid input, global totals through filtering, delete and CSV download')

  // Real-browser export checks: the filename alone did not catch corrupt rows.
  // Keep a populated record hidden by the filter to verify export-all behavior.
  const exportTest = {
    name: 'CSV keeps quoted data and records hidden by the active filter',
    steps: [
      { action: 'fill', target: { label: 'Description' }, value: 'Coffee, "large"' },
      { action: 'fill', target: { label: 'Amount' }, value: '5' },
      { action: 'click', target: { role: 'button', name: 'Add expense' } },
      { action: 'select', target: { label: 'Filter category' }, value: 'Transport' },
      { action: 'click', target: { role: 'button', name: 'Export CSV' } },
    ],
    expect: [{ type: 'download', value: 'pocket-ledger.csv', content: { format: 'csv', equals: [['description', 'amount', 'category'], ['Coffee, "large"', '5.00', 'Food']] } }],
  }
  assert.equal(parseRuntimeTests([exportTest]).length, 1)
  const exported = await run(expenseHtml, [exportTest])
  assert.equal(exported.status, 'passed', JSON.stringify(exported))
  const corruptExport = await run(expenseHtml.replace('(row.cents/100).toFixed(2)', "'50.00'"), [exportTest])
  assert.equal(corruptExport.status, 'failed', 'A correct filename with an incorrect exported amount fails at both widths')
  assert.equal(corruptExport.checks.filter(check => !check.passed).length, 2)
  const legacyExport = await run(expenseHtml, [{ ...exportTest, expect: [{ type: 'download', value: 'pocket-ledger.csv' }] }])
  assert.equal(legacyExport.status, 'partial', 'Old filename-only plans remain compatible but cannot prove export contents')

  const security = html.replace(`<script>${script}</script>`, `<script>let parentBlocked=false;try{parent.document.body.innerHTML='escaped'}catch{parentBlocked=true}document.getElementById('result').textContent=parentBlocked&&typeof RTCPeerConnection==='undefined'&&typeof WebTransport==='undefined'?'opaque':'escaped';fetch('https://example.com/no-network').then(()=>document.getElementById('count').textContent='escaped').catch(()=>document.getElementById('count').textContent='blocked')</script>`)
  const isolated = await run(security, [{ name: 'Opaque parent and denied network', steps: [], expect: [{ type: 'text', target: { selector: '#result' }, value: 'opaque' }, { type: 'text', target: { selector: '#count' }, value: 'blocked' }] }])
  assert.equal(isolated.status, 'partial', 'Passing isolation probes do not exercise the fixture\'s remaining interactive controls')
  assert.ok(isolated.checks.every(check => check.passed), JSON.stringify(isolated))
  for (const width of [1440, 390]) assert.deepEqual(evidence(isolated, 0, width).passedAssertions, [0, 1], 'Both opaque-parent and denied-network assertions must actually pass')

  let calls = []
  globalThis.runtimeModel = async (messages, options) => {
    calls.push({ messages, options })
    if (calls.length === 1) return JSON.stringify(freshPlan)
    if (calls.length === 2) return broken
    // Runtime interaction + script failures use a complete repair; acceptance
    // tests remain the original plan, not tests authored by the repair answer.
    assert.match(messages.at(-1).content, /runtime-script|runtime-interaction/)
    return html
  }
  const fixed = await generateWebsite({ model: 'fixture', user: 'Build a budget calculator, counter and About navigation', prompt: productPrompt, deadlineMs: Date.now() + 100000 })
  assert.ok(fixed, JSON.stringify(calls))
  assert.equal(fixed.html, html)
  assert.equal(fixed.repaired, true)
  assert.equal(fixed.review.runtime.status, 'passed')
  assert.equal(fixed.behaviorContract.version, 2)
  assert.equal(fixed.review.runtime.requirements.status, 'checked')
  assert.equal(fixed.review.runtime.requirements.verified, requirements.length)
  assert.equal(calls.length, 3, 'known runtime failure triggers a bounded repair before success')
  assert.deepEqual(fixed.review.runtime.checks.filter(check => !check.passed), [])

  const correctedPlans = []
  for (const incompleteTests of [undefined, [{ ...tests[0], steps: Array(9).fill(tests[0].steps[0]) }]]) {
    calls = []
    globalThis.runtimeModel = async (messages, options) => {
      calls.push({ messages, options })
      if (calls.length === 1) return JSON.stringify({ ...freshPlan, runtimeTests: incompleteTests })
      if (calls.length === 2) {
        assert.match(messages.at(-1).content, /runtimeTests or requirements were missing or outside/)
        assert.match(messages.at(-1).content, incompleteTests ? /runtimeTests\[0\]\.steps: expected at most 8 steps/ : /runtimeTests: expected 1-4 independent journeys/)
        assert.ok(options.timeoutMs <= 22000, 'correction uses the original bounded planning window')
        return JSON.stringify(freshPlan)
      }
      assert.match(messages.at(-1).content, /Income 1000|runtimeTests/)
      return html
    }
    const corrected = await generateWebsite({ model: 'fixture', user: 'Build a budget calculator, counter and About navigation', prompt: productPrompt, deadlineMs: Date.now() + 100000 })
    assert.equal(calls.length, 3, 'single-provider missing/malformed plans get one correction, then one build')
    assert.equal(corrected.review.runtime.status, 'passed', JSON.stringify(corrected.review.runtime))
    assert.equal(corrected.review.runtime.checks.length, 12)
    assert.deepEqual(corrected.review.runtime.planning.attempts.map(attempt => attempt.result), ['invalid-journeys', 'valid'])
    correctedPlans.push({ initial: incompleteTests ? 'malformed' : 'missing', runtime: corrected.review.runtime })
  }

  calls = []
  globalThis.runtimeModel = async (messages, options) => { calls.push({ messages, options }); return JSON.stringify({ edits: [{ search: '<h1>Budget worksheet</h1>', replace: '<h1>Family budget</h1>' }], runtimeTests: tests }) }
  const edited = await generateWebsite({ model: 'fixture', user: 'Rename the heading to Family budget', prompt: 'Rename the heading to Family budget', previous: html, deadlineMs: Date.now() + 100000 })
  assert.equal(edited.html, html.replace('<h1>Budget worksheet</h1>', '<h1>Family budget</h1>'))
  assert.equal(edited.review.runtime.status, 'partial', 'A legacy edit can pass its checks while requested-feature inventory coverage remains unknown')
  assert.equal(edited.review.runtime.requirements.status, 'unknown')
  assert.equal(edited.review.runtime.requirements.inventory.status, 'unknown')
  assert.ok(edited.review.runtime.checks.every(check => check.passed), 'Legacy compatibility keeps successful original interactions without inventing inventory coverage')
  assert.equal(calls.length, 1, 'runtime verification preserves atomic source edits and existing interactions')

  const lowBudget = await run(html, tests, 100)
  assert.equal(lowBudget.status, 'unavailable')
  const looping = html.replace(`<script>${script}</script>`, '<script>while(true){}</script>')
  const start = Date.now()
  const timed = await run(looping, [], 3000)
  assert.equal(timed.status, 'unavailable')
  assert.ok(Date.now() - start < 6000, 'infinite generated JS must not hang the server beyond its verification budget')
  const controller = new AbortController()
  const cancelTimer = setTimeout(() => controller.abort(), 200)
  const cancelStart = Date.now()
  await assert.rejects(reviewWebsiteRuntime(looping, [], { deadlineMs: Date.now() + 22000, signal: controller.signal }), error => error.name === 'AbortError')
  clearTimeout(cancelTimer)
  assert.ok(Date.now() - cancelStart < 2000, 'caller cancellation must interrupt browser checks without waiting for the runtime deadline')
  const report = { at: new Date().toISOString(), modelCalls: 'synthetic only', lifecycle: lifecycles[0], linuxArgs, normal: good, verifiedRequirements, crash: bad, incorrectCalculation: wrong, failedRequirements, partiallyPassingJourney, partiallyPassingRequirements, hiddenResult, historyScope, scopedHistory, partial, unexercised, uncoveredMobile, staticReview, capturedDependentJourneys: dependent, independentJourneys: independent, isolation: isolated, repaired: fixed.review.runtime, correctedPlans, sourcePreservingEdit: edited.review.runtime, deadline: timed, browserCancellationMs: Date.now() - cancelStart }
  if (process.env.OUTPUT_DIR) { const { mkdir } = await import('node:fs/promises'); await mkdir(process.env.OUTPUT_DIR, { recursive: true }); await writeFile(join(process.env.OUTPUT_DIR, 'studio-runtime.json'), JSON.stringify(report, null, 2)) }
  console.log('Studio runtime regressions passed: real desktop/mobile load, calculation, validation, counter, navigation, indexed execution evidence, hidden result rejection, requirement verification, null-DOM repair, frozen assertions, faithful legacy edit with unknown coverage, opaque parent/network isolation and infinite-script deadline.')
} finally {
  delete globalThis.runtimeModel
  delete globalThis.runtimeLaunch
  await rm(directory, { recursive: true, force: true })
}
