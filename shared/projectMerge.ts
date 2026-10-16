/** Project snapshots are unions, not replacement lists. A change carries the
 * revision it was edited from. An ambiguous/competing edit becomes a visible
 * conflict copy, preserving both versions rather than choosing by device clock.
 */
export type ProjectRecord = Record<string, any> & { id: string }
export class ProjectDataValidationError extends Error {}
export const PROJECT_COLLECTIONS: Record<string, string> = {
  'nalu-chat-projects': 'nalu-deleted-projects',
  'nalu-projects': 'nalu-deleted-workspace-projects',
}
export function projectKeys(key: string): [string, string] | null {
  const collection = PROJECT_COLLECTIONS[key] ? key : Object.keys(PROJECT_COLLECTIONS).find(name => PROJECT_COLLECTIONS[name] === key)
  return collection ? [collection, PROJECT_COLLECTIONS[collection]] : null
}
export function projectArray(value: unknown, missing = false): any[] {
  if (missing && value === undefined) return []
  for (let n = 0; n < 6 && typeof value === 'string'; n++) {
    try { value = JSON.parse(value) } catch { throw new ProjectDataValidationError('Saved projects must be a JSON array.') }
  }
  if (!Array.isArray(value)) throw new ProjectDataValidationError('Saved projects must be an array. Delete projects explicitly instead of removing their collection.')
  return value
}
function records(value: unknown, missing = false): ProjectRecord[] {
  return projectArray(value, missing).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim()) throw new ProjectDataValidationError('Each saved project needs a stable ID.')
    return item
  })
}
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
export function projectContent(project: ProjectRecord): string {
  const { _projectSync, ...content } = project
  return canonical(content)
}
const revision = (project: ProjectRecord) => Number.isSafeInteger(project._projectSync?.revision) && project._projectSync.revision > 0 ? project._projectSync.revision : 0
const encodeLike = (value: unknown, original: unknown) => typeof original === 'string' ? JSON.stringify(value) : value
export function projectDeletedIds(value: unknown, missing = false): string[] {
  return [...new Set(projectArray(value, missing).map(item => {
    const id = typeof item === 'string' ? item : item?.id
    if (typeof id !== 'string' || !id.trim()) throw new ProjectDataValidationError('Each project deletion needs an ID.')
    return id
  }))]
}
// This hash makes retry IDs compact; exact submitted content, not the hash, is
// used for equality. A collision gets a new suffix and cannot discard content.
function shortHash(text: string): string {
  let a = 2166136261, b = 2246822519
  for (let n = 0; n < text.length; n++) { a = Math.imul(a ^ text.charCodeAt(n), 16777619); b = Math.imul(b ^ text.charCodeAt(n), 3266489917) }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36)
}
export function mergeProjectRecords(stored: unknown, incoming: unknown, deleted: unknown, optimistic = false): ProjectRecord[] {
  const dead = new Set(projectDeletedIds(deleted, true))
  const byId = new Map(records(stored, true).filter(item => !dead.has(item.id)).map(item => [item.id, item]))
  for (const item of records(incoming)) {
    if (dead.has(item.id)) continue
    const previous = byId.get(item.id), content = projectContent(item)
    if (!previous) {
      byId.set(item.id, { ...item, _projectSync: { revision: optimistic ? revision(item) : 1, ...(item._projectSync?.conflictOf ? { conflictOf: item._projectSync.conflictOf, submitted: item._projectSync.submitted } : {}) } })
      continue
    }
    const oldContent = projectContent(previous)
    const history: string[] = Array.isArray(previous._projectSync?.history) ? previous._projectSync.history.filter((value: unknown) => typeof value === 'string') : []
    if (content === oldContent) continue
    if (item._projectSync?.revision !== undefined && revision(item) === revision(previous)) {
      byId.set(item.id, { ...item, _projectSync: { ...previous._projectSync, revision: revision(previous) + (optimistic ? 0 : 1), history: [...history, oldContent] } })
      continue
    }
    // Historical content from the current base revision is an intentional
    // revert; only stale snapshots/retries should be discarded by history.
    if (history.includes(content)) continue
    // A legacy edit without a base revision is ambiguous too. Preserve it in
    // the same way as a concurrent edit; never reinterpret it as a new truth.
    if ([...byId.values()].some(value => value._projectSync?.conflictOf === item.id && value._projectSync?.submitted === content)) continue
    const base = `${item.id}~conflict-${shortHash(content)}`
    let id = base, suffix = 1
    while (byId.has(id)) id = `${base}-${suffix++}`
    if (dead.has(id)) continue // retry must not restore a conflict the user deleted
    byId.set(id, { ...item, id, name: `${String(item.name || 'Project')} (conflicting edit)`, _projectSync: { revision: optimistic ? 0 : 1, conflictOf: item.id, submitted: content } })
  }
  return [...byId.values()]
}

/** Return both documents for one atomic commit, including immediate deletion. */
export function projectWrites(values: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const keys = projectKeys(key)
  if (!keys) throw new Error('Not a project key')
  const [collection, tombstones] = keys
  const deleted = key === tombstones
    ? [...new Set([...projectDeletedIds(values[tombstones], true), ...projectDeletedIds(value)])]
    : projectDeletedIds(values[tombstones], true)
  const projects = mergeProjectRecords(values[collection], key === collection ? value : [], deleted)
  return {
    [collection]: encodeLike(projects, key === collection ? value : values[collection] ?? ''),
    [tombstones]: encodeLike(deleted, key === tombstones ? value : values[tombstones] ?? ''),
  }
}
