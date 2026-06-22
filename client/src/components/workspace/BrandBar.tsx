import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useBrand, editBrand, clearBrand, type BrandKit } from './brandKit'

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
  const [open, setOpen] = useState(false)
  if (!brand) return null
  const hex = (v?: string) => '#' + (v || '000000')

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl">
      {/* Collapsed: one quiet line — swatches + name + edit. */}
      <div className="flex items-center gap-2.5 px-1 text-[11px] text-[#8e8e8e]">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2.5 rounded-md py-0.5 hover:text-[#cfcfcf]"
          title="Edit brand"
        >
          <span className="flex items-center gap-1">
            {TOKENS.map((t) => (
              <span
                key={t.key}
                className="h-3 w-3 rounded-full ring-1 ring-white/15"
                style={{ backgroundColor: hex(brand[t.key] as string) }}
              />
            ))}
          </span>
          <span className="tracking-wide">
            <span className="text-[#bdbdbd]">{brand.name || 'Brand'}</span>
            <span className="text-[#6e6e6e]"> · applies to all docs</span>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-3">
          <button onClick={() => setOpen((o) => !o)} className="hover:text-[#cfcfcf]">
            {open ? 'Done' : 'Edit'}
          </button>
          <button
            onClick={() => clearBrand()}
            title="Reset to Nalu default"
            className="flex items-center gap-1 hover:text-[#cfcfcf]"
          >
            <RotateCcw size={11} /> Reset
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 flex flex-wrap items-end gap-4 rounded-xl border border-white/[0.1] bg-white/[0.03] px-3 py-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#8e8e8e]">
            Name
            <input
              value={brand.name || ''}
              onChange={(e) => editBrand({ name: e.target.value || undefined })}
              placeholder="Nalu"
              className="w-36 rounded-md border border-white/15 bg-white/[0.05] px-2 py-1 text-xs text-[#ededed] outline-none focus:border-white/30"
            />
          </label>
          {TOKENS.map((t) => (
            <label key={t.key} className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#8e8e8e]">
              {t.label}
              <input
                type="color"
                value={hex(brand[t.key] as string)}
                onChange={(e) => editBrand({ [t.key]: e.target.value.slice(1).toUpperCase() } as Partial<BrandKit>)}
                className="h-7 w-10 cursor-pointer rounded border border-white/15 bg-transparent"
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#8e8e8e]">
            Heading font
            <input
              value={brand.headingFont || ''}
              onChange={(e) => editBrand({ headingFont: e.target.value || undefined })}
              placeholder="Cormorant Garamond"
              className="w-40 rounded-md border border-white/15 bg-white/[0.05] px-2 py-1 text-xs text-[#ededed] outline-none focus:border-white/30"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-[#8e8e8e]">
            Body font
            <input
              value={brand.bodyFont || ''}
              onChange={(e) => editBrand({ bodyFont: e.target.value || undefined })}
              placeholder="Inter"
              className="w-32 rounded-md border border-white/15 bg-white/[0.05] px-2 py-1 text-xs text-[#ededed] outline-none focus:border-white/30"
            />
          </label>
        </div>
      )}
    </div>
  )
}
