import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const root=dirname(dirname(fileURLToPath(import.meta.url))),temp=await mkdtemp(join(root,'scripts','.fund-risk-'))
try{
  const bundled=await build({stdin:{resolveDir:root,contents:"export * from './shared/hedgeFundRisk';export {HEDGE_FUND_ROLES,hedgeFundTeam} from './client/src/components/workspace/hedgeFund';"},bundle:true,write:false,platform:'node',format:'esm',packages:'external'})
  const path=join(temp,'risk.mjs');await writeFile(path,bundled.outputFiles[0].text)
  const {parseFundRiskPolicy,validateFundDecisions,guardHedgeFundOutput,hedgeFundOutputContract,HEDGE_FUND_ROLES}=await import(pathToFileURL(path).href)
  const now=Date.parse('2026-10-18T12:00:00Z'),quoteTime='2026-10-18T11:59:00Z'
  const policy={schema:'nalu-fund-risk-v1',currency:'USD',asOf:quoteTime,equity:100000,cash:80000,minCash:20000,maxPositionPct:40,maxSectorPct:55,maxGrossExposurePct:80,maxQuoteAgeHours:1,tradeCostBps:10,allowShort:false,shortMarginPct:150,positions:[{ticker:'ABC',quantity:100,price:100,priceAsOf:quoteTime,priceSource:'User supplied fixture quote',sector:'Technology',maxShares:350},{ticker:'XYZ',quantity:50,price:200,priceAsOf:quoteTime,priceSource:'User supplied fixture quote',sector:'Consumer',maxShares:200},{ticker:'DEF',quantity:0,price:100,priceAsOf:quoteTime,priceSource:'User supplied fixture quote',sector:'Technology',maxShares:350}]}
  const trusted=parseFundRiskPolicy(JSON.stringify(policy),now),buy=(ticker,quantity)=>({ticker,action:'buy',quantity,reasoning:'Research case with explicit source assumptions.'})
  const checked=validateFundDecisions([buy('ABC',100),buy('XYZ',50)],trusted)
  assert.equal(checked.cashAfter,59980);assert.equal(checked.fees,20);assert.equal(checked.grossExposure,40000);assert.equal(checked.equityAfterFees,99980)
  assert.throws(()=>validateFundDecisions([buy('ABC',251)],trusted),/share cap/)
  assert.throws(()=>validateFundDecisions([buy('ABC',300)],{...trusted,positions:trusted.positions.map(p=>({...p,maxShares:1000}))}),/position exposure/)
  assert.throws(()=>validateFundDecisions([buy('ABC',200),buy('DEF',300)],trusted),/sector exposure/)
  assert.throws(()=>validateFundDecisions([buy('ABC',100),buy('XYZ',100)],{...trusted,maxGrossExposurePct:30}),/gross exposure/)
  assert.throws(()=>validateFundDecisions([buy('ABC',100)],{...trusted,minCash:75000}),/cash reserve/)
  assert.throws(()=>validateFundDecisions([buy('NOPE',1)],trusted),/No user-supplied/)
  assert.throws(()=>validateFundDecisions([buy('ABC',1),buy('ABC',2)],trusted),/Duplicate/)
  assert.throws(()=>validateFundDecisions([buy('ABC',NaN)],trusted),/quantity/)
  assert.throws(()=>validateFundDecisions([buy('ABC',1.5)],trusted),/whole share/)
  assert.throws(()=>validateFundDecisions([{...buy('ABC',1),action:'hold'}],trusted),/Hold/)
  assert.throws(()=>validateFundDecisions([{...buy('ABC',101),action:'sell'}],trusted),/more ABC/)
  assert.throws(()=>validateFundDecisions([{...buy('ABC',1),action:'cover'}],trusted),/more ABC/)
  assert.throws(()=>validateFundDecisions([{...buy('DEF',1),action:'short'}],trusted),/not allowed/)
  const shortPolicy={...trusted,allowShort:true,positions:trusted.positions.map(p=>({...p,borrowLimitShares:100}))}
  assert.equal(validateFundDecisions([{...buy('DEF',50),action:'short'}],shortPolicy).cashAvailableAfterCollateral,77495)
  assert.throws(()=>validateFundDecisions([{...buy('DEF',101),action:'short'}],shortPolicy),/borrow limit/)
  const shortHolding={...shortPolicy,positions:shortPolicy.positions.map(p=>p.ticker==='DEF'?{...p,quantity:-50}:p),cash:85000}
  assert.equal(validateFundDecisions([{...buy('DEF',50),action:'cover'}],shortHolding).cashAfter,79995)
  assert.throws(()=>validateFundDecisions([{...buy('DEF',51),action:'cover'}],shortHolding),/more DEF/)
  for(const patch of [{equity:100001},{cash:'80000'},{allowShort:'false'},{maxPositionPct:101},{maxQuoteAgeHours:0},{asOf:'2026-10-17T00:00:00Z'},{currency:'dollars'}])assert.throws(()=>parseFundRiskPolicy(JSON.stringify({...policy,...patch}),now))
  for(const patch of [{priceAsOf:'2026-10-17T00:00:00Z'},{price:0},{priceSource:''},{sector:''},{quantity:Infinity}])assert.throws(()=>parseFundRiskPolicy(JSON.stringify({...policy,positions:[{...policy.positions[0],...patch},...policy.positions.slice(1)]}),now))
  const proposal=(decisions)=>JSON.stringify({schema:'nalu-fund-proposal-v1',summary:'Research thesis; source details and uncertainties.',decisions})
  const guarded=JSON.parse(guardHedgeFundOutput('hf-portfolio',proposal([buy('ABC',100)]),{policyText:JSON.stringify(policy),now}))
  assert.equal(guarded.status,'proposal-within-user-limits');assert.equal(guarded.execution,'none');assert.equal(guarded.decisions[0].quantity,100)
  assert.equal(JSON.parse(guardHedgeFundOutput('hf-portfolio',proposal([]))).status,'research-only')
  assert.throws(()=>guardHedgeFundOutput('hf-portfolio',proposal([buy('ABC',100)])),/user-attached/)
  assert.throws(()=>guardHedgeFundOutput('hf-portfolio','Buy 10 ABC'),/structured JSON/)
  assert.throws(()=>guardHedgeFundOutput('hf-portfolio',JSON.stringify({schema:'nalu-fund-checked-v1',decisions:[]})),/required proposal/)
  assert.equal(guardHedgeFundOutput('ceo','unrelated output'),'unrelated output')
  assert.match(guardHedgeFundOutput('hf-risk','Advisory limits'),/NO PORTFOLIO POLICY/)
  assert.match(hedgeFundOutputContract('hf-portfolio'),/decisions:\[\]/)
  assert.ok(HEDGE_FUND_ROLES.every(r=>r.charter.includes('uncalibrated')))
  assert.ok(HEDGE_FUND_ROLES.every(r=>!r.charter.includes('confidence 0-100')))
  console.log('PASS hedge-fund risk checks: policy provenance, quote freshness, equity reconciliation, aggregate cash/fees/position/sector/gross exposure, holdings/borrow/collateral, structured proposals and research-only fallback.')
}finally{await rm(temp,{recursive:true,force:true})}
