import { projectKeys, projectWrites, ProjectDataValidationError } from '../shared/projectMerge'
import { CloudflareStore, CloudflareConflict } from './_cloudflareStore'
import { writeCloudflareChatData } from './_cloudflareChat'
import { ChatDataValidationError } from './_chatMerge'
import { CloudflareTaskLedger } from './_cloudflareTaskLedger'

function array(value: unknown): any[] | null {
  for (let n = 0; n < 6 && typeof value === 'string'; n++) { try { value = JSON.parse(value) } catch { return null } }
  return Array.isArray(value) ? value : null
}
const json = (value: unknown) => JSON.stringify(value ?? null)
const encodeLike = (value: unknown, original: unknown) => typeof original === 'string' ? JSON.stringify(value) : value

/** Account documents use the same revision for snapshots, chat tombstones and
 * updates from the other clients. No read/write SQL transaction is simulated. */
export class CloudflareDataStore {
  constructor(readonly store: CloudflareStore) {}
  async read(owner: string, keys: string[]) {
    const saved = await this.store.readDocuments(owner, keys)
    return { revision: saved.revision, values: Object.fromEntries(saved.entries.map(item => [item.key, JSON.parse(item.value)])) }
  }
  async load(owner: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const inventory = await this.store.batch([
        { sql: 'SELECT revision FROM nalu_store_revisions WHERE scope=?', params: ['user:' + owner] },
        { sql: 'SELECT key FROM nalu_user_data WHERE user_id=? ORDER BY key', params: [owner] },
      ])
      const revision = inventory.results[0].results[0]?.revision || '', keys = inventory.results[1].results.map(row => String(row.key))
      const data: Record<string, unknown> = {}; let changed = false
      for (let offset = 0; offset < keys.length; offset += 20) {
        const page = await this.read(owner, keys.slice(offset, offset + 20))
        if (page.revision !== revision) { changed = true; break }
        Object.assign(data, page.values)
      }
      if (!changed) return data
    }
    throw new CloudflareConflict('Saved data changed during loading. Please try again.')
  }
  async write(owner: string, key: string, value: unknown): Promise<Record<string, unknown> | void> {
    if (key === 'nalu-chats' || key === 'nalu-deleted-chats') return writeCloudflareChatData(this.store, owner, key, value)
    // Preserve completed node outputs before a fresh browser run can replace
    // its flow snapshot. The ledger retains the first run's finished status.
    if (key === 'nalu-agent-flows') for (const flow of array(value) || []) await new CloudflareTaskLedger(this.store).preserveFlowResults(owner, flow)
    for (let attempt = 0; attempt < 5; attempt++) {
      const keys = projectKeys(key)
      const saved = await this.read(owner, keys || [key])
      const changed = keys ? projectWrites(saved.values, key, value) : { [key]: value }
      try {
        await this.store.commitDocuments(owner, saved.revision, Object.entries(changed).map(([name, next]) => ({ key: name, value: json(next) })))
        return keys ? changed : undefined
      } catch (error) { if (!(error instanceof CloudflareConflict) || attempt === 4) throw error }
    }
  }
  async remove(owner: string, key: string): Promise<void> {
    if (projectKeys(key)) throw new ProjectDataValidationError('Delete projects by ID. Project tombstones cannot be removed.')
    for (let attempt = 0; attempt < 5; attempt++) {
      const saved = await this.read(owner, [key]), revision = crypto.randomUUID(), scope = 'user:' + owner
      const result = await this.store.batch([
        { sql: "INSERT INTO nalu_store_revisions(scope,revision) VALUES(?,'') ON CONFLICT DO NOTHING", params: [scope] },
        { sql: 'UPDATE nalu_store_revisions SET revision=? WHERE scope=? AND revision=? RETURNING revision', params: [revision, scope, saved.revision] },
        { sql: `UPDATE nalu_document_parts SET touched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE owner=? AND sha256 IN (SELECT h.value FROM nalu_document_manifests m,json_each(m.parts) h WHERE m.owner=? AND m.key=?) AND EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)`, params: [owner, owner, key, scope, revision] },
        { sql: 'DELETE FROM nalu_user_data WHERE user_id=? AND key=? AND EXISTS(SELECT 1 FROM nalu_store_revisions WHERE scope=? AND revision=?)', params: [owner, key, scope, revision] },
      ])
      if (result.results[1].results.length) return
    }
    throw new CloudflareConflict('Saved data changed before removal. Please try again.')
  }
  async appendTurn(owner: string, turn: { chatId: string; turnId: string; user: string; assistant: string; source: string }): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const saved = await this.read(owner, ['nalu-chats', 'nalu-deleted-chats'])
      const stored = saved.values['nalu-chats'], chats = stored === undefined ? [] : array(stored)
      if (!chats) throw new ChatDataValidationError('Saved conversation history could not be read.')
      if ((array(saved.values['nalu-deleted-chats']) || []).some(item => String(item?.id ?? item) === turn.chatId)) return false
      const previous = chats.find(item => item?.id === turn.chatId), messages = Array.isArray(previous?.messages) ? previous.messages.filter((item: any) => item && typeof item === 'object') : []
      if (messages.some((item: any) => item.id === turn.turnId + ':user')) return true
      const now = Date.now(), chat = { ...previous, id: turn.chatId, title: previous?.title || turn.user.slice(0, 80), source: turn.source, createdAt: previous?.createdAt || now, updatedAt: now, messages: [...messages, { id: turn.turnId + ':user', role: 'user', content: turn.user }, { id: turn.turnId + ':assistant', role: 'assistant', content: turn.assistant }] }
      const next = [chat, ...chats.filter(item => item?.id !== turn.chatId)]
      try { await this.store.commitDocuments(owner, saved.revision, [{ key: 'nalu-chats', value: json(encodeLike(next, stored ?? '')) }]); return true }
      catch (error) { if (!(error instanceof CloudflareConflict) || attempt === 4) throw error }
    }
    return false
  }
}
