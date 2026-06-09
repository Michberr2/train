import type { VercelRequest, VercelResponse } from '@vercel/node'

// Mirror of server/src/routes/chat.ts as a Vercel serverless function so
// /api/chat works in production. Streams OpenRouter SSE → the named-event
// SSE shape the Dashboard parses.

interface ToolCall {
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
  index?: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

const BASE_PROMPT = `You are Nalu, an open-source AI coding assistant operating in a web workspace.
Be concise, technical, and direct. When discussing code, reference file paths with backticks.

You have tools that let you read, write, edit, and list files in the user's repository. Use them whenever the user asks you to make a change. Prefer \`edit_file\` for small, targeted edits. Use \`write_file\` for new files or full rewrites. Always read a file before editing it unless you are creating it. After making edits, briefly summarize what you changed.`

interface PromptContext {
  repo?: string
  githubConnected?: boolean
  origin?: { owner: string; repo: string } | null
  branch?: string | null
}

function buildSystemPrompt(ctx: PromptContext): string {
  const lines: string[] = [BASE_PROMPT]
  if (ctx.repo) lines.push(`The user is currently working in the \`${ctx.repo}\` folder.`)
  if (ctx.branch) lines.push(`Current branch: \`${ctx.branch}\`.`)
  if (ctx.githubConnected) {
    lines.push(
      'The user has connected GitHub in this session. You may suggest concrete `git` and `gh` CLI commands they can run locally.',
    )
    if (ctx.origin) {
      lines.push(`Origin remote: \`${ctx.origin.owner}/${ctx.origin.repo}\`.`)
    }
  } else {
    lines.push('The user has not connected GitHub yet.')
  }
  return lines.join('\n')
}

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5'

export const config = {
  // Streaming on Vercel needs the Node runtime (not edge) so we can write
  // chunked SSE responses.
  runtime: 'nodejs',
  maxDuration: 60,
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'OPENROUTER_API_KEY not set' })
    return
  }

  const { messages, model, repo, githubConnected, origin, branch, tools, tool_choice } = req.body ?? {}
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' })
    return
  }

  const fullMessages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        repo: typeof repo === 'string' ? repo : undefined,
        githubConnected: !!githubConnected,
        origin: origin && typeof origin === 'object' && origin.owner && origin.repo ? origin : null,
        branch: typeof branch === 'string' ? branch : null,
      }),
    },
    ...messages.filter((m: ChatMessage) => {
      if (!m || m.role === 'system') return false
      if (m.role === 'tool') return typeof m.tool_call_id === 'string'
      if (m.role === 'assistant') return typeof m.content === 'string' || Array.isArray(m.tool_calls)
      return typeof m.content === 'string'
    }),
  ]

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://n4lu.ai',
        'X-Title': 'Nalu Workspace',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: fullMessages,
        stream: true,
        ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: tool_choice ?? 'auto' } : {}),
      }),
    })

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      send('error', { message: `Upstream ${upstream.status}: ${text.slice(0, 400)}` })
      res.end()
      return
    }

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (!raw.startsWith('data:')) continue
        const payload = raw.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload)
          const choice = json?.choices?.[0]
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) send('delta', { text: delta })
          const toolCalls = choice?.delta?.tool_calls
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              send('tool_call_delta', {
                index: tc?.index ?? 0,
                id: tc?.id,
                name: tc?.function?.name,
                arguments: tc?.function?.arguments,
              })
            }
          }
          const finish = choice?.finish_reason
          if (finish) send('finish', { reason: finish })
        } catch { /* skip malformed line */ }
      }
    }

    send('done', { ok: true })
    res.end()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      res.end()
      return
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    send('error', { message })
    res.end()
  }
}
