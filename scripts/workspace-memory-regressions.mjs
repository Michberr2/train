import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { build } from 'esbuild'

const stored = new Map()
globalThis.localStorage = { getItem: key => stored.get(key) ?? null }
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
  import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  import MemoryPanel from './client/src/components/workspace/MemoryPanel';
  import WorkspaceLiveHub from './client/src/components/workspace-preview/real/WorkspaceLiveHub';
  export {buildMemoryGraph,memoryGraphPreview,memoryGraphPalette} from './client/src/components/workspace/MemoryPanel';
  export {chatActivity} from './client/src/components/workspace/design/workspaceActivity';
  export const renderMemory = chats => renderToStaticMarkup(React.createElement(MemoryPanel, {chats,designEnabled:true}));
  export const renderHub = (chats,items) => renderToStaticMarkup(React.createElement(WorkspaceLiveHub, {chats,activity:{items,isSample:false,error:'',refresh(){}},onOpenChat(){},onNewChat(){},savedMemory:null}));
` }, bundle: true, platform: 'node', format: 'esm', loader: { '.css': 'empty', '.png': 'dataurl' }, define: { 'import.meta.env.DEV': 'false' }, write: false,
  banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(`${process.cwd()}/package.json`)});` } })
const { buildMemoryGraph, memoryGraphPreview, memoryGraphPalette, renderMemory, renderHub, chatActivity } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const chat = (id, messages = []) => ({ id, title: `Saved ${id}`, createdAt: 1, messages })
beforeEach(() => stored.clear())

test('Memory uses complete hydrated chats instead of the quota-trimmed browser skeleton', () => {
  const full = chat('report', [{ role: 'assistant', content: '', doc: { title: 'Complete account report', blocks: [] } }])
  stored.set('nalu-chats', JSON.stringify([chat('report')]))
  assert.equal(buildMemoryGraph().summary.studio, 0)
  const graph = buildMemoryGraph([full])
  assert.equal(graph.summary.studio, 1)
  assert.ok(graph.nodes.some(node => node.type === 'doc' && node.label === 'Complete account report'))
  assert.match(renderMemory([full]), /Complete account report/)
  assert.equal(buildMemoryGraph([]).summary.chats, 0, 'explicit empty live state never revives storage data')
})

test('Memory reflects same-count edits, every creation format, and files past the old four-item cap', () => {
  const messages = [
    { role: 'assistant', doc: { title: 'Old report' } },
    { role: 'assistant', sheet: { title: 'Budget' } },
    { role: 'assistant', deck: { title: 'Pitch' } },
    { role: 'assistant', design: { title: 'Website' } },
    { role: 'assistant', email: { subject: 'Delivery details' } },
    { role: 'assistant', cad: 'function main() { return cube(); }' },
    { role: 'assistant', video: 'https://example.test/saved.mp4' },
    { role: 'assistant', content: '![Generated scene](https://example.test/saved.png)' },
  ]
  const full = chat('work', messages)
  assert.equal(buildMemoryGraph([full]).summary.studio, 8)
  for (const kind of ['doc', 'sheet', 'deck', 'design', 'email', 'cad', 'video', 'image']) {
    assert.ok(buildMemoryGraph([full]).nodes.some(node => node.type === kind && node.meta.chatId === full.id), kind)
  }
  full.messages[0].doc.title = 'Corrected report'
  const html = renderMemory([full])
  assert.match(html, /Corrected report/)
  assert.match(html, /Delivery details/)
  assert.doesNotMatch(html, /Old report/)
})

test('deleted chats disappear from saved context even when an older cache still contains them', () => {
  stored.set('nalu-deleted-chats', JSON.stringify(['gone', { id: 'also-gone' }]))
  const graph = buildMemoryGraph([chat('gone'), chat('also-gone'), chat('kept')])
  assert.equal(graph.summary.chats, 1)
  assert.ok(graph.nodes.some(node => node.id === 'chat:kept'))
  assert.ok(!graph.nodes.some(node => node.meta.chatId === 'gone' || node.meta.chatId === 'also-gone'))
})

test('session clearing hides every collection when failed archiving retains the previous account data', () => {
  stored.set('nalu-chats', JSON.stringify([chat('retained')]))
  stored.set('nalu-agent-flows', JSON.stringify([{ id: 'retained-flow' }]))
  stored.set('nalu-automations', JSON.stringify([{ id: 'retained-automation' }]))
  stored.set('nalu-map-shapes', JSON.stringify([{ name: 'Retained place' }]))
  stored.set('nalu-map-active-layers', JSON.stringify(['retained-layer']))
  const graph = buildMemoryGraph([chat('retained-live')], { cleared: true })
  assert.equal(graph.summary.chats + graph.summary.studio + graph.summary.map + graph.summary.autopilot, 0)
  assert.ok(graph.nodes.every(node => node.type === 'core' || node.type === 'lobe'))
  assert.ok(stored.get('nalu-chats').includes('retained'), 'the recovery data is preserved, not deleted')
})

test('large accounts keep the whole library while only the force-layout preview is bounded', () => {
  const history = Array.from({ length: 400 }, (_, i) => chat(String(i), [{ role: 'assistant', doc: { title: `Document ${i}` } }]))
  stored.set('nalu-agent-flows', JSON.stringify(Array.from({ length: 35 }, (_, i) => ({ id: `flow-${i}`, name: `Workflow ${i}` }))))
  stored.set('nalu-map-shapes', JSON.stringify(Array.from({ length: 35 }, (_, i) => ({ name: `Place ${i}` }))))
  const graph = buildMemoryGraph(history)
  assert.equal(graph.summary.chats, 400)
  assert.equal(graph.summary.studio, 400)
  assert.equal(graph.nodes.filter(node => node.type === 'flow').length, 35)
  assert.equal(graph.nodes.filter(node => node.type === 'map').length, 35)
  assert.ok(graph.nodes.some(node => node.label === 'Document 399'))
  const preview = memoryGraphPreview(graph.nodes)
  assert.equal(preview.length, 128)
  assert.equal(preview.filter(node => node.type === 'lobe').length, 5)
  assert.equal(preview.filter(node => node.type === 'core').length, 1)
  assert.ok(graph.nodes.length > 800, 'limiting the preview never mutates the searchable library')
})

test('old or malformed saved records remain readable without crashing the Memory surface', () => {
  const graph = buildMemoryGraph([null, 7, {}, { id: '' }, chat('valid', [null, 1, {}, { role: 'user', content: { broken: true } }]), chat('valid')])
  assert.equal(graph.summary.chats, 1)
  assert.equal(graph.summary.qa, 0)
  assert.doesNotThrow(() => renderMemory([{ id: 'recoverable', messages: 'broken' }]))
})

test('All work displays completed and saved conversations instead of reporting an empty Memory', () => {
  const chats = Array.from({ length: 9 }, (_, i) => chat(`conversation-${i}`, [{ role: 'user', content: `Work ${i}` }]))
  const html = renderHub(chats, chatActivity(chats, []))
  for (const entry of chats) assert.ok(html.includes(entry.title), `${entry.title} remains available`)
  assert.match(html, /9 threads/)
  assert.doesNotMatch(html, /A quiet moment/)
  assert.equal((html.match(/class="live-hub-card"/g) || []).length, 9)
})

test('Memory graph ink stays legible in both light and dark containers', () => {
  const luminance = hex => {
    const rgb = hex.match(/[\da-f]{2}/gi).map(pair => parseInt(pair, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
  }
  for (const dark of [false, true]) {
    const ink = luminance(memoryGraphPalette(dark).label), panel = luminance(dark ? '#25272b' : '#f4f4f2')
    assert.ok((Math.max(ink, panel) + .05) / (Math.min(ink, panel) + .05) >= 7)
  }
})
