import { Router, Request, Response } from 'express'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const BASE_PROMPT = `You are Nalu, an open-source AI coding assistant operating in a web workspace.
Be concise, technical, and direct. When discussing code, reference file paths with backticks.`

interface PromptContext {
  repo?: string
  githubConnected?: boolean
  origin?: { owner: string; repo: string } | null
  branch?: string | null
}

function buildSystemPrompt(ctx: PromptContext): string {
  const lines: string[] = [BASE_PROMPT]
  if (ctx.repo) {
    lines.push(`The user is currently working in the \`${ctx.repo}\` folder.`)
  }
  if (ctx.branch) {
    lines.push(`Current branch: \`${ctx.branch}\`.`)
  }
  if (ctx.githubConnected) {
    lines.push(
      'The user has connected GitHub in this session. You may suggest concrete `git` and `gh` CLI commands they can run locally — assume they are authenticated to push, pull, and operate on the origin remote. When suggesting CLI commands, format them in fenced bash blocks.',
    )
    if (ctx.origin) {
      lines.push(`Origin remote: \`${ctx.origin.owner}/${ctx.origin.repo}\`.`)
    }
  } else {
    lines.push(
      'The user has not connected GitHub yet. If they need to push or commit, gently mention they can click the Commit button to connect.',
    )
  }
  return lines.join('\n')
}

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4-5'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: 'OPENROUTER_API_KEY not set' })
    return
  }

  const { messages, model, repo, githubConnected, origin, branch } = req.body ?? {}
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
    ...messages.filter((m: ChatMessage) => m && typeof m.content === 'string' && m.role !== 'system'),
  ]

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

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
          const delta = json?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            send('delta', { text: delta })
          }
          const finish = json?.choices?.[0]?.finish_reason
          if (finish) send('finish', { reason: finish })
        } catch {
          // skip malformed line
        }
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
})

export default router
