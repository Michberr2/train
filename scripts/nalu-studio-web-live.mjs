// Real web Studio and model calls, with an isolated account/data fixture only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {chromium, expect} from '@playwright/test'

const base=process.argv[2]
assert.ok(base?.startsWith('https://'), 'Supply the deployment URL')
const out=process.env.OUTPUT_DIR || `/tmp/nalu-studio-repair/live/${new URL(base).hostname}`
await fs.mkdir(out,{recursive:true})
const browser=await chromium.launch()
const report={base,passed:false,requests:[],errors:[],checks:[]}
const context=await browser.newContext({viewport:{width:1280,height:900}})
const page=await context.newPage()
page.setDefaultTimeout(15000)
page.on('pageerror',error=>report.errors.push(error.message))
await context.addInitScript(()=>{
 if(window!==window.top)return
 localStorage.setItem('nalu-token','isolated-live-studio')
 localStorage.setItem('nalu-data-owner','isolated-live-studio')
 localStorage.setItem('nalu-view','studio')
})
await context.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname
 if(path==='/api/auth')return route.fulfill({json:{ok:true,user:{id:'isolated-live-studio',displayName:'Studio review'}}})
 if(path==='/api/data')return route.fulfill({json:{ok:true,data:{},tasks:[],items:[]}})
 // Prevent fake authentication from being sent to any live service. Public
 // generation is exercised through the same request body as the actual UI.
 const headers={...route.request().headers()};delete headers.authorization
 report.requests.push({path,action:route.request().postDataJSON()?.action})
 return route.continue({headers})
})
try {
 await page.goto(base,{waitUntil:'domcontentloaded'})
 await page.getByLabel('Studio tool',{exact:true}).selectOption({label:'Website'})
 await page.getByLabel('Your idea',{exact:true}).fill('Build a complete, compact expense tracker web app called Pocket Ledger. Use an ivory background, charcoal text, slim fonts, and muted green accents. This must be a working app, with no marketing hero. No external libraries, network requests, or login. Start with no expenses. Provide visible associated labels Description, Amount, Category. Category options Food, Transport, Other. Add expense submits a positive amount and nonempty description; reject zero, negative, and blank values. Show Total spent with aria-label="Total spent", calculated from ALL expenses, even when filtering. Add a select labelled Filter category with All, Food, Transport, Other. Each row has a Delete button that updates the total. Export CSV downloads all expenses, including filtered-out ones. Escape CSV values correctly. Keep data in memory so it works in a sandbox. Fully responsive without horizontal overflow at 390px. Use your best judgment and build it now; no clarifying questions.')
 const started=Date.now()
 const generation=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/design'&&r.request().method()==='POST',{timeout:295000})
 await page.getByRole('button',{name:'Generate',exact:true}).click()
 const response=await generation
 const data=await response.json()
 report.generation={status:response.status(),elapsedMs:Date.now()-started,quality:data.quality}
 await fs.writeFile(`${out}/response.json`,JSON.stringify(data,null,2))
 assert.equal(response.status(),200,data.error)
 assert.ok(data.html?.includes('</html>'))
 assert.equal(data.quality?.runtime?.status,'passed','Server must run the planned interactions in bundled Chromium')
 assert.deepEqual(data.quality.runtime.widths,[1440,390])
 assert.ok(data.quality.runtime.checks.length>4,'Both widths must include interaction checks')
 assert.ok(data.quality.runtime.checks.every(check=>check.passed))
 await expect(page.locator('.ws-studio-preview summary').filter({hasText:'Built · browser checks passed'})).toBeVisible()
 report.checks.push('Deployed Chromium executed planned desktop/mobile interactions and UI shows matching result')
 await fs.writeFile(`${out}/website.html`,data.html)
 const app=page.locator('.ws-studio-preview').frameLocator('iframe').first()
 // A labelled summary region can contain the separately labelled value.
 const description=app.getByLabel('Description',{exact:true}),amount=app.getByLabel('Amount',{exact:true}),category=app.getByLabel('Category',{exact:true}),total=app.getByLabel('Total spent',{exact:true}).last()
 await description.waitFor({timeout:30000})
 await expect(total).toContainText(/0[.,]00|^\D*0\D*$/)
 const add=async(text,cost,group)=>{await description.fill(text);await amount.fill(cost);await category.selectOption({label:group});await app.getByRole('button',{name:'Add expense',exact:false}).click()}
 await add('Lunch audit','10','Food');await expect(total).toContainText(/10[.,]00/)
 await add('Train audit','25','Transport');await expect(total).toContainText(/35[.,]00/)
 report.checks.push('Add expenses and calculate total')
 await app.getByLabel('Filter category',{exact:true}).selectOption({label:'Food'})
 await expect(app.getByText('Train audit',{exact:true})).toBeHidden()
 await expect(app.getByText('Lunch audit',{exact:true})).toBeVisible()
 await expect(total).toContainText(/35[.,]00/)
 report.checks.push('Filter retains full total')
 await app.getByRole('button',{name:/delete/i}).first().click()
 await expect(total).toContainText(/25[.,]00/)
 report.checks.push('Delete recalculates total')
 const [download]=await Promise.all([page.waitForEvent('download'),app.getByRole('button',{name:/export.*csv/i}).click()])
 const csv=await fs.readFile(await download.path(),'utf8')
 assert.ok(csv.includes('Train audit'));assert.ok(!csv.includes('Lunch audit'))
 report.checks.push('CSV includes filtered-out expenses')
 await add('Invalid audit','-5','Food');await expect(total).toContainText(/25[.,]00/)
 await expect(app.getByText('Invalid audit',{exact:true})).toHaveCount(0)
 report.checks.push('Reject invalid amount')
 await page.screenshot({path:`${out}/desktop.png`})
 await page.setViewportSize({width:390,height:844})
 if(await page.getByRole('button',{name:'Preview',exact:true}).isVisible())await page.getByRole('button',{name:'Preview',exact:true}).click()
 assert.equal(await app.locator('html').evaluate(el=>el.scrollWidth>innerWidth+2),false)
 report.checks.push('Phone preview has no horizontal overflow')
 await page.screenshot({path:`${out}/phone.png`})
 await expect(page.getByRole('button',{name:'Stop generation',exact:true})).toHaveCount(0)
 assert.deepEqual(report.errors,[])
 report.passed=true
 console.log(JSON.stringify(report))
} finally {
 await fs.writeFile(`${out}/report.json`,JSON.stringify(report,null,2))
 await browser.close()
}
