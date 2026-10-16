import { chatComplete, type CompleteOpts } from './_llm'
import { readProviderStream } from './_chatStream'

// Emit only the string after a conversation discriminator, never routing fields.
// An incomplete JSON escape stays buffered until its full character arrives.
export function conversationPrefix(raw: string, maxChars = 1000): string {
  const match = raw.match(/^\s*\{\s*"type"\s*:\s*"conversation"\s*,\s*"reply"\s*:\s*"/)
  if (!match) return ''
  let encoded = '', decoded = ''
  for (let i = match[0].length; i < raw.length; i++) {
    const c = raw[i]
    if (c === '"') break
    encoded += c
    if (c === '\\') {
      if (++i >= raw.length) break
      encoded += raw[i]
      if (raw[i] === 'u') {
        if (i + 4 >= raw.length) break
        encoded += raw.slice(i + 1, i + 5); i += 4
      }
    }
    try { decoded = JSON.parse('"' + encoded + '"') } catch { break }
  }
  return decoded.replace(/[\uD800-\uDBFF]$/, '').trim().slice(0, maxChars)
}

// Voice uses the configured fast provider. Keep the general completion helper
// and its other callers unchanged, and never retry after exposing spoken text.
export function voiceStreamCompletion(onText: (text: string) => void, signal: AbortSignal, maxChars = 1000): typeof chatComplete {
  let first = true, emitted = ''
  return async (messages, opts: CompleteOpts = {}) => {
    if (!first) {
      if (emitted) throw new Error('The voice reply was interrupted. Please continue.')
      return chatComplete(messages, { ...opts, signal })
    }
    first = false
    const provider = opts.providers?.[0]
    if (!provider) return chatComplete(messages, { ...opts, signal })
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const timer = setTimeout(cancel, opts.timeoutMs || 5000)
    try {
      const response = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model, messages: [...messages, {
          role: 'system', content: 'For a conversation answer, output type first, then reply: {"type":"conversation","reply":"..."}. Start the reply with one short useful sentence. Keep all other routing rules unchanged.',
        }], stream: true, max_tokens: opts.maxTokens || 500, temperature: 0,
          response_format: { type: 'json_object' },
          ...(/generativelanguage\.googleapis|inkling/i.test(provider.base + provider.model) ? { reasoning_effort: opts.reasoningEffort || 'none' } : {}),
        }),
      })
      if (!response.ok || !response.body) throw new Error('Voice connection unavailable. Please try again.')
      if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
        const data = await response.json()
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string') throw new Error('The voice reply was interrupted. Please continue.')
        return content
      }
      let raw = '', finished = false
      await readProviderStream(response.body, message => {
        if (controller.signal.aborted) throw new Error('Voice conversation ended.')
        const choice = message?.choices?.[0]
        if (choice?.finish_reason === 'stop') finished = true
        const chunk = choice?.delta?.content
        if (typeof chunk !== 'string') return
        raw += chunk
        if (raw.length > 12000) throw new Error('Voice reply exceeded its limit.')
        const prefix = conversationPrefix(raw, maxChars)
        if (!prefix.startsWith(emitted)) throw new Error('Voice reply changed unexpectedly.')
        const delta = prefix.slice(emitted.length)
        if (delta) { emitted = prefix; onText(delta) }
      })
      if (!finished || controller.signal.aborted) throw new Error('The voice reply was interrupted. Please continue.')
      if (emitted) {
        const parsed = JSON.parse(raw)
        if (parsed.type !== 'conversation' || typeof parsed.reply !== 'string' || !parsed.reply.startsWith(emitted)) throw new Error('The voice reply was interrupted. Please continue.')
      }
      return raw
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
  }
}
