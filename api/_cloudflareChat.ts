import { CloudflareConflict, type CloudflareStore } from './_cloudflareStore'
import { chatDataChanges } from './_chatMerge'

/** Merge again only after a definite revision conflict. An uncertain network
 * response is surfaced so the caller can recover from the saved history. */
export async function writeCloudflareChatData(store: CloudflareStore, owner: string, key: 'nalu-chats' | 'nalu-deleted-chats', value: unknown): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const saved = await store.readDocuments(owner, ['nalu-chats', 'nalu-deleted-chats'])
    const values = Object.fromEntries(saved.entries.map(entry => [entry.key, JSON.parse(entry.value)]))
    const updates = chatDataChanges(key, value, values['nalu-chats'], values['nalu-deleted-chats'])
    try {
      await store.commitDocuments(owner, saved.revision, updates.map(update => ({ key: update.key, value: JSON.stringify(update.value) })))
      return
    } catch (error) { if (!(error instanceof CloudflareConflict) || attempt === 4) throw error }
  }
}
