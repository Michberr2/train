import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
const directory = await fs.mkdtemp(new URL('./.edit-check-', import.meta.url).pathname)
try {
  const bundle = await build({ stdin: { contents: "export * from './api/_websiteEdits'; export { generateWebsite } from './api/_websiteGeneration'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'provider', setup(b) {
    b.onResolve({ filter: /^\.\/_websiteRuntime$/ }, () => ({ path: 'runtime', namespace: 'runtime-fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'runtime-fixture' }, () => ({ resolveDir: process.cwd(), contents: `export {WEBSITE_RUNTIME_TEST_SCHEMA,parseRuntimeTests,inspectRuntimeTests} from '${process.cwd()}/api/_websiteRuntime.ts';export const reviewWebsiteRuntime=async()=>({status:'passed',widths:[1440,390],checks:[],issues:[],limitations:['Mocked in parser/provider unit tests; real browser covered by studio-runtime-regressions.mjs']})` }))
    b.onResolve({ filter: /^\.\/_llm$/ }, () => ({ path: 'llm', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const providerChain=()=>[{model:'thinkingmachines/Inkling'}];export async function chatComplete(messages,options){return globalThis.editFixture(messages,options)};export async function chatCompleteEx(messages,options){const result=await chatComplete(messages,options);return typeof result==='string'?{content:result,finishReason:'stop'}:result}` }))
  } }] })
  await fs.writeFile(directory + '/edits.mjs', bundle.outputFiles[0].text)
  const { prepareWebsiteEdit, applyWebsiteEdits, generateWebsite } = await import(pathToFileURL(directory + '/edits.mjs'))
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
  // Exercise the actual API boundary: even tiny documents are edits, and no
  // large source can be silently sliced before the generator receives it.
  const handlerBundle = await build({ entryPoints: ['api/design.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'services', setup(b) {
    b.onResolve({ filter: /^\.\/(?:_websiteGeneration|_db|_limits|_grounding|web)$/ }, args => ({ path: args.path, namespace: 'service' }))
    b.onLoad({ filter: /.*/, namespace: 'service' }, ({ path }) => ({ contents:
      path === './_websiteGeneration' ? 'export class WebsiteRuntimeUnavailableError extends Error{};export const WEBSITE_SYSTEM="fixture";export const generateWebsite=options=>globalThis.handlerFixture(options);' :
      path === './_db' ? 'export const identityForRequest=async()=>null;export const identityBlock=()=>"";' :
      path === './_limits' ? 'export const reserveStudioQuota=async()=>({ok:true,release:async()=>{globalThis.quotaReleased++}});export const studioLimitMessage=()=>"limit";' :
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
        assert.ok(!options.user.includes(previous), 'source has one canonical copy in the generator, not duplicated in the request context')
        return { html: previous, review: { issues: [], scripts: 0, links: 0, controls: 0 }, repaired: false }
      }
      const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
      await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Update the title', prevHtml: previous } }, res)
      assert.equal(res.code, 200)
      assert.equal(res.payload.html, previous)
    }
    globalThis.quotaReleased = 0
    globalThis.handlerFixture = async () => null
    const res = { code: 0, setHeader() {}, status(code) { this.code = code; return this }, json(payload) { this.payload = payload } }
    await handler({ method: 'POST', headers: {}, body: { kind: 'webpage', prompt: 'Update the title', prevHtml: original } }, res)
    assert.equal(res.code, 502)
    assert.equal(globalThis.quotaReleased, 1, 'failed edits refund their generation quota')
    assert.match(res.payload.error, /existing design is preserved/)
  } finally { if (originalKey === undefined) delete process.env.TINKER_API_KEY; else process.env.TINKER_API_KEY = originalKey }
  console.log('PASS: tiny edits, large source and tail preservation, duplicated embedded assets, literal Unicode/replacement bytes, atomic rejection, and extended-context routing')
} finally { delete globalThis.editFixture; delete globalThis.handlerFixture; delete globalThis.quotaReleased; await fs.rm(directory, { recursive: true, force: true }) }
