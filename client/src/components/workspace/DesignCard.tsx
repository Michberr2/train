import { useEffect, useMemo, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'

// Inline "Nalu Design" card — renders an AI-generated self-contained HTML
// document live in a sandboxed iframe, with download
// (.html), open-in-new-tab, and a shareable public link (hosted on n4lu.ai).

// The sandbox (no allow-same-origin) makes localStorage/sessionStorage THROW —
// one unguarded access would kill a generated page's whole <script>. Inject an
// in-memory shim FIRST so any storage call the model wrote just works.
const STORAGE_SHIM = `<script>(function(){try{localStorage.length}catch(e){var mk=function(){var s={};return{getItem:function(k){return k in s?s[k]:null},setItem:function(k,v){s[k]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s={}},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};try{Object.defineProperty(window,'localStorage',{value:mk(),configurable:true});Object.defineProperty(window,'sessionStorage',{value:mk(),configurable:true})}catch(e2){}}})()</script>`
function shimHtml(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + STORAGE_SHIM)
  return STORAGE_SHIM + html
}

export default function DesignCard({ html, truncated, onUpdate }: { html: string; truncated?: boolean; onUpdate?: (html: string) => void }) {
  const [showCode, setShowCode] = useState(false)
  const [share, setShare] = useState<'idle' | 'working' | string>('idle')
  const [copied, setCopied] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishErr, setFinishErr] = useState('')
  const preview = useMemo(() => shimHtml(html), [html])
  const blobUrl = useMemo(() => URL.createObjectURL(new Blob([html], { type: 'text/html' })), [html])
  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl])

  // An interrupted build can always still be finished: hand the current page
  // back to the design engine to complete every unfinished section.
  const finishBuild = async () => {
    if (finishing || !onUpdate) return
    setFinishing(true)
    setFinishErr('')
    try {
      const r = await fetch('/api/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'This page was cut off mid-generation. FINISH the build: complete every unfinished or thin section, close out all interactivity, and ship the complete polished page. Keep everything that is already good exactly as it is.',
          kind: 'webpage',
          prevHtml: html,
        }),
      })
      const d = (await r.json().catch(() => ({}))) as { html?: string; error?: string }
      if (r.ok && d.html && d.html.length > html.length * 0.6) onUpdate(d.html)
      else setFinishErr(d.error || 'Could not finish the build — try again.')
    } catch (e) {
      setFinishErr(e instanceof Error ? e.message : 'Could not finish the build — try again.')
    } finally {
      setFinishing(false)
    }
  }

  const download = () => {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = 'nalu-design.html'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  const openTab = () => window.open(blobUrl, '_blank', 'noopener,noreferrer')

  // Publish to a public shareable URL on n4lu.ai (stored server-side).
  const makeShareLink = async () => {
    if (share === 'working') return
    if (typeof share === 'string' && share.startsWith('http')) {
      void navigator.clipboard?.writeText(share)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      return
    }
    setShare('working')
    try {
      const token = localStorage.getItem('nalu-token') || ''
      const r = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'share', token, html }),
      })
      const d = (await r.json().catch(() => ({}))) as { url?: string; error?: string }
      if (d.url) {
        const full = `${location.origin}${d.url}`
        setShare(full)
        void navigator.clipboard?.writeText(full)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      } else {
        setShare('idle')
      }
    } catch {
      setShare('idle')
    }
  }

  return (
    <div className="my-4 border-y border-glass/[0.12]">
      <div className="flex items-baseline gap-3 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">Design</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">Live preview — interactive</span>
        <button onClick={() => setShowCode((s) => !s)} className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline">Code</button>
        <span className="text-xs text-dim">·</span>
        <button onClick={openTab} className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline">Open</button>
        <span className="text-xs text-dim">·</span>
        <button
          onClick={() => void makeShareLink()}
          title={typeof share === 'string' && share.startsWith('http') ? share : 'Create a shareable link'}
          className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline"
        >
          {share === 'working' ? 'Sharing…' : copied ? 'Copied' : typeof share === 'string' && share.startsWith('http') ? 'Link' : 'Share'}
        </button>
        <span className="text-xs text-dim">·</span>
        <button onClick={download} className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline">HTML</button>
      </div>
      {truncated && onUpdate && (
        <div className="flex items-center gap-2.5 border-b border-amber-400/25 bg-amber-500/[0.08] px-4 py-2">
          <span className="flex-1 text-xs text-amber-200">This build was interrupted before it finished — it can still be completed.</span>
          {finishErr && <span className="text-[11px] text-red-300">{finishErr}</span>}
          <button
            onClick={() => void finishBuild()}
            disabled={finishing}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500/25 px-2.5 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/35 disabled:opacity-60"
          >
            {finishing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} className="rotate-180" />}
            {finishing ? 'Finishing… (~1-2 min)' : 'Finish build'}
          </button>
        </div>
      )}
      <iframe
        srcDoc={preview}
        title="Nalu Design"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className="h-[80vh] w-full border-0 bg-white"
      />
      {showCode && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-glass/[0.1] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-[#9fd0ff]">
          {html}
        </pre>
      )}
    </div>
  )
}
