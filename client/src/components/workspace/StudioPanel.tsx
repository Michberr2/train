import WorkspaceIntro from './WorkspaceIntro'
import NaluAvatar from '../avatar/NaluAvatar'
import NaluMark from '../landing/NaluMark'
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import MotionPreview from './MotionPreview'
import WebsiteStarter from './WebsiteStarter'
import StudioStarter from './StudioStarter'
import type { MotionSpec } from './motionFrame'
import type { ArtifactPreviewSource } from '../workspace-preview/real/ArtifactPreview'
import {
  Globe, Sparkles, Palette, BookOpen, Ruler, Footprints, Film, ShoppingBag,
  Image as ImageIcon, FileText, BarChart3, Table2, Video, PenTool, LayoutTemplate,
  ArrowRight, Eye, X, Search, Gamepad2, GalleryHorizontal, type LucideIcon,
} from 'lucide-react'

// A thing Nalu built (across all chats), surfaced in the Studio gallery.
export type Creation = { key: string; chatId: string; mi: number; kind: string; title: string; html?: string; img?: string; motion?: Partial<MotionSpec>; previewData?: ArtifactPreviewSource }
const ReviewArtifactPreview = lazy(() => import('../workspace-preview/real/ArtifactPreview'))
const KIND_ICON: Record<string, LucideIcon> = {
  webpage: Globe, poster: LayoutTemplate, motion: Film, brand: BookOpen, canvas: PenTool,
  palette: Palette, blueprint: Ruler, logo: Sparkles, shopping: ShoppingBag,
  deck: BarChart3, sheet: Table2, doc: FileText, video: Video, cad: Footprints,
  game: Gamepad2, board: LayoutTemplate, image: ImageIcon, carousel: GalleryHorizontal,
}

// Nalu Studio — quiet-luxury design workspace. Restrained monochrome + a single
// gold accent, serif display type, hairline rules. Pick a tool, optionally a
// design system, describe a brief, Generate → runs the real generator.
const SERIF = "'Cormorant Garamond', Georgia, 'Times New Roman', serif"

export type Tool = { key: string; name: string; desc: string; icon: LucideIcon; styled?: boolean; ph: string; tmpl: (b: string, s: string) => string }
const sp = (s: string) => (s && s !== 'none' ? `${s} ` : '')
export const TOOLS: Tool[] = [
  { key: 'website', name: 'Website', desc: 'A complete, downloadable website or working app.', icon: Globe, styled: true, ph: 'a boutique coffee roaster called Ember', tmpl: (b, s) => `Build this complete ${sp(s)}website or web app, honoring the requested functionality: ${b}` },
  { key: 'logo', name: 'Logo', desc: 'Clean vector marks and AI logo images, on brand.', icon: Sparkles, styled: true, ph: 'Ember, a coastal coffee brand', tmpl: (b, s) => `Design a ${sp(s)}logo for ${b}` },
  { key: 'palette', name: 'Palette', desc: 'A cohesive, accessible color palette to save.', icon: Palette, ph: 'a calm wellness app', tmpl: (b) => `Create a color palette for ${b}` },
  { key: 'brand', name: 'Brand book', desc: 'A polished, multi-page brand guidelines book.', icon: BookOpen, styled: true, ph: 'Aurora, a fintech startup', tmpl: (b, s) => `Create ${sp(s)}brand guidelines for ${b}` },
  { key: 'blueprint', name: 'Blueprint', desc: 'Floor plans, dimensioned and to scale, with 3D.', icon: Ruler, ph: 'a 3-bedroom house with an open kitchen', tmpl: (b) => `Design a detailed floor plan for ${b}` },
  { key: 'walkthrough', name: 'Walkthrough', desc: 'Walk a furnished 3D house and record a tour.', icon: Footprints, ph: 'a 2-bedroom apartment with a balcony', tmpl: (b) => `Design a house I can walk through in 3D: ${b}` },
  { key: 'motion', name: 'Motion', desc: 'A looping animated title or logo reveal.', icon: Film, styled: true, ph: 'an Ember logo reveal', tmpl: (b, s) => `Create a ${sp(s)}animated motion graphic for ${b}` },
  { key: 'game', name: 'Game', desc: 'A playable 3D/2D game, built with PlayCanvas.', icon: Gamepad2, ph: 'an endless runner where you dodge obstacles', tmpl: (b) => `Make a playable game: ${b}` },
  { key: 'poster', name: 'Poster', desc: 'A bold poster or infographic, downloadable.', icon: LayoutTemplate, styled: true, ph: 'a summer jazz festival', tmpl: (b, s) => `Design a ${sp(s)}poster for ${b}` },
  { key: 'carousel', name: 'Carousel', desc: 'A swipeable Instagram/social carousel post — download every slide.', icon: GalleryHorizontal, styled: true, ph: '5 tips for better sleep', tmpl: (b, s) => `Design a ${sp(s)}Instagram carousel post about ${b}` },
  { key: 'canvas', name: 'Canvas', desc: 'An editable vector graphic, Figma-like.', icon: PenTool, styled: true, ph: 'an Instagram post announcing a sale', tmpl: (b, s) => `Make an editable ${sp(s)}social graphic for ${b}` },
  { key: 'shopping', name: 'Shopping', desc: 'A curated list, then see it in a 3D room.', icon: ShoppingBag, ph: 'a mid-century living room under $4000', tmpl: (b) => `Make a shopping list to furnish ${b}` },
  { key: 'document', name: 'Document', desc: 'A designed Word document, on your brand.', icon: FileText, ph: 'a one-page business plan for a coffee shop', tmpl: (b) => `Write a polished document: ${b}` },
  { key: 'presentation', name: 'Deck', desc: 'A polished PowerPoint presentation, on brand.', icon: BarChart3, ph: 'a 6-slide pitch for an AI note app', tmpl: (b) => `Create a pitch deck about ${b}` },
  { key: 'spreadsheet', name: 'Spreadsheet', desc: 'A real Excel workbook with formulas, on brand.', icon: Table2, ph: 'a monthly household budget with formulas', tmpl: (b) => `Build a spreadsheet for ${b}` },
  { key: 'image', name: 'Image', desc: 'Generate a photoreal image of anything.', icon: ImageIcon, ph: 'a misty pine forest at sunrise', tmpl: (b) => `Generate an image of ${b}` },
  { key: 'video', name: 'Video', desc: 'Cinematic clips — incl. blueprint→3D grow reveals & walkthroughs.', icon: Video, ph: 'a blueprint growing into a photoreal 3D home walkthrough', tmpl: (b) => `Create a video of ${b}` },
]
const SYSTEMS = ['none', 'minimal', 'luxury', 'swiss', 'brutalist', 'editorial', 'glassmorphism', 'bauhaus', 'memphis', 'y2k', 'corporate', 'organic', 'dark neon']
const TOOL_GROUPS = [
  { name: 'Design & identity', keys: ['website', 'logo', 'palette', 'brand', 'poster', 'carousel', 'canvas'] },
  { name: 'Words & numbers', keys: ['document', 'presentation', 'spreadsheet'] },
  { name: 'Spaces & experiences', keys: ['blueprint', 'walkthrough', 'game', 'shopping'] },
  { name: 'Image & motion', keys: ['image', 'motion', 'video'] },
]
// Gallery frames are static and cannot run generated scripts. The full preview
// uses the artifact's actual card, with its editor, downloads and playback.
const thumbnailHtml = (html: string) => html.replace(/<\/head>/i, '<style>*,*::before,*::after{animation-play-state:paused!important;animation-delay:-4s!important;transition:none!important}html,body{overflow:hidden}</style></head>')

export default function StudioPanel({
  onGenerate,
  creations = [],
  onOpen,
  streaming = false,
  renderCreation,
  resultKey,
  feedback,
  onStop,
  designPreview = false,
  designEnabled = false,
}: {
  onGenerate: (prompt: string, toolKey: string, target?: Creation) => void
  creations?: Creation[]
  onOpen?: (chatId: string, mi: number) => void
  streaming?: boolean
  // Renders a creation's REAL interactive card (doc/sheet/deck/CAD/blueprint/…)
  // so every kind previews inside the Studio — not just HTML iframes.
  renderCreation?: (c: Creation) => ReactNode
  resultKey?: string
  feedback?: ReactNode
  onStop?: () => void
  designPreview?: boolean
  designEnabled?: boolean
}) {
  const reviewLayout = designEnabled || import.meta.env.DEV && designPreview
  const [toolKey, setToolKey] = useState('website')
  const [style, setStyle] = useState('none')
  const [studioView, setStudioView] = useState<'create' | 'library'>('create')
  const [showIdeas, setShowIdeas] = useState(false)
  const [mobilePreview, setMobilePreview] = useState(false)
  const [brief, setBrief] = useState('')
  const [preview, setPreview] = useState<Creation | null>(null)
  const [working, setWorking] = useState(false) // a generation kicked off here is in flight
  const [inline, setInline] = useState<Creation | null>(null) // the result shown in-Studio
  const sawStreaming = useRef(false)
  const [dismissFeedback, setDismissFeedback] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState('')
  const [libraryKind, setLibraryKind] = useState('all')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewCloseRef = useRef<HTMLButtonElement>(null)
  const previewTriggerRef = useRef<HTMLElement | null>(null)
  const editFocusRef = useRef(false)
  const previewTitleId = useId()
  const openPreview = (creation: Creation, trigger: HTMLElement) => {
    previewTriggerRef.current = trigger
    setPreview(creation)
  }
  useEffect(() => {
    if (!preview) return
    const trigger = previewTriggerRef.current
    previewCloseRef.current?.focus({ preventScroll: true })
    // Key events from the sandboxed preview cannot bubble to this document.
    // Remove the rest of the workspace from navigation while it is open.
    const disabled: HTMLElement[] = []
    let branch: HTMLElement | null = previewRef.current
    while (branch?.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement && !sibling.inert) {
          sibling.inert = true
          disabled.push(sibling)
        }
      }
      branch = branch.parentElement
      if (branch === document.body) break
    }
    return () => {
      disabled.forEach(element => { element.inert = false })
      if (editFocusRef.current) { editFocusRef.current = false; taRef.current?.focus({ preventScroll: true }) }
      else if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [preview?.key])
  const previewControls = () => Array.from(previewRef.current?.querySelectorAll<HTMLElement>(
    'a[href], area[href], button, input, select, textarea, summary, iframe, object, embed, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]',
  ) || []).filter(element => element.tabIndex >= 0 && !element.matches(':disabled, [data-preview-focus-guard]')
    && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden')
  const previewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const dialog = previewRef.current
    // React portal events bubble through the parent component even when a
    // presentation dialog lives elsewhere in the DOM. Its own keys stay there.
    if (!dialog || event.defaultPrevented || !(event.target instanceof Element)
      || event.target.closest('[role="dialog"]') !== dialog) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setPreview(null)
    } else if (event.key === 'Tab') {
      const controls = previewControls()
      const first = controls[0], last = controls[controls.length - 1]
      const active = document.activeElement
      if (!first) { event.preventDefault(); dialog.focus() }
      else if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (active === last || active === dialog)) { event.preventDefault(); first.focus() }
    }
  }
  const tool = TOOLS.find((t) => t.key === toolKey) || TOOLS[0]
  const ToolIcon = tool.icon
  const libraryKinds = [...new Set(creations.map(creation => creation.kind))]
  const visibleCreations = reviewLayout ? creations.filter(creation => (libraryKind === 'all' || creation.kind === libraryKind) && `${creation.title} ${creation.kind}`.toLowerCase().includes(libraryQuery.toLowerCase().trim())) : creations
  const inlineCard = inline ? renderCreation?.(inline) : null
  const previewCard = preview ? renderCreation?.(preview) : null
  const run = () => {
    if (working || streaming || (inline && !brief.trim())) return
    setMobilePreview(true)
    setDismissFeedback(false)
    onGenerate(inline ? brief.trim() : tool.tmpl(brief.trim() || tool.ph, tool.styled ? style : 'none'), tool.key, inline || undefined)
    sawStreaming.current = false
    setWorking(true)
  }
  // When the generation lands a new creation, show it in the Studio container.
  useEffect(() => {
    if (streaming) { sawStreaming.current = true; setWorking(true); setMobilePreview(true); return }
    if (!sawStreaming.current) return
    const result = creations.find(c => c.key === resultKey)
    if (result) setInline(result)
    setWorking(false)
    sawStreaming.current = false
  }, [streaming, creations, resultKey])
  const hasFeedback = !!feedback && !dismissFeedback
  useEffect(() => { if (hasFeedback) setMobilePreview(true) }, [hasFeedback, resultKey])
  const startNew = () => { setInline(null); setBrief(''); setDismissFeedback(true); setShowIdeas(false); setMobilePreview(false) }
  const continueEditing = (creation: Creation) => {
    const keys: Record<string, string> = { webpage: 'website', doc: 'document', deck: 'presentation', sheet: 'spreadsheet', cad: 'walkthrough', board: 'poster' }
    editFocusRef.current = true
    setToolKey(keys[creation.kind] || creation.kind)
    setInline(creation); setBrief(''); setPreview(null); setStudioView('create'); setDismissFeedback(true); setMobilePreview(false)
  }
  const pick = (k: string) => { if (k !== toolKey) { setToolKey(k); setInline(null) } }
  const startExample = (idea: string, direction: string) => {
    if (!brief.trim()) { setBrief(idea); setStyle(direction) }
    setShowIdeas(false)
    setMobilePreview(false)
    taRef.current?.focus()
  }

  return (
    <div className="ws-studio ws-feature-page flex-1 min-h-0" data-studio-design-preview={reviewLayout || undefined}>
      <div className="ws-studio-layout">
        <WorkspaceIntro label={reviewLayout ? 'Studio' : 'Nalu Studio'} title={reviewLayout ? 'An idea. A little room to make it.' : "Let's make something."} description={reviewLayout ? 'Choose your medium, find your direction, and make something yours.' : 'A page, a picture, a whole new idea. Pick a tool and tell Nalu what you have in mind.'}/>

        <div className="ws-studio-toolbar">
          <nav className="ws-segments" aria-label="Studio views">
            <button aria-pressed={studioView === 'create'} onClick={() => setStudioView('create')}>Create</button>
            <button aria-pressed={studioView === 'library'} onClick={() => setStudioView('library')}>Your creations <span>{creations.length}</span></button>
          </nav>
          <div role="group" aria-label="Studio tools" className="ws-studio-tools" hidden={studioView !== 'create'}>
            <label>Make <select aria-label="Studio tool" value={toolKey} onChange={e => { pick(e.target.value); setShowIdeas(false) }} disabled={working}>{TOOLS.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
          </div>
        </div>
        <div className="ws-studio-workbench" data-preview={mobilePreview} hidden={studioView !== 'create'}>
        {reviewLayout && <aside className="review-studio-toolbox" aria-label="Creation tools">
          <div className="review-toolbox-heading"><span>Your toolkit</span><small>{TOOLS.length} ways to create</small></div>
          {TOOL_GROUPS.map(group => <section key={group.name}><h3>{group.name}</h3><div>
            {group.keys.map(key => {
              const item = TOOLS.find(candidate => candidate.key === key)!
              const Icon = item.icon
              return <button key={key} type="button" aria-pressed={toolKey === key} disabled={working} title={item.desc}
                onClick={() => { pick(key); setShowIdeas(false) }}><Icon size={18} strokeWidth={1.5}/><span>{item.name}</span></button>
            })}
          </div></section>)}
        </aside>}
        {/* Design screen — the result shows HERE, above the prompt bar */}
        <div className="ws-studio-preview">
          <div className="flex items-center justify-between gap-3 border-b border-glass/[0.07] px-4 py-2.5">
            <button className="ws-mobile-preview-toggle" onClick={() => setMobilePreview(false)}>Edit brief</button>
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
              {working && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-glass/20 border-t-accent" />}
              <span className="truncate">{working ? `Designing your ${tool.name.toLowerCase()}…` : inline ? inline.title : toolKey === 'website' ? 'Website canvas' : `${tool.name} preview`}</span>
            </span>
            {inline && !working && (
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={(event) => openPreview(inline, event.currentTarget)} className="rounded-md bg-glass/10 px-2.5 py-1 text-[11px] text-ink hover:bg-glass/20">Full screen</button>
                {onOpen && <button onClick={() => onOpen(inline.chatId, inline.mi)} className="rounded-md bg-glass/10 px-2.5 py-1 text-[11px] text-ink hover:bg-glass/20">Open in chat</button>}
                <button aria-label="Dismiss creation preview" onClick={() => setInline(null)} className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-glass/10 hover:text-ink"><X size={14} /></button>
              </div>
            )}
          </div>
          <div className="ws-studio-preview-body">
            {working ? (
              <div className="ws-studio-wait flex flex-col items-center justify-center gap-2 text-[12px] text-dim">
                <span className="h-7 w-7 animate-spin rounded-full border-2 border-glass/15 border-t-accent" />
                <span>Nalu is composing it — it’ll appear here and in your chat.</span>
                {onStop && <button onClick={onStop} className="ws-idea-pill">Stop generation</button>}
              </div>
            ) : hasFeedback ? feedback : inlineCard ? (
              <div className="ws-studio-result p-4">{inlineCard}</div>
            ) : inline?.html ? (
              inline.kind === 'motion' ? <MotionPreview html={inline.html} motion={inline.motion} /> : <iframe title={inline.title} srcDoc={inline.html} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="ws-studio-frame w-full border-0 bg-white" />
            ) : inline ? (
              <button onClick={() => onOpen?.(inline.chatId, inline.mi)}
                className="ws-studio-wait flex w-full flex-col items-center justify-center gap-3 text-dim transition-colors hover:text-ink">
                <span className="text-[12px]">Open “{inline.title}” in chat to view &amp; download</span>
              </button>
            ) : !showIdeas ? (
              <div className={`ws-studio-empty${reviewLayout ? ' review-studio-canvas-empty' : ''}`}>
                {reviewLayout ? <NaluMark className="review-empty-logo"/> : <NaluAvatar size={210} />}
                <h2>{reviewLayout ? <>Your next <em>{tool.name.toLowerCase()}.</em></> : 'A little space for your idea.'}</h2>
                <p>{tool.desc}</p>
                <button className="ws-idea-pill" onClick={() => setShowIdeas(true)}>Explore starting points <ArrowRight size={13}/></button>
                {reviewLayout && creations.length > 0 && <div className="review-studio-recent"><span>Or pick up where you left off</span><div>{creations.slice(0, 3).map(creation => {
                  return <button key={creation.key} onClick={event => openPreview(creation, event.currentTarget)}>{ReviewArtifactPreview && <div className="review-recent-preview"><Suspense fallback={<span>Loading saved preview…</span>}><ReviewArtifactPreview source={creation.previewData} title={creation.title} kind={creation.kind} html={creation.html} img={creation.img} compact/></Suspense></div>}<span>{creation.title}</span><ArrowRight size={13}/></button>
                })}</div></div>}
              </div>
            ) : toolKey === 'website' ? (
              <WebsiteStarter hasBrief={!!brief.trim()} onWrite={() => taRef.current?.focus()} onStart={startExample} />
            ) : (
              <StudioStarter key={toolKey} tool={tool} hasBrief={!!brief.trim()} onWrite={() => taRef.current?.focus()} onStart={startExample} />
            )}
          </div>
        </div>

        {/* Prompt bar */}
        <div className="ws-studio-brief">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div className="ws-brief-title">{inline ? 'Keep creating.' : tool.name}</div>
            <div className="ws-brief-description text-[11px] text-dim">{inline ? `Editing ${inline.title}. Describe what to change; the current version stays saved.` : tool.desc}</div>
            {inline && <button className="ws-start-new" onClick={startNew} disabled={working}>Start a new creation</button>}
          </div>

          {tool.styled && !inline && <label className="ws-style-select">Style <select aria-label="Design style" value={style} onChange={e => setStyle(e.target.value)}>{SYSTEMS.map(s => <option key={s} value={s}>{s === 'none' ? 'Let Nalu choose' : s}</option>)}</select></label>}
          <label className="ws-brief-label" htmlFor="studio-brief">Your idea</label>

          <textarea
            id="studio-brief"
            ref={taRef}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run() } }}
            rows={reviewLayout ? 2 : 5}
            placeholder={inline ? 'What would you like to change or add?' : `Describe your ${tool.name.toLowerCase()} — e.g. “${tool.ph}”`}
            className="max-h-44 w-full resize-none bg-transparent py-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-dim"
          />
          <div className="mt-2 flex items-center justify-between border-t border-glass/[0.07] pt-3">
            <span className="ws-studio-shortcut text-[10px] text-dim">⌘/Ctrl + Enter</span>
            <button className="ws-mobile-preview-toggle" onClick={() => setMobilePreview(true)}>Preview <Eye size={13}/></button>
            <button onClick={run} disabled={working || streaming || (!!inline && !brief.trim())}
              className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-[#c9a86a] to-accent px-5 py-2 text-[13px] font-semibold tracking-wide text-[#15170f] shadow-md transition-[filter,transform] hover:brightness-110 active:scale-[0.98]">
              {inline ? 'Update creation' : 'Generate'} <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>

        </div>

        {/* Your creations — preview anything built in the Studio, right here */}
        {studioView === 'library' && (
          <div className="ws-studio-library">
            <div className="mb-4 flex items-center gap-3">
              <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-dim">Your creations</span>
              <span className="h-px flex-1 bg-glass/[0.08]" />
              <span className="text-[10px] text-dim">{creations.length}</span>
            </div>
            {!creations.length && <div className="ws-library-empty">{reviewLayout ? <NaluMark className="review-empty-logo"/> : <NaluAvatar size={180}/>}<h2>Good things start here.</h2><p>Your creations will be waiting in this space.</p><button className="ws-idea-pill" onClick={() => setStudioView('create')}>Make your first creation <ArrowRight size={13}/></button></div>}
            {reviewLayout && creations.length > 0 && <div className="review-library-controls">
              <label><Search size={17}/><input aria-label="Search creations" placeholder="Find something you made…" value={libraryQuery} onChange={event => setLibraryQuery(event.target.value)}/></label>
              <div className="review-library-filters" aria-label="Filter creations"><button aria-pressed={libraryKind === 'all'} onClick={() => setLibraryKind('all')}>All work <span>{creations.length}</span></button>{libraryKinds.map(kind => <button key={kind} aria-pressed={libraryKind === kind} onClick={() => setLibraryKind(kind)}>{kind}<span>{creations.filter(creation => creation.kind === kind).length}</span></button>)}</div>
              {!visibleCreations.length && <p role="status">No creations match this search.</p>}
            </div>}
            <div className="review-library-grid grid grid-cols-2 gap-3 sm:grid-cols-3">
              {visibleCreations.map((c) => {
                const previewable = !!c.html || !!c.img || !!renderCreation
                return (
                  <button key={c.key} onClick={(event) => (previewable ? openPreview(c, event.currentTarget) : onOpen?.(c.chatId, c.mi))}
                    data-creation-kind={c.kind}
                    className="group overflow-hidden rounded-xl border border-glass/[0.08] bg-glass/[0.02] text-left transition-all hover:border-accent/40">
                    <div className="relative h-32 w-full overflow-hidden bg-canvas">
                      {reviewLayout && ReviewArtifactPreview ? <Suspense fallback={<div className="artifact-preview-unavailable"><strong>{c.title}</strong><p>Loading saved preview…</p></div>}><ReviewArtifactPreview source={c.previewData} kind={c.kind} title={c.title} html={c.html} img={c.img}/></Suspense> : c.html && c.kind === 'motion' ? <MotionPreview html={c.html} motion={c.motion} thumbnail /> : c.html ? (
                        <iframe title={c.title} srcDoc={thumbnailHtml(c.html)} scrolling="no" tabIndex={-1} sandbox="" aria-hidden="true"
                          className="pointer-events-none h-[420px] w-[200%] origin-top-left scale-50 border-0" />
                      ) : c.img ? (
                        <img src={c.img} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center px-3 text-center text-[11px] uppercase tracking-[0.14em] text-dim">{c.kind}</div>
                      )}
                      {!reviewLayout && <span className="absolute right-1.5 top-1.5 rounded bg-canvas px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink shadow-sm">{c.kind}</span>}
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{c.title}</span>
                      {previewable ? <Eye size={12} className="shrink-0 text-dim group-hover:text-gold" /> : <ArrowRight size={12} className="shrink-0 text-dim" />}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Full-screen preview of ANY creation — HTML in an iframe, everything
          else via its real interactive card (doc/sheet/deck/CAD/blueprint/…). */}
      {preview && (
        <div ref={previewRef} role="dialog" aria-modal="true" aria-labelledby={previewTitleId} tabIndex={-1}
          className="fixed inset-0 z-50 flex flex-col bg-canvas outline-none"
          onKeyDown={previewKeyDown} onClick={(event) => { if (event.target === event.currentTarget) setPreview(null) }}>
          <span tabIndex={0} aria-hidden="true" data-preview-focus-guard className="sr-only" onFocus={() => { const controls = previewControls(); controls[controls.length - 1]?.focus() }} />
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
            <h2 id={previewTitleId} className="min-w-0 flex-1 basis-full truncate text-sm text-ink sm:basis-auto">{preview.title || 'Creation preview'}</h2>
            <div className="flex shrink-0 items-center gap-2">
              <button onClick={() => continueEditing(preview)} className="rounded-md bg-glass/10 px-2.5 py-1 text-[12px] text-ink hover:bg-glass/20">Continue editing</button>
              {onOpen && (
                <button onClick={() => { onOpen(preview.chatId, preview.mi); setPreview(null) }}
                  className="rounded-md bg-glass/10 px-2.5 py-1 text-[12px] text-ink hover:bg-glass/20">Open in chat</button>
              )}
              <button ref={previewCloseRef} aria-label="Close preview" onClick={() => setPreview(null)} className="flex h-7 w-7 items-center justify-center rounded-md bg-glass/10 text-ink hover:bg-glass/20"><X size={15} /></button>
            </div>
          </div>
          {preview.html && !previewCard ? (
            preview.kind === 'motion' ? <MotionPreview html={preview.html} motion={preview.motion} /> : <iframe title={preview.title} srcDoc={preview.html} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="w-full flex-1 border-0 bg-white" onClick={(e) => e.stopPropagation()} />
          ) : (
            <div className="w-full flex-1 overflow-y-auto bg-canvas p-4" onClick={(e) => e.stopPropagation()}>
              <div className="mx-auto max-w-4xl">
                {previewCard || (
                  <div className="flex h-[60vh] items-center justify-center text-[13px] text-dim">Open this creation in chat to view it.</div>
                )}
              </div>
            </div>
          )}
          <span tabIndex={0} aria-hidden="true" data-preview-focus-guard className="sr-only" onFocus={() => previewControls()[0]?.focus()} />
        </div>
      )}
    </div>
  )
}
