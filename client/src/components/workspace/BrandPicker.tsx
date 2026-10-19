import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, X } from 'lucide-react'

type Choice = { value: string; label: string; detail?: string }
const fontGroups: [string, string[]][] = [
  ['Sans serif', ['Inter', 'Arial', 'Helvetica', 'Poppins', 'DM Sans', 'Manrope', 'Montserrat', 'Open Sans', 'Roboto', 'Lato', 'Nunito', 'Raleway', 'Work Sans', 'Space Grotesk', 'Outfit', 'Figtree', 'Liberation Sans']],
  ['Serif', ['Cormorant Garamond', 'Georgia', 'Times New Roman', 'Playfair Display', 'Lora', 'Merriweather', 'Libre Baskerville', 'Source Serif 4', 'Bodoni Moda', 'DM Serif Display', 'EB Garamond', 'Crimson Pro', 'Fraunces', 'Liberation Serif']],
  ['Display & script', ['Bebas Neue', 'Oswald', 'Anton', 'Pacifico', 'Dancing Script', 'Caveat', 'Lobster']],
  ['Monospace', ['JetBrains Mono', 'IBM Plex Mono', 'Space Mono', 'Courier New', 'Liberation Mono']],
]
const fonts: Choice[] = fontGroups.flatMap(([detail, names]) => names.map(value => ({ value, label: value, detail })))
const colors: Choice[] = [
  ['14345A', 'Nalu blue'], ['AF8C56', 'Nalu gold'], ['0F1B2D', 'Midnight navy'], ['000000', 'Black'], ['FFFFFF', 'White'],
  ['1F1F1F', 'Charcoal'], ['64748B', 'Slate'], ['808080', 'Gray'], ['D1D5DB', 'Silver'], ['F5F1E8', 'Ivory'],
  ['FF0000', 'Red'], ['DC143C', 'Crimson'], ['800020', 'Burgundy'], ['FF6B6B', 'Coral'], ['FA8072', 'Salmon'],
  ['FF69B4', 'Hot pink'], ['FFC0CB', 'Pink'], ['E8B4BC', 'Dusty rose'], ['FFDAB9', 'Peach'], ['FFE4E1', 'Blush'],
  ['FFA500', 'Orange'], ['CC5500', 'Burnt orange'], ['E2725B', 'Terracotta'], ['D97706', 'Amber'], ['FFD700', 'Gold'], ['FFFF00', 'Yellow'], ['FFFDD0', 'Cream'],
  ['008000', 'Green'], ['228B22', 'Forest green'], ['50C878', 'Emerald'], ['9CAF88', 'Sage green'], ['808000', 'Olive'], ['98FF98', 'Mint'], ['32CD32', 'Lime'],
  ['008080', 'Teal'], ['40E0D0', 'Turquoise'], ['00FFFF', 'Cyan'], ['87CEEB', 'Sky blue'], ['0000FF', 'Blue'], ['4169E1', 'Royal blue'], ['000080', 'Navy'], ['0047AB', 'Cobalt'],
  ['800080', 'Purple'], ['8A2BE2', 'Violet'], ['E6E6FA', 'Lavender'], ['C8A2C8', 'Lilac'], ['4B0082', 'Indigo'], ['8E4585', 'Plum'],
  ['8B4513', 'Brown'], ['6F4E37', 'Coffee'], ['C19A6B', 'Camel'], ['F5F5DC', 'Beige'], ['D2B48C', 'Tan'], ['B87333', 'Copper'], ['B76E79', 'Rose gold'],
].map(([value, label]) => ({ value, label, detail: '#' + value }))
const hexValue = (value: string) => {
  const hex = value.trim().replace(/^#/, '')
  return /^[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : /^[0-9a-f]{3}$/i.test(hex) ? [...hex].map(char => char + char).join('').toUpperCase() : ''
}

export default function BrandPicker({ label, value, kind, onChange }: { label: string; value: string; kind: 'font' | 'color'; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [index, setIndex] = useState(0)
  const [position, setPosition] = useState({ left: 8, top: 8, width: 300, maxHeight: 320 })
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null)
  const id = useId()
  const catalog = kind === 'font' ? fonts : colors
  const known = catalog.find(choice => choice.value.toLowerCase() === value.toLowerCase())
  const search = query.trim().toLowerCase()
  const matches = catalog.filter(choice => kind === 'font' && search === 'serif' ? choice.detail === 'Serif' : `${choice.label} ${choice.detail || ''} ${choice.value}`.toLowerCase().includes(search))
  const custom = kind === 'color' ? hexValue(query) : query.trim().slice(0, 80)
  const choices = custom && (kind === 'color' || !matches.length) && !matches.some(choice => choice.value.toLowerCase() === custom.toLowerCase())
    ? [{ value: custom, label: kind === 'color' ? `Use #${custom}` : `Use ${custom}`, detail: 'Custom' }, ...matches] : matches
  const close = () => { setOpen(false); anchor.current?.focus() }
  const choose = (next: string) => { onChange(next); close() }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, window.innerWidth - 16), below = window.innerHeight - rect.bottom - 16, above = rect.top - 16
      const down = below >= 320 || below >= above
      const maxHeight = Math.min(360, Math.max(120, down ? below : above))
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: down ? rect.bottom + 6 : Math.max(8, rect.top - maxHeight - 6), width, maxHeight })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent | FocusEvent) => { if (!anchor.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside) }
  }, [open])
  return <div className="flex min-w-0 flex-col gap-1">
    <span className="text-[10px] uppercase tracking-wide text-dim">{label}</span>
    <button ref={anchor} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setQuery(''); setIndex(0); setOpen(!open) }}
      className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-glass/15 bg-glass/[0.05] px-2.5 py-1.5 text-left text-xs text-ink hover:border-glass/30">
      {kind === 'color' && <span className="h-5 w-5 shrink-0 rounded border border-glass/20" style={{ background: '#' + value }} />}
      <span className="truncate">{known?.label || (kind === 'color' ? '#' + value : value)}</span><ChevronDown size={13} className="ml-auto shrink-0 text-dim" />
    </button>
    {open && createPortal(<div ref={popup} style={position} className="fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-glass/25 bg-panel/65 text-ink shadow-xl backdrop-blur-2xl"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, Math.min(choices.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))) }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'color') { event.preventDefault(); if (choices[index]) choose(choices[index].value) }
      }}>
      <div className="flex shrink-0 items-center gap-2 border-b border-glass/15 px-3 py-2">
        <Search size={14} className="shrink-0 text-dim" />
        <input autoFocus role="combobox" aria-label={kind === 'font' ? 'Search fonts' : 'Search colors'} aria-expanded="true" aria-controls={id} aria-autocomplete="list" aria-activedescendant={choices[index] ? `${id}-${index}` : undefined}
          value={query} onChange={event => { setQuery(event.target.value); setIndex(0) }} placeholder={kind === 'font' ? 'Search fonts or enter a name…' : 'Search colors or paste a hex…'} className="min-w-0 flex-1 bg-transparent py-1 text-sm text-ink outline-none" />
        <button type="button" aria-label="Close choices" onClick={close} className="rounded p-1 text-dim hover:text-ink"><X size={15} /></button>
      </div>
      <div id={id} role="listbox" aria-label={`${label} choices`} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {choices.map((choice, i) => <button key={choice.value} id={`${id}-${i}`} type="button" role="option" aria-selected={choice.value.toLowerCase() === value.toLowerCase()}
          onClick={() => choose(choice.value)} onMouseEnter={() => setIndex(i)}
          ref={element => { if (element && i === index && open) element.scrollIntoView({ block: 'nearest' }) }}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm ${i === index ? 'bg-primary/15' : 'hover:bg-glass/10'}`}>
          {kind === 'color' && <span className="h-6 w-6 shrink-0 rounded-md border border-glass/20" style={{ background: '#' + choice.value }} />}
          <span className="min-w-0 flex-1"><span className="block truncate">{choice.label}</span><span className="block text-[10px] text-dim">{choice.detail}</span></span>
          {choice.value.toLowerCase() === value.toLowerCase() && <Check size={14} className="text-primary" />}
        </button>)}
        {!choices.length && <p className="px-3 py-4 text-xs text-dim">Search a color name or enter a 3 or 6 digit hex.</p>}
      </div>
      {kind === 'color' && <label className="flex shrink-0 cursor-pointer items-center justify-between border-t border-glass/15 px-3 py-2 text-xs text-dim">Custom color picker<input type="color" aria-label={`Custom ${label.toLowerCase()} color`} value={'#' + value} onChange={event => onChange(event.target.value.slice(1).toUpperCase())} className="h-7 w-9 cursor-pointer rounded border border-glass/20 bg-transparent" /></label>}
    </div>, document.body)}
  </div>
}
