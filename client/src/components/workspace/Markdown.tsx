import { useState, useRef, memo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Components } from 'react-markdown'
import 'katex/dist/katex.min.css'
import { chartDataUrl, hasChartData, type ChartSpec } from './chartRender'

// react-markdown's defaultUrlTransform only allows http/https/mailto-style
// protocols and BLANKS everything else — including `data:` URLs. Generated
// images (Gemini + baked FLUX fallback) come back as `data:image/...`, so the
// default strips their src and every image renders as "failed to load". Allow
// data:image and blob: (safe for <img>), and defer to the default — which still
// blocks javascript: etc. — for all other URLs.
function markdownUrlTransform(url: string): string {
  if (/^data:image\//i.test(url) || /^blob:/i.test(url)) return url
  return defaultUrlTransform(url)
}

// ```chart blocks render as REAL charts inline (bar/line/pie via chartRender).
// While the JSON is still streaming in it shows a quiet placeholder.
function ChartBlock({ source }: { source: string }) {
  let spec: ChartSpec | null = null
  try {
    const parsed = JSON.parse(source) as ChartSpec
    if (hasChartData(parsed)) spec = parsed
  } catch {
    /* incomplete while streaming — or malformed once complete (handled below) */
  }
  if (!spec) {
    // A chart block that LOOKS finished but won't parse is malformed, not still
    // streaming — show the raw JSON in a code box so it isn't a placeholder that
    // pulses forever. "Finished" = ends on } or ] AND braces/brackets are balanced,
    // so a mid-stream partial (which is transiently unbalanced) never flashes here.
    const t = source.trim()
    const balanced = (o: string, c: string) => (t.split(o).length === t.split(c).length)
    const looksDone = t.length > 1 && /[}\]]$/.test(t) && balanced('{', '}') && balanced('[', ']')
    if (looksDone)
      return (
        <pre className="my-3 overflow-x-auto rounded-xl border border-glass/[0.12] bg-black/40 p-3.5 text-[13px] leading-relaxed">
          <code className="font-mono text-[13px]">{source}</code>
        </pre>
      )
    return <span className="my-2 block h-40 w-full max-w-xl animate-pulse rounded-xl border border-glass/[0.12] bg-glass/[0.04]" />
  }
  const url = chartDataUrl(spec, 920, 460)
  return url ? (
    <img src={url} alt={spec.title || 'chart'} className="my-2 block w-full max-w-xl rounded-xl border border-glass/[0.12]" />
  ) : null
}

// A fenced code block with a hover Copy button (reads the rendered text so it
// copies exactly what's shown, language class and all).
function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <pre ref={ref} className="group relative my-3 overflow-x-auto rounded-xl border border-glass/[0.12] bg-black/40 p-3.5 text-[13px] leading-relaxed">
      <button
        onClick={() => {
          // Copy the CODE only — reading the <pre>'s innerText would include this
          // button's own "Copy" label.
          const text = ref.current?.querySelector('code')?.textContent ?? ref.current?.textContent ?? ''
          navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
        }}
        title="Copy code"
        aria-label="Copy code"
        className="absolute right-2 top-2 z-10 rounded-md border border-glass/[0.14] bg-black/50 px-1.5 py-1 text-[11px] text-dim opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {children}
    </pre>
  )
}

// Models emit LaTeX with \[ \] / \( \) delimiters; convert them to $$ / $ so
// remark-math + KaTeX render real formulas instead of raw \frac{}{} text.
function normalizeMath(s: string): string {
  return s
    // Escape CURRENCY dollar signs ("$180", "$1.5", "$ 65") FIRST so remark-math
    // doesn't pair them into inline math — "$180 billion … $65 billion" was being
    // parsed as a formula and rendered as a column of stacked characters. Real
    // inline math (from \(...\) below, or "$x^2$") isn't "$" + digit, so it's safe.
    .replace(/\$(?=\s?\d)/g, '\\$')
    .replace(/\\\[/g, () => '$$')
    .replace(/\\\]/g, () => '$$')
    .replace(/\\\(/g, () => '$')
    .replace(/\\\)/g, () => '$')
}

// Hard no-emoji policy: strip emoji + decorative check/cross/star glyphs that
// slip through, and normalize manual bullet glyphs to clean Markdown dashes.
export function stripDecoration(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[✅✓✔✖✗✘❌❎⭐★☆✨⬆✔️]/g, '')
    .replace(/^[ \t]*[•·▪►▶‣]\s+/gm, '- ')
    .replace(/[ \t]{2,}/g, ' ')
}

// Apply a prose transform (currency-$, emoji strip, whitespace collapse) ONLY to
// text OUTSIDE code — fenced ``` / ~~~ blocks and inline `code` spans are left
// byte-for-byte intact. Without this, normalizeMath/stripDecoration mangled code:
// space-collapse destroyed indentation (Python/YAML) and "$1"/"$180" became
// "\$1"/"\$180" inside code. An unterminated trailing fence (still streaming) is
// protected to end-of-string so code never flickers through the prose transform.
function transformOutsideCode(s: string, fn: (t: string) => string): string {
  const re = /```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|`[^`\n]+`/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out += fn(s.slice(last, m.index)) // prose before this code run → transform
    out += m[0] // code run → verbatim
    last = m.index + m[0].length
  }
  return out + fn(s.slice(last))
}

// Renders assistant replies as nicely formatted Markdown, themed for Nalu's
// dark glass UI. Handles headings, lists, code blocks, tables, quotes, links.

// Image with a "Generating image…" spinner that swaps to the photo on load.
function MarkdownImg({ src, alt }: { src?: string; alt?: string }) {
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading')
  const url = typeof src === 'string' ? src : ''
  return (
    <span className="my-2 block">
      {state !== 'done' && (
        <span className="relative flex h-72 w-72 max-w-full items-center justify-center overflow-hidden rounded-xl border border-glass/[0.14] bg-glass/[0.04]">
          <span className="absolute inset-0 animate-pulse bg-glass/[0.03]" />
          {state === 'loading' ? (
            <span className="z-10 flex flex-col items-center gap-2.5 text-xs text-dim">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-glass/20 border-t-white/80" />
              Generating image…
            </span>
          ) : (
            <span className="z-10 text-xs text-red-300">⚠️ Image failed to load</span>
          )}
        </span>
      )}
      {url && (
        <img
          src={url}
          alt={alt || ''}
          onLoad={() => setState('done')}
          onError={() => setState('error')}
          className={`max-h-[28rem] w-auto max-w-full rounded-xl border border-glass/[0.14] ${
            state === 'done' ? 'block' : 'hidden'
          }`}
        />
      )}
      {url && state === 'done' && (
        <button
          onClick={() => {
            void (async () => {
              try {
                const r = await fetch(url)
                const blob = await r.blob()
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = `nalu-image.${blob.type.includes('png') ? 'png' : 'jpg'}`
                document.body.appendChild(a)
                a.click()
                a.remove()
                setTimeout(() => URL.revokeObjectURL(a.href), 3000)
              } catch {
                window.open(url, '_blank')
              }
            })()
          }}
          className="mt-1 block text-xs font-medium text-gold underline-offset-4 hover:underline"
        >
          Download image
        </button>
      )}
    </span>
  )
}

// Quiet-luxury styling — ONE consistent font family (the app's Inter sans) for
// every block so a reply reads as a single cohesive typeface, with a gold
// hairline under section heads, gold "—" list markers, and muted-gold links.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-6 mb-3 border-b border-accent/30 pb-1.5 text-[1.5rem] font-semibold leading-tight tracking-tight text-ink first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2.5 text-[1.25rem] font-semibold leading-tight tracking-tight text-ink first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-1.5 text-[0.8rem] font-semibold uppercase tracking-[0.14em] text-gold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold text-ink first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0 leading-[1.7] text-ink">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2.5 space-y-1.5 pl-1 [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:left-[2px] [&>li]:before:text-accent [&>li]:before:content-['·'] [&>li]:before:text-[1.4em] [&>li]:before:leading-[1.1]">
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="my-2.5 ml-5 list-decimal space-y-1.5 marker:text-accent">{children}</ol>,
  li: ({ children }) => <li className="leading-[1.7] text-ink [&>ul]:mt-1.5 [&>ol]:mt-1.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic text-ink">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-gold underline decoration-accent/40 underline-offset-2 hover:text-[#e0c489]">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-accent/60 pl-4 italic text-ink">{children}</blockquote>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-accent/25" />,
  img: MarkdownImg,
  // react-markdown v9 no longer passes `inline`; detect block code by a
  // language- class or a multi-line body, otherwise render an inline pill.
  code({ className, children, ...props }) {
    if (/language-chart\b/.test(className || '')) return <ChartBlock source={String(children ?? '')} />
    const isBlock = /language-/.test(className || '') || String(children ?? '').includes('\n')
    if (isBlock) {
      return (
        <code className={`${className || ''} font-mono text-[13px]`} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-glass/[0.08] px-1.5 py-0.5 text-[13px] font-mono text-ink" {...props}>
        {children}
      </code>
    )
  },
  pre: ({ children }) => {
    // a ```chart block renders as a bare chart — no dark code box around it
    const first = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string } } | undefined
    if (/language-chart\b/.test(String(first?.props?.className || ''))) return <>{children}</>
    return <CodeBlock>{children}</CodeBlock>
  },
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-glass/[0.14] bg-glass/[0.05] px-3 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-glass/[0.14] px-3 py-1.5">{children}</td>,
}

// Memoized: while a message streams, only IT re-parses each frame — every other
// message in the conversation skips re-parsing (same string), so streaming stays
// smooth even in long chats.
function MarkdownBase({ children }: { children: string }) {
  // INTERACTIVE CHECKLISTS: GitHub task-list checkboxes ("- [ ]") render as live,
  // tickable boxes so any list Nalu writes (to-dos, action items, steps, packing
  // lists) works as a real checklist right in the chat. State is keyed by the
  // checkbox's source line, so it stays consistent as the message re-renders.
  const [checks, setChecks] = useState<Record<number, boolean>>({})
  // remark-gfm SYNTHESIZES the checkbox <input> nodes from "[ ]", so they carry NO
  // source position — keying state by the input's line makes every box collapse onto
  // key 0, so ticking one ticks them all. Instead assign each checkbox a stable
  // sequential index during render. The <li> and its <input> render in interleaved
  // document order (li0 → input0 → li1 → input1 …), so two counters reset each render
  // stay in lockstep and share the same key per task item.
  const cbIdx = useRef(0)
  const liIdx = useRef(0)
  cbIdx.current = 0
  liIdx.current = 0
  const comps: Components = {
    ...components,
    input: ({ node, checked, type, ...props }) => {
      if (type !== 'checkbox') return <input type={type} {...props} />
      const key = cbIdx.current++
      const on = checks[key] ?? !!checked
      return (
        <input
          type="checkbox"
          checked={on}
          onChange={() => setChecks((c) => ({ ...c, [key]: !on }))}
          style={{ accentColor: '#E4B96F' }}
          className="relative -top-px mr-2 h-[15px] w-[15px] shrink-0 cursor-pointer rounded align-middle"
        />
      )
    },
    li: ({ node, children: liChildren, className, ...props }) => {
      const isTask = /task-list-item/.test(className || '') ||
        (Array.isArray((node as { children?: Array<{ tagName?: string }> })?.children) &&
          (node as { children?: Array<{ tagName?: string }> }).children?.[0]?.tagName === 'input')
      const done = isTask && (checks[liIdx.current++] ?? false)
      return (
        <li className={`${className || ''} ${isTask ? 'flex list-none items-start' : ''} ${done ? 'text-dim line-through' : ''}`} {...props}>
          {liChildren}
        </li>
      )
    },
  }
  return (
    <div dir="auto" className="markdown-body text-[13.5px] text-ink break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={markdownUrlTransform}
        components={comps}
      >
        {transformOutsideCode(children, (t) => stripDecoration(normalizeMath(t)))}
      </ReactMarkdown>
    </div>
  )
}
export default memo(MarkdownBase)
