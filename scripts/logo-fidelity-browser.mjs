import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium,expect} from '@playwright/test'
const base=process.env.BASE_URL||'http://127.0.0.1:5206',origin=new URL(base).origin
const output=`/private/tmp/nalu-logo-fidelity-browser/${new URL(base).hostname}`;await mkdir(output,{recursive:true})
const original='create me a logo for unicorns'
const questions=[{q:'What is the logo for, and who is its target audience?',options:[]},{q:'What style and elements should the logo use?',options:[]}]
const art={kind:'logo',name:'',initials:'',symbol:'a whimsical unicorn',literal:true,userStyle:'whimsical',colors:['#705898','#DDD0EF'],colorNames:['violet','lavender'],concept:'Whimsical unicorn'}
// Disposable image stands in for the paid image generator; inspect the actual
// requested image prompts and the card's absence of invented typography.
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII='
const browser=await chromium.launch(),requests=[],errors=[]
try {
 const page=await browser.newPage({viewport:{width:1280,height:960}})
 page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(()=>{if(window!==top)return;localStorage.setItem('nalu-token','logo-review');localStorage.setItem('nalu-data-owner','logo-review');localStorage.setItem('nalu-view','chat')})
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.origin!==origin)return route.abort()
  if(!u.pathname.startsWith('/api/'))return route.continue()
  const body=route.request().postDataJSON()||{},path=u.pathname;requests.push({path,body})
  if(path==='/api/auth')return route.fulfill({json:{ok:true,user:{id:'logo-review',displayName:'Trevor Park'}}})
  if(path==='/api/web'&&body.action==='intent')return route.fulfill({json:{kind:'logo',mode:body.prompt==='Make it purple'?'edit':'create'}})
  if(path==='/api/web'&&body.action==='clarify')return route.fulfill({json:{questions:body.prompt==='Make it purple'?[]:questions}})
  if(path==='/api/design')return route.fulfill({json:art})
  if(path==='/api/web'&&body.action==='proxyimg')return route.fulfill({json:{dataUrl:pixel}})
  if(path==='/api/image')return route.fulfill({json:{url:pixel}})
  return route.fulfill({json:{ok:true,data:{},tasks:[],items:[],outputs:[],connections:[]}})
 })
 await page.goto(base)
 const composer=page.getByPlaceholder('Ask Nalu anything…  (paste images or videos too)')
 await composer.fill(original);await page.getByRole('button',{name:'Send',exact:true}).click()
 await expect(page.getByText(questions[0].q,{exact:true})).toBeVisible()
 await composer.fill('it is for younger folks and it is for a fantasy book. a unicorn and whimsical')
 await page.getByRole('button',{name:'Send',exact:true}).click()
 const designs=()=>requests.filter(r=>r.path==='/api/design')
 await expect.poll(()=>designs().length).toBe(1)
 assert.equal(designs()[0].body.kind,'logo')
 assert.equal(designs()[0].body.logoBrief.request,original)
 assert.match(designs()[0].body.logoBrief.answers,/fantasy book.*unicorn and whimsical/)
 assert.equal(requests.filter(r=>r.path==='/api/image'||r.path==='/api/web'&&r.body.action==='proxyimg').length,0,'viewing a logo preview never starts image generation')
 await page.getByRole('button',{name:'Generate images',exact:true}).click()
 await expect(page.getByRole('img',{name:'Logo mark'}).first()).toBeVisible()
 assert.equal(await page.getByText('Black & white (primary)',{exact:true}).count(),0)
 assert.equal(await page.getByText('TP',{exact:true}).count(),0)
 await page.getByRole('button',{name:'Save to Brand',exact:true}).first().click()
 await expect(page.getByRole('button',{name:'Saved',exact:true})).toBeVisible()
 const savedBrand=await page.evaluate(()=>Object.values(localStorage).map(value=>{try{return JSON.parse(value)}catch{return null}}).find(value=>value?.name==='Logo'&&value?.logoMark))
 assert.match(savedBrand.logoMark,/^data:image\/png;base64,/)
 assert.ok(savedBrand.logoMark.length<180000,'saved mark must fit durable brand storage')
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible()
 const retry=page.getByRole('button',{name:'Retry',exact:true}).last()
 await retry.click()
 await expect.poll(()=>designs().length).toBe(2)
 assert.equal(designs()[1].body.logoBrief.request,original,'Retry must retain the original subject after clarification')
 assert.equal(designs()[1].body.logoBrief.answers,designs()[0].body.logoBrief.answers)
 assert.equal(requests.filter(r=>r.path==='/api/web'&&r.body.action==='clarify').length,1,'Do not ask the answered questions again')
 const images=requests.filter(r=>r.path==='/api/image')
 assert.ok(images.length>0);assert.ok(images.every(r=>r.body.prompt.includes('unicorn')))
 assert.ok(images.every(r=>!r.body.prompt.includes('Trevor')))
 await composer.fill('Make it purple');await page.getByRole('button',{name:'Send',exact:true}).click()
 await expect.poll(()=>designs().length).toBe(3)
 assert.equal(designs()[2].body.prevLogo.symbol,art.symbol,'edits retain the existing subject')
 assert.equal(designs()[2].body.prevLogo.imgCache,undefined,'image bytes do not belong in the generation brief')
 assert.equal(designs()[2].body.logoBrief.request,'Make it purple')
 assert.deepEqual(errors,[])
 await page.screenshot({path:`${output}/unnamed-unicorn.png`})
 await writeFile(`${output}/report.json`,JSON.stringify({passed:true,original,requests},null,2))
 console.log('PASS: unicorn clarification keeps original subject, no invented initials/wordmark, image prompts depict unicorn, Retry preserves original brief.')
} finally {await browser.close()}
