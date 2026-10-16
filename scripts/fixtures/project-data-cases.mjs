import assert from 'node:assert/strict'

const decode = value => { for (let n = 0; n < 6 && typeof value === 'string'; n++) value = JSON.parse(value); return value }
export async function projectDataCases(invoke) {
  let checks = 0
  for (const [collection, tombstones] of [['nalu-chat-projects', 'nalu-deleted-projects'], ['nalu-projects', 'nalu-deleted-workspace-projects']]) {
    const set = value => invoke({ action: 'set', key: collection, value })
    const remove = value => invoke({ action: 'set', key: tombstones, value })
    const load = async () => decode((await invoke({ action: 'load' })).body.data[collection]) || []
    const ids = async () => (await load()).map(item => item.id).sort()
    const project = (id, name = id) => ({ id, name, createdAt: 100 })
    assert.ok((await Promise.all([set([project('A')]), set(JSON.stringify([project('B')]))])).every(response => response.code === 200))
    assert.deepEqual(await ids(), ['A', 'B']); checks++
    await set([project('A')]); await set('[]')
    assert.deepEqual(await ids(), ['A', 'B']); checks++
    const base = (await load()).find(item => item.id === 'A')
    assert.equal((await set([{ ...base, name: 'Edited A' }])).code, 200)
    await set([base])
    assert.equal((await load()).find(item => item.id === 'A').name, 'Edited A'); checks++
    const conflicting = { ...base, name: 'Other device A', notes: 'Keep every byte 🐺' }
    await set([conflicting]); await set([conflicting])
    let rows = await load(), copies = rows.filter(item => item._projectSync?.conflictOf === 'A')
    assert.equal(copies.length, 1); assert.equal(copies[0].notes, 'Keep every byte 🐺')
    assert.equal(copies[0].name, 'Other device A (conflicting edit)')
    assert.equal(rows.find(item => item.id === 'A').name, 'Edited A'); checks++
    // A legacy client without a revision cannot silently clobber newer metadata.
    await set([project('A', 'Legacy rename')]); await set([project('A', 'Legacy rename')])
    assert.equal((await load()).filter(item => item.name === 'Legacy rename (conflicting edit)').length, 1); checks++
    const latest = (await load()).find(item => item.id === 'A')
    await set([{ ...latest, name: 'Resolved name' }])
    assert.equal((await load()).find(item => item.id === 'A').name, 'Resolved name'); checks++
    // Returning to old content from the current revision is intentional. Old
    // snapshots and lost acknowledgements still must not undo that new edit.
    const resolved = (await load()).find(item => item.id === 'A')
    const revert = { ...resolved, name: 'A' }
    await set([revert])
    const reverted = (await load()).find(item => item.id === 'A')
    assert.equal(reverted.name, 'A', 'A current-revision revert to historical content must be saved')
    assert.equal(reverted._projectSync.revision, resolved._projectSync.revision + 1); checks++
    await set([revert]); await set([resolved]); await set([latest])
    assert.deepEqual((await load()).find(item => item.id === 'A'), reverted)
    assert.equal((await load()).filter(item => item._projectSync?.conflictOf === 'A').length, 2); checks++
    await set([{ ...reverted, name: 'Edited A' }])
    const revertedAgain = (await load()).find(item => item.id === 'A')
    assert.equal(revertedAgain.name, 'Edited A')
    assert.equal(revertedAgain._projectSync.revision, reverted._projectSync.revision + 1); checks++
    await set([revert]); await set([reverted])
    assert.deepEqual((await load()).find(item => item.id === 'A'), revertedAgain)
    assert.equal((await load()).filter(item => item._projectSync?.conflictOf === 'A').length, 2); checks++
    await remove([copies[0].id]); await set([conflicting])
    assert.equal((await load()).some(item => item.id === copies[0].id), false); checks++
    await Promise.all([remove(['A']), set([project('A'), project('C')])])
    assert.equal((await ids()).includes('A'), false)
    assert.equal((await ids()).includes('C'), true)
    assert.equal((await ids()).includes('B'), true); checks++
    await Promise.all([remove(['B']), remove(['C'])])
    await remove([]); await set([project('B'), project('C')])
    assert.equal((await ids()).some(id => id === 'B' || id === 'C'), false); checks++
    // The tombstone prunes immediately even if setMany's project snapshot came first.
    for (const first of [true, false]) {
      const id = 'ordered-' + first
      const entries = first ? { [collection]: [project(id)], [tombstones]: [{ id }] } : { [tombstones]: [{ id }], [collection]: [project(id)] }
      assert.equal((await invoke({ action: 'setMany', entries })).code, 200)
      assert.equal((await ids()).includes(id), false); checks++
    }
    assert.equal((await set(JSON.stringify(JSON.stringify([project('nested')])))).code, 200)
    assert.equal((await ids()).includes('nested'), true); checks++
    const before = await load()
    for (const value of [null, '{}', 'invalid', [null], [{ name: 'Missing ID' }]]) {
      assert.equal((await set(value)).code, 400)
      assert.deepEqual(await load(), before)
    }
    for (const key of [collection, tombstones]) assert.equal((await invoke({ action: 'remove', key })).code, 400)
    assert.deepEqual(await load(), before); checks++
    const response = await set([project('response')])
    assert.ok(decode(response.body.data[collection]).some(item => item.id === 'response'))
    assert.ok(decode(response.body.data[tombstones]).includes('A')); checks++
    await remove((await load()).map(item => item.id))
    assert.deepEqual(await load(), [])
    await set(before); assert.deepEqual(await load(), []); checks++
  }
  return checks
}
