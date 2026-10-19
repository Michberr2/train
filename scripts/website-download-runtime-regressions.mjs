// The actual runtime orchestration with an in-memory Playwright transport.
// No browser is launched: these assertions do not prove Chromium downloads.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const directory = await mkdtemp(join(process.cwd(), 'scripts/.website-download-runtime-'))
let fixture
const launch = async () => {
  const page = new EventEmitter()
  let width = 1440, clickIndex = 0
  const timers = new Set()
  const recordDownload = entry => {
    const download = {
      suggestedFilename: () => entry.name || 'ledger.csv',
      cancel: async () => { fixture.cancelled++ },
      createReadStream: async () => {
        fixture.reads++
        if (entry.error) throw new Error('private provider detail')
        return Readable.from((async function* () {
          if (entry.readDelay) await new Promise(resolve => setTimeout(resolve, entry.readDelay))
          yield Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? '')
        })())
      },
    }
    page.emit('download', download)
  }
  const control = {
    click: async () => {
      const entries = fixture.click({ width, index: clickIndex++ })
      for (const entry of entries) {
        if (entry.delay) {
          const timer = setTimeout(() => { timers.delete(timer); recordDownload(entry) }, entry.delay)
          timers.add(timer)
        } else recordDownload(entry)
      }
    },
    fill: async () => {}, selectOption: async () => {}, press: async () => {}, check: async () => {}, uncheck: async () => {},
    innerText: async () => fixture.text ?? '200',
    isVisible: async () => fixture.visible !== false,
  }
  const frame = {
    getByRole: () => control, getByLabel: () => control,
    locator: () => ({ ...control, waitFor: async () => {}, evaluate: async () => false, evaluateAll: async () => true }),
  }
  Object.assign(page, {
    setViewportSize: async size => { width = size.width; clickIndex = 0 },
    setContent: async () => {},
    locator: () => ({ evaluate: async () => {} }),
    frameLocator: () => frame,
    waitForTimeout: async () => {},
    waitForEvent: (event, options) => new Promise((resolve, reject) => {
      const listener = item => {
        if (!options.predicate(item)) return
        clearTimeout(timer); page.off(event, listener); resolve(item)
      }
      const timer = setTimeout(() => { page.off(event, listener); reject(new Error('No matching download arrived.')) }, Math.min(options.timeout, 30))
      page.on(event, listener)
    }),
    close: async () => { for (const timer of timers) clearTimeout(timer); timers.clear() },
  })
  const context = {
    addInitScript: async () => {}, route: async () => {}, routeWebSocket: async () => {},
    setDefaultTimeout: () => {}, newPage: async () => page, on: () => {}, pages: () => [page],
  }
  return { newContext: async () => context, contexts: () => [context], close: async () => { fixture.closed++ } }
}
globalThis.downloadRuntimeLaunch = launch
try {
  const result = await build({ entryPoints: ['api/_websiteRuntime.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, plugins: [{ name: 'in-memory-download-transport', setup(b) {
    b.onResolve({ filter: /^playwright-core$/ }, () => ({ path: 'fixture', namespace: 'download-transport' }))
    b.onLoad({ filter: /.*/, namespace: 'download-transport' }, () => ({ contents: 'export const chromium={launch:()=>globalThis.downloadRuntimeLaunch()}' }))
  } }] })
  await writeFile(join(directory, 'runtime.mjs'), result.outputFiles[0].text)
  const { reviewWebsiteRuntime, inspectRuntimeTests } = await import(pathToFileURL(join(directory, 'runtime.mjs')))
  const csv = { format: 'csv', equals: [['description', 'amount'], ['Coffee, "large"', '5.00']] }
  const expectation = { type: 'download', value: 'ledger.csv', content: csv }
  const journey = { name: 'Export contains the entered record', steps: [{ action: 'click', target: { role: 'button', name: 'Export' } }], expect: [expectation] }
  const correct = 'description,amount\r\n"Coffee, ""large""",5.00\r\n'
  const run = async (entries, tests = [journey], state = {}) => {
    fixture = { ...state, click: typeof entries === 'function' ? entries : () => entries, reads: 0, cancelled: 0, closed: 0 }
    const report = await reviewWebsiteRuntime('<!doctype html><html><body><button>Export</button></body></html>', tests, { deadlineMs: Date.now() + 22000 })
    assert.equal(fixture.closed, 1, 'Every synthetic renderer closes after verification')
    return report
  }
  assert.equal(inspectRuntimeTests([journey]).issues.length, 0)
  for (const bad of [null, { format: 'html', equals: 'bad' }, { format: 'csv', equals: [[5]] }, { format: 'text', equals: 'ok', evaluate: 'arbitrary()' }]) {
    assert.equal(inspectRuntimeTests([{ ...journey, expect: [{ ...expectation, content: bad }] }]).tests.length, 0)
  }
  assert.equal(inspectRuntimeTests([{ ...journey, expect: [{ type: 'text', target: { selector: 'h1' }, value: 'Hi', content: csv }] }]).tests.length, 0)
  assert.equal(inspectRuntimeTests([{ ...journey, expect: [{ type: 'download', value: '' }] }]).tests.length, 0)

  const target={selector:'#history'}
  const pair=(left,right)=>[{...journey,expect:[left,right]}]
  const conflictingPairs=[
    [{type:'text',target,value:'M1'},{type:'text',target,value:'M1 C10 North South 2 Move cable'}],
    [{type:'value',target,value:' 200 '},{type:'value',target,value:'200'}],
    [{type:'count',target,value:1},{type:'count',target,value:2}],
    [{type:'checked',target,value:false},{type:'checked',target,value:true}],
    [{type:'hash',value:'#history'},{type:'hash',value:'#summary'}],
    [{type:'visible',target},{type:'hidden',target}],
    [{type:'hidden',target},{type:'visible',target}],
    [{type:'text',target:{role:'status',name:'History'},value:'M1'},{type:'text',target:{name:'History',role:'status'},value:'M2'}],
    [{type:'text',target:{label:'History',selector:'#first'},value:'M1'},{type:'text',target:{label:'History',selector:'#second'},value:'M2'}],
  ]
  for(const [left,right] of conflictingPairs){
    const parsed=inspectRuntimeTests(pair(left,right))
    assert.deepEqual(parsed.tests,[],'Conflicting post-action assertions cannot freeze into a durable test contract')
    assert.match(parsed.issues.join('\n'),/runtimeTests\[0\]\.expect\[1\]: conflicts with expect\[0\]/)
    assert.doesNotMatch(parsed.issues.join('\n'),/Move cable|North|South|#history|#summary/,'Conflict diagnostics include fixed schema paths, not generated values')
  }
  for(const [left,right] of [
    [{type:'text',target,value:'M1\n C10'},{type:'text',target,value:' M1\tC10 '}],
    [{type:'value',target,value:'200'},{type:'value',target,value:'200'}],
    [{type:'count',target,value:0},{type:'count',target,value:0}],
    [{type:'checked',target,value:false},{type:'checked',target,value:false}],
    [{type:'hash',value:'#history'},{type:'hash',value:'#history'}],
    [{type:'visible',target},{type:'visible',target}],
    [{type:'text',target:{selector:'#one'},value:'M1'},{type:'text',target:{selector:'#two'},value:'M2'}],
    [{type:'text',target:{label:'History'},value:'M1'},{type:'text',target:{selector:'#history'},value:'M2'}],
    [{type:'text',target,value:''},{type:'value',target,value:'200'}],
    [{type:'value',target,value:'200'},{type:'visible',target}],
    [expectation,{...expectation,content:{...csv,equals:[['description','amount'],['Another','5.00']]}}],
  ])assert.equal(inspectRuntimeTests(pair(left,right)).issues.length,0,'Only definite contradictions in the same observation are rejected')
  assert.equal(inspectRuntimeTests([{...journey,expect:[conflictingPairs[0][0]]},{...journey,expect:[conflictingPairs[0][1]]}]).issues.length,0,'Independent journeys may legitimately expect different final states')
  for(const invalidTarget of [undefined,{}, {label:27,selector:'#history'}, {role:'invalid',name:'History',selector:'#history'}]){
    const parsed=inspectRuntimeTests(pair({type:'text',target:invalidTarget,value:'M1'},{type:'text',target:invalidTarget,value:'M2'}))
    assert.ok(parsed.issues.every(issue=>!issue.includes('conflicts with')),'Invalid or unusable effective targets cannot collide under a fallback key')
  }

  const good = await run([{ bytes: correct }])
  assert.equal(good.status, 'passed', JSON.stringify(good))
  assert.deepEqual(good.widths, [1440, 390])
  assert.equal(fixture.reads, 2, 'Export bytes are checked at both widths')
  for (const bytes of ['', 'description,amount\n', correct.replace('5.00', '50.00'), correct + 'Extra,1.00\n', 'description,amount\n"unterminated,5.00', Buffer.from([0xff, 0xfe])]) {
    const report = await run([{ bytes }])
    assert.equal(report.status, 'failed', JSON.stringify(report))
    assert.equal(report.checks.filter(check => !check.passed).length, 2)
    assert.ok(report.issues.every(issue => !issue.detail.includes('Coffee')), 'Failure logs do not expose export contents')
  }
  const legacy = await run([{ bytes: '' }], [{ ...journey, expect: [{ type: 'download', value: 'ledger.csv' }] }])
  assert.equal(legacy.status, 'partial', 'Filename-only compatibility must not claim the export contents passed')
  assert.equal(fixture.reads, 0)
  assert.match(legacy.limitations.join(' '), /only filenames/)
  assert.equal((await run([{ bytes: correct, delay: 5 }])).status, 'passed', 'A download event arriving after click completion is awaited')
  assert.equal((await run([])).status, 'failed', 'A missing export fails its journey')
  assert.equal((await run([{ bytes: correct }, { bytes: correct }])).status, 'failed', 'Ambiguous matching files cannot hide an incorrect export')
  assert.equal((await run([{ bytes: correct, readDelay: 20 }, { bytes: 'corrupt late duplicate', delay: 5 }])).status, 'failed', 'A corrupt duplicate arriving while the first file is read cannot hide behind the valid file')
  assert.equal((await run([{ bytes: correct, readDelay: 20 }, ...Array.from({ length: 8 }, (_, i) => ({ name: 'extra-' + i + '.txt', bytes: 'extra', delay: 5 }))])).status, 'failed', 'Download overflow during reading is rechecked after the read')
  assert.equal((await run(Array(9).fill({ bytes: correct }))).status, 'failed', 'A flood of files is bounded and rejected')
  assert.ok(fixture.cancelled >= 18)
  const failedRead = await run([{ error: true }])
  assert.equal(failedRead.status, 'failed')
  assert.ok(failedRead.issues.every(issue => !issue.detail.includes('private provider detail')))
  const repeated = await run([{ bytes: correct }], [{ ...journey, expect: [expectation, expectation] }])
  assert.equal(repeated.status, 'passed')
  assert.equal(fixture.reads, 2, 'Repeated assertions reuse bounded bytes rather than re-reading the file')
  const independent = await run(({ index }) => index === 0 ? [{ bytes: correct }] : [], [journey, { ...journey, name: 'Second export' }])
  assert.equal(independent.status, 'failed')
  assert.equal(independent.checks.filter(check => !check.passed).length, 2, 'A prior journey download cannot satisfy a later missing export')
  const jsonJourney = { ...journey, expect: [{ type: 'download', value: 'data.json', content: { format: 'json', equals: { total: 5, items: ['Coffee'] } } }] }
  assert.equal((await run([{ name: 'data.json', bytes: '{"items":["Coffee"],"total":5}' }], [jsonJourney])).status, 'passed')
  assert.equal((await run([{ name: 'data.json', bytes: '{"items":["Coffee"],"total":"5"}' }], [jsonJourney])).status, 'failed')
  const textJourney = { name: 'Show the calculated total', steps: [{ action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: '200' }] }
  assert.equal((await run([], [textJourney])).status, 'passed')
  const hiddenResult = await run([], [textJourney], { visible: false })
  assert.equal(hiddenResult.status, 'failed')
  for (const issue of hiddenResult.issues) {
    assert.match(issue.detail, /not visible|hidden/i, 'Repair feedback must identify hidden output even when its text is numerically correct')
    assert.match(issue.detail, /#result/, 'Repair feedback identifies the affected output')
  }
  const incorrectResult = await run([], [textJourney], { text: '2000' })
  assert.equal(incorrectResult.status, 'failed')
  assert.ok(incorrectResult.issues.every(issue => issue.detail.includes('expected "200", observed "2000"')), 'Visible value mismatches retain their useful expected/actual feedback')
  for(const [expected,observed] of [['200','2000'],['M1','M10'],['200','200.00'],['200','200,000'],['200','200%'],['200','200 %'],['200','0.200'],['200','-200'],['M1','AM1'],['M1','M1_extra']]){
    const mismatch=await run([],[{...textJourney,expect:[{...textJourney.expect[0],value:expected}]}],{text:observed})
    assert.equal(mismatch.status,'failed')
    assert.ok(mismatch.issues.every(issue=>!issue.detail.includes('scope mismatch')),`${expected} vs ${observed}: an embedded or extended value is ordinary wrong-value feedback`)
  }
  const prefixedDate=await run([],[{...textJourney,expect:[{...textJourney.expect[0],value:'2028-03-01'}]}],{text:'Due date: 2028-03-01'})
  assert.equal(prefixedDate.status,'failed')
  assert.ok(prefixedDate.issues.every(issue=>issue.detail.includes('Possible container-versus-field target scope mismatch')),'A separately displayed exact date with a surrounding label remains a possible scope mismatch')
  const historyJourney={...textJourney,name:'Show the transfer ID',expect:[{type:'text',target:{selector:'#history'},value:'M1'}]}
  const composite=await run([], [historyJourney],{text:'M1 — C10 North→South qty 2 Move cable [undone]'})
  assert.equal(composite.status,'failed','Composite text still fails exact comparison; no substring-based pass is introduced')
  for(const issue of composite.issues){
    assert.match(issue.detail,/Possible container-versus-field target scope mismatch/)
    assert.match(issue.detail,/Preserve requested neighboring fields/)
    assert.match(issue.detail,/expected "M1", observed/)
  }
  const longComposite=await run([], [historyJourney],{text:'M1 '+ 'Original field notes. '.repeat(100)})
  assert.ok(longComposite.issues.every(issue=>issue.detail.includes('Preserve requested neighboring fields')),'The scope hint survives bounded diagnostic truncation')
  const differentText=await run([], [historyJourney],{text:'No transfers yet'})
  assert.ok(differentText.issues.every(issue=>!issue.detail.includes('scope mismatch')),'Unrelated failures do not claim a target-scope cause')
  const emptyText=await run([], [{...historyJourney,expect:[{...historyJourney.expect[0],value:''}]}],{text:'M1'})
  assert.ok(emptyText.issues.every(issue=>!issue.detail.includes('scope mismatch')),'Empty expectations cannot match every observed result')
  assert.equal((await run([], [historyJourney],{text:' M1\n\t'})).status,'passed','Exact normalized matching remains unchanged')
  console.log('PASS runtime orchestration: contradictory post-action expectations rejected; normalized duplicates and independent states retained; composite-text scope hints preserve exact failure semantics; download content at both widths, corrupt/empty/missing exports, filename-only partial status, delayed events, bounds, fresh journeys and cleanup. In-memory transport only; no browser launched.')
} finally {
  delete globalThis.downloadRuntimeLaunch
  await rm(directory, { recursive: true, force: true })
}
