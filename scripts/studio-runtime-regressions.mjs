// Real Chromium + real generation/repair code; model responses are deterministic
// fixtures. No provider/account calls, external navigation or saved user data.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const directory = await mkdtemp(join(process.cwd(), 'scripts/.runtime-regression-'))
try {
  const bundle = await build({ stdin: { contents: "export * from './api/_websiteRuntime'; export * from './api/_websiteGeneration'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'synthetic-model', setup(build) {
    build.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const providerChain=()=>[{label:"primary",model:"fixture"}];export const chatComplete=(messages,options)=>globalThis.runtimeModel(messages,options)' }))
  } }] })
  const modulePath = join(directory, 'runtime.mjs')
  await writeFile(modulePath, bundle.outputFiles[0].text)
  const { reviewWebsiteRuntime, parseRuntimeTests, reviewWebsite, generateWebsite } = await import(pathToFileURL(modulePath))
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
  const report = { at: new Date().toISOString(), modelCalls: 'synthetic only', normal: good, crash: bad, incorrectCalculation: wrong, partial, isolation: isolated, repaired: fixed.review.runtime, sourcePreservingEdit: edited.review.runtime, deadline: timed, browserCancellationMs: Date.now() - cancelStart }
  if (process.env.OUTPUT_DIR) { const { mkdir } = await import('node:fs/promises'); await mkdir(process.env.OUTPUT_DIR, { recursive: true }); await writeFile(join(process.env.OUTPUT_DIR, 'studio-runtime.json'), JSON.stringify(report, null, 2)) }
  console.log('Studio runtime regressions passed: real desktop/mobile load, calculation, validation, counter, navigation, null-DOM repair, frozen assertions, faithful edit, opaque parent/network isolation and infinite-script deadline.')
} finally {
  delete globalThis.runtimeModel
  await rm(directory, { recursive: true, force: true })
}
