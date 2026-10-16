import { requestChat } from './chatRequest'
// Streaming chat client for the Nalu workspace. Talks to /api/chat (OpenRouter
// under the hood), decodes its SSE events (`delta`, `tool_call_delta`, `finish`,
// `done`, `error`), and supports the tool-calling agent loop.

// A user message can carry text + images (OpenAI vision parts). /api/chat routes
// any message containing an image part to the Nalu Vision model.
import { getModelSettings } from '../../lib/naluSettings'
import { buildChatMemory } from './crossChatMemory'
import { readChatStream } from './chatStream'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
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

// Some models (notably GLM) sometimes emit a tool call as PLAIN TEXT (a JSON
// blob in the content) instead of the structured tool_calls field — a known
// serving-parser gap. This recovers those: it finds tool-call-shaped JSON in the
// text and converts it to real ToolCalls (only for names we actually expose, so
// a normal JSON answer is never mistaken for a call).
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k]
  return undefined
}
function asToolCall(o: unknown, i: number, valid?: Set<string>): ToolCall | null {
  if (!o || typeof o !== 'object') return null
  const obj = o as Record<string, unknown>
  const name = pick(obj, ['name', 'function', 'tool', 'tool_name', 'action', 'recipient_name'])
  if (typeof name !== 'string' || !name) return null
  const clean = name.replace(/^functions[.:]/, '').trim()
  if (valid && valid.size && !valid.has(clean)) return null
  const args = pick(obj, ['arguments', 'params', 'parameters', 'args', 'input', 'action_input', 'query'])
  const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  return { id: `txt_${i}_${clean}`, type: 'function', function: { name: clean, arguments: argStr } }
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Find top-level {…} JSON objects ANYWHERE in text (brace-balanced, string-aware),
// so bare tool-call JSON the model drops mid-sentence is caught — not just blocks
// at the very start. Returns each object's raw substring.
export function findJsonObjects(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0
      let inStr = false
      let esc = false
      let j = i
      for (; j < text.length; j++) {
        const ch = text[j]
        if (inStr) {
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
        } else if (ch === '"') inStr = true
        else if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            out.push(text.slice(i, j + 1))
            break
          }
        }
      }
      i = j + 1
    } else i++
  }
  return out
}

// Parse the args from a tool call's bracketed/quoted payload into a flat map.
// Handles JSON `{…}`, a single quoted positional string, and `key="v"` kwargs.
function parseToolArgs(inside: string, primary: string): Record<string, string> {
  const args: Record<string, string> = {}
  const s = inside.trim()
  if (!s) return args
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>
      for (const [k, v] of Object.entries(o)) args[k] = typeof v === 'string' ? v : JSON.stringify(v)
      return args
    } catch {
      /* fall through */
    }
  }
  if (/^["'][\s\S]*["']$/.test(s)) {
    args[primary] = s.slice(1, -1)
    return args
  }
  const kw = [...s.matchAll(/(\w+)\s*[=:]\s*["']([^"']*)["']/g)]
  if (kw.length) {
    for (const k of kw) args[k[1]] = k[2]
    return args
  }
  args[primary] = s.replace(/^["']|["']$/g, '')
  return args
}

/** True if a parsed object is shaped like a tool/function call (not just any
 * object with a "name"). Either an explicit call key, or name + an args bag. */
export function isToolCallShape(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false
  const obj = o as Record<string, unknown>
  if (['function', 'tool', 'tool_name', 'recipient_name'].some((k) => typeof obj[k] === 'string')) return true
  if (typeof obj.name === 'string' && (obj.arguments !== undefined || obj.params !== undefined || obj.parameters !== undefined)) return true
  return false
}
function primaryArg(spec: ToolSpec): string {
  const p = (spec.function.parameters || {}) as { required?: unknown; properties?: Record<string, unknown> }
  if (Array.isArray(p.required) && typeof p.required[0] === 'string') return p.required[0]
  const props = p.properties && typeof p.properties === 'object' ? Object.keys(p.properties) : []
  return props[0] || 'query'
}

/**
 * Recover tool calls a model emitted as PLAIN TEXT instead of the structured
 * tool_calls field (a known serving-parser gap — GLM emits JSON, DeepSeek emits
 * <tool_name>…</tool_name> tags). Returns the recovered calls AND the text with
 * the call syntax stripped out (so any preamble like "Let me research…" stays).
 */
export function recoverToolCalls(text: string, tools: ToolSpec[]): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = []
  if (!text) return { calls, cleaned: text }
  const argFor = new Map(tools.map((t) => [t.function.name, primaryArg(t)]))
  const validNames = new Set(argFor.keys())
  let cleaned = text

  // 0) Function-call XML: <invoke name="TOOL"><parameter name="P">V</parameter></invoke>
  //    Handles canonical, garbled (tool name landed in the attribute/prose), and
  //    unclosed (streaming) variants, plus the antml: namespace.
  if (/<\s*\/?\s*(?:antml:)?(?:invoke|parameter)\b/i.test(cleaned)) {
    const invokeRe = /<\s*(?:antml:)?invoke\b[^>]*?\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)(?:<\s*\/\s*(?:antml:)?invoke\s*>|$)/gi
    const blocks: { raw: string; idx: number; invName: string; body: string }[] = []
    let im: RegExpExecArray | null
    while ((im = invokeRe.exec(cleaned))) blocks.push({ raw: im[0], idx: im.index, invName: im[1].trim(), body: im[2] })
    for (const blk of blocks) {
      const params: Record<string, string> = {}
      const pRe = /<\s*(?:antml:)?parameter\b[^>]*?\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)(?:<\s*\/\s*(?:antml:)?parameter\s*>|$)/gi
      let pm: RegExpExecArray | null
      while ((pm = pRe.exec(blk.body))) params[pm[1].trim()] = pm[2].replace(/<[^>]*>/g, '').trim()
      let tool = validNames.has(blk.invName) ? blk.invName : ''
      if (!tool) {
        // garbled: the real tool name isn't the invoke attribute — use the
        // nearest valid tool name mentioned in the text before this block.
        const before = cleaned.slice(0, blk.idx)
        let bestIdx = -1
        for (const n of validNames) {
          const i = before.lastIndexOf(n)
          if (i > bestIdx) {
            bestIdx = i
            tool = n
          }
        }
        if (!tool) tool = validNames.has('web_search') ? 'web_search' : [...validNames][0]
      }
      const primary = argFor.get(tool) || 'query'
      const args: Record<string, string> = Object.keys(params).length ? params : {}
      if (!Object.keys(args).length) {
        const val = blk.body.replace(/<[^>]*>/g, '').trim()
        if (val) args[primary] = val
      }
      if (Object.keys(args).length && validNames.has(tool)) {
        calls.push({ id: `txt_${calls.length}_${tool}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } })
      }
      cleaned = cleaned.split(blk.raw).join(' ')
    }
    // Strip any orphan invoke/parameter tags left by malformed output.
    cleaned = cleaned.replace(/<\s*\/?\s*(?:antml:)?(?:invoke|parameter)\b[^>]*>/gi, '').replace(/[ \t]{2,}/g, ' ').trim()
  }

  // 1) XML-tag style: <tool_name>inner</tool_name> (or unclosed → to end).
  for (const [name, arg] of argFor) {
    const re = new RegExp(`<${escapeRe(name)}>\\s*([\\s\\S]*?)\\s*(?:</${escapeRe(name)}>|$)`, 'i')
    const m = re.exec(cleaned)
    if (m && m[1].trim()) {
      calls.push({ id: `txt_${calls.length}_${name}`, type: 'function', function: { name, arguments: JSON.stringify({ [arg]: m[1].trim() }) } })
      cleaned = cleaned.replace(m[0], '').trim()
    }
  }

  // 2) JSON style — fenced ```json … ``` or a bare {…}/[…] object.
  if (cleaned.includes('{')) {
    const blocks: { raw: string; body: string }[] = []
    const fence = /```(?:json|tool_call|tool|function)?\s*([\s\S]*?)```/gi
    let fm: RegExpExecArray | null
    while ((fm = fence.exec(cleaned))) blocks.push({ raw: fm[0], body: fm[1].trim() })
    const t = cleaned.trim()
    if (!blocks.length && (t.startsWith('{') || t.startsWith('['))) blocks.push({ raw: t, body: t })
    for (const blk of blocks) {
      let parsed: unknown
      try {
        parsed = JSON.parse(blk.body)
      } catch {
        continue
      }
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      let any = false
      for (const o of arr) {
        const tc = asToolCall(o, calls.length, validNames)
        if (tc) {
          calls.push(tc)
          any = true
        }
      }
      if (any) cleaned = cleaned.replace(blk.raw, '').trim()
    }

    // 3) Bare JSON objects ANYWHERE (the model drops `{ "function": … }` mid-text
    //    without fences). Brace-balanced scan so they're recovered + stripped too.
    for (const raw of findJsonObjects(cleaned)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      let any = false
      for (const o of arr) {
        const tc = asToolCall(o, calls.length, validNames)
        if (tc) {
          calls.push(tc)
          any = true
        }
      }
      if (any) cleaned = cleaned.replace(raw, '').trim()
    }
  }

  // 4) Name-prefixed calls in ANY bracketing the model invents:
  //    name("q") | name(key="v") | name{"query":"q"} | name "q"  — optionally
  //    preceded by `tool_call`/`function_call`/`invoke`. Brace/paren/quote aware.
  for (const [name, primary] of argFor) {
    const nameRe = new RegExp(`\\b${escapeRe(name)}\\b`, 'g')
    let nm: RegExpExecArray | null
    while ((nm = nameRe.exec(cleaned))) {
      let k = nm.index + name.length
      while (k < cleaned.length && /\s/.test(cleaned[k])) k++
      const opener = cleaned[k]
      let end = -1
      let inside = ''
      if (opener === '(' || opener === '{') {
        const close = opener === '(' ? ')' : '}'
        let depth = 0
        let inStr: string | false = false
        let esc = false
        let j = k
        for (; j < cleaned.length; j++) {
          const ch = cleaned[j]
          if (inStr) {
            if (esc) esc = false
            else if (ch === '\\') esc = true
            else if (ch === inStr) inStr = false
          } else if (ch === '"' || ch === "'") inStr = ch
          else if (ch === opener) depth++
          else if (ch === close) {
            depth--
            if (depth === 0) {
              j++
              break
            }
          }
        }
        if (depth !== 0) continue // still streaming / unbalanced — leave it
        end = j
        inside = opener === '{' ? cleaned.slice(k, end) : cleaned.slice(k + 1, end - 1)
      } else if (opener === '"' || opener === "'") {
        let j = k + 1
        let esc = false
        let closed = false
        for (; j < cleaned.length; j++) {
          const ch = cleaned[j]
          if (esc) esc = false
          else if (ch === '\\') esc = true
          else if (ch === opener) {
            closed = true
            break
          }
        }
        if (!closed) continue
        end = j + 1
        inside = cleaned.slice(k + 1, j)
      } else {
        continue // bare mention in prose, not a call
      }
      const args = parseToolArgs(inside, primary)
      if (!Object.keys(args).length) continue
      let start = nm.index
      const pre = cleaned.slice(Math.max(0, start - 16), start)
      const km = pre.match(/(?:tool_call|function_call|invoke)[\s:]*$/i)
      if (km) start -= km[0].length
      calls.push({ id: `txt_${calls.length}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
      cleaned = (cleaned.slice(0, start) + ' ' + cleaned.slice(end)).replace(/[ \t]{2,}/g, ' ')
      nameRe.lastIndex = start
    }
  }

  // Tidy leftover empty ```python / ``` fences after the calls were stripped.
  cleaned = cleaned.replace(/```(?:python|py|tool|json)?\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim()
  return { calls, cleaned }
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
  onReasoning?: (text: string) => void
  onError?: (message: string) => void
  onRoute?: (name: string, kind?: string) => void
  signal?: AbortSignal
}

export interface TurnResult {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  autoResearch: boolean
  error?: string
  finishReason?: string
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
  think?: number, // 0 off · 1 think · 2 ultrathink · 3 packmind
  // Agent pipelines force a specific Nalu specialist (bypasses keyword routing).
  specialist?: string,
  // Only the MAIN interactive chat turn opts into cross-chat memory — NOT helper
  // calls (captions, titles) or agent-pipeline steps, which shouldn't carry it.
  wantMemory?: boolean,
  // Per-call overrides of the user's global model settings. AutoPilot pipeline
  // steps can research current facts using just their task instruction; attached
  // records and prior outputs stay out of public search queries.
  overrides?: { webSearch?: boolean; researchPrompt?: string },
): Promise<TurnResult> {
  const { onDelta, onReasoning, onError, onRoute, signal } = handlers
  let res: Response
  try {
    res = await requestChat(JSON.stringify({ messages, model, useMemory: !!wantMemory, ...(tools && tools.length ? { tools } : {}), ...(context || {}), ...(think && think > 0 ? { think: true, thinkLevel: think } : {}), ...(specialist ? { specialist } : {}), ...(() => { const s = getModelSettings(); return { reasoning: s.reasoning, maxTokens: s.maxTokens, webSearch: overrides?.webSearch ?? s.webSearch, ...(overrides?.researchPrompt !== undefined ? { researchPrompt: overrides.researchPrompt } : {}), ...(s.systemPrompt && s.systemPrompt.trim() ? { systemPrompt: s.systemPrompt } : {}) } })(), ...(wantMemory ? (() => { try { const mem = buildChatMemory(messages); return mem ? { memory: mem } : {} } catch { return {} } })() : {}) }), signal)
  } catch {
    const error = signal?.aborted ? undefined : 'Couldn’t reach Nalu — check your connection and try again.'
    if (error) onError?.(error)
    return { text: '', reasoning: '', autoResearch: false, toolCalls: [], error }
  }
  if (!res.ok || !res.body) {
    // Human-friendly copy instead of a raw "Server 504"; the status still hints at cause.
    const msg = res.status === 429
      ? 'Nalu is receiving too many requests. Please try again shortly.'
      : res.status >= 500
        ? 'Nalu could not connect after retrying. Your request is saved; tap Retry to try again.'
        : 'Something went wrong with that request. Please try again.'
    onError?.(msg)
    return { text: '', reasoning: '', autoResearch: false, toolCalls: [], error: msg }
  }

  return readChatStream(res.body, handlers)
}
