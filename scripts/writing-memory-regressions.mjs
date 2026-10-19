import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const tmp = await mkdtemp(`${process.cwd()}/scripts/.writing-memory-`)
const originalFetch = globalThis.fetch
const stored = new Map()
globalThis.localStorage = { getItem: key => stored.get(key) || null }
process.env.NALU_FALLBACK_API_KEY = 'synthetic-fallback'
process.env.NALU_DISABLE_EMERGENCY = '1'
delete process.env.TINKER_API_KEY
let passed = 0
const check = (label, fn) => { fn(); passed++; console.log('PASS', label) }
try {
  await build({ stdin: { resolveDir: process.cwd(), contents: `export { buildChatMemory } from './client/src/components/workspace/crossChatMemory';export { buildAccountContext } from './api/_accountContext';export * from './api/_profileLearning';export * from './shared/contextSelection';` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: `${tmp}/memory.mjs` })
  const { buildChatMemory, buildAccountContext, applyProfileLearning, shouldLearnProfile, conversationContext } = await import(pathToFileURL(`${tmp}/memory.mjs`))
  const ask = [{ role: 'user', content: 'What is the Cedar launch amount now?' }]
  const chat = { id: 'cedar', title: 'Cedar launch', createdAt: 1, updatedAt: 3, messages: [{ role: 'user', content: 'Cedar budget is $4000. ' + 'Old planning details. '.repeat(250) }, { role: 'assistant', content: 'I think the budget is $9000.' }, { role: 'user', content: 'Correction: Cedar is now $6200. Do not use the old amount.' }] }
  const noise = Array.from({ length: 180 }, (_, i) => ({ id: `noise-${i}`, title: 'Unrelated errands', createdAt: 100 + i, messages: [{ role: 'user', content: 'Buy oranges' }] }))
  stored.set('nalu-chats', JSON.stringify([...noise, chat]))
  check('old relevant chat and its late correction survive 180 newer chats', () => { const memory = buildChatMemory(ask); assert.match(memory, /6200/); assert.match(memory, /unverified/); assert.doesNotMatch(memory, /Buy oranges/) })
  chat.messages.at(-1).content = 'Correction: Cedar is now $7100. Ignore the old amount.'
  stored.set('nalu-chats', JSON.stringify([...noise, chat]))
  check('same-count edits invalidate remembered facts', () => assert.match(buildChatMemory(ask), /7100/))
  stored.set('nalu-deleted-chats', JSON.stringify(['cedar']))
  check('deleted chats are not retrieved locally', () => assert.doesNotMatch(buildChatMemory(ask), /Cedar/))
  stored.delete('nalu-deleted-chats')
  stored.set('nalu-chats', JSON.stringify([chat]))
  check('a new unsaved chat can retrieve the single previous conversation', () => assert.match(buildChatMemory(ask), /7100/))
  check('fresh unrelated task does not inherit recent client identity', () => assert.equal(buildChatMemory([{ role: 'user', content: 'Make a whimsical unicorn logo' }]), ''))
  check('account retrieval retains correction and provenance', () => { const out = buildAccountContext({ id: 'test', displayName: 'Tester' }, { 'nalu-chats': [chat, ...noise] }, [], ask); assert.match(out, /7100/); assert.match(out, /not independently verified/) })
  check('account retrieval retains the latest record for conversation metadata questions', () => {
    const out = buildAccountContext({ id: 'test', displayName: 'Tester' }, { 'nalu-chats': [{ id: 'metadata', title: 'Older conversation', createdAt: Date.parse('2026-07-05T00:00:00Z'), messages: [{ role: 'user', content: 'Saved meeting details.' }] }] }, [], [{ role: 'user', content: 'When was this conversation created?' }])
    assert.match(out, /2026-07-05T00:00:00.000Z/)
  })
  check('account tombstones win over stale saved records', () => assert.doesNotMatch(buildAccountContext({ id: 'test', displayName: 'Tester' }, { 'nalu-chats': [chat], 'nalu-deleted-chats': ['cedar'] }, [], ask), /7100/))
  check('conversation keeps initial requirements and the last correction', () => { const text = conversationContext([{ role: 'user', content: 'Use three headings: Scope, Price, Timing.' }, ...noise.map(c => c.messages[0]), { role: 'user', content: 'The price is now $7100; no deadline.' }], 'Make the document'); assert.match(text, /Scope, Price, Timing/); assert.match(text, /7100/) })
  check('fictional first-person writing is not learned as autobiography', () => assert.equal(shouldLearnProfile('Write an email saying I am a surgeon and my name is John.'), false))
  const old = '- I live in Boston\n- I prefer concise emails'
  check('profile correction preserves unrelated preferences', () => assert.equal(applyProfileLearning(old, 'I live in Austin now.', JSON.stringify({ changes: [{ quote: 'I live in Austin now.', replaces: ['- I live in Boston'] }] })), '- I prefer concise emails\n- User said: I live in Austin now.'))
  check('profile replacement tolerates formatting without changing fact matching', () => assert.equal(applyProfileLearning(old, 'I live in Austin now.', JSON.stringify({changes:[{quote:'I live in Austin now.',replaces:['I live in Boston']}]})), '- I prefer concise emails\n- User said: I live in Austin now.'))
  check('invented profile quotes cannot be saved', () => assert.equal(applyProfileLearning(old, 'I prefer concise emails.', JSON.stringify({ changes: [{ quote: 'I am a millionaire.', replaces: [] }] })), null))
  check('explicit forgetting removes only the requested profile fact', () => assert.equal(applyProfileLearning(old, 'Forget where I live.', JSON.stringify({ changes: [{ quote: 'Forget where I live.', replaces: ['- I live in Boston'], forget: true }] })), '- I prefer concise emails'))

  const mocks = {
    './_db': 'export async function identityForRequest(){return {id:"fixture",name:"Alex",profile:""}};export function identityBlock(){return ""}',
    './_accountContext': 'export async function accountContextForUser(){return ""}',
    './_limits': 'export async function reserveStudioQuota(){return {ok:true,release:async()=>{}}};export function studioLimitMessage(){return "limit"}',
    './_grounding': 'export async function groundResearch(){return {text:"",sources:[],status:"not-needed"}}',
  }
  await build({ stdin: { resolveDir: process.cwd(), contents: `export { default as email } from './api/email';export { default as doc } from './api/doc';` }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: `${tmp}/writers.mjs`, plugins: [{ name: 'isolated-account', setup(b) { b.onResolve({ filter: /^\.\/_/ }, args => mocks[args.path] ? { path: args.path, namespace: 'mock' } : null);b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path] })) } }] })
  const { email, doc } = await import(pathToFileURL(`${tmp}/writers.mjs`))
  const run = async (handler, body, outputs) => {
    const calls = []
    globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body));assert.ok(outputs.length, 'unexpected model call');return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(outputs.shift()) }, finish_reason: 'stop' }] }), { status: 200 }) }
    const res = { code: 200, setHeader() {}, status(code) { this.code = code;return this }, json(value) { this.body = value;return this } }
    await handler({ method: 'POST', headers: {}, body }, res)
    return { ...res, calls }
  }
  const previous = { to: 'jane@example.com', subject: 'Cedar proposal', body: 'Hi Jane,\nThe proposal is $4000.\nThanks,\nAlex' }
  const corrected = { ...previous, body: 'Hi Jane,\nThe proposal is $7100. Would you like to discuss it?\nThanks,\nAlex' }
  let r = await run(email, { prompt: 'Make it warmer and use the updated amount; keep the subject.', prevEmail: previous, messages: [{ role: 'user', content: 'Cedar now costs $7100, with no deadline.' }], material: 'Jane is the reader.' }, [corrected, corrected])
  check('email revision uses conversation, material and existing draft with fallback-only configuration', () => { assert.equal(r.code, 200, JSON.stringify(r.body));assert.equal(r.body.to, previous.to);assert.equal(r.body.subject, previous.subject);for (const call of r.calls) { const text = JSON.stringify(call.messages);assert.match(text, /7100/);assert.match(text, /EXISTING EMAIL/);assert.match(text, /Jane is the reader/);assert.match(text, /latest|Latest|LATEST/) } })
  r = await run(email, { prompt: 'Write to Jane about Cedar.' }, [{ ...corrected, to: 'invented@example.com' }, { ...corrected, to: '' }, { ...corrected, to: '' }])
  check('an invented destination is rejected and repaired', () => { assert.equal(r.code, 200);assert.equal(r.body.to, '');assert.equal(r.calls.length, 3) })
  const literal = { to: '', subject: 'Exact wording', body: 'I wanted to reach out to request the revised quote by Friday.' }
  r = await run(email, { prompt: `Use this exact body: ${literal.body}` }, [literal, literal])
  check('literal email wording is not destroyed by cosmetic cleanup', () => assert.equal(r.body.body, literal.body))
  r = await run(email, { prompt: 'Make it shorter', prevEmail: '{broken' }, [])
  check('unreadable previous draft fails before generation', () => assert.equal(r.code, 400))
  const document = { title: 'Cedar proposal', blocks: [{ type: 'heading', level: 1, text: 'Scope' }, { type: 'paragraph', text: 'Cedar design work.' }, { type: 'heading', level: 1, text: 'Price' }, { type: 'paragraph', text: '$7100.' }] }
  r = await run(doc, { prompt: 'Update the price. Keep the headings.', messages: [{ role: 'user', content: 'Use $7100 instead of $4000.' }], material: 'Cedar design work.', prevDoc: JSON.stringify({ ...document, blocks: [{ type: 'paragraph', text: '$4000.' }] }) }, [document, document])
  check('document revision and final editor both receive latest facts and source draft', () => { assert.equal(r.code, 200, JSON.stringify(r.body));assert.equal(r.calls.length, 2);for (const call of r.calls) { assert.match(JSON.stringify(call.messages), /7100/);assert.match(JSON.stringify(call.messages), /4000/);assert.match(JSON.stringify(call.messages), /Cedar design work/) } })
  console.log(JSON.stringify({ passed, ok: true }))
} finally { globalThis.fetch = originalFetch;delete globalThis.localStorage;await rm(tmp, { recursive: true, force: true }) }
