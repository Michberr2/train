import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium,expect} from '@playwright/test'
import {mergeChatTitle} from '../shared/chatTitle.ts'
const base=process.env.BASE_URL||'http://127.0.0.1:5206',origin=new URL(base).origin
const output=`/private/tmp/nalu-chat-brand-browser/${new URL(base).hostname}`;await mkdir(output,{recursive:true})
const initial={id:'old-project-chat',title:'Create a logo for unicorns',projectId:'old-project',createdAt:100,messages:[{id:'u',role:'user',content:'Saved original request'},{id:'a',role:'assistant',content:'Saved original answer'}]}
const cloud={'nalu-chats':JSON.stringify([initial]),'nalu-chat-projects':JSON.stringify([{id:'old-project',name:'Former project',createdAt:100}])}
const errors=[],browser=await chromium.launch()
async function device(viewport,stale=false){
 const context=await browser.newContext({viewport})
 await context.addInitScript(({initial,stale})=>{if(window!==top||sessionStorage.getItem('seeded'))return;sessionStorage.setItem('seeded','yes');localStorage.setItem('nalu-token','review');localStorage.setItem('nalu-data-owner','review');localStorage.setItem('nalu-view','projects');if(stale)localStorage.setItem('nalu-chats',JSON.stringify([initial]))},{initial,stale})
 await context.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON()||{}
  if(path==='/api/auth')return route.fulfill({json:{user:{id:'review',displayName:'Review'}}})
  if(path==='/api/data'&&body.action==='load')return route.fulfill({json:{data:cloud}})
  if(path==='/api/data'&&body.action==='setMany'){
   for(const [key,value]of Object.entries(body.entries||{})){
    if(key==='nalu-chats'){
     const previous=JSON.parse(cloud[key]||'[]'),next=JSON.parse(value)
     const map=new Map(previous.map(chat=>[chat.id,chat]));for(const chat of next)map.set(chat.id,{...chat,...mergeChatTitle(chat,map.get(chat.id)||{})})
     cloud[key]=JSON.stringify([...map.values()])
    }else cloud[key]=value
   }
  }
  return route.fulfill({json:{ok:true,data:{},tasks:[],items:[],members:[]}})
 })
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base)
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible({timeout:30000})
 if(viewport.width<768)await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click()
 return{context,page}
}
try{
 const {page}=await device({width:1280,height:1000})
 const row=page.locator('[data-chat-id="old-project-chat"]')
 await expect(row).toBeVisible();assert.equal(await page.getByText('Projects',{exact:true}).count(),0)
 await row.getByRole('button',{name:/Rename chat:/}).click();await page.getByRole('textbox',{name:'Chat name',exact:true}).fill('  Unicorn book ideas  ')
 await page.getByRole('button',{name:'Save chat name'}).click()
 await expect.poll(()=>JSON.parse(cloud['nalu-chats'])[0].title).toBe('Unicorn book ideas')
 assert.deepEqual(JSON.parse(cloud['nalu-chats'])[0].messages,initial.messages)
 await page.reload();await expect(row.getByRole('button',{name:'Unicorn book ideas',exact:true})).toBeVisible()
 await row.getByRole('button',{name:/Rename chat:/}).click();await page.getByRole('textbox',{name:'Chat name',exact:true}).fill('Discard this');await page.getByRole('textbox',{name:'Chat name',exact:true}).press('Escape')
 await expect(row.getByRole('button',{name:'Unicorn book ideas',exact:true})).toBeVisible()
 await row.getByRole('button',{name:'Unicorn book ideas',exact:true}).click();await page.getByRole('button',{name:'Rename current chat'}).click()
 await page.getByRole('textbox',{name:'Chat name',exact:true}).fill(' ');await expect(page.getByRole('button',{name:'Save chat name'})).toBeDisabled();await page.getByRole('button',{name:'Cancel rename'}).click()
 await page.getByRole('button',{name:'Edit',exact:true}).click()
 await page.getByRole('button',{name:'Heading font',exact:true}).click();await page.getByRole('combobox',{name:'Search fonts'}).fill('Poppins');await page.getByRole('option',{name:/^Poppins/}).click()
 await page.getByRole('button',{name:'Primary',exact:true}).click();await page.getByRole('combobox',{name:'Search colors'}).fill('sage');await page.getByRole('option',{name:/Sage green/}).click()
 await page.getByRole('button',{name:'Accent',exact:true}).click();await page.getByRole('combobox',{name:'Search colors'}).fill('#a1b2c3');await page.getByRole('combobox',{name:'Search colors'}).press('Enter')
 const brand=await page.evaluate(()=>JSON.parse(localStorage.getItem('nalu-active-brand')))
 assert.equal(brand.headingFont,'Poppins');assert.equal(brand.primary,'9CAF88');assert.equal(brand.accent,'A1B2C3');assert.ok(brand.logo||brand.logoMark)
 await page.getByRole('button',{name:'Body font',exact:true}).click();await page.getByRole('combobox',{name:'Search fonts'}).fill('serif');await page.screenshot({path:`${output}/desktop-fonts.png`});await page.getByRole('combobox',{name:'Search fonts'}).press('Escape')
 const mobile=await device({width:390,height:844},true)
 const mobileRow=mobile.page.locator('[data-chat-id="old-project-chat"]');await expect(mobileRow.getByRole('button',{name:'Unicorn book ideas',exact:true})).toBeVisible()
 await mobileRow.getByRole('button',{name:/Rename chat:/}).click();await mobile.page.getByRole('textbox',{name:'Chat name',exact:true}).fill('My fantasy book');await mobile.page.getByRole('textbox',{name:'Chat name',exact:true}).press('Enter')
 await expect.poll(()=>JSON.parse(cloud['nalu-chats'])[0].title).toBe('My fantasy book')
 await mobileRow.getByRole('button',{name:'My fantasy book',exact:true}).click();await expect.poll(()=>mobile.page.locator('aside').evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);await mobile.page.getByRole('button',{name:'Edit',exact:true}).click()
 await mobile.page.getByRole('button',{name:'Primary',exact:true}).click();await mobile.page.getByRole('combobox',{name:'Search colors'}).fill('blue')
 const listbox=mobile.page.getByRole('listbox',{name:'Primary choices'});await expect(listbox).toBeVisible()
 const box=await listbox.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=844,'dropdown stays inside a phone screen')
 await mobile.page.screenshot({path:`${output}/mobile-colors.png`})
 assert.deepEqual(errors,[])
 await writeFile(`${output}/report.json`,JSON.stringify({passed:true,cloud},null,2))
 console.log('PASS: rename on desktop/mobile, saved title survives reload and stale device, project chats remain visible, searchable fonts/colors and custom hex, original logo retained.')
}finally{await browser.close()}
