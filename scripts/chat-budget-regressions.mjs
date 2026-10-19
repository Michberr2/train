import assert from 'node:assert/strict'
import { build } from 'esbuild'
const bundle = await build({ entryPoints: ['api/_chatBudget.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { budgetChatContext, estimatedTokens, ChatContextError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { pickSpecialist, scoreSpecialistEx, pickSpecialistsMulti } = await import('../api/_specialists.ts')
let checks = 0

for (const language of ['An old record with details. ', '原始记录包括重要的参考资料。', 'سجل يحتوي على معلومات سابقة. ']) {
  for (const turns of [5, 20, 50]) {
    const messages = [{ role: 'system', content: 'Keep all user constraints. Use tool evidence only when present.' }]
    for (let turn = 0; turn < turns; turn++) {
      messages.push(
        { role: 'user', content: `Instruction ${turn}: preserve budget=${turn + 1000}, unit=EUR, filename=record-${turn}.csv.` },
        { role: 'assistant', content: null, tool_calls: [{ id: `read-${turn}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `record-${turn}.csv` }) } }, { id: `calc-${turn}`, type: 'function', function: { name: 'calculate', arguments: '{"expression":"2+2"}' } }] },
        { role: 'tool', tool_call_id: `read-${turn}`, content: language.repeat(turn === turns - 1 ? 1 : 400) },
        { role: 'tool', tool_call_id: `calc-${turn}`, content: '4' },
        { role: 'assistant', content: `Acknowledged record ${turn}.` },
      )
    }
    const before = JSON.stringify(messages)
    const result = budgetChatContext(messages, { maxOutputTokens: 4096, contextTokens: 16384, tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] })
    assert.ok(result.removedMessages > 0)
    assert.ok(result.estimatedInputTokens <= result.inputBudget, `token estimate over budget for ${turns} turns`)
    assert.deepEqual(result.messages.filter(message => message.role === 'user'), messages.filter(message => message.role === 'user'))
    assert.deepEqual(result.messages.slice(-5), messages.slice(-5))
    assert.equal(JSON.stringify(messages), before, 'budgeting must not mutate source/history storage')
    const calls = new Set(result.messages.flatMap(message => (message.tool_calls || []).map(call => call.id)))
    const results = new Set(result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
    assert.deepEqual(calls, results, 'keep both/all parallel results with their generating assistant')
    checks++
  }
}
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(3_000_000) } }
const pictureMessage = [{ role: 'system', content: 'Inspect the available image.' }, { role: 'user', content: [{ type: 'text', text: 'Read the label.' }, image] }]
assert.deepEqual(budgetChatContext(pictureMessage, { maxOutputTokens: 4096, contextTokens: 64000 }).messages, pictureMessage)
assert.equal(estimatedTokens(image), 8192)
assert.ok(estimatedTokens('数据') > estimatedTokens('ab'), 'non-ASCII text must account for UTF-8 size')
checks++
for (const messages of [
  [{ role: 'system', content: 'Instruction '.repeat(10000) }, { role: 'user', content: 'Proceed.' }],
  [{ role: 'system', content: 'Follow instructions.' }, { role: 'user', content: 'Required exact data '.repeat(10000) }],
  [{ role: 'system', content: 'Follow instructions.' }, { role: 'user', content: 'Use this current tool result.' }, { role: 'assistant', content: null, tool_calls: [{ id: 'active' }] }, { role: 'tool', tool_call_id: 'active', content: 'Current evidence '.repeat(10000) }],
]) {
  assert.throws(() => budgetChatContext(messages, { maxOutputTokens: 4096, contextTokens: 16384 }), ChatContextError)
  checks++
}
const small = [{ role: 'system', content: 'Be accurate.' }, { role: 'user', content: 'Hello.' }]
assert.deepEqual(budgetChatContext(small, { maxOutputTokens: 4096 }).messages, small)
assert.throws(() => budgetChatContext(small, { maxOutputTokens: 4096, contextTokens: 8192, tools: { description: 'Huge tool catalogue '.repeat(20000) } }), ChatContextError)
checks++

assert.equal(scoreSpecialistEx('cryptocurrency cryptocurrency CRYPTOCURRENCY').hits, 1)
assert.equal(pickSpecialistsMulti([{ role: 'user', content: 'Discuss cryptocurrency '.repeat(10) + 'and insurance '.repeat(10) }]).length, 0)
assert.equal(pickSpecialist([pictureMessage[1], { role: 'assistant', content: 'The label says Sample.' }, { role: 'user', content: 'Debug this TypeScript exception in React.' }]).kind, 'code')
assert.equal(pickSpecialist(pictureMessage).kind, 'vision')
checks++
console.log(`PASS ${checks} context/routing groups: multilingual 5–50 turn histories, all user constraints, parallel tool pairs, protected current results/images, oversized failures, tool overhead, and distinct-keyword/current-image routing`)
