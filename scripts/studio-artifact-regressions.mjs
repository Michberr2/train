// Real Workspace chat + Studio with saved synthetic artifacts and real exports.
// All APIs are mocked; no provider/account calls. Uses a separate source server,
// never rebuilds or replaces client/dist. AUDIT_ONLY=1 records known failures.
// BASE_URL=https://candidate.example node scripts/studio-artifact-regressions.mjs
// --allow-public-fixture uses deployed assets with the same fully mocked APIs.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createServer } from 'vite'
import { chromium, expect } from '@playwright/test'
import JSZip from 'jszip'
import sharp from 'sharp'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../client/tailwind.config.js'
import { artifacts } from './studio-artifact-fixtures.mjs'

const output = process.env.OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'nalu-other-studio-'))
await mkdir(output, { recursive: true })
const target = process.env.BASE_URL ? new URL(process.env.BASE_URL) : null
if (target && !['http:', 'https:'].includes(target.protocol)) throw new Error('BASE_URL must use HTTP or HTTPS')
if (target && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !process.argv.includes('--allow-public-fixture')) throw new Error('Pass --allow-public-fixture to explicitly use a public frontend with mocked account APIs')
const clientRoot = fileURLToPath(new URL('../client/', import.meta.url))
const server = target ? null : await createServer({ configFile: join(clientRoot, 'vite.config.ts'), root: clientRoot, cacheDir: join(output, 'vite-cache'), css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [clientRoot + '/src/**/*.{ts,tsx}'] }), autoprefixer()] } }, server: { host: '127.0.0.1', port: 5194, strictPort: true, hmr: false } })
const origin = target?.origin || 'http://127.0.0.1:5194'
const report = { output, origin, mode: target ? 'deployed-assets' : 'isolated-source', tested: [], findings: [], pageErrors: [], consoleErrors: [], failedRequests: [], assets: [], blockedExternal: [], apiActions: [] }
const check = (kind, label, run) => { try { run(); return true } catch (error) { report.findings.push({ kind, label, error: error.message }); return false } }
const image = await sharp({ create: { width: 320, height: 220, channels: 3, background: '#285946' } }).png().toBuffer()
let browser
try {
  await server?.listen()
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => report.pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()) })
  page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('requestfinished', request => {
    const url = new URL(request.url())
    if (url.origin === origin && /^\/(?:assets|fonts)\//.test(url.pathname)) {
      const timing = request.timing()
      report.assets.push({ path: url.pathname, durationMs: Math.round(timing.responseEnd) })
    }
  })
  await page.addInitScript(({ artifacts }) => {
    if (window.top !== window) return
    if (localStorage.getItem('other-studio-fixture')) return
    localStorage.setItem('other-studio-fixture', '1')
    localStorage.setItem('nalu-token', 'offline-other-studio-fixture')
    localStorage.setItem('nalu-data-owner', 'offline-studio')
    localStorage.setItem('nalu-view', 'studio')
    localStorage.setItem('nalu-theme', 'dark')
    localStorage.setItem('nalu-chats', JSON.stringify(artifacts.map(({ id, title, art }) => ({ id, title, createdAt: Date.now(), messages: [{ role: 'user', content: `Show ${title}.` }, { role: 'assistant', content: '', design: art }] }))))
  }, { artifacts })
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedFixture = value } } }))
  // Do not intercept ordinary same-origin static assets: exercise the CDN and
  // the deployed lazy chunks normally, while every account/API call is mocked.
  await page.route(url => url.origin !== origin && !['data:', 'blob:'].includes(url.protocol), route => {
    const url = new URL(route.request().url())
    report.blockedExternal.push(url.origin + url.pathname)
    // Image-loading code runs, but only deterministic synthetic bytes arrive.
    if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: image })
    return route.abort()
  })
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    const body = route.request().postDataJSON() || {}
    report.apiActions.push({ path: url.pathname, action: body.action })
    if (url.pathname === '/api/auth') return route.fulfill({ json: { ok: true, user: { id: 'offline-studio', displayName: 'Offline Studio' } } })
    if (url.pathname === '/api/data') return route.fulfill({ json: { ok: true, data: {}, entries: {}, activity: [] } })
    if (['/api/design', '/api/chat', '/api/video', '/api/image'].includes(url.pathname)) { report.findings.push({ kind: 'network', label: 'unexpected generation request', path: url.pathname }); return route.abort() }
    return route.fulfill({ json: { ok: true, results: [], outputs: [], items: [], connections: [] } })
  })
  const started = Date.now()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  report.entry = await page.locator('script[type="module"][src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')))
  console.log(`Frontend entry: ${report.entry.join(', ')}`)
  const save = async (scope, label, file) => {
    const event = page.waitForEvent('download')
    await scope.getByRole('button', { name: label, exact: true }).click()
    const download = await event
    await download.saveAs(join(output, file))
    return readFile(join(output, file))
  }
  const galleryButton = title => page.getByRole('button').filter({ has: page.getByText(title, { exact: true }) }).last()
  const selectStudio = async () => {
    // The authenticated app opens its space picker even with a saved view.
    // Wait for that shell before checking lazy navigation, then enter Studio
    // through the same carousel control a returning account uses.
    await page.locator('.nalu-workspace').waitFor()
    if (await page.locator('.nalu-workspace[data-workspace-launcher=true]').count()) {
      const carousel = page.getByRole('region', { name: 'Choose a workspace', exact: true })
      await carousel.waitFor()
      await carousel.getByRole('button', { name: 'Show Studio', exact: true }).click()
      await carousel.getByRole('button', { name: 'Open Studio', exact: true }).click()
      await expect(carousel).toBeHidden()
      return
    }
    const dock = page.getByRole('navigation', { name: 'Workspace navigation', exact: true })
    if (await dock.count()) await dock.getByRole('button', { name: 'Studio', exact: true }).click()
    else if (await page.locator('.nalu-workspace').getAttribute('data-workspace-view') !== 'studio') {
      await page.getByRole('button', { name: 'Chats', exact: true }).click()
      await page.getByRole('button', { name: 'Studio', exact: true }).click()
    }
  }
  const showLibrary = async () => {
    await selectStudio()
    await page.getByRole('button', { name: /Your creations/ }).click()
    await page.locator('.ws-studio-library').waitFor()
  }
  const open = async title => {
    if (!await page.locator('.ws-studio-library').isVisible()) await showLibrary()
    const button = galleryButton(title)
    await button.waitFor({ timeout: 30000 }); await button.click()
    const overlay = page.getByRole('dialog', { name: title, exact: true })
    await overlay.waitFor()
    return overlay
  }
  const returnStudio = selectStudio
  for (const item of artifacts.filter(item => !process.env.ARTIFACT_CASE || process.env.ARTIFACT_CASE.split(',').includes(item.id))) {
    const { id, title, art } = item
    try {
      const overlay = await open(title)
      if (report.firstOverlayMs == null) report.firstOverlayMs = Date.now() - started
      const details = { id, studio: false, chat: false, downloads: [] }
      if (art.html) {
        const frame = overlay.frameLocator('iframe[title="Nalu Design"]')
        await frame.getByRole('heading', { level: 1 }).waitFor()
        if (id === 'game') {
          await frame.getByRole('button', { name: 'Start game', exact: true }).click()
          await frame.getByRole('button', { name: 'Catch light', exact: true }).click()
          await expect(frame.getByText('Score: 1', { exact: true })).toBeVisible()
          await frame.getByRole('button', { name: 'Restart', exact: true }).click()
          await expect(frame.getByText('Score: 0', { exact: true })).toBeVisible()
          details.gameplay = 'start, score, restart and sandboxed storage passed'
        }
        if (id === 'board') { await frame.getByRole('button', { name: 'Show specification', exact: true }).click(); await frame.getByText('SPEC_END: keep the supplied 12 m span.', { exact: true }).waitFor() }
        const html = await save(overlay, 'HTML', `${id}.html`)
        check(id, 'HTML export retains every source byte', () => assert.equal(html.toString(), art.html))
        details.downloads.push('HTML')
        const standalone = await browser.newPage()
        await standalone.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort())
        await standalone.goto(pathToFileURL(join(output, `${id}.html`)).href)
        await standalone.getByRole('heading', { level: 1 }).waitFor()
        if (id === 'game') { await standalone.getByRole('button', { name: 'Start game', exact: true }).click(); await standalone.getByRole('button', { name: 'Catch light', exact: true }).click(); await expect(standalone.getByText('Score: 1', { exact: true })).toBeVisible() }
        await standalone.screenshot({ path: join(output, `${id}-standalone.png`) }); await standalone.close()
      } else if (id === 'palette') {
        await overlay.getByRole('button', { name: 'CSS', exact: true }).waitFor()
        report.firstPreviewMs = Date.now() - started
        const css = await save(overlay, 'CSS', 'palette.css')
        const tw = JSON.parse((await save(overlay, 'Tailwind', 'palette.tailwind.json')).toString())
        const json = JSON.parse((await save(overlay, 'JSON', 'palette.json')).toString())
        for (const color of art.colors) { assert.ok(css.toString().toLowerCase().includes(color.hex.toLowerCase())); assert.ok(JSON.stringify(tw).toLowerCase().includes(color.hex.toLowerCase())) }
        check(id, 'JSON preserves alternate directions and fonts', () => { assert.deepEqual(json.options, art.options); assert.deepEqual(json.fonts, art.fonts) })
        check(id, 'JSON retains the complete saved palette contract', () => assert.deepEqual(json, art))
        await save(overlay, 'PNG', 'palette.png')
        assert.ok((await sharp(join(output, 'palette.png')).metadata()).width >= 1000)
        await overlay.getByRole('button', { name: 'Use & save', exact: true }).last().click()
        const kit = await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-active-brand')))
        assert.equal(kit.name, 'Warm alternative')
        details.downloads.push('CSS', 'Tailwind JSON', 'JSON', 'PNG'); details.brandSave = true
      } else if (id === 'brand') {
        const docx = await save(overlay, 'DOCX', 'brand.docx')
        const doc = await JSZip.loadAsync(docx), xml = await doc.file('word/document.xml').async('string')
        const docText = await page.evaluate(xml => Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('w:t')).map(node => node.textContent).join(' '), xml)
        await save(overlay, 'PDF', 'brand.pdf')
        const info = execFileSync('pdfinfo', [join(output, 'brand.pdf')], { encoding: 'utf8' })
        execFileSync('pdftotext', ['-layout', join(output, 'brand.pdf'), join(output, 'brand-pdf.txt')])
        const pdfText = await readFile(join(output, 'brand-pdf.txt'), 'utf8')
        const requiredCopy = [art.brand.name, art.brand.tagline, art.brand.mission, ...art.brand.voice,
          ...art.palette.flatMap(color => [color.role, color.name, color.hex, color.usage]),
          art.typography.heading.usage, art.typography.body.usage, ...Object.values(art.logo), ...art.dos, ...art.donts,
          'Type scale: ' + art.typography.scale.join(' · ') + ' px',
          `Base: ${art.spacing.base} px`, 'Spacing scale: ' + art.spacing.scale.join(' · ') + ' px',
        ]
        const compact = value => value.replace(/\s+/g, ' ').trim()
        for (const copy of requiredCopy) {
          check(id, 'DOCX retains supplied copy: ' + copy.slice(0, 55), () => assert.ok(compact(docText).includes(compact(copy))))
          check(id, 'PDF retains supplied copy: ' + copy.slice(0, 55), () => assert.ok(compact(pdfText).includes(compact(copy))))
        }
        for (const token of ['LOGO_DIRECTION_END', 'LOGO_CLEARSPACE_END', 'LOGO_MINSIZE_END', 'HEAD_USAGE_END', 'BODY_USAGE_END', 'DO_END_12', 'DONT_END_8']) {
          check(id, `DOCX preserves ${token}`, () => assert.ok(xml.includes(token)))
          check(id, `PDF preserves visible ${token}`, () => assert.ok(pdfText.includes(token)))
        }
        check(id, 'long PDF guidelines paginate', () => assert.ok(Number(info.match(/Pages:\s+(\d+)/)[1]) > 1))
        execFileSync('pdftoppm', ['-png', '-scale-to', '1000', join(output, 'brand.pdf'), join(output, 'brand-page')])
        details.downloads.push('PDF', 'DOCX')
      } else if (art.kind === 'logo') {
        await overlay.getByRole('button', { name: 'Save to Brand', exact: true }).waitFor()
        const svg = await save(overlay, 'SVG', `${id}.svg`)
        const decoded = await page.evaluate(async svg => { const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); try { await image.decode(); return { ok: true, width: image.naturalWidth, height: image.naturalHeight } } catch { return { ok: false } } }, svg.toString())
        check(id, 'downloaded SVG is a standalone decodable image', () => assert.equal(decoded.ok, true))
        if (id === 'logo_legacy') {
          check(id, 'complete legacy SVG bytes remain inside the safe image boundary', () => {
            const exported = svg.toString()
            const embedded = exported.match(/<image[^>]+(?:href|xlink:href)="data:image\/svg\+xml,([^"]+)"/)
            assert.equal(embedded ? decodeURIComponent(embedded[1]) : exported, art.options[0].mark)
          })
          check(id, 'legacy SVG retains intrinsic dimensions', () => assert.deepEqual([decoded.width, decoded.height], [600, 120]))
        } else {
          const viewBox = svg.toString().match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number)
          check(id, 'standalone SVG preserves the supplied aspect ratio', () => assert.equal(decoded.width / decoded.height, viewBox[2] / viewBox[3]))
        }
        const png = await save(overlay, 'PNG', `${id}.png`)
        assert.equal((await sharp(png).metadata()).width, 1400)
        if (id === 'logo_legacy') {
          assert.equal((await sharp(png).metadata()).height, 280)
          const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
          const pixel = (x, y) => [...data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]
          assert.deepEqual(pixel(1000, 140), [22, 78, 58], 'the supplied rectangle must survive raster scaling at its original relative position')
          assert.deepEqual(pixel(200, 140), [255, 255, 255], 'the original empty portion of the wide logo must remain empty')
        }
        await save(overlay, 'Mark PNG', `${id}-mark.png`)
        await overlay.getByRole('button', { name: 'Save to Brand', exact: true }).click()
        const kit = await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-active-brand')))
        assert.ok(kit.logo.startsWith('data:'))
        details.downloads.push('SVG', 'PNG', 'Mark PNG'); details.brandSave = true
      } else if (id === 'blueprint') {
        await overlay.getByRole('button', { name: 'Upper floor', exact: true }).click()
        const svg = await save(overlay, 'SVG', 'blueprint.svg')
        assert.ok(svg.toString().includes('UPPER_FLOOR_END')); assert.ok(!svg.toString().includes('Living room'))
        const dimensions = await overlay.locator('svg[data-blueprint]').evaluate(el => ({ width: +el.getAttribute('width'), height: +el.getAttribute('height') }))
        const png = await save(overlay, 'PNG', 'blueprint.png')
        const meta = await sharp(png).metadata()
        assert.deepEqual([meta.width, meta.height], [dimensions.width * 2, dimensions.height * 2])
        await save(overlay, 'PDF', 'blueprint.pdf')
        execFileSync('pdftoppm', ['-png', '-scale-to', '1000', join(output, 'blueprint.pdf'), join(output, 'blueprint-page')])
        details.downloads.push('selected-floor SVG', 'selected-floor PNG', 'selected-floor PDF')
        await overlay.getByRole('button', { name: 'View 3D', exact: true }).click()
        await overlay.locator('canvas').waitFor()
        await overlay.getByRole('button', { name: 'Furnish', exact: true }).click()
        await overlay.getByRole('button', { name: '+ Sofa', exact: true }).click()
        await overlay.getByRole('button', { name: 'Clear all (1)', exact: true }).waitFor()
        const originalCanvas = await overlay.locator('canvas').elementHandle()
        // Exercise a real parent render while this 3D view stays mounted. A
        // Real saved-data hydration must not discard the WebGL scene/camera or canvas.
        await page.evaluate(() => window.dispatchEvent(new Event('nalu-hydrated')))
        await page.waitForTimeout(400)
        assert.ok(await originalCanvas.evaluate(canvas => canvas.isConnected), 'A parent render replaced the active WebGL canvas')
        details.scenePreserved = true
        await overlay.locator('canvas').screenshot({ path: join(output, 'blueprint-3d.png') })
        await overlay.getByRole('button', { name: '2D Plan', exact: true }).click()
        await overlay.getByRole('button', { name: 'View 3D', exact: true }).click()
        await overlay.getByRole('button', { name: 'Furnish', exact: true }).click()
        await overlay.getByRole('button', { name: 'Clear all (1)', exact: true }).waitFor()
        details.furniture = 'real WebGL scene, added sofa persists after 3D remount'
        await overlay.getByRole('button', { name: '2D Plan', exact: true }).click()
      } else if (id === 'shopping') {
        await overlay.getByRole('button', { name: 'Copy list', exact: true }).click()
        const copied = await page.evaluate(() => window.__copiedFixture)
        for (const product of art.items) assert.ok(copied.includes(product.name) && copied.includes(product.price))
        const links = await overlay.getByRole('link', { name: 'Shop', exact: true }).evaluateAll(links => links.map(link => link.href))
        assert.equal(links.length, 2)
        for (const [i, link] of links.entries()) assert.ok(decodeURIComponent(link).includes(art.items[i].query))
        details.copyAndLinks = true
        await overlay.getByRole('button', { name: /^Walk the room in 3D/ }).click()
        await overlay.locator('canvas').waitFor()
        await overlay.getByRole('button', { name: 'Furnish', exact: true }).click()
        const clear = overlay.getByRole('button', { name: /^Clear all \(/ })
        await clear.waitFor()
        await expect(overlay.locator('canvas')).toBeVisible()
        // The room finishes its asset load asynchronously; capture its stable
        // containing dialog rather than pinning a transient canvas node.
        await overlay.screenshot({ path: join(output, 'shopping-3d.png') })
        details.furniture = await clear.textContent()
        await clear.click()
        await expect(clear).toHaveCount(0)
        await overlay.getByRole('button', { name: 'Back to preview', exact: true }).click()
        await overlay.getByRole('button', { name: /^Walk the room in 3D/ }).click()
        await overlay.getByRole('button', { name: 'Furnish', exact: true }).click()
        if (await clear.count()) report.findings.push({ kind: id, label: 'clearing all room furniture survives reopening 3D', error: 'Removed furniture was restored from initial suggestions instead of preserving the saved empty room.' })
        else details.emptyRoomPersistence = true
        await overlay.getByRole('button', { name: 'Back to preview', exact: true }).click()
      }
      details.studio = true
      await overlay.screenshot({ path: join(output, `${id}-studio.png`) })
      await overlay.getByRole('button', { name: 'Open in chat', exact: true }).click()
      if (art.html) await page.locator('.ws-chat-thread:visible').frameLocator('iframe[title="Nalu Design"]').getByRole('heading', { level: 1 }).waitFor()
      else await page.locator('.ws-chat-thread:visible').getByText(id === 'brand' ? art.brand.name : art.name || art.title, { exact: false }).first().waitFor()
      details.chat = true
      const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('nalu-chats')).find(chat => chat.id === id).messages[1].design, id)
      assert.deepEqual(saved, art, 'opening/exporting a saved creation must preserve the complete source artifact')
      await returnStudio()
      report.tested.push(details)
      console.log(`Checked ${id}: Studio + chat; ${details.downloads.join(', ') || 'interactive preview'}`)
    } catch (error) {
      report.findings.push({ kind: id, label: 'UI/export flow', error: error.message })
      await page.screenshot({ path: join(output, `${id}-failure.png`) }).catch(() => {})
      await page.evaluate(() => localStorage.setItem('nalu-view', 'studio'))
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await showLibrary()
  for (const { title } of artifacts) await galleryButton(title).waitFor()
  report.reload = 'all saved artifacts restored in Studio'
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ entry: report.entry, firstPreviewMs: report.firstPreviewMs, tested: report.tested.map(x => x.id), findings: report.findings, pageErrors: report.pageErrors, consoleErrors: report.consoleErrors, failedRequests: report.failedRequests, output }, null, 2))
  if (!process.env.AUDIT_ONLY) { assert.deepEqual(report.findings, []); assert.deepEqual(report.pageErrors, []) }
} finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close() }
