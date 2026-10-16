import BrandPicker from './BrandPicker'
import { useState } from 'react'
import { RotateCcw, Plus, Check, X } from 'lucide-react'
import { useBrand, editBrand, clearBrand, setBrand, savePalette, deletePalette, usePalettes, NALU_BASELINE, type BrandKit } from './brandKit'

// The active Brand Kit — a quiet, refined line above the composer. Persists
// across every chat and themes generated docs / decks / sheets / designs.
// Collapsed by default; click to edit colors + fonts.
const TOKENS: { key: keyof BrandKit; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'accent', label: 'Accent' },
  { key: 'dark', label: 'Dark' },
  { key: 'text', label: 'Text' },
]

export default function BrandBar() {
  const brand = useBrand()
  const palettes = usePalettes()
  const [open, setOpen] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  if (!brand) return null
  const hex = (v?: string) => '#' + (v || '000000')
  const activeSig = `${brand.primary}-${brand.accent}-${brand.dark}-${brand.text}`.toLowerCase()
  const baseSig = `${NALU_BASELINE.primary}-${NALU_BASELINE.accent}-${NALU_BASELINE.dark}-${NALU_BASELINE.text}`.toLowerCase()
  const saveCurrent = () => {
    savePalette(brand)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1400)
  }
  // Upload your own logo file (PNG/SVG/JPG) → attach to the active brand. Raster images
  // are DOWNSCALED to a small PNG so they always fit the persist budget (a full-res
  // upload would base64-inflate past the cap and be silently dropped). SVGs stay as-is.
  const onLogoFile = (file?: File | null) => {
    if (!file) return
    const reader = new FileReader()
    if (file.type === 'image/svg+xml') {
      reader.onload = () => {
        const url = String(reader.result || '')
        if (url && url.length < 180000) editBrand({ logo: url })
      }
      reader.readAsDataURL(file)
      return
    }
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const max = 320
        const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1))
        const w = Math.max(1, Math.round((img.width || 1) * scale))
        const h = Math.max(1, Math.round((img.height || 1) * scale))
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const g = cv.getContext('2d')
        if (!g) return
        g.drawImage(img, 0, 0, w, h)
        try {
          const url = cv.toDataURL('image/png')
          if (url && url.length < 180000) editBrand({ logo: url })
        } catch {
          /* tainted canvas / unsupported — skip */
        }
      }
      img.src = String(reader.result || '')
    }
    reader.readAsDataURL(file)
  }
  // Small logo thumbnail (mark preferred; falls back to full logo). White pad so a
  // dark mark stays visible on the glass bar.
  const logoThumb = (b: { logo?: string; logoMark?: string }, cls: string) => {
    const src = b.logoMark || b.logo
    return src ? <img src={src} alt="" className={`${cls} shrink-0 rounded object-contain bg-white/80 p-[1px]`} /> : null
  }

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl">
      {/* Collapsed: one quiet line — swatches + name + edit. */}
      <div className="flex items-center gap-2.5 px-1 text-[11px] text-dim">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2.5 rounded-md py-0.5 hover:text-ink"
          title="Edit brand"
        >
          {logoThumb(brand, 'h-4 w-4')}
          <span className="flex items-center gap-1">
            {TOKENS.map((t) => (
              <span
                key={t.key}
                className="h-3 w-3 rounded-full ring-1 ring-glass/15"
                style={{ backgroundColor: hex(brand[t.key] as string) }}
              />
            ))}
          </span>
          <span className="tracking-wide">
            <span className="text-dim">{brand.name || 'Brand'}</span>
            <span className="text-dim"> · applies to docs, decks, sheets & websites</span>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setOpen((o) => !o)} className="hover:text-ink">
            {open ? 'Done' : 'Edit'}
          </button>
          <button
            onClick={() => clearBrand()}
            title="Reset to Nalu default"
            className="flex items-center gap-1 hover:text-ink"
          >
            <RotateCcw size={11} /> Reset
          </button>
        </div>
      </div>

      {/* Saved palettes — swatches + fonts you can switch between. */}
      <div className="mt-1.5 flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          onClick={saveCurrent}
          title="Save the current palette"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-glass/20 px-2 py-1 text-[10px] text-dim hover:border-glass/40 hover:text-ink"
        >
          {justSaved ? <Check size={11} className="text-emerald-300" /> : <Plus size={11} />} {justSaved ? 'Saved' : 'Save'}
        </button>
        {/* Built-in Nalu baseline — always present, never persisted/synced. */}
        <button
          onClick={() => setBrand({ ...NALU_BASELINE })}
          title="Nalu baseline — the house palette + Nalu logo, always here to work off"
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${baseSig === activeSig ? 'border-accent/60 bg-accent/10' : 'border-glass/12 bg-glass/[0.03] hover:bg-glass/[0.07]'}`}
        >
          {logoThumb(NALU_BASELINE, 'h-3.5 w-3.5')}
          <span className="flex">
            {(['primary', 'accent', 'dark', 'text'] as const).map((k) => (
              <span key={k} className="h-3 w-3 rounded-full ring-1 ring-black/30" style={{ backgroundColor: hex(NALU_BASELINE[k] as string), marginLeft: k === 'primary' ? 0 : -3 }} />
            ))}
          </span>
          <span className="text-[10px] text-ink">Nalu</span>
        </button>
        {palettes.filter((p) => `${p.primary}-${p.accent}-${p.dark}-${p.text}`.toLowerCase() !== baseSig).map((p) => {
          const active = `${p.primary}-${p.accent}-${p.dark}-${p.text}`.toLowerCase() === activeSig
          return (
            <div
              key={p.id}
              className={`group relative flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${active ? 'border-accent/60 bg-accent/10' : 'border-glass/12 bg-glass/[0.03] hover:bg-glass/[0.07]'}`}
            >
              <button onClick={() => setBrand({ ...p })} className="flex items-center gap-1.5" title={`Apply ${p.name || 'palette'}`}>
                {logoThumb(p, 'h-3.5 w-3.5')}
                <span className="flex">
                  {(['primary', 'accent', 'dark', 'text'] as const).map((k) => (
                    <span key={k} className="h-3 w-3 rounded-full ring-1 ring-black/30" style={{ backgroundColor: hex(p[k] as string), marginLeft: k === 'primary' ? 0 : -3 }} />
                  ))}
                </span>
                <span className="max-w-[90px] truncate text-[10px] text-ink">{p.name || 'Palette'}</span>
                {(p.headingFont || p.bodyFont) && (
                  <span className="text-[9px] text-dim" title={`${p.headingFont || ''} / ${p.bodyFont || ''}`}>Aa</span>
                )}
              </button>
              <button
                onClick={() => deletePalette(p.id)}
                className="text-dim opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100"
                title="Remove"
                aria-label="Remove palette"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        {!palettes.length && <span className="text-[10px] text-dim">Save palettes (colors + fonts) here to reuse across designs.</span>}
      </div>

      {open && (
        <div className="mt-2 grid grid-cols-2 items-end gap-3 sm:grid-cols-3 rounded-xl border border-glass/[0.1] bg-glass/[0.03] px-3 py-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-dim">
            Name
            <input
              value={brand.name || ''}
              onChange={(e) => editBrand({ name: e.target.value || undefined })}
              placeholder="Nalu"
              className="w-full rounded-md border border-glass/15 bg-glass/[0.05] px-2 py-1 text-xs text-ink outline-none focus:border-glass/30"
            />
          </label>
          {TOKENS.map(t => <BrandPicker key={t.key} kind="color" label={t.label} value={(brand[t.key] as string || '000000').replace(/^#/, '')} onChange={value => editBrand({ [t.key]: value } as Partial<BrandKit>)} />)}
          <BrandPicker kind="font" label="Heading font" value={brand.headingFont || 'Cormorant Garamond'} onChange={headingFont => editBrand({ headingFont })} />
          <BrandPicker kind="font" label="Body font" value={brand.bodyFont || 'Inter'} onChange={bodyFont => editBrand({ bodyFont })} />
          <div className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-dim">
            Logo
            <div className="flex items-center gap-2">
              {(brand.logo || brand.logoMark) && (
                <img src={brand.logoMark || brand.logo} alt="" className="h-7 w-7 rounded object-contain bg-white/80 p-0.5" />
              )}
              <label className="cursor-pointer rounded-md border border-glass/15 bg-glass/[0.05] px-2 py-1 text-xs normal-case text-ink hover:border-glass/30">
                {brand.logo || brand.logoMark ? 'Replace' : 'Upload'}
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => onLogoFile(e.target.files?.[0])} />
              </label>
              {(brand.logo || brand.logoMark) && (
                <button onClick={() => editBrand({ logo: undefined, logoMark: undefined })} className="text-[10px] normal-case text-dim hover:text-red-300">
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
