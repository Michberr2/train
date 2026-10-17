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
  const bundle = await build({ stdin: { contents: "export * from './api/_websiteRuntime'; export * from './api/_websiteGeneration'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'synthetic-model', setup(build) {
    build.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const providerChain=()=>[{label:"primary",model:"fixture"}];export const chatComplete=(messages,options)=>globalThis.runtimeModel(messages,options);export const chatCompleteEx=async(messages,options)=>{const result=await chatComplete(messages,options);return typeof result==="string"?{content:result,finishReason:"stop"}:result}' }))
    build.onResolve({ filter: /^playwright-core$/ }, () => ({ path: 'browser', namespace: 'lifecycle' }))
    build.onLoad({ filter: /.*/, namespace: 'lifecycle' }, () => ({ contents: 'export const chromium={launch:options=>globalThis.runtimeLaunch(options)}' }))
  } }] })
  const modulePath = join(directory, 'runtime.mjs')
  await writeFile(modulePath, bundle.outputFiles[0].text)
  const { reviewWebsiteRuntime, parseRuntimeTests, reviewWebsite, generateWebsite, websiteBrowserArgs } = await import(pathToFileURL(modulePath))
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
  assert.deepEqual(parseRuntimeTests([{ name: 'execute code', steps: [{ action: 'evaluate', value: 'fetch("https://example.com")' }], expect: [] }]), [])
  const run = (source, journeys = tests, milliseconds = 22000) => reviewWebsiteRuntime(source, journeys, { deadlineMs: Date.now() + milliseconds })
  const good = await run(html)
  assert.equal(good.status, 'passed', JSON.stringify(good))
  assert.deepEqual(good.widths, [1440, 390])
  assert.equal(good.checks.filter(check => !check.passed).length, 0)
  assert.equal(good.checks.length, 12)
  assert.deepEqual(lifecycles[0], { contexts: 1, pages: 1, contextDisposals: 0, widths: [1440, 390], openPagesAtBrowserClose: 0 }, 'Both widths finish in one request-owned context/page; close pages before the browser without the hanging context boundary')
  assert.ok(good.timings.some(timing => timing.stage === 'journey' && timing.width === 390))
  assert.ok(good.timings.every(timing => timing.durationMs >= 0))

  const broken = html.replace("getElementById('calculator')", "getElementById('missing')")
  assert.deepEqual(reviewWebsite(broken).issues, [], 'reproduce the original static-validator false acceptance')
  const bad = await run(broken)
  assert.equal(bad.status, 'failed')
  assert.ok(bad.issues.some(issue => issue.code === 'runtime-script' && /null|addEventListener/.test(issue.detail)), JSON.stringify(bad))
  assert.ok(bad.checks.some(check => !check.passed && check.name === tests[0].name))

  const wrong = await run(html.replace('income*0.2', 'income*2'))
  assert.equal(wrong.status, 'failed', 'syntactically valid but wrong calculations must fail actual expected output')
  assert.ok(wrong.issues.some(issue => issue.code === 'runtime-interaction'))
  const partial = await run(html, [])
  assert.equal(partial.status, 'partial', 'generic control smoke must not masquerade as user-specific verification')

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
    { ...dependentTests[2], steps: [...setup, ...dependentTests[2].steps], expect: [{ ...dependentTests[2].expect[0], value: '0.00' }, dependentTests[2].expect[1]] },
  ])
  assert.equal(independentTests.length, 3)
  const independent = await run(expenseHtml, independentTests)
  assert.equal(independent.status, 'passed', JSON.stringify(independent))
  assert.deepEqual(independent.widths, [1440, 390])
  assert.equal(independent.checks.length, 10, 'fresh setup verifies add/invalid input, global totals through filtering, delete and CSV download')

  const security = html.replace(`<script>${script}</script>`, `<script>let parentBlocked=false;try{parent.document.body.innerHTML='escaped'}catch{parentBlocked=true}document.getElementById('result').textContent=parentBlocked&&typeof RTCPeerConnection==='undefined'&&typeof WebTransport==='undefined'?'opaque':'escaped';fetch('https://example.com/no-network').then(()=>document.getElementById('count').textContent='escaped').catch(()=>document.getElementById('count').textContent='blocked')</script>`)
  const isolated = await run(security, [{ name: 'Opaque parent and denied network', steps: [], expect: [{ type: 'text', target: { selector: '#result' }, value: 'opaque' }, { type: 'text', target: { selector: '#count' }, value: 'blocked' }] }])
  assert.equal(isolated.status, 'passed', JSON.stringify(isolated))

  let calls = []
  globalThis.runtimeModel = async (messages, options) => {
    calls.push({ messages, options })
    if (calls.length === 1) return JSON.stringify({ direction: 'Useful worksheet', pages: [{ name: 'Budget' }], runtimeTests: tests })
    if (calls.length === 2) return broken
    // Runtime interaction + script failures use a complete repair; acceptance
    // tests remain the original plan, not tests authored by the repair answer.
    assert.match(messages.at(-1).content, /runtime-script|runtime-interaction/)
    return html
  }
  const fixed = await generateWebsite({ model: 'fixture', user: 'Build a budget calculator, counter and About navigation', prompt: 'Calculate twenty percent. Reject negative amounts. Add increments a count.', deadlineMs: Date.now() + 100000 })
  assert.ok(fixed, JSON.stringify(calls))
  assert.equal(fixed.html, html)
  assert.equal(fixed.repaired, true)
  assert.equal(fixed.review.runtime.status, 'passed')
  assert.equal(calls.length, 3, 'known runtime failure triggers a bounded repair before success')
  assert.deepEqual(fixed.review.runtime.checks.filter(check => !check.passed), [])

  const correctedPlans = []
  for (const incompleteTests of [undefined, [{ ...tests[0], steps: Array(9).fill(tests[0].steps[0]) }]]) {
    calls = []
    globalThis.runtimeModel = async (messages, options) => {
      calls.push({ messages, options })
      if (calls.length === 1) return JSON.stringify({ direction: 'Useful worksheet', pages: [{ name: 'Budget' }], runtimeTests: incompleteTests })
      if (calls.length === 2) {
        assert.match(messages.at(-1).content, /runtimeTests were missing or outside/)
        assert.match(messages.at(-1).content, incompleteTests ? /runtimeTests\[0\]\.steps: expected at most 8 steps/ : /runtimeTests: expected 1-4 independent journeys/)
        assert.ok(options.timeoutMs <= 22000, 'correction uses the original bounded planning window')
        return JSON.stringify({ direction: 'Useful worksheet', pages: [{ name: 'Budget' }], runtimeTests: tests })
      }
      assert.match(messages.at(-1).content, /Income 1000|runtimeTests/)
      return html
    }
    const corrected = await generateWebsite({ model: 'fixture', user: 'Build a budget calculator, counter and About navigation', prompt: 'Calculate twenty percent. Reject negative amounts. Add increments a count.', deadlineMs: Date.now() + 100000 })
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
  assert.equal(edited.review.runtime.status, 'passed')
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
  const report = { at: new Date().toISOString(), modelCalls: 'synthetic only', lifecycle: lifecycles[0], linuxArgs, normal: good, crash: bad, incorrectCalculation: wrong, partial, capturedDependentJourneys: dependent, independentJourneys: independent, isolation: isolated, repaired: fixed.review.runtime, correctedPlans, sourcePreservingEdit: edited.review.runtime, deadline: timed, browserCancellationMs: Date.now() - cancelStart }
  if (process.env.OUTPUT_DIR) { const { mkdir } = await import('node:fs/promises'); await mkdir(process.env.OUTPUT_DIR, { recursive: true }); await writeFile(join(process.env.OUTPUT_DIR, 'studio-runtime.json'), JSON.stringify(report, null, 2)) }
  console.log('Studio runtime regressions passed: real desktop/mobile load, calculation, validation, counter, navigation, null-DOM repair, frozen assertions, faithful edit, opaque parent/network isolation and infinite-script deadline.')
} finally {
  delete globalThis.runtimeModel
  delete globalThis.runtimeLaunch
  await rm(directory, { recursive: true, force: true })
}
