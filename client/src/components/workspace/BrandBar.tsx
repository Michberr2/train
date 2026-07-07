import { useState } from 'react'
import { RotateCcw, Plus, Check, X } from 'lucide-react'
import { useBrand, editBrand, clearBrand, setBrand, savePalette, deletePalette, usePalettes, type BrandKit } from './brandKit'

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
  const saveCurrent = () => {
    savePalette(brand)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1400)
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
        {palettes.map((p) => {
          const active = `${p.primary}-${p.accent}-${p.dark}-${p.text}`.toLowerCase() === activeSig
          return (
            <div
              key={p.id}
              className={`group relative flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${active ? 'border-accent/60 bg-accent/10' : 'border-glass/12 bg-glass/[0.03] hover:bg-glass/[0.07]'}`}
            >
              <button onClick={() => setBrand({ ...p })} className="flex items-center gap-1.5" title={`Apply ${p.name || 'palette'}`}>
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
        <div className="mt-2 flex flex-wrap items-end gap-4 rounded-xl border border-glass/[0.1] bg-glass/[0.03] px-3 py-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-dim">
            Name
            <input
              value={brand.name || ''}
              onChange={(e) => editBrand({ name: e.target.value || undefined })}
              placeholder="Nalu"
              className="w-36 rounded-md border border-glass/15 bg-glass/[0.05] px-2 py-1 text-xs text-ink outline-none focus:border-glass/30"
            />
          </label>
          {TOKENS.map((t) => (
            <label key={t.key} className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-dim">
              {t.label}
              <input
                type="color"
                value={hex(brand[t.key] as string)}
                onChange={(e) => editBrand({ [t.key]: e.target.value.slice(1).toUpperCase() } as Partial<BrandKit>)}
                className="h-7 w-10 cursor-pointer rounded border border-glass/15 bg-transparent"
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-dim">
            Heading font
            <input
              value={brand.headingFont || ''}
              onChange={(e) => editBrand({ headingFont: e.target.value || undefined })}
              placeholder="Cormorant Garamond"
              className="w-40 rounded-md border border-glass/15 bg-glass/[0.05] px-2 py-1 text-xs text-ink outline-none focus:border-glass/30"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-dim">
            Body font
            <input
              value={brand.bodyFont || ''}
              onChange={(e) => editBrand({ bodyFont: e.target.value || undefined })}
              placeholder="Inter"
              className="w-32 rounded-md border border-glass/15 bg-glass/[0.05] px-2 py-1 text-xs text-ink outline-none focus:border-glass/30"
            />
          </label>
        </div>
      )}
    </div>
  )
}
