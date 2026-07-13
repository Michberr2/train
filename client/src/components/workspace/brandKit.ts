// The active Brand Kit. Set once (derived from a Nalu Studio palette or brand
// artifact); decks, docs and sheets read it at build time so every generated
// artifact comes out on-brand. Hex values are stored WITHOUT '#' (the pptxgenjs
// / docx APIs want bare hex); toRgb() gives [r,g,b] tuples for jsPDF.
import { useSyncExternalStore, useMemo } from 'react'
import type { DesignArtifact } from './types'

export type BrandKit = {
  name?: string
  primary: string // hex, no '#'
  accent: string // hex, no '#'
  dark: string // hex, no '#' — dark title backgrounds
  text: string // hex, no '#' — body text
  onDark: string // hex, no '#' — text on dark bg
  subtle: string // hex, no '#' — muted text on dark bg
  headingFont?: string
  bodyFont?: string
}

// One global Brand Kit for the whole app — stored in localStorage, so it persists
// across EVERY chat and every session (not per-chat). The "routine" primary brand.
// v2 — re-seeds the Four Seasons house palette over any stale v1 default.
const KEY = 'nalu.brandkit.v2'

// The Nalu house brand — quiet luxury (Four Seasons). This is the
// always-present default so every doc / deck / sheet / design is premium out of
// the box AND the Brand bar is always there to edit. Colors only (no fonts) so
// generated designs still pick their own elegant display serif.
export const DEFAULT_BRAND: BrandKit = {
  name: 'Nalu',
  primary: '14345A', // house navy (--hp-primary)
  accent: 'AF8C56', // antique gold (--hp-accent) — shared with Four Seasons' gold
  dark: '0F1B2D', // deep navy-black for dark title backgrounds
  text: '1F1F1F', // Four Seasons --color-text-primary (crisp near-black body)
  onDark: 'FFFFFF',
  subtle: 'E4B96F', // light antique gold for subtitles on dark
}

// Live subscription so the BrandBar / cards update the instant the brand changes
// (and across tabs via the storage event).
const listeners = new Set<() => void>()
function emit() {
  listeners.forEach((l) => l())
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

export function hexClean(h?: string, fallback = '000000'): string {
  if (!h) return fallback
  let s = h.trim().replace(/^#/, '')
  if (s.length === 3)
    s = s
      .split('')
      .map((c) => c + c)
      .join('')
  return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : fallback
}

export function toRgb(hex: string): [number, number, number] {
  const h = hexClean(hex)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function lum(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function getBrand(): BrandKit | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as BrandKit) : null
  } catch {
    return null
  }
}

export function setBrand(b: BrandKit | null): void {
  try {
    if (b) localStorage.setItem(KEY, JSON.stringify(b))
    else localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  emit()
}

/** Edit fields of the active brand in place (e.g. tweak a color or font). */
export function editBrand(patch: Partial<BrandKit>): void {
  const cur = getBrand()
  if (!cur) return
  setBrand({ ...cur, ...patch })
}

/** Reset to the Nalu house brand (not null) — the Brand bar always stays. */
export function clearBrand(): void {
  setBrand(DEFAULT_BRAND)
}

/** Seed the house brand if nothing is set yet (called on workspace mount). */
export function ensureDefaultBrand(): void {
  if (!getBrand()) setBrand(DEFAULT_BRAND)
}

/** Live React subscription to the active Brand Kit. */
export function useBrand(): BrandKit | null {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(KEY)
      } catch {
        return null
      }
    },
    () => null,
  )
  return useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as BrandKit) : null
    } catch {
      return null
    }
  }, [raw])
}

// ── Saved palette library ────────────────────────────────────────────────────
// A library of saved palettes (colors + fonts) the user can switch between from
// the bar at the bottom of the screen. Uses the `nalu-` prefix so it syncs to
// the server (Neon) and follows the account across devices.
export type SavedPalette = BrandKit & { id: string }
const PALETTES_KEY = 'nalu-palettes'
const pListeners = new Set<() => void>()
function pEmit() {
  pListeners.forEach((l) => l())
}
function pSubscribe(cb: () => void): () => void {
  pListeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === PALETTES_KEY) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    pListeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}
export function getPalettes(): SavedPalette[] {
  try {
    const raw = localStorage.getItem(PALETTES_KEY)
    const a = raw ? JSON.parse(raw) : []
    return notTrashed(Array.isArray(a) ? a : [])
  } catch {
    return []
  }
}
function setPalettes(list: SavedPalette[]): void {
  try {
    localStorage.setItem(PALETTES_KEY, JSON.stringify(list.slice(0, 30)))
  } catch {
    /* ignore */
  }
  pEmit()
}
const sigOf = (b: BrandKit) => `${b.primary}-${b.accent}-${b.dark}-${b.text}`.toLowerCase()

// TOMBSTONES — a deleted palette stays deleted FOREVER, even if a stale server
// copy or another tab tries to resurrect it during sync hydration.
const TRASH_KEY = 'nalu-palettes-trash'
type Tomb = { id?: string; sig?: string }
function getTrash(): Tomb[] {
  try { const a = JSON.parse(localStorage.getItem(TRASH_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
}
function addTrash(t: Tomb): void {
  try { localStorage.setItem(TRASH_KEY, JSON.stringify([t, ...getTrash()].slice(0, 200))) } catch { /* */ }
}
function unTrash(sig: string): void {
  try { localStorage.setItem(TRASH_KEY, JSON.stringify(getTrash().filter((t) => t.sig !== sig))) } catch { /* */ }
}
function notTrashed(list: SavedPalette[]): SavedPalette[] {
  const trash = getTrash()
  if (!trash.length) return list
  const ids = new Set(trash.map((t) => t.id).filter(Boolean))
  const sigs = new Set(trash.map((t) => t.sig).filter(Boolean))
  return list.filter((p) => !ids.has(p.id) && !sigs.has(sigOf(p)))
}
/** Save a palette (defaults to the active brand) into the library. */
export function savePalette(b: BrandKit): SavedPalette {
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const item: SavedPalette = { ...b, id, name: b.name || 'Palette' }
  unTrash(sigOf(b)) // an explicit re-save un-deletes this color combo
  // de-dup by the four core colors so saving twice doesn't pile up
  const rest = getPalettes().filter((p) => sigOf(p) !== sigOf(b))
  setPalettes([item, ...rest])
  return item
}
export function deletePalette(id: string): void {
  const gone = getPalettes().find((p) => p.id === id)
  if (gone) addTrash({ id, sig: sigOf(gone) }) // tombstone: never comes back
  setPalettes(getPalettes().filter((p) => p.id !== id))
}
/** Live React subscription to the saved-palette library. */
export function usePalettes(): SavedPalette[] {
  const raw = useSyncExternalStore(
    pSubscribe,
    () => {
      try {
        return localStorage.getItem(PALETTES_KEY)
      } catch {
        return null
      }
    },
    () => null,
  )
  return useMemo(() => {
    try {
      return notTrashed(raw ? (JSON.parse(raw) as SavedPalette[]) : [])
    } catch {
      return []
    }
  }, [raw])
}

type PColor = { role?: string; hex: string }

export function fromColors(colors: PColor[], name?: string, fonts?: { heading?: string; body?: string }): BrandKit | null {
  const valid = colors.filter((c) => /^#?[0-9a-fA-F]{6}$/.test((c.hex || '').replace(/^#/, '')))
  if (!valid.length) return null
  const byRole = (r: string) => valid.find((c) => (c.role || '').toLowerCase() === r)?.hex
  const primary = hexClean(byRole('primary') || valid[0].hex)
  const accent = hexClean(byRole('accent') || byRole('secondary') || valid[Math.min(1, valid.length - 1)].hex)
  const sorted = [...valid].sort((a, b) => lum(a.hex) - lum(b.hex))
  const dark = hexClean(sorted[0].hex)
  const text = lum(primary) < 0.5 ? primary : dark
  return {
    name,
    primary,
    accent,
    dark,
    text,
    onDark: 'FFFFFF',
    subtle: hexClean(byRole('neutral') || 'C7D2FE'),
    headingFont: fonts?.heading,
    bodyFont: fonts?.body,
  }
}

/** Derive a BrandKit from a palette or brand DesignArtifact (else null). */
export function deriveBrand(art: DesignArtifact): BrandKit | null {
  if (art.kind === 'palette') return fromColors(art.colors || [], art.name)
  if (art.kind === 'brand') {
    const fonts = { heading: art.typography?.heading?.family, body: art.typography?.body?.family }
    return fromColors((art.palette as PColor[]) || [], art.brand?.name, fonts)
  }
  return null
}
