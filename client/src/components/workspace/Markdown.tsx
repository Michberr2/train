import { useState, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Components } from 'react-markdown'
import 'katex/dist/katex.min.css'
import { chartDataUrl, hasChartData, type ChartSpec } from './chartRender'

// ```chart blocks render as REAL charts inline (bar/line/pie via chartRender).
// While the JSON is still streaming in it shows a quiet placeholder.
function ChartBlock({ source }: { source: string }) {
  let spec: ChartSpec | null = null
  try {
    const parsed = JSON.parse(source) as ChartSpec
    if (hasChartData(parsed)) spec = parsed
  } catch {
    /* incomplete while streaming */
  }
  if (!spec)
    return <span className="my-2 block h-40 w-full max-w-xl animate-pulse rounded-xl border border-glass/[0.12] bg-glass/[0.04]" />
  const url = chartDataUrl(spec, 920, 460)
  return url ? (
    <img src={url} alt={spec.title || 'chart'} className="my-2 block w-full max-w-xl rounded-xl border border-glass/[0.12]" />
  ) : null
}

// Models emit LaTeX with \[ \] / \( \) delimiters; convert them to $$ / $ so
// remark-math + KaTeX render real formulas instead of raw \frac{}{} text.
function normalizeMath(s: string): string {
  return s
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
    <ul className="my-2.5 space-y-1.5 pl-1 [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:text-accent [&>li]:before:content-['—']">
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
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-glass/[0.12] bg-black/40 p-3.5 text-[13px] leading-relaxed">
        {children}
      </pre>
    )
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
  return (
    <div className="markdown-body text-[13.5px] text-ink break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {stripDecoration(normalizeMath(children))}
      </ReactMarkdown>
    </div>
  )
}
export default memo(MarkdownBase)
