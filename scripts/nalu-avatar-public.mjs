import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {chromium} from '@playwright/test'
const bases=process.argv.slice(2)
assert.ok(bases.length)
const output=process.env.OUTPUT_DIR||'/tmp/nalu-avatar-verification'
await fs.mkdir(output,{recursive:true})
const original=await fs.readFile(new URL('../shared/nalu-avatar/nalu-avatar.png',import.meta.url))
const browser=await chromium.launch(),report=[]
try{
 for(const base of bases){
  const url=new URL(base);assert.ok(url.protocol==='https:'&&(/\.vercel\.app$/.test(url.hostname)||['n4lu.ai','n4lu.com'].includes(url.hostname)))
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[]
  page.on('pageerror',e=>errors.push(e.message))
  const response=await page.goto(base);assert.equal(response.status(),200)
  await page.getByRole('button',{name:'Play with friends',exact:true}).waitFor({timeout:30000})
  assert.equal(await page.locator('[data-nalu-avatar]').count(),0)
  await page.getByRole('button',{name:'Play with friends',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-nalu-chase]')?.dataset.friendsActive==='true')
  await page.screenshot({path:output+'/'+url.hostname+'-playground.png'})
  await context.addInitScript(()=>{localStorage.setItem('nalu-token','avatar-deployment-fixture');localStorage.setItem('nalu-data-owner','avatar-deployment-fixture');localStorage.setItem('nalu-view','chat')})
  await context.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/auth'?{user:{id:'avatar-deployment-fixture',displayName:'Michael'}}:{ok:true,data:{},tasks:[],items:[],members:[]}}))
  await page.reload();await page.locator('[data-nalu-avatar][data-ready="true"]').waitFor({timeout:30000})
  const artwork=await page.locator('[data-nalu-avatar] img').getAttribute('src')
  const image=await context.request.get(new URL(artwork,base).href);assert.equal(image.status(),200);assert.deepEqual(await image.body(),original)
  assert.equal(await page.locator('.nalu-avatar-pause').count(),0,'Avatar demo controls are removed')
  assert.equal(await page.locator('.nalu-workspace').count(),1,'Refreshed workspace appears only after login')
  await page.screenshot({path:output+'/'+url.hostname+'-workspace.png'})
  assert.deepEqual(errors,[])
  report.push({domain:url.hostname,entry:await page.locator('script[type="module"]').getAttribute('src'),artwork,publicPlayground:true,signedInAvatar:true,originalBytes:true,errors})
  await context.close()
 }
 console.log(JSON.stringify(report,null,2))
}finally{await fs.writeFile(output+'/public-'+(bases.length>1?'domains':'candidate')+'.json',JSON.stringify(report,null,2));await browser.close()}
