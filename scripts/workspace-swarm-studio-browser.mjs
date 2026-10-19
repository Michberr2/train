/** Offline browser regression: real Swarm hook/controller/cards, mocked authenticated
 * API, no accounts/providers/ordinary-chat writes. Run from the repository root. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
const root = process.cwd(), clientRoot = path.join(root, 'client')
const out = process.env.OUTPUT_DIR || '/private/tmp/nalu-swarm-studio-browser-review'
await fs.mkdir(out, { recursive: true })
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nalu-swarm-studio-browser-'))
const entry = path.join(fixture, 'entry.tsx')
// Resolve dependencies through the normal repo node_modules, not a cached Vite bundle.
await fs.writeFile(entry, `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import useSwarm from ${JSON.stringify(path.join(clientRoot,'src/components/workspace/design/useSwarm.ts'))};
import WorkspaceSwarm from ${JSON.stringify(path.join(clientRoot,'src/components/workspace-preview/real/WorkspaceSwarm.tsx'))};
import ${JSON.stringify(path.join(clientRoot,'src/globals.css'))};
function App(){const [owner,setOwner]=useState('browser-owner');const swarm=useSwarm({accountId:owner,active:true});
window.__switchSwarmAccount=()=>{localStorage.setItem('nalu-token','other-token');localStorage.setItem('nalu-data-owner','other-owner');setOwner('other-owner');window.dispatchEvent(new Event('nalu-hydrated'))};
return <div data-workspace-design className="nalu-design-review" style={{height:'100dvh',padding:12,background:'#edf3fa'}}><WorkspaceSwarm swarm={swarm} navigationKey={0} availableChatIds={[]} onOpenChat={()=>{throw Error('Ordinary chat must not be opened')}}/></div>};createRoot(document.getElementById('root')!).render(<App/>);`)
let browser, server, page
const errors = [], forbidden = [], calls = [], report = []
let revision = 1, artifactRevision = 1, delayArtifact = false, releaseArtifact
const project = { id: 'launch', title: 'Launch project', brief: 'Create a real launch brief and website.', members: ['Nalu','Rocky','Milo'], createdAt: 1, updatedAt: 1 }
const document = { type: 'studio-artifact', studioKind: 'document', payload: { title: 'Launch brief', blocks: [{type:'heading',text:'Our launch'},{type:'p',text:'This document belongs to the selected Swarm task.'}], design: {background:'#FFFFFF',ink:'#173E39'} }, status:'done',summary:'Saved creation' }
let website = { type:'studio-artifact',studioKind:'website',payload:{ html:'<!doctype html><html><body><h1>Original launch</h1><p>Saved website content</p></body></html>', quality:{runtime:{status:'passed',widths:[390],checks:[],limitations:[]}} },status:'done',summary:'Saved website' }
let tasks = [{id:'doc-task',projectId:'launch',title:'Make launch brief',assignee:'Milo',status:'waiting',summary:'Continue this document in Studio.',threads:['Milo'],updatedAt:1,executionId:'source-doc',handoff:{studioKind:'document',prompt:'Write a launch brief',reason:'Needs document creation'}},
{id:'site-task',projectId:'launch',title:'Launch website',assignee:'Nalu',status:'done',summary:'Saved website.',threads:['group'],updatedAt:1,executionId:'site-job',artifact:{executionId:'site-job',studioKind:'website',revision:1}}]
const state = () => ({version:1,mode:'live',projects:[project],tasks,messages:[],turns:[]})
try {
 process.chdir(clientRoot)
 server = await createServer({ root:clientRoot, configFile:false, cacheDir:path.join(fixture,'vite-cache'), resolve:{dedupe:['react','react-dom']}, plugins:[react(),{name:'swarm-test-entry',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/__swarm-test')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__swarm-test',`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`))})}}],server:{host:'127.0.0.1',port:0,fs:{allow:[root,fixture,'/Users/michaelberryii/train/node_modules']}} })
 await server.listen(); console.log('Local fixture server ready'); const address=server.httpServer.address(), origin=`http://127.0.0.1:${address.port}`
 browser=await chromium.launch(); console.log('Chromium ready'); const context=await browser.newContext({viewport:{width:1280,height:900}})
 await context.addInitScript(()=>{if(window!==top)return;localStorage.setItem('nalu-token','browser-token');localStorage.setItem('nalu-data-owner','browser-owner')})
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url())
  if(url.origin!==origin){if(url.protocol==='http:'||url.protocol==='https:')return route.abort();return route.continue()}
  if(!url.pathname.startsWith('/api/'))return route.continue()
  if(url.pathname!=='/api/swarm'){forbidden.push(url.pathname);return route.fulfill({status:501,json:{error:'Unexpected ordinary API call'}})}
  const body=request.postDataJSON();calls.push(body)
  assert.equal(request.headers().authorization,body.action==='list'&&request.headers().authorization==='Bearer other-token'?'Bearer other-token':'Bearer browser-token')
  if(request.headers().authorization==='Bearer other-token')return route.fulfill({json:{state:{version:1,mode:'live',projects:[],tasks:[],messages:[],turns:[]},revision:1}})
  if(body.action==='list')return route.fulfill({json:{state:state(),revision}})
  if(body.action==='continue-studio'){
   assert.deepEqual({projectId:body.projectId,taskId:body.taskId,sourceJobId:body.sourceJobId},{projectId:'launch',taskId:'doc-task',sourceJobId:'source-doc'});assert.ok(body.requestId)
   tasks=tasks.map(task=>task.id==='doc-task'?{...task,status:'done',handoff:undefined,executionId:'doc-job',executionRequestId:body.requestId,artifact:{executionId:'doc-job',studioKind:'document',revision:1}}:task);revision++
   return route.fulfill({json:{state:state(),revision}})
  }
  if(body.action==='artifact'){
   assert.equal(body.projectId,'launch');const task=tasks.find(task=>task.id===body.taskId);assert.equal(body.executionId,task.artifact.executionId)
   if(delayArtifact){await new Promise(resolve=>releaseArtifact=resolve)}
   return route.fulfill({json:{artifact:body.taskId==='doc-task'?document:website,revision:body.taskId==='doc-task'?1:artifactRevision}}).catch(()=>{})
  }
  if(body.action==='update-artifact'){
   assert.equal(body.taskId,'site-task');assert.equal(body.executionId,'site-job');assert.equal(body.revision,artifactRevision)
   website={...website,payload:body.payload};artifactRevision++;revision++;tasks=tasks.map(task=>task.id==='site-task'?{...task,artifact:{...task.artifact,revision:artifactRevision}}:task)
   return route.fulfill({json:{state:state(),revision}})
  }
  forbidden.push(body.action);return route.fulfill({status:501,json:{error:'Unexpected action'}})
 })
 page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(`${origin}/__swarm-test`);console.log('Fixture page loaded')
 await expect(page.getByRole('heading',{name:'Launch project',exact:true})).toBeVisible({timeout:30000})
 console.log('Real Swarm workspace ready');
 await page.getByRole('button',{name:'Chat with Milo about Launch project'}).click()
 await page.getByRole('button',{name:'Continue Make launch brief in Studio'}).click()
 await page.getByRole('button',{name:'View creation',exact:true}).click()
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect(dialog.getByText('This document belongs to the selected Swarm task.')).toBeVisible({timeout:30000})
 await expect(dialog.getByRole('button',{name:'Word',exact:true})).toBeVisible()
 await page.screenshot({path:path.join(out,'desktop-document.png')})
 await dialog.getByRole('button',{name:'Close creation'}).click()
 await page.getByRole('button',{name:'Group',exact:true}).click()
 await page.getByRole('button',{name:'View creation',exact:true}).click()
 await expect(dialog.locator('iframe')).toBeVisible({timeout:30000});await expect(dialog.getByRole('button',{name:'Share',exact:true})).toHaveCount(0)
 await dialog.getByRole('button',{name:'Edit HTML',exact:true}).click()
 await dialog.getByRole('textbox',{name:'HTML source'}).fill('<!doctype html><html><body><h1>Edited launch</h1><p>Saved explicitly to this task.</p></body></html>')
 assert.equal(calls.filter(body=>body.action==='update-artifact').length,0,'editing must not automatically write')
 await dialog.getByRole('button',{name:'Save changes',exact:true}).click()
 await expect(dialog.getByText('Changes saved to this task.')).toBeVisible()
 assert.equal(calls.filter(body=>body.action==='update-artifact').length,1)
 await dialog.getByRole('button',{name:'Show preview',exact:true}).click()
 await expect(dialog.frameLocator('iframe').getByRole('heading',{name:'Edited launch'})).toBeVisible()
 assert.equal(website.payload.quality.runtime.status,'partial','edited code must not reuse the generated runtime pass')
 await expect(dialog.getByText('Edited HTML has not been runtime-tested.')).toHaveCount(1)
 await page.screenshot({path:path.join(out,'desktop-website.png')})
 await page.setViewportSize({width:390,height:844})
 const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=391&&box.y+box.height<=845,'preview must remain within mobile viewport')
 await page.screenshot({path:path.join(out,'mobile-website.png')})
 await dialog.getByRole('button',{name:'Close creation'}).click()
 await page.setViewportSize({width:1280,height:900})
 delayArtifact=true
 await page.getByRole('button',{name:'View creation',exact:true}).click()
 await expect(dialog.getByText('Loading saved creation…')).toBeVisible()
 await page.waitForFunction(()=>typeof window.__switchSwarmAccount==='function')
 await page.evaluate(()=>window.__switchSwarmAccount())
 if(releaseArtifact)releaseArtifact()
 await expect(page.getByRole('dialog')).toHaveCount(0)
 await expect(page.getByText('Make room for an idea.')).toBeVisible()
 assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[])
 report.push('Actual private task continuation, authenticated requests, saved DocCard/Word export control, real website iframe, explicit scoped Save changes, mobile containment, account-switch stale-read dismissal, no ordinary API calls')
 console.log('PASS '+report[0])
} catch(error) {
 if(page){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'failure.txt'),await page.locator('body').innerText().catch(()=>''))}
 console.error('Browser failure',error.message,errors);throw error
} finally {
 if(releaseArtifact)releaseArtifact()
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({report,errors,forbidden,calls},null,2))
 await browser?.close();await server?.close();process.chdir(root)
}
