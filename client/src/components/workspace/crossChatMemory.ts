import { contextExcerpt, contextTerms, contextText, relevance } from '../../../../shared/contextSelection'

interface StoredMsg { role?: string; content?: unknown; email?: unknown; doc?: unknown }
interface StoredChat { id?: string; title?: string; messages?: StoredMsg[]; createdAt?: number; updatedAt?: number }
const parse = (key: string): unknown => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null } }
const signature = (messages?: StoredMsg[]) => contextText(messages?.find(m => m.role === 'user')?.content).replace(/\s+/g, ' ').trim()

/** All stored chats participate in relevance ranking, including older threads.
 * No message-count cache: editing a fact without adding a turn must take effect. */
export function buildChatMemory(currentMessages: StoredMsg[]): string {
  const saved = parse('nalu-chats')
  if (!Array.isArray(saved)) return ''
  const tombstones = parse('nalu-deleted-chats')
  const deleted = new Set((Array.isArray(tombstones) ? tombstones : []).map(v => typeof v === 'string' ? v : v?.id))
  const query = contextTerms(currentMessages.filter(m => m.role === 'user').slice(-3).map(m => contextText(m.content)).join(' '))
  const current = signature(currentMessages)
  const rows = (saved as StoredChat[]).flatMap(chat => {
    if (!chat || deleted.has(chat.id) || (current && signature(chat.messages) === current)) return []
    const text = (Array.isArray(chat.messages) ? chat.messages : []).map(m => {
      const content = contextText(m.content)
      const draft = m.email || m.doc
      return `${m.role === 'user' ? 'User stated' : 'Assistant draft (unverified)'}: ${content}${draft ? '\nSaved draft: ' + JSON.stringify(draft, (key, value) => /^(?:src|dataUrl|base64|password|token|secret)$/i.test(key) ? undefined : value) : ''}`
    }).join('\n')
    if (!text && !chat.title) return []
    const at = chat.updatedAt || chat.createdAt || 0
    return [{ chat, text, at, score: relevance((chat.title || '') + ' ' + text, query) }]
  }).sort((a, b) => b.score - a.score || b.at - a.at)
  // Unrelated recent work is useful only for an explicit continuity question;
  // always injecting it contaminates new briefs with old project/client names.
  const continuity = /\b(last time|previous (?:chat|conversation)|recent(?:ly)?|what (?:did|have) we|where (?:were|did) we)\b/i.test(currentMessages.map(m => contextText(m.content)).slice(-1)[0] || '')
  const selected = (continuity ? [...rows].sort((a, b) => b.at - a.at) : rows.filter(r => r.score > 0)).slice(0, 6)
  const budget = Math.min(1700, Math.floor(5400 / Math.max(1, selected.length)))
  return selected.sort((a, b) => a.at - b.at).map(r => JSON.stringify({
    source: 'saved conversation', id: r.chat.id, title: r.chat.title,
    updated: r.at > 0 && Number.isFinite(r.at) ? new Date(r.at).toISOString() : null,
    excerpt: contextExcerpt(r.text, query, budget),
  })).join('\n').slice(0, 6500)
}
