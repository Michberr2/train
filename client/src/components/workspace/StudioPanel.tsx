import { useRef, useState } from 'react'
import {
  Globe, Sparkles, Palette, BookOpen, Ruler, Footprints, Film, ShoppingBag,
  Image as ImageIcon, FileText, BarChart3, Table2, Video, PenTool, LayoutTemplate,
  ArrowUp, type LucideIcon,
} from 'lucide-react'

// Nalu Studio — a polished, fully-functional design workspace: pick a tool from
// the gallery, optionally a design system, describe a brief, and Generate. It
// builds the real prompt and runs the generator; the result streams into chat.
type Tool = {
  key: string; name: string; desc: string; icon: LucideIcon; tint: string
  styled?: boolean; tmpl: (brief: string, style: string) => string; ph: string
}
const sp = (s: string) => (s && s !== 'none' ? `${s} ` : '')
const TOOLS: Tool[] = [
  { key: 'website', name: 'Website', desc: 'A complete, downloadable landing page or web app.', icon: Globe, tint: 'text-fuchsia-300 bg-fuchsia-500/15', styled: true, ph: 'a boutique coffee roaster called Ember', tmpl: (b, s) => `Build a polished ${sp(s)}landing page for ${b}` },
  { key: 'logo', name: 'Logo', desc: 'Clean SVG marks + AI logo images in your brand color.', icon: Sparkles, tint: 'text-amber-300 bg-amber-500/15', styled: true, ph: 'Ember, a coastal coffee brand', tmpl: (b, s) => `Design a ${sp(s)}logo for ${b}` },
  { key: 'palette', name: 'Color palette', desc: 'An accessible, cohesive palette you can save.', icon: Palette, tint: 'text-pink-300 bg-pink-500/15', ph: 'a calm wellness app', tmpl: (b) => `Create a color palette for ${b}` },
  { key: 'brand', name: 'Brand book', desc: 'A polished multi-page brand guidelines book.', icon: BookOpen, tint: 'text-indigo-300 bg-indigo-500/15', styled: true, ph: 'Aurora, a fintech startup', tmpl: (b, s) => `Create ${sp(s)}brand guidelines for ${b}` },
  { key: 'blueprint', name: 'Blueprint', desc: 'Multi-floor plans, dimensioned, to scale, with 3D.', icon: Ruler, tint: 'text-sky-300 bg-sky-500/15', ph: 'a 3-bedroom modern house with an open kitchen', tmpl: (b) => `Design a detailed floor plan for ${b}` },
  { key: 'walkthrough', name: '3D walkthrough', desc: 'Walk a furnished 3D house and record a tour.', icon: Footprints, tint: 'text-emerald-300 bg-emerald-500/15', ph: 'a 2-bedroom apartment with a balcony', tmpl: (b) => `Design a house I can walk through in 3D: ${b}` },
  { key: 'motion', name: 'Motion graphic', desc: 'A looping animated title or logo reveal.', icon: Film, tint: 'text-violet-300 bg-violet-500/15', styled: true, ph: 'an Ember logo reveal', tmpl: (b, s) => `Create a ${sp(s)}animated motion graphic for ${b}` },
  { key: 'poster', name: 'Poster', desc: 'A bold poster or infographic, downloadable.', icon: LayoutTemplate, tint: 'text-rose-300 bg-rose-500/15', styled: true, ph: 'a summer jazz festival', tmpl: (b, s) => `Design a ${sp(s)}poster for ${b}` },
  { key: 'canvas', name: 'Canvas', desc: 'An editable vector graphic (Figma-like).', icon: PenTool, tint: 'text-teal-300 bg-teal-500/15', styled: true, ph: 'an Instagram post announcing a sale', tmpl: (b, s) => `Make an editable ${sp(s)}social graphic for ${b}` },
  { key: 'shopping', name: 'Shopping list', desc: 'Curated products + see them in a 3D room.', icon: ShoppingBag, tint: 'text-amber-200 bg-amber-500/10', ph: 'a cozy mid-century living room under $4000', tmpl: (b) => `Make a shopping list to furnish ${b}` },
  { key: 'document', name: 'Document', desc: 'A designed Word doc, on your brand.', icon: FileText, tint: 'text-blue-300 bg-blue-500/15', ph: 'a one-page business plan for a coffee shop', tmpl: (b) => `Write a polished document: ${b}` },
  { key: 'presentation', name: 'Presentation', desc: 'A polished PowerPoint deck, on your brand.', icon: BarChart3, tint: 'text-orange-300 bg-orange-500/15', ph: 'a 6-slide pitch for an AI note-taking app', tmpl: (b) => `Create a pitch deck about ${b}` },
  { key: 'spreadsheet', name: 'Spreadsheet', desc: 'A real Excel workbook with formulas, on-brand.', icon: Table2, tint: 'text-green-300 bg-green-500/15', ph: 'a monthly household budget with formulas', tmpl: (b) => `Build a spreadsheet for ${b}` },
  { key: 'image', name: 'Image', desc: 'Generate a photoreal image of anything.', icon: ImageIcon, tint: 'text-cyan-300 bg-cyan-500/15', ph: 'a misty pine forest at sunrise', tmpl: (b) => `Generate an image of ${b}` },
  { key: 'video', name: 'Video', desc: 'Generate a short video clip from a prompt.', icon: Video, tint: 'text-red-300 bg-red-500/15', ph: 'a slow ocean wave at golden hour', tmpl: (b) => `Create a video of ${b}` },
]
const SYSTEMS = ['none', 'minimal', 'luxury', 'swiss', 'brutalist', 'editorial', 'glassmorphism', 'bauhaus', 'memphis', 'y2k', 'corporate', 'organic', 'dark neon']

export default function StudioPanel({ onGenerate }: { onGenerate: (prompt: string) => void }) {
  const [toolKey, setToolKey] = useState('website')
  const [style, setStyle] = useState('none')
  const [brief, setBrief] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const tool = TOOLS.find((t) => t.key === toolKey) || TOOLS[0]
  const TIcon = tool.icon
  const run = () => onGenerate(tool.tmpl(brief.trim() || tool.ph, tool.styled ? style : 'none'))
  const pick = (k: string) => { setToolKey(k); setTimeout(() => taRef.current?.focus(), 30) }

  return (
    <div
      className="flex-1 overflow-y-auto"
      style={{ background: 'radial-gradient(1100px 520px at 50% -8%, rgba(175,140,86,0.10), transparent 60%)' }}
    >
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#c9a86a] to-[#8c6f43] text-[#12140d] shadow-lg">
            <Sparkles size={20} />
          </div>
          <h2 className="text-2xl font-light tracking-tight text-white sm:text-[28px]">Nalu Studio</h2>
          <p className="mx-auto mt-1.5 max-w-xl text-sm text-[#9a9a9a]">
            Pick a tool, add a design system, describe it, and generate. Nalu builds the real artifact and streams it into your chat — themed by your active palette.
          </p>
        </div>

        {/* Composer — the focal point */}
        <div className="rounded-3xl border border-white/[0.1] bg-white/[0.04] p-2 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.55)] backdrop-blur-2xl">
          <div className="rounded-[20px] border border-white/[0.06] bg-[#0b0e16]/70 p-3.5 sm:p-4">
            <div className="mb-3 flex items-center gap-2.5">
              <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${tool.tint}`}><TIcon size={16} /></span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-[#f0f0f0]">Making a {tool.name.toLowerCase()}</div>
                <div className="truncate text-[11px] text-[#7e8696]">{tool.desc}</div>
              </div>
            </div>

            {tool.styled && (
              <div className="mb-3 -mx-0.5 flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <span className="shrink-0 pl-0.5 pr-1 text-[10px] uppercase tracking-wider text-[#6e7686]">Style</span>
                {SYSTEMS.map((s) => (
                  <button key={s} onClick={() => setStyle(s)}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] capitalize transition-colors ${style === s ? 'bg-[#AF8C56] text-[#12140d]' : 'bg-white/[0.05] text-[#9a9a9a] hover:bg-white/10'}`}>
                    {s === 'none' ? 'Default' : s}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2">
              <textarea
                ref={taRef}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run() } }}
                rows={2}
                placeholder={`Describe your ${tool.name.toLowerCase()} — e.g. "${tool.ph}"`}
                className="max-h-44 flex-1 resize-none rounded-xl bg-transparent px-1 py-1.5 text-[15px] leading-relaxed text-[#ededed] outline-none placeholder:text-[#5f6675]"
              />
              <button onClick={run}
                className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-[#c9a86a] to-[#AF8C56] px-4 text-sm font-semibold text-[#12140d] shadow-md transition-[filter,transform] hover:brightness-110 active:scale-[0.98]">
                Generate <ArrowUp size={15} />
              </button>
            </div>
          </div>
          <div className="px-3 py-1.5 text-center text-[10px] text-[#6e7686]">⌘/Ctrl + Enter to generate · everything is themed by your active palette</div>
        </div>

        {/* Tool gallery */}
        <div className="mb-3 mt-8 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7e8696]">Choose a tool</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {TOOLS.map((t) => {
            const Icon = t.icon
            const on = t.key === toolKey
            return (
              <button key={t.key} onClick={() => pick(t.key)}
                className={`group relative flex flex-col gap-2.5 rounded-2xl border p-4 text-left transition-all duration-200 ${
                  on
                    ? 'border-[#AF8C56]/60 bg-gradient-to-br from-[#AF8C56]/[0.14] to-transparent shadow-[0_0_0_1px_rgba(175,140,86,0.25)]'
                    : 'border-white/[0.08] bg-white/[0.025] hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06]'
                }`}>
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${t.tint}`}><Icon size={19} /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[#f2f2f2]">{t.name}</span>
                  <span className="mt-1 block text-[11.5px] leading-snug text-[#8a8f99]">{t.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
