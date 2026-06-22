// Streaming chat client for the Nalu workspace. Talks to /api/chat (OpenRouter
// under the hood), decodes its SSE events (`delta`, `tool_call_delta`, `finish`,
// `done`, `error`), and supports the tool-calling agent loop.

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  // assistant tool calls / tool results (OpenAI/OpenRouter shape)
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface StreamHandlers {
  onDelta?: (text: string) => void
  onError?: (message: string) => void
  onRoute?: (name: string, kind?: string) => void
  signal?: AbortSignal
}

export interface TurnResult {
  text: string
  toolCalls: ToolCall[]
}

export interface RepoContext {
  repo?: string
  githubConnected?: boolean
  origin?: { owner: string; repo: string }
  branch?: string
}

/** Run one model turn. Streams text via onDelta and returns any tool calls. */
export async function streamChat(
  messages: WireMessage[],
  model: string | undefined,
  handlers: StreamHandlers,
  tools?: ToolSpec[],
  context?: RepoContext,
): Promise<TurnResult> {
  const { onDelta, onError, onRoute, signal } = handlers
  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model, ...(tools && tools.length ? { tools } : {}), ...(context || {}) }),
      signal,
    })
  } catch (e) {
    onError?.(e instanceof Error ? e.message : 'Network error')
    return { text: '', toolCalls: [] }
  }
  if (!res.ok || !res.body) {
    onError?.(`Server ${res.status}`)
    return { text: '', toolCalls: [] }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let event = ''
  let text = ''
  const calls: Record<number, ToolCall> = {}

  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch {
      break
    }
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        let data: { text?: string; message?: string; index?: number; id?: string; name?: string; kind?: string; arguments?: string } = {}
        try {
          data = JSON.parse(payload)
        } catch {
          /* ignore */
        }
        if (event === 'route' && typeof data.name === 'string') {
          onRoute?.(data.name, data.kind)
        } else if (event === 'delta' && typeof data.text === 'string') {
          text += data.text
          onDelta?.(data.text)
        } else if (event === 'tool_call_delta') {
          const i = data.index ?? 0
          if (!calls[i]) calls[i] = { id: data.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } }
          if (data.id) calls[i].id = data.id
          if (data.name) calls[i].function.name += data.name
          if (data.arguments) calls[i].function.arguments += data.arguments
        } else if (event === 'error') {
          onError?.(data.message || 'Error')
        }
      }
    }
  }
  return { text, toolCalls: Object.values(calls).filter((c) => c.function.name) }
}
