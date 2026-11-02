import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({ stdin: { contents: "export * from './client/src/components/workspace/design/generativeUi'; export * from './shared/chatMessages'", loader: 'ts', resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const raw = { title: 'Property comparison', blocks: [
 { id: 'returns', type: 'calculator', title: 'Try your numbers', fields: [{ id: 'price', type: 'number', label: 'Price', value: '400000' }, { id: 'noi', type: 'number', label: 'Annual NOI', value: '24000' }], calculations: [{ label: 'Cap rate', formula: 'noi/price', format: 'percent' }] },
 { id: 'next', type: 'checklist', title: 'Due diligence', items: [{ id: 'leases', label: 'Verify leases', checked: false }] },
] }
const json = JSON.stringify(raw)
for (let length = 1; length < json.length; length++) {
 const partial = api.readStreamingUi(json.slice(0, length))
 if (partial) { assert.ok(partial.blocks.length <= 2); assert.ok(partial.blocks.every(b => b.id === 'returns' || b.id === 'next')) }
}
const firstEnd = json.indexOf('},{"id":"next"') + 1
assert.equal(api.readStreamingUi(json.slice(0, firstEnd)).blocks.length, 1)
assert.equal(api.uiFromText('```nalu_ui\n' + json.slice(0, firstEnd)).complete, false)
assert.equal(api.uiFromText('```nalu_ui\n' + json + '\n```').complete, true)
assert.equal(api.uiFromText('```nalu_ui\n' + json + '\n```').ui.blocks.length, 2)
assert.equal(api.uiFromText(json).ui.blocks.length, 2)
assert.equal(api.uiFromText('```json\n' + json + '\n```').ui.blocks.length, 2)
assert.equal(api.workspaceText(json), '')
assert.equal(api.workspaceText('Intro\n```nalu_ui\n' + json + '\n```\nDone'), 'Intro\n\nDone')
assert.equal(api.calculate('noi / price', { noi: '24000', price: '400000' }), .06)
assert.equal(api.calculate('(rent-expenses)*12/price', { rent: '3000', expenses: '1000', price: '400000' }), .06)
assert.equal(api.calculate('noi/price', { noi: '24000', price: '0' }), null)
assert.equal(api.calculate('noi/price', { noi: '24000', price: '' }), null)
for (const formula of ['globalThis.process.exit()', '1;alert(1)', 'Math.random()', 'price ** 2', 'Infinity', 'constructor', '1/0', '1e999']) assert.equal(api.calculate(formula, {}), null)
const malicious = api.parseGenerativeUi({ blocks: [{ id: 'x', type: 'text', sources: [{ label: 'bad', url: 'javascript:alert(1)' }, { label: 'safe', url: 'https://example.com' }] }, { id: 'x', type: 'text' }, { id: 'code', type: 'javascript', text: 'alert(1)' }] })
assert.equal(malicious.blocks.length, 1)
assert.equal(malicious.blocks[0].sources.length, 1)
assert.equal(api.parseGenerativeUi({ blocks: Array.from({ length: 100 }, (_, i) => ({ id: `block${i}`, type: 'text' })) }).blocks.length, 24)
const saved = { id: 'reply', role: 'assistant', content: 'Saved workspace', generativeUi: api.parseGenerativeUi(raw), uiValues: { 'returns:price': '500000', 'next:leases': true }, uiComplete: true, updatedAt: 20 }
const stale = { id: 'reply', role: 'assistant', content: 'Saved workspace', updatedAt: 10 }
assert.deepEqual(api.mergeChatMessages([stale], [saved])[0], saved)
assert.deepEqual(api.mergeChatMessages([{ ...stale, updatedAt: 30 }], [saved])[0].uiValues, saved.uiValues)
console.log('PASS streamed complete-block assembly, partial JSON recovery, arithmetic without code execution, invalid-input handling, URL/type/size validation and cross-client retention of saved layout and edits')
