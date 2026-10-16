// Shared retrieval for saved history and writing briefs. Keep provenance and
// later corrections; never treat a generated draft as a user statement.
export type ContextMessage = { role?: string; content?: unknown; [key: string]: unknown }
const STOP = new Set('the and that this what with have from about does your you was were can could would please tell know our for how did are make write create draft email document'.split(' '))
export function contextTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'@.-]{2,}/gu) || []).filter(t => !STOP.has(t)))]
}
export function contextText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => v && typeof v === 'object' && typeof v.text === 'string' ? v.text : '').join('\n')
  return ''
}
export function relevance(text: string, query: string[]): number {
  const lower = text.toLowerCase()
  return query.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0)
}
/** Select several passages, not just a prefix or a single best window. The tail
 * is always retained because it can retract an earlier, highly relevant fact. */
export function contextExcerpt(text: string, query: string[], budget: number): string {
  if (text.length <= budget) return text
  const size = Math.max(100, Math.floor((budget - 100) / 4))
  const chunks: { at: number; text: string; score: number }[] = []
  for (let at = 0; at < text.length; at += size) {
    const part = text.slice(at, at + size)
    chunks.push({ at, text: part, score: relevance(part, query) })
  }
  const selected = new Set([chunks[0], chunks[chunks.length - 1]])
  for (const chunk of [...chunks].sort((a, b) => b.score - a.score || b.at - a.at)) {
    if (selected.size >= 4) break
    selected.add(chunk)
  }
  let end = 0
  return [...selected].sort((a, b) => a.at - b.at).map(c => {
    const gap = c.at > end ? '\n[… omitted passage …]\n' : ''
    end = c.at + c.text.length
    return gap + c.text
  }).join('').slice(0, budget)
}
export function conversationContext(messages: ContextMessage[], prompt: string, budget = 24000): string {
  const query = contextTerms(prompt)
  const rows = messages.flatMap((m, index) => {
    if (m.role !== 'user' && m.role !== 'assistant') return []
    const text = contextText(m.content).trim()
    return text ? [{ index, role: m.role, text, score: relevance(text, query) }] : []
  })
  const selected = new Set(rows.slice(-8))
  const first = rows.find(r => r.role === 'user')
  if (first) selected.add(first)
  for (const row of [...rows].sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (selected.size >= 16) break
    if (row.score) selected.add(row)
  }
  const each = Math.max(250, Math.floor((budget - 1500) / Math.max(1, selected.size)))
  return [...selected].sort((a, b) => a.index - b.index).map(r =>
    `[Turn ${r.index + 1} · ${r.role === 'user' ? 'USER' : 'ASSISTANT DRAFT / unverified'}]\n${contextExcerpt(r.text, query, each)}`,
  ).join('\n\n').slice(0, budget)
}
