// Pure saved-artifact checks using the production update helper and merge.
// No browser, model providers, user data, or network access.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { updateDesignMessage, prepareDesignResponse } from '../client/src/components/workspace/designReferences.ts'
import { mergeChatMessages } from '../shared/chatMessages.ts'

async function loadContracts() {
  const directory = await fs.mkdtemp(fileURLToPath(new URL('./.artifact-sync-', import.meta.url)))
  try {
    const bundle = await build({ stdin: { contents: "export { createWebsiteBehaviorContractV2, parseWebsiteBehaviorContract } from './api/_websiteBehavior'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false })
    await fs.writeFile(directory + '/contracts.mjs', bundle.outputFiles[0].text)
    return await import(pathToFileURL(directory + '/contracts.mjs'))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
const { createWebsiteBehaviorContractV2, parseWebsiteBehaviorContract } = await loadContracts()
const clone = value => JSON.parse(JSON.stringify(value))
const contract = (id, expected) => ({ version: 1, checks: [{ id, test: { name: 'Saved calculation', steps: [{ action: 'fill', target: { label: 'Income' }, value: '1000' }, { action: 'click', target: { role: 'button', name: 'Calculate' } }], expect: [{ type: 'text', target: { selector: '#result' }, value: expected }] } }] })
const artifact = (heading, checks) => prepareDesignResponse('webpage', {
  html: `<!doctype html><html><body><h1>${heading}</h1></body></html>`,
  quality: { behaviorContract: checks, runtime: { status: 'passed', widths: [1440, 390], checks: [], limitations: [] } },
})
const oldDesign = artifact('Old calculator', contract('saved-calculation', '200'))
const fixedDesign = artifact('Repaired calculator', contract('saved-calculation', '250'))
const old = { id: 'assistant-1', role: 'assistant', content: '', reasoning: 'Preserved explanation', updatedAt: 100, design: oldDesign }
const oldSnapshot = clone(old)
const fixed = updateDesignMessage(old, fixedDesign, 200)
assert.deepEqual(old, oldSnapshot, 'Updating a design must not mutate the original saved message')
assert.notEqual(fixed, old)
assert.equal(fixed.updatedAt, 200)
assert.equal(fixed.id, old.id)
assert.equal(fixed.reasoning, old.reasoning)
assert.deepEqual(fixed.design.quality.behaviorContract, fixedDesign.quality.behaviorContract)

for (const [incoming, stored] of [[fixed, old], [old, fixed]]) {
  const merged = mergeChatMessages(clone([incoming]), clone([stored]))
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0], fixed, 'The repaired artifact and its matching checks must win in either merge direction')
  const reloaded = clone(merged)
  assert.deepEqual(mergeChatMessages([old], reloaded)[0], fixed, 'A stale save after JSON reload must not revive the earlier design')
  assert.deepEqual(mergeChatMessages(reloaded, [old])[0], fixed, 'Reloading and synchronizing in reverse preserves the complete repaired artifact')
}

// Two repairs in one clock tick still need distinct ordering, and a device
// clock moving backward cannot make a newer edit look stale.
const second = updateDesignMessage(fixed, artifact('Second repair', contract('saved-calculation', '300')), 200)
const third = updateDesignMessage(second, artifact('Third repair', contract('saved-calculation', '350')), 150)
assert.equal(second.updatedAt, 201)
assert.equal(third.updatedAt, 202)
for (const previous of [old, fixed, second]) {
  assert.deepEqual(mergeChatMessages([previous], [third])[0], third)
  assert.deepEqual(mergeChatMessages([third], [previous])[0], third)
}

// An HTML-identical repair can still establish new verified behavior checks.
const metadataOnly = updateDesignMessage(fixed, { ...fixedDesign, quality: { ...fixedDesign.quality, behaviorContract: contract('additional-check', '250') } }, 200)
assert.equal(metadataOnly.design.html, fixed.design.html)
assert.equal(mergeChatMessages([fixed], clone([metadataOnly]))[0].design.quality.behaviorContract.checks[0].id, 'additional-check')

// A response based on an older artifact must not overwrite a newer in-flight
// edit, even when the newer edit changed only private behavior metadata.
assert.equal(updateDesignMessage(fixed, oldDesign, 500, oldDesign), fixed, 'Reject an obsolete response after the source HTML changed')
assert.equal(updateDesignMessage(metadataOnly, oldDesign, 500, fixedDesign), metadataOnly, 'Reject an obsolete response after only the source checks changed')
const withoutDesign = { ...old, design: undefined }
assert.equal(updateDesignMessage(withoutDesign, fixedDesign, 500, oldDesign), withoutDesign, 'Do not restore an artifact removed while its repair was running')
assert.deepEqual(updateDesignMessage(old, fixedDesign, 200, oldDesign), fixed, 'Accept a response whose exact source artifact is still current')
const cloudClone = clone(old)
assert.notEqual(cloudClone.design, old.design)
assert.deepEqual(updateDesignMessage(cloudClone, fixedDesign, 200, oldDesign), fixed, 'Accept identical JSON-reloaded source state despite its new object identity')
const cyclic = { ...oldDesign }
cyclic.self = cyclic
const cyclicMessage = { ...old, design: cyclic }
assert.equal(updateDesignMessage(cyclicMessage, fixedDesign, 500, oldDesign), cyclicMessage, 'Unserializable state cannot accidentally match a response source')

// Legacy messages and invalid persisted clocks must acquire a finite clock.
const legacy = { role: 'assistant', content: '', design: oldDesign }
const repairedLegacy = updateDesignMessage(legacy, fixedDesign, 300)
for (const [incoming, stored] of [[legacy, repairedLegacy], [repairedLegacy, legacy]]) {
  assert.deepEqual(mergeChatMessages([incoming], [stored])[0], repairedLegacy)
}
for (const invalid of [undefined, NaN, Infinity, -Infinity]) {
  const updated = updateDesignMessage({ ...old, updatedAt: invalid }, fixedDesign, 400)
  assert.equal(updated.updatedAt, 400)
  assert.ok(Number.isFinite(updated.updatedAt))
}
for (const invalidNow of [NaN, Infinity, -Infinity]) assert.equal(updateDesignMessage(old, fixedDesign, invalidNow).updatedAt, 101)
assert.throws(() => updateDesignMessage({ ...old, updatedAt: Number.MAX_VALUE }, fixedDesign, 500), /timestamp cannot be advanced/)

// Private checks travel with the message, never inside downloadable HTML.
assert.equal(fixed.design.html, fixedDesign.html)
assert.ok(!fixed.design.html.includes('saved-calculation'))
assert.deepEqual(clone(fixed).design.quality.behaviorContract, fixedDesign.quality.behaviorContract)

// Updating only required-function coverage must have the same stale-save and
// stale-response protection as an HTML edit. Build valid fixtures through the
// production constructor so a v2 wire-schema change cannot silently evade this.
const privateBrief = 'Fill Income. Send real email to PRIVATE_SYNC_REQUIREMENT.'
const unsupported = { id: 'email', quote: 'Send real email to PRIVATE_SYNC_REQUIREMENT.', viewports: ['desktop', 'mobile'], goal: { kind: 'capability', description: 'External email delivery' }, coverage: { state: 'unsupported', reason: 'External delivery cannot be checked in the isolated page.' } }
const inventory = { version: 1, requirements: [
  { id: 'income', quote: 'Fill Income.', viewports: ['desktop', 'mobile'], goal: { kind: 'control', action: 'fill', target: { label: 'Income' } }, coverage: { state: 'mapped', refs: [{ checkId: 'saved-calculation', step: 0 }] } },
  unsupported,
] }
const v2Contract = createWebsiteBehaviorContractV2(fixedDesign.quality.behaviorContract.checks, inventory, privateBrief)
const revisedInventory = clone(inventory)
revisedInventory.requirements[1].coverage.reason = 'Real email delivery needs an external provider and remains unverified.'
const revisedV2 = createWebsiteBehaviorContractV2(v2Contract.checks, revisedInventory, privateBrief)
assert.equal(v2Contract.version, 2)
assert.deepEqual(v2Contract.checks, revisedV2.checks)
assert.deepEqual(v2Contract.evidence, revisedV2.evidence)
assert.notDeepEqual(v2Contract.inventory, revisedV2.inventory, 'This fixture changes inventory alone')
const v2Design = artifact('Repaired calculator', v2Contract)
const v2Message = { ...fixed, updatedAt: 600, design: v2Design }
const revisedDesign = { ...v2Design, quality: { ...v2Design.quality, behaviorContract: revisedV2 } }
const inventoryUpdate = updateDesignMessage(v2Message, revisedDesign, 600, v2Design)
assert.equal(inventoryUpdate.updatedAt, 601)
assert.equal(inventoryUpdate.design.html, v2Message.design.html)
for (const [incoming, stored] of [[v2Message, inventoryUpdate], [inventoryUpdate, v2Message]]) {
  const merged = mergeChatMessages(clone([incoming]), clone([stored]))
  assert.deepEqual(merged, [inventoryUpdate], 'An inventory-only update wins in both save orders')
  const reloaded = clone(merged)
  assert.deepEqual(parseWebsiteBehaviorContract(reloaded[0].design.quality.behaviorContract), revisedV2)
  assert.deepEqual(mergeChatMessages(clone([v2Message]), reloaded), [inventoryUpdate], 'A stale save after reload cannot restore earlier inventory')
  assert.deepEqual(mergeChatMessages(reloaded, clone([v2Message])), [inventoryUpdate])
}
assert.equal(updateDesignMessage(inventoryUpdate, v2Design, 900, v2Design), inventoryUpdate, 'An old repair cannot overwrite newer inventory even when HTML, checks, and evidence are identical')
assert.deepEqual(updateDesignMessage(clone(v2Message), revisedDesign, 600, v2Design), inventoryUpdate, 'Identical reloaded v2 source state still accepts its pending update')
assert.deepEqual(v2Message.design.quality.behaviorContract, v2Contract, 'Inventory changes do not mutate the original message')

// Empty executable suites still carry explicit unverified requirements. They
// must not disappear or resurrect older checks when another device saves.
const noChecks = createWebsiteBehaviorContractV2([], { version: 1, requirements: [unsupported] }, privateBrief)
const noChecksDesign = artifact('Repaired calculator', noChecks)
const noChecksMessage = updateDesignMessage(inventoryUpdate, noChecksDesign, 700, revisedDesign)
for (const [incoming, stored] of [[inventoryUpdate, noChecksMessage], [noChecksMessage, inventoryUpdate]]) {
  const saved = clone(mergeChatMessages(clone([incoming]), clone([stored])))
  assert.deepEqual(saved, [noChecksMessage])
  assert.deepEqual(parseWebsiteBehaviorContract(saved[0].design.quality.behaviorContract), noChecks)
}
assert.doesNotMatch(noChecksMessage.design.html, /PRIVATE_SYNC_REQUIREMENT|requestHash|behaviorContract/)
console.log('PASS: repaired website HTML and v1/v2 private checks/inventory survive stale saves, both merge orders, JSON reloads, empty suites, repeated edits, and clock rollback; obsolete repair responses preserve current work.')
