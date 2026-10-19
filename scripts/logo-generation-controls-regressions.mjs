// Real LogoCard lifecycle, network interception only. Never calls a provider.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII='
const fixture=`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{LogoCard}from'/src/components/workspace/StudioCards.tsx';
const initial={kind:'logo',name:'',symbol:'a whimsical unicorn',literal:true,userStyle:'whimsical',colors:['#705898','#DDD0EF'],colorNames:['violet','lavender'],concept:'Whimsical unicorn'};
function App(){const[art,setArt]=useState(()=>JSON.parse(localStorage.getItem('fixture-art')||'null')||initial);return React.createElement(LogoCard,{art,onUpdate:next=>{localStorage.setItem('fixture-art',JSON.stringify(next));setArt(next)}})}
const root=createRoot(document.getElementById('root'));root.render(React.createElement(App));window.unmountLogo=()=>root.unmount();`
const server=await createServer({configFile:false,root:fileURLToPath(new URL('../client',import.meta.url)),plugins:[react(),{name:'logo-cost-fixture',resolveId(id){if(id==='/@logo-fixture')return '\0logo-fixture'},load(id){if(id==='\0logo-fixture')return fixture},configureServer(vite){vite.middlewares.use('/__logo-fixture',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__logo-fixture','<!doctype html><html><body><main id="root"></main><script type="module" src="/@logo-fixture"></script></body></html>'))})}}],server:{host:'127.0.0.1',port:5197,strictPort:true}})
let browser
try{
 await server.listen();browser=await chromium.launch();const page=await browser.newPage();const errors=[],calls=[];let rejectOne=true,hold=false,release
 page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(()=>{localStorage.setItem('nalu-token','fixture-owner');window.logoAborts=0;const originalFetch=window.fetch;window.fetch=(input,options)=>{if(input==='/api/image')options?.signal?.addEventListener('abort',()=>window.logoAborts++);return originalFetch(input,options)}})
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!=='http://127.0.0.1:5197')return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();calls.push({url:url.pathname,body:route.request().postDataJSON(),auth:route.request().headers().authorization});assert.equal(url.pathname,'/api/image','preview must not hide generation behind an image proxy');if(hold)await new Promise(resolve=>{release=resolve});if(rejectOne){rejectOne=false;return route.fulfill({status:429,json:{error:'Daily image limit reached.'}})}return route.fulfill({json:{url:pixel,name:'Nalu Image'}})})
 await page.goto('http://127.0.0.1:5197/__logo-fixture')
 const generate=page.getByRole('button',{name:'Generate images',exact:true})
 await expect(generate).toBeVisible();await page.waitForTimeout(4200)
 assert.equal(calls.length,0,'mount and former prefetch timer must never generate')
 await generate.click();await expect(page.getByRole('img',{name:'Logo mark'})).toHaveCount(2);await expect(page.getByText('Daily image limit reached.',{exact:true})).toBeVisible()
 assert.equal(calls.length,3);assert.ok(calls.every(c=>c.auth==='Bearer fixture-owner'&&c.body.prompt.includes('unicorn')))
 await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.getByRole('img',{name:'Logo mark'})).toHaveCount(3)
 await expect.poll(()=>page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('fixture-art')||'{}').imgCache||{}).length)).toBe(3)
 const beforeReload=calls.length;await page.reload();await expect(page.getByRole('img',{name:'Logo mark'})).toHaveCount(3);assert.equal(calls.length,beforeReload,'reopening uses saved bytes')
 await page.getByRole('button',{name:'Try other styles ▾',exact:true}).click();await expect(generate).toBeEnabled();await page.waitForTimeout(4200);assert.equal(calls.length,beforeReload,'style change does not generate or prefetch')
 await page.getByRole('button',{name:'Regenerate',exact:true}).click();await expect(page.getByRole('img',{name:'Logo mark'})).toHaveCount(3);assert.equal(calls.length,beforeReload+3,'explicit Regenerate makes exactly one batch')
 // Starting another variant and immediately leaving cancels all in-flight calls.
 hold=true;await page.getByRole('button',{name:'Regenerate',exact:true}).click();await expect.poll(()=>calls.length).toBe(beforeReload+6);await page.evaluate(()=>window.unmountLogo());assert.equal(await page.evaluate(()=>window.logoAborts),3,'leaving the preview aborts every in-flight image request');release?.();await page.waitForTimeout(50)
 assert.deepEqual(errors,[])
 console.log('PASS: LogoCard mount/reopen/style browsing make zero generation calls; explicit generate/retry/regenerate, quota error, persistence, auth and unmount cancellation work.')
}finally{await browser?.close();await server.close()}
