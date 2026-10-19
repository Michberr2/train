/** Conservative token accounting, with a safety margin for tokenizer variance.
 * This is an estimate, not a claim to have the deployed model's tokenizer. */
export function estimatedTokens(value: unknown): number {
  if (typeof value === 'string') return Math.ceil(new TextEncoder().encode(value).length / 3)
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + estimatedTokens(part) + 4, 0)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // Base64 bytes are not text tokens. Reserve a separate visual-input budget;
    // never truncate or discard an image while preserving a claim to see it.
    if (record.type === 'image_url' || record.type === 'image') return 8192
    return Object.entries(record).reduce((sum, [key, item]) => sum + estimatedTokens(key) + estimatedTokens(item) + 4, 0)
  }
  return value == null ? 1 : estimatedTokens(String(value))
}

export class ChatContextError extends Error {
  code = 'CHAT_CONTEXT_LIMIT'
  constructor() { super('This conversation exceeds the available context. Shorten large attachments or tool results, or start a new chat with the relevant information. Your latest request and earlier instructions have not been silently truncated.') }
}

type Message = { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }

/** Keep every user/system instruction and the entire current tool cycle.
 * Older assistant + tool-result exchanges are evicted atomically, oldest first.
 * Oversized protected content fails visibly instead of cutting task constraints,
 * tool JSON, source text, or images in half. */
export function budgetChatContext<T extends Message>(messages: T[], options: {
  maxOutputTokens: number; tools?: unknown; contextTokens?: number
}): { messages: T[]; estimatedInputTokens: number; removedMessages: number; inputBudget: number } {
  const configured = options.contextTokens ?? Number(process.env.NALU_CHAT_CONTEXT_TOKENS || 64000)
  const capacity = Number.isFinite(configured) ? Math.max(8192, Math.min(1_000_000, configured)) : 64000
  const inputBudget = Math.floor(capacity * 0.9) - options.maxOutputTokens - estimatedTokens(options.tools)
  const tokens = messages.map(estimatedTokens)
  let lastUser = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') { lastUser = index; break }
  }
  const retained = messages.map(() => true)
  const originalTokens = tokens.reduce((sum, count) => sum + count + 4, 0)
  let used = originalTokens
  const note = '\n\nCONTEXT COVERAGE: Some older assistant replies and their tool results were omitted to fit the context window. All user instructions and the current request/tool cycle are retained. Do not claim to recall omitted results; retrieve them again if needed.'
  const reserve = estimatedTokens(note) + 12
  if (used > inputBudget) {
    for (let i = 0; i < lastUser && used + reserve > inputBudget; i++) {
      if (messages[i].role !== 'assistant') continue
      const group = [i]
      // Tool results must remain with their generating assistant call, including
      // parallel calls. Never leave orphan result messages in a shortened record.
      while (i + 1 < lastUser && messages[i + 1].role === 'tool') group.push(++i)
      for (const index of group) { retained[index] = false; used -= tokens[index] + 4 }
    }
  }
  const removedMessages = retained.filter(value => !value).length
  if (used + (removedMessages ? reserve : 0) > inputBudget) throw new ChatContextError()
  const result = messages.filter((_, index) => retained[index])
  if (removedMessages) {
    const index = result.findIndex(message => message.role === 'system' && typeof message.content === 'string')
    if (index >= 0) result[index] = { ...result[index], content: String(result[index].content) + note }
    else throw new ChatContextError()
  }
  return { messages: result, estimatedInputTokens: estimatedTokens(result), removedMessages, inputBudget }
}
