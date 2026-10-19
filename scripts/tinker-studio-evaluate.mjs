import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import {chromium,expect} from '@playwright/test'
const out='/tmp/nalu-studio-repair/models',report=[]
const numericTotal = async (locator, expected) => expect.poll(async () => {
 const text = (await locator.innerText()).trim()
 const tokens = text.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g) || []
 return tokens.length === 1 ? Number(tokens[0].replace(/,/g, '')) : NaN
}).toBe(expected)
const browser=await chromium.launch()
try{
 for(const id of (process.argv.length>2?process.argv.slice(2):['inkling-low','inkling-medium','inkling-high','kimi','glm'])){
  const html=await fs.readFile(`${out}/${id}-studio.html`,'utf8').catch(()=>'')
  if(!html)continue
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:900}}),errors=[],checks=[]
   page.setDefaultTimeout(2500)
   page.on('pageerror',e=>errors.push(e.message))
   await page.setContent('<style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe sandbox="allow-scripts allow-forms allow-downloads" title="Review"></iframe>')
   await page.locator('iframe').evaluate((el,value)=>el.srcdoc=value,html)
   const app=page.frameLocator('iframe')
   const check=async(name,fn)=>{try{await fn();checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:e.message.slice(0,250)})}}
   const desc=app.getByLabel('Description',{exact:true}),amount=app.getByLabel('Amount',{exact:true}),category=app.getByLabel('Category',{exact:true})
   const exactTotalLabel=await app.getByLabel('Total spent',{exact:true}).count()===1
   const total=app.getByLabel(/Total spent/i).first()
   await check('starts at zero',()=>numericTotal(total,0))
   await check('add first expense',async()=>{await desc.fill('Lunch audit');await amount.fill('10');await category.selectOption({label:'Food'});await app.getByRole('button',{name:'Add expense',exact:false}).click();await numericTotal(total,10);await expect(app.getByText('Lunch audit',{exact:true})).toBeVisible()})
   await check('add second expense',async()=>{await desc.fill('Train audit');await amount.fill('25');await category.selectOption({label:'Transport'});await app.getByRole('button',{name:'Add expense',exact:false}).click();await numericTotal(total,35)})
   await check('filter retains full total',async()=>{await app.getByRole('combobox',{name:/filter/i}).selectOption({label:'Food'});await expect(app.getByText('Train audit',{exact:true})).toBeHidden();await expect(app.getByText('Lunch audit',{exact:true})).toBeVisible();await numericTotal(total,35)})
   await check('delete recalculates',async()=>{await app.getByRole('button',{name:/delete/i}).first().click();await numericTotal(total,25)})
   await check('export includes hidden expense',async()=>{const [file]=await Promise.all([page.waitForEvent('download',{timeout:3000}),app.getByRole('button',{name:/export.*csv/i}).click()]);const path=await file.path();const csv=await fs.readFile(path,'utf8');assert.ok(csv.includes('Train audit'));assert.ok(!csv.includes('Lunch audit'))})
   await check('reject negative amount',async()=>{await desc.fill('Invalid audit');await amount.fill('-5');await app.getByRole('button',{name:'Add expense',exact:false}).click();await numericTotal(total,25);await expect(app.getByText('Invalid audit',{exact:true})).toHaveCount(0)})
   await check('no horizontal overflow',async()=>assert.equal(await app.locator('html').evaluate(el=>el.scrollWidth>innerWidth+2),false))
   await page.screenshot({path:`${out}/${id}-${width}.png`})
   report.push({id,width,checks,errors,exactTotalLabel,passed:checks.every(c=>c.passed)&&!errors.length})
   console.log(JSON.stringify({id,width,passed:checks.filter(c=>c.passed).length,total:checks.length,errors,failures:checks.filter(c=>!c.passed).map(c=>c.name)}))
   await page.close()
  }
 }
}finally{await fs.writeFile(out+(process.argv.length>2?'/functional-'+process.argv.slice(2).join('-')+'.json':'/functional-report.json'),JSON.stringify(report,null,2));await browser.close()}

if (!report.length || report.some(item => !item.passed)) process.exitCode = 1
