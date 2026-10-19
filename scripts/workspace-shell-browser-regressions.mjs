// Actual combined App, dock, Memory, connectors, settings and ordinary chat.
// Every API is synthetic; no provider/OAuth/account is contacted.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'
const root=fileURLToPath(new URL('../client/',import.meta.url)),out=process.env.OUTPUT_DIR||'/private/tmp/nalu-workspace-shell-browser-review'
await mkdir(out,{recursive:true})
const server=await createServer({root,configFile:root+'vite.config.ts',cacheDir:out+'/vite-cache',css:{postcss:{plugins:[tailwindcss({...tailwindConfig,content:[root+'src/**/*.{ts,tsx}']}),autoprefixer()]}},server:{host:'127.0.0.1',port:5198,strictPort:true,hmr:false}})
const origin='http://127.0.0.1:5198',report={checks:[],errors:[],requests:[],blocked:[]}
let browser, lastPage
const initial=[{id:'planning-chat',title:'Planning conversation',createdAt:1,messages:[{id:'user-one',role:'user',content:'Remember the launch plans.'},{id:'answer-one',role:'assistant',content:'The launch plan is saved here.'}]}]
try{
 await server.listen();browser=await chromium.launch()
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const context=await browser.newContext({viewport});let cloud={'nalu-chats':JSON.stringify(initial)}
  const swarmState={version:1,mode:'live',projects:[],tasks:[],messages:[],turns:[]},swarmRequests=[];let swarmRevision=1
  await context.addInitScript(initial=>{if(window!==top)return;if(sessionStorage.getItem('shell-seeded'))return;sessionStorage.setItem('shell-seeded','1');localStorage.setItem('nalu-token','offline-shell');localStorage.setItem('nalu-data-owner','offline-shell');localStorage.setItem('nalu-view','studio');localStorage.setItem('nalu-chats',JSON.stringify(initial))},initial)
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url())
   if(url.origin!==origin){if(['http:','https:'].includes(url.protocol)){report.blocked.push(url.hostname);return route.abort()}return route.continue()}
   if(!url.pathname.startsWith('/api/'))return route.continue()
   const body=req.method()==='POST'?req.postDataJSON()||{}:{};report.requests.push({path:url.pathname,action:body.action,width:viewport.width})
   if(url.pathname==='/api/auth')return route.fulfill({json:{ok:true,user:{id:'offline-shell',displayName:'Shell review'}}})
   if(url.pathname==='/api/data'){
    if(body.action==='load')return route.fulfill({json:{ok:true,data:cloud}})
    if(body.action==='setMany')cloud={...cloud,...body.entries}
    return route.fulfill({json:{ok:true,data:{},items:[],tasks:[]}})
   }
   if(url.pathname==='/api/connect'&&body.action==='reviews')return route.fulfill({json:{reviews:[]}})
   if(url.pathname==='/api/connect'&&body.action==='list')return route.fulfill({json:{connections:[]}})
   if(url.pathname==='/api/connect')return route.fulfill({status:501,json:{error:'Unexpected connection mutation in offline regression'}})
   if(url.pathname==='/api/oauth')return route.fulfill({json:{configured:[]}})
   if(url.pathname==='/api/swarm'){
    swarmRequests.push(body)
    if(body.action==='create'){
     assert.ok(body.title&&body.brief&&body.requestId,'Agent work creates a real project with a request receipt')
     let project=swarmState.projects.find(item=>item.requestId===body.requestId)
     if(!project){const now=Date.now();project={id:`shell-project-${swarmState.projects.length+1}`,requestId:body.requestId,title:body.title,brief:body.brief,members:['Nalu','Rocky','Milo'],createdAt:now,updatedAt:now};swarmState.projects.push(project);swarmRevision++}
     return route.fulfill({json:{state:swarmState,revision:swarmRevision,projectId:project.id}})
    }
    if(body.action==='send'){
     const project=swarmState.projects.find(item=>item.id===body.projectId)
     assert.ok(project&&project.members.includes(body.thread),'Private replies stay attached to a member of the selected project')
     assert.ok(body.requestId&&body.content,'Private sends preserve their request receipt and content')
     if(!swarmState.turns.some(item=>item.requestId===body.requestId)){
      const now=Date.now(),userMessageId=`shell-user-${body.requestId}`,replyId=`shell-reply-${body.requestId}`,turnId=`shell-turn-${body.requestId}`
      swarmState.messages.push({id:userMessageId,projectId:project.id,thread:body.thread,speaker:'You',content:body.content,createdAt:now},{id:replyId,projectId:project.id,thread:body.thread,speaker:body.thread,content:`${body.thread} is working with you on ${project.title}.`,createdAt:now+1,turnId})
      swarmState.turns.push({id:turnId,requestId:body.requestId,projectId:project.id,thread:body.thread,replySpeaker:body.thread,userMessageId,replyId,status:'completed',createdAt:now,updatedAt:now+1});project.updatedAt=now+1;swarmRevision++
     }
     return route.fulfill({json:{state:swarmState,revision:swarmRevision}})
    }
    if(body.action==='list')return route.fulfill({json:{state:swarmState,revision:swarmRevision}})
    return route.fulfill({status:400,json:{error:'Unexpected Swarm action in offline shell regression'}})
   }
   if(url.pathname==='/api/web'&&body.action==='intent')return route.fulfill({json:{kind:'chat',mode:'answer'}})
   if(url.pathname==='/api/chat')return route.fulfill({contentType:'text/event-stream',body:'event: route\ndata: {"name":"Nalu"}\n\nevent: delta\ndata: {"text":"Offline ordinary chat response."}\n\nevent: finish\ndata: {"reason":"stop"}\n\nevent: done\ndata: {"ok":true}\n\n'})
   return route.fulfill({json:{ok:true,connections:[],providers:[],results:[],items:[],tasks:[],outputs:[],runs:[],members:[]}})
  })
  const page=await context.newPage();lastPage=page;page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push({width:viewport.width,error:error.message,stack:error.stack}))
  await page.goto(origin,{waitUntil:'domcontentloaded'})
  const dock=page.getByRole('navigation',{name:'Workspace navigation',exact:true})
  await expect(dock).toBeVisible({timeout:60000})
  const carousel=page.getByRole('region',{name:'Choose a workspace',exact:true})
  await expect(carousel).toBeVisible()
  await expect(carousel.getByRole('heading',{name:'What would you like to do?',exact:true})).toBeVisible()
  assert.equal(await page.evaluate(()=>localStorage.getItem('nalu-view')),'studio')
  if(viewport.width>950){
   const frame=await page.evaluate(()=>{const scene=document.querySelector('.review-desktop-scene'),dock=document.querySelector('.workspace-app-dock'),brand=document.querySelector('.review-header-brand');return{sceneTop:scene.getBoundingClientRect().top,shoulderTop:dock.getBoundingClientRect().top+parseFloat(getComputedStyle(dock,'::before').top),brandBottom:brand.getBoundingClientRect().bottom}})
   assert.ok(Math.abs(frame.sceneTop-frame.shoulderTop)<=1,'The scenic top edge aligns with the dock shoulders')
   assert.ok(frame.brandBottom<=frame.sceneTop+1,'The Nalu wordmark fits inside the top white frame')
   report.checks.push(`${viewport.width}: top white frame aligns with dock shoulders and contains the wordmark`)
  }
  await page.screenshot({path:`${out}/${viewport.width}-carousel.png`})
  await carousel.getByRole('button',{name:'Open Studio',exact:true}).click()
  await expect(carousel).toHaveCount(0)
  await expect(page.getByLabel('Studio tool',{exact:true})).toBeVisible()
  await page.reload({waitUntil:'domcontentloaded'})
  await expect(carousel).toBeVisible({timeout:60000})
  assert.ok((await page.evaluate(()=>JSON.parse(localStorage.getItem('nalu-chats')||'[]'))).some(chat=>chat.id==='planning-chat'))
  await carousel.getByRole('button',{name:'Open Studio',exact:true}).click()
  await expect(carousel).toHaveCount(0)
  report.checks.push(`${viewport.width}: saved tool does not bypass the initial or returning carousel; opening Studio preserves saved chats`)
  await expect(page.getByText('Local preview',{exact:true})).toHaveCount(0)
  await expect(page.getByText(/Real workspace\s*·\s*sample work\s*·\s*no account changes/i)).toHaveCount(0)
  await expect(page.getByText('Sample activity',{exact:true})).toHaveCount(0)
  report.checks.push(`${viewport.width}: authenticated App contains no local-preview or sample-activity banner`)
  for(const label of ['Studio','Autopilot','Map','Memory','Skills']){const box=await dock.getByRole('button',{name:label,exact:true}).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=viewport.width+1,`${label} dock control fits ${viewport.width}`)}
  await dock.getByRole('button',{name:'Studio',exact:true}).click()
  await expect(page.getByLabel('Studio tool',{exact:true})).toBeVisible();assert.ok(await page.getByLabel('Studio tool',{exact:true}).locator('option').count()>=17)
  await page.getByLabel('Studio tool',{exact:true}).selectOption({label:'Website'});await expect(page.getByLabel('Your idea',{exact:true})).toBeVisible()
  report.checks.push(`${viewport.width}: dock controls fit and ordinary Studio tool selection works`)
  await dock.getByRole('button',{name:'Memory',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Memory',exact:true})).toBeVisible()
  await page.getByRole('tab',{name:'Saved context',exact:true}).click()
  await page.getByRole('textbox',{name:'Search saved work',exact:true}).fill('Planning conversation')
  const item=page.locator('.memory-review-item').filter({hasText:'Planning conversation'}).first();await expect(item).toBeVisible();await item.click()
  await expect(page.locator('#memory-review-details')).toBeVisible()
  await page.getByRole('button',{name:'Zoom memory graph in',exact:true}).click();await page.getByRole('button',{name:'Fit all memory connections',exact:true}).click()
  await page.screenshot({path:`${out}/${viewport.width}-memory.png`});report.checks.push(`${viewport.width}: saved Memory search, details, real graph and zoom/fit controls`)
  await dock.getByRole('button',{name:'Skills',exact:true}).click();await page.getByRole('button',{name:'Connections & Chrome',exact:true}).click()
  const gmail=page.getByRole('region',{name:'Gmail connection',exact:true});await expect(gmail).toBeVisible();await gmail.getByRole('button',{name:'Set up connection',exact:true}).click()
  const connection=page.getByRole('dialog',{name:'App connections',exact:true});await expect(connection).toBeVisible();await expect(connection.getByRole('textbox',{name:'Connection name',exact:true})).toBeVisible()
  const bounds=await connection.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y>=0&&bounds.y+bounds.height<=viewport.height+1)
  await page.screenshot({path:`${out}/${viewport.width}-connections.png`});await connection.getByRole('button',{name:'Close connections',exact:true}).click()
  report.checks.push(`${viewport.width}: actual connector catalogue/setup form and bounded dialog; no OAuth or credentials submitted`)
  await page.getByRole('button',{name:'Account options',exact:true}).click();const account=page.locator('.workspace-account-panel');await expect(account.getByRole('status',{name:'Chat save status'})).toBeVisible()
  await expect(account.getByRole('link',{name:'Download Nalu Desktop'})).toHaveAttribute('href','/download.html');await account.getByRole('button',{name:'Settings',exact:true}).click()
  await expect(page.getByRole('navigation',{name:'Settings categories'})).toBeVisible();await page.getByRole('button',{name:/Theme.*tap to switch/}).click();await expect(page.getByText(/tap to switch to/).first()).toBeVisible()
  await page.screenshot({path:`${out}/${viewport.width}-settings.png`});report.checks.push(`${viewport.width}: account save status/download and Settings theme control`)
  await page.getByRole('button',{name:'Open Nalu chat',exact:true}).click();const chat=page.locator('.workspace-chat-popover');await expect(chat).toBeVisible()
  let composer=chat.locator('.ws-composer textarea');await expect(composer).toBeVisible();await composer.fill('Keep this ordinary draft')
  const editor=await composer.elementHandle();await chat.getByRole('button',{name:'Expand Nalu chat',exact:true}).click()
  await expect(composer).toHaveValue('Keep this ordinary draft');assert.ok(await editor.evaluate(element=>element.isConnected))
  const showHistory=chat.getByRole('button',{name:'Show chat history',exact:true});if(await showHistory.count())await showHistory.click()
  await chat.getByRole('searchbox',{name:'Search all chats',exact:true}).fill('Planning')
  await chat.getByRole('navigation',{name:'Chat history'}).getByRole('button',{name:'Planning conversation',exact:true}).click()
  await expect(chat.getByText('The launch plan is saved here.',{exact:true})).toBeVisible()
  if(viewport.width>=768&&await chat.getByRole('button',{name:'Hide chat history',exact:true}).count())await chat.getByRole('button',{name:'Hide chat history',exact:true}).click()
  composer=chat.locator('.ws-composer textarea');await composer.fill('Say hello in plain text.');await chat.getByRole('button',{name:'Send',exact:true}).click()
  await expect(chat.getByText('Offline ordinary chat response.',{exact:true})).toBeVisible({timeout:30000})
  await page.screenshot({path:`${out}/${viewport.width}-chat.png`});await chat.getByRole('button',{name:'Minimize Nalu chat',exact:true}).click();await page.getByRole('button',{name:'Open Nalu chat',exact:true}).click()
  await expect(chat.getByText('Offline ordinary chat response.',{exact:true})).toBeVisible()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  report.checks.push(`${viewport.width}: ordinary composer survives maximize, history search/selection, real streaming renderer and minimize/reopen`)
  await chat.getByRole('button',{name:'Minimize Nalu chat',exact:true}).click()
  const tray=page.getByRole('complementary',{name:'Agent workspaces',exact:true}),rocky=tray.locator('.agent-tray-card[data-agent="rocky"]'),milo=tray.locator('.agent-tray-card[data-agent="milo"]')
  await expect(rocky).toBeEnabled();await expect(milo).toBeEnabled()
  const chooseAgent=async name=>{await tray.locator('.agent-tray-card[data-primary="true"]').click();const picker=tray.getByRole('dialog',{name:'Your team',exact:true});await expect(picker).toBeVisible();await picker.getByRole('button',{name:`Chat with ${name}`,exact:true}).click()}
  await chooseAgent('Rocky')
  await expect(chat.getByRole('heading',{name:'Work with Rocky',exact:true})).toBeVisible()
  await chat.getByLabel('Project name',{exact:true}).fill('Launch with the pack')
  await chat.getByLabel('What would you like to work on?',{exact:true}).fill('Keep each agent conversation attached to our launch project.')
  await chat.getByRole('button',{name:'Create Swarm',exact:true}).click()
  await expect(chat.getByText('Talking with Rocky',{exact:true})).toBeVisible()
  await chat.getByRole('textbox',{name:'Message Rocky',exact:true}).fill('ROCKY_PRIVATE: Please review the launch budget.')
  await chat.getByRole('button',{name:'Send Swarm message',exact:true}).click()
  await expect(chat.getByRole('log',{name:'Rocky direct conversation',exact:true}).getByText('Rocky is working with you on Launch with the pack.',{exact:true})).toBeVisible()
  await chat.getByRole('button',{name:'Minimize Nalu chat',exact:true}).click()
  await expect(milo).toBeEnabled();await chooseAgent('Milo')
  await expect(chat.getByText('Talking with Milo',{exact:true})).toBeVisible()
  await expect(chat.getByRole('log',{name:'Milo direct conversation',exact:true}).getByText('ROCKY_PRIVATE: Please review the launch budget.',{exact:true})).toHaveCount(0)
  await chat.getByRole('textbox',{name:'Message Milo',exact:true}).fill('MILO_PRIVATE: Help with the launch brief.')
  await chat.getByRole('button',{name:'Send Swarm message',exact:true}).click()
  await expect(chat.getByRole('log',{name:'Milo direct conversation',exact:true}).getByText('Milo is working with you on Launch with the pack.',{exact:true})).toBeVisible()
  assert.equal(swarmState.projects.length,1,'Selecting another dog opens its private branch in the same group')
  assert.deepEqual(swarmRequests.filter(item=>item.action==='send').map(({projectId,thread})=>({projectId,thread})),[{projectId:swarmState.projects[0].id,thread:'Rocky'},{projectId:swarmState.projects[0].id,thread:'Milo'}])
  assert.ok((await page.evaluate(()=>JSON.parse(localStorage.getItem('nalu-chats')||'[]'))).some(item=>item.id==='planning-chat'),'Agent conversations preserve the ordinary chat')
  await page.screenshot({path:`${out}/${viewport.width}-agents.png`})
  await chat.getByRole('navigation',{name:'Quick conversations',exact:true}).getByRole('button',{name:'Planning conversation',exact:true}).click()
  await expect(chat.getByText('Offline ordinary chat response.',{exact:true})).toBeVisible()
  report.checks.push(`${viewport.width}: idle Rocky and Milo are selectable, create/open real private group branches, render their own replies and preserve ordinary chat`)
  await page.reload({waitUntil:'domcontentloaded'});await expect(carousel).toBeVisible({timeout:60000})
  await carousel.getByRole('button',{name:'Open Studio',exact:true}).click()
  await chooseAgent('Rocky')
  await expect(chat.getByRole('log',{name:'Rocky direct conversation',exact:true}).getByText('Rocky is working with you on Launch with the pack.',{exact:true})).toBeVisible()
  await expect(chat.getByRole('log',{name:'Rocky direct conversation',exact:true}).getByText('MILO_PRIVATE: Help with the launch brief.',{exact:true})).toHaveCount(0)
  assert.equal(swarmState.projects.length,1,'Reload and reopening an agent do not duplicate its project')
  report.checks.push(`${viewport.width}: saved agent private branches survive reload without leaking another private conversation or duplicating projects`)
  await context.close();console.log(`PASS desktop/mobile shell ${viewport.width}`)
 }
 const signedOut=await browser.newContext({viewport:{width:1440,height:1000}})
 await signedOut.route('**/*',async route=>{
  const url=new URL(route.request().url())
  if(url.origin!==origin){if(['http:','https:'].includes(url.protocol)){report.blocked.push(url.hostname);return route.abort()}return route.continue()}
  if(url.pathname.startsWith('/api/'))return route.fulfill({status:401,json:{error:'Sign in required'}})
  return route.continue()
 })
 const publicPage=await signedOut.newPage();lastPage=publicPage
 publicPage.on('pageerror',error=>report.errors.push({width:1440,phase:'signed-out',error:error.message,stack:error.stack}))
 await publicPage.goto(origin,{waitUntil:'domcontentloaded'})
 await expect(publicPage.locator('.nalu-landing')).toBeVisible({timeout:60000})
 await expect(publicPage.locator('.nalu-header-signin')).toBeVisible()
 await expect(publicPage.getByRole('navigation',{name:'Workspace navigation',exact:true})).toHaveCount(0)
 await expect(publicPage.getByText('Local preview',{exact:true})).toHaveCount(0)
 await publicPage.screenshot({path:`${out}/signed-out-landing.png`})
 report.checks.push('Signed-out actual App remains behind the public landing/authentication gate')
 await signedOut.close()
 assert.deepEqual(report.errors,[])
}catch(error){report.failure=error.message;report.stack=error.stack;if(lastPage&&!lastPage.isClosed()){await lastPage.screenshot({path:out+'/failure.png'}).catch(()=>{});await writeFile(out+'/failure-body.txt',await lastPage.locator('body').innerText().catch(()=>''))}throw error}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser?.close();await server.close()}
