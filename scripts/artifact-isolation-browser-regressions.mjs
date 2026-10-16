import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Only synthetic secrets, local HTTP, and mocked publication are used. These
// tests exercise actual browser security boundaries, not a regex sanitizer.
const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.env.OUTPUT_DIR || '/tmp/nalu-artifact-isolation-regressions'
await mkdir(output, { recursive: true })
const source = String.raw`
import React from 'react'; import {createRoot} from 'react-dom/client';
import DesignCard from './client/src/components/workspace/DesignCard';
import DesignArtifactCard from './client/src/components/workspace/DesignArtifactCard';
import {LogoCard} from './client/src/components/workspace/StudioCards';
import {openArtifactBlob} from './client/src/components/workspace/artifactIsolation';
import {isolatedLogoSvg,logoImageUrl} from './client/src/components/workspace/logoSvg';
const app=createRoot(document.getElementById('root'));
const setArtifact=art=>app.render(<DesignArtifactCard art={art} onUpdate={next=>{window.savedArtifact=next;setArtifact(next)}}/>);
window.audit={setArtifact,setHtml:html=>app.render(<DesignCard html={html}/>),setSvg:svg=>app.render(<LogoCard art={{kind:'logo',name:'Security fixture',literal:true,options:[{mark:svg,lockup:svg}]}}/>),openBlob:(html,type,name)=>openArtifactBlob(new Blob([html],{type}),name),isolatedLogoSvg,logoImageUrl};
window.audit.setHtml('<!doctype html><html><head><title>Initial</title></head><body><h1>Initial</h1></body></html>');
`
const bundle = (await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', logLevel: 'silent' })).outputFiles[0].contents
const serverBundle = (await build({ entryPoints: [resolve(root, 'api/_artifactIsolation.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })).outputFiles[0].text
const { sendIsolatedArtifact } = await import('data:text/javascript;base64,' + Buffer.from(serverBundle).toString('base64'))
let publicHtml = '', exportedSvg = '', publicHeaders = {}, privateRequests = 0
const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(bundle); return }
  if (req.url === '/private') { privateRequests++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('SYNTHETIC-PRIVATE-ACCOUNT'); return }
  if (req.url === '/popup-child') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body>Artifact child<script>try{document.body.dataset.leak=localStorage.getItem("nalu-token")}catch{document.body.dataset.leak="blocked"}</script></body></html>'); return }
  if (req.url === '/shared') {
    const wrapped = { setHeader(k, v) { publicHeaders[k.toLowerCase()] = v; res.setHeader(k, v) }, status(n) { res.statusCode = n; return this }, send(body) { res.end(body) } }
    sendIsolatedArtifact(wrapped, publicHtml); return
  }
  if (req.url === '/export.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(exportedSvg); return }
  if (req.url?.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: {} })); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const html = `<!doctype html><html><head><title>Isolated application</title></head><body>
<h1>Isolated application</h1><button id="add">Add</button><output id="count">0</output><a href="#details">Details</a><section id="details">Details section</section>
<form id="form"><label>Quantity<input id="qty" type="number" value="3"></label><button>Calculate</button></form><output id="total">0</output>
<button id="download">Download JSON</button><button id="popup">Open child</button>
<script>window.instanceId=Math.random();const read=fn=>{try{return fn()}catch{return 'blocked'}};
window.result={local:read(()=>localStorage.getItem('nalu-token')),session:read(()=>sessionStorage.getItem('nalu-token')),cookie:read(()=>document.cookie),parent:read(()=>parent.localStorage.getItem('nalu-token')),top:read(()=>top.localStorage.getItem('nalu-token')),opener:!!opener};
localStorage.setItem('private-artifact','works'); result.ownStorage=localStorage.getItem('private-artifact');
fetch('${base}/private',{credentials:'include'}).then(r=>r.text()).then(text=>{result.account=text;document.body.dataset.ready='yes'}).catch(()=>{result.account='blocked';document.body.dataset.ready='yes'});
document.getElementById('add').onclick=()=>document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1);
document.getElementById('form').onsubmit=e=>{e.preventDefault();document.getElementById('total').textContent=String(Number(document.getElementById('qty').value)*7)};
document.getElementById('download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['{"ok":true}'],{type:'application/json'}));a.download='artifact.json';a.click()};
document.getElementById('popup').onclick=()=>window.open('${base}/popup-child','_blank');
</script></body></html>`
const report = { checks: [], limits: 'Local Chromium fixtures and current-source components. No real secrets, published malicious sites, or external requests.' }
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  await page.goto(base)
  const partialQuality = { runtime: { status: 'partial', widths: [1440, 390], checks: [{ name: 'Page renders', width: 1440, passed: true }], limitations: ['External services are disabled during checks.'] } }
  await page.evaluate(({ html, quality }) => window.audit.setArtifact({ kind: 'webpage', html, quality, truncated: true }), { html, quality: partialQuality })
  await expect(page.locator('summary')).toHaveText('Built · interaction checks incomplete')
  await page.locator('summary').click()
  await expect(page.getByText('The page passed basic browser checks. Its requested interactions still need testing.')).toBeVisible()
  await expect(page.getByText('External services are disabled during checks.')).toBeVisible()
  const passedQuality = { runtime: { ...partialQuality.runtime, status: 'passed' } }
  await page.route('**/api/design', route => route.fulfill({ json: { html: html.replace('Isolated application', 'Repaired application'), quality: passedQuality } }))
  await page.getByRole('button', { name: 'Finish build', exact: true }).click()
  await expect(page.locator('summary')).toHaveText('Built · browser checks passed')
  assert.deepEqual(await page.evaluate(() => window.savedArtifact.quality), passedQuality)
  report.checks.push({ name: 'Partial build has honest status and repair persists new revision quality', passed: true })
  await page.evaluate(html => window.audit.setHtml(html), html)
  await expect(page.locator('summary')).toHaveText('Browser checks unavailable for this version')
  report.checks.push({ name: 'Legacy artifacts never inherit another revision’s passed checks', passed: true })
  await page.evaluate(() => { localStorage.setItem('nalu-token', 'SYNTHETIC-NOT-A-REAL-TOKEN'); sessionStorage.setItem('nalu-token', 'SYNTHETIC-SESSION'); document.cookie = 'account=SYNTHETIC-COOKIE; SameSite=Lax' })
  const inspect = async (frame, label, { shim = true } = {}) => {
    await frame.locator('body[data-ready="yes"]').waitFor()
    const observed = await frame.locator('body').evaluate(() => window.result)
    assert.ok([null, 'blocked'].includes(observed.local), label + ': local storage isolated')
    assert.ok([null, 'blocked'].includes(observed.session), label + ': session storage isolated')
    assert.equal(observed.cookie, 'blocked', label + ': cookie isolated')
    assert.ok([null, 'blocked'].includes(observed.parent), label + ': parent isolated')
    assert.ok([null, 'blocked'].includes(observed.top), label + ': top isolated')
    assert.equal(observed.account, 'blocked', label + ': credentialed response unreadable')
    assert.equal(observed.opener, false, label + ': no account opener')
    if (shim) assert.equal(observed.ownStorage, 'works', label + ': own ephemeral storage works')
    report.checks.push({ name: label + ' account isolation', passed: true, observed })
    await frame.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(frame.locator('#count')).toHaveText('1')
    await frame.getByLabel('Quantity', { exact: true }).fill('9')
    await frame.getByRole('button', { name: 'Calculate', exact: true }).click()
    await expect(frame.locator('#total')).toHaveText('63')
    const instance = await frame.locator('body').evaluate(() => window.instanceId)
    await frame.getByRole('link', { name: 'Details', exact: true }).click()
    await expect(frame.locator('#details')).toBeVisible()
    await expect(frame.locator('#count')).toHaveText('1')
    await expect(frame.locator('#total')).toHaveText('63')
    assert.equal(await frame.locator('body').evaluate(() => window.instanceId), instance, label + ': fragment navigation preserves the running document')
    await expect.poll(() => frame.locator('body').evaluate(() => location.hash), { message: label + ': fragment URL updates' }).toBe('#details')
    report.checks.push({ name: label + ' scripts, form, calculation and fragment navigation', passed: true })
  }
  await page.evaluate(html => window.audit.setHtml(html), html)
  await inspect(page.frameLocator('iframe'), 'Inline preview')
  const openPromise = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const opened = await openPromise
  await inspect(opened.frameLocator('iframe'), 'Open in new tab')
  assert.equal(await opened.evaluate(() => window.opener), null)
  const downloadPromise = opened.waitForEvent('download')
  await opened.frameLocator('iframe').getByRole('button', { name: 'Download JSON', exact: true }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'artifact.json')
  assert.deepEqual(JSON.parse(await readFile(await download.path(), 'utf8')), { ok: true })
  report.checks.push({ name: 'Opened application downloads', passed: true })
  const childPending = context.waitForEvent('page')
  await opened.frameLocator('iframe').getByRole('button', { name: 'Open child', exact: true }).click()
  const child = await childPending
  await expect(child.locator('body')).toHaveAttribute('data-leak', 'blocked')
  await child.close()
  report.checks.push({ name: 'Artifact popup inherits opaque sandbox when navigating to account origin', passed: true })
  await opened.close()

  publicHtml = html
  const shared = await context.newPage()
  await shared.goto(base + '/shared')
  await inspect(shared, 'Public share')
  assert.match(publicHeaders['content-security-policy'], /^sandbox /)
  assert.doesNotMatch(publicHeaders['content-security-policy'], /allow-same-origin|allow-popups-to-escape-sandbox/)
  assert.equal(publicHeaders['x-content-type-options'], 'nosniff')
  assert.equal(publicHeaders['cache-control'], 'no-store')
  assert.equal(publicHeaders['referrer-policy'], 'no-referrer')
  report.checks.push({ name: 'Public response policy cannot be overridden by content', passed: true, headers: publicHeaders })
  const publicDownload = shared.waitForEvent('download')
  await shared.getByRole('button', { name: 'Download JSON', exact: true }).click()
  assert.deepEqual(JSON.parse(await readFile(await (await publicDownload).path(), 'utf8')), { ok: true })
  const publicChildPending = context.waitForEvent('page')
  await shared.getByRole('button', { name: 'Open child', exact: true }).click()
  const publicChild = await publicChildPending
  await expect(publicChild.locator('body')).toHaveAttribute('data-leak', 'blocked')
  await publicChild.close()
  report.checks.push({ name: 'Public share downloads work and popups inherit sandbox', passed: true })
  await shared.close()

  // Attachment documents have no app storage shim; their script handles denied
  // storage itself. MIME and filename disagree in the last two cases.
  const attachmentHtml = html.replace("localStorage.setItem('private-artifact','works'); result.ownStorage=localStorage.getItem('private-artifact');", '')
  for (const [type, name] of [['text/html', 'page.html'], ['application/octet-stream', 'page.html'], ['text/plain', 'page.html']]) {
    const pending = context.waitForEvent('page')
    await page.evaluate(({ html, type, name }) => window.audit.openBlob(html, type, name), { html: attachmentHtml, type, name })
    const attachment = await pending
    await attachment.waitForLoadState()
    assert.equal(await attachment.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-forms allow-popups allow-modals allow-downloads')
    if (type === 'text/html') await inspect(attachment.frameLocator('iframe'), 'HTML attachment', { shim: false })
    report.checks.push({ name: `Attachment boundary ${type} / ${name}`, passed: true })
    await attachment.close()
  }

  const attacks = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload='window.logoSentinel=localStorage.getItem("nalu-token")'><circle cx="5" cy="5" r="3"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="window.logoSentinel=localStorage.getItem('nalu-token')"><rect width="10" height="10"/></svg>`,
    `<svg viewBox="0 0 10 10" onload=window.logoSentinel=1><circle cx="5" cy="5" r="3"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>window.logoSentinel=localStorage.getItem('nalu-token')</script><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="bad" onerror="window.logoSentinel=1"/></div></foreignObject></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><a xlink:href="javascript:window.logoSentinel=1"><rect width="10" height="10"/></a><image href="${base}/private" width="10" height="10"/><style>@import url('${base}/private');</style></svg>`,
  ]
  for (const [index, svg] of attacks.entries()) {
    const before = privateRequests
    await page.evaluate(svg => window.audit.setSvg(svg), svg)
    await page.getByRole('button', { name: 'SVG', exact: true }).waitFor()
    // Wait for every image decode/error, including deliberately malformed XML.
    await expect.poll(() => page.locator('img').evaluateAll(imgs => imgs.every(img => img.complete))).toBe(true)
    assert.equal(await page.evaluate(() => window.logoSentinel), undefined)
    assert.equal(await page.locator('#root svg[onload], #root foreignObject, #root script').count(), 0)
    assert.equal(privateRequests, before, 'SVG image mode does not load external URLs')
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: 'SVG', exact: true }).click()
    exportedSvg = await readFile(await (await pending).path(), 'utf8')
    const exported = await context.newPage()
    await exported.goto(base + '/export.svg')
    assert.equal(await exported.evaluate(() => window.logoSentinel), undefined)
    assert.equal(await exported.locator('svg > image').count(), 1)
    assert.equal(await exported.locator('script, foreignObject, [onload]').count(), 0)
    await exported.close()
    report.checks.push({ name: `SVG attack ${index + 1}: preview and standalone export`, passed: true })
  }
  const validSvg = '<svg viewBox="0 0 200 100"><defs><linearGradient id="ink"><stop stop-color="currentColor"/><stop offset="1" stop-color="#00ff00"/></linearGradient></defs><rect width="200" height="100" rx="12" fill="url(#ink)"/><text x="20" y="55" fill="white" font-size="28">Nalu &amp; Co</text></svg>'
  await page.evaluate(svg => window.audit.setSvg(svg), validSvg)
  await expect.poll(() => page.getByRole('img', { name: 'Security fixture logo', exact: true }).evaluateAll(imgs => imgs.length > 0 && imgs.every(img => img.complete && img.naturalWidth === 200 && img.naturalHeight === 100))).toBe(true)
  const pngPending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PNG', exact: true }).click()
  const pngPath = await (await pngPending).path()
  const png = await readFile(pngPath)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 1400)
  assert.equal(png.readUInt32BE(20), 700)
  exportedSvg = await page.evaluate(svg => window.audit.isolatedLogoSvg(svg), validSvg)
  // Decode the exported vector as an image and inspect its actual pixels. This
  // catches a safe-but-blank nested SVG regression rather than just checking DOM.
  const pixels = await page.evaluate(async svg => {
    const image = new Image(); image.src = 'data:image/svg+xml,' + encodeURIComponent(svg); await image.decode()
    const c = document.createElement('canvas'); c.width = 200; c.height = 100
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0)
    return [...ctx.getImageData(100, 10, 1, 1).data]
  }, exportedSvg)
  assert.equal(pixels[3], 255); assert.ok(pixels[1] > 100)
  report.checks.push({ name: 'Valid logo image, PNG dimensions, exported vector pixels', passed: true, pixels })
  await page.screenshot({ path: resolve(output, 'valid-logo.png') })

  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Revision one</h1></body></html>'))
  const requests = [], pendingShares = []
  await page.route('**/api/data', async route => {
    const body = route.request().postDataJSON(); requests.push(body)
    if (body.html?.includes('Slow revision')) { pendingShares.push(route); return }
    if (body.html?.includes('Oversized revision')) { await route.fulfill({ status: 413, json: { error: 'This site is too large to share. Download the complete HTML instead.' } }); return }
    await route.fulfill({ json: { ok: true, url: '/api/data?share=revision-' + requests.length } })
  })
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('link', { name: base + '/api/data?share=revision-1', exact: true })).toBeVisible()
  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Revision two</h1></body></html>'))
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('link', { name: base + '/api/data?share=revision-2', exact: true })).toBeVisible()
  assert.equal(requests.length, 2); assert.match(requests[1].html, /Revision two/)
  report.checks.push({ name: 'Share after edit publishes current HTML and labels snapshot URL', passed: true })

  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Slow revision</h1></body></html>'))
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect.poll(() => pendingShares.length).toBe(1)
  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Newest revision</h1></body></html>'))
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('link', { name: base + '/api/data?share=revision-4', exact: true })).toBeVisible()
  await pendingShares[0].fulfill({ json: { ok: true, url: '/api/data?share=stale-revision' } }).catch(() => {})
  await expect(page.getByRole('link', { name: base + '/api/data?share=revision-4', exact: true })).toBeVisible()
  assert.equal(await page.locator('[href*="stale-revision"]').count(), 0)
  report.checks.push({ name: 'Old in-flight publication cannot attach its URL to a newer revision', passed: true })
  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Slow revision again</h1></body></html>'))
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect.poll(() => pendingShares.length).toBe(2)
  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Different revision</h1></body></html>'))
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible()
  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Slow revision again</h1></body></html>'))
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible()
  await pendingShares[1].fulfill({ json: { ok: true, url: '/api/data?share=aborted-revision' } }).catch(() => {})
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible()
  assert.equal(await page.locator('[href*="aborted-revision"]').count(), 0)
  report.checks.push({ name: 'Returning to a canceled revision allows sharing again', passed: true })
  await page.evaluate(() => window.audit.setHtml('<html><head></head><body><h1>Oversized revision</h1></body></html>'))
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('This site is too large to share. Download the complete HTML instead.')
  assert.equal(await page.locator('a[href*="/api/data?share="]').count(), 0)
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible()
  report.checks.push({ name: 'Rejected publication exposes actionable error with no incorrect URL', passed: true })
  report.passed = true
  await context.close()
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(`PASS ${report.checks.length} artifact isolation, SVG rendering/export and share revision checks. ${output}/report.json`)
