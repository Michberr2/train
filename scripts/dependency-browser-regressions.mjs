// Real upgraded MapLibre SDK and KaTeX through the production React components.
// Tiles/style responses are local fixtures; no real accounts or provider calls.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { transform as transformCode } from 'esbuild'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'
import sharp from 'sharp'

const root = fileURLToPath(new URL('../client', import.meta.url))
const output = process.env.OUTPUT_DIR || '/tmp/nalu-dependency-browser'
await mkdir(output, { recursive: true })
const math = String.raw`Inline \(x^2 + y^2 = z^2\), then a display formula:

\[
\frac{1}{2} + \sqrt{4} = 2.5
\]

An untrusted formula must not create a link: \(\href{javascript:alert(1)}{unsafe}\).

Prices are $180 and $65.`
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import MapGlobe from'/src/components/workspace/MapGlobe3D.tsx';import Markdown from'/src/components/workspace/Markdown.tsx';import'/src/globals.css';
function App(){const[camera,setCamera]=React.useState();const[shown,setShown]=React.useState(true);window.setFixtureCamera=setCamera;return <><section aria-label="Math fixture"><Markdown>{${JSON.stringify(math)}}</Markdown></section><div style={{height:480,position:'relative'}}>{shown&&<MapGlobe center={{lat:28.5,lng:-81.4}} zoom={8} cameraRequest={camera} onClose={()=>setShown(false)}/>}</div></>};createRoot(document.getElementById('root')).render(<App/>);`
const server = await createServer({ configFile: false, root, cacheDir: `${output}/vite-cache`, css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [root + '/src/**/*.{ts,tsx}'] })] } }, plugins: [react(), {
  name: 'dependency-browser-fixture', resolveId(id) { if (id === '/@dependency-fixture.jsx') return '\0dependency-fixture.jsx'; if (id === '/@map-sdk-capture') return '\0map-sdk-capture' },
  load(id) { if (id === '\0dependency-fixture.jsx') return fixture; if (id === '\0map-sdk-capture') return `import * as sdk from'maplibre-gl';export default {...sdk,Map:class extends sdk.Map{constructor(options){super(options);window.fixtureMap=this}}}` },
  transform(source, id) { if (id === '\0dependency-fixture.jsx') return transformCode(source, { loader: 'jsx', jsx: 'automatic' }); if (id.endsWith('/MapGlobe3D.tsx')) return source.replace(/import \* as maplibregl from ["']maplibre-gl["'];?/, "import maplibregl from '/@map-sdk-capture';") },
  configureServer(vite) { vite.middlewares.use('/__dependency-fixture', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/__dependency-fixture', '<!doctype html><html><body><div id="root"></div><script type="module" src="/@dependency-fixture.jsx"></script></body></html>')) }) },
}], server: { host: '127.0.0.1', port: 0, hmr: false } })
let browser
const errors = [], checks = [], external = []
const record = name => { checks.push(name); console.log('PASS ' + name) }
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message) })
  const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 128, g: 0, b: 0 } } }).png().toBuffer()
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
    external.push(url.hostname)
    if (url.hostname === 'tiles.openfreemap.org') return route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'fixture-background', type: 'background', paint: { 'background-color': '#334f73' } }] } })
    if (['s3.amazonaws.com', 'server.arcgisonline.com'].includes(url.hostname)) return route.fulfill({ contentType: 'image/png', body: tile })
    return route.abort()
  })
  await page.goto(origin + '/__dependency-fixture')
  const formulas = page.getByRole('region', { name: 'Math fixture' })
  await expect(formulas.locator('.katex')).toHaveCount(3)
  await expect(formulas.locator('.katex-display')).toHaveCount(1)
  assert.match(await formulas.innerText(), /Prices are \$180 and \$65/)
  assert.equal(await formulas.locator('a').count(), 0)
  assert.equal(await formulas.locator('script').count(), 0)
  record('Actual Markdown renders inline/display KaTeX, preserves currency and blocks an untrusted formula link')
  await expect(page.getByRole('button', { name: 'Auto-orbit', exact: true })).toBeEnabled({ timeout: 25000 })
  const initial = await page.evaluate(() => ({ version: window.fixtureMap.version, projection: window.fixtureMap.getProjection(), terrain: window.fixtureMap.getTerrain(), canvas: window.fixtureMap.getCanvas().width }))
  assert.ok(initial.canvas > 0)
  assert.equal(initial.projection.type, 'globe')
  assert.equal(initial.terrain.source, 'nalu-terrain')
  record('Actual MapLibre initializes the production globe, canvas and terrain with local fixture tiles')
  await page.getByRole('button', { name: 'Satellite', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.fixtureMap.getLayoutProperty('nalu-sat', 'visibility'))).toBe('visible')
  await page.getByRole('slider', { name: 'Terrain exaggeration' }).fill('2.1')
  await expect.poll(() => page.evaluate(() => window.fixtureMap.getTerrain().exaggeration)).toBe(2.1)
  await page.evaluate(() => window.setFixtureCamera({ kind: 'point', lat: 30, lng: -80, zoom: 10 }))
  await expect.poll(() => page.evaluate(() => Math.round(window.fixtureMap.getCenter().lat * 100))).toBe(3000)
  await expect.poll(() => page.evaluate(() => Math.round(window.fixtureMap.getZoom()))).toBe(10)
  record('Satellite, terrain slider and an explicit camera request update the real SDK')
  await page.screenshot({ path: `${output}/map-and-math.png` })
  await page.getByRole('button', { name: 'Exit 3D', exact: true }).click()
  await expect(page.getByRole('region', { name: '3D map', exact: true })).toHaveCount(0)
  assert.deepEqual(errors, [])
  record('Production globe unmounts cleanly without browser exceptions')
  await writeFile(`${output}/report.json`, JSON.stringify({ passed: true, checks, errors, mockedHosts: [...new Set(external)] }, null, 2))
} finally { await browser?.close(); await server.close() }
