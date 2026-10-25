import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../client/tailwind.config.js'

const root=fileURLToPath(new URL('../client/',import.meta.url))
const output=process.env.OUTPUT_DIR||'/private/tmp/nalu-responsive-browser'
const origin=process.env.RESPONSIVE_BASE_URL||'http://127.0.0.1:5201'
await mkdir(output,{recursive:true})
const server=process.env.RESPONSIVE_BASE_URL?null:await createServer({root,configFile:root+'vite.config.ts',cacheDir:output+'/vite-cache',css:{postcss:{plugins:[tailwindcss({...tailwindConfig,content:[root+'src/**/*.{ts,tsx}']}),autoprefixer()]}},server:{host:'127.0.0.1',port:5201,strictPort:true,hmr:false}})
const report=[]
let browser
try {
 await server?.listen()
 browser=await chromium.launch()
 const context=await browser.newContext()
 await context.addInitScript(()=>{localStorage.setItem('nalu-token','responsive-offline');localStorage.setItem('nalu-data-owner','responsive-offline');localStorage.setItem('nalu-theme','light')})
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url())
  if(url.origin!==new URL(origin).origin)return route.abort()
  if(!url.pathname.startsWith('/api/'))return route.continue()
  if(url.pathname==='/api/auth')return route.fulfill({json:{ok:true,user:{id:'responsive-offline',displayName:'Layout review'}}})
  // Real UI, isolated account transport. No production account actions.
  return route.fulfill({json:{ok:true,data:{},items:[],tasks:[],outputs:[],connections:[],configured:[],members:[],results:[],state:{version:1,mode:'live',projects:[],tasks:[],messages:[],turns:[]}}})
 })
 const page=await context.newPage()
 const errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(origin)
 const dock=page.getByRole('navigation',{name:'Workspace navigation',exact:true})
 await expect(dock).toBeVisible({timeout:60000})
 await page.emulateMedia({reducedMotion:'reduce'})
 for(const [width,height] of [[1920,1080],[1440,900],[1024,768],[900,600],[768,600],[600,600],[390,844],[320,568],[844,390]]) {
  await page.setViewportSize({width,height})
  await page.getByRole('button',{name:'Nalu home',exact:true}).first().click()
  const carousel=page.getByRole('region',{name:'Choose a workspace',exact:true})
  await expect(carousel).toBeVisible()
  for(const name of ['Studio','Autopilot','Map','Memory','Skills']) {
   const button=dock.getByRole('button',{name,exact:true})
   const box=await button.boundingBox()
   assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.width>=44,`${width}: ${name} dock target fits`)
  }
  const open=carousel.locator('.workspace-carousel-open')
  await open.scrollIntoViewIfNeeded()
  await expect(open).toBeInViewport({ratio:1})
  const overlap=await open.evaluate(button=>{const description=button.parentElement.querySelector('.workspace-carousel-select>p');return description.getBoundingClientRect().bottom>button.getBoundingClientRect().top+1})
  assert.equal(overlap,false,`${width}x${height}: carousel description clears Open`)
  await page.screenshot({path:`${output}/${width}x${height}-carousel.png`})
  for(const name of ['Studio','Autopilot','Map','Memory','Skills']) {
   await dock.getByRole('button',{name,exact:true}).click()
   await expect(carousel).toHaveCount(0)
   const panel=page.locator('.nalu-workspace>.ws-main')
   const geometry=await panel.evaluate(element=>({box:element.getBoundingClientRect().toJSON(),pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,scene:document.querySelector('.review-desktop-scene').getBoundingClientRect().toJSON()}))
   const {box,scene}=geometry
   assert.ok(box.width>0&&box.height>0&&box.x>=scene.x-1&&box.right<=scene.right+1&&box.y>=scene.y&&box.bottom<=scene.bottom+1,`${width}x${height} ${name}: panel is inside desktop scene`)
   assert.ok(geometry.pageWidth<=width+1&&geometry.pageHeight<=height+1,`${width}x${height} ${name}: page fits viewport`)
   report.push({width,height,name,panel:box})
   await page.screenshot({path:`${output}/${width}x${height}-${name.toLowerCase()}.png`})
  }
 }
 assert.deepEqual(errors,[])
 console.log(`PASS: ${report.length} app layouts across nine window sizes; dock targets and carousel action reachable`)
} finally {
 await writeFile(output+'/report.json',JSON.stringify(report,null,2))
 await browser?.close()
 await server?.close()
}
