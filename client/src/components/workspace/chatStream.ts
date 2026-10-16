import type { StreamHandlers, ToolCall, TurnResult } from './agentApi'

/** Decode complete SSE events, including frames split across network chunks. */
export async function readChatStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<TurnResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const { signal, onDelta, onReasoning, onRoute, onError } = handlers
  let buffer = '', event = '', text = '', reasoning = ''
  let dataLines: string[] = []
  let complete = false, autoResearch = false
  let error: string | undefined, finishReason: string | undefined
  const calls = new Map<number, ToolCall>()
  const fail = (message: string) => {
    if (!error && !signal?.aborted) { error = message; onError?.(message) }
  }
  const dispatch = () => {
    const payload = dataLines.join('\n')
    const kind = event
    event = ''; dataLines = []
    if (!payload || complete) return
    if (payload === '[DONE]') { complete = true; return }
    let data: Record<string, unknown>
    try { data = JSON.parse(payload) } catch { fail('Nalu sent an unreadable response. Please retry.'); return }
    if (!data || typeof data !== 'object') return
    if (kind === 'done') {
      if (data.ok === false) fail(typeof data.message === 'string' ? data.message : 'Nalu could not complete this response. Please retry.')
      complete = true
    } else if (kind === 'finish' && typeof data.reason === 'string') {
      finishReason = data.reason
    } else if (kind === 'error') {
      fail(typeof data.message === 'string' ? data.message : 'Nalu could not complete this response. Please retry.')
    } else if (kind === 'route' && typeof data.name === 'string') {
      autoResearch ||= data.autoResearch === true
      onRoute?.(data.name, typeof data.kind === 'string' ? data.kind : undefined)
    } else if (kind === 'reasoning' && typeof data.text === 'string') {
      reasoning += data.text; onReasoning?.(data.text)
    } else if (kind === 'delta' && typeof data.text === 'string') {
      text += data.text; onDelta?.(data.text)
    } else if (kind === 'tool_call_delta') {
      const index = typeof data.index === 'number' && Number.isInteger(data.index) && data.index >= 0 ? data.index : 0
      const call = calls.get(index) || { id: `call_${index}`, type: 'function' as const, function: { name: '', arguments: '' } }
      if (typeof data.id === 'string' && data.id) call.id = data.id
      if (typeof data.name === 'string') call.function.name += data.name
      if (typeof data.arguments === 'string') call.function.arguments += data.arguments
      calls.set(index, call)
    }
  }
  const line = (value: string) => {
    if (value === '') { dispatch(); return }
    if (value.startsWith(':')) return // keepalive
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    const valuePart = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = valuePart
    else if (field === 'data') dataLines.push(valuePart)
  }
  const consume = (flush = false) => {
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== '\r' && buffer[i] !== '\n') continue
      if (!flush && buffer[i] === '\r' && i === buffer.length - 1) break
      line(buffer.slice(start, i))
      if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++
      start = i + 1
    }
    buffer = buffer.slice(start)
    if (flush && buffer) { line(buffer); buffer = '' }
  }
  // Cancel the reader even when the provided stream does not itself observe fetch's signal.
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (!complete && !signal?.aborted) {
      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode(); consume(true); dispatch(); break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      consume()
    }
    if (!complete && !signal?.aborted && !error) {
      fail(text.trim() ? 'The connection dropped — this answer may be incomplete. Tap Retry to finish it.' : 'The connection dropped before Nalu could answer. Please try again.')
    }
  } catch {
    fail(text.trim() ? 'The connection dropped — this answer may be incomplete. Tap Retry to finish it.' : 'The connection dropped before Nalu could answer. Please try again.')
  } finally {
    signal?.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return {
    text, reasoning, autoResearch, error, finishReason,
    // Partial arguments must never become an executable action after a failed stream.
    toolCalls: complete && !error && !signal?.aborted
      ? [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call).filter((call) => call.function.name)
      : [],
  }
}
