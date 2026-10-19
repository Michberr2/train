import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
const directory = await fs.mkdtemp(new URL('./.edit-check-', import.meta.url).pathname)
try {
  const bundle = await build({ stdin: { contents: "export * from './api/_websiteEdits'; export { generateWebsite } from './api/_websiteGeneration'; export { createWebsiteBehaviorContractV2 } from './api/_websiteBehavior'; export { prepareDesignResponse } from './client/src/components/workspace/designReferences'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'provider', setup(b) {
    b.onResolve({ filter: /^\.\/_websiteRuntime$/ }, () => ({ path: 'runtime', namespace: 'runtime-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'runtime-fixture' }, () => ({ resolveDir: process.cwd(), contents: `export {WEBSITE_RUNTIME_JOURNEY_SCHEMA,WEBSITE_RUNTIME_TEST_SCHEMA,parseRuntimeTests,inspectRuntimeTests} from '${process.cwd()}/api/_websiteRuntime.ts';export const reviewWebsiteRuntime=async()=>({status:'passed',widths:[1440,390],checks:[],issues:[],limitations:['Mocked in parser/provider unit tests; real browser covered by studio-runtime-regressions.mjs']})` }))
    b.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const providerChain=()=>[{model:'thinkingmachines/Inkling'}];export async function chatCompleteEx(messages,options){const result=await globalThis.editFixture(messages,options);return typeof result==='string'?{content:result,finishReason:'stop'}:result};export async function chatComplete(messages,options){return (await chatCompleteEx(messages,options)).content}` }))
  } }] })
  await fs.writeFile(directory + '/edits.mjs', bundle.outputFiles[0].text)
  const { prepareWebsiteEdit, applyWebsiteEdits, generateWebsite, createWebsiteBehaviorContractV2, prepareDesignResponse } = await import(pathToFileURL(directory + '/edits.mjs'))
  const edits = items => JSON.stringify({ edits: items })
  const patch = (search, replace) => edits([{ search, replace }])
  const tiny = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>Old</h1></main></body></html>'
  assert.ok(tiny.length < 200)
  const asset = 'data:image/png;base64,' + 'QUJD'.repeat(90000)
  const middle = Array.from({ length: 2000 }, (_, i) => `<p id="entry-${i}">Record ${i}: Keep this complete historical observation and its original punctuation, spaces, dates and units.</p>\n`).join('')
  const original = tiny.replace('</main>', `<img src="${asset}" alt="Saved map"><img src="${asset}" alt="Map copy">${middle}<p id="tail">Final note</p><button id="add">Add</button><output id="count" aria-label="Count">0</output></main>`).replace('</body>', '<script>let count=0;document.querySelector("button").onclick=()=>document.querySelector("output").textContent=++count</script></body>')
  const prepared = prepareWebsiteEdit(original)
  assert.ok(original.length > 900000)
  assert.ok(prepared.source.length > 180000, 'exercise real markup past the old cutoff as well as folded images')
  assert.equal(prepared.restore(prepared.source), original, 'asset folding is lossless')
  assert.ok(!prepared.source.includes(asset))
  const replacement = '<p id="tail">End of field notes — 東京 $& $` $\'</p>'
  const raw = edits([{ search: '<h1>Old</h1>', replace: '<h1>Field notes</h1>' }, { search: '<p id="tail">Final note</p>', replace: replacement }])
  const expected = original.replace('<h1>Old</h1>', '<h1>Field notes</h1>').replace('<p id="tail">Final note</p>', () => replacement)
  assert.equal(prepared.restore(applyWebsiteEdits(prepared.source, raw)), expected, 'all unrelated bytes, both images, data, script and tail survive')
  for (const raw of [patch('Record', 'Entry'), patch('absent source', ''), edits([{ search: 'Old', replace: 'New' }, { search: '<h1>Old</h1>', replace: '<h1>Title</h1>' }]), patch('Old', 'Old'), edits([{ search: '', replace: 'append' }]), '{"edits":']) assert.throws(() => applyWebsiteEdits(original, raw))
  const token = prepared.source.match(/nalu-preserved-asset:[^"\s]+/)[0]
  assert.throws(() => prepared.restore(prepared.source.replace(token, token + '-damaged')))
  let calls = 0
  globalThis.editFixture = async (messages, options) => {
    calls++
    assert.equal(options.providers[0].model, 'thinkingmachines/Inkling:peft:262144')
    assert.ok(messages[1].content.includes('<p id="tail">Final note</p>'), 'model sees the full document tail')
    assert.ok(!messages[1].content.includes(asset), 'opaque bytes do not consume the model context')
    return raw
  }
  const result = await generateWebsite({ model: 'thinkingmachines/Inkling', prompt: 'Rename and update final note', user: 'Rename and update final note', previous: original, deadlineMs: Date.now() + 275000 })
  assert.equal(result.html, expected)
  assert.equal(calls, 1)
  globalThis.editFixture = async () => patch('<h1>Old</h1>', '<h1>New</h1>')
  const tinyResult = await generateWebsite({ model: 'thinkingmachines/Inkling', prompt: 'Rename', user: 'Rename', previous: tiny, deadlineMs: Date.now() + 275000 })
  assert.equal(tinyResult.html, tiny.replace('Old', 'New'))
  let completionCalls = 0
  globalThis.editFixture = async messages => {
    completionCalls++
    assert.ok(messages[1].content.includes('<h1>Old</h1>'), 'A rejected incomplete edit must retry against the unchanged original source')
    return completionCalls === 1
      ? { content: patch('<h1>Old</h1>', '<h1>Partial change</h1>'), finishReason: 'length' }
      : { content: patch('<h1>Old</h1>', '<h1>Complete change</h1>'), finishReason: 'stop' }
  }
  const completedEdit = await generateWebsite({ model: 'thinkingmachines/Inkling', prompt: 'Update the page fully', user: 'Update the page fully', previous: tiny, deadlineMs: Date.now() + 275000 })
  assert.equal(completionCalls, 2, 'Valid JSON from an unfinished generation must not publish an incomplete edit')
  assert.equal(completedEdit.html, tiny.replace('Old', 'Complete change'))
  completionCalls = 0
  globalThis.editFixture = async () => ({ content: patch('<h1>Old</h1>', '<h1>Incomplete change</h1>'), finishReason: ['length', 'content_filter', ''][completionCalls++] })
  const rejectedEdit = await generateWebsite({ model: 'thinkingmachines/Inkling', prompt: 'Update the page fully', user: 'Update the page fully', previous: tiny, deadlineMs: Date.now() + 275000 })
  assert.equal(completionCalls, 3)
  assert.equal(rejectedEdit, null, 'Exhausted incomplete edits must leave the saved page intact')
  // Exercise the actual API boundary: even tiny documents are edits, and no
  // large source can be silently sliced before the generator receives it.
  const handlerBundle = await build({ entryPoints: ['api/design.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'services', setup(b) {
    b.onResolve({ filter: /^\.\/(?:_websiteGeneration|_db|_limits|_grounding|web)$/ }, args => ({ path: args.path, namespace: 'service' }))
    b.onLoad({ filter: /.*/, namespace: 'service' }, ({ path }) => ({ contents:
      path === './_websiteGeneration' ? 'export class WebsiteRuntimeUnavailableError extends Error{};export const WEBSITE_SYSTEM="fixture";export const generateWebsite=options=>globalThis.handlerFixture(options);' :
      path === './_db' ? 'export const identityForRequest=async()=>null;export const identityBlock=()=>"";' :
      path === './_limits' ? 'export const reserveStudioQuota=async()=>{globalThis.quotaReserved=(globalThis.quotaReserved||0)+1;return {ok:true,release:async()=>{globalThis.quotaReleased++}}};export const studioLimitMessage=()=>"limit";' :
      path === './web' ? 'export const research=async()=>null;' : 'export const groundResearch=async()=>({text:"",sources:[]});',
    }))
  } }] })
  await fs.writeFile(directory + '/handler.mjs', handlerBundle.outputFiles[0].text)
  const originalKey = process.env.TINKER_API_KEY
  process.env.TINKER_API_KEY = 'offline-test'
  try {
    const { default: handler } = await import(pathToFileURL(directory + '/handler.mjs'))
    for (const previous of [tiny, original]) {
      globalThis.handlerFixture = async options => {
        assert.equal(options.previous, previous)
        assert.equal(options.changeRequest, undefined, 'Older clients remain compatible without the optional latest-change field')
        assert.ok(!options.user.includes(previous), 'source has one canonical copy in the generator, not duplicated in the request context')
        return { html: previous, review: { issues: [], scripts: 0, links: 0, controls: 0 }, repaired: false }
      }
      const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Update the title', prevHtml: previous } }, res)
      assert.equal(res.code, 200)
      assert.equal(res.payload.html, previous)
    }
    const savedContract = { version: 1, checks: [{ id: 'check_0123456789abcdef', test: { name: 'Original heading', steps: [], expect: [{ type: 'text', target: { role: 'heading', name: 'Old' }, value: 'Old' }] } }] }
    const savedArtifact = JSON.parse(JSON.stringify(prepareDesignResponse('webpage', { html: tiny, quality: { behaviorContract: savedContract } })))
    assert.deepEqual(savedArtifact.quality.behaviorContract, savedContract, 'Preparing and saving a website must retain its private behavior contract')
    globalThis.handlerFixture = async options => {
      assert.deepEqual(options.previousContract, savedContract, 'Saved behavior checks reach the generator after reload')
      assert.equal(options.changeRequest, 'Keep the heading and change its color', 'Reconciliation receives only the latest edit instruction')
      return { html: tiny, review: { issues: [], scripts: 0, links: 0, controls: 0 }, repaired: false, behaviorContract: savedContract }
    }
    const contractResponse = { setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
    await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Older context: replace the heading. Latest request: Keep the heading and change its color', websiteChangeRequest: ' Keep the heading and change its color ', prevHtml: savedArtifact.html, prevWebsiteContract: savedArtifact.quality.behaviorContract } }, contractResponse)
    assert.equal(contractResponse.code, 200)
    assert.deepEqual(contractResponse.payload.quality.behaviorContract, savedContract)
    assert.equal(contractResponse.payload.html, tiny, 'Private test metadata is not inserted into public/downloadable HTML')
    const privateBrief = 'Show the heading Old. Send real email to PRIVATE_WEBSITE_REQUIREMENT.'
    const unsupportedRequirement = { id: 'email', quote: 'Send real email to PRIVATE_WEBSITE_REQUIREMENT.', viewports: ['desktop', 'mobile'], goal: { kind: 'capability', description: 'External email delivery' }, coverage: { state: 'unsupported', reason: 'External delivery cannot be checked in the isolated page.' } }
    const inventory = { version: 1, requirements: [
      { id: 'heading', quote: 'Show the heading Old.', viewports: ['desktop', 'mobile'], goal: { kind: 'result', expectation: savedContract.checks[0].test.expect[0] }, coverage: { state: 'mapped', refs: [{ checkId: savedContract.checks[0].id, assertion: 0 }] } },
      unsupportedRequirement,
    ] }
    const savedV2 = createWebsiteBehaviorContractV2(savedContract.checks, inventory, privateBrief)
    const noChecksV2 = createWebsiteBehaviorContractV2([], { version: 1, requirements: [unsupportedRequirement] }, privateBrief)
    for (const contract of [savedV2, noChecksV2]) {
      assert.equal(contract.version, 2)
      const reloaded = JSON.parse(JSON.stringify(prepareDesignResponse('webpage', { html: tiny, quality: { behaviorContract: contract } })))
      assert.deepEqual(reloaded.quality.behaviorContract, contract, 'V2 inventory, evidence, and empty check lists survive artifact preparation and JSON reload')
      for (const previewIssues of [undefined, ['The saved heading did not appear.']]) {
        globalThis.handlerFixture = async options => {
          assert.deepEqual(options.previousContract, contract, 'The real API forwards every private v2 field for both edits and repairs')
          assert.equal(options.previous, tiny)
          assert.deepEqual(options.repairIssues, previewIssues)
          return { html: tiny, review: { issues: [], scripts: 0, links: 0, controls: 0 }, repaired: !!previewIssues, behaviorContract: contract }
        }
        await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: previewIssues ? 'Repair the saved heading.' : 'Keep the heading and change its color.', prevHtml: reloaded.html, prevWebsiteContract: reloaded.quality.behaviorContract, ...(previewIssues ? { previewIssues } : {}) } }, contractResponse)
        assert.equal(contractResponse.code, 200)
        assert.deepEqual(JSON.parse(JSON.stringify(contractResponse.payload.quality.behaviorContract)), contract, 'The API response remains a complete persisted v2 contract')
        assert.equal(contractResponse.payload.html, tiny, 'Private v2 inventory and evidence never become public/downloadable HTML')
        assert.doesNotMatch(contractResponse.payload.html, /PRIVATE_WEBSITE_REQUIREMENT|requestHash|behaviorContract/)
      }
    }
    for (const invalidRequest of [null, '', '   ', {}, 'x'.repeat(60001)]) {
      const beforeQuota = globalThis.quotaReserved
      globalThis.handlerFixture = async () => { throw new Error('Invalid change text must not reach generation') }
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Change color', prevHtml: tiny, websiteChangeRequest: invalidRequest } }, contractResponse)
      assert.equal(contractResponse.code, 400)
      assert.equal(globalThis.quotaReserved, beforeQuota, 'Invalid change text rejects before reserving quota')
    }
    const malformedV2 = JSON.parse(JSON.stringify(savedV2))
    malformedV2.inventory.requirements[0].coverage.refs[0].checkId = 'missing_check'
    for (const malformed of [null, { version: 2, checks: [] }, { ...savedV2, evidence: [] }, malformedV2, { ...savedV2, version: 3 }, { version: 1, checks: [{ id: 'bad', test: { name: 'Run JS', steps: [{ action: 'evaluate', value: 'alert(1)' }], expect: [] } }] }]) {
      const beforeQuota = globalThis.quotaReserved
      globalThis.handlerFixture = async () => { throw new Error('Invalid contract must not reach generation') }
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Change color', prevHtml: tiny, prevWebsiteContract: malformed } }, contractResponse)
      assert.equal(contractResponse.code, 400)
      assert.equal(globalThis.quotaReserved, beforeQuota, 'Malformed metadata rejects before reserving quota')
    }
    for (const contract of [savedContract, savedV2, noChecksV2]) {
      const beforeQuota = globalThis.quotaReserved
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Create a new page', prevWebsiteContract: contract } }, contractResponse)
      assert.equal(contractResponse.code, 400, 'An existing v1 or v2 contract cannot be paired with a missing original page')
      assert.equal(globalThis.quotaReserved, beforeQuota)
    }
    globalThis.quotaReleased = 0
    globalThis.handlerFixture = async () => null
    const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
    await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Update the title', prevHtml: original } }, res)
    assert.equal(res.code, 502)
    assert.equal(globalThis.quotaReleased, 1, 'failed edits refund their generation quota')
    assert.match(res.payload.error, /existing design is preserved/)
    const originalInfo = console.info
    const diagnosticLogs = []
    try {
      console.info = line => diagnosticLogs.push(JSON.parse(line.replace(/^nalu-studio /, '')))
      globalThis.handlerFixture = async options => {
        const privateValue = 'PRIVATE_PROMPT_PLAN_PROVIDER_CREDENTIAL'
        options.onDiagnostic('build', Object.assign(new Error(privateValue), { completionFailure: { category: 'quota', status: 429, finishReason: 'length', body: privateValue }, cause: privateValue }))
        options.onDiagnostic('plan-runtime', { attempt: 1, provider: 'primary', result: 'invalid-journeys', elapsedMs: 23, contentChars: 456, finishReason: 'stop', issues: [privateValue], prompt: privateValue })
        options.onDiagnostic('review', JSON.stringify([{ detail: privateValue }]))
        options.onDiagnostic(privateValue, { completionFailure: { category: privateValue, status: privateValue, finishReason: privateValue } })
        return null
      }
      const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Synthetic diagnostic check' } }, res)
      assert.equal(res.code, 502, 'failed generation still emits safe operational facts')
      assert.deepEqual(diagnosticLogs, [
        { stage: 'build', category: 'quota', status: 429, finishReason: 'length' },
        { stage: 'plan-runtime', result: 'invalid-journeys', provider: 'primary', finishReason: 'stop', attempt: 1, elapsedMs: 23, contentChars: 456, issueCount: 1 },
        { stage: 'review', category: 'validation' },
        { stage: 'other', category: 'unknown' },
      ])
      assert.doesNotMatch(JSON.stringify({ diagnosticLogs, response: res.payload }), /PRIVATE_/)
      console.info = () => { throw new Error('logging unavailable') }
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Synthetic diagnostic check' } }, res)
      assert.equal(res.code, 502, 'logging failure cannot change generation behavior')
    } finally { console.info = originalInfo }
    const modelKeys = ['NALU_DESIGN_MODEL', 'NALU_WEBSITE_MODEL', 'NALU_WEBSITE_PLANNER_MODEL', 'NALU_WEBSITE_EDIT_MODEL', 'NALU_WEBSITE_FALLBACK_MODEL']
    const savedModels = Object.fromEntries(modelKeys.map(key => [key, process.env[key]]))
    try {
      const configurations = [
        { env: {}, planner: 'thinkingmachines/Inkling', builder: 'thinkingmachines/Inkling', editor: 'thinkingmachines/Inkling' },
        { env: { NALU_DESIGN_MODEL: 'configured-design' }, planner: 'configured-design', builder: 'configured-design', editor: 'configured-design' },
        { env: { NALU_WEBSITE_PLANNER_MODEL: 'configured-planner', NALU_WEBSITE_MODEL: 'configured-builder', NALU_WEBSITE_EDIT_MODEL: 'configured-editor' }, planner: 'configured-planner', builder: 'configured-builder', editor: 'configured-editor' },
        { env: { NALU_WEBSITE_PLANNER_MODEL: '   ' }, planner: 'thinkingmachines/Inkling', builder: 'thinkingmachines/Inkling', editor: 'thinkingmachines/Inkling' },
      ]
      for (const [index, item] of configurations.entries()) {
        for (const key of modelKeys) delete process.env[key]
        Object.assign(process.env, item.env)
        const { default: configuredHandler } = await import(pathToFileURL(directory + '/handler.mjs').href + '?model-config=' + index)
        for (const editing of [false, true]) {
          globalThis.handlerFixture = async options => {
            assert.equal(options.plannerModel, item.planner, 'only server environment selects the planner')
            assert.equal(options.model, editing ? item.editor : item.builder, 'planner override preserves builder/editor selection')
            assert.equal(options.fallbackModel, editing ? item.env.NALU_DESIGN_MODEL || 'thinkingmachines/Inkling' : 'moonshotai/Kimi-K2.6:peft:131072', 'planner override preserves fallback selection')
            return { html: tiny, review: { issues: [], scripts: 0, links: 0, controls: 0 }, repaired: false }
          }
          const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
          await configuredHandler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Synthetic planner contract', plannerModel: 'untrusted-request-model', NALU_WEBSITE_PLANNER_MODEL: 'untrusted-request-model', ...(editing ? { prevHtml: tiny } : {}) } }, res)
          assert.equal(res.code, 200)
        }
      }
    } finally {
      for (const key of modelKeys) { if (savedModels[key] === undefined) delete process.env[key]; else process.env[key] = savedModels[key] }
    }
  } finally { if (originalKey === undefined) delete process.env.TINKER_API_KEY; else process.env.TINKER_API_KEY = originalKey }
  console.log('PASS: tiny edits, large source and tail preservation, duplicated embedded assets, literal Unicode/replacement bytes, v1/v2 private-contract edit/repair roundtrips, invalid metadata before quota, atomic rejection, and extended-context routing')
} finally { delete globalThis.editFixture; delete globalThis.handlerFixture; delete globalThis.quotaReleased; delete globalThis.quotaReserved; await fs.rm(directory, { recursive: true, force: true }) }
