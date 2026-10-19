import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
const temp = await mkdtemp(join(process.cwd(), 'scripts/.website-check-'))
const originalNow = Date.now
try {
  const bundle = await build({ entryPoints: ['api/_websiteGeneration.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'fixture-provider', setup(b) {
    b.onResolve({ filter: /^\.\/_websiteRuntime$/ }, () => ({ path: 'runtime', namespace: 'runtime-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'runtime-fixture' }, () => ({ resolveDir: process.cwd(), contents: `export {WEBSITE_RUNTIME_JOURNEY_SCHEMA,WEBSITE_RUNTIME_TEST_SCHEMA,parseRuntimeTests,inspectRuntimeTests} from '${process.cwd()}/api/_websiteRuntime.ts';export const reviewWebsiteRuntime=async(...args)=>{globalThis.websiteFixture.runtimeCalls?.push(args);if(globalThis.websiteFixture.runtime)return globalThis.websiteFixture.runtime(...args);return {status:'passed',widths:[1440,390],checks:[1440,390].flatMap(width=>args[1].map((test,journeyIndex)=>({name:test.name,width,passed:true,journeyIndex,executedSteps:test.steps.flatMap((step,index)=>!step.viewport||step.viewport===(width<600?'mobile':'desktop')?[index]:[]),passedAssertions:test.expect.map((_,index)=>index)}))),issues:[],limitations:['Mocked in parser/provider unit tests; real browser covered by studio-runtime-regressions.mjs']}}` }))
    b.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const providerChain=model=>[{label:'primary',model,base:'https://provider.test'},{label:'fallback',model:'fallback',base:'https://fallback.test'}];export async function chatComplete(messages,options){return globalThis.websiteFixture.complete(messages,options)};export async function chatCompleteEx(messages,options){const result=await chatComplete(messages,options);return typeof result==='string'?{content:result,finishReason:'stop'}:result}` }))
  } }] })
  const path = join(temp, 'website.mjs'); await writeFile(path, bundle.outputFiles[0].text)
  const { reviewWebsite, generateWebsite, extractWebsitePlanJson } = await import(pathToFileURL(path))
  const valid = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Budget</title></head><body><main><h1>Plan your budget</h1><form><label for="income">Income</label><input id="income" type="number"><button type="submit">Calculate</button><output id="result"></output></form><a href="#income">Edit income</a></main><script>document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('output').textContent=Number(document.querySelector('input').value)*0.2})</script></body></html>`
  assert.deepEqual(reviewWebsite(valid).issues, [])
  assert.ok(reviewWebsite(valid.replace('</script>', `;const state={incomes:[],expenses:[]};function add(type){state[type].push(1)};add('expense');</script>`)).issues.some(issue => issue.code === 'state-key'))
  assert.ok(reviewWebsite(valid.replace('</script>', `;history.pushState(null,'','#home');</script>`)).issues.some(issue => issue.code === 'sandbox-history'))
  assert.ok(reviewWebsite(valid.replace('</head>', '<style>.nav-toggle{display:none;display:flex}</style></head>')).issues.some(i => i.code === 'navigation-display'))
  assert.deepEqual(reviewWebsite(valid.replace('<label for="income">Income</label><input id="income" type="number">', '<label>Income<input id="income" type="number"></label>')).issues, [])
  assert.ok(reviewWebsite(valid.replace('*0.2', '*')).issues.some(i => i.code === 'script-syntax' && i.severity === 'error'))
  assert.ok(reviewWebsite(valid.replace('#income', '#missing')).issues.some(i => i.code === 'missing-target'))
  assert.ok(reviewWebsite(valid.replace('href="#income"', 'href="#"')).issues.some(i => i.code === 'empty-link'))
  assert.ok(reviewWebsite(valid.replace('</html>', '')).issues.some(i => i.code === 'incomplete'))
  assert.ok(reviewWebsite(valid.replace('<label for="income">Income</label>', '')).issues.some(i => i.code === 'input-label'))
  const runtimeTests = [{ name: 'Calculate budget', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: '200' }] }]
  const planFor = (brief, journeys = runtimeTests) => JSON.stringify({ direction: 'Useful worksheet', pages: [{ name: 'Budget' }], runtimeTests: journeys, requirements: journeys.map((test, index) => ({ id: `result_${index}`, quote: brief, goal: { kind: ['visible','hidden'].includes(test.expect[0].type) ? 'state' : 'result', type: test.expect[0].type, ...(test.expect[0].target ? { target: test.expect[0].target } : {}) }, refs: [{ test: index, assertion: 0 }] })) })
  const fixtures = [planFor('Build a budget calculator'), valid.replace('*0.2', '*'), valid.match(/<script>([\s\S]*)<\/script>/)[1]]
  let time = 0; const calls = []
  Date.now = () => time
  globalThis.websiteFixture = { complete: async (messages, options) => { calls.push({ messages, options, at: time }); time += 2000; return fixtures.shift() || '' } }
  const result = await generateWebsite({ model: 'fixture', prompt: 'Build a budget calculator', user: 'Build a budget calculator', deadlineMs: 275000 })
  assert.equal(result.html, valid)
  assert.equal(result.repaired, true)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].options.reasoningEffort, 'medium')
  assert.equal(calls[1].options.reasoningEffort, 'high')
  assert.equal(calls[2].options.reasoningEffort, 'high')
  assert.match(calls[2].messages.at(-1).content, /script-syntax/)
  assert.match(calls[2].messages[0].content,/ONLY complete executable JavaScript/)
  assert.equal(result.review.issues.length, 0)
  assert.ok(calls.every(c => c.options.maxAttempts === 1 && c.options.timeoutMs <= 275000 - c.at))
  time = 0; calls.length = 0
  globalThis.websiteFixture.complete = async (messages, options) => { calls.push({ messages, options }); time += options.timeoutMs; throw new Error('timeout') }
  assert.equal(await generateWebsite({ model: 'fixture', prompt: 'A site', user: 'A site', deadlineMs: 75000 }), null)
  assert.ok(time <= 75000, `request exceeded budget: ${time}`)
  time = 0; calls.length = 0
  const patch = (search, replace) => JSON.stringify({ edits: [{ search, replace }] })
  globalThis.websiteFixture.complete = async (messages, options) => { calls.push({ messages, options }); return patch('>Calculate</button>', '>Estimate</button>') }
  const labelEdit = await generateWebsite({ model: 'fixture', prompt: 'Change the button label', user: 'Change Calculate to Estimate', previous: valid, deadlineMs: 275000 })
  assert.equal(labelEdit.html, valid.replace('>Calculate</button>', '>Estimate</button>'))
  assert.equal(calls.length, 1, 'edits must skip replanning')
  assert.match(calls[0].messages[0].content, /Preserve design, content, images, routes/)
  assert.equal(calls[0].options.reasoningEffort, 'high')
  time=0; calls.length=0
  globalThis.websiteFixture.complete=async(messages,options)=>{calls.push({messages,options});return patch('*2}', '*0.2}')}
  const runtimeRepair=await generateWebsite({model:'fixture',prompt:'Repair the observed action failure',user:'Fix the preview',previous:valid.replace('*0.2}', '*2}'),repairIssues:['Income 1000 should produce 200, but gives 2000.'],deadlineMs:275000})
  assert.equal(runtimeRepair.html,valid);assert.equal(calls.length,1)
  assert.match(calls[0].messages[0].content,/ONLY a JSON object/)
  time=0;calls.length=0
  globalThis.websiteFixture.complete=async()=>patch('<output id="result">', '<output id="result" aria-label="Result">')
  const additive=await generateWebsite({model:'fixture',prompt:'Label the result',user:'Repair accessibility',previous:valid,repairIssues:['Result lacks an accessible name'],deadlineMs:275000})
  assert.ok(additive.html.includes("addEventListener('submit'"),'a small accessibility patch must retain the existing calculator and event bindings')
  assert.ok(additive.html.includes('aria-label="Result"'))
  globalThis.websiteFixture.complete=async()=>`console.log('fixed');`
  const dropped=await generateWebsite({model:'fixture',prompt:'Fix the result',user:'Repair',previous:valid,repairIssues:['Result needs a fix'],deadlineMs:275000})
  assert.equal(dropped,null,'a partial repair must fail instead of replacing working event handlers or claiming a fix')
  time=0;calls.length=0
  globalThis.websiteFixture.complete=async(messages,options)=>{calls.push({messages,options});return calls.length===1?patch('>', '>unsafe'):patch('>Calculate</button>', '>Estimate</button>')}
  const retried=await generateWebsite({model:'fixture',prompt:'Change the button label',user:'Use Estimate',previous:valid,deadlineMs:275000})
  assert.equal(retried.html,labelEdit.html,'ambiguous patches must apply nothing; the retry edits the untouched original')
  assert.equal(calls.length,2)
  assert.match(calls[1].messages[1].content,/ambiguous/)
  globalThis.websiteFixture.complete=async()=>valid
  assert.equal(await generateWebsite({model:'fixture',prompt:'Change one label',user:'Use Estimate',previous:valid,deadlineMs:275000}),null,'failed patches must not fall back to an unverified full rewrite')
  time=0;calls.length=0
  globalThis.websiteFixture.complete=async(messages,options)=>{
    calls.push({messages,options,at:time})
    const provider=options.providers[0]
    if(options.json){assert.equal(provider.model,'planner');return planFor('Build a calculator')}
    if(provider.model==='builder'){time+=options.timeoutMs;throw new Error('Builder timed out')}
    assert.equal(provider.model,'backup');return valid
  }
  const recovered=await generateWebsite({model:'builder',plannerModel:'planner',fallbackModel:'backup',prompt:'Build a calculator',user:'Build a calculator',deadlineMs:275000})
  assert.equal(recovered.html,valid)
  assert.deepEqual(calls.map(c=>c.options.providers[0].model),['planner','builder','backup'])
  assert.ok(calls.every(c=>c.options.timeoutMs<=275000-c.at),'independent planner and fallback must respect the shared deadline')
  time=0;calls.length=0
  globalThis.websiteFixture.complete=async(messages,options)=>{
    calls.push({messages,options})
    if(options.json)return planFor('Build a calculator')
    if(calls.length===2)return valid.replace('*0.2','*')
    if(options.providers[0].model==='builder'){time+=options.timeoutMs;throw new Error('Primary repair failed')}
    assert.equal(options.providers[0].model,'backup','the tested secondary builder must precede the generic provider fallback')
    return valid.match(/<script>([\s\S]*)<\/script>/)[1]
  }
  const repairedByBackup=await generateWebsite({model:'builder',plannerModel:'planner',fallbackModel:'backup',prompt:'Build a calculator',user:'Build a calculator',deadlineMs:275000})
  assert.equal(repairedByBackup.html,valid)
  assert.equal(repairedByBackup.repaired,true)
  assert.deepEqual(calls.map(c=>c.options.providers[0].model),['planner','builder','builder','backup'])
  time=0;calls.length=0
  globalThis.websiteFixture.complete=async(messages,options)=>{calls.push({messages,options});return patch('>Calculate</button>','>Estimate</button>')}
  const faithful=await generateWebsite({model:'editor',plannerModel:'unused-planner',fallbackModel:'backup',prompt:'Rename the action',user:'Use Estimate',previous:valid,deadlineMs:275000})
  assert.equal(faithful.html,labelEdit.html)
  assert.deepEqual(calls.map(c=>c.options.providers[0].model),['editor'],'source edits must not plan or rebuild with the website builder')
  const validPlan = planFor('A calculator')
  const planningPrivateValue = 'PRIVATE_UNFINISHED_PLAN_MUST_NOT_ENTER_DIAGNOSTICS'
  const incompleteCoveragePlan = JSON.stringify({ ...JSON.parse(validPlan), direction: planningPrivateValue })
  const exportJourney = { name: 'Export the calculation', steps: [...runtimeTests[0].steps, { action: 'click', target: { role: 'button', name: 'Export CSV' } }], expect: [{ type: 'download', value: 'tax.csv', content: { format: 'csv', equals: [['Income', 'Tax'], ['1000', '200']] } }] }
  const exportBrief = 'Build a calculator with Income and Calculate: 1000 produces 200. Also provide Export CSV, downloading tax.csv with Income,Tax headers and the calculated row.'
  const completeCoveragePlan = planFor(exportBrief, [...runtimeTests, exportJourney])
  const exportHtml = valid.replace('</form>', '</form><button id="export" type="button">Export CSV</button>').replace('</script>', ';document.getElementById("export").onclick=()=>{const income=Number(document.querySelector("input").value);const url=URL.createObjectURL(new Blob(["Income,Tax\\n"+income+","+(income*0.2)+"\\n"],{type:"text/csv"}));const link=document.createElement("a");link.href=url;link.download="tax.csv";link.click();URL.revokeObjectURL(url)}</script>')
  const unfinishedFinalPlan = incompleteCoveragePlan + '\nFinal revised plan: {"contracts":[{"kind":"control","literal":"Export CSV","behavior":"download tax.csv"}'
  // A complete-looking draft from an unfinished completion is not an accepted
  // plan. The correction must recover omitted behavior before checks freeze.
  for (const fixture of [
    ...['length', 'content_filter', 'tool_calls', '', undefined, 'unexpected-provider-finish'].map(finishReason => ({ content: incompleteCoveragePlan, finishReason })),
    { content: unfinishedFinalPlan, finishReason: 'length' },
    { content: unfinishedFinalPlan, finishReason: 'stop' },
  ]) {
    time = 0; calls.length = 0
    const runtimeCalls = []
    globalThis.websiteFixture = { runtimeCalls, complete: async (messages, options) => {
      calls.push({ messages, options, at: time })
      if (options.json) {
        if (calls.length === 1) { time += 20000; return fixture }
        assert.equal(calls.length, 2, 'only one correction is permitted')
        assert.equal(options.providers[0].label, 'primary', 'an unfinished but responding planner corrects its own output')
        assert.equal(options.timeoutMs, 15000, 'correction uses only the remainder of the original 35-second planning window')
        assert.match(messages[1].content, /complete JSON object/)
        assert.ok(messages[1].content.includes(exportBrief), 'correction retains the full product requirements')
        time += 5000
        return completeCoveragePlan
      }
      assert.equal(calls.length, 3, 'builder cannot start from the unfinished subset')
      assert.ok(messages[1].content.includes(completeCoveragePlan), 'builder receives the corrected plan including export')
      assert.ok(!messages[1].content.includes(planningPrivateValue), 'unfinished draft never enters the accepted implementation plan')
      return exportHtml
    } }
    const recoveredCoverage = await generateWebsite({ model: 'fixture', prompt: exportBrief, user: exportBrief, deadlineMs: 275000 })
    assert.ok(recoveredCoverage, 'builder must run only after correction supplies the complete accepted plan')
    assert.deepEqual(recoveredCoverage.review.runtime.planning.attempts.map(attempt => attempt.result), ['invalid-json', 'valid'])
    assert.equal(recoveredCoverage.review.runtime.planning.attempts[0].finishReason, ['length', 'stop'].includes(fixture.finishReason) ? fixture.finishReason : 'other')
    assert.deepEqual(recoveredCoverage.behaviorContract.checks.map(check => check.test), [...runtimeTests, exportJourney], 'only the corrected complete suite is persisted')
    assert.equal(runtimeCalls.length, 1)
    assert.deepEqual(runtimeCalls[0][1], [...runtimeTests, exportJourney], 'runtime receives the export check rather than the original subset')
    assert.equal(recoveredCoverage.review.runtime.status, 'passed')
    assert.doesNotMatch(JSON.stringify(recoveredCoverage.review.runtime.planning), new RegExp(planningPrivateValue), 'diagnostics cannot disclose a discarded draft')
  }
  for (const fixture of [{ content: incompleteCoveragePlan, finishReason: 'length' }, { content: unfinishedFinalPlan, finishReason: 'stop' }]) {
    time = 0; calls.length = 0
    const runtimeCalls = []
    globalThis.websiteFixture = { runtimeCalls, complete: async (messages, options) => {
      calls.push({ messages, options, at: time })
      if (options.json) { time += calls.length === 1 ? 20000 : options.timeoutMs; return fixture }
      assert.ok(messages[1].content.includes(exportBrief))
      assert.doesNotMatch(messages[1].content, /DESIGN AND IMPLEMENTATION PLAN|PRIVATE_UNFINISHED_PLAN/)
      return exportHtml
    } }
    const exhaustedCoverage = await generateWebsite({ model: 'fixture', prompt: exportBrief, user: exportBrief, deadlineMs: 275000 })
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.slice(0, 2).map(call => call.options.providers[0].label), ['primary', 'primary'])
    assert.deepEqual(calls.slice(0, 2).map(call => call.options.timeoutMs), [22000, 15000])
    assert.equal(calls[2].at, 35000, 'two invalid responses cannot extend the planning window')
    assert.equal(exhaustedCoverage.plan, null)
    assert.equal(exhaustedCoverage.behaviorContract, undefined, 'no discarded subset can become durable behavior metadata')
    assert.deepEqual(runtimeCalls[0][1], [])
    assert.equal(exhaustedCoverage.review.runtime.status, 'partial', 'generic runtime success cannot promote missing accepted coverage')
    assert.ok(exhaustedCoverage.review.runtime.planning.attempts.every(attempt => attempt.result === 'invalid-json'))
    assert.doesNotMatch(JSON.stringify(exhaustedCoverage.review.runtime.planning), new RegExp(planningPrivateValue))
  }
  const escapedPlan = { ...JSON.parse(validPlan), direction: 'Keep "quoted" text and {literal braces} with \\paths', runtimeTests: [{ ...runtimeTests[0], expect: [{ type: 'text', target: { selector: '[aria-label="Cost {USD}"]' }, value: 'A "quote" and } brace' }] }] }
  assert.deepEqual(extractWebsitePlanJson(`A draft {not JSON}.\n\`\`\`json\n${JSON.stringify(escapedPlan)}\n\`\`\`\nNotes {no more objects}.`), escapedPlan, 'quoted braces and escaped quotes cannot split a valid JSON object')
  assert.deepEqual(extractWebsitePlanJson(`Draft:\n${validPlan}\nFinal:\n${JSON.stringify(escapedPlan)}\nMetadata: {"note":"complete"}`), escapedPlan, 'select the final complete plan, not a draft or trailing metadata object')
  assert.equal(extractWebsitePlanJson(`${validPlan}\nFinal: {"direction":"Final","pages":[]`), null, 'a truncated final plan cannot silently fall back to an earlier draft')
  assert.equal(extractWebsitePlanJson(`${validPlan}\nFinal: {"direction":"Final" "pages":[]}`), null, 'do not repair missing commas or accept an earlier draft over an invalid final plan')
  for (const key of ['purpose', 'direction', 'palette', 'typography', 'contracts', 'pages', 'interactions', 'evidenceLimits', 'acceptance', 'runtimeTests', 'requirements']) {
    assert.equal(extractWebsitePlanJson(`${validPlan}\nFinal: {"${key}":`), null, `unfinished final ${key} cannot resurrect an earlier plan`)
    assert.equal(extractWebsitePlanJson(`${validPlan}\nFinal: {"${key}":}`), null, `invalid final ${key} cannot resurrect an earlier plan`)
  }
  assert.equal(extractWebsitePlanJson('{direction:"Unquoted property names are not JSON"}'), null)
  const privateValue = 'PRIVATE_PROMPT_VALUE_MUST_NOT_APPEAR_IN_DIAGNOSTICS'
  const badJourney = { ...runtimeTests[0], steps: [{ action: 'evaluate', target: { label: privateValue }, value: privateValue }], expect: [{ type: 'count', target: { selector: 'button' }, value: '1' }] }
  const rejectedPlan = JSON.stringify({ direction: privateValue, pages: [{ name: privateValue }], runtimeTests: [runtimeTests[0], badJourney] })
  assert.deepEqual(extractWebsitePlanJson(`${validPlan}\nFinal:\n${rejectedPlan}`), JSON.parse(rejectedPlan), 'a final JSON plan with invalid journeys must reach schema rejection, never fall back to an earlier valid plan')
  const captured = JSON.parse(await readFile(new URL('./fixtures/studio-planner-output.json', import.meta.url), 'utf8'))
  assert.equal(extractWebsitePlanJson(captured.malformedPlanAndBuildPrefix), null, 'actual malformed planner JSON followed by a premature HTML build remains rejected')
  assert.deepEqual(extractWebsitePlanJson(captured.invalidSelectPlan), JSON.parse(captured.invalidSelectPlan), 'actual second completion reaches strict journey validation without syntax or field rewriting')
  for (const fixture of [
    { content: captured.malformedPlanAndBuildPrefix, result: 'invalid-json', paths: ['plan: expected a complete JSON object'] },
    { content: captured.invalidSelectPlan, result: 'invalid-journeys', paths: ['runtimeTests[0].steps[2].value', 'runtimeTests[1].steps[0].value', 'runtimeTests[1].steps[3].value'] },
  ]) {
    time = 0; calls.length = 0
    const productBrief = 'Build this complete website or web app now: a calculator with "Income" and Calculate. Start empty. Preserve all requested behavior; no clarifying questions.'
    globalThis.websiteFixture.complete = async (messages, options) => {
      calls.push({ messages, options })
      if (options.json) {
        assert.match(messages[0].content, /separate builder will implement your plan later/)
        assert.ok(messages[1].content.startsWith('PLANNING PHASE ONLY.'))
        const encoded = messages[1].content.split('PRODUCT BRIEF (JSON string):\n')[1].split('\nEND PRODUCT BRIEF.')[0]
        assert.ok(JSON.parse(encoded).startsWith(productBrief), 'the full original product requirements survive phase framing byte-for-byte')
        assert.match(messages[1].content, /includes its own setup actions/)
        assert.match(messages[1].content, /computes its expected values from the product's requested initial state plus only that journey's actions/)
        assert.match(messages[1].content, /Do not add unrequested seed data or change the requested initial state/)
        if (calls.length === 1) { time += 20000; return fixture.content }
        assert.equal(options.providers[0].label, 'primary')
        assert.equal(options.timeoutMs, 15000, 'captured-output correction stays within original 35s window')
        for (const path of fixture.paths) assert.ok(messages[1].content.includes(path))
        return planFor(productBrief)
      }
      assert.ok(messages[1].content.startsWith(productBrief), 'builder still receives its original build request')
      assert.ok(!messages[1].content.startsWith('PLANNING PHASE ONLY.'))
      return valid
    }
    const result = await generateWebsite({ model: 'fixture', prompt: productBrief, user: productBrief, deadlineMs: 275000 })
    assert.equal(calls.length, 3)
    assert.deepEqual(result.review.runtime.planning.attempts.map(attempt => attempt.result), [fixture.result, 'valid'])
    assert.doesNotMatch(JSON.stringify(result.review.runtime.planning), /Pocket Ledger|optionValue|I'll build/, 'raw captured text never enters returned diagnostics')
  }
  for (const fixture of [
    { name: 'missing', content: JSON.stringify({ direction: 'Worksheet', pages: [] }), finishReason: 'stop', result: 'invalid-journeys', issue: /runtimeTests: expected 1-4/ },
    { name: 'malformed', content: rejectedPlan, finishReason: 'stop', result: 'invalid-journeys', issue: /runtimeTests\[1\]\.steps\[0\]\.action/ },
    { name: 'truncated', content: '{"direction":"Worksheet","pages":[', finishReason: 'length', result: 'invalid-json', issue: /complete JSON object/ },
    { name: 'design', content: JSON.stringify({ runtimeTests, direction: 'Worksheet' }), finishReason: 'stop', result: 'invalid-design', issue: /pages: expected/ },
    { name: 'select requires value field', content: JSON.stringify({ direction: 'Worksheet', pages: [], runtimeTests: [{ ...runtimeTests[0], steps: [{ action: 'select', target: { label: 'Category' }, option: 'food' }] }] }), finishReason: 'stop', result: 'invalid-journeys', issue: /runtimeTests\[0\]\.steps\[0\]\.value: expected a string/ },
    { name: 'select rejects object value', content: JSON.stringify({ direction: 'Worksheet', pages: [], runtimeTests: [{ ...runtimeTests[0], steps: [{ action: 'select', target: { label: 'Category' }, value: { label: 'Food' } }] }] }), finishReason: 'stop', result: 'invalid-journeys', issue: /runtimeTests\[0\]\.steps\[0\]\.value: expected a string/ },
  ]) {
    time = 0; calls.length = 0
    globalThis.websiteFixture.complete = async (messages, options) => {
      calls.push({ messages, options, at: time })
      if (calls.length === 1) { time += 20000; return { content: fixture.content, finishReason: fixture.finishReason } }
      if (calls.length === 2) {
        assert.match(messages[0].content, /Every fill, select or press step requires a string field named value/)
        assert.ok(messages[0].content.includes('{"action":"select","target":{"label":"Category"},"value":"food"}'), 'select syntax is shown as the actual accepted JSON shape')
        assert.equal(options.providers[0].label, 'primary', 'format/schema correction stays with the responding provider, even when the fallback is quota-blocked')
        assert.match(messages.at(-1).content, fixture.issue, 'correction includes the actual validation field path')
        assert.equal(options.timeoutMs, 15000, '20s first attempt leaves only 15s of the original planning window')
        time += 5000
        return planFor(privateValue)
      }
      return valid
    }
    const corrected = await generateWebsite({ model: 'fixture', prompt: privateValue, user: privateValue, deadlineMs: 275000 })
    const diagnostics = corrected.review.runtime.planning.attempts
    assert.equal(calls.length, 3)
    assert.equal(diagnostics[0].result, fixture.result)
    assert.equal(diagnostics[0].finishReason, fixture.finishReason)
    assert.equal(diagnostics[0].contentChars, fixture.content.length)
    assert.match(diagnostics[0].issues.join('\n'), fixture.issue)
    assert.equal(diagnostics[1].result, 'valid')
    assert.deepEqual(diagnostics.map(attempt => attempt.provider), ['primary', 'primary'])
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(privateValue), 'response diagnostics contain no raw plan, prompt, reasoning or generated values')
  }
  time = 0; calls.length = 0
  globalThis.websiteFixture.complete = async (messages, options) => {
    calls.push({ messages, options })
    return calls.length === 1 ? `<think>{${privateValue}}</think>\n\`\`\`json\n${planFor(privateValue)}\n\`\`\`` : valid
  }
  const reasoned = await generateWebsite({ model: 'fixture', prompt: privateValue, user: privateValue, deadlineMs: 275000 })
  assert.equal(calls.length, 2, 'reasoning braces do not invalidate complete JSON or require a retry')
  assert.equal(reasoned.review.runtime.planning.attempts[0].result, 'valid')
  assert.doesNotMatch(JSON.stringify(reasoned.review.runtime.planning), new RegExp(privateValue))
  time = 0; calls.length = 0
  globalThis.websiteFixture.complete = async (messages, options) => {
    calls.push({ messages, options })
    if (options.json) throw Object.assign(new Error(privateValue), { completionFailure: { category: 'empty_response', finishReason: 'length' } })
    return valid
  }
  const unavailablePlan = await generateWebsite({ model: 'fixture', prompt: privateValue, user: privateValue, deadlineMs: 275000 })
  assert.equal(unavailablePlan.review.runtime.status, 'partial', 'the generator cannot promote an absent interaction plan to passed, even if the runtime result says passed')
  const failures = unavailablePlan.review.runtime.planning.attempts
  assert.equal(failures.length, 2, 'provider failures remain bounded to two planning attempts')
  assert.ok(failures.every(attempt => attempt.result === 'provider-error' && attempt.failureCategory === 'empty_response' && attempt.finishReason === 'length'))
  assert.deepEqual(failures.map(attempt => attempt.provider), ['primary', 'fallback'], 'completion failures still advance to the next provider')
  assert.doesNotMatch(JSON.stringify(failures), new RegExp(privateValue), 'provider errors are categorized without exposing their message')
  time = 0; calls.length = 0
  globalThis.websiteFixture.complete = async (messages, options) => {
    calls.push({ messages, options, at: time })
    if (calls.length === 1) { time += options.timeoutMs; throw Object.assign(new Error('timeout'), { completionFailure: { category: 'timeout' } }) }
    if (calls.length === 2) {
      assert.equal(options.providers[0].label, 'fallback')
      assert.equal(options.timeoutMs, 13000, 'a 22s failed primary leaves only 13s in the original planning window')
      time += 1000
      return validPlan
    }
    return valid
  }
  const fallbackPlan = await generateWebsite({ model: 'fixture', prompt: 'A calculator', user: 'A calculator', deadlineMs: 275000 })
  assert.deepEqual(fallbackPlan.review.runtime.planning.attempts.map(attempt => attempt.result), ['provider-error', 'valid'])
  assert.equal(calls.length, 3)
  // Two different final values for the same output cannot both be true. Reject
  // that plan before building, then correct it within the existing window.
  time=0;calls.length=0
  const contradictoryPlan=JSON.parse(validPlan)
  contradictoryPlan.runtimeTests[0].expect.push({...runtimeTests[0].expect[0],value:'300'})
  globalThis.websiteFixture={complete:async(messages,options)=>{
    calls.push({messages,options,at:time})
    if(calls.length===1){time+=20000;return JSON.stringify(contradictoryPlan)}
    if(calls.length===2){
      assert.equal(options.json,true,'A contradictory plan is corrected before implementation starts')
      assert.equal(options.timeoutMs,15000,'Contradiction correction keeps the original planning deadline')
      assert.match(messages[1].content,/runtimeTests\[0\]\.expect\[1\].*conflicts/)
      time+=1000
      return validPlan
    }
    return valid
  }}
  const consistentPlan=await generateWebsite({model:'fixture',prompt:'A calculator',user:'A calculator',deadlineMs:275000})
  assert.equal(calls.length,3)
  assert.deepEqual(consistentPlan.review.runtime.planning.attempts.map(attempt=>attempt.result),['invalid-journeys','valid'])
  assert.deepEqual(consistentPlan.behaviorContract.checks.map(check=>check.test),runtimeTests,'Conflicting assertions cannot become saved checks')
  // A journey list alone is no longer a complete fresh plan. Validate the
  // inventory before freezing tests, and correct only within the original cap.
  const coverageBrief = 'Calculate twenty percent. Export records. Send an email.'
  const coveragePlan = JSON.parse(planFor(coverageBrief))
  coveragePlan.requirements.push(
    { id: 'export', quote: 'Export records.', state: 'uncovered', reason: 'No export journey fits this bounded plan.' },
    { id: 'email', quote: 'Send an email.', state: 'unsupported', reason: 'Real delivery is outside isolated verification.' },
  )
  for (const brokenInventory of [undefined, null, [], [{ id: 'wrong', quote: 'Invented feature.', state: 'uncovered', reason: 'Wrong evidence.' }], [{ ...coveragePlan.requirements[0], refs: [{ test: 20, assertion: 0 }] }]]) {
    time=0; calls.length=0
    globalThis.websiteFixture = { complete: async (messages, options) => {
      calls.push({ messages, options, at: time })
      if (calls.length === 1) { time += 20000; return JSON.stringify({ ...coveragePlan, requirements: brokenInventory }) }
      if (calls.length === 2) {
        assert.match(messages[1].content, /requirements: expected 1-16/)
        assert.equal(options.timeoutMs, 15000)
        assert.equal(options.maxTokens, 4000, 'inventory replaces duplicate planning prose without expanding output budget')
        time += 1000
        return JSON.stringify(coveragePlan)
      }
      return valid
    } }
    const covered = await generateWebsite({ model:'fixture',prompt:coverageBrief,user:coverageBrief,deadlineMs:275000 })
    assert.equal(calls.length,3)
    assert.equal(covered.behaviorContract.version,2)
    assert.deepEqual(covered.review.runtime.planning.attempts.map(attempt=>attempt.result),['invalid-requirements','valid'])
    assert.equal(covered.review.runtime.status,'partial','passing one journey cannot erase unsupported or uncovered requested features')
    assert.equal(covered.review.runtime.requirements.verified,1)
    assert.deepEqual(covered.review.runtime.requirements.items.map(item=>item.status),['verified','uncovered','unsupported'])
    assert.equal(covered.behaviorContract.inventory.requirements.length,3)
    assert.ok(!covered.html.includes('No export journey fits'), 'private requirement metadata must not be added to exported HTML')
    // A saved artifact roundtrip and unrelated edit must retain missing features.
    const previousContract=JSON.parse(JSON.stringify(covered.behaviorContract))
    time=0;calls.length=0
    globalThis.websiteFixture.complete=async(messages,options)=>{
      calls.push({messages,options})
      if(calls.length===1){
        assert.match(messages[0].content,/requirementChanges/)
        const saved=JSON.parse(messages[1].content.split('SAVED BEHAVIOR CHECKS (JSON data):\n')[1])
        assert.deepEqual(saved.inventory,previousContract.inventory)
        return JSON.stringify({changes:[],requirementChanges:[]})
      }
      return patch('Plan your budget','Family budget')
    }
    const edited=await generateWebsite({model:'fixture',prompt:'Rename the heading to Family budget.',user:'Rename the heading to Family budget.',previous:valid,previousContract,deadlineMs:275000})
    assert.equal(calls.length,2)
    assert.equal(edited.review.runtime.status,'partial')
    assert.deepEqual(edited.behaviorContract.inventory,previousContract.inventory)
    assert.deepEqual(edited.behaviorContract.evidence,previousContract.evidence)
    assert.ok(edited.html.includes('Family budget'))
  }
  time=0;calls.length=0
  globalThis.websiteFixture={complete:async(messages,options)=>{
    calls.push({messages,options})
    if(options.json)return JSON.stringify({...coveragePlan,requirements:undefined})
    return valid
  }}
  const missingInventory=await generateWebsite({model:'fixture',prompt:coverageBrief,user:coverageBrief,deadlineMs:275000})
  assert.equal(calls.length,3)
  assert.equal(missingInventory.behaviorContract,undefined)
  assert.equal(missingInventory.review.runtime.status,'partial')
  assert.equal(missingInventory.review.runtime.requirements.status,'unknown')
  assert.deepEqual(missingInventory.review.runtime.planning.attempts.map(attempt=>attempt.result),['invalid-requirements','invalid-requirements'])
  // The checks and inventory can each fit individually but overflow the
  // complete persisted contract. Do not discard that accepted evidence and
  // proceed as a nominally successful build with an empty contract.
  const largeTests=Array.from({length:4},(_,i)=>({name:`Export ${i}`,steps:[{action:'click',target:{role:'button',name:'Export'}}],expect:Array.from({length:3},(_,j)=>({type:'download',value:`part-${i}-${j}.txt`,content:{format:'text',equals:'x'.repeat(10000)}}))}))
  const largePlan={direction:'Export workspace',pages:[{name:'Records'}],runtimeTests:largeTests,requirements:[{id:'export',quote:'Export all records.',goal:{kind:'result',type:'download'},refs:[{test:0,assertion:0}]}]}
  time=0;calls.length=0
  globalThis.websiteFixture={complete:async(messages,options)=>{calls.push({messages,options});assert.equal(options.json,true,'unsavable metadata must be corrected before any implementation request');return JSON.stringify(largePlan)}}
  const oversized=await generateWebsite({model:'fixture',prompt:'Export all records.',user:'Export all records.',deadlineMs:275000})
  assert.equal(oversized,null)
  assert.equal(calls.length,2,'an oversized aggregate has at most the existing bounded correction')
  // Regression: a lower failure count cannot trade a working calculation for
  // a repaired Reset button. Run the actual fixture functions independently
  // of the repair decision; no browser or provider is involved.
  const repairHtml = valid.replace('</form>', '<button type="reset">Reset</button></form>').replace(/<script>[\s\S]*?<\/script>/, `<script>function tax(income){return income*0.2}function resetValue(){return '1000'}document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('output').textContent=tax(Number(document.querySelector('input').value))});document.querySelector('form').addEventListener('reset',e=>{e.preventDefault();document.querySelector('input').value=resetValue()})</script>`)
  const resetTest = { name: 'Reset clears income', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Reset' } }], expect: [{ type: 'value', target: { label: 'Income' }, value: '' }] }
  const correctPatch = patch("return '1000'", "return ''")
  for (const scenario of ['equal failures', 'fewer failures', 'missing mobile', 'missing assertion', 'missing step', 'duplicate evidence']) {
    time=0;calls.length=0
    const tests=[runtimeTests[0],resetTest,...(scenario==='fewer failures'?[{...resetTest,name:runtimeTests[0].name,steps:[{...resetTest.steps[0],value:'500'},resetTest.steps[1]]}]:[])]
    const previousContract={version:1,checks:tests.map((test,index)=>({id:`frozen_${index}`,test}))}
    const promoted=[], observations=[]
    globalThis.websiteFixture={
      complete:async(messages,options)=>{
        calls.push({messages,options,at:time})
        if(calls.length>1)return correctPatch
        const edits=[{search:"return '1000'",replace:"return ''"}]
        if(scenario.endsWith('failures'))edits.push({search:'return income*0.2',replace:'return income*0.5'})
        else edits.push({search:'<main>',replace:'<main data-probe="incomplete-evidence">'})
        return JSON.stringify({edits})
      },
      runtime:async(candidate,journeys)=>{
        const sandbox={document:{querySelector:()=>({addEventListener(){}})}}
        vm.createContext(sandbox)
        vm.runInContext(candidate.match(/<script>([\s\S]*)<\/script>/)[1],sandbox)
        const values=[sandbox.tax(1000),sandbox.resetValue()]
        let checks=[1440,390].flatMap(width=>journeys.map((test,journeyIndex)=>{const passed=journeyIndex===0?values[0]===200:values[1]==='';return{name:test.name,width,journeyIndex,passed,executedSteps:[0,1],passedAssertions:passed?[0]:[]}}))
        const incomplete=candidate.includes('data-probe=')
        if(incomplete&&scenario==='missing mobile')checks=checks.filter(check=>check.journeyIndex!==0||check.width!==390)
        if(incomplete&&scenario==='missing assertion')checks=checks.map(check=>check.journeyIndex===0?{...check,passedAssertions:[]}:check)
        if(incomplete&&scenario==='missing step')checks=checks.map(check=>check.journeyIndex===0?{...check,executedSteps:[1]}:check)
        if(incomplete&&scenario==='duplicate evidence')checks.push({...checks[0]})
        const issues=checks.filter(check=>!check.passed).map(check=>({code:'runtime-interaction',severity:'error',detail:`${check.width}px / ${check.name}: exact fixture result failed.`}))
        observations.push({values,errors:issues.length,checks})
        return{status:issues.length?'failed':incomplete?'partial':'passed',widths:[1440,390],checks,issues,limitations:['Offline function execution and synthetic indexed evidence.']}
      },
    }
    const recovered=await generateWebsite({model:'fixture',prompt:'Fix Reset while preserving tax calculation.',user:'Fix Reset while preserving tax calculation.',previous:repairHtml,previousContract,repairIssues:['Reset should clear the Income field.'],deadlineMs:275000,onCandidate:html=>promoted.push(html)})
    assert.ok(recovered,`${scenario}: rejected repair must retain the original baseline so the corrected patch can apply`)
    assert.equal(calls.length,2,`${scenario}: explicit retry feedback permits a focused second repair`)
    assert.equal(recovered.html,repairHtml.replace("return '1000'","return ''"))
    assert.ok(calls[1].messages[1].content.includes("function resetValue(){return '1000'}"),`${scenario}: next repair receives accepted source, not rejected source`)
    assert.match(calls[1].messages[1].content,/PREVIOUS REPAIR REJECTED/)
    assert.match(calls[1].messages[1].content,/journey 1/)
    assert.match(calls[1].messages[1].content,/1440px|390px/)
    assert.ok(promoted.every(html=>!html.includes('return income*0.5')&&!html.includes('data-probe=')),`${scenario}: rejected candidates never reach candidate promotion`)
    assert.deepEqual(recovered.review.issues,[],`${scenario}: retry feedback never pollutes the accepted review with synthetic errors`)
    assert.equal(recovered.repaired,true)
    assert.equal(observations[0].values[0],200)
    assert.equal(observations.at(-1).values[0],200)
    assert.deepEqual(recovered.behaviorContract,previousContract)
    assert.ok(calls.every(call=>call.options.maxAttempts===1&&call.options.timeoutMs<=65000),'repair providers and caps stay unchanged')
  }
  for(const interruption of ['deadline','unavailable']){
    time=0;calls.length=0
    const previousContract={version:1,checks:[runtimeTests[0],resetTest].map((test,index)=>({id:`frozen_${index}`,test}))}
    const promoted=[]
    let runtimeAttempts=0
    globalThis.websiteFixture={complete:async(messages,options)=>{calls.push({messages,options});if(interruption==='deadline')time=265000;return JSON.stringify({edits:[{search:"return '1000'",replace:"return ''"},{search:'return income*0.2',replace:'return income*0.5'}]})},runtime:async()=>{
      runtimeAttempts++
      if(runtimeAttempts>1&&interruption==='unavailable')return{status:'unavailable',widths:[],checks:[],issues:[],limitations:['Synthetic exhausted verification window.']}
      const checks=[1440,390].flatMap(width=>previousContract.checks.map(({test},journeyIndex)=>({name:test.name,width,journeyIndex,passed:runtimeAttempts===1?journeyIndex===0:journeyIndex===1,executedSteps:[0,1],passedAssertions:runtimeAttempts===1?journeyIndex===0?[0]:[]:journeyIndex===1?[0]:[]})))
      return{status:'failed',widths:[1440,390],checks,issues:checks.filter(check=>!check.passed).map(check=>({code:'runtime-interaction',severity:'error',detail:`${check.width}px / ${check.name}: fixture assertion failed.`})),limitations:[]}
    }}
    const run=()=>generateWebsite({model:'fixture',prompt:'Fix Reset.',user:'Fix Reset.',previous:repairHtml,previousContract,repairIssues:['Reset should clear Income.'],deadlineMs:275000,onCandidate:html=>promoted.push(html)})
    if(interruption==='unavailable')await assert.rejects(run(),error=>error.name==='WebsiteRuntimeUnavailableError','unavailable verification still fails closed without promoting the candidate')
    else assert.equal(await run(),null,'deadline exhaustion cannot accept the rejected regression or extend the repair loop')
    assert.equal(calls.length,1)
    assert.deepEqual(promoted,[repairHtml])
  }
  console.log('PASS: actual HTML/JS parsing, broken link/label detection, targeted repair, shared deadlines, completed-plan gating, stale-draft rejection, corrected export coverage, exhausted-plan partial status, and preservation during edits. Repair selection preserves passing frozen journey/viewport evidence, rejects incomplete/ambiguous evidence and retries against the accepted source. Synthetic provider/runtime only; no browser or paid calls.')
} finally { Date.now = originalNow; delete globalThis.websiteFixture; await rm(temp, { recursive: true, force: true }) }
