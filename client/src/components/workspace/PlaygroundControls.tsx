// Tinker-playground-style chat controls, but for Nalu — a right settings DRAWER
// (model · reasoning · max tokens · web search · system prompt) and a "View code"
// MODAL (OpenAI-compatible snippet in Python/JS/cURL that mirrors the live settings).
// These live in the CHAT header (not Settings). They read/write the same
// naluSettings that every /api/chat request already uses, so changing a slider here
// takes effect on your next message.
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, ChevronDown, Copy, Check } from 'lucide-react'
import {
  getModelSettings, setModelSettings,
  REASONING_LEVELS, REASONING_LABEL, REASONING_DESC, MIN_TOKENS, MAX_TOKENS,
  type NaluModelSettings,
} from '../../lib/naluSettings'

const ENDPOINT = 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'
const MODEL = 'thinkingmachines/Inkling'
// Map Nalu's 6 reasoning levels to the OpenAI `reasoning_effort` string.
const EFFORT: Record<string, string> = { none: 'none', min: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high' }

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} aria-label={label}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${on ? 'border-emerald-400 bg-emerald-500' : 'border-glass/30 bg-glass/20'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${on ? 'translate-x-[22px]' : 'translate-x-1'}`} />
    </button>
  )
}

// ---- API code snippets (reflect the live settings) ------------------------------
const WEB_TOOL_PY = `        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Searches the web for relevant information.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "A query to send to a search engine."},
                    },
                    "required": ["query"],
                },
            },
        },`
function pyCode(s: NaluModelSettings): string {
  const mt = s.maxTokens >= MAX_TOKENS ? 'None' : String(s.maxTokens)
  const tools = s.webSearch ? `\n    tools=[\n${WEB_TOOL_PY}\n    ],` : ''
  return `import os
from openai import OpenAI

BASE_URL = "${ENDPOINT}"
MODEL = "${MODEL}"

client = OpenAI(
    base_url=BASE_URL,
    api_key=os.environ["TINKER_API_KEY"],
)

stream = client.chat.completions.create(
    model=MODEL,
    messages=[
        {
            "role": "system",
            "content": ${JSON.stringify(s.systemPrompt || 'You are Inkling, a multimodal AI model created by Thinking Machines.')},
        },
    ],
    reasoning_effort="${EFFORT[s.reasoning] || 'low'}",
    max_tokens=${mt},
    stream=${s.streaming ? 'True' : 'False'},${tools}
)

for chunk in stream:
    delta = chunk.choices[0].delta.content or ""
    print(delta, end="", flush=True)`
}
function jsCode(s: NaluModelSettings): string {
  const mt = s.maxTokens >= MAX_TOKENS ? 'undefined' : String(s.maxTokens)
  const tools = s.webSearch
    ? `\n  tools: [{ type: "function", function: { name: "web_search", description: "Searches the web for relevant information.", parameters: { type: "object", properties: { query: { type: "string", description: "A query to send to a search engine." } }, required: ["query"] } } }],`
    : ''
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${ENDPOINT}",
  apiKey: process.env.TINKER_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "${MODEL}",
  messages: [
    { role: "system", content: ${JSON.stringify(s.systemPrompt || 'You are Inkling, a multimodal AI model created by Thinking Machines.')} },
  ],
  reasoning_effort: "${EFFORT[s.reasoning] || 'low'}",
  max_tokens: ${mt},
  stream: ${s.streaming ? 'true' : 'false'},${tools}
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}`
}
function curlCode(s: NaluModelSettings): string {
  const mt = s.maxTokens >= MAX_TOKENS ? 'null' : String(s.maxTokens)
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: s.systemPrompt || 'You are Inkling, a multimodal AI model created by Thinking Machines.' }],
    reasoning_effort: EFFORT[s.reasoning] || 'low',
    max_tokens: mt === 'null' ? null : Number(mt),
    stream: s.streaming,
    ...(s.webSearch ? { tools: [{ type: 'function', function: { name: 'web_search', description: 'Searches the web for relevant information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'A query to send to a search engine.' } }, required: ['query'] } } }] } : {}),
  }
  return `curl ${ENDPOINT}/chat/completions \\
  -H "Authorization: Bearer $TINKER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2)}'`
}

type Lang = 'python' | 'javascript' | 'curl'
const LANGS: { id: Lang; label: string }[] = [{ id: 'python', label: 'Python' }, { id: 'javascript', label: 'JavaScript' }, { id: 'curl', label: 'cURL' }]

export default function PlaygroundControls() {
  const [s, setS] = useState<NaluModelSettings>(() => getModelSettings())
  const [drawer, setDrawer] = useState(false)
  const [code, setCode] = useState(false)
  const [lang, setLang] = useState<Lang>('python')
  const [copied, setCopied] = useState(false)
  // Keep in sync if the settings change elsewhere (e.g. the Settings panel).
  useEffect(() => {
    const h = (e: Event) => setS((e as CustomEvent).detail || getModelSettings())
    window.addEventListener('nalu-settings-changed', h)
    return () => window.removeEventListener('nalu-settings-changed', h)
  }, [])
  const patch = (p: Partial<NaluModelSettings>) => setS(setModelSettings(p))

  const snippet = useMemo(() => (lang === 'python' ? pyCode(s) : lang === 'javascript' ? jsCode(s) : curlCode(s)), [lang, s])
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { /* */ } }

  const rIdx = Math.max(0, REASONING_LEVELS.indexOf(s.reasoning))
  const spRef = useRef<HTMLTextAreaElement>(null)

  return (
    <>
      {/* header buttons (View code / right settings panel) removed per request */}

      {/* right settings drawer */}
      {drawer && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setDrawer(false)} />
          <div className="fixed right-0 top-0 z-50 flex h-full w-[360px] max-w-[92vw] flex-col border-l border-glass/[0.18] bg-panel/95 text-ink shadow-2xl backdrop-blur-2xl">
            <div className="flex items-center justify-between px-5 py-4">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-dim">Model</div>
                <div className="flex items-center gap-1.5 text-base font-semibold">Inkling <ChevronDown size={15} className="text-dim" /></div>
              </div>
              <button onClick={() => setDrawer(false)} className="text-dim hover:text-ink"><X size={18} /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto border-t border-glass/[0.12] px-5 py-5">
              {/* Reasoning */}
              <div>
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-semibold">Reasoning effort</div>
                  <div className="text-sm font-medium">{REASONING_LABEL[s.reasoning]}</div>
                </div>
                <p className="mt-0.5 text-xs text-dim">{REASONING_DESC[s.reasoning]}</p>
                <input type="range" min={0} max={REASONING_LEVELS.length - 1} step={1} value={rIdx}
                  onChange={(e) => patch({ reasoning: REASONING_LEVELS[Number(e.target.value)] })}
                  className="mt-3 w-full accent-primary cursor-pointer" />
                <div className="mt-1 flex justify-between text-[10px] text-dim">
                  {REASONING_LEVELS.map((l) => <span key={l} className={s.reasoning === l ? 'font-semibold text-ink' : ''}>{REASONING_LABEL[l]}</span>)}
                </div>
              </div>
              {/* Max tokens */}
              <div>
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-semibold">Max tokens</div>
                  <div className="text-sm font-medium tabular-nums">{s.maxTokens >= MAX_TOKENS ? 'Auto' : s.maxTokens.toLocaleString()}</div>
                </div>
                <p className="mt-0.5 text-xs text-dim">Caps response length.</p>
                <input type="range" min={MIN_TOKENS} max={MAX_TOKENS} step={256} value={s.maxTokens}
                  onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
                  className="mt-3 w-full accent-primary cursor-pointer" />
                <div className="mt-1 flex justify-between text-[10px] text-dim"><span>Shorter</span><span>Auto</span></div>
              </div>
              {/* Web search */}
              <div className="flex items-center justify-between border-t border-glass/[0.12] pt-5">
                <div>
                  <div className="text-sm font-semibold">Web search</div>
                  <p className="mt-0.5 text-xs text-dim">Search the web while responding.</p>
                </div>
                <Toggle on={s.webSearch} onClick={() => patch({ webSearch: !s.webSearch })} label="Web search" />
              </div>
              {/* Streaming */}
              <div className="flex items-center justify-between border-t border-glass/[0.12] pt-5">
                <div>
                  <div className="text-sm font-semibold">Stream replies</div>
                  <p className="mt-0.5 text-xs text-dim">Type the answer out live as it generates.</p>
                </div>
                <Toggle on={s.streaming} onClick={() => patch({ streaming: !s.streaming })} label="Stream replies" />
              </div>
              {/* System prompt */}
              <div className="border-t border-glass/[0.12] pt-5">
                <div className="text-sm font-semibold">System prompt</div>
                <p className="mt-0.5 text-xs text-dim">Extra instructions Nalu follows every message.</p>
                <textarea ref={spRef} value={s.systemPrompt} onChange={(e) => patch({ systemPrompt: e.target.value })}
                  placeholder="e.g. Always answer concisely and cite sources."
                  className="mt-2 h-40 w-full resize-y rounded-lg border border-glass/[0.18] bg-glass/[0.06] p-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-primary/50" />
                <div className="mt-1 text-right text-[11px] text-dim">{s.systemPrompt.length.toLocaleString()} characters</div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* API code modal */}
      {code && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={() => setCode(false)}>
          <div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-glass/[0.18] bg-panel text-ink shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between px-5 pt-5">
              <div>
                <div className="text-base font-semibold">API code</div>
                <p className="mt-0.5 text-sm text-dim">Uses Tinker's OpenAI-compatible chat completions endpoint with Inkling.</p>
              </div>
              <button onClick={() => setCode(false)} className="text-dim hover:text-ink"><X size={18} /></button>
            </div>
            <div className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="relative">
                <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}
                  className="appearance-none rounded-lg border border-glass/[0.18] bg-glass/[0.06] py-1.5 pl-3 pr-8 text-sm text-ink outline-none focus:border-primary/50">
                  {LANGS.map((l) => <option key={l.id} value={l.id} className="bg-panel2">{l.label}</option>)}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim" />
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-dim">Streaming</span>
                <Toggle on={s.streaming} onClick={() => patch({ streaming: !s.streaming })} label="Streaming" />
              </div>
            </div>
            <div className="flex items-center justify-between px-5 pb-2 text-xs">
              <a href="https://tinker.thinkingmachines.ai" target="_blank" rel="noreferrer" className="text-dim hover:text-ink">Generate API key <span className="underline">here ↗</span></a>
              <button onClick={copy} className="flex items-center gap-1.5 text-dim hover:text-ink">{copied ? <><Check size={13} className="text-emerald-400" /> Copied</> : <><Copy size={13} /> Copy</>}</button>
            </div>
            <div className="mx-5 mb-3 min-h-0 flex-1 overflow-auto rounded-xl bg-glass/[0.06] p-4">
              <pre className="text-[12.5px] leading-relaxed text-ink"><code>{snippet}</code></pre>
            </div>
            {s.webSearch && (
              <p className="px-5 pb-5 text-xs leading-relaxed text-dim">Tinker's OpenAI-compatible API does not have built-in web search, so this snippet passes the web-search tool schema through — your client implements the search.</p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
