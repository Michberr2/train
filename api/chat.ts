// Nalu chat backend — Vercel Node serverless function.
// Auto-routes the request to a named Nalu specialist based on the ask, streams
// the reply, and re-emits the SSE events the workspace expects (`route`,
// `delta`, `tool_call_delta`, `finish`, `done`, `error`).
//
// Specialists ("a Nalu for every market", all served by Tinker):
//   Nalu Code · Nalu Financial · Nalu Crypto · Nalu Real Estate · Nalu Legal
//   Nalu Health · Nalu Marketing · Nalu Reason · Nalu Vision · Nalu Catalina
// "Nalu Catalina" is the general fallback that covers anything else.
//
// All model/provider details live SERVER-SIDE only — the browser never sees
// them. Every specialist is env-overridable so any can point at any
// OpenAI-compatible endpoint/model (e.g. a future fine-tuned Nalu model):
//   NALU_<KIND>_BASE_URL, NALU_<KIND>_API_KEY, NALU_<KIND>_MODEL

interface ToolCall {
  id?: string
  index?: number
  function?: { name?: string; arguments?: string }
}
// content may be a plain string or an array of parts (OpenAI vision format).
type Content = string | unknown[] | null
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: Content
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

// Tinker OpenAI-compatible endpoint (the trained-model platform).
const DEFAULT_BASE =
  process.env.GLM_BASE_URL || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
const DEFAULT_KEY = process.env.GLM_API_KEY || ''

// Current Tinker catalog (June 2026). DeepSeek-V3.1 returns clean,
// instruction-style output and powers every text specialist; Nemotron
// reasons (gated) and Qwen3.5-VL handles images.
const DS = 'deepseek-ai/DeepSeek-V3.1'
const MODEL_REASONING = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16' // NVIDIA Nemotron
const MODEL_VISION = 'Qwen/Qwen3.5-397B-A17B' // Hybrid + Vision

interface Specialist {
  kind: string // env key + route id
  name: string // shown to the user (e.g. "Nalu Financial")
  model: string
  prompt: string // domain instructions layered on the base prompt
  match?: RegExp // when it claims the ask (omit for vision/general)
}

// Order matters: the first specialist whose `match` hits wins. Vision is
// chosen up front when an image is present; general is the catch-all.
const SPECIALISTS: Specialist[] = [
  {
    kind: 'code',
    name: 'Nalu Code',
    model: DS,
    prompt: 'Mode: Nalu Code — prioritize correct, idiomatic, runnable code with concise explanations.',
    match:
      /```|\b(code|coding|function|class|bug|error|stack ?trace|exception|refactor|repo|repository|debug|compile|build|deploy|typescript|javascript|python|rust|golang|java|react|node|sql|regex|api|endpoint|git|commit|pull request|diff|unit test|lint)\b/i,
  },
  {
    kind: 'crypto',
    name: 'Nalu Crypto',
    model: DS,
    prompt:
      'Mode: Nalu Crypto — deep expertise in cryptocurrency, blockchain, DeFi, and web3. Give precise analysis; add a brief note that this is educational, not financial advice.',
    match:
      /\b(crypto|cryptocurrenc(y|ies)|bitcoin|btc|ethereum|eth|solana|blockchain|web3|defi|nft|token|wallet|staking|on-?chain|altcoin|stablecoin)\b/i,
  },
  {
    kind: 'finance',
    name: 'Nalu Financial',
    model: DS,
    prompt:
      'Mode: Nalu Financial — deep expertise in markets, investing, accounting, and valuation. Give precise, well-reasoned analysis; add a brief note that this is educational, not personalized financial advice.',
    match:
      /\b(stock|stocks|invest|investing|investment|investor|portfolio|equit(y|ies)|securit(y|ies)|market|markets|trading|trader|valuation|dcf|wacc|ebit|ebitda|cogs|dividend|p\/e|pe ratio|eps|earnings|revenue|sales|gross (profit|margin)|net (income|profit)|profit|profitability|margin|income statement|balance sheet|cash ?flow|hedge|option|options|futures|forex|bond|bonds|etf|mutual fund|index fund|401k|ira|roth|pension|retirement|net worth|tax(es)?|finance|financial|accounting|depreciation|amortization|roi|return on investment|npv|net present value|present value|future value|discount rate|irr|apr|apy|compound interest|simple interest|interest rate|capital|liabilit(y|ies)|assets?|budget|expense|expenditure|salary|wage|payroll|break.?even|yield|principal|invoice|cost of goods|finance formula|financial formula)\b/i,
  },
  {
    kind: 'realestate',
    name: 'Nalu Real Estate',
    model: DS,
    prompt:
      'Mode: Nalu Real Estate — deep expertise in property, mortgages, leasing, and real-estate investing. Give precise, practical guidance.',
    match:
      /\b(real estate|property|properties|mortgage|rent|rental|landlord|tenant|lease|housing|home ?buying|appraisal|hoa|zoning|realtor|escrow|closing costs)\b/i,
  },
  {
    kind: 'legal',
    name: 'Nalu Legal',
    model: DS,
    prompt:
      'Mode: Nalu Legal — knowledgeable about law, contracts, and compliance. Be precise; add a brief note that this is general information, not legal advice.',
    match:
      /\b(legal|law|lawyer|attorney|contract|agreement|liability|lawsuit|litigation|clause|terms of service|nda|copyright|trademark|patent|compliance|regulation|statute)\b/i,
  },
  {
    kind: 'health',
    name: 'Nalu Health',
    model: DS,
    prompt:
      'Mode: Nalu Health — knowledgeable about health, medicine, nutrition, and fitness. Be careful and evidence-based; add a brief note that this is educational, not medical advice.',
    match:
      /\b(health|medical|medicine|doctor|symptom|diagnos(e|is)|disease|treatment|medication|nutrition|diet|fitness|workout|mental health|therapy|wellness)\b/i,
  },
  {
    kind: 'studio',
    name: 'Nalu Studio',
    model: DS,
    prompt:
      "Mode: Nalu Studio — Nalu's creative design studio. You help with editable vector designs, posters, social graphics, color palettes, brand guidelines, blueprints, and decks, all built from open-source tooling. When a request would be better served as a generated artifact (a palette, a brand kit, an editable canvas, a blueprint, a poster, a webpage, or a deck), say so briefly and describe what you would produce — the app turns these into real, exportable artifacts. Give concrete, opinionated design direction (specific hex colors, font pairings, layout, hierarchy); never use lorem ipsum.",
    match:
      /\b(graphic|graphics|colou?r palette|colou?r scheme|swatch|brand guidelines?|brand identity|brand kit|style guide|visual identity|moodboard|mood board|poster|flyer|social (?:post|graphic)|instagram (?:post|story)|infographic|blueprint|floor ?plan|wireframe|figma|canvas|logo concept|typography|art ?direction|graphic design)\b/i,
  },
  {
    kind: 'marketing',
    name: 'Nalu Marketing',
    model: DS,
    prompt:
      'Mode: Nalu Marketing — expert in marketing, SEO, branding, content, and growth. Give actionable, specific recommendations.',
    match:
      /\b(marketing|seo|advertis(e|ing)|ad campaign|brand(ing)?|social media|content strategy|copywriting|funnel|conversion|growth|email campaign|audience|engagement|go-to-market)\b/i,
  },
  {
    kind: 'reasoning',
    name: 'Nalu Reason',
    model: MODEL_REASONING,
    prompt: 'Mode: Nalu Reason — work carefully through hard problems and give rigorous, well-justified answers.',
    match:
      /\b(reason through|reason about|chain of thought|think step by step|prove that|proof of|theorem|derive|logic puzzle|riddle|deduce|solve for|work this out)\b/i,
  },
]

const VISION: Specialist = {
  kind: 'vision',
  name: 'Nalu Vision',
  model: MODEL_VISION,
  prompt: 'Mode: Nalu Vision — analyze any images the user shares accurately and in detail.',
}
const GENERAL: Specialist = {
  kind: 'general',
  name: 'Nalu Catalina',
  model: DS,
  prompt: '',
}

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v : undefined
}

type Backend = { base: string; key: string; model: string; gated: boolean; name: string; kind: string; prompt: string }

/** Resolve the live backend for a specialist, applying per-kind env overrides. */
function backendFor(spec: Specialist): Backend {
  const K = spec.kind.toUpperCase()
  const base = (env(`NALU_${K}_BASE_URL`) || DEFAULT_BASE).replace(/\/+$/, '')
  const key = env(`NALU_${K}_API_KEY`) || DEFAULT_KEY
  const model = env(`NALU_${K}_MODEL`) || env('NALU_DEFAULT_MODEL') || spec.model
  const gated = /nemotron|gpt-oss/i.test(model)
  return { base, key, model, gated, name: spec.name, kind: spec.kind, prompt: spec.prompt }
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some((p) => p && (p.type === 'image_url' || p.type === 'image')),
  )
}

/** Auto-rotate: pick the specialist that best fits the ask. */
function pickSpecialist(messages: ChatMessage[]): Specialist {
  if (hasImage(messages)) return VISION
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const raw = typeof lastUser?.content === 'string' ? lastUser.content : ''
  for (const s of SPECIALISTS) if (s.match && s.match.test(raw)) return s
  return GENERAL
}

const BASE_PROMPT = `You are Nalu, a helpful and knowledgeable AI assistant made by N4lu.ai (website n4lu.ai). You are an expert software engineer, but you can help with anything.

Your name is Nalu and the company/brand is Nalu / Nalu AI. NEVER refer to yourself or the company by any other name (never "Nexus", "Nexus AI", "Acme", "Assistant", etc.). When asked who you are, you are Nalu.

NEVER use emojis, emoticons, or decorative symbols of any kind — no ✅ ✓ ❌ → • ★ 🔥 🚀 etc. Use only clean, professional Markdown (headings, bold, plain "-" bullet lists). This is a hard rule.

How to respond:
- Always directly answer the user's actual question, fully and helpfully. Never deflect with generic lines like "I'm ready to help, let me know what you'd like to do" — just answer the question.
- For casual or short messages (e.g. "hi", "how are you?"), reply naturally and warmly, like a friendly expert — do not turn them into a coding prompt.
- Be concise but complete: finish your thought, and don't stop after a stub.
- You have a \`web_search\` tool and a \`fetch_url\` tool. Use \`web_search\` whenever you need current information, recent events, prices, releases, or any fact you're not fully sure of — search instead of guessing or saying you don't know. Use \`fetch_url\` to read a promising result in detail. Cite sources when you used the web.
- Format answers in clean Markdown: use ## headings, **bold**, bullet lists, and fenced code blocks where they help readability.`

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
      'The user has connected GitHub in this session. You may suggest concrete `git` and `gh` CLI commands they can run locally. When suggesting CLI commands, format them in fenced bash blocks.',
    )
    if (ctx.origin) lines.push(`Origin remote: \`${ctx.origin.owner}/${ctx.origin.repo}\`.`)
  }
  return lines.join('\n')
}

/** Flatten array (vision) content to its text parts — used when the resolved
 *  model is text-only, so image messages never crash it. */
function flattenForText(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m
    const text = (m.content as Array<{ type?: string; text?: string }>)
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
    return { ...m, content: text }
  })
}

// Marker that separates a reasoner's chain-of-thought from its final answer.
const GATE_MARKERS = ['</think>', 'assistantfinal']

/**
 * Streaming text cleaner.
 *  - Always removes <think>…</think> pairs.
 *  - When `gated`, suppresses everything before the first answer-start marker
 *    (the reasoning preamble), then streams only the final answer.
 *  - flush() MUST be called at end-of-stream: it surfaces the gated buffer (if
 *    the marker never arrived) and the small tail held back to guard against a
 *    split <think> tag — otherwise the last few chars of every reply are lost.
 */
function makeAnswerExtractor(gated: boolean) {
  let gateOpen = !gated
  let buf = ''
  let inThink = false
  let carry = ''

  const stripPairs = (input: string): string => {
    let s = carry + input
    carry = ''
    let out = ''
    for (;;) {
      if (!inThink) {
        const i = s.indexOf('<think>')
        if (i === -1) {
          const keep = Math.max(0, s.length - 7)
          out += s.slice(0, keep)
          carry = s.slice(keep)
          break
        }
        out += s.slice(0, i)
        s = s.slice(i + 7)
        inThink = true
      } else {
        const j = s.indexOf('</think>')
        if (j === -1) {
          carry = s.slice(Math.max(0, s.length - 8))
          break
        }
        s = s.slice(j + 8)
        inThink = false
      }
    }
    return out
  }

  const feed = (chunk: string): string => {
    if (gateOpen) return stripPairs(chunk)
    buf += chunk
    let idx = -1
    let mlen = 0
    for (const mk of GATE_MARKERS) {
      const k = buf.indexOf(mk)
      if (k !== -1 && (idx === -1 || k < idx)) {
        idx = k
        mlen = mk.length
      }
    }
    if (idx === -1) return '' // still in the reasoning preamble — hold output
    const after = buf.slice(idx + mlen)
    buf = ''
    gateOpen = true
    return stripPairs(after)
  }
  // End-of-stream flush: emit any held buffer + the guarded tail.
  feed.flush = (): string => {
    let out = ''
    if (!gateOpen && buf) {
      gateOpen = true
      out += stripPairs(buf)
      buf = ''
    }
    if (!inThink && carry) out += carry
    carry = ''
    return out
  }
  return feed
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }

  let body: Record<string, unknown> = {}
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}
  } catch {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { messages, repo, githubConnected, origin, branch, tools, tool_choice } = body as {
    messages?: ChatMessage[]
    repo?: string
    githubConnected?: boolean
    origin?: { owner: string; repo: string } | null
    branch?: string | null
    tools?: unknown[]
    tool_choice?: unknown
  }
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' })
    return
  }

  const spec = pickSpecialist(messages)
  const backend = backendFor(spec)
  if (!backend.key) {
    res.status(500).json({ error: 'Nalu engine is not configured.' })
    return
  }

  const sysBase = buildSystemPrompt({
    repo: typeof repo === 'string' ? repo : undefined,
    githubConnected: !!githubConnected,
    origin: origin && typeof origin === 'object' && origin.owner && origin.repo ? origin : null,
    branch: typeof branch === 'string' ? branch : null,
  })

  let fullMessages: ChatMessage[] = [
    { role: 'system', content: backend.prompt ? `${sysBase}\n\n${backend.prompt}` : sysBase },
    ...messages.filter((m) => {
      if (!m || m.role === 'system') return false
      if (m.role === 'tool') return typeof m.tool_call_id === 'string'
      if (m.role === 'assistant') return typeof m.content === 'string' || Array.isArray(m.tool_calls)
      return typeof m.content === 'string' || Array.isArray(m.content)
    }),
  ]

  // Only the vision route can take image parts; flatten them everywhere else.
  if (backend.kind !== 'vision') fullMessages = flattenForText(fullMessages)

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  // Tell the client which Nalu specialist took the ask (e.g. "Nalu Financial").
  send('route', { kind: backend.kind, name: backend.name })

  const extract = makeAnswerExtractor(backend.gated)

  try {
    const payload: Record<string, unknown> = {
      model: backend.model,
      messages: fullMessages,
      stream: true,
      max_tokens: 8192,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools, tool_choice: tool_choice ?? 'auto' } : {}),
    }

    const upstream = await fetch(`${backend.base}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(backend.key ? { Authorization: `Bearer ${backend.key}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
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
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (!raw.startsWith('data:')) continue
        const payloadLine = raw.slice(5).trim()
        if (!payloadLine || payloadLine === '[DONE]') continue
        try {
          const json = JSON.parse(payloadLine)
          const choice = json?.choices?.[0]
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            const visible = extract(delta)
            if (visible) send('delta', { text: visible })
          }
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
        } catch {
          // skip malformed line
        }
      }
    }
    const tail = extract.flush()
    if (tail) send('delta', { text: tail })
    send('done', { ok: true })
    res.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    send('error', { message })
    res.end()
  }
}
