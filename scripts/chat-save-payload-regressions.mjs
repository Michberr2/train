import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
async function load(path) {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('./.payload-check-', import.meta.url)))
  try {
    const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external' })
    await fs.writeFile(directory + '/fixture.mjs', result.outputFiles[0].text)
    return await import(pathToFileURL(directory + '/fixture.mjs'))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
const { syncBodies } = await load('client/src/lib/syncPayload.ts')
// A missing sibling checkout is a verification failure, never a skipped pass.
const { syncBodies: desktopSyncBodies } = await load(fileURLToPath(new URL('../../naludesktop/src/lib/syncPayload.ts', import.meta.url)))
const { syncEntries } = await load('api/_syncPayload.ts')
const { mergeChatMessages } = await load('shared/chatMessages.ts')
const { createWebsiteBehaviorContractV2, parseWebsiteBehaviorContract } = await load('api/_websiteBehavior.ts')
const privateBrief = 'Send real email to PRIVATE_PAYLOAD_REQUIREMENT.'
const inventory = { version: 1, requirements: [{ id: 'email', quote: privateBrief, viewports: ['desktop', 'mobile'], goal: { kind: 'capability', description: 'External email delivery' }, coverage: { state: 'unsupported', reason: 'External delivery cannot be checked in the isolated page.' } }] }
const behaviorContract = createWebsiteBehaviorContractV2([], inventory, privateBrief)
assert.equal(behaviorContract.version, 2)
const v2Message = { id: 'private-v2', role: 'assistant', content: 'Saved website', updatedAt: 200, design: { kind: 'webpage', html: '<html>Private metadata stays outside this page.</html>', quality: { behaviorContract } } }
const smallEntries = { 'nalu-chats': JSON.stringify([{ id: 'v2-site', messages: [v2Message] }]), 'nalu-theme': 'dark' }
const chats = Array.from({ length: 4 }, (_, i) => ({ id: `chat-${i}`, messages: [{ id: `answer-${i}`, role: 'assistant', content: '🐺'.repeat(310000), design: { html: '<html>All original artifact bytes</html>' } }] }))
chats[0].messages.push(v2Message)
const enormous = [{ id: 'large-site', messages: [{ role: 'assistant', design: { html: '<section>A complete generated website</section>'.repeat(200000) } }, v2Message] }]
for (const [name, encode] of [['web', syncBodies], ['desktop', desktopSyncBodies]]) {
  const small = await encode(smallEntries, 'fixture')
  assert.equal(small.length, 1, `${name}: a small v2 artifact uses a plain payload`)
  assert.deepEqual(syncEntries(JSON.parse(small[0])), smallEntries, `${name}: plain payloads retain the exact private contract JSON`)
  const smallReload = JSON.parse(syncEntries(JSON.parse(small[0]))['nalu-chats'])
  assert.deepEqual(parseWebsiteBehaviorContract(smallReload[0].messages[0].design.quality.behaviorContract), behaviorContract)
  assert.doesNotMatch(smallReload[0].messages[0].design.html, /PRIVATE_PAYLOAD_REQUIREMENT|requestHash|behaviorContract/)

  const bodies = await encode({ 'nalu-chats': JSON.stringify(chats), 'nalu-theme': 'dark' }, 'fixture')
  assert.ok(bodies.length > 1, `${name}: a large UTF-8 history is batched`)
  const restored = []
  let theme
  for (const body of bodies) {
    assert.ok(new TextEncoder().encode(body).length < 3500000)
    const values = syncEntries(JSON.parse(body))
    if (values['nalu-chats']) restored.push(...JSON.parse(values['nalu-chats']))
    if (values['nalu-theme']) theme = values['nalu-theme']
  }
  assert.equal(theme, 'dark', `${name}: non-chat entries survive batching`)
  assert.deepEqual(restored, chats, `${name}: batched UTF-8 history preserves every message, legacy artifact, and v2 inventory/evidence`)
  const compressed = await encode({ 'nalu-chats': JSON.stringify(enormous) }, 'fixture')
  assert.equal(compressed.length, 1)
  assert.equal(JSON.parse(compressed[0]).encoding, 'gzip-base64')
  const decompressed = JSON.parse(syncEntries(JSON.parse(compressed[0]))['nalu-chats'])
  assert.deepEqual(decompressed, enormous, `${name}: gzip preserves complete HTML and v2 metadata unchanged`)
  assert.deepEqual(parseWebsiteBehaviorContract(decompressed[0].messages[1].design.quality.behaviorContract), behaviorContract)
}
for (const invalid of [{ compressedEntries: '***', encoding: 'gzip-base64' }, { compressedEntries: 'dGVzdA==', encoding: 'gzip-base64' }, { entries: [] }]) assert.throws(() => syncEntries(invalid))
const finished = { id: 'a', role: 'assistant', content: 'The complete answer.', updatedAt: 200, design: { html: 'saved' } }
assert.deepEqual(mergeChatMessages([{ ...finished, content: 'The comp', updatedAt: 100, design: undefined }], [finished]), [finished])
assert.equal(mergeChatMessages([{ role: 'assistant', content: 'The comp' }], [{ role: 'assistant', content: 'The complete answer.' }])[0].content, 'The complete answer.')
const prefix = [{ id: 'u', role: 'user', content: 'Hello' }, finished]
const branchA = [{ id: 'ua', role: 'user', content: 'From A' }, { id: 'aa', role: 'assistant', content: 'Answer A' }]
const branchB = [{ id: 'ub', role: 'user', content: 'From B' }, { id: 'ab', role: 'assistant', content: 'Answer B' }]
const union = mergeChatMessages([...prefix, ...branchB], [...prefix, ...branchA])
assert.deepEqual(union.map(m => m.id), ['u', 'a', 'ua', 'aa', 'ub', 'ab'])
assert.deepEqual(mergeChatMessages([...prefix, ...branchB], union), union, 'retries cannot duplicate turns')
console.log('PASS: web and desktop plain/batched/compressed v2 inventory preservation, large UTF-8 histories, legacy artifacts, malformed uploads, stale replies, concurrent turns, idempotent retry')
