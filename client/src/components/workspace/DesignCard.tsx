import { useMemo, useState } from 'react'
import { Globe, Download, ExternalLink, Code2, Share2, Check, Loader2 } from 'lucide-react'

// Inline "Nalu Design" card — renders an AI-generated self-contained HTML
// document live in a sandboxed iframe (Claude-Artifacts style), with download
// (.html), open-in-new-tab, and a shareable public link (hosted on n4lu.ai).

export default function DesignCard({ html }: { html: string }) {
  const [showCode, setShowCode] = useState(false)
  const [share, setShare] = useState<'idle' | 'working' | string>('idle')
  const [copied, setCopied] = useState(false)
  const blobUrl = useMemo(() => URL.createObjectURL(new Blob([html], { type: 'text/html' })), [html])

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
    <div className="my-2 overflow-hidden rounded-xl border border-white/[0.16] bg-white/[0.04]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.12] px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-fuchsia-500/15 text-fuchsia-300">
          <Globe size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#ededed]">Nalu Design</div>
          <div className="text-xs text-[#8e8e8e]">Live preview — interactive</div>
        </div>
        <button
          onClick={() => setShowCode((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs text-[#ededed] hover:bg-white/[0.12]"
        >
          <Code2 size={13} /> Code
        </button>
        <button
          onClick={openTab}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs text-[#ededed] hover:bg-white/[0.12]"
        >
          <ExternalLink size={13} /> Open
        </button>
        <button
          onClick={() => void makeShareLink()}
          title={typeof share === 'string' && share.startsWith('http') ? share : 'Create a shareable link'}
          className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs text-[#ededed] hover:bg-white/[0.12]"
        >
          {share === 'working' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : copied ? (
            <Check size={13} className="text-emerald-300" />
          ) : (
            <Share2 size={13} />
          )}
          {copied ? 'Copied' : typeof share === 'string' && share.startsWith('http') ? 'Link' : 'Share'}
        </button>
        <button
          onClick={download}
          className="flex items-center gap-1.5 rounded-lg bg-fuchsia-500/20 px-2.5 py-1.5 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/30"
        >
          <Download size={13} /> HTML
        </button>
      </div>
      <iframe
        srcDoc={html}
        title="Nalu Design"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        className="h-[30rem] w-full border-0 bg-white"
      />
      {showCode && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-white/[0.1] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-[#9fd0ff]">
          {html}
        </pre>
      )}
    </div>
  )
}
