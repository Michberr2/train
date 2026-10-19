// Real Chromium DOM, actual content.js, mocked extension message transport.
// Fixture-only network interception: no user Chrome profile or live websites.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
const source = await fs.readFile('nalu-for-chrome/content.js', 'utf8')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
let checks = 0
await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
<form id="compose"><label>Message <input id="message" name="message"></label><button id="send">Send</button></form>
<input id="secret" type="password" value="private-fixture-password"><canvas id="canvas" width="200" height="100" style="display:block;background:#ccc"></canvas>
<form role="search"><input type="search" aria-label="Search"><button>Search</button></form>
<div id="shadow"></div><script>
window.submissions=0;window.enterEvents=0;window.canvasClicks=0;
document.querySelector('#compose').addEventListener('submit', e=>{e.preventDefault();window.submissions++});
document.querySelector('#message').addEventListener('keydown',()=>{window.enterEvents++});
document.querySelector('#canvas').addEventListener('click',()=>{window.canvasClicks++});
const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});shadow.innerHTML='<button aria-label="Shadow action">Shadow action</button>';
</script></body></html>` }))
await page.addInitScript(() => { window.chrome = { runtime: { onMessage: { addListener(listener) { window.contentListener = listener } } } } })
const message = payload => page.evaluate(payload => new Promise(resolve => window.contentListener(payload, {}, resolve)), payload)
const reset = async () => { await page.goto('https://nalu-fixture.invalid/compose'); await page.addScriptTag({ content: source }); return message({ type: 'snapshot' }) }
const expected = snap => ({ documentKey: snap.documentKey, snapshotKey: snap.snapshotKey, url: snap.url })
const refFor = (snap, label) => snap.elements.find(element => element.text === label)?.ref
const prepare = (action, snap) => message({ type: 'prepare', action, expected: expected(snap) })
const act = (action, snap, review) => message({ type: 'act', action, expected: expected(snap), reviewId: review.reviewId })
try {
  let snap = await reset()
  assert.ok(snap.documentKey && snap.snapshotKey)
  assert.ok(!JSON.stringify(snap).includes('private-fixture-password'), 'password value must not be sent to the model')
  assert.ok(refFor(snap, 'Shadow action'), 'open shadow-root targets remain available')
  checks++
  let action = { type: 'type', ref: snap.elements.find(element => element.tag === 'input' && element.inputType === 'text').ref, text: 'Hello', submit: true }
  let review = await prepare(action, snap)
  assert.equal(review.ok, true); assert.equal(review.target.form.search, false)
  assert.equal((await act(action, snap, review)).ok, true)
  assert.equal(await page.evaluate(() => window.submissions), 1)
  assert.equal(await page.evaluate(() => window.enterEvents), 0, 'do not send Enter AND requestSubmit and submit twice')
  assert.equal((await act(action, snap, review)).ok, false, 'review is single-use')
  assert.equal(await page.evaluate(() => window.submissions), 1)
  checks++

  for (const mutation of ['value', 'label', 'replace', 'SPA URL', 'new snapshot']) {
    snap = await reset()
    action = { type: 'type', ref: snap.elements.find(element => element.inputType === 'text').ref, text: 'Do not send stale data', submit: true }
    review = await prepare(action, snap)
    await page.evaluate(mutation => {
      const input = document.querySelector('#message')
      if (mutation === 'value') input.value = 'A user typed newer content'
      if (mutation === 'label') input.setAttribute('aria-label', 'Different action')
      if (mutation === 'replace') input.replaceWith(input.cloneNode(true))
      if (mutation === 'SPA URL') history.pushState({}, '', '/different-document-context')
      if (mutation === 'new snapshot') window.contentListener({ type: 'snapshot' }, {}, () => {})
    }, mutation)
    assert.equal((await act(action, snap, review)).ok, false, mutation)
    assert.equal(await page.evaluate(() => window.submissions), 0, mutation)
    checks++
  }
  snap = await reset()
  action = { type: 'click', ref: refFor(snap, 'Send') }
  review = await prepare(action, snap)
  assert.equal((await act({ ...action, ref: refFor(snap, 'Shadow action') }, snap, review)).ok, false)
  assert.equal(await page.evaluate(() => window.submissions), 0)
  checks++
  snap = await reset()
  action = { type: 'click', ref: refFor(snap, 'Send') }
  review = await prepare(action, snap)
  assert.equal((await act(action, { ...snap, documentKey: 'another-document' }, review)).ok, false)
  assert.equal(await page.evaluate(() => window.submissions), 0)
  checks++

  for (const overlay of [false, true]) {
    snap = await reset()
    const box = await page.locator('#canvas').boundingBox()
    action = { type: 'click_at', x: box.x + 40, y: box.y + 40 }
    review = await prepare(action, snap)
    assert.equal(review.ok, true)
    if (overlay) await page.evaluate(({ x, y }) => { const el = document.createElement('button'); el.textContent = 'Unreviewed target'; el.style.cssText = `position:fixed;left:${x - 10}px;top:${y - 10}px;width:50px;height:50px;z-index:1000`; document.body.append(el) }, action)
    const result = await act(action, snap, review)
    assert.equal(result.ok, !overlay)
    assert.equal(await page.evaluate(() => window.canvasClicks), overlay ? 0 : 1)
    checks++
  }
  snap = await reset()
  const search = snap.elements.find(element => element.inputType === 'search')
  review = await prepare({ type: 'type', ref: search.ref, text: 'wolves', submit: true }, snap)
  assert.equal(review.target.form.search, true)
  checks++
  console.log(`PASS ${checks} real Chromium content groups: password exclusion, shadow DOM, exact form submission, one-shot action reviews, DOM/value/label/SPA changes, document identity, coordinate overlays and search forms`)
} finally { await browser.close() }
