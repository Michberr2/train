import { useRef, useState } from 'react'
import {
  Globe, Sparkles, Palette, BookOpen, Ruler, Footprints, Film, ShoppingBag,
  Image as ImageIcon, FileText, BarChart3, Table2, Video, PenTool, LayoutTemplate,
  ArrowRight, type LucideIcon,
} from 'lucide-react'

// Nalu Studio — quiet-luxury design workspace. Restrained monochrome + a single
// gold accent, serif display type, hairline rules. Pick a tool, optionally a
// design system, describe a brief, Generate → runs the real generator.
const SERIF = "'Cormorant Garamond', Georgia, 'Times New Roman', serif"

type Tool = { key: string; name: string; desc: string; icon: LucideIcon; styled?: boolean; ph: string; tmpl: (b: string, s: string) => string }
const sp = (s: string) => (s && s !== 'none' ? `${s} ` : '')
const TOOLS: Tool[] = [
  { key: 'website', name: 'Website', desc: 'A complete, downloadable landing page or web app.', icon: Globe, styled: true, ph: 'a boutique coffee roaster called Ember', tmpl: (b, s) => `Build a polished ${sp(s)}landing page for ${b}` },
  { key: 'logo', name: 'Logo', desc: 'Clean vector marks and AI logo images, on brand.', icon: Sparkles, styled: true, ph: 'Ember, a coastal coffee brand', tmpl: (b, s) => `Design a ${sp(s)}logo for ${b}` },
  { key: 'palette', name: 'Palette', desc: 'A cohesive, accessible color palette to save.', icon: Palette, ph: 'a calm wellness app', tmpl: (b) => `Create a color palette for ${b}` },
  { key: 'brand', name: 'Brand book', desc: 'A polished, multi-page brand guidelines book.', icon: BookOpen, styled: true, ph: 'Aurora, a fintech startup', tmpl: (b, s) => `Create ${sp(s)}brand guidelines for ${b}` },
  { key: 'blueprint', name: 'Blueprint', desc: 'Floor plans, dimensioned and to scale, with 3D.', icon: Ruler, ph: 'a 3-bedroom house with an open kitchen', tmpl: (b) => `Design a detailed floor plan for ${b}` },
  { key: 'walkthrough', name: 'Walkthrough', desc: 'Walk a furnished 3D house and record a tour.', icon: Footprints, ph: 'a 2-bedroom apartment with a balcony', tmpl: (b) => `Design a house I can walk through in 3D: ${b}` },
  { key: 'motion', name: 'Motion', desc: 'A looping animated title or logo reveal.', icon: Film, styled: true, ph: 'an Ember logo reveal', tmpl: (b, s) => `Create a ${sp(s)}animated motion graphic for ${b}` },
  { key: 'poster', name: 'Poster', desc: 'A bold poster or infographic, downloadable.', icon: LayoutTemplate, styled: true, ph: 'a summer jazz festival', tmpl: (b, s) => `Design a ${sp(s)}poster for ${b}` },
  { key: 'canvas', name: 'Canvas', desc: 'An editable vector graphic, Figma-like.', icon: PenTool, styled: true, ph: 'an Instagram post announcing a sale', tmpl: (b, s) => `Make an editable ${sp(s)}social graphic for ${b}` },
  { key: 'shopping', name: 'Shopping', desc: 'A curated list, then see it in a 3D room.', icon: ShoppingBag, ph: 'a mid-century living room under $4000', tmpl: (b) => `Make a shopping list to furnish ${b}` },
  { key: 'document', name: 'Document', desc: 'A designed Word document, on your brand.', icon: FileText, ph: 'a one-page business plan for a coffee shop', tmpl: (b) => `Write a polished document: ${b}` },
  { key: 'presentation', name: 'Deck', desc: 'A polished PowerPoint presentation, on brand.', icon: BarChart3, ph: 'a 6-slide pitch for an AI note app', tmpl: (b) => `Create a pitch deck about ${b}` },
  { key: 'spreadsheet', name: 'Spreadsheet', desc: 'A real Excel workbook with formulas, on brand.', icon: Table2, ph: 'a monthly household budget with formulas', tmpl: (b) => `Build a spreadsheet for ${b}` },
  { key: 'image', name: 'Image', desc: 'Generate a photoreal image of anything.', icon: ImageIcon, ph: 'a misty pine forest at sunrise', tmpl: (b) => `Generate an image of ${b}` },
  { key: 'video', name: 'Video', desc: 'Generate a short cinematic video clip.', icon: Video, ph: 'a slow ocean wave at golden hour', tmpl: (b) => `Create a video of ${b}` },
]
const SYSTEMS = ['none', 'minimal', 'luxury', 'swiss', 'brutalist', 'editorial', 'glassmorphism', 'bauhaus', 'memphis', 'y2k', 'corporate', 'organic', 'dark neon']

export default function StudioPanel({ onGenerate }: { onGenerate: (prompt: string) => void }) {
  const [toolKey, setToolKey] = useState('website')
  const [style, setStyle] = useState('none')
  const [brief, setBrief] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const tool = TOOLS.find((t) => t.key === toolKey) || TOOLS[0]
  const run = () => onGenerate(tool.tmpl(brief.trim() || tool.ph, tool.styled ? style : 'none'))
  const pick = (k: string) => { setToolKey(k); setTimeout(() => taRef.current?.focus(), 30) }

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: 'radial-gradient(900px 460px at 50% -10%, rgba(175,140,86,0.08), transparent 62%)' }}>
      <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
        {/* Header */}
        <div className="text-center">
          <div className="text-[11px] uppercase tracking-[0.34em] text-[#c9b891]">Nalu Studio</div>
          <h2 style={{ fontFamily: SERIF }} className="mt-3 text-[2.6rem] font-light leading-[1.05] text-white sm:text-5xl">
            Make something beautiful
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-[#9a9a9a]">
            Choose a tool, set a design system, describe it — Nalu crafts the finished piece and streams it into your chat, themed by your palette.
          </p>
          <div className="mx-auto mt-6 h-px w-14 bg-gradient-to-r from-transparent via-[#AF8C56] to-transparent" />
        </div>

        {/* Composer */}
        <div className="mt-8 rounded-2xl border border-[#AF8C56]/20 bg-white/[0.03] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:p-5">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div style={{ fontFamily: SERIF }} className="text-xl italic text-[#ece6d8]">{tool.name}</div>
            <div className="truncate text-[11px] text-[#7e8696]">{tool.desc}</div>
          </div>

          {tool.styled && (
            <div className="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="shrink-0 pr-1 text-[10px] uppercase tracking-[0.2em] text-[#6e7686]">Style</span>
              {SYSTEMS.map((s) => (
                <button key={s} onClick={() => setStyle(s)}
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] capitalize transition-colors ${style === s ? 'border-[#AF8C56] bg-[#AF8C56]/15 text-[#e2c896]' : 'border-white/10 text-[#9a9a9a] hover:border-white/25'}`}>
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
            className="max-h-44 w-full resize-none bg-transparent py-1 text-[15px] leading-relaxed text-[#ededed] outline-none placeholder:text-[#5f6675]"
          />
          <div className="mt-2 flex items-center justify-between border-t border-white/[0.07] pt-3">
            <span className="text-[10px] text-[#6e7686]">⌘/Ctrl + Enter</span>
            <button onClick={run}
              className="group flex items-center gap-2 rounded-full bg-gradient-to-r from-[#c9a86a] to-[#AF8C56] px-5 py-2 text-[13px] font-semibold tracking-wide text-[#15170f] shadow-md transition-[filter,transform] hover:brightness-110 active:scale-[0.98]">
              Generate <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>

        {/* Tools */}
        <div className="mb-4 mt-10 flex items-center gap-3">
          <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-[#7e8696]">The tools</span>
          <span className="h-px flex-1 bg-white/[0.08]" />
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {TOOLS.map((t) => {
            const Icon = t.icon
            const on = t.key === toolKey
            return (
              <button key={t.key} onClick={() => pick(t.key)}
                className={`group flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200 ${
                  on ? 'border-[#AF8C56]/50 bg-[#AF8C56]/[0.07]' : 'border-white/[0.07] hover:border-[#AF8C56]/30 hover:bg-white/[0.03]'
                }`}>
                <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${on ? 'border-[#AF8C56]/40 text-[#e2c896]' : 'border-white/10 text-[#a8a299] group-hover:text-[#d8cfbf]'}`}>
                  <Icon size={14} strokeWidth={1.6} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-[#ededed]">{t.name}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-[#838893]">{t.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
