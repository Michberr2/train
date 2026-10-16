// Actual editable Canvas and Carousel cards; local fixtures only, no providers.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import sharp from 'sharp'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../client/tailwind.config.js'
import JSZip from 'jszip'
import { execFileSync } from 'node:child_process'
const output = '/tmp/nalu-canvas-carousel'
await mkdir(output, { recursive: true })
const canvas = { kind: 'canvas', name: 'Native canvas', canvas: { width: 1200, height: 503, background: '#ffffff', objects: [{ type: 'Rect', left: 1030, top: 90, width: 140, height: 200, fill: '#174fce', strokeWidth: 0 }, { type: 'Textbox', left: 70, top: 85, width: 780, text: 'Canvas text stays editable', fontSize: 54, fontFamily: 'Arial', fill: '#17283f' }] } }
canvas.canvas.objects.push({ type: 'Rect', left: 900, top: 400, width: 80, height: 40, fill: '#cc3344', strokeWidth: 0, originX: 'center', originY: 'center' })
const carousel = { kind: 'carousel', name: 'Readable social slides', platform: 'Instagram', ratio: '4:5', handle: '@fixture', theme: { bg: '#102238', bg2: '#102238', ink: '#ffffff', accent: '#e8b95c', headingFont: 'Inter', bodyFont: 'Inter' }, slides: [{ kind: 'cover', headline: 'A clear idea', sub: 'A visible subtitle with complete source text.', body: ['Body text must stay readable. CAROUSEL_BODY_END'] }, { kind: 'point', headline: 'Keep the whole message', badge: '02', body: ['The second slide also needs its complete body text.', 'Preserve the final qualification. CAROUSEL_LAST_END'] }], caption: 'Keep this complete caption.', hashtags: ['#Fixture'] }
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import CanvasCard from '/src/components/workspace/CanvasCard.tsx';import CarouselCard,{carouselToHtml} from '/src/components/workspace/CarouselCard.tsx';import '/src/globals.css';
const root=createRoot(document.getElementById('root'));window.carouselToHtml=carouselToHtml;
window.showArtifact=(kind,art)=>root.render(React.createElement(kind==='canvas'?CanvasCard:CarouselCard,{art,onUpdate:next=>{const value=kind==='canvas'?{...art,canvas:next}:next;localStorage.setItem('qa-saved-'+kind,JSON.stringify(value));window.showArtifact(kind,value)}}));`
const clientRoot = fileURLToPath(new URL('../client', import.meta.url))
const server = await createServer({ configFile: false, root: clientRoot, cacheDir: `${output}/vite-cache`, css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [clientRoot + '/src/**/*.{js,ts,jsx,tsx}'] }), autoprefixer()] } }, plugins: [react(), { name: 'canvas-carousel-fixture', resolveId(id) { if (id === '/@canvas-carousel-fixture') return '\0canvas-carousel-fixture' }, load(id) { if (id === '\0canvas-carousel-fixture') return fixture }, configureServer(vite) { vite.middlewares.use('/__canvas-carousel', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__canvas-carousel', '<!doctype html><html><body style="margin:0;background:#181a20"><main id="root" style="max-width:900px;margin:auto"></main><script type="module" src="/@canvas-carousel-fixture"></script></body></html>')) }) } }], server: { host: '127.0.0.1', port: 5189, strictPort: true } })
let browser
try {
  await server.listen(); browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1040, height: 960 } })
  const errors = [], external = []
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message) })
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== 'http://127.0.0.1:5189' && !['data:', 'blob:'].includes(url.protocol)) { external.push(url.href); return route.abort() }; return route.continue() })
  await page.goto('http://127.0.0.1:5189/__canvas-carousel'); await page.waitForFunction(() => !!window.showArtifact)
  const saveDownload = async (button, filename) => { const event = page.waitForEvent('download'); await button.click(); const download = await event; await download.saveAs(`${output}/${filename}`); return download.suggestedFilename() }
  await page.evaluate(art => window.showArtifact('carousel', art), carousel)
  await page.getByRole('heading', { name: 'A clear idea', exact: true }).waitFor()
  const textMetrics = await page.getByText('Body text must stay readable. CAROUSEL_BODY_END', { exact: true }).evaluate(el => ({ size: getComputedStyle(el).fontSize, box: { w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height } }))
  await page.screenshot({ path: `${output}/carousel-preview.png`, fullPage: true })
  const html = await page.evaluate(art => window.carouselToHtml(art), carousel)
  await writeFile(`${output}/carousel.html`, html)
  if (!process.env.AUDIT_ONLY) {
    await writeFile(`${output}/copy-bounds.json`, JSON.stringify(await page.locator('[data-carousel-copy]').evaluateAll(copies => copies.map(copy => ({box:copy.getBoundingClientRect().toJSON(),children:[...copy.children].map(child=>{const range=document.createRange();range.selectNodeContents(child);return {text:child.textContent,box:range.getBoundingClientRect().toJSON()}})}))),null,2));
    await expect(page.getByRole('button', { name: 'Download all', exact: true })).toBeEnabled()
    await saveDownload(page.getByRole('button', { name: 'This slide', exact: true }), 'carousel-desktop.png')
    assert.deepEqual(await sharp(`${output}/carousel-desktop.png`).metadata().then(m => [m.width, m.height]), [1080, 1350])
    await saveDownload(page.getByRole('button', { name: 'Download all', exact: true }), 'carousel.zip')
    const zip = await JSZip.loadAsync(await readFile(`${output}/carousel.zip`))
    assert.equal(Object.keys(zip.files).length, 2)
    for (const file of Object.values(zip.files)) assert.deepEqual(await sharp(await file.async('nodebuffer')).metadata().then(m => [m.width, m.height]), [1080, 1350])
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(page.getByRole('button', { name: 'This slide', exact: true })).toBeEnabled()
    await saveDownload(page.getByRole('button', { name: 'This slide', exact: true }), 'carousel-mobile.png')
    assert.deepEqual(await sharp(`${output}/carousel-mobile.png`).metadata().then(m => [m.width, m.height]), [1080, 1350])
    const desktop = await sharp(`${output}/carousel-desktop.png`).raw().toBuffer(), mobile = await sharp(`${output}/carousel-mobile.png`).raw().toBuffer()
    let rasterDifference = 0, changedChannels = 0
    for (let i = 0; i < desktop.length; i++) { const difference = Math.abs(desktop[i] - mobile[i]); rasterDifference += difference; if (difference) changedChannels++ }
    assert.ok(rasterDifference / desktop.length < .7 && changedChannels / desktop.length < .01, 'responsive exports must keep layout; allow subpixel text antialiasing only')
    await page.screenshot({ path: `${output}/carousel-mobile-preview.png`, fullPage: true })
    const standalone = await browser.newPage({ viewport: { width: 500, height: 900 } })
    await standalone.route('**/*', route => route.abort())
    await standalone.setContent(html)
    const standaloneFont = await standalone.getByText('Body text must stay readable. CAROUSEL_BODY_END', { exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize))
    assert.ok(standaloneFont >= 14)
    await standalone.close()
    const photoArt = { ...carousel, name: 'A wider view', theme: { ...carousel.theme, bg: '#102f2b', bg2: '#102f2b', accent: '#f7dda7', headingFont: 'Source Serif 4' }, slides: [{ kind: 'cover', headline: 'Make room for a wider view.', sub: 'A fresh perspective starts with a little breathing space.', img: '/images/bg-meadow-sunset.png' }, { kind: 'point', badge: '01', headline: 'Start with what matters.', body: ['Choose one clear idea.', 'Give it room to be understood.', 'Keep the next step easy to find.'] }] }
    await page.evaluate(art => window.showArtifact('carousel', art), photoArt)
    await expect(page.getByRole('button', { name: 'This slide', exact: true })).toBeEnabled({ timeout: 30000 })
    await page.locator('[data-carousel-slide]').first().screenshot({ path: `${output}/carousel-photo-preview.png` })
    await saveDownload(page.getByRole('button', { name: 'This slide', exact: true }), 'carousel-photo.png')
    const expectedPhotoPixel = await page.locator('[data-carousel-slide] img').first().evaluate(image => {
      const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1350
      const ctx = canvas.getContext('2d'), scale = Math.max(1080 / image.naturalWidth, 1350 / image.naturalHeight)
      const w = image.naturalWidth * scale, h = image.naturalHeight * scale
      ctx.drawImage(image, (1080 - w) / 2, (1350 - h) / 2, w, h)
      const raw = ctx.getImageData(950, 150, 1, 1).data, alpha = 0x22 / 255 + (0xcc - 0x22) / 255 * (150.5 / 1350)
      return [16, 47, 43].map((bg, i) => Math.round(raw[i] * (1 - alpha) + bg * alpha))
    })
    const actualPhotoPixel = [...await sharp(`${output}/carousel-photo.png`).extract({ left: 950, top: 150, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
    assert.ok(actualPhotoPixel.every((channel, i) => Math.abs(channel - expectedPhotoPixel[i]) <= 5), `PNG must preserve cover crop and overlay: ${actualPhotoPixel} vs ${expectedPhotoPixel}`)
    await page.getByRole('button', { name: 'Next slide', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Slide 2', exact: true })).toHaveAttribute('aria-current', 'true')
    assert.equal(await saveDownload(page.getByRole('button', { name: 'This slide', exact: true }), 'carousel-editorial-point.png'), 'instagram-slide-2.png', 'Next then export must retain the requested selection during smooth scrolling')
    const pointPixel = [...await sharp(`${output}/carousel-editorial-point.png`).extract({ left: 950, top: 700, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
    assert.deepEqual(pointPixel, [16, 47, 43], 'slide 2 must contain its own solid background, not the previous cover photograph')
    await page.evaluate(art => window.showArtifact('carousel', { ...art, slides: [{ kind: 'cover', headline: 'An unavailable image', img: '/fixture-missing-image.png' }] }), carousel)
    await expect(page.getByRole('button', { name: 'This slide', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'This slide', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'image could not load' })).toBeVisible()
    await page.evaluate(art => window.showArtifact('carousel', { ...art, slides: [{ kind: 'point', headline: 'Too much source text', body: Array.from({ length: 12 }, (_, i) => `Long paragraph ${i + 1} repeats the complete source wording that cannot fit into one readable social slide.`) }] }), carousel)
    await expect(page.getByRole('alert').filter({ hasText: 'need more space' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download all', exact: true })).toBeDisabled()
  }
  await page.evaluate(art => window.showArtifact('canvas', art), canvas)
  await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeEnabled({ timeout: 30000 })
  await saveDownload(page.getByRole('button', { name: 'JSON', exact: true }), 'canvas.json')
  const json = JSON.parse(await readFile(`${output}/canvas.json`, 'utf8'))
  await page.screenshot({ path: `${output}/canvas-preview.png`, fullPage: true })
  if (process.env.AUDIT_ONLY) { console.log(JSON.stringify({ textMetrics, exportedSceneWidth: json.canvas.width, exportedSceneHeight: json.canvas.height, exportedSceneKeys: Object.keys(json.canvas), errors }, null, 2)); process.exitCode = 0 }
  else {
    assert.ok(parseFloat(textMetrics.size) >= 14, 'Carousel body must have readable computed type size')
    assert.equal(json.canvas.width, canvas.canvas.width); assert.equal(json.canvas.height, canvas.canvas.height)
    assert.deepEqual(json.canvas.objects.slice(0, 2).map(({ originX, originY }) => [originX, originY]), [['left', 'top'], ['left', 'top']], 'legacy scenes retain left/top coordinates under Fabric 7')
    assert.deepEqual([json.canvas.objects[2].originX, json.canvas.objects[2].originY], ['center', 'center'], 'an explicitly saved origin remains authoritative')
    const canvasRegion = page.getByRole('region', { name: 'Native canvas canvas', exact: true })
    const mobileBounds = await canvasRegion.locator('canvas.lower-canvas').evaluate(el => ({ width: el.getBoundingClientRect().width, window: innerWidth }))
    assert.ok(mobileBounds.width <= mobileBounds.window - 30, 'mobile Fabric stage must fit without horizontal scrolling')
    await saveDownload(page.getByRole('button', { name: 'PNG', exact: true }), 'canvas.png')
    assert.deepEqual(await sharp(`${output}/canvas.png`).metadata().then(m => [m.width, m.height]), [1200, 503])
    await saveDownload(page.getByRole('button', { name: 'SVG', exact: true }), 'canvas.svg')
    const svg = await readFile(`${output}/canvas.svg`, 'utf8')
    assert.match(svg, /width="1200" height="503"/)
    const svgRaster = await sharp(Buffer.from(svg)).png().toBuffer()
    await writeFile(`${output}/canvas-vector-render.png`, svgRaster)
    assert.deepEqual(await sharp(svgRaster).metadata().then(m => [m.width, m.height]), [1200, 503])
    const pixel = async (left, top) => [...await sharp(`${output}/canvas.png`).extract({ left, top, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
    assert.deepEqual(await pixel(1150, 100), [23, 79, 206], 'right edge must remain at its original horizontal position')
    assert.deepEqual(await pixel(1150, 280), [23, 79, 206], 'lower edge must remain at its original vertical position')
    assert.deepEqual(await pixel(1050, 60), [255, 255, 255], 'the rectangle must not shift upward to a center-based origin')
    assert.deepEqual(await pixel(870, 385), [204, 51, 68], 'explicitly centered objects keep their saved position')
    const raster = await sharp(`${output}/canvas.png`).removeAlpha().raw().toBuffer()
    const textBounds = { minX: 1200, maxX: -1, minY: 503, maxY: -1 }
    for (let y = 0; y < 250; y++) for (let x = 0; x < 900; x++) {
      const offset = (y * 1200 + x) * 3
      if (raster[offset] < 80 && raster[offset + 1] < 80 && raster[offset + 2] < 100) { textBounds.minX = Math.min(textBounds.minX, x); textBounds.maxX = Math.max(textBounds.maxX, x); textBounds.minY = Math.min(textBounds.minY, y); textBounds.maxY = Math.max(textBounds.maxY, y) }
    }
    assert.ok(textBounds.minX >= 70 && textBounds.minX < 90 && textBounds.maxX > 500 && textBounds.maxX < 850 && textBounds.minY >= 85 && textBounds.maxY < 170, 'text must retain its full unclipped left/top bounds: ' + JSON.stringify(textBounds))
    await saveDownload(page.getByRole('button', { name: 'PDF', exact: true }), 'canvas.pdf')
    const pdfInfo = execFileSync('pdfinfo', [`${output}/canvas.pdf`], { encoding: 'utf8' })
    assert.match(pdfInfo, /Page size:\s+900 x 377\.25 pts/, 'PDF preserves CSS pixel dimensions at 96dpi')
    await page.getByRole('button', { name: 'Shape', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeEnabled()
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('qa-saved-canvas')))
    assert.equal(saved.canvas.objects.length, 4); assert.equal(saved.canvas.width, 1200); assert.equal(saved.canvas.height, 503)
    await page.reload(); await page.waitForFunction(() => !!window.showArtifact)
    await page.evaluate(() => window.showArtifact('canvas', JSON.parse(localStorage.getItem('qa-saved-canvas'))))
    await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeEnabled()
    await saveDownload(page.getByRole('button', { name: 'JSON', exact: true }), 'canvas-reloaded.json')
    assert.equal(JSON.parse(await readFile(`${output}/canvas-reloaded.json`, 'utf8')).canvas.objects.length, 4)
    await page.setViewportSize({ width: 1040, height: 960 })
    await expect.poll(async () => page.locator('canvas.lower-canvas').evaluate(el => el.getBoundingClientRect().width)).toBe(760)
    await page.screenshot({ path: `${output}/canvas-edited-preview.png`, fullPage: true })
    assert.deepEqual(errors, [])
    await writeFile(`${output}/report.json`, JSON.stringify({ passed: true, textMetrics, mobileBounds, errors, checks: ['readable carousel body and standalone HTML', '1080px responsive PNG with stable text layout', 'complete ZIP download', 'photo crop and overlay pixel match', 'missing-image error', 'overflow guard', 'responsive Fabric stage', 'exact PNG/SVG/PDF dimensions', 'right-side geometry retained', 'editable save and reload'] }, null, 2))
    console.log(`PASS real Canvas/Carousel typography, mobile layouts, native export dimensions, ZIP, overflow guard and editable save/reload. ${output}`)
  }
} finally { await browser?.close(); await server.close() }
