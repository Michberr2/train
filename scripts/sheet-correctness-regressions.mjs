// Offline actual-handler and real XLSX regressions; no paid calls or credentials.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(root, 'scripts', '.sheet-correctness-'))
const originalFetch = globalThis.fetch, originalKey = process.env.TINKER_API_KEY
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks++ }
try {
  process.env.TINKER_API_KEY = 'offline-only'
  globalThis.fetch = async () => { throw new Error('Unexpected network request') }
  const bundled = await build({
    stdin: { resolveDir: root, contents: `export {buildEvaluator} from './client/src/components/workspace/formulaEval'; export {buildWorkbookBlob} from './client/src/components/workspace/SheetCard'; export {normalizeSheets,guardFormula} from './api/_validate'; export {default as sheet} from './api/sheet';` },
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'offline-services', setup(build) {
      build.onResolve({ filter: /^\.\/_db$|^\.\/_limits$|^\.\/_grounding$|^\.\/_llm$/ }, (args) => ({ path: args.path, namespace: 'offline' }))
      build.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents:
        path === './_db' ? 'export async function identityForRequest(){return null};export function identityBlock(){return ""}' :
        path === './_grounding' ? 'export async function groundFromPrompt(){return ""}' :
        path === './_limits' ? 'export async function reserveStudioQuota(){globalThis.__sheet.reserved++;return {ok:true,release:async()=>globalThis.__sheet.refunds++}};export function studioLimitMessage(){return "limit"}' :
        `export const primaryProvider=()=>({model:'offline'}), fallbackProvider=()=>null, emergencyProvider=()=>null; export async function chatCompleteContinued(messages){const t=globalThis.__sheet;t.calls.push(messages);const next=t.responses.shift();if(next instanceof Error||next==null)throw next||new Error('offline outage');return {content:typeof next==='string'?next:JSON.stringify(next)}}`,
      }))
    }}],
  })
  const modulePath = join(temp, 'test.mjs'); await writeFile(modulePath, bundled.outputFiles[0].text)
  const { buildEvaluator, buildWorkbookBlob, normalizeSheets, guardFormula, sheet } = await import(pathToFileURL(modulePath).href)
  const single = (formula, extra = []) => buildEvaluator([{ name: 'Calc', columns: ['Formula'], rows: [[formula]] }, ...extra]).result(0, 0, 0)
  const expect = (formula, expected) => { const r = single(formula); assert.equal(r.status, 'value', `${formula}: ${JSON.stringify(r)}`); assert.equal(r.value, expected, formula); checks++ }
  const approx = (formula, expected, tolerance = 1e-7) => { const r = single(formula); check(r.status === 'value' && typeof r.value === 'number' && Math.abs(r.value - expected) <= tolerance, `${formula}: ${JSON.stringify(r)}, expected ${expected}`) }
  for (const [formula, value] of [
    ['=ROUND(-1.5,0)', -2], ['=ROUND(1.5,0)', 2], ['=ROUND(1.005,2)', 1.01], ['=ROUND(-1.005,2)', -1.01], ['=ROUND(-125,-1)', -130],
    ['=ROUNDUP(-1.21,1)', -1.3], ['=ROUNDDOWN(-1.29,1)', -1.2], ['=TRUNC(-1.9)', -1], ['=ROUND(5.45,1.9)', 5.5],
    ['=50%*200', 100], ['=.5+1e2', 100.5], ['=2^3^2', 64], ['=1&2+3', '15'], ['=1+2&3', '33'], ['=IF(FALSE,1/0,7)', 7],
    ['=IFERROR(1/0,99)', 99], ['=IFERROR(SQRT(-1),88)', 88], ['=IFNA(MATCH(5,B2:B3,0),42)', 42], ['=PMT(0,10,1000)', -100],
    ['=FV(0,10,-100,0)', 1000], ['=PV(0,10,-100)', 1000], ['=NPER(0,-100,1000)', 10], ['=SUM("123",TRUE)', 124],
    ['="A"="a"', true], ['=COUNTIF(B:B,"*")', 0], ['=YEAR("2026-10-18")', 2026],
  ]) expect(formula, value)
  approx('=PMT(0.05/12,360,100000)', -536.8216230121399)
  approx('=IFERROR(PMT(0.05/12,360,100000),0)', -536.8216230121399)
  approx('=PMT(0.08/12,120,10000,0,1)', -120.52410035300355)
  approx('=FV(0.06/12,120,-100,0)', 16387.934680645)
  approx('=PV(0.05/12,360,-536.8216230121399)', 100000)
  approx('=NPER(0.05/12,-536.8216230121399,100000)', 360)
  approx('=IPMT(0.05/12,1,360,100000)', -416.6666666666667)
  approx('=PPMT(0.05/12,1,360,100000)', -120.1549563454732)
  approx('=IPMT(0.05/12,1,360,100000,0,1)', 0)
  approx('=RATE(360,-536.8216230121399,100000,0,0,0.01)', 0.05/12)
  approx('=NPV(0.1,100,200,300)', 481.59278737791124)
  const cash = [{ name: 'Cash', columns: ['Amount'], rows: [[-1000], [500], [600]] }]
  const irr = single('=IRR(Cash!A2:A4)', cash)
  check(irr.status === 'value' && Math.abs(-1000 + 500/(1+irr.value) + 600/(1+irr.value)**2) < 1e-6, 'IRR must zero the original cash flows')
  for (const [f, error] of [['=1/0','#DIV/0!'],['=SQRT(-1)','#NUM!'],['=Missing!A1','#REF!'],['=SUM(1,2','#VALUE!'],['=1+','#VALUE!'],['=1 2','#VALUE!'],['=ROUND(1)','#VALUE!'],['=ROUND(1,2,3)','#VALUE!'],['=IFNA(1/0,0)','#DIV/0!'],['=PMT(0,0,100)','#NUM!'],['=NPER(0,0,100)','#DIV/0!'],['=IRR(100)','#NUM!'],['=YEAR(-1)','#NUM!']]) {
    const result = single(f); check(result.status === 'error' && result.error === error, `${f}: ${JSON.stringify(result)}`)
  }
  for (const f of ['=UNKNOWN(1)', '=IFERROR(UNKNOWN(1),0)', '=A2', '=SUM(A1:XFD1048576)', '=IFERROR(SUM(A1:XFD1048576),0)']) check(single(f).status === 'unsupported', `${f} must never cache a made-up number`)
  const tab = { name: 'Data', columns: ['Label','Amount','Flag'], rows: [['Food',10,true],['Food','not numeric',false],['Fuel',30,true],['Food',20,false]] }
  const rangeCases = [ ['=SUM(Data!B2:B5)',60], ['=AVERAGEIF(Data!A2:A5,"Food",Data!B2:B5)',15], ['=SUMIF(Data!A2:A5,"F*",Data!B2:B5)',60], ['=COUNTIF(Data!C2:C5,TRUE)',2], ['=SUM(Data!C2:C5)',0], ['=SUM(Data!A2:A5)',0], ['=SUM(Data!$B:$B)',60], ['=INDEX(Data!A2:C5,2,1)','Food'], ['=VLOOKUP("Fuel",Data!A2:C5,2,FALSE)',30], ['=XLOOKUP("Food",Data!A2:A5,Data!B2:B5,0,0,-1)',20], ['=SUM(OFFSET(Data!B2,0,0,4,1))',60] ]
  for (const [f, expected] of rangeCases) { const r = single(f,[tab]); check(r.status==='value' && r.value===expected, `${f}: ${JSON.stringify(r)}`) }
  for (const [f, expected] of [['=COUNTIF(Data!B2:B5,">0")',3],['=SUMIF(Data!A2:A5,"Food",Data!B2)',30]]) { const r=single(f,[tab]); check(r.status==='value'&&r.value===expected, `${f}: ${JSON.stringify(r)}`) }
  const selective=single('=SUMIF(Errors!A2:A3,"good",Errors!B2:B3)',[{name:'Errors',columns:['Kind','Amount'],rows:[['good',12],['bad','=1/0']]}])
  check(selective.status==='value'&&selective.value===12,'SUMIF must not evaluate an unselected error cell')
  const shapeMismatch=single('=SUMIFS(Data!B2:B5,Data!A2:B3,"Food")',[tab])
  check(shapeMismatch.status==='error'&&shapeMismatch.error==='#VALUE!','SUMIFS requires matching shapes, not just equal cell counts')
  const propagated = buildEvaluator([{columns:['Input','Derived'],rows:[['=1/0','=SUM(A2:A2)'],['FY2026','=A3+1'],['=UNKNOWN(1)','=IFERROR(A4,0)']]}])
  check(propagated.result(0,0,1).error==='#DIV/0!', 'aggregate must propagate dependent errors')
  check(propagated.result(0,1,1).error==='#VALUE!', 'text must not coerce to digits')
  check(propagated.result(0,2,1).status==='unsupported', 'unsupported dependencies cannot be hidden by IFERROR')
  check(guardFormula('=PMT(0.05/12,360,100000)')==='=PMT(0.05/12,360,100000)', 'normalizer must not add IFERROR')
  const unresolved = normalizeSheets([{ name:'Calc', columns:['Amount'], rows:[['=@missing'],['=SUM(B{first}:B{last})']] }])
  check(unresolved[0].rows.every((r)=> typeof r[0]==='string' && r[0]!=='0'), 'unresolved templates must not become numeric zero')

  const complexName = "Owner's cash / forecast with long worksheet name"
  const named=normalizeSheets([{name:complexName,columns:['Value'],rows:[[12]]},{name:'Summary',columns:['Total','Literal'],rows:[[`='${complexName.replace(/'/g,"''")}'!A2*2`, '="Owner cash!"']]}])
  check(buildEvaluator(named).value(1,0,0)===24,'server normalization must preserve references through Excel worksheet-name changes')
  check(named[1].rows[0][1]==='="Owner cash!"','server normalization must preserve string literals')
  const unusual=normalizeSheets([{name:'P&L',columns:['Value'],rows:[[3]]},{name:'Summary',columns:['Formula','Literal'],rows:[['=P&L!A2','="P&L!A2"']]}])
  check(buildEvaluator(unusual).value(1,0,0)===3 && unusual[1].rows[0][1]==='="P&L!A2"','unquoted special names must be repaired without editing literals')
  const numeric=normalizeSheets([{name:'Inputs',columns:['Identifier','Malformed grouping','Amount'],rows:[['00123','12,34','$1,234.50']]}])
  assert.deepEqual(numeric[0].rows[0],['00123','12,34',1234.5]);checks++
  const doc = {title:'Formula correctness',sheets:[{name:'Calc',columns:['Result'],rows:[['=ROUND(-1.5,0)'],['=PMT(0.05/12,360,100000)'],['=1/0'],['=IFERROR(UNKNOWN(1),0)'],['=TRUE()'],['="Ready"']]}]}
  const blob = await buildWorkbookBlob(doc,null), bytes=await blob.arrayBuffer(), wb=new ExcelJS.Workbook()
  await wb.xlsx.load(bytes)
  const ws=wb.worksheets[0]
  check(ws.getCell('A2').result===-2,'XLSX must cache correct negative rounding')
  check(Math.abs(ws.getCell('A3').result+536.8216230121399)<1e-7,'XLSX must cache computed PMT')
  assert.deepEqual(ws.getCell('A4').result,{error:'#DIV/0!'});checks++
  check(ws.getCell('A5').formula==='IFERROR(UNKNOWN(1),0)' && ws.getCell('A5').result===undefined,'unsupported formula must export intact with no numeric cache')
  check(ws.getCell('A6').result===true,'XLSX boolean must remain typed boolean')
  check(ws.getCell('A7').result==='Ready','XLSX text result must stay intact')
  const zip=await JSZip.loadAsync(bytes), xml=await zip.file('xl/worksheets/sheet1.xml').async('string')
  check(/<c r="A4"[^>]*t="e"[^>]*>/.test(xml),'OOXML calculation error must have error cell type')
  check(!/<c r="A5"[^>]*>[\s\S]*?<v>/.test(xml.match(/<c r="A5"[^>]*>[\s\S]*?<\/c>/)[0]),'OOXML unsupported formula must not contain cached value')

  const previous={title:'Actual payroll',sheets:[{name:'Payroll',columns:['Employee','Pay'],rows:[['Actual employee',1250]]}]}
  const invoke=async(body,responses=[])=>{globalThis.__sheet={responses,calls:[],reserved:0,refunds:0};let code,data;const req={method:'POST',headers:{},body};const res={setHeader(){},status(n){code=n;return this},json(v){data=v;return this},end(){}};await sheet(req,res);return {code,data,state:globalThis.__sheet}}
  for(const body of [{prompt:'Payroll model'},{prompt:'Raise this pay by 5%',prevSheet:JSON.stringify(previous)}]){
    const r=await invoke(body)
    check(r.code===502 && r.data.code==='SHEET_GENERATION_FAILED','provider failure must not become HTTP200 invented workbook')
    check(!r.data.sheets && r.state.refunds===1,'failed generation must return no replacement and refund once')
    check(r.data.previousWorkbookPreserved===Boolean(body.prevSheet),'error must accurately state previous workbook preservation')
  }
  const invalid=await invoke({prompt:'Edit',prevSheet:'{"sheets":['});check(invalid.code===400 && invalid.state.calls.length===0 && invalid.state.reserved===0,'invalid/truncated edit must stop before generation/quota')
  const empty=await invoke({prompt:'Workbook'},[{tabs:[]},{sheets:[]},{sheets:[]}]);check(empty.code===502&&empty.state.refunds===1,'empty workbook is a failed generation')
  const bad={title:'Wrong calculations',sheets:[{name:'Calc',columns:['Value'],rows:[['=ROUND(1)']]}]}
  const broken=await invoke({prompt:'Edit payroll',prevSheet:JSON.stringify(previous)},[bad,bad]);check(broken.code===502&&broken.state.refunds===1,'invalid model calculations must never be published')
  check(broken.state.calls[1][1].content.includes('Wrong number of arguments for ROUND'),'calculation repair retry must include the actual failed check')
  const truncated=await invoke({prompt:'Edit payroll',prevSheet:JSON.stringify(previous)},['{"sheets":[{"name":"Payroll","columns":["Pay"],"rows":[[1250]]}']);check(truncated.code===502&&truncated.state.refunds===1,'truncated JSON must not be repaired into an incomplete successful edit')
  const result={title:'Loan',sheets:[{name:'Loan',columns:['Payment'],rows:[['=PMT(0.05/12,360,100000)']]}]}
  const success=await invoke({prompt:'Loan with principal 100000, interest 5%, 360 months'},[new Error('spec down'),result]);check(success.code===200&&success.state.refunds===0,'valid full fallback must succeed without refund');check(success.data.sheets[0].rows[0][0]==='=PMT(0.05/12,360,100000)','successful formula must not be hidden inside added IFERROR')
  check(success.state.calls.every((messages)=>messages[0].content.includes('illustrative assumption')),'every generation path must require explicit illustrative assumptions')
  console.log(`PASS ${checks} spreadsheet correctness checks: typed financial/error semantics, bounded strict parsing, actual XLSX caches and real handler failures/refunds.`)
}finally{
  globalThis.fetch=originalFetch
  if(originalKey==null)delete process.env.TINKER_API_KEY;else process.env.TINKER_API_KEY=originalKey
  delete globalThis.__sheet
  await rm(temp,{recursive:true,force:true})
}
