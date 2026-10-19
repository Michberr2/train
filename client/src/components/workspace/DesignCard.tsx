import { useScopedArtifact } from './ScopedArtifactContext'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import MotionPreview from './MotionPreview'
import type { MotionSpec } from './motionFrame'
import type { WebsiteQuality } from './types'
import StudioValidation from './StudioValidation'
import { ARTIFACT_SANDBOX, artifactDocument as shimHtml, openArtifactHtml } from './artifactIsolation'

// Inline "Nalu Design" card — renders an AI-generated self-contained HTML
// document live in a sandboxed iframe, with download
// (.html), open-in-new-tab, and a shareable public link (hosted on n4lu.ai).

const PREVIEW_CHECKS = `<script>(function(){var send=function(message){parent.postMessage({type:'nalu-website-issue',message:String(message).slice(0,500)},'*')};addEventListener('error',function(e){if(e.message)send(e.message)});addEventListener('unhandledrejection',function(e){send(e.reason&&e.reason.message||'An action failed to complete.')});var check=function(){if(document.documentElement.scrollWidth>innerWidth+2)send('Content overflows the viewport at '+innerWidth+'px. Fix the responsive layout without clipping content.')};addEventListener('load',function(){setTimeout(check,500)});addEventListener('resize',check)})()</script>`
function checkedPreview(html: string): string {
  const preview = shimHtml(html)
  return preview.replace(/<head[^>]*>/i, match => match + PREVIEW_CHECKS)
}

export default function DesignCard({ html, kind = 'webpage', motion, truncated, quality, onUpdate }: { html: string; kind?: 'webpage' | 'poster' | 'motion' | 'game' | 'board'; motion?: Partial<MotionSpec>; truncated?: boolean; quality?: WebsiteQuality; onUpdate?: (html: string, quality?: WebsiteQuality) => void }) {
  const scoped = useScopedArtifact()
  const [showCode, setShowCode] = useState(false)
  const [publication, setPublication] = useState<{ html: string; state: 'working' | 'ready' | 'error'; url?: string; error?: string }>()
  const [copiedHtml, setCopiedHtml] = useState<string>()
  const shareRequest = useRef<AbortController | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const latestHtml = useRef(html)
  latestHtml.current = html
  const share = publication?.html === html ? publication : undefined
  const copied = copiedHtml === html
  useEffect(() => {
    setPublication(undefined)
    setCopiedHtml(undefined)
    return () => {
      shareRequest.current?.abort()
      shareRequest.current = null
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [html])
  const [finishing, setFinishing] = useState(false)
  const [finishErr, setFinishErr] = useState('')
  const [phone, setPhone] = useState(false)
  const [previewIssues, setPreviewIssues] = useState<string[]>([])
  const previewRef = useRef<HTMLIFrameElement>(null)
  const preview = useMemo(() => kind === 'webpage' ? checkedPreview(html) : shimHtml(html), [html, kind])
  useEffect(() => {
    setPreviewIssues([])
    const receive = (event: MessageEvent) => {
      if (event.source !== previewRef.current?.contentWindow || event.data?.type !== 'nalu-website-issue' || typeof event.data.message !== 'string') return
      const message = event.data.message.slice(0, 500)
      setPreviewIssues(issues => issues.includes(message) ? issues : [...issues, message].slice(0, 6))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [html])
  const [blobUrl, setBlobUrl] = useState('')
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    setBlobUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [html])

  // An interrupted build can always still be finished: hand the current page
  // back to the design engine to complete every unfinished section.
  const finishBuild = async (repair = false) => {
    if (scoped || finishing || !onUpdate) return
    setFinishing(true)
    setFinishErr('')
    try {
      const r = await fetch('/api/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: repair ? `Fix these problems observed in the running website: ${previewIssues.join('; ')}. Preserve the existing content, art direction, and working features. Return the complete corrected HTML. Do not hide content or remove functionality to suppress an error.` : kind === 'motion'
            ? 'This motion graphic was cut off mid-generation. Finish the existing animation and its code. Preserve its copy, composition, aspect ratio, timing, loop behavior, and reduced-motion support. Keep the existing creative content and output the complete animated HTML artifact.'
            : `This ${kind} was cut off mid-generation. Finish its existing content and interactivity, preserving the artifact type, design, and everything already complete. Output the complete HTML artifact.`,
          kind,
          prevHtml: html,
          ...(repair ? { previewIssues } : {}),
        }),
      })
      const d = (await r.json().catch(() => ({}))) as { html?: string; error?: string; quality?: WebsiteQuality }
      if (r.ok && d.html && d.html.length > html.length * 0.6 && latestHtml.current === html) onUpdate(d.html, d.quality)
      else setFinishErr(d.error || 'Could not finish the build — try again.')
    } catch (e) {
      setFinishErr(e instanceof Error ? e.message : 'Could not finish the build — try again.')
    } finally {
      setFinishing(false)
    }
  }

  const download = () => {
    if (!blobUrl) return
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = 'nalu-design.html'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  const openTab = () => openArtifactHtml(html, 'Nalu Design')

  // Publish to a public shareable URL on n4lu.ai (stored server-side).
  const makeShareLink = async () => {
    if (scoped) return
    if (share?.state === 'working') return
    const copy = async (url: string) => {
      try {
        if (!navigator.clipboard) return
        await navigator.clipboard.writeText(url)
        if (latestHtml.current !== html) return
        setCopiedHtml(html)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopiedHtml(undefined), 1500)
      } catch { /* The published URL remains available in the link below. */ }
    }
    if (share?.url) {
      void copy(share.url)
      return
    }
    shareRequest.current?.abort()
    const controller = new AbortController()
    shareRequest.current = controller
    setPublication({ html, state: 'working' })
    try {
      const token = localStorage.getItem('nalu-token') || ''
      const r = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'share', token, html }),
        signal: controller.signal,
      })
      const d = (await r.json().catch(() => ({}))) as { url?: string; error?: string }
      if (controller.signal.aborted || shareRequest.current !== controller || latestHtml.current !== html) return
      if (r.ok && d.url?.startsWith('/api/data?share=')) {
        const full = new URL(d.url, location.origin).href
        setPublication({ html, state: 'ready', url: full })
        void copy(full)
      } else {
        setPublication({ html, state: 'error', error: typeof d.error === 'string' ? d.error.slice(0, 300) : undefined })
      }
    } catch {
      if (!controller.signal.aborted && shareRequest.current === controller && latestHtml.current === html) setPublication({ html, state: 'error' })
    } finally {
      if (shareRequest.current === controller) shareRequest.current = null
    }
  }

  return (
    <div className="my-4 border-y border-glass/[0.12]">
      <div className="flex items-baseline gap-3 px-1 py-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">Design</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{kind === 'motion' ? 'Motion graphic' : 'Live preview — interactive'}</span>
        <button onClick={() => setShowCode((s) => !s)} className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline">Code</button>
        <span className="text-xs text-dim">·</span>
        <button onClick={openTab} className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline">Open</button>
        {!scoped && <span className="text-xs text-dim">·</span>}
        {!scoped && <button
          onClick={() => void makeShareLink()}
          title={share?.url || 'Publish this version and create a shareable link'}
          className="shrink-0 text-xs text-dim underline-offset-4 hover:text-ink hover:underline"
        >
          {share?.state === 'working' ? 'Sharing…' : copied ? 'Copied' : share?.url ? 'Link' : 'Share'}
        </button>}
        <span className="text-xs text-dim">·</span>
        <button onClick={download} className="shrink-0 text-xs font-medium text-gold underline-offset-4 hover:underline">HTML</button>
      </div>
      {share?.state === 'error' && <p role="alert" className="px-2 pb-2 text-xs text-ink">{share.error || 'This version could not be shared. Try again.'}</p>}
      {share?.url && <p className="px-2 pb-2 text-xs text-dim">Published version: <a className="break-all underline" href={share.url} target="_blank" rel="noopener noreferrer">{share.url}</a></p>}
      {kind === 'webpage' && <StudioValidation quality={quality} />}
      {truncated && onUpdate && !scoped && (
        <div className="flex items-center gap-2.5 border-b border-amber-400/25 bg-panel/80 px-4 py-2">
          <span className="flex-1 text-xs text-ink">This build was interrupted before it finished — it can still be completed.</span>
          {finishErr && <span className="text-[11px] text-red-300">{finishErr}</span>}
          <button
            onClick={() => void finishBuild()}
            disabled={finishing}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500/25 px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-amber-500/35 disabled:opacity-60"
          >
            {finishing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} className="rotate-180" />}
            {finishing ? 'Finishing… (~1-2 min)' : 'Finish build'}
          </button>
        </div>
      )}
      {kind === 'webpage' && <div className="flex items-center justify-between gap-3 border-t border-glass/10 px-2 py-2">
        <span className="text-xs text-dim">{scoped ? 'Try the page' : 'Try the page before sharing'}</span>
        <div className="flex gap-1"><button onClick={() => { setPhone(false); setPreviewIssues([]) }} aria-pressed={!phone} className={`rounded px-3 py-1.5 text-xs ${!phone ? 'bg-glass/10 text-ink' : 'text-dim'}`}>Responsive</button><button onClick={() => { setPhone(true); setPreviewIssues([]) }} aria-pressed={phone} className={`rounded px-3 py-1.5 text-xs ${phone ? 'bg-glass/10 text-ink' : 'text-dim'}`}>Phone</button></div>
      </div>}
      {kind === 'webpage' && !!previewIssues.length && <div className="flex flex-wrap items-center gap-3 border-t border-amber-500/20 bg-panel/80 p-3 text-xs text-ink">
        <span className="min-w-0 flex-1">The preview found a problem: {previewIssues[0]}</span>
        {onUpdate && !scoped && <button disabled={finishing} onClick={() => void finishBuild(true)} className="rounded-lg bg-amber-500/20 px-3 py-2 font-medium disabled:opacity-50">{finishing ? 'Repairing…' : 'Repair preview'}</button>}
        {finishErr && <span role="alert" className="w-full">{finishErr}</span>}
      </div>}
      {kind === 'motion' ? <MotionPreview html={html} motion={motion} /> : <div className="flex justify-center overflow-auto bg-black/10"><iframe
        ref={previewRef}
        srcDoc={preview}
        title="Nalu Design"
        sandbox={ARTIFACT_SANDBOX}
        className="h-[80vh] w-full border-0 bg-white"
        style={kind === 'webpage' && phone ? { width: 375, maxWidth: '100%', flexShrink: 0 } : undefined}
      /></div>}
      {showCode && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-glass/[0.1] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-[#9fd0ff]">
          {html}
        </pre>
      )}
    </div>
  )
}
