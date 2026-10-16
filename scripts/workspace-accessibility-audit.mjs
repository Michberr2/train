// Inspect real deployed UI with isolated account fixtures; no account writes.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import {chromium} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
const base=process.argv[2]||'https://n4lu.com'
const out=process.env.OUTPUT_DIR||'/tmp/nalu-quality-web-2026-10-03/accessibility'
await fs.mkdir(out,{recursive:true})
const browser=await chromium.launch(),report=[]
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage()
  await context.addInitScript(()=>{if(window!==top)return;localStorage.setItem('nalu-token','a11y-audit');localStorage.setItem('nalu-data-owner','a11y-audit');localStorage.setItem('nalu-view','chat')})
  await context.route('**/api/**',route=>{
   const path=new URL(route.request().url()).pathname
   if(path==='/api/auth')return route.fulfill({json:{ok:true,user:{id:'a11y-audit',displayName:'Accessibility review'}}})
   return route.fulfill({json:{ok:true,data:{},items:[],tasks:[],connections:[],members:[],runs:[]}})
  })
  await page.goto(base)
  await page.locator('.ws-chat-home').waitFor()
  for(const theme of ['light','dark']){
   if(theme==='dark')await page.getByRole('button',{name:'Toggle light or dark theme',exact:true}).click()
   await page.waitForFunction(theme=>document.querySelector('.nalu-workspace')?.getAttribute('data-workspace-theme')===theme,theme)
   for(const view of ['Chats','Studio','Skills','AutoPilot','Memory','Settings']){
    if(width<768)await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click()
    await page.locator('.ws-sidebar').getByRole('button',{name:view,exact:true}).click()
    await page.waitForTimeout(350)
    assert.equal(await page.locator('.nalu-workspace').getAttribute('data-workspace-theme'),theme)
    const results=await new AxeBuilder({page}).include('.nalu-workspace').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()
    const violations=results.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,html:n.html.slice(0,500),summary:n.failureSummary}))}))
    report.push({base,width,theme,view,violations,incomplete:results.incomplete.map(v=>({id:v.id,nodes:v.nodes.length}))})
    await page.screenshot({path:`${out}/${width}-${theme}-${view}.png`})
    await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2))
    console.log(JSON.stringify({width,theme,view,violations:violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))}))
   }
  }
  await context.close()
 }
}finally{await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close()}
process.exitCode=report.length!==24||report.some(r=>r.violations.some(v=>['serious','critical'].includes(v.impact)))?1:0
