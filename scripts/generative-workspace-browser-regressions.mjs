// Real application, account lifecycle and stream decoder; isolated transport only.
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { localEngineBrowserFixture, enableFixtureLocalAI } from './lib/local-engine-browser-fixture.mjs'
let base = process.env.GENERATIVE_TEST_URL, server
if (!base) {
 const root = fileURLToPath(new URL('../client/', import.meta.url))
 process.chdir(root)
 server = await createServer({ root, configFile: root + 'vite.config.ts', plugins: [localEngineBrowserFixture()], cacheDir: '/tmp/nalu-generative-browser-vite', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } })
 await server.listen()
 base = `http://127.0.0.1:${server.httpServer.address().port}`
}
const output = '/tmp/nalu-generative-browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const calls = [], errors = [], remote = []
let accountTheme
const blockA = { id: 'returns', type: 'calculator', title: 'Editable returns', width: 'half', fields: [{ id: 'price', label: 'Purchase price', type: 'number', value: '400000' }, { id: 'noi', label: 'Annual NOI', type: 'number', value: '24000' }], calculations: [{ label: 'Cap rate', formula: 'noi/price', format: 'percent' }] }
const blockB = { id: 'tasks', type: 'checklist', title: 'Due diligence', width: 'half', items: [{ id: 'leases', label: 'Verify leases' }, { id: 'expenses', label: 'Verify expenses' }] }
const blockC = { id: 'comparison', type: 'table', title: 'Comparison', width: 'full', columns: ['Property','Price'], rows: [['B','$500000'],['A','$400000']] }
const layouts = { initial: { title: 'Your property workspace', description: 'Based on your supplied figures.', blocks: [blockA, blockB, blockC] }, update: { title: 'Updated property workspace', blocks: [blockA, blockB, blockC, { id: 'action', type: 'form', title: 'Next step', width: 'full', fields: [{ id: 'note', label: 'Your instructions', type: 'text' }], actions: [{ label: 'Continue with Nalu', prompt: 'Use these instructions for the next step.' }] }] } }
await context.addInitScript(enableFixtureLocalAI)
await context.addInitScript(() => {
  window.__uiCalls = []
  // Measure the actual canvas cursor tip against live DOM geometry, rather than
  // asserting that elements merely registered as construction jobs.
  window.__cursorGeometry = []
  window.__constructionOrderErrors = []
  window.__maxCrew = 0
  new MutationObserver(records => {
    for (const record of records) {
      const el = record.target
      if (el.hasAttribute('data-workspace-cursors')) window.__maxCrew = Math.max(window.__maxCrew, Number(el.dataset.activeJobs || 0))
      if (el.dataset.buildState === 'working') {
        const parent = el.parentElement?.closest('[data-build-piece]')
        if (parent && parent.dataset.buildState !== 'settled') window.__constructionOrderErrors.push({element:el.tagName,parent:parent.tagName,state:parent.dataset.buildState})
      }
    }
  }).observe(document, {subtree:true,attributes:true,attributeFilter:['data-active-jobs','data-build-state']})
  const fillText = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
    if ((text === 'Nalu · size button' || text === 'Nalu · set copy' || text === 'Nalu · typing') && this.canvas.hasAttribute('data-workspace-cursors')) {
      const transform = this.getTransform(), canvas = this.canvas.getBoundingClientRect()
      const x = transform.e / transform.a + canvas.left, y = transform.f / transform.d + canvas.top
      const candidates = []
      for (const el of document.querySelectorAll(text.endsWith('size button') ? 'button[data-build-piece]' : text.endsWith('typing') ? '.nalu-build-written' : '[data-build-piece=text]')) {
        const box = el.getBoundingClientRect()
        if (text.endsWith('size button')) candidates.push({ x: box.right, y: box.bottom })
        else if (text.endsWith('typing')) { const word = el.parentElement.getBoundingClientRect(); candidates.push({ x: box.right + 2, y: word.top + word.height * .75 }) }
        else {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let node
          while ((node = walker.nextNode())) for (let i = 0; i < node.length; i++) {
            const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1)
            const r = range.getBoundingClientRect(); if (r.height) candidates.push({ x: r.right, y: r.bottom })
          }
        }
      }
      const error = Math.min(...candidates.map(p => Math.hypot(p.x - x, p.y - y)))
      if (window.__cursorGeometry.length < 5000) window.__cursorGeometry.push({ kind: text, error, x, y })
    }
    return fillText.call(this, text, ...args)
  }
})
const fixtureTransport = async route => {
 const request = route.request(), url = new URL(request.url())
 if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7QAAAABJRU5ErkJggg==', 'base64') })
 if (url.origin === 'http://127.0.0.1:8834' && /health/.test(url.pathname)) return route.fulfill({ status: 503, json: { error: 'Local GPU fixture is offline.' } })
 if (url.origin !== base && !['data:', 'blob:'].includes(url.protocol)) { if (url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com') remote.push(url.origin); return route.abort() }
 if (url.pathname === '/__nalu_local_entry') return route.fulfill({ json: { ok: true, token: 'isolated-generative-test', user: { id: 'isolated-generative-owner', displayName: 'Local test' } } })
 if (url.pathname === '/__fixture-local-model') {
  const body = request.postDataJSON()
  if (body.messages?.some(m => m.role === 'system' && m.content.includes('Nalu’s coordinator'))) return route.fulfill({json:{completion:JSON.stringify({expert:'conversation',tools:[],presentation:'workspace'})}})
  await page.evaluate(value => window.__uiCalls.push(value), body)
  if (!body.messages?.some(m => m.role === 'system' && m.content.includes('generative Nalu workspace'))) return route.fulfill({json:{completion:'Fixture helper'}})
  const turn = body.messages.filter(m => m.role === 'user').length
  const layout = turn === 1 ? layouts.initial : layouts.update
  const raw = '```nalu_ui\n' + JSON.stringify(layout) + '\n```\nYour workspace is ready.'
  const firstBlock = raw.indexOf('},{"id":"tasks"') + 1
  return route.fulfill({json:{completion:raw,chunks:[raw.slice(0,firstBlock),raw.slice(firstBlock)],delayMs:3000}})
 }
 if (!url.pathname.startsWith('/api/')) return route.continue()
 const body = request.postData() ? JSON.parse(request.postData()) : {}; calls.push({ path: url.pathname, action: body.action })
 if (url.pathname === '/api/data' && body.action === 'setMany' && body.entries?.['nalu-theme']) accountTheme = body.entries['nalu-theme']
 let json = { ok: true }
 if (url.pathname === '/api/auth') json = { ok: true, user: { id: 'isolated-generative-owner', displayName: 'Local test' } }
 else if (url.pathname === '/api/data') json = body.action === 'load' ? { data: accountTheme ? { 'nalu-theme': accountTheme } : {} } : { ok: true, items: [], tasks: [] }
 else if (url.pathname === '/api/swarm') json = { state: { version: 1, mode: 'live', projects: [], tasks: [], messages: [], turns: [] }, revision: 1 }
 else if (url.pathname === '/api/web' && body.action === 'intent') json = { kind: 'chat', mode: 'chat', additionalKinds: [] }
 else if (url.pathname === '/api/web' && body.action === 'places') json = { source: 'osm', results: [{ name: 'Fixture Dallas restaurant', address: 'Dallas, Texas', lat: 32.78, lng: -96.8 }] }
 else if (url.pathname === '/api/browser') json = {configured:true,runtime:'hosted',active:true,status:'idle',agents:[{id:'main',status:'idle'}],image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2mAAAAABJRU5ErkJggg=='}
 else if (url.pathname === '/api/team') json = { members: [], teams: [], invites: [] }
 else if (url.pathname === '/api/artifacts') json = { outputs: [] }
 else if (url.pathname === '/api/community') json = { rooms: [] }
 return route.fulfill({ json })
}
await context.route('**/*',fixtureTransport)
let page
try {
 page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
 await page.goto(base)
 await page.getByRole('button', { name: 'Enter local workspace' }).click()
 const home = page.getByRole('region', { name: 'Your generative workspace' })
 await expect(home).toBeVisible({ timeout: 45000 })
 await page.waitForFunction(() => Number(document.querySelector('[data-workspace-cursors]')?.getAttribute('data-active-jobs')) > 0)
 await page.waitForTimeout(1500)
 await page.screenshot({ path: output + '/00-cursors.png' })
 await page.getByRole('button', { name: 'Pause cursor construction', exact: true }).click()
 assert.equal(await page.locator('.workspace-chat-trigger,.workspace-app-dock,.workspace-agent-tray,.workspace-chat-popover').count(), 0)
 const appearance = async (label) => {
  await page.getByRole('button',{name:'Account options',exact:true}).click()
  await page.getByRole('button',{name:label,exact:true}).click()
  await page.keyboard.press('Escape')
  await expect.poll(async()=>{const color=await page.locator('.generative-home .ws-composer,.generative-block').first().evaluate(el=>getComputedStyle(el).backgroundColor);return label==='Dark mode'?luminance(color)<.08:luminance(color)>.7},{timeout:4000}).toBe(true)
 }
 const luminance = css => css.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0)
 await home.locator('textarea').fill('A draft survives changing appearance')
 const lightHome=await home.locator('.ws-composer').evaluate(el=>getComputedStyle(el).backgroundColor)
 await appearance('Dark mode')
 await expect(page.locator('[data-workspace-theme=dark]')).toHaveCount(1)
 const darkHome=await home.locator('.ws-composer').evaluate(el=>getComputedStyle(el).backgroundColor)
 assert.ok(luminance(darkHome)<.08 && luminance(lightHome)>.7,'signed-in home actually changes its surfaces between light and dark '+JSON.stringify({lightHome,darkHome,root:await page.locator('[data-generative-workspace]').evaluate(el=>({matches:el.matches(':has([data-workspace-theme=dark])'),panel:getComputedStyle(el).getPropertyValue('--gw-panel-rgb'),sheets:[...document.querySelectorAll('style')].filter(s=>s.textContent.includes('--gw-panel-rgb')).length}))}))
 await expect(home.locator('textarea')).toHaveValue('A draft survives changing appearance')
 await appearance('Light mode')
 await expect(page.locator('[data-workspace-theme=light]')).toHaveCount(1)
 await expect(home.locator('textarea')).toHaveValue('A draft survives changing appearance')
 const logo = await page.getByRole('button', { name: 'Nalu home', exact: true }).boundingBox()
 assert.ok(logo.x >= 30 && logo.y > 10 && logo.y < 70)
 await home.locator('textarea').fill('Compare two properties with editable inputs and a checklist.')
 await home.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.locator('[data-block-id="returns"]')).toBeVisible()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','true')
 assert.equal(await page.locator('[data-block-id="tasks"]').count(), 0)
 await page.screenshot({ path: output + '/01-streaming.png' })
 await expect(page.locator('[data-block-id="tasks"]')).toBeVisible()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','false')
 await expect(page.locator('output')).toHaveText('6%')
 await page.getByRole('spinbutton', { name: 'Purchase price', exact: true }).fill('500000')
 await expect(page.locator('output')).toHaveText('4.8%')
 await page.getByRole('checkbox', { name: 'Verify leases', exact: true }).check()
 await page.getByRole('button', { name: 'Property', exact: true }).click()
 await expect(page.locator('.generative-table tbody tr').first()).toContainText('A')
 await page.getByRole('button', { name: 'Play cursor construction', exact: true }).click()
 await page.waitForFunction(() => Number(document.querySelector('[data-workspace-cursors]')?.getAttribute('data-active-jobs')) > 0)
 for (const selector of ['input[type=number]', 'input[type=checkbox]', 'th', 'td', '.generative-block', '.nalu-build-copy']) assert.ok(await page.locator(selector + '[data-build-piece]').count(), `cursor covers ${selector}`)
 await page.waitForTimeout(3000)
 await page.screenshot({ path: output + '/02-cursor-construction.png' })
 await page.waitForFunction(()=>['Nalu · size button','Nalu · set copy','Nalu · typing'].every(kind=>window.__cursorGeometry.filter(sample=>sample.kind===kind).length>4),undefined,{timeout:15000})
 const geometry = await page.evaluate(() => window.__cursorGeometry)
 assert.deepEqual(await page.evaluate(()=>window.__constructionOrderErrors),[],'parent components settle before their descendants start building')
 assert.ok(await page.evaluate(()=>window.__maxCrew)<=8,'a bounded crew builds the workspace instead of overlapping every job')
 for (const kind of ['Nalu · size button','Nalu · set copy','Nalu · typing']) {
  const samples = geometry.filter(sample => sample.kind === kind)
  assert.ok(samples.length > 4, `measured real ${kind} motion`)
  assert.ok(Math.max(...samples.map(sample => sample.error)) < 2, `${kind} cursor tip follows the rendered control edge or actual glyph: ${JSON.stringify(samples.sort((a,b)=>b.error-a.error).slice(0,3))}`)
 }
 await page.setViewportSize({ width: 900, height: 700 })
 await page.evaluate(() => { window.__cursorGeometry = []; window.dispatchEvent(new Event('nalu-construction-replay')); document.querySelector('.ws-main').scrollTop = 120 })
 await page.waitForTimeout(2200)
 const resizedGeometry = await page.evaluate(() => window.__cursorGeometry.filter(sample => sample.kind === 'Nalu · size button'))
 assert.ok(resizedGeometry.length > 4 && resizedGeometry.every(sample => sample.error < 2), 'cursor edges stay accurate after viewport resize and nested scrolling')
 await page.setViewportSize({ width: 1440, height: 1000 })
 await page.getByRole('button', { name: 'Pause cursor construction', exact: true }).click()
 await expect(page.getByRole('spinbutton', { name: 'Purchase price', exact: true })).toHaveValue('500000')
 await page.screenshot({ path: output + '/02-edited.png' })
 await appearance('Dark mode')
 const fieldColors=await page.getByRole('spinbutton',{name:'Purchase price',exact:true}).evaluate(el=>({ink:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}))
 assert.ok((Math.max(luminance(fieldColors.ink),luminance(fieldColors.background))+.05)/(Math.min(luminance(fieldColors.ink),luminance(fieldColors.background))+.05)>=4.5,'dark inputs retain readable contrast')
 assert.ok(luminance(await page.locator('.generative-block').first().evaluate(el=>getComputedStyle(el).backgroundColor))<.08,'generated blocks follow dark mode')
 await expect(page.getByRole('spinbutton',{name:'Purchase price',exact:true})).toHaveValue('500000')
 await page.screenshot({path:output+'/02-dark-workspace.png'})
 await page.waitForTimeout(500)
 await page.reload()
 await expect(home).toBeVisible({ timeout: 45000 })
 await page.getByRole('button', { name: 'Pause cursor construction', exact: true }).click()
 await expect(page.locator('[data-workspace-theme=dark]')).toHaveCount(1)
 await page.getByRole('navigation', { name: 'Recent work' }).getByRole('button').first().click()
 await expect(page.getByRole('spinbutton', { name: 'Purchase price', exact: true })).toHaveValue('500000')
 await expect(page.getByRole('checkbox', { name: 'Verify leases', exact: true })).toBeChecked()
 await appearance('Light mode')
 await expect(page.getByRole('spinbutton',{name:'Purchase price',exact:true})).toHaveValue('500000')
 assert.ok(luminance(await page.locator('.generative-block').first().evaluate(el=>getComputedStyle(el).backgroundColor))>.7,'light mode restores light generated blocks')
 const canvas = page.getByRole('region', { name: 'Generated workspace' })
 await canvas.locator('textarea').fill('Add a next step form and keep my inputs.')
 await canvas.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.getByRole('heading', { name: 'Updated property workspace', exact: true })).toBeVisible()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','false')
 await expect(page.getByRole('spinbutton', { name: 'Purchase price', exact: true })).toHaveValue('500000')
 await expect(page.getByRole('checkbox', { name: 'Verify leases', exact: true })).toBeChecked()
 await page.getByRole('textbox', { name: 'Your instructions', exact: true }).fill('Review the leases first')
 await page.getByRole('button', { name: 'Continue with Nalu', exact: true }).click()
 await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
 await page.getByRole('button', { name: 'Stop', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toHaveAttribute('aria-busy','false')
 const modelCalls = await page.evaluate(() => window.__uiCalls)
 assert.ok(modelCalls.some(call => call.messages.some(m => typeof m.content === 'string' && m.content.includes('Review the leases first'))))
 await page.getByRole('region', { name: 'Generated workspace' }).getByRole('button', { name: 'Conversation', exact: true }).click()
 await expect(page.locator('.generative-conversation')).toBeVisible()
 assert.equal(await page.getByRole('dialog', { name: 'Nalu chat' }).count(), 0)
 await page.getByRole('button', { name: 'Back to workspace' }).click()
 await page.setViewportSize({ width: 390, height: 844 })
 await page.screenshot({ path: output + '/03-mobile.png' })
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
 await page.setViewportSize({ width: 1440, height: 1000 })
 await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Capabilities', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Nalu capabilities' })).toBeVisible()
 assert.equal(await page.getByRole('region', { name: 'Choose a workspace', exact: true }).count(), 0)
 await page.screenshot({ path: output + '/04-capabilities.png' })
 await page.getByRole('button', { name: 'Work with numbers', exact: false }).click()
 await expect(home).toBeVisible()
 await expect(home.locator('textarea')).toHaveValue('Help me analyze ')
 await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Saved work', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Saved workspaces' })).toBeVisible()
 await page.getByLabel('Search saved work', { exact: true }).fill('Compare two properties')
 await expect(page.locator('.generative-library-card')).toHaveCount(1)
 await page.screenshot({ path: output + '/05-saved-work.png' })
 await page.locator('.generative-library-card').click()
 await expect(page.getByRole('region', { name: 'Generated workspace' })).toBeVisible()
 await page.getByRole('button', { name: 'Account options', exact: true }).click()
 await page.getByRole('button', { name: 'Settings', exact: true }).click()
 await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
 await page.screenshot({ path: output + '/06-settings.png' })
 await page.getByRole('button', { name: 'Nalu home', exact: true }).click()
 await expect(home).toBeVisible()
 const beforeMapCalls = await page.evaluate(() => window.__uiCalls.length)
 await page.getByRole('button',{name:'Play cursor construction',exact:true}).click()
 await home.locator('textarea').fill('show me best places to eat in dallas on a map')
 await home.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.locator('[data-block-type="map"]')).toBeVisible()
 await expect(page.getByRole('textbox', { name: 'Map search', exact: true })).toHaveValue('best restaurants in dallas')
 assert.equal(await page.evaluate(() => window.__uiCalls.length), beforeMapCalls, 'explicit map requests do not wait on chat generation')
 await expect(page.locator('.generative-canvas')).toHaveAttribute('data-layout','map')
 assert.equal(await page.locator('[data-block-type=map]').evaluate(el=>getComputedStyle(el).opacity),'1','cursor construction never fades the live map surface')
 await page.evaluate(() => { window.__mapElement = document.querySelector('.generative-live-map') })
 const fullMap = await page.locator('.generative-live-map').boundingBox(), viewport = page.viewportSize()
 assert.ok(fullMap.x <= 1 && fullMap.width >= viewport.width - 2 && fullMap.y < 180 && fullMap.y + fullMap.height >= viewport.height - 2, `map fills the working page ${JSON.stringify({fullMap,viewport})}`)
 await expect.poll(async()=>luminance(await page.locator('.generative-header-nav button').first().evaluate(el=>getComputedStyle(el).color))<.08).toBe(true)
 await writeFile(output+'/map-header-style.json',JSON.stringify(await page.locator('.generative-header-nav').evaluate(el=>[el,...el.querySelectorAll('button')].map(n=>({tag:n.tagName,color:getComputedStyle(n).color,opacity:getComputedStyle(n).opacity,style:n.getAttribute('style')}))),null,2))
 await page.screenshot({path:output+'/06-full-page-map.png'})
 await page.setViewportSize({width:390,height:844})
 const mobileMap = await page.locator('.generative-live-map').boundingBox()
 assert.ok(mobileMap.x <= 1 && mobileMap.width >= 388 && mobileMap.height > 550, `mobile map fills the workspace ${JSON.stringify(mobileMap)}`)
 await page.getByRole('button',{name:'Exit full-page map',exact:true}).click()
 assert.ok(await page.evaluate(()=>window.__mapElement === document.querySelector('.generative-live-map')), 'expanding and restoring retains the mounted map, camera and pins')
 await expect(page.getByRole('textbox',{name:'Map search',exact:true})).toHaveValue('best restaurants in dallas')
 await page.setViewportSize({width:1440,height:1000})
 for (const prompt of ['open browser', 'show my browser', 'browser']) {
  await page.getByRole('button', {name:'Nalu home',exact:true}).click()
  await expect(home).toBeVisible()
  const before = await page.evaluate(() => window.__uiCalls.length)
  await home.locator('textarea').fill(prompt)
  await home.getByRole('button', {name:'Send',exact:true}).click()
  await expect(page.getByAltText('Your private Nalu browser')).toBeVisible({timeout:30000})
  assert.equal(await page.evaluate(() => window.__uiCalls.length),before,'browser navigation does not call the model')
  await expect(page.getByLabel('Connect this computer',{exact:true})).toHaveCount(0)
 }
 assert.ok(calls.some(c=>c.path==='/api/browser' && c.action==='host_workspace_open'))
 console.log('PASS chat opens hosted Browser directly without Capabilities or model inference')
 await page.getByRole('button',{name:'Pause cursor construction',exact:true}).click()
 await appearance('Dark mode')
 await expect.poll(()=>accountTheme).toBe('dark')
 const fresh=await browser.newContext({viewport:{width:1100,height:850},reducedMotion:'reduce'})
 await fresh.addInitScript(()=>localStorage.setItem('nalu-token','isolated-generative-test'))
 await fresh.route('**/*',fixtureTransport)
 const freshPage=await fresh.newPage();freshPage.on('pageerror',e=>errors.push(e.message))
 await freshPage.goto(base)
 await expect(freshPage.getByRole('region',{name:'Your generative workspace'})).toBeVisible({timeout:45000})
 await expect(freshPage.locator('[data-workspace-theme=dark]')).toHaveCount(1)
 assert.ok(luminance(await freshPage.locator('.generative-home .ws-composer').evaluate(el=>getComputedStyle(el).backgroundColor))<.08,'fresh login restores the account theme without a local theme preference')
 const workspaceTint=await freshPage.locator('.review-desktop-scene').evaluate(el=>getComputedStyle(el,'::after').backgroundColor)
 assert.ok(Number(workspaceTint.match(/[\d.]+/g).at(-1))>=.65,'dark mode tints the actual workspace scenery')
 await freshPage.screenshot({path:output+'/07-dark-account-login.png'})
 await freshPage.getByRole('button',{name:'Capabilities',exact:true}).click()
 await freshPage.getByRole('button',{name:'Open Studio',exact:true}).click()
 const studioTool=freshPage.getByRole('combobox',{name:'Studio tool',exact:true})
 await expect(studioTool).toBeVisible()
 assert.ok(luminance(await studioTool.evaluate(el=>getComputedStyle(el).backgroundColor))<.08,'native Studio controls follow dark mode')
 assert.match(await freshPage.locator('.ws-studio-preview-body').evaluate(el=>getComputedStyle(el).backgroundImage),/radial-gradient/,'Studio has its own drafting surface')
 await freshPage.getByRole('button',{name:'Account options',exact:true}).click();await freshPage.getByRole('button',{name:'Light mode',exact:true}).click();await freshPage.keyboard.press('Escape')
 await expect.poll(async()=>luminance(await studioTool.evaluate(el=>getComputedStyle(el).backgroundColor))>.7).toBe(true)
 await freshPage.getByRole('button',{name:'Account options',exact:true}).click();await freshPage.getByRole('button',{name:'Dark mode',exact:true}).click();await freshPage.keyboard.press('Escape')
 for(const name of ['Autopilot','Memory']){
  await freshPage.getByRole('button',{name:'Capabilities',exact:true}).click();await freshPage.getByRole('button',{name:'Open '+name,exact:true}).click()
  await expect.poll(async()=>luminance(await freshPage.locator('.ws-main').evaluate(el=>getComputedStyle(el).backgroundColor))<.08).toBe(true)
  if(name==='Autopilot')assert.match(await freshPage.locator('.ap-stage').evaluate(el=>getComputedStyle(el).backgroundImage),/linear-gradient/,'Autopilot has its own operation grid')
 }
 await fresh.close()
 const publicContext=await browser.newContext({viewport:{width:1200,height:900},reducedMotion:'reduce'})
 await publicContext.addInitScript(()=>{if(!sessionStorage.getItem('theme-fixture')){localStorage.setItem('nalu-theme','dark');sessionStorage.setItem('theme-fixture','1')}})
 await publicContext.route('**/*',fixtureTransport)
 const publicPage=await publicContext.newPage();publicPage.on('pageerror',e=>errors.push(e.message))
 await publicPage.goto(base)
 await publicPage.getByRole('button',{name:'Sign in',exact:true}).first().waitFor({timeout:45000})
 const landingScene=publicPage.locator('.nalu-hero [data-scenery]').first()
 assert.ok(Number(await landingScene.evaluate(el=>getComputedStyle(el,'::after').opacity))>=.65,'dark mode tints public landing scenery')
 await publicPage.screenshot({path:output+'/08-dark-public-site.png'})
 await publicPage.getByRole('button',{name:'Sign in',exact:true}).first().click()
 const authScene=publicPage.getByRole('dialog').locator('[data-scenery]')
 await expect(authScene).toHaveCount(1)
 assert.ok(Number(await authScene.evaluate(el=>getComputedStyle(el,'::after').opacity))>=.65,'dark mode tints login scenery')
 await publicPage.screenshot({path:output+'/09-dark-login.png'})
 await publicPage.evaluate(()=>localStorage.setItem('nalu-theme','light'));await publicPage.reload()
 await publicPage.getByRole('button',{name:'Sign in',exact:true}).first().waitFor({timeout:45000})
 assert.equal(await landingScene.evaluate(el=>getComputedStyle(el,'::after').opacity),'0','light mode restores the original public scenery')
 await publicContext.close()
 assert.deepEqual(errors, [])
 assert.deepEqual(remote, [])
 console.log('PASS signed-in light/dark surfaces, draft and edit preservation, account appearance reload, fresh-account login restoration, public/login/workspace background tint, native tool surfaces and input contrast; measured cursor accuracy at rendered button edges and glyphs during construction, scroll and resize; question-triggered full-page maps on desktop/mobile without remounting; cursor coverage across text/layout/controls, dynamic registration and Motion pause/resume without lost edits; progressive UI before stream completion; live calculation, checklist and sorting edits; reload restoration; follow-up preservation; form continuation; Stop; full-page conversation; mobile layout; new capability/library navigation and settings; no legacy carousel, floating icons or remote fixture traffic')
} catch(error) { await page?.screenshot({path: output+'/failure.png'}).catch(()=>{}); await writeFile(output+'/failure.json',JSON.stringify({errors,text:await page?.locator('body').innerText()},null,2)); throw error } finally { await context.close(); await browser.close(); await server?.close() }
