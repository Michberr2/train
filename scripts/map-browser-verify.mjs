// Deterministic Map UI regression checks. Local component + fake Google SDK only;
// provider availability/geographic accuracy require separate live verification.
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import tailwindConfig from '../client/tailwind.config.js'
import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const cameraCheck = process.argv.includes('--camera')
const layerCheck = process.argv.includes('--layers')
// The real MapGlobe3D component runs against a controlled SDK in --camera mode.
// Calls are recorded at the SDK boundary; this fixture never requests tiles.
const mapLibreFixture = `
const state = window.__globeTest = { maps: [], cameras: [] };
class Map {
  listeners = {}; bearing = -20;
  constructor(options) { this.center = options.center; this.zoom = options.zoom; state.maps.push(this); this.canvas = document.createElement('canvas'); options.container.append(this.canvas); if (!state.delayLoad) setTimeout(() => this.emit('load'), 0); }
  on(type, callback) { (this.listeners[type] ||= []).push(callback); return this; }
  emit(type) { (this.listeners[type] || []).forEach((callback) => callback({})); }
  addControl() {} addSource() {} setTerrain() {} setSky() {} setProjection() {} addLayer() {} setLayoutProperty() {} resize() {}
  getStyle() { return { layers: [] }; }
  getBearing() { return this.bearing; }
  setBearing(bearing) { this.bearing = bearing; }
  flyTo(options) { this.center = options.center; this.zoom = options.zoom; state.cameras.push({ kind: 'point', ...options }); }
  fitBounds(bounds, options) { state.cameras.push({ kind: 'bounds', bounds, ...options }); }
  remove() { this.canvas.remove(); }
}
export { Map };export class NavigationControl {}export class ScaleControl {}export class GeolocateControl {}export function setWorkerUrl(){}`
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client';
import MapPanel from '/src/components/workspace/MapPanel.tsx'; import '/src/globals.css';
function App() { const [shown, show] = React.useState(true); return React.createElement(React.Fragment, null,
  React.createElement('button', { onClick: () => show(!shown) }, shown ? 'Unmount map' : 'Mount map'),
  React.createElement('div', { style: { display: 'flex', height: '90vh' } }, shown ? React.createElement(MapPanel) : null)); }
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(App)));`
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../client', import.meta.url)),
  define: { 'import.meta.env.VITE_GOOGLE_MAPS_KEY': JSON.stringify('map-regression-test') },
  css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [fileURLToPath(new URL('../client/src/**/*.{ts,tsx}', import.meta.url))] })] } },
  plugins: [{
    name: 'map-camera-sdk-fixture', enforce: 'pre',
    resolveId(id) { if (cameraCheck && id === 'maplibre-gl') return '\0maplibre-fixture' },
    load(id) { if (id === '\0maplibre-fixture') return mapLibreFixture },
  }, react(), {
    name: 'map-test-fixture',
    resolveId(id) { if (id === '/@map-fixture') return '\0map-fixture' },
    load(id) { if (id === '\0map-fixture') return fixture },
    configureServer(vite) {
      vite.middlewares.use('/__map-test', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/__map-test', '<!doctype html><html><head><title>Map regression fixture</title></head><body><div id="root"></div><script type="module" src="/@map-fixture"></script></body></html>'))
      })
    },
  }],
  server: { host: '127.0.0.1', port: 5183, strictPort: true },
})
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const expectMapMode = async (mode) => {
    const viewport = page.locator('.map-2d-viewport')
    const in3D = mode === '3d'
    await expect(page.locator('.map-surface')).toHaveAttribute('data-map-mode', mode)
    await expect(viewport).toHaveCSS('opacity', in3D ? '0' : '1')
    await expect(viewport).toHaveAttribute('aria-hidden', String(in3D))
    assert.equal(await viewport.evaluate(element => element.inert), in3D)
    assert.ok((await viewport.boundingBox()).width > 0, 'hidden 2D camera retains dimensions')
    if (in3D) {
      await expect(viewport).toBeHidden()
      await expect(page.getByRole('button', { name: /^Layers/ })).toHaveCount(0)
      await expect(page.getByRole('combobox', { name: 'Map background' })).toHaveCount(0)
    } else {
      await expect(viewport).toBeVisible()
      await expect(page.getByRole('region', { name: '3D map', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^Layers/ })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Show search panel', exact: true })).toBeVisible()
  }
  await page.addInitScript(() => {
    localStorage.setItem('nalu-map-active-layers', '["osm"]')
    localStorage.setItem('nalu-map-shapes', '{"malformed":true}')
    const state = window.__mapTest = { maps: [], markers: [], data: [], infos: [], opened: [], removed: 0 }
    const point = (value) => ({ lat: () => value.lat, lng: () => value.lng })
    class Evented {
      listeners = []
      addListener(type, callback) { const listener = { type, callback, removed: false }; this.listeners.push(listener); return listener }
      setMap(map) { this.map = map }
    }
    class Collection {
      values = []
      getArray() { return this.values }
      push(value) { this.values.push(value) }
      insertAt(index, value) { this.values.splice(index, 0, value) }
      removeAt(index) { this.values.splice(index, 1) }
      clear() { this.values = [] }
    }
    class Bounds {
      points = []
      constructor(center = { lat: 28.5, lng: -81.5 }) { this.center = center }
      extend(value) { this.points.push(value); return this }
      union() { return this }
      getSouthWest() { return point(this.points.length ? { lat: Math.min(...this.points.map((p) => p.lat)), lng: Math.min(...this.points.map((p) => p.lng)) } : { lat: 28.2, lng: -81.8 }) }
      getNorthEast() { return point(this.points.length ? { lat: Math.max(...this.points.map((p) => p.lat)), lng: Math.max(...this.points.map((p) => p.lng)) } : { lat: 28.8, lng: -81.2 }) }
      getCenter() { return point(this.center) }
    }
    class Map extends Evented {
      overlayMapTypes = new Collection()
      constructor(element, options) { super(); this.center = options.center; this.zoom = options.zoom; state.maps.push(this); element.dataset.mockMap = 'ready' }
      getCenter() { return point(this.center) }
      getZoom() { return this.zoom }
      getBounds() { return new Bounds(this.center) }
      panTo(center) { this.center = center }
      setZoom(zoom) { this.zoom = zoom }
      setOptions() {}
      setMapTypeId() {}
      fitBounds() {}
    }
    class Marker extends Evented {
      constructor(options) { super(); Object.assign(this, options); state.markers.push(this) }
      getPosition() { return point(this.position) }
      setAnimation() {}
      setOpacity(opacity) { this.opacity = opacity }
      setVisible(visible) { this.visible = visible }
    }
    class InfoWindow {
      setContent(content) { state.infos.push(content) }
      setPosition() {}
      open(options) { state.opened.push({ anchor: options?.anchor?.position || null }) }
      close() {}
    }
    class Data extends Evented {
      features = []
      constructor(options) { super(); Object.assign(this, options); state.data.push(this) }
      setStyle(style) { this.style = style }
      forEach(callback) { [...this.features].forEach(callback) }
      remove(feature) { this.features = this.features.filter((item) => item !== feature) }
      addGeoJson(json) { return json.features || [] }
    }
    window.google = { maps: {
      Map, Marker, Data, InfoWindow, LatLngBounds: Bounds,
      ImageMapType: class { constructor(options) { Object.assign(this, options) } setOpacity(opacity) { this.opacity = opacity } },
      Size: class {}, SymbolPath: { CIRCLE: 'circle' },
      event: { clearInstanceListeners(item) { if (item) item.listeners?.forEach((listener) => { listener.removed = true; state.removed++ }) }, removeListener(listener) { listener.removed = true; state.removed++ } },
    } }
  })
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort()
    return route.continue()
  })
  const pending = []
  const fallbackCalls = []
  const place = (name) => ({ name, address: 'Orlando', lat: 28.5, lng: -81.4, placeId: name, types: ['cafe'], rating: 4.5, userRatings: 10, priceLevel: null })
  await page.route('**/api/web', async (route) => {
    const payload = route.request().postDataJSON()
    if (payload.query === 'fallback cafes') {
      fallbackCalls.push(payload)
      if (payload.action === 'mapai') return route.fulfill({ status: 200, json: { error: 'Map AI is temporarily unavailable.' } })
      pending.push({ route, payload })
      return
    }
    if (payload.query === 'first search' || payload.query === 'cancel me') {
      pending.push({ route, payload })
      return
    }
    if (payload.query === 'restaurants') return route.fulfill({ status: 503, json: { error: 'Places temporarily unavailable' } })
    if (payload.action === 'mapai') return route.fulfill({ json: { answer: `Answer for ${payload.query}`, center: { lat: 28.5, lng: -81.4 }, zoom: 12, search: payload.query } })
    if (payload.query === 'idless cafes') return route.fulfill({ json: { results: [
      { ...place('Cafe North'), placeId: '', address: '', lat: 28.5, lng: -81.4 },
      { ...place('Cafe South'), placeId: '', address: '', lat: 28.6, lng: -81.3 },
      { ...place('Cafe North'), placeId: '', address: '', lat: 28.5, lng: -81.4 },
    ] } })
    return route.fulfill({ json: { results: [place(payload.query)] } })
  })
  await page.goto('http://127.0.0.1:5183/__map-test')
  await page.getByRole('button', { name: /^Layers/ }).waitFor()
  if (layerCheck) {
    const viewport = () => page.evaluate(() => { const m = window.__mapTest.maps.at(-1); return { center: m.center, zoom: m.zoom } })
    const startView = await viewport()
    await page.getByRole('button', { name: /^Layers/ }).click()
    await page.getByRole('tab', { name: 'Browse layers', exact: true }).click()
    const filter = page.getByRole('textbox', { name: 'Search layers', exact: true })
    await filter.fill('flood')
    await page.getByRole('button', { name: /^FEMA flood zones National/ }).click()
    assert.deepEqual(await viewport(), startView, 'toggling a regional layer must preserve the current location and zoom')
    await filter.fill('radar')
    await page.getByRole('button', { name: /^Live weather radar NOAA/ }).click()
    await page.getByRole('tab', { name: /^On the map/ }).click()
    const opacity = page.getByRole('slider', { name: 'FEMA flood zones opacity' })
    await opacity.fill('25')
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.find(o => o.name === 'FEMA flood zones').opacity), 0.25)
    await page.getByRole('button', { name: 'View only FEMA flood zones', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.find(o => o.name === 'Live weather radar').opacity), 0)
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.find(o => o.name === 'OpenStreetMap').opacity), 1)
    await page.getByRole('button', { name: 'Exit solo view', exact: true }).click()
    await page.getByRole('button', { name: 'Hide overlays', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.find(o => o.name === 'FEMA flood zones').opacity), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-map-active-layers')).length), 3)
    await page.getByRole('button', { name: 'Show overlays', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.find(o => o.name === 'FEMA flood zones').opacity), 0.25)
    console.log('PASS layer toggles preserve the camera; opacity, solo, and hide/show keep selections and backgrounds intact')

    await page.getByRole('tab', { name: 'Browse layers', exact: true }).click()
    await filter.fill('Carto light')
    await page.getByRole('button', { name: /^Carto light Minimal/ }).click()
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.some(o => o.name === 'OpenStreetMap')), false)
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.length), 3)
    await page.getByRole('combobox', { name: 'Map background', exact: true }).selectOption('satellite')
    assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.length), 2)
    await page.evaluate(() => { const m = window.__mapTest.maps.at(-1); m.center = { lat: 35.1, lng: -80.9 }; m.zoom = 12.5; m.listeners.filter(l => l.type === 'idle' && !l.removed).forEach(l => l.callback()) })
    await page.getByRole('button', { name: 'Unmount map', exact: true }).click()
    await page.getByRole('button', { name: 'Mount map', exact: true }).click()
    await page.getByRole('button', { name: /^Layers/ }).waitFor()
    assert.deepEqual(await viewport(), { center: { lat: 35.1, lng: -80.9 }, zoom: 12.5 })
    await page.getByRole('button', { name: /^Layers/ }).click()
    assert.equal(await page.getByRole('slider', { name: 'FEMA flood zones opacity' }).inputValue(), '25')
    assert.equal(await page.getByRole('combobox', { name: 'Map background' }).inputValue(), 'satellite')
    console.log('PASS backgrounds replace one another, preserve data overlays, and restore viewport/opacity/background after leaving Map')

    await page.getByRole('tab', { name: 'Browse layers', exact: true }).click()
    await filter.fill('Power lines (clickable)')
    await page.getByRole('button', { name: /^Power lines \(clickable\) High-voltage/ }).click()
    await page.getByRole('tab', { name: /^On the map/ }).click()
    await page.getByRole('slider', { name: 'Power lines (clickable) opacity', exact: true }).fill('50')
    const lineStyle = () => page.evaluate(() => window.__mapTest.data.at(-1).style({ getGeometry: () => ({ getType: () => 'LineString' }) }))
    assert.equal((await lineStyle()).strokeOpacity, 0.5)
    await page.getByRole('button', { name: 'View only FEMA flood zones', exact: true }).click()
    assert.equal((await lineStyle()).visible, false)
    assert.equal((await lineStyle()).clickable, false)
    await page.getByRole('button', { name: 'Exit solo view', exact: true }).click()
    assert.equal((await lineStyle()).visible, true)
    assert.equal((await lineStyle()).strokeOpacity, 0.5)
    console.log('PASS vector layer opacity and solo visibility also disable hidden feature hit targets')

    await page.getByRole('button', { name: 'Close layers', exact: true }).click()
    await page.getByRole('button', { name: 'Expand map', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Exit full map', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Expand map', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.map-workspace')).toHaveClass(/map-compact/)
    const compactMap = await page.locator('.map-surface').boundingBox()
    assert.ok(compactMap.width >= 389, 'rotating keeps the map full width while preserving an open search')
    await page.getByRole('button', { name: /^Layers/ }).click()
    await expect(page.getByRole('textbox', { name: 'Map search', exact: true })).toBeHidden()
    const bounds = await page.getByRole('region', { name: 'Map layers' }).boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.height < 520)
    await page.screenshot({ path: '/private/tmp/nalu-map-ux-fixture-mobile.png' })
    await page.getByRole('button', { name: 'Show search panel', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Map layers' })).toBeHidden()
    await expect(page.getByRole('textbox', { name: 'Map search', exact: true })).toBeVisible()
    assert.deepEqual(errors, [])
    console.log('PASS expanded-map keyboard exit and mobile panels keep the map visible without overlapping each other')
  } else if (cameraCheck) {
    const input = page.getByRole('textbox', { name: 'Map search', exact: true })
    await expectMapMode('2d')
    const mapCount = await page.evaluate(() => window.__mapTest.maps.length)
    const savedLayers = await page.evaluate(() => localStorage.getItem('nalu-map-active-layers'))
    await page.getByRole('button', { name: '3D', exact: true }).click()
    await expectMapMode('3d')
    await expect(page.getByRole('button', { name: 'Auto-orbit', exact: true })).toBeEnabled()
    await page.evaluate(() => window.__globeTest.maps.at(-1).setBearing(123))
    await input.fill('draft without navigation')
    assert.equal(await page.evaluate(() => window.__globeTest.cameras.length), 0)
    assert.equal(await page.evaluate(() => window.__globeTest.maps.at(-1).bearing), 123)
    console.log('PASS unrelated parent renders preserve the visible3D camera and orbit')

    await page.getByRole('button', { name: 'Coffee', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__globeTest.cameras.at(-1)?.kind)).toBe('bounds')
    assert.deepEqual(await page.evaluate(() => window.__globeTest.cameras.at(-1).bounds), [[-81.4, 28.5], [-81.4, 28.5]])
    console.log('PASS Places searches fit actual result bounds in the visible3D camera')

    await input.fill('idless cafes')
    await input.press('Enter')
    await page.getByRole('button', { name: 'Show Cafe South on map', exact: true }).waitFor()
    await expect.poll(() => page.evaluate(() => window.__globeTest.cameras.at(-1)?.kind)).toBe('point')
    assert.deepEqual(await page.evaluate(() => window.__globeTest.cameras.at(-1).center), [-81.4, 28.5])
    assert.equal(await page.evaluate(() => window.__globeTest.cameras.at(-1).zoom), 12)
    console.log('PASS AI search viewport updates reach the visible3D camera')

    const south = page.getByRole('button', { name: 'Show Cafe South on map', exact: true })
    await south.click()
    await expect.poll(() => page.evaluate(() => window.__globeTest.cameras.at(-1)?.zoom)).toBe(16)
    assert.deepEqual(await page.evaluate(() => window.__globeTest.cameras.at(-1).center), [-81.3, 28.6])
    assert.equal(await south.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByRole('button', { name: 'Show Cafe North on map', exact: true }).getAttribute('aria-pressed'), 'false')
    assert.equal(await page.evaluate(() => window.__globeTest.maps.at(-1).bearing), 123)
    console.log('PASS selecting a result moves the visible3D camera to its pin and preserves selection/bearing')

    const camerasBefore = await page.evaluate(() => window.__globeTest.cameras.length)
    await page.evaluate(() => { const map = window.__globeTest.maps.at(-1); map.center = [-100, 40]; map.bearing = 75 })
    await south.click()
    await expect.poll(() => page.evaluate(() => window.__globeTest.cameras.length)).toBe(camerasBefore + 1)
    assert.deepEqual(await page.evaluate(() => window.__globeTest.maps.at(-1).center), [-81.3, 28.6])
    await input.fill('another unsent draft')
    await page.evaluate(() => window.__mapTest.maps.at(-1).listeners.filter((listener) => ['center_changed', 'zoom_changed', 'idle'].includes(listener.type) && !listener.removed).forEach((listener) => listener.callback()))
    await new Promise((resolve) => setTimeout(resolve, 650))
    assert.equal(await page.evaluate(() => window.__globeTest.cameras.length), camerasBefore + 1)
    assert.equal(await page.evaluate(() => window.__globeTest.maps.at(-1).bearing), 75)
    assert.equal(await south.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(errors, [])
    console.log('PASS reselecting the same place recenters once; unrelated renders and underlying2D events do not loop')

    await page.getByRole('button', { name: 'Exit 3D', exact: true }).click()
    await expectMapMode('2d')
    await page.evaluate(() => { window.__globeTest.delayLoad = true })
    await page.getByRole('button', { name: '3D', exact: true }).click()
    await page.getByRole('region', { name: '3D map', exact: true }).getByRole('status').waitFor()
    await expectMapMode('3d')
    const beforeLoad = await page.evaluate(() => window.__globeTest.cameras.length)
    await page.getByRole('button', { name: 'Show Cafe North on map', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__globeTest.cameras.length), beforeLoad)
    await page.evaluate(() => window.__globeTest.maps.at(-1).emit('load'))
    await expect.poll(() => page.evaluate(() => window.__globeTest.cameras.length)).toBe(beforeLoad + 1)
    assert.deepEqual(await page.evaluate(() => window.__globeTest.cameras.at(-1).center), [-81.4, 28.5])
    assert.equal(await page.getByRole('button', { name: 'Show Cafe North on map', exact: true }).getAttribute('aria-pressed'), 'true')
    console.log('PASS selections made while3D loads apply to the visible camera once ready')
    await page.evaluate(() => window.__globeTest.maps.at(-1).emit('webglcontextlost'))
    await expect(page.getByRole('button', { name: 'Retry 3D', exact: true })).toBeVisible()
    await expectMapMode('3d')
    await page.getByRole('button', { name: 'Return to map', exact: true }).click()
    await expectMapMode('2d')
    await page.setViewportSize({ width: 320, height: 740 })
    await page.evaluate(() => { window.__globeTest.delayLoad = false })
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: '3D', exact: true }).click()
      await expectMapMode('3d')
      await expect(page.getByRole('button', { name: 'Auto-orbit', exact: true })).toBeEnabled()
      const exit = page.getByRole('button', { name: 'Exit 3D', exact: true })
      const box = await exit.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 320, 'mobile 3D exit stays on screen')
      if (i === 0) await page.screenshot({ path: '/private/tmp/nalu-map-exclusive-3d-mobile.png' })
      await exit.click()
      await expectMapMode('2d')
    }
    assert.equal(await page.evaluate(() => window.__mapTest.maps.length), mapCount, 'mode switches preserve the original 2D instance')
    assert.equal(await page.evaluate(() => localStorage.getItem('nalu-map-active-layers')), savedLayers)
    assert.deepEqual(errors, [])
    console.log('PASS only one map is visible during 3D loading, ready and error states; repeated mobile switches preserve 2D layers and controls')
  } else {
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-map-active-layers'))), ['osm'])
  assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.length), 1)
  console.log('PASS saved layers survive mount and React StrictMode; malformed saved drawings do not crash')

  const input = page.getByRole('textbox', { name: 'Map search', exact: true })
  await input.fill('first search')
  await input.press('Enter')
  await page.getByRole('status').filter({ hasText: 'Searching the map' }).waitFor()
  await expect.poll(() => pending.some((entry) => entry.payload.query === 'first search')).toBe(true)
  await input.fill('second search')
  await input.press('Enter')
  await page.getByRole('button', { name: 'Show second search on map', exact: true }).waitFor()
  for (const request of pending.splice(0)) await request.route.fulfill({ json: { answer: 'STALE ANSWER', search: 'stale place', center: { lat: 0, lng: 0 } } }).catch(() => {})
  assert.equal(await page.getByText('STALE ANSWER', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Show second search on map', exact: true }).count(), 1)
  console.log('PASS a newer query supersedes the first request and late results cannot replace it')

  await input.fill('cancel me')
  await input.press('Enter')
  await expect.poll(() => pending.some((entry) => entry.payload.query === 'cancel me')).toBe(true)
  await page.getByRole('button', { name: 'Cancel map search', exact: true }).click()
  for (const request of pending.splice(0)) await request.route.fulfill({ json: { answer: 'CANCELLED ANSWER' } }).catch(() => {})
  assert.equal(await input.inputValue(), '')
  assert.equal(await page.getByText('CANCELLED ANSWER', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.__mapTest.markers.filter((marker) => marker.map).length), 0)
  console.log('PASS cancel stays available while loading and clears result markers')

  await page.getByRole('button', { name: 'Restaurants', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Places temporarily unavailable' }).waitFor()
  assert.equal(await page.getByText('No results — try "waterfront homes in Miami".', { exact: true }).count(), 0)
  console.log('PASS provider errors are visible rather than reported as empty results')

  await input.fill('fallback cafes')
  await input.press('Enter')
  await expect.poll(() => pending.some((entry) => entry.payload.query === 'fallback cafes' && entry.payload.action === 'places')).toBe(true)
  assert.deepEqual(fallbackCalls.map((call) => call.action), ['mapai', 'places'], 'an HTTP200 AI error must use the real Places fallback exactly once')
  assert.equal(fallbackCalls[1].query, 'fallback cafes', 'fallback must preserve the original search')
  assert.equal(Number.isFinite(fallbackCalls[1].lat) && Number.isFinite(fallbackCalls[1].lng), true, 'fallback must retain viewport bias')
  await expect(page.getByRole('status').filter({ hasText: 'Searching the map' })).toBeVisible()
  const fallbackRequest = pending.splice(pending.findIndex((entry) => entry.payload.query === 'fallback cafes'), 1)[0]
  await fallbackRequest.route.fulfill({ json: { results: [place('Fallback Cafe North'), { ...place('Fallback Cafe South'), lat: 28.6, lng: -81.3 }] } })
  await expect(page.getByRole('button', { name: 'Show Fallback Cafe South on map', exact: true })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Searching the map' })).toHaveCount(0)
  assert.equal(await page.getByText('Map AI is temporarily unavailable.', { exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.__mapTest.markers.filter((marker) => marker.map).length), 2)
  await page.getByRole('button', { name: 'Show Fallback Cafe South on map', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.__mapTest.opened.at(-1).anchor), { lat: 28.6, lng: -81.3 })
  assert.equal(await page.getByRole('button', { name: 'Show Fallback Cafe South on map', exact: true }).getAttribute('aria-pressed'), 'true')
  console.log('PASS HTTP200 Map AI errors fall back once to Places, preserve loading until results, render usable pins, and clear loading')

  await input.fill('idless cafes')
  await input.press('Enter')
  await page.getByRole('button', { name: 'Show Cafe South on map', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.__mapTest.opened.at(-1).anchor), { lat: 28.6, lng: -81.3 }, 'ID-less place popups must attach to the chosen place, not the first marker')
  assert.equal(await page.getByRole('button', { name: 'Show Cafe South on map', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByRole('button', { name: 'Show Cafe North on map', exact: true }).getAttribute('aria-pressed'), 'false')
  assert.equal(await page.getByRole('button', { name: /^Show Cafe .+ on map$/ }).count(), 2, 'duplicate records must not create duplicate rows or pins')
  const preciseLink = new URL(await page.getByRole('link', { name: 'Open Cafe South in Google Maps', exact: true }).getAttribute('href'))
  assert.equal(preciseLink.searchParams.get('query'), '28.6,-81.3')
  assert.equal(preciseLink.searchParams.has('query_place_id'), false)
  console.log('PASS ID-less places select one row, anchor the correct popup, remove exact duplicates, and link to exact coordinates')

  await input.fill('<img src=x onerror="alert(1)">')
  await input.press('Enter')
  await page.getByRole('button', { name: 'Show <img src=x onerror="alert(1)"> on map', exact: true }).click()
  assert.match(await page.evaluate(() => window.__mapTest.infos.at(-1)), /&lt;img/)
  assert.equal(await page.locator('button a').count(), 0)
  const savedBeforeUnmount = await page.evaluate(() => JSON.parse(localStorage.getItem('nalu-map-active-layers')))
  await page.getByRole('button', { name: 'Unmount map', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__mapTest.markers.filter((marker) => marker.map).length), 0)
  assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.length), 0)
  await page.getByRole('button', { name: 'Mount map', exact: true }).click()
  await page.getByRole('button', { name: /^Layers/ }).waitFor()
  assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).overlayMapTypes.values.length), savedBeforeUnmount.length)
  await new Promise((resolve) => setTimeout(resolve, 650))
  assert.equal(await page.evaluate(() => window.__mapTest.maps.at(-1).zoom), 6, 'old camera animations must not move the new map')
  assert.deepEqual(errors, [])
  console.log('PASS popups escape provider content; leaving Map removes overlays/markers and returning restores layers')

  const permitRequests = []
  await page.route('https://data.cityofnewyork.us/**', (route) => { permitRequests.push(route) })
  await page.evaluate(() => { const map = window.__mapTest.maps.at(-1); map.center = { lat: 40.713, lng: -74.006 }; map.zoom = 15 })
  await page.getByRole('button', { name: /^Layers/ }).click()
  await page.getByRole('tab', { name: 'Browse layers', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search layers', exact: true }).fill('Building permits')
  const permits = page.getByRole('button', { name: /^Building permits Construction/ })
  await permits.click()
  await expect.poll(() => permitRequests.length).toBe(1)
  await page.evaluate(() => { const map = window.__mapTest.maps.at(-1); for (let i = 0; i < 3; i++) map.listeners.filter((listener) => listener.type === 'idle' && !listener.removed).forEach((listener) => listener.callback()) })
  await expect.poll(() => permitRequests.length).toBe(2)
  await page.evaluate(() => window.__mapTest.maps.at(-1).listeners.filter((listener) => listener.type === 'idle' && !listener.removed).forEach((listener) => listener.callback()))
  await permits.click()
  for (const route of permitRequests) await route.fulfill({ json: [{ latitude: '40.713', longitude: '-74.006', permit_type: 'Building permit' }] }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(permitRequests.length, 2, 'disabling a layer cancels its queued viewport load')
  assert.equal(await page.evaluate(() => window.__mapTest.markers.filter((marker) => marker.map).length), 0)
  assert.equal(await permits.getAttribute('aria-pressed'), 'false')
  await page.getByRole('button', { name: /^Layers/ }).click()
  console.log('PASS viewport events coalesce into one request; disabling permits prevents late markers and queued loads')

  await page.getByRole('button', { name: '3D', exact: true }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Retry 3D', exact: true }).isVisible(), true)
  await page.getByRole('button', { name: 'Exit 3D', exact: true }).click()
  assert.equal(await page.getByRole('region', { name: '3D map' }).count(), 0)
  console.log('PASS unavailable 3D providers show retry and exit controls instead of an endless loader')

  await page.setViewportSize({ width: 390, height: 844 })
  if (!(await page.getByRole('textbox', { name: 'Map search', exact: true }).isVisible())) await page.getByRole('button', { name: 'Show search panel', exact: true }).click()
  await page.screenshot({ path: '/tmp/nalu-map-regression-mobile.png' })
  assert.equal(await page.getByRole('textbox', { name: 'Map search', exact: true }).isVisible(), true)
  console.log('PASS mobile search controls remain visible (mock map screenshot: /tmp/nalu-map-regression-mobile.png)')
  }
} finally {
  await browser?.close()
  await server.close()
}
