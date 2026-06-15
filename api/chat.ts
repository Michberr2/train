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

// Two prompts: one when the backend can function-call (read/write/edit/list),
// and a no-tools variant that's HONEST about not being able to touch files.
// Mixing the two — claiming tools while none are wired — makes the model
// hallucinate filenames and contents, which is what was happening on the free
// HuggingFace backend.
const TOOLS_PROMPT = `You are Nalu, an open-source AI coding assistant operating in a web workspace.
Be concise, technical, and direct. When discussing code, reference file paths with backticks.

You have tools that let you read, write, edit, and list files in the user's repository. Use them whenever the user asks you to make a change. Prefer \`edit_file\` for small, targeted edits. Use \`write_file\` for new files or full rewrites. Always read a file before editing it unless you are creating it. After making edits, briefly summarize what you changed.`

const NO_TOOLS_PROMPT = `You are Nalu, an open-source AI assistant.
Be concise, technical, and direct. When discussing code, reference file paths with backticks.

You DO NOT have file access tools on this backend — you can't read, list, write, or edit any files on the user's machine. If the user asks you to do something that needs file access (read a file, edit code, list a directory, look at their repo), say so plainly: "I can't access files from here — paste the snippet and I'll help." Never invent filenames, directory contents, or file bodies. If the user pastes code, work from that text.`

interface PromptContext {
  repo?: string
  githubConnected?: boolean
  origin?: { owner: string; repo: string } | null
  branch?: string | null
}

function buildSystemPrompt(ctx: PromptContext, hasTools: boolean): string {
  const lines: string[] = [hasTools ? TOOLS_PROMPT : NO_TOOLS_PROMPT]
  if (ctx.repo) {
    lines.push(
      hasTools
        ? `The user is currently working in the \`${ctx.repo}\` folder.`
        // Don't claim "working in a folder" when we can't actually see it;
        // the model would otherwise hallucinate contents from the folder name.
        : `The user mentioned working in a folder called \`${ctx.repo}\` (you cannot see its contents).`,
    )
  }
  if (ctx.branch) lines.push(`Current branch: \`${ctx.branch}\`.`)
  if (ctx.githubConnected) {
    lines.push(
      'The user has connected GitHub in this session. You may suggest concrete `git` and `gh` CLI commands they can run locally.',
    )
    if (ctx.origin) {
      lines.push(`Origin remote: \`${ctx.origin.owner}/${ctx.origin.repo}\`.`)
    }
  }
  return lines.join('\n')
}

// Two OpenAI-compatible providers, used in order of preference:
// 1) HuggingFace Router (HUGGINGFACE_API_TOKEN) — free/cheap, default
// 2) OpenRouter (OPENROUTER_API_KEY) — fallback if HF token missing
// Either one can be overridden via OPENROUTER_MODEL / HF_MODEL env vars.
//
// Default HF model is Llama 3.3 70B via Novita — that combo DOES support
// function calling (verified by probing the live router). The earlier
// 3.1-8B default did not, which is why Dashboard's tools were getting
// rejected. 70B has the side benefit of much better tool-use reasoning.
const HF_DEFAULT_MODEL = process.env.HF_MODEL || 'meta-llama/Llama-3.3-70B-Instruct:novita'
const OPENROUTER_DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5'

interface ChatBackend {
  url: string
  apiKey: string
  defaultModel: string
  referer: string
  title: string
  /** false = backend's free model can't function-call; we drop `tools` from the
   *  outbound request and let the model just chat. (Otherwise Novita Llama
   *  returns 400 "model features function calling not support".) */
  supportsTools: boolean
}

function pickBackend(): ChatBackend | null {
  const hfKey = process.env.HUGGINGFACE_API_TOKEN
  if (hfKey) {
    // Llama 3.3 70B on Novita supports tool calls. If you override HF_MODEL
    // to a model that DOESN'T (e.g. the old 3.1-8B), also set
    // HF_DISABLE_TOOLS=1 to fall back to plain-prose mode.
    const disableTools = String(process.env.HF_DISABLE_TOOLS || '').toLowerCase() === '1'
    return {
      url: 'https://router.huggingface.co/v1/chat/completions',
      apiKey: hfKey,
      defaultModel: HF_DEFAULT_MODEL,
      referer: 'https://n4lu.com',
      title: 'Nalu',
      supportsTools: !disableTools,
    }
  }
  const orKey = process.env.OPENROUTER_API_KEY
  if (orKey) {
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: orKey,
      defaultModel: OPENROUTER_DEFAULT_MODEL,
      referer: 'https://n4lu.ai',
      title: 'Nalu Workspace',
      supportsTools: true,
    }
  }
  return null
}

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
  const backend = pickBackend()
  if (!backend) {
    res.status(500).json({ error: 'No chat backend configured (set HUGGINGFACE_API_TOKEN or OPENROUTER_API_KEY)' })
    return
  }

  const { messages, model, repo, githubConnected, origin, branch, tools, tool_choice } = req.body ?? {}
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' })
    return
  }

  // Backend's tool support drives the system prompt — claiming tools when we
  // can't deliver them is what makes the model hallucinate file contents.
  const effectiveTools = backend.supportsTools && Array.isArray(tools) && tools.length > 0
  const fullMessages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(
        {
          repo: typeof repo === 'string' ? repo : undefined,
          githubConnected: !!githubConnected,
          origin: origin && typeof origin === 'object' && origin.owner && origin.repo ? origin : null,
          branch: typeof branch === 'string' ? branch : null,
        },
        effectiveTools,
      ),
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
  // Critical: without flushHeaders, Vercel's Node runtime buffers writes
  // until the function exits, so the client sees nothing until the very
  // end — looks like the chat is hung. Flushing makes the SSE deltas
  // actually stream as they arrive.
  res.flushHeaders?.()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const controller = new AbortController()
  res.on('close', () => controller.abort())

  try {
    const upstream = await fetch(backend.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${backend.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': backend.referer,
        'X-Title': backend.title,
      },
      body: JSON.stringify({
        model: model || backend.defaultModel,
        // Tool messages reference tool calls the model made on a previous
        // turn — without those calls in history, the backend rejects the
        // request. Strip them along with the orphaned assistant tool_calls
        // when the backend can't function-call, so the model still sees the
        // user's question and replies in plain prose.
        messages: backend.supportsTools
          ? fullMessages
          : fullMessages
              .filter((m) => m.role !== 'tool')
              .map((m) =>
                m.role === 'assistant' && m.tool_calls
                  ? { role: m.role, content: m.content ?? '' }
                  : m,
              ),
        stream: true,
        ...(backend.supportsTools && Array.isArray(tools) && tools.length > 0
          ? { tools, tool_choice: tool_choice ?? 'auto' }
          : {}),
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
