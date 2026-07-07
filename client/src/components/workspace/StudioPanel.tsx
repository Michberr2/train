import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Globe, Sparkles, Palette, BookOpen, Ruler, Footprints, Film, ShoppingBag,
  Image as ImageIcon, FileText, BarChart3, Table2, Video, PenTool, LayoutTemplate,
  ArrowRight, Eye, X, Gamepad2, GalleryHorizontal, type LucideIcon,
} from 'lucide-react'

// A thing Nalu built (across all chats), surfaced in the Studio gallery.
export type Creation = { key: string; chatId: string; mi: number; kind: string; title: string; html?: string; img?: string }
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
  { key: 'website', name: 'Website', desc: 'A complete, downloadable landing page or web app.', icon: Globe, styled: true, ph: 'a boutique coffee roaster called Ember', tmpl: (b, s) => `Build a polished ${sp(s)}landing page for ${b}` },
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

export default function StudioPanel({
  onGenerate,
  creations = [],
  onOpen,
  streaming = false,
  renderCreation,
}: {
  onGenerate: (prompt: string) => void
  creations?: Creation[]
  onOpen?: (chatId: string, mi: number) => void
  streaming?: boolean
  // Renders a creation's REAL interactive card (doc/sheet/deck/CAD/blueprint/…)
  // so every kind previews inside the Studio — not just HTML iframes.
  renderCreation?: (c: Creation) => ReactNode
}) {
  const [toolKey, setToolKey] = useState('website')
  const [style, setStyle] = useState('none')
  const [brief, setBrief] = useState('')
  const [preview, setPreview] = useState<Creation | null>(null)
  const [working, setWorking] = useState(false) // a generation kicked off here is in flight
  const [inline, setInline] = useState<Creation | null>(null) // the result shown in-Studio
  const baseRef = useRef(0)
  const sawStreaming = useRef(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const tool = TOOLS.find((t) => t.key === toolKey) || TOOLS[0]
  const run = () => {
    onGenerate(tool.tmpl(brief.trim() || tool.ph, tool.styled ? style : 'none'))
    baseRef.current = creations.length
    sawStreaming.current = false
    setInline(null)
    setWorking(true)
  }
  // When the generation lands a new creation, show it in the Studio container.
  useEffect(() => {
    if (!working) return
    if (creations.length > baseRef.current) { setInline(creations[0]); setWorking(false); return }
    if (streaming) { sawStreaming.current = true; return }
    if (sawStreaming.current) setWorking(false) // finished without a designable artifact
  }, [working, streaming, creations])
  const pick = (k: string) => { setToolKey(k); setTimeout(() => taRef.current?.focus(), 30) }

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: 'radial-gradient(900px 460px at 50% -10%, rgba(175,140,86,0.08), transparent 62%)' }}>
      <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        {/* Header */}
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-[0.34em] text-gold">Nalu Studio</div>
          <h2 style={{ fontFamily: SERIF }} className="mt-3 text-[2.6rem] font-light leading-[1.05] text-ink sm:text-5xl">
            Make something beautiful
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-dim">
            Choose a tool, set a design system, describe it — Nalu crafts the finished piece and streams it into your chat, themed by your palette.
          </p>
          <div className="mx-auto mt-6 h-px w-14 bg-gradient-to-r from-transparent via-accent to-transparent" />
        </div>

        {/* Tools — a compact selectable list, up top (pick what to make) */}
        <div className="mt-8 flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TOOLS.map((t) => {
            const on = t.key === toolKey
            return (
              <button key={t.key} onClick={() => pick(t.key)} title={t.desc}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] transition-colors ${
                  on ? 'border-accent bg-accent/15 text-gold' : 'border-glass/10 text-dim hover:border-glass/25 hover:text-gold'
                }`}>
                {t.name}
              </button>
            )
          })}
        </div>

        {/* Design screen — the result shows HERE, above the prompt bar */}
        <div className="mt-5 overflow-hidden rounded-2xl border border-accent/25 bg-glass/[0.02] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
          <div className="flex items-center justify-between gap-3 border-b border-glass/[0.07] px-4 py-2.5">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink">
              {working && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-glass/20 border-t-accent" />}
              <span className="truncate">{working ? `Designing your ${tool.name.toLowerCase()}…` : inline ? inline.title : `${tool.name} preview`}</span>
            </span>
            {inline && !working && (
              <div className="flex shrink-0 items-center gap-2">
                {inline.html && <button onClick={() => setPreview(inline)} className="rounded-md bg-glass/10 px-2.5 py-1 text-[11px] text-ink hover:bg-glass/20">Full screen</button>}
                {onOpen && <button onClick={() => onOpen(inline.chatId, inline.mi)} className="rounded-md bg-glass/10 px-2.5 py-1 text-[11px] text-ink hover:bg-glass/20">Open in chat</button>}
                <button onClick={() => setInline(null)} className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-glass/10 hover:text-ink"><X size={14} /></button>
              </div>
            )}
          </div>
          <div className="bg-canvas">
            {working ? (
              <div className="flex h-[62vh] flex-col items-center justify-center gap-2 text-[12px] text-dim">
                <span className="h-7 w-7 animate-spin rounded-full border-2 border-glass/15 border-t-accent" />
                <span>Nalu is composing it — it’ll appear here and in your chat.</span>
              </div>
            ) : inline?.html ? (
              <iframe title={inline.title} srcDoc={inline.html} className="h-[82vh] w-full border-0 bg-white" />
            ) : inline && renderCreation?.(inline) ? (
              <div className="max-h-[82vh] overflow-y-auto p-4">{renderCreation(inline)}</div>
            ) : inline ? (
              <button onClick={() => onOpen?.(inline.chatId, inline.mi)}
                className="flex h-[62vh] w-full flex-col items-center justify-center gap-3 text-dim transition-colors hover:text-ink">
                <span className="text-[12px]">Open “{inline.title}” in chat to view &amp; download</span>
              </button>
            ) : (
              <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-dim">
                <span className="text-[13px]">Your {tool.name.toLowerCase()} will appear here</span>
              </div>
            )}
          </div>
        </div>

        {/* Prompt bar */}
        <div className="mt-5 rounded-2xl border border-accent/20 bg-glass/[0.03] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div style={{ fontFamily: SERIF }} className="text-xl italic text-ink">{tool.name}</div>
            <div className="truncate text-[11px] text-dim">{tool.desc}</div>
          </div>

          {tool.styled && (
            <div className="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="shrink-0 pr-1 text-[10px] uppercase tracking-[0.2em] text-dim">Style</span>
              {SYSTEMS.map((s) => (
                <button key={s} onClick={() => setStyle(s)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] capitalize transition-colors ${style === s ? 'border-accent bg-accent/15 text-gold' : 'border-glass/10 text-dim hover:border-glass/25'}`}>
                  {s === 'none' ? 'Default' : s}
                </button>
              ))}
            </div>
          )}

          <textarea
            ref={taRef}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run() } }}
            rows={2}
            placeholder={`Describe your ${tool.name.toLowerCase()} — e.g. “${tool.ph}”`}
            className="max-h-44 w-full resize-none bg-transparent py-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-dim"
          />
          <div className="mt-2 flex items-center justify-between border-t border-glass/[0.07] pt-3">
            <span className="text-[10px] text-dim">⌘/Ctrl + Enter</span>
            <button onClick={run}
              className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-[#c9a86a] to-accent px-5 py-2 text-[13px] font-semibold tracking-wide text-[#15170f] shadow-md transition-[filter,transform] hover:brightness-110 active:scale-[0.98]">
              Generate <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>

        {/* Your creations — preview anything built in the Studio, right here */}
        {creations.length > 0 && (
          <>
            <div className="mb-4 mt-12 flex items-center gap-3">
              <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-dim">Your creations</span>
              <span className="h-px flex-1 bg-glass/[0.08]" />
              <span className="text-[10px] text-dim">{creations.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {creations.map((c) => {
                const previewable = !!c.html || !!c.img || !!renderCreation
                return (
                  <button key={c.key} onClick={() => (previewable ? setPreview(c) : onOpen?.(c.chatId, c.mi))}
                    className="group overflow-hidden rounded-xl border border-glass/[0.08] bg-glass/[0.02] text-left transition-all hover:border-accent/40">
                    <div className="relative h-32 w-full overflow-hidden bg-canvas">
                      {c.html ? (
                        <iframe title={c.title} srcDoc={c.html} scrolling="no" tabIndex={-1}
                          className="pointer-events-none h-[420px] w-[200%] origin-top-left scale-50 border-0" />
                      ) : c.img ? (
                        <img src={c.img} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center px-3 text-center text-[11px] uppercase tracking-[0.14em] text-dim">{c.kind}</div>
                      )}
                      <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-gold backdrop-blur">{c.kind}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{c.title}</span>
                      {previewable ? <Eye size={12} className="shrink-0 text-dim group-hover:text-gold" /> : <ArrowRight size={12} className="shrink-0 text-dim" />}
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Full-screen preview of ANY creation — HTML in an iframe, everything
          else via its real interactive card (doc/sheet/deck/CAD/blueprint/…). */}
      {preview && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur" onClick={() => setPreview(null)}>
          <div className="flex items-center justify-between gap-3 px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
            <span className="truncate text-sm text-ink">{preview.title}</span>
            <div className="flex shrink-0 items-center gap-2">
              {onOpen && (
                <button onClick={() => { onOpen(preview.chatId, preview.mi); setPreview(null) }}
                  className="rounded-md bg-glass/10 px-2.5 py-1 text-[12px] text-ink hover:bg-glass/20">Open in chat</button>
              )}
              <button onClick={() => setPreview(null)} className="flex h-7 w-7 items-center justify-center rounded-md bg-glass/10 text-ink hover:bg-glass/20"><X size={15} /></button>
            </div>
          </div>
          {preview.html ? (
            <iframe title={preview.title} srcDoc={preview.html} className="w-full flex-1 border-0 bg-white" onClick={(e) => e.stopPropagation()} />
          ) : (
            <div className="w-full flex-1 overflow-y-auto bg-canvas p-4" onClick={(e) => e.stopPropagation()}>
              <div className="mx-auto max-w-4xl">
                {renderCreation?.(preview) || (
                  <div className="flex h-[60vh] items-center justify-center text-[13px] text-dim">Open this creation in chat to view it.</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
