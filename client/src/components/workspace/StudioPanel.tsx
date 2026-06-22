import { useState } from 'react'
import {
  Globe, Sparkles, Palette, BookOpen, Ruler, Footprints, Film, ShoppingBag,
  Image as ImageIcon, FileText, BarChart3, Table2, Video, PenTool, LayoutTemplate,
  ArrowUp, type LucideIcon,
} from 'lucide-react'

// Nalu Studio — a polished, fully-functional design workspace (open-design style):
// pick a tool, optionally a design system, describe a brief, and Generate. It
// builds a complete prompt and runs the real generator; the result streams into
// the chat. Everything is themed by the active palette (Brand bar).
type Tool = {
  key: string
  name: string
  desc: string
  icon: LucideIcon
  tint: string
  styled?: boolean // supports a design system
  tmpl: (brief: string, style: string) => string
}
const styleP = (style: string) => (style && style !== 'none' ? `${style} ` : '')
const TOOLS: Tool[] = [
  { key: 'website', name: 'Website', desc: 'A complete, downloadable landing page or web app.', icon: Globe, tint: 'text-fuchsia-300 bg-fuchsia-500/15', styled: true, tmpl: (b, s) => `Build a polished ${styleP(s)}landing page for ${b}` },
  { key: 'logo', name: 'Logo', desc: 'Clean SVG marks + AI logo images, your brand color.', icon: Sparkles, tint: 'text-amber-300 bg-amber-500/15', styled: true, tmpl: (b, s) => `Design a ${styleP(s)}logo for ${b}` },
  { key: 'palette', name: 'Color palette', desc: 'An accessible, cohesive palette you can save.', icon: Palette, tint: 'text-pink-300 bg-pink-500/15', tmpl: (b) => `Create a color palette for ${b}` },
  { key: 'brand', name: 'Brand book', desc: 'A polished multi-page brand guidelines book.', icon: BookOpen, tint: 'text-indigo-300 bg-indigo-500/15', styled: true, tmpl: (b, s) => `Create ${styleP(s)}brand guidelines for ${b}` },
  { key: 'blueprint', name: 'Blueprint', desc: 'Multi-floor plans, dimensioned, to scale + 3D.', icon: Ruler, tint: 'text-sky-300 bg-sky-500/15', tmpl: (b) => `Design a detailed floor plan for ${b}` },
  { key: 'walkthrough', name: '3D walkthrough', desc: 'Walk a furnished 3D house and record it.', icon: Footprints, tint: 'text-emerald-300 bg-emerald-500/15', tmpl: (b) => `Design a house I can walk through in 3D: ${b}` },
  { key: 'motion', name: 'Motion graphic', desc: 'A looping animated title / logo reveal.', icon: Film, tint: 'text-violet-300 bg-violet-500/15', styled: true, tmpl: (b, s) => `Create a ${styleP(s)}animated motion graphic for ${b}` },
  { key: 'poster', name: 'Poster', desc: 'A bold poster or infographic, downloadable.', icon: LayoutTemplate, tint: 'text-rose-300 bg-rose-500/15', styled: true, tmpl: (b, s) => `Design a ${styleP(s)}poster for ${b}` },
  { key: 'canvas', name: 'Canvas', desc: 'An editable vector graphic (Figma-like).', icon: PenTool, tint: 'text-teal-300 bg-teal-500/15', styled: true, tmpl: (b, s) => `Make an editable ${styleP(s)}social graphic for ${b}` },
  { key: 'shopping', name: 'Shopping list', desc: 'Curated products + see them in a 3D room.', icon: ShoppingBag, tint: 'text-amber-200 bg-amber-500/10', tmpl: (b) => `Make a shopping list to furnish ${b}` },
  { key: 'document', name: 'Document', desc: 'A designed Word doc, on your brand.', icon: FileText, tint: 'text-blue-300 bg-blue-500/15', tmpl: (b) => `Write a polished document: ${b}` },
  { key: 'presentation', name: 'Presentation', desc: 'A polished PowerPoint deck, on your brand.', icon: BarChart3, tint: 'text-orange-300 bg-orange-500/15', tmpl: (b) => `Create a pitch deck about ${b}` },
  { key: 'spreadsheet', name: 'Spreadsheet', desc: 'A real Excel workbook with formulas, on-brand.', icon: Table2, tint: 'text-green-300 bg-green-500/15', tmpl: (b) => `Build a spreadsheet for ${b}` },
  { key: 'image', name: 'Image', desc: 'Generate a photoreal image of anything.', icon: ImageIcon, tint: 'text-cyan-300 bg-cyan-500/15', tmpl: (b) => `Generate an image of ${b}` },
  { key: 'video', name: 'Video', desc: 'Generate a short video clip from a prompt.', icon: Video, tint: 'text-red-300 bg-red-500/15', tmpl: (b) => `Create a video of ${b}` },
]
const SYSTEMS = ['none', 'minimal', 'luxury', 'swiss', 'brutalist', 'editorial', 'glassmorphism', 'bauhaus', 'memphis', 'y2k', 'corporate', 'organic', 'dark neon']
const PLACEHOLDERS: Record<string, string> = {
  website: 'a boutique coffee roaster called Ember', logo: 'Ember, a coastal coffee brand',
  palette: 'a calm wellness app', brand: 'Aurora, a fintech startup', blueprint: 'a 3-bedroom modern house with an open kitchen',
  walkthrough: 'a 2-bedroom apartment with a balcony', motion: 'an Ember logo reveal', poster: 'a summer jazz festival',
  canvas: 'an Instagram post announcing a sale', shopping: 'a cozy mid-century living room under $4000',
  document: 'a one-page business plan for a coffee shop', presentation: 'a 6-slide pitch for an AI note-taking app',
  spreadsheet: 'a monthly household budget with formulas', image: 'a misty pine forest at sunrise', video: 'a slow ocean wave at golden hour',
}

export default function StudioPanel({ onGenerate }: { onGenerate: (prompt: string) => void }) {
  const [toolKey, setToolKey] = useState('website')
  const [style, setStyle] = useState('none')
  const [brief, setBrief] = useState('')
  const tool = TOOLS.find((t) => t.key === toolKey) || TOOLS[0]
  const run = () => {
    const b = brief.trim() || PLACEHOLDERS[tool.key] || 'something great'
    onGenerate(tool.tmpl(b, tool.styled ? style : 'none'))
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Hero brief builder */}
      <div className="border-b border-white/[0.08] bg-gradient-to-b from-[#AF8C56]/[0.06] to-transparent px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300"><Sparkles size={16} /></span>
            <h2 className="text-xl font-medium tracking-tight text-[#f0f0f0]">Nalu Studio</h2>
          </div>
          <p className="mb-4 max-w-2xl text-sm text-[#9a9a9a]">Pick a tool, add a design system if you like, describe it, and generate. It builds the real artifact and streams it into your chat — themed by your active palette.</p>

          <div className="rounded-2xl border border-white/[0.12] bg-white/[0.04] p-3 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl">
            {/* tool chips */}
            <div className="mb-2 flex flex-wrap gap-1.5">
              {TOOLS.map((t) => {
                const Icon = t.icon
                const on = t.key === toolKey
                return (
                  <button key={t.key} onClick={() => setToolKey(t.key)}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${on ? 'bg-white/15 text-white' : 'bg-white/[0.05] text-[#bdbdbd] hover:bg-white/10'}`}>
                    <Icon size={13} className={on ? '' : 'opacity-70'} /> {t.name}
                  </button>
                )
              })}
            </div>
            {/* design system row (only for styled tools) */}
            {tool.styled && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] uppercase tracking-wider text-[#7e8696]">Design system</span>
                {SYSTEMS.map((s) => (
                  <button key={s} onClick={() => setStyle(s)}
                    className={`rounded-md px-2 py-0.5 text-[11px] capitalize transition-colors ${style === s ? 'bg-[#AF8C56]/25 text-[#e2c896]' : 'bg-white/[0.05] text-[#9a9a9a] hover:bg-white/10'}`}>
                    {s === 'none' ? 'Default' : s}
                  </button>
                ))}
              </div>
            )}
            {/* brief + generate */}
            <div className="flex items-end gap-2 rounded-xl border border-white/[0.1] bg-[#0b0e16]/60 p-2 focus-within:border-white/25">
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run() } }}
                rows={2}
                placeholder={`Describe your ${tool.name.toLowerCase()} — e.g. "${PLACEHOLDERS[tool.key] || ''}"`}
                className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-[#ededed] outline-none placeholder:text-[#5f6675]"
              />
              <button onClick={run}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#c9a86a] to-[#AF8C56] px-3.5 text-sm font-medium text-[#11140d] hover:brightness-110">
                Generate <ArrowUp size={15} />
              </button>
            </div>
            <div className="mt-1.5 px-1 text-[10px] text-[#6e7686]">{tool.desc} · ⌘/Ctrl+Enter to generate</div>
          </div>
        </div>
      </div>

      {/* Tool gallery — click to select */}
      <div className="px-4 py-5 sm:px-8">
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((t) => {
            const Icon = t.icon
            const on = t.key === toolKey
            return (
              <button key={t.key} onClick={() => { setToolKey(t.key); document.querySelector('textarea')?.focus() }}
                className={`group flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${on ? 'border-[#AF8C56]/50 bg-[#AF8C56]/[0.08]' : 'border-white/[0.1] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'}`}>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${t.tint}`}><Icon size={17} /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[#ededed]">{t.name}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-[#8e8e8e]">{t.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
