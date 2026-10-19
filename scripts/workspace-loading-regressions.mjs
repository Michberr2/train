// Render real opening, artifact, and dock components without launching a browser.
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: `
  import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  import LoadingScreen from './client/src/components/LoadingScreen';
  import MediaLoader from './client/src/components/workspace/MediaLoader';
  import WorkspaceAppDock from './client/src/components/workspace-preview/real/WorkspaceAppDock';
  export const opening = () => renderToStaticMarkup(React.createElement(LoadingScreen));
  export const media = action => renderToStaticMarkup(React.createElement(MediaLoader, {kind:'slides', action}));
  export const dock = () => renderToStaticMarkup(React.createElement(WorkspaceAppDock, {currentView:'studio', launcherOpen:false, onOpen(){}}));
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', loader: { '.css': 'empty' }, write: false,
  banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(`${process.cwd()}/package.json`)});` } })
const { opening, media, dock } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

// Execute the actual icon component's event handlers/effects with deterministic
// hooks and timers. Image downloads are not needed to verify recovery behavior.
const iconBundle = await build({ stdin: { contents: `export {AppIcon} from './client/src/components/workspace-preview/real/WorkspaceAppDock'`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', loader: { '.css': 'empty' }, write: false,
  banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(`${process.cwd()}/package.json`)});` },
  plugins: [{ name: 'icon-hooks', setup(build) {
    build.onResolve({ filter: /^react$/ }, args => args.importer.endsWith('/WorkspaceAppDock.tsx') ? { path: 'hooks', namespace: 'fixture' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const useState=(...args)=>globalThis.__iconHooks.useState(...args); export const useRef=(...args)=>globalThis.__iconHooks.useRef(...args); export const useEffect=(...args)=>globalThis.__iconHooks.useEffect(...args);` }))
  } }],
})
const { AppIcon } = await import(`data:text/javascript;base64,${Buffer.from(iconBundle.outputFiles[0].text).toString('base64')}`)

test('the branded opening screen and artifact activity never show the conversation globe', () => {
  const intro = opening()
  assert.match(intro, /nalu-opening-track/)
  assert.match(intro, /A little help\. A little more possibility\./)
  assert.doesNotMatch(intro, /class="nalu-globe/)
  for (const action of ['opening', 'creating']) {
    const html = media(action)
    assert.match(html, /role="status"/)
    assert.match(html, action === 'opening' ? /Opening your deck/ : /Creating your deck/)
    assert.match(html, /0s elapsed/)
    assert.doesNotMatch(html, /class="nalu-globe|%/)
  }
})

test('the dock loads only approved artwork without flashing legacy icons', async () => {
  const html = dock()
  assert.doesNotMatch(html, /<svg|workspace-app-dock-vector/)
  assert.equal((html.match(/data-icon-state="loading"/g) || []).length, 5)
  assert.equal((html.match(/data-loaded="false"/g) || []).length, 5)
  for (const [label, filename] of [
    ['Studio', 'studio-glossy-paintbrush.png'], ['Autopilot', 'autopilot-neon-molecule.png'],
    ['Map', 'map-glossy-blue-pin.png'], ['Memory', 'memory-glossy-brain.png'], ['Skills', 'skills-plug-socket.png'],
  ]) {
    assert.ok(html.includes(`aria-label="${label}"`), `${label} stays accessible before the image loads`)
    assert.ok(html.includes(`src="/workspace-icons/${filename}"`), label)
    await access(`client/public/workspace-icons/${filename}`)
  }
})

test('failed artwork retries once, then on reconnect, and cleans up when ready or unmounted', () => {
  const previousWindow = globalThis.window, previousHooks = globalThis.__iconHooks
  const timers = new Map(), online = new Set()
  let timerId = 0
  globalThis.window = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId },
    clearTimeout(id) { timers.delete(id) },
    addEventListener(type, callback) { assert.equal(type, 'online'); online.add(callback) },
    removeEventListener(type, callback) { assert.equal(type, 'online'); online.delete(callback) },
  }
  const mount = () => {
    const slots = [], effects = []
    let cursor = 0, pending = []
    const hooks = {
      useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
      useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial } },
      useEffect(callback, deps) { const index = cursor++, old = effects[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: callback() } }) },
    }
    return {
      render() { globalThis.__iconHooks = hooks; cursor = 0; pending = []; const tree = AppIcon({ view: 'map' }); for (const effect of pending) effect(); return { state: tree.props['data-icon-state'], image: tree.props.children.find(child => child?.type === 'img') } },
      unmount() { for (const effect of effects) effect?.cleanup?.() },
    }
  }
  const instance = mount()
  try {
    let icon = instance.render()
    const src = icon.image.props.src
    icon.image.props.onError(); icon = instance.render()
    assert.equal(icon.state, 'error'); assert.equal(timers.size, 1); assert.equal(online.size, 1)
    const retry = [...timers.values()][0]; retry(); retry()
    icon = instance.render()
    assert.equal(icon.state, 'loading'); assert.equal(icon.image.key, '1'); assert.equal(icon.image.props.src, src)
    assert.equal(timers.size, 0); assert.equal(online.size, 0)
    icon.image.props.onError(); icon = instance.render()
    assert.equal(icon.state, 'error'); assert.equal(timers.size, 0); assert.equal(online.size, 1)
    instance.render(); assert.equal(timers.size, 0, 'ordinary rerenders never loop failed downloads')
    for (const reconnect of [...online]) reconnect()
    icon = instance.render()
    assert.equal(icon.state, 'loading'); assert.equal(icon.image.key, '2'); assert.equal(icon.image.props.src, src)
    icon.image.props.onLoad(); icon = instance.render()
    assert.equal(icon.state, 'ready'); assert.equal(icon.image.props['data-loaded'], true)
    assert.equal(timers.size, 0); assert.equal(online.size, 0)
    instance.unmount()
    const early = mount(); early.render().image.props.onError(); early.render(); early.unmount()
    assert.equal(timers.size, 0); assert.equal(online.size, 0, 'unmount removes the reconnect listener')
  } finally {
    instance.unmount()
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow
    if (previousHooks === undefined) delete globalThis.__iconHooks; else globalThis.__iconHooks = previousHooks
  }
})
