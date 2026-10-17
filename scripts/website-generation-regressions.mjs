import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const temp = await mkdtemp(join(process.cwd(), 'scripts/.website-check-'))
const originalNow = Date.now
try {
  const bundle = await build({ entryPoints: ['api/_websiteGeneration.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'fixture-provider', setup(b) {
    b.onResolve({ filter: /^\.\/_websiteRuntime$/ }, () => ({ path: 'runtime', namespace: 'runtime-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'runtime-fixture' }, () => ({ resolveDir: process.cwd(), contents: `export {WEBSITE_RUNTIME_TEST_SCHEMA,parseRuntimeTests,inspectRuntimeTests} from '${process.cwd()}/api/_websiteRuntime.ts';export const reviewWebsiteRuntime=async()=>({status:'passed',widths:[1440,390],checks:[],issues:[],limitations:['Mocked in parser/provider unit tests; real browser covered by studio-runtime-regressions.mjs']})` }))
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
  const fixtures = [JSON.stringify({ runtimeTests, purpose: 'Budget tool', direction: 'Useful financial worksheet', pages: [{ name: 'Budget' }], acceptance: ['Income 1000 produces 200'] }), valid.replace('*0.2', '*'), valid.match(/<script>([\s\S]*)<\/script>/)[1]]
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
    if(options.json){assert.equal(provider.model,'planner');return JSON.stringify({runtimeTests,direction:'Useful worksheet',pages:[{name:'Budget'}]})}
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
    if(options.json)return JSON.stringify({runtimeTests,direction:'Useful worksheet',pages:[{name:'Budget'}]})
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
  const validPlan = JSON.stringify({ direction: 'Useful worksheet', pages: [{ name: 'Budget' }], runtimeTests })
  const escapedPlan = { ...JSON.parse(validPlan), direction: 'Keep "quoted" text and {literal braces} with \\paths', runtimeTests: [{ ...runtimeTests[0], expect: [{ type: 'text', target: { selector: '[aria-label="Cost {USD}"]' }, value: 'A "quote" and } brace' }] }] }
  assert.deepEqual(extractWebsitePlanJson(`A draft {not JSON}.\n\`\`\`json\n${JSON.stringify(escapedPlan)}\n\`\`\`\nNotes {no more objects}.`), escapedPlan, 'quoted braces and escaped quotes cannot split a valid JSON object')
  assert.deepEqual(extractWebsitePlanJson(`Draft:\n${validPlan}\nFinal:\n${JSON.stringify(escapedPlan)}\nMetadata: {"note":"complete"}`), escapedPlan, 'select the final complete plan, not a draft or trailing metadata object')
  assert.equal(extractWebsitePlanJson(`${validPlan}\nFinal: {"direction":"Final","pages":[]`), null, 'a truncated final plan cannot silently fall back to an earlier draft')
  assert.equal(extractWebsitePlanJson(`${validPlan}\nFinal: {"direction":"Final" "pages":[]}`), null, 'do not repair missing commas or accept an earlier draft over an invalid final plan')
  assert.equal(extractWebsitePlanJson('{direction:"Unquoted property names are not JSON"}'), null)
  const privateValue = 'PRIVATE_PROMPT_VALUE_MUST_NOT_APPEAR_IN_DIAGNOSTICS'
  const badJourney = { ...runtimeTests[0], steps: [{ action: 'evaluate', target: { label: privateValue }, value: privateValue }], expect: [{ type: 'count', target: { selector: 'button' }, value: '1' }] }
  const rejectedPlan = JSON.stringify({ direction: privateValue, pages: [{ name: privateValue }], runtimeTests: [runtimeTests[0], badJourney] })
  assert.deepEqual(extractWebsitePlanJson(`${validPlan}\nFinal:\n${rejectedPlan}`), JSON.parse(rejectedPlan), 'a final JSON plan with invalid journeys must reach schema rejection, never fall back to an earlier valid plan')
  for (const fixture of [
    { name: 'missing', content: JSON.stringify({ direction: 'Worksheet', pages: [] }), finishReason: 'stop', result: 'invalid-journeys', issue: /runtimeTests: expected 1-4/ },
    { name: 'malformed', content: rejectedPlan, finishReason: 'stop', result: 'invalid-journeys', issue: /runtimeTests\[1\]\.steps\[0\]\.action/ },
    { name: 'truncated', content: '{"direction":"Worksheet","pages":[', finishReason: 'length', result: 'invalid-json', issue: /complete JSON object/ },
    { name: 'design', content: JSON.stringify({ runtimeTests, direction: 'Worksheet' }), finishReason: 'stop', result: 'invalid-design', issue: /pages: expected/ },
  ]) {
    time = 0; calls.length = 0
    globalThis.websiteFixture.complete = async (messages, options) => {
      calls.push({ messages, options, at: time })
      if (calls.length === 1) { time += 20000; return { content: fixture.content, finishReason: fixture.finishReason } }
      if (calls.length === 2) {
        assert.equal(options.providers[0].label, 'primary', 'format/schema correction stays with the responding provider, even when the fallback is quota-blocked')
        assert.match(messages.at(-1).content, fixture.issue, 'correction includes the actual validation field path')
        assert.equal(options.timeoutMs, 15000, '20s first attempt leaves only 15s of the original planning window')
        time += 5000
        return validPlan
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
    return calls.length === 1 ? `<think>{${privateValue}}</think>\n\`\`\`json\n${validPlan}\n\`\`\`` : valid
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
  console.log('PASS: actual HTML/JS parsing, broken link/label detection, targeted repair, shared request deadline, and preservation during edits.')
} finally { Date.now = originalNow; delete globalThis.websiteFixture; await rm(temp, { recursive: true, force: true }) }
