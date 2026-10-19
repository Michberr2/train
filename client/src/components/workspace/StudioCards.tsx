import { useScopedArtifact } from './ScopedArtifactContext'
import { useMemo, useRef, useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Palette, Sparkles, Ruler, Download, Copy, Check, FileJson, FileCode2, Image as ImageIcon, FileText, Star, Box, PencilRuler, ShoppingBag, ExternalLink, Footprints } from 'lucide-react'
import CardErrorBoundary from './CardErrorBoundary'

const Blueprint3D = lazy(() => import('./Blueprint3D'))
import { setBrand, deriveBrand, fromColors, savePalette, getBrand, DEFAULT_BRAND, svgToLogoUrl } from './brandKit'
import { planRoomFromItems } from './furnishPlan'
import { generateVideo } from '../../lib/videoEngine'
import { getToken } from '../../lib/localAuth'
import { prepareLogoSvg, logoImageUrl, isolatedLogoSvg } from './logoSvg'
import type { DesignArtifact } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Nalu Studio — Palette / Brand / Blueprint cards.
//
// All artifact color math is computed CLIENT-SIDE in pure TS (we never trust the
// LLM's rgb/hsl/contrast numbers). The model only supplies HEX. Exports use
// jsPDF (vector) + a native <canvas> for PNG — html2canvas is NOT installed.
// ─────────────────────────────────────────────────────────────────────────────

// ===== Shared types (mirror api/design.ts {kind} payloads) ===================

export type PaletteColor = {
  role?: string
  name?: string
  hex: string
  usage?: string
}

export type PaletteOption = {
  name?: string
  description?: string
  fonts?: { heading?: string; body?: string }
  colors: PaletteColor[]
}
export type PaletteArt = {
  kind: 'palette'
  name?: string
  description?: string
  fonts?: { heading?: string; body?: string }
  colors: PaletteColor[]
  options?: PaletteOption[]
}

type BrandFont = { family?: string; googleFont?: boolean; weights?: number[]; usage?: string }

export type BrandArt = {
  kind: 'brand'
  // The polished multi-page HTML brand book (new primary form). When present it
  // is rendered live + printable; the structured fields below are a legacy fallback.
  html?: string
  brand?: { name?: string; tagline?: string; mission?: string; voice?: string[] }
  palette?: PaletteColor[]
  typography?: { heading?: BrandFont; body?: BrandFont; scale?: string[] }
  logo?: { direction?: string; clearspace?: string; minSize?: string }
  dos?: string[]
  donts?: string[]
  spacing?: { base?: number; scale?: number[] }
}

type BPShape =
  | { type: 'rect'; x: number; y: number; w: number; h: number; label?: string; stroke?: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number; stroke?: number }
  | { type: 'circle'; cx: number; cy: number; r: number; label?: string; stroke?: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; label?: string; stroke?: number }
  | { type: 'polyline'; points: [number, number][]; stroke?: number }
  | { type: 'text'; x: number; y: number; text: string }
  | { type: 'door'; x: number; y: number; w: number; swing?: string; dir?: 'h' | 'v' }
  | { type: 'window'; x: number; y: number; w: number; dir?: 'h' | 'v' }
  | { type: 'tree'; cx: number; cy: number; r: number; label?: string }

type BPDimension = { x1: number; y1: number; x2: number; y2: number; text?: string; side?: string }
type BPAnnotation = { x: number; y: number; text: string; leaderTo?: [number, number] }
export type BPFloor = {
  name?: string
  viewBox: { w: number; h: number }
  shapes?: BPShape[]
  dimensions?: BPDimension[]
  annotations?: BPAnnotation[]
}

export type LogoOption = { concept?: string; mark?: string; lockup?: string }
export type LogoArt = {
  kind: 'logo'
  name?: string
  initials?: string
  serif?: boolean
  font?: string
  colors?: string[]
  // Diffusion-friendly plain-English names for `colors`, in order.
  colorNames?: string[]
  // The art-directed pictorial mark concept ("a cresting wave curling into a
  // coffee bean") — drives the AI logo image prompts.
  symbol?: string
  // Faithful-logo signals from the server: when the user DESCRIBED the mark, we
  // render exactly that (no imposed house style / embellishments).
  literal?: boolean // user described the mark → transcribe, don't reinterpret
  colorsLocked?: boolean // user named the color(s) → use only those
  userStyle?: string // the user's own render-style words ("hand-drawn","3D glossy"), else ''
  background?: string // mark background the user asked for ("white"|"transparent"|"black"…)
  // Generated logo images (url → dataUrl) persisted with the artifact so every
  // logo is cached in the DB and browsable anytime, on any device.
  imgCache?: Record<string, string>
  options?: LogoOption[]
  // legacy single-mark form
  concept?: string
  mark?: string
  lockup?: string
}

export type ShopItem = {
  name: string
  category?: string
  reason?: string
  price?: string
  retailer?: string
  query?: string
}
export type ShoppingArt = {
  kind: 'shopping'
  title?: string
  summary?: string
  budget?: string
  items: ShopItem[]
}

export type BlueprintArt = {
  kind: 'blueprint'
  title?: string
  units?: string
  scale?: string
  viewBox?: { w: number; h: number }
  grid?: { step?: number; show?: boolean }
  floors?: BPFloor[]
  shapes?: BPShape[]
  dimensions?: BPDimension[]
  annotations?: BPAnnotation[]
}

// ===== Pure-TS color math ====================================================

type RGB = { r: number; g: number; b: number }

function normHex(hex: string): string {
  let h = (hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return '000000'
  return h.toLowerCase()
}

export function hexToRgb(hex: string): RGB {
  const h = normHex(hex)
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

export function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function relLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function bestText(hex: string): '#000000' | '#ffffff' {
  // WCAG contrast of black vs white on this bg; pick the higher-contrast one.
  const L = relLuminance(hexToRgb(hex))
  const cWhite = (1.0 + 0.05) / (L + 0.05)
  const cBlack = (L + 0.05) / 0.05
  return cWhite >= cBlack ? '#ffffff' : '#000000'
}

function rgbStr(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgb(${r}, ${g}, ${b})`
}
function hslStr(hex: string): string {
  const { h, s, l } = rgbToHsl(hexToRgb(hex))
  return `hsl(${h}, ${s}%, ${l}%)`
}

function slug(s?: string, fallback = 'nalu'): string {
  return (s || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback
}

function roleKey(c: PaletteColor, i: number): string {
  return slug(c.role || c.name || `color-${i + 1}`, `color-${i + 1}`)
}

function cssVarsFromPalette(colors: PaletteColor[]): string {
  const lines = colors.flatMap((c, i) => {
    const k = roleKey(c, i)
    return [`  --${k}: ${'#' + normHex(c.hex)};`, `  --${k}-contrast: ${bestText(c.hex)};`]
  })
  return `:root {\n${lines.join('\n')}\n}\n`
}

function tailwindColorsFromPalette(colors: PaletteColor[]): string {
  const obj: Record<string, string> = {}
  colors.forEach((c, i) => {
    obj[roleKey(c, i)] = '#' + normHex(c.hex)
  })
  return JSON.stringify({ theme: { extend: { colors: obj } } }, null, 2)
}

// ===== Download helpers =======================================================

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
function downloadText(text: string, filename: string, type: string) {
  downloadBlob(new Blob([text], { type }), filename)
}

// ===== Shared chrome ==========================================================

// Minimal flat frame: hairlines + a quiet meta row. No icon chips, no curves —
// the artifact itself is the design.
function CardShell({
  tint,
  title,
  subtitle,
  actions,
  children,
}: {
  icon?: React.ReactNode
  tint?: string
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  void tint
  return (
    <div className="my-4 border-y border-glass/[0.12]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {title}
          {subtitle && <span className="ml-2 text-xs font-normal text-dim">{subtitle}</span>}
        </span>
        {actions}
      </div>
      {children}
    </div>
  )
}

function ActionBtn({
  onClick,
  children,
  primary,
  tint,
}: {
  onClick: () => void
  children: React.ReactNode
  primary?: boolean
  tint?: string
}) {
  const base =
    primary && tint
      ? tint
      : 'bg-glass/[0.07] text-ink hover:bg-glass/[0.12]'
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${primary ? 'font-medium' : ''} ${base}`}
    >
      {children}
    </button>
  )
}

// "Make routine" — set this palette/brand as the global primary Brand Kit, so it
// persists across every chat and themes all docs / decks / sheets / designs.
function MakeRoutineBtn({ art }: { art: DesignArtifact }) {
  const scoped = useScopedArtifact()
  const [done, setDone] = useState(false)
  if (scoped) return null
  return (
    <ActionBtn
      onClick={() => {
        const b = deriveBrand(art)
        if (b) {
          setBrand(b)
          setDone(true)
          setTimeout(() => setDone(false), 1800)
        }
      }}
    >
      {done ? <Check size={13} /> : <Star size={13} />} {done ? 'Routine set' : 'Make routine'}
    </ActionBtn>
  )
}

// ===== Swatch + PaletteStrip (shared by PaletteCard + BrandCard) =============

function Swatch({ c, i }: { c: PaletteColor; i: number }) {
  const [copied, setCopied] = useState<string | null>(null)
  const hex = '#' + normHex(c.hex)
  const fg = bestText(c.hex)
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value)
    setCopied(label)
    setTimeout(() => setCopied((p) => (p === label ? null : p)), 1200)
  }
  return (
    <div className="overflow-hidden rounded-lg border border-glass/[0.1] bg-glass/[0.02]">
      <button
        onClick={() => copy('hex', hex)}
        className="group relative flex h-20 w-full items-end justify-between px-3 py-2 text-left"
        style={{ backgroundColor: hex, color: fg }}
        title="Copy hex"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{c.role || `Color ${i + 1}`}</span>
        <span className="flex items-center gap-1 font-mono text-xs font-semibold">
          {copied === 'hex' ? <Check size={12} /> : <Copy size={12} className="opacity-0 transition-opacity group-hover:opacity-70" />}
          {hex}
        </span>
      </button>
      <div className="space-y-1 px-3 py-2">
        {c.name && <div className="truncate text-xs font-medium text-ink">{c.name}</div>}
        <div className="flex flex-wrap gap-1.5">
          <CopyChip label="RGB" value={rgbStr(c.hex)} active={copied === 'rgb'} onClick={() => copy('rgb', rgbStr(c.hex))} />
          <CopyChip label="HSL" value={hslStr(c.hex)} active={copied === 'hsl'} onClick={() => copy('hsl', hslStr(c.hex))} />
        </div>
        {c.usage && <div className="text-[11px] leading-snug text-dim">{c.usage}</div>}
      </div>
    </div>
  )
}

function CopyChip({ label, value, active, onClick }: { label: string; value: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`Copy ${value}`}
      className="flex items-center gap-1 rounded-md bg-glass/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-dim hover:bg-glass/[0.12] hover:text-ink"
    >
      {active ? <Check size={9} /> : null}
      {label}
    </button>
  )
}

export function PaletteStrip({ colors }: { colors: PaletteColor[] }) {
  return (
    <div className="flex h-12 w-full overflow-hidden rounded-lg border border-glass/[0.1]">
      {colors.map((c, i) => (
        <div key={i} className="flex-1" style={{ backgroundColor: '#' + normHex(c.hex) }} title={`${c.role || ''} ${'#' + normHex(c.hex)}`} />
      ))}
    </div>
  )
}

// ===== PNG painter (native canvas — no html2canvas) ==========================

function paintPalettePng(name: string, colors: PaletteColor[]): Promise<Blob | null> {
  const scale = 2
  const cols = colors.length
  const W = Math.max(cols * 220, 660)
  const bandH = 320
  const footerH = 120
  const H = bandH + footerH
  const canvas = document.createElement('canvas')
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.scale(scale, scale)
  // dark bg
  ctx.fillStyle = '#0b0e16'
  ctx.fillRect(0, 0, W, H)
  const bw = W / cols
  colors.forEach((c, i) => {
    const hex = '#' + normHex(c.hex)
    const fg = bestText(c.hex)
    ctx.fillStyle = hex
    ctx.fillRect(i * bw, 0, bw, bandH)
    ctx.fillStyle = fg
    ctx.font = '600 13px Inter, Arial, sans-serif'
    ctx.fillText((c.role || `Color ${i + 1}`).toUpperCase(), i * bw + 16, 30)
    ctx.font = '700 16px Inter, Arial, sans-serif'
    ctx.fillText(hex.toUpperCase(), i * bw + 16, bandH - 22)
    if (c.name) {
      ctx.font = '500 12px Inter, Arial, sans-serif'
      ctx.fillText(c.name, i * bw + 16, bandH - 44)
    }
  })
  ctx.fillStyle = '#ededed'
  ctx.font = '700 22px Inter, Arial, sans-serif'
  ctx.fillText(name || 'Nalu Palette', 20, bandH + 50)
  ctx.fillStyle = '#7a7a7a'
  ctx.font = '400 12px Inter, Arial, sans-serif'
  ctx.fillText('Generated with Nalu Studio', 20, bandH + 78)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

// ===== PaletteCard ============================================================

export function PaletteCard({ art }: { art: PaletteArt }) {
  const colors = useMemo(() => (art.colors || []).filter((c) => c && c.hex), [art.colors])
  const name = art.name || 'Nalu Palette'
  const base = slug(name, 'nalu-palette')

  const exportCss = () => downloadText(cssVarsFromPalette(colors), `${base}.css`, 'text/css')
  const exportTw = () => downloadText(tailwindColorsFromPalette(colors), `${base}.tailwind.json`, 'application/json')
  const exportJson = () =>
    downloadText(JSON.stringify({ ...art, name, colors }, null, 2), `${base}.json`, 'application/json')
  const exportPng = async () => {
    const blob = await paintPalettePng(name, colors)
    if (blob) downloadBlob(blob, `${base}.png`)
  }

  if (!colors.length) {
    return (
      <CardShell icon={<Palette size={15} />} tint="bg-rose-500/15 text-rose-300" title={name} subtitle="No colors returned">
        <div className="p-4 text-sm text-dim">This palette came back empty. Try rephrasing your request.</div>
      </CardShell>
    )
  }

  return (
    <CardShell
      icon={<Palette size={15} />}
      tint="bg-rose-500/15 text-rose-300"
      title={name}
      subtitle={art.description || `${colors.length} colors · click any swatch to copy`}
      actions={
        <>
          <MakeRoutineBtn art={art} />
          <ActionBtn onClick={exportCss}><FileCode2 size={13} /> CSS</ActionBtn>
          <ActionBtn onClick={exportTw}><FileCode2 size={13} /> Tailwind</ActionBtn>
          <ActionBtn onClick={exportJson}><FileJson size={13} /> JSON</ActionBtn>
          <ActionBtn onClick={() => void exportPng()} primary tint="bg-rose-500/20 text-rose-200 hover:bg-rose-500/30">
            <ImageIcon size={13} /> PNG
          </ActionBtn>
        </>
      }
    >
      <div className="bg-canvas p-4">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {colors.map((c, i) => (
            <Swatch key={i} c={c} i={i} />
          ))}
        </div>
        {/* PICK A DIRECTION — the recommended set + alternates; one click makes
            it YOUR palette (applied to the Brand bar AND saved to the library) */}
        <PaletteOptions art={art} />
      </div>
    </CardShell>
  )
}

function PaletteOptions({ art }: { art: PaletteArt }) {
  const scoped = useScopedArtifact()
  const [picked, setPicked] = useState<string | null>(null)
  const all: PaletteOption[] = [
    { name: art.name || 'Recommended', description: art.description, fonts: art.fonts, colors: art.colors || [] },
    ...(art.options || []),
  ].filter((o) => (o.colors || []).filter((c) => c && c.hex).length >= 3)
  if (all.length < 2 && !art.fonts) return null
  const use = (o: PaletteOption, key: string) => {
    const kit = fromColors(o.colors, o.name, o.fonts)
    if (!kit) return
    setBrand(kit)
    savePalette(kit)
    setPicked(key)
    setTimeout(() => setPicked(null), 2200)
  }
  return (
    <div className="mt-4 border-t border-glass/[0.08] pt-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">
        {scoped ? 'Palette directions' : 'Pick a direction — applies & saves to your palette'}
      </div>
      <div className="space-y-1.5">
        {all.map((o, i) => {
          const key = `${o.name}-${i}`
          const cs = (o.colors || []).filter((c) => c && c.hex).slice(0, 8)
          return (
            <div key={key} className="flex items-center gap-3 rounded-xl border border-glass/[0.08] bg-glass/[0.03] px-2.5 py-2">
              <span className="flex shrink-0 overflow-hidden rounded-md">
                {cs.map((c, j) => (
                  <span key={j} className="h-7 w-7" style={{ background: c.hex }} title={`${c.name || c.role || ''} ${c.hex}`} />
                ))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-ink">
                  {o.name || `Direction ${i + 1}`}
                  {i === 0 && <span className="ml-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-gold">Recommended</span>}
                </span>
                <span className="block truncate text-[10.5px] text-dim">
                  {[o.fonts?.heading && `${o.fonts.heading} / ${o.fonts.body || 'system'}`, o.description].filter(Boolean).join(' — ')}
                </span>
              </span>
              {!scoped && <button
                onClick={() => use(o, key)}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors ${picked === key ? 'bg-emerald-500/20 text-emerald-200' : 'bg-accent/15 text-gold hover:bg-accent/25'}`}
              >
                {picked === key ? 'Saved ✓' : 'Use & save'}
              </button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ===== BrandCard ==============================================================

const GFONT_LOADED = new Set<string>()
function ensureGoogleFont(family?: string, weights?: number[]) {
  if (!family || typeof document === 'undefined') return
  const key = family + (weights || []).join(',')
  if (GFONT_LOADED.has(key)) return
  GFONT_LOADED.add(key)
  const w = (weights && weights.length ? weights : [400, 700]).join(';')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${w}&display=swap`
  document.head.appendChild(link)
}

export function BrandCard({ art }: { art: BrandArt }) {
  const brand = art.brand || {}
  const palette = useMemo(() => (art.palette || []).filter((c) => c && c.hex), [art.palette])
  const typo = art.typography || {}
  const heading = typo.heading || {}
  const body = typo.body || {}
  const dos = art.dos || []
  const donts = art.donts || []
  const spacing = art.spacing || {}
  const name = brand.name || 'Brand Guidelines'
  const base = slug(name, 'nalu-brand')

  if (heading.googleFont) ensureGoogleFont(heading.family, heading.weights)
  if (body.googleFont) ensureGoogleFont(body.family, body.weights)

  const headFamily = heading.family ? `'${heading.family}', Inter, system-ui, sans-serif` : 'Inter, system-ui, sans-serif'
  const bodyFamily = body.family ? `'${body.family}', Inter, system-ui, sans-serif` : 'Inter, system-ui, sans-serif'

  const exportPdf = async () => {
    const { buildBrandPdf } = await import('./brandExport')
    downloadBlob(await buildBrandPdf(art), `${base}.pdf`)
  }
  const exportDocx = async () => {
    const { buildBrandDocx } = await import('./brandExport')
    downloadBlob(await buildBrandDocx(art), `${base}.docx`)
  }

  return (
    <CardShell
      icon={<Sparkles size={15} />}
      tint="bg-violet-500/15 text-violet-300"
      title={name}
      subtitle={brand.tagline || 'Brand guidelines'}
      actions={
        <>
          <MakeRoutineBtn art={art} />
          <ActionBtn onClick={() => void exportDocx()}><FileText size={13} /> DOCX</ActionBtn>
          <ActionBtn onClick={() => void exportPdf()} primary tint="bg-violet-500/20 text-violet-200 hover:bg-violet-500/30">
            <Download size={13} /> PDF
          </ActionBtn>
        </>
      }
    >
      <div className="space-y-6 bg-canvas p-5">
        {/* Hero */}
        <div className="rounded-xl border border-glass/[0.08] bg-gradient-to-br from-[#15121f] to-canvas p-5">
          <div className="text-2xl font-bold text-ink" style={{ fontFamily: headFamily }}>{name}</div>
          {brand.tagline && <div className="mt-1 text-sm text-violet-300" style={{ fontFamily: bodyFamily }}>{brand.tagline}</div>}
          {brand.mission && <p className="mt-3 max-w-prose text-sm leading-relaxed text-dim" style={{ fontFamily: bodyFamily }}>{brand.mission}</p>}
          {brand.voice && brand.voice.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {brand.voice.map((v, i) => (
                <span key={i} className="rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs text-violet-200">{v}</span>
              ))}
            </div>
          )}
        </div>

        {/* Palette */}
        {palette.length > 0 && (
          <section>
            <SectionLabel>Color Palette</SectionLabel>
            <PaletteStrip colors={palette} />
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              {palette.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-dim">
                  <span className="h-3 w-3 shrink-0 rounded-sm border border-glass/20" style={{ backgroundColor: '#' + normHex(c.hex) }} />
                  <span className="truncate">{c.role || c.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-dim">{('#' + normHex(c.hex)).toUpperCase()}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Typography */}
        <section>
          <SectionLabel>Typography</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-glass/[0.08] bg-glass/[0.02] p-4">
              <div className="text-[10px] uppercase tracking-wide text-dim">Heading · {heading.family || 'Inter'}</div>
              <div className="mt-1 text-2xl font-bold text-ink" style={{ fontFamily: headFamily }}>Aa Bb Cc</div>
              <div className="text-lg font-semibold text-ink" style={{ fontFamily: headFamily }}>The quick brown fox</div>
              {heading.usage && <div className="mt-1 text-[11px] text-dim">{heading.usage}</div>}
            </div>
            <div className="rounded-lg border border-glass/[0.08] bg-glass/[0.02] p-4">
              <div className="text-[10px] uppercase tracking-wide text-dim">Body · {body.family || 'Inter'}</div>
              <div className="mt-1 text-2xl text-ink" style={{ fontFamily: bodyFamily }}>Aa Bb Cc</div>
              <div className="text-sm text-dim" style={{ fontFamily: bodyFamily }}>The quick brown fox jumps over the lazy dog.</div>
              {body.usage && <div className="mt-1 text-[11px] text-dim">{body.usage}</div>}
            </div>
          </div>
          {typo.scale && typo.scale.length > 0 && (
            <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              {typo.scale.map((s, i) => (
                <span key={i} className="leading-none text-[#9fb3ff]" style={{ fontFamily: headFamily, fontSize: `${Math.min(Number(s) || 12, 40)}px` }}>{s}</span>
              ))}
            </div>
          )}
        </section>

        {/* Logo */}
        {art.logo && (art.logo.direction || art.logo.clearspace || art.logo.minSize) && (
          <section>
            <SectionLabel>Logo</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
              {art.logo.direction && <p className="text-sm leading-relaxed text-dim">{art.logo.direction}</p>}
              <div className="space-y-1 text-xs text-dim">
                {art.logo.clearspace && <div>Clearspace: <span className="text-ink">{art.logo.clearspace}</span></div>}
                {art.logo.minSize && <div>Min size: <span className="text-ink">{art.logo.minSize}</span></div>}
              </div>
            </div>
          </section>
        )}

        {/* Do / Don't */}
        {(dos.length > 0 || donts.length > 0) && (
          <section className="grid gap-4 sm:grid-cols-2">
            {dos.length > 0 && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-300">Do</div>
                <ul className="space-y-1.5">
                  {dos.map((d, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink"><Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {donts.length > 0 && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.06] p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-300">Don't</div>
                <ul className="space-y-1.5">
                  {donts.map((d, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink"><span className="mt-0.5 shrink-0 font-bold text-rose-400">×</span>{d}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Spacing */}
        {spacing.scale && spacing.scale.length > 0 && (
          <section>
            <SectionLabel>Spacing{spacing.base ? ` · ${spacing.base}px base` : ''}</SectionLabel>
            <div className="flex flex-wrap items-end gap-3">
              {spacing.scale.map((s, i) => (
                <div key={i} className="flex flex-col items-center gap-1">
                  <div className="rounded bg-violet-400/60" style={{ width: 14, height: Math.min(s, 72) }} />
                  <span className="font-mono text-[10px] text-dim">{s}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </CardShell>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-dim">{children}</div>
}

// ===== LogoCard ===============================================================

function svgToPng(svg: string, size: number, bg: string | null, cb: (url: string) => void) {
  const { svg: doc, width: cw, height: ch } = prepareLogoSvg(svg, size)
  const blob = new Blob([doc], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) { URL.revokeObjectURL(url); return }
    if (bg) {
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, cw, ch)
    }
    ctx.drawImage(img, 0, 0, cw, ch)
    URL.revokeObjectURL(url)
    cb(canvas.toDataURL('image/png'))
  }
  img.onerror = () => URL.revokeObjectURL(url)
  img.src = url
}

const colorize = (svg: string, color: string) => svg.replace(/currentColor/g, color)

// ── Code-based logo generator ────────────────────────────────────────────────
// We render logos in CODE (not freehand LLM SVG) so they are reliably clean,
// professional, and SIMPLE: refined wordmarks + crisp geometric monograms in
// web-safe fonts (which also rasterize correctly for PNG export). The LLM only
// supplies the name, initials, palette and a serif/vibe flag.
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"
const SERIF = "Georgia, 'Times New Roman', serif"
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function initialsFrom(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean)
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase()
  return (w[0]?.[0] || 'N').toUpperCase()
}
const markSvg = (inner: string) => `<svg viewBox="0 0 100 100">${inner}</svg>`
// width estimate is intentionally generous so the wordmark never clips (it just
// gets symmetric side padding, staying centered).
const wordWidth = (text: string, fs: number, serif: boolean) => Math.round(text.length * fs * (serif ? 0.62 : 0.66)) + 36

function wordmarkLockup(name: string, serif: boolean, caps = false): string {
  const f = serif ? SERIF : SANS
  const t = caps ? name.toUpperCase() : name
  const fs = t.length > 12 ? 42 : t.length > 8 ? 50 : 58
  const tracking = caps ? 6 : serif ? 0 : -2
  const W = wordWidth(t, fs, serif) + (caps ? t.length * 6 : 0)
  return `<svg viewBox="0 0 ${W} 100"><text x="${W / 2}" y="54" text-anchor="middle" dominant-baseline="central" font-family="${f}" font-size="${fs}" font-weight="${serif ? 600 : 700}" letter-spacing="${tracking}" fill="currentColor">${xmlEsc(t)}</text></svg>`
}
function plainInitialInner(initials: string, serif: boolean): string {
  const f = serif ? SERIF : SANS
  const fs = initials.length > 1 ? 48 : 64
  return `<text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-family="${f}" font-size="${fs}" font-weight="700" letter-spacing="${initials.length > 1 ? 1 : 0}" fill="currentColor">${xmlEsc(initials)}</text>`
}
function ringInner(initials: string, serif: boolean): string {
  const f = serif ? SERIF : SANS
  const fs = initials.length > 1 ? 34 : 46
  return `<circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" stroke-width="3.5"/><text x="50" y="53" text-anchor="middle" dominant-baseline="central" font-family="${f}" font-size="${fs}" font-weight="600" letter-spacing="${initials.length > 1 ? 1 : 0}" fill="currentColor">${xmlEsc(initials)}</text>`
}
function badgeInner(initials: string, serif: boolean): string {
  // Filled rounded square with the letter knocked out (transparent), so the
  // brand color or background shows through — a clean, app-icon-ready mark.
  const f = serif ? SERIF : SANS
  const fs = initials.length > 1 ? 34 : 46
  const id = `nlko_${initials}_${serif ? 's' : 'n'}`
  return `<defs><mask id="${id}"><rect width="100" height="100" fill="white"/><text x="50" y="54" text-anchor="middle" dominant-baseline="central" font-family="${f}" font-size="${fs}" font-weight="700" fill="black">${xmlEsc(initials)}</text></mask></defs><rect x="10" y="10" width="80" height="80" rx="20" fill="currentColor" mask="url(#${id})"/>`
}
function comboLockup(inner: string, name: string, serif: boolean): string {
  const f = serif ? SERIF : SANS
  const fs = name.length > 12 ? 40 : 46
  const W = 110 + wordWidth(name, fs, serif)
  return `<svg viewBox="0 0 ${W} 100"><g transform="translate(8,12) scale(0.76)">${inner}</g><text x="108" y="54" dominant-baseline="central" font-family="${f}" font-size="${fs}" font-weight="${serif ? 600 : 600}" letter-spacing="-1" fill="currentColor">${xmlEsc(name)}</text></svg>`
}

function genLogoOptions(name: string, initials: string, serif: boolean): LogoOption[] {
  const ini = initials || initialsFrom(name)
  const ring = ringInner(ini, serif)
  const badge = badgeInner(ini, serif)
  return [
    { concept: serif ? 'Elegant wordmark' : 'Clean wordmark', mark: markSvg(plainInitialInner(ini, serif)), lockup: wordmarkLockup(name, serif) },
    { concept: 'Ring monogram', mark: markSvg(ring), lockup: comboLockup(ring, name, serif) },
    { concept: 'Monogram badge', mark: markSvg(badge), lockup: comboLockup(badge, name, serif) },
    { concept: 'Uppercase wordmark', mark: markSvg(plainInitialInner(ini, serif)), lockup: wordmarkLockup(name, serif, true) },
  ]
}

// AI logo IMAGES (Nalu image engine, keyless) — icon-only pictorial MARKS.
// Key insight: diffusion models garble letterforms, so we never ask for text —
// the mark is generated clean and the wordmark is typeset in code below it.
const LOGO_STYLES: { key: string; label: string; desc: string; archetype: string }[] = [
  { key: 'minimal', label: 'Minimal', desc: 'minimalist, timeless, refined, elegant use of negative space, thin precise strokes', archetype: 'a single-line minimal pictorial mark' },
  { key: 'modern', label: 'Modern', desc: 'modern, flat 2D geometric design, clean confident lines, bold simple shapes', archetype: 'a flat geometric pictorial mark' },
  { key: 'tech', label: 'Tech', desc: 'sleek, futuristic, sharp angles, precise, circuit-like accents, high-tech', archetype: 'an abstract angular tech mark' },
  { key: 'corporate', label: 'Corporate', desc: 'professional, trustworthy, balanced, symmetrical, refined', archetype: 'a solid emblem-style mark' },
  { key: 'luxury', label: 'Luxury', desc: 'elegant, premium, sophisticated, fine hairline detailing, subtle gold accents', archetype: 'a refined crest-like mark' },
  { key: 'playful', label: 'Playful', desc: 'friendly, rounded soft shapes, cheerful, approachable', archetype: 'a rounded mascot-like mark' },
  { key: 'abstract', label: 'Abstract', desc: 'artistic, distinctive, dynamic overlapping geometry, gradient of two brand colors', archetype: 'an abstract geometric mark' },
  { key: 'gradient', label: 'Gradient', desc: 'smooth vibrant duotone gradients, contemporary, dimensional but flat-rendered', archetype: 'a fluid gradient mark' },
]
// Diffusion models can't parse hex codes — translate to the nearest plain-English
// color so "primary color #0F1B2D" becomes "deep navy blue".
const NAMED_COLORS: Array<[string, number, number, number]> = [
  ['deep navy blue', 15, 27, 45], ['royal blue', 40, 80, 200], ['sky blue', 120, 180, 235], ['teal', 20, 128, 128],
  ['emerald green', 16, 120, 70], ['forest green', 34, 80, 40], ['sage green', 150, 165, 130], ['antique gold', 175, 140, 86],
  ['warm orange', 235, 130, 40], ['terracotta', 200, 100, 70], ['crimson red', 180, 40, 50], ['burgundy', 110, 30, 45],
  ['magenta', 200, 40 , 140], ['royal purple', 100, 50, 160], ['lavender', 180, 160, 220], ['charcoal black', 35, 35, 38],
  ['slate gray', 110, 118, 130], ['warm ivory', 244, 241, 234], ['chocolate brown', 90, 60, 40], ['coral pink', 250, 120, 110],
]
function hexToColorName(hex: string): string {
  const h = hex.replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'deep navy blue'
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  let best = NAMED_COLORS[0][0], bd = Infinity
  for (const [name, nr, ng, nb] of NAMED_COLORS) {
    const d = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2
    if (d < bd) { bd = d; best = name }
  }
  return best
}
// Background clause from the user's requested background (default white).
function bgClause(background?: string): string {
  const b = (background || 'white').toLowerCase().trim()
  if (b === 'transparent') return 'on a transparent background'
  if (!b || b === 'white') return 'on a solid white background'
  return `on a solid ${b} background`
}
// The always-on text bans (the wordmark is typeset in code, so the mark carries no
// letters). Render-effect bans are DROPPED when the user's style asks for that very
// effect — banning "3D" while the user asked for "3D glossy" fights their request.
function negativesFor(userStyle?: string): string {
  const s = (userStyle || '').toLowerCase()
  let n = 'no text, no letters, no words, no typography, no mockup, no watermark'
  if (!/photo|realistic|photoreal/.test(s)) n += ', no photo'
  if (!/3d|three-?dimensional|isometric|clay|glossy|emboss|extrude|chrome/.test(s)) n += ', no 3D render'
  if (!/shadow|emboss|deboss|3d|glossy|chrome|watercolor|paint|brush/.test(s)) n += ', no drop shadow'
  if (!/gradient|neon|glow|duotone|holograph|chrome|glossy|watercolor|paint|brush|airbrush|metallic/.test(s)) n += ', no gradient'
  return n
}
// Build the diffusion prompt. FAITHFUL (literal) mode leads with the user's exact
// described mark + their own style words and adds NO house adjectives or award-bait
// — that imposed styling was the "random stuff". Non-literal (user gave no picture)
// keeps the polished preset look.
function logoImgUrl(o: {
  symbol: string; colorDesc: string; seed: number
  literal: boolean; userStyle?: string; background?: string; presetKey?: string
}): string {
  const bg = bgClause(o.background)
  const negatives = negativesFor(o.userStyle)
  const us = (o.userStyle || '').trim()
  let prompt: string
  if (o.literal) {
    // The user described it — reproduce THAT, nothing else.
    const styleClause = us ? `${us} logo mark` : 'flat 2D vector logo mark'
    prompt = `${o.symbol}, ${styleClause}, ${o.colorDesc}, single centered icon ${bg}, generous margin, clean crisp edges, ${negatives}`
  } else {
    // No picture given — apply today's polished house style; a userStyle (rare
    // here) still overrides the preset's look.
    const preset = LOGO_STYLES.find((s) => s.key === o.presetKey) || LOGO_STYLES[0]
    prompt = `professional vector logo mark, ${preset.archetype}: ${o.symbol}, ${us || preset.desc}, flat 2D vector illustration, ${o.colorDesc}, one single centered icon ${bg}, generous margin, crisp edges, iconic and memorable, dribbble behance award-winning logo design, ${negatives}`
  }
  // flux for crisp, high-quality marks; the server proxy retries + falls back.
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=768&nologo=true&model=flux&seed=${o.seed}`
}
// Once generated, a logo image is CACHED — revisiting a chat or the Studio
// gallery must never re-run the diffusion model. In-memory for the session +
// a small localStorage LRU so it survives reloads.
const logoMemCache = new Map<string, string>()
const LOGO_CACHE_KEY = 'nalu-logo-img-cache'
const LOGO_CACHE_MAX = 60 // ~20 logos' worth (was 9 = ~3, which evicted almost immediately)
function logoCacheGet(url: string): string {
  const hit = logoMemCache.get(url)
  if (hit) return hit
  try {
    const store = JSON.parse(localStorage.getItem(LOGO_CACHE_KEY) || '{}') as Record<string, string>
    if (store[url]) {
      logoMemCache.set(url, store[url])
      // LRU touch: move this key to the end so it survives eviction.
      const v = store[url]; delete store[url]; store[url] = v
      try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(store)) } catch { /* quota */ }
      return v
    }
  } catch { /* */ }
  return ''
}
function logoCachePut(url: string, dataUrl: string) {
  logoMemCache.set(url, dataUrl)
  try {
    const store = JSON.parse(localStorage.getItem(LOGO_CACHE_KEY) || '{}') as Record<string, string>
    delete store[url]; store[url] = dataUrl // re-insert at end (most-recent)
    let keys = Object.keys(store)
    while (keys.length > LOGO_CACHE_MAX) { delete store[keys.shift() as string] }
    // If it still won't fit the quota, drop oldest until it does — never silently lose the NEW one.
    for (;;) {
      try { localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(store)); break } catch {
        keys = Object.keys(store); if (keys.length <= 1) break; delete store[keys[0]]
      }
    }
  } catch { /* in-memory cache still holds it this session */ }
}
// Generation is called only by explicit Generate/Retry/Regenerate controls.
// Viewing saved artifacts and changing style never launch provider work.
async function fetchLogoImage(url: string, signal: AbortSignal): Promise<string> {
  const cached = logoCacheGet(url)
  if (cached) return cached
  const token = getToken()
  const prompt = decodeURIComponent((url.match(/\/prompt\/([^?]+)/) || [])[1] || '')
  if (!prompt) throw new Error('The logo prompt is missing.')
  const response = await fetch('/api/image', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ prompt, size: '768x768' }),
  })
  const data = await response.json() as { url?: string; error?: string }
  signal.throwIfAborted()
  if (!response.ok || !data.url) throw new Error(data.error || 'The logo image could not be generated.')
  logoCachePut(url, data.url)
  return data.url
}

type LogoSlot = { st: 'idle' | 'loading' | 'done' | 'error'; data: string; error?: string }
const downloadDataUrl = (data: string, filename: string) => {
  const a = document.createElement('a')
  a.href = data; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
}
// Composite the generated mark + a code-typeset wordmark onto one clean canvas —
// crisp typography (diffusion models garble letters) under a crisp icon.
function downloadLogoLockup(markDataUrl: string, name: string, serif: boolean, filename: string) {
  if (!name.trim()) return downloadDataUrl(markDataUrl, filename)
  const img = new Image()
  img.onload = () => {
    const W = 1200
    const markSize = 680
    const gap = 56
    const fontPx = Math.min(120, Math.floor((W * 0.82) / Math.max(4, name.length) / 0.62))
    const H = 120 + markSize + gap + fontPx + 120
    const cv = document.createElement('canvas')
    cv.width = W; cv.height = H
    const ctx = cv.getContext('2d')
    if (!ctx) return downloadDataUrl(markDataUrl, filename)
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H)
    ctx.drawImage(img, (W - markSize) / 2, 120, markSize, markSize)
    ctx.fillStyle = '#111111'
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.font = `${serif ? '500' : '600'} ${fontPx}px ${serif ? 'Georgia, "Times New Roman", serif' : 'Inter, "Helvetica Neue", Arial, sans-serif'}`
    const label = serif ? name : name.toUpperCase()
    if (!serif) { /* letter-spaced caps for the sans lockup */ }
    ctx.fillText(label, W / 2, 120 + markSize + gap)
    downloadDataUrl(cv.toDataURL('image/png'), filename)
  }
  img.onerror = () => downloadDataUrl(markDataUrl, filename)
  img.src = markDataUrl
}
// Deterministic-but-well-spread seed (hash), so styles/rounds never collide.
function seedFor(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) }
  return Math.abs(h % 999983) + 1
}
function LogoImages({ name, brand, accent, symbol, colorNames, serif, literal, colorsLocked, userStyle, background, saved, onCache }: { name: string; brand: string; accent?: string; symbol?: string; colorNames?: string[]; serif?: boolean; literal?: boolean; colorsLocked?: boolean; userStyle?: string; background?: string; saved?: Record<string, string>; onCache?: (url: string, dataUrl: string) => void }) {
  const scoped = useScopedArtifact()
  const [savedChoice, setSavedChoice] = useState<number | null>(null)
  const [saveError, setSaveError] = useState('')
  const saveImage = async (data: string, index: number) => {
    setSaveError('')
    try {
      // Brand storage has a size cap; save a compact real mark, not a discarded
      // full-resolution data URL or an unrelated generated monogram.
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = data; await img.decode()
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')
      let logo = ''
      for (const size of [384, 256, 128, 64]) {
        const scale = size / Math.max(img.naturalWidth, img.naturalHeight)
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height); logo = canvas.toDataURL('image/png')
        if (logo.length <= 175000) break
      }
      if (logo.length > 175000) throw new Error('Image too large')
      const next = { ...(getBrand() || DEFAULT_BRAND), name: name || 'Logo', logo, logoMark: logo }
      setBrand(next); savePalette(next); setSavedChoice(index)
    } catch { setSaveError('Could not save this mark. You can still download it.') }
  }
  // `explore` = the user opted IN to reinterpreting a faithful mark in other house
  // styles. `preset` = which of the 8 styles (only used when NOT faithful).
  const [explore, setExplore] = useState(false)
  const [preset, setPreset] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  // Seed the cache from the artifact's saved images (persisted in the DB) so every
  // logo you ever made shows INSTANTLY on revisit — browse them all, anytime.
  useMemo(() => { if (!scoped && saved) for (const [u, d] of Object.entries(saved)) if (u && d) logoMemCache.set(u, d) }, [saved])
  // FAITHFUL = the user described the mark or named a style, and hasn't opted to
  // explore other looks → reproduce exactly what they asked for. Otherwise apply a
  // polished house style. Default preset is luxury/modern (not the old forced 'minimal').
  const faithful = (!!literal || !!(userStyle || '').trim()) && !explore
  const presetKey = preset ?? (serif ? 'luxury' : 'modern')
  // The mark concept. When literal we use the user's exact symbol; when inventing we
  // fall back to a subject-neutral monogram motif. (The wordmark-only case — empty
  // symbol + literal — never reaches here: the call site doesn't render LogoImages then.)
  const concept = (symbol || '').trim() || (literal ? '' : `an abstract geometric emblem evoking "${name}"`)
  const colorDesc = (() => {
    const primaryName = colorNames?.[0] || hexToColorName(brand)
    const accentName = colorNames?.[1] || (accent ? hexToColorName(accent) : '')
    // colorsLocked → the user named the exact color(s); forbid the model adding more.
    if (colorsLocked)
      return accentName ? `colored only ${primaryName} and ${accentName}, no other colors`
        : `colored only ${primaryName}, no other colors`
    return accentName
      ? `two-color palette: ${primaryName} as the dominant color with ${accentName} accents`
      : `monochrome ${primaryName}`
  })()
  // Stable keys let saved images survive revisiting the same style.
  const seedKey = (styleSeg: string, r: number, n: number) => `${name}|${styleSeg}|${userStyle || ''}|${r}|${n}`
  const urlsForRound = (variant: number) => [0, 1, 2].map((n) => logoImgUrl({
      symbol: concept, colorDesc,
      seed: seedFor(seedKey(faithful ? 'faithful' : presetKey, variant, n)),
      literal: faithful, // faithful (described mark OR a named style) → faithful template, no house-style/award-bait
      userStyle: faithful ? (userStyle || '') : '', // the symbol always stays the user's
      background: background || 'white',
      presetKey: faithful ? undefined : presetKey,
    }))
  const urls = useMemo(
    () => urlsForRound(round),
    [name, concept, colorDesc, round, faithful, presetKey, userStyle, background, literal], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const urlKey = urls.join('|')
  // Seed each slot from what's ALREADY cached (saved-in-DB imgCache first, then the
  // local cache) so finished logos show INSTANTLY on (hard) refresh — never reloaded.
  const seedSlot = (u: string): LogoSlot => {
    const c = (saved && saved[u]) || (!scoped ? logoCacheGet(u) : '')
    return c ? { st: 'done', data: c } : { st: 'idle', data: '' }
  }
  const [slots, setSlots] = useState<LogoSlot[]>(() => urls.map(seedSlot))
  const activeKey = useRef(urlKey)
  activeKey.current = urlKey
  const pending = useRef(new Map<string, AbortController>())
  useEffect(() => {
    setSlots(urls.map((url, i) => pending.current.has(urlKey + '#' + i) ? { st: 'loading', data: '' } : seedSlot(url)))
    return () => {
      for (const [key, controller] of pending.current) {
        if (key.startsWith(urlKey + '#')) { controller.abort(); pending.current.delete(key) }
      }
    }
  }, [urlKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const generate = (targets: string[], indices: number[]) => {
    if (scoped) return
    const key = targets.join('|')
    for (const i of indices) {
      const requestKey = key + '#' + i
      if (pending.current.has(requestKey)) continue
      const controller = new AbortController()
      pending.current.set(requestKey, controller)
      setSlots(prev => { const next = prev.slice(); next[i] = { st: 'loading', data: '' }; return next })
      fetchLogoImage(targets[i], controller.signal).then(data => {
        if (controller.signal.aborted) return
        onCache?.(targets[i], data)
        if (activeKey.current === key) setSlots(prev => { const next = prev.slice(); next[i] = { st: 'done', data }; return next })
      }).catch(error => {
        if (!controller.signal.aborted && activeKey.current === key) setSlots(prev => {
          const next = prev.slice(); next[i] = { st: 'error', data: '', error: error instanceof Error ? error.message : 'Generation failed.' }; return next
        })
      }).finally(() => { if (pending.current.get(requestKey) === controller) pending.current.delete(requestKey) })
    }
  }
  const regenerate = () => {
    const nextRound = round + 1, targets = urlsForRound(nextRound)
    activeKey.current = targets.join('|')
    setRound(nextRound)
    generate(targets, [0, 1, 2])
  }
  const loading = slots.some(slot => slot.st === 'loading') || [...pending.current.keys()].some(key => key.startsWith(urlKey + '#'))
  const doneCount = slots.filter(slot => slot.st === 'done').length
  const generationError = slots.find(slot => slot.error)?.error

  return (
    <div className="border-t border-glass/[0.08] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">AI logo images</span>
        {!scoped && (faithful ? (
          // FAITHFUL: no imposed styles — we render exactly what was described. Show
          // a read-only chip + a quiet opt-in to explore other looks.
          <>
            <span className="rounded px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-100">As described{(userStyle || '').trim() ? ` · ${userStyle}` : ''}</span>
            {(!!literal || !!(userStyle || '').trim()) && (
              <button onClick={() => setExplore(true)} className="rounded px-1.5 py-0.5 text-[10px] text-dim hover:bg-glass/10 hover:text-ink">Try other styles ▾</button>
            )}
          </>
        ) : (
          <>
            {(!!literal || !!(userStyle || '').trim()) && (
              <button onClick={() => { setExplore(false); setPreset(null) }} className="rounded px-1.5 py-0.5 text-[10px] text-dim hover:bg-glass/10 hover:text-ink">← As described</button>
            )}
            {LOGO_STYLES.map((s) => (
              <button
                key={s.key}
                onClick={() => setPreset(s.key)}
                className={`rounded px-1.5 py-0.5 text-[10px] ${presetKey === s.key ? 'bg-amber-500/25 text-amber-100' : 'bg-glass/10 text-dim hover:bg-glass/20'}`}
              >
                {s.label}
              </button>
            ))}
          </>
        ))}
        {!scoped && <button disabled={loading} onClick={() => generate(urls, slots.flatMap((s, i) => s.st !== 'done' ? [i] : []))} className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-dim hover:bg-glass/10 hover:text-ink disabled:opacity-50">Generate images</button>}
        {!scoped && <button disabled={loading} onClick={regenerate} className="disabled:opacity-50 rounded px-1.5 py-0.5 text-[10px] text-dim hover:bg-glass/10 hover:text-ink">
          Regenerate
        </button>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {/* Each logo appears the instant IT finishes — no waiting for all three. */}
        {slots.map((s, i) => (
              <div key={i} className="group relative aspect-square overflow-hidden rounded-xl border border-glass/10 bg-white animate-fadeIn">
                {s.st === 'done' ? (
                  <>
                    <div className="flex h-full w-full flex-col items-center justify-center">
                      <img src={s.data} alt={name ? `${name} logo` : "Logo mark"} className={`${name ? "h-[78%]" : "h-full"} w-full object-contain`} />
                      {name && <div
                        className="max-w-[92%] truncate px-1 text-center text-black"
                        style={{ fontFamily: serif ? 'Georgia, serif' : 'Inter, sans-serif', fontWeight: serif ? 500 : 600, fontSize: '13px', letterSpacing: serif ? '0.02em' : '0.14em' }}
                      >
                        {serif ? name : name.toUpperCase()}
                      </div>}
                    </div>
                    <div className="absolute inset-x-1.5 bottom-1.5 flex flex-wrap justify-end gap-1">
                      {!scoped && <button onClick={() => saveImage(s.data, i)} className="rounded-md bg-black/65 px-2 py-1 text-[10px] font-medium text-white">{savedChoice === i ? 'Saved' : 'Save to Brand'}</button>}
                      <button onClick={() => downloadLogoLockup(s.data, name, !!serif, `${slug(name, 'nalu-logo')}-${faithful ? 'logo' : presetKey}-${i + 1}.png`)} className="rounded-md bg-black/65 px-2 py-1 text-[10px] font-medium text-white">Download</button>
                    </div>
                  </>
                ) : s.st === 'loading' ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-white">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-black/15 border-t-accent" />
                  </div>
                ) : scoped ? <div className="flex h-full items-center justify-center p-2 text-center text-xs text-black/60">No saved image</div> : (
                  <button onClick={() => generate(urls, [i])} className="absolute inset-0 flex items-center justify-center bg-white text-[10px] text-black/50 hover:bg-black/[0.03]">
                    <span className="rounded-md bg-black/5 px-2 py-1">{s.st === 'idle' ? 'Generate' : 'Retry'}</span>
                  </button>
                )}
              </div>
            ))}
      </div>
      <div className="mt-1.5 text-[10px] text-dim">
        {saveError && <p role="status">{saveError}</p>}
        {generationError && <p role="status">{generationError}</p>}
        {scoped ? 'Saved logo images for this task.' : loading ? `Designing your logos… ${doneCount}/3 ready` : doneCount
          ? 'Saved images are ready. Generate missing images or Regenerate for new options.'
          : 'Choose a style, then Generate images. Generation uses your daily image allowance.'}
      </div>
    </div>
  )
}

export function LogoCard({ art, onUpdate }: { art: LogoArt; onUpdate?: (art: LogoArt) => void }) {
  const scoped = useScopedArtifact()
  // Accumulate generated logo images into the artifact (capped) + persist them,
  // debounced, so all your logos are saved in the DB — browse them whenever.
  const imgAcc = useRef<Record<string, string>>({ ...(art.imgCache || {}) })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cacheImg = useCallback((url: string, dataUrl: string) => {
    if (!onUpdate || imgAcc.current[url] === dataUrl) return
    imgAcc.current[url] = dataUrl
    const keys = Object.keys(imgAcc.current)
    while (keys.length > 24) delete imgAcc.current[keys.shift() as string] // bound payload (~8 logos)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => onUpdate({ ...art, imgCache: { ...imgAcc.current } }), 900)
  }, [onUpdate, art])
  // Prefer code-generated options (reliably clean). Legacy artifacts that carry
  // freehand LLM SVG options still render via the same path.
  const pictorialOnly = !!art.symbol?.trim() && !art.options?.length && !art.mark && !art.lockup
  const options: LogoOption[] =
    art.options && art.options.length
      ? art.options
      : !pictorialOnly && (art.initials || art.name)
        ? genLogoOptions(art.name || art.initials || '', art.initials || initialsFrom(art.name || ''), !!art.serif)
        : [{ concept: art.concept, mark: art.mark, lockup: art.lockup }]
  const [sel, setSel] = useState(0)
  const [savedBrand, setSavedBrand] = useState(false)
  const opt = options[Math.min(sel, options.length - 1)]
  const lockup = opt.lockup || opt.mark || ''
  const mark = opt.mark || opt.lockup || ''
  const name = art.name || 'Logo'
  const base = slug(name, 'nalu-logo') + (options.length > 1 ? `-${sel + 1}` : '')
  const colors = (art.colors || []).filter((c) => /^#?[0-9a-fA-F]{3,8}$/.test(c)).slice(0, 6)
  const brand = colors[0] ? (colors[0].startsWith('#') ? colors[0] : '#' + colors[0]) : '#0F1B2D'

  // export honours currentColor by baking the requested color into the SVG.
  const exportPng = (svg: string, label: string, color: string, bg: string | null) =>
    svgToPng(colorize(svg, color), 1400, bg, (url) => {
      const a = document.createElement('a')
      a.href = url
      a.download = `${base}-${label}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
    })

  // Tie THIS logo to the Brand bar: set it (full lockup + compact mark) on the active
  // brand's color scheme + fonts, and save it as a reusable brand-book chip.
  const saveToBrand = () => {
    const fullUrl = svgToLogoUrl(colorize(lockup, brand))
    if (!fullUrl) return
    const cur = getBrand() || DEFAULT_BRAND
    const nm = !cur.name || cur.name.toLowerCase() === 'nalu' ? name : cur.name
    const next = { ...cur, name: nm, logo: fullUrl, logoMark: svgToLogoUrl(colorize(mark, brand)) || fullUrl }
    setBrand(next)
    savePalette(next)
    setSavedBrand(true)
    setTimeout(() => setSavedBrand(false), 1600)
  }

  const SvgBox = ({
    svg,
    color,
    bg,
    border,
    h,
  }: {
    svg: string
    color: string
    bg: string
    border: string
    h: string
  }) => (
    <div
      className={`flex ${h} items-center justify-center overflow-hidden rounded-xl border ${border} p-6`}
      style={{ backgroundColor: bg, color }}
    >
      {/* The wrapper must have a DEFINITE size or a viewBox-only SVG collapses to
          nothing. h-full/w-full off the fixed-height box + preserveAspectRatio
          (default "meet") contains + centers the art. */}
      <img className="h-full w-full object-contain" src={logoImageUrl(svg, color)} alt={`${name} logo`} />
    </div>
  )

  return (
    <CardShell
      icon={<Sparkles size={15} />}
      tint="bg-amber-500/15 text-amber-300"
      title={name}
      subtitle={opt.concept || 'Logo — designed in black & white first'}
      actions={
        lockup ? <>
          {!scoped && <ActionBtn onClick={saveToBrand} tint="bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25">
            {savedBrand ? <Check size={13} /> : <Star size={13} />} {savedBrand ? 'Saved to Brand' : 'Save to Brand'}
          </ActionBtn>}
          <ActionBtn onClick={() => downloadText(isolatedLogoSvg(lockup), `${base}.svg`, 'image/svg+xml')}>
            <FileCode2 size={13} /> SVG
          </ActionBtn>
          <ActionBtn onClick={() => exportPng(mark, 'mark-black', '#000000', '#FFFFFF')}>
            <ImageIcon size={13} /> Mark PNG
          </ActionBtn>
          <ActionBtn onClick={() => exportPng(lockup, 'logo', brand, '#FFFFFF')} primary tint="bg-amber-500/20 text-amber-200 hover:bg-amber-500/30">
            <ImageIcon size={13} /> PNG
          </ActionBtn>
        </> : undefined
      }
    >
      {lockup && <>
      {/* Concept options — a real designer presents a few directions. */}
      {options.length > 1 && (
        <div className="flex gap-2 border-b border-glass/[0.08] px-4 py-3">
          {options.map((o, i) => (
            <button
              key={i}
              onClick={() => setSel(i)}
              className={`flex h-16 flex-1 items-center justify-center rounded-lg border bg-white text-black transition ${
                i === sel ? 'border-amber-400 ring-1 ring-amber-400/40' : 'border-black/10 hover:border-black/30'
              }`}
              title={`Concept ${i + 1}`}
            >
              <img className="h-10 w-10 object-contain" src={logoImageUrl(o.mark || o.lockup || '')} alt={`Concept ${i + 1} logo`} />
            </button>
          ))}
        </div>
      )}

      {/* PRIMARY: black & white — the real test a designer runs first. */}
      <div className="px-4 pt-4">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Black &amp; white (primary)</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SvgBox svg={lockup} color="#0B0B0B" bg="#FFFFFF" border="border-black/10" h="h-36" />
          <SvgBox svg={lockup} color="#FFFFFF" bg="#0B0B0B" border="border-glass/10" h="h-36" />
        </div>
      </div>

      {/* COLOR treatment. */}
      <div className="px-4 pt-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">In color</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SvgBox svg={lockup} color={brand} bg="#F4F1EA" border="border-black/10" h="h-36" />
          <SvgBox svg={lockup} color="#FFFFFF" bg={brand} border="border-glass/10" h="h-36" />
        </div>
      </div>

      {/* The MARK alone, on light + dark + tiny (favicon test). */}
      <div className="px-4 py-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">The mark · scales to a favicon</div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          <SvgBox svg={mark} color="#0B0B0B" bg="#FFFFFF" border="border-black/10" h="h-24" />
          <SvgBox svg={mark} color="#FFFFFF" bg="#0B0B0B" border="border-glass/10" h="h-24" />
          <SvgBox svg={mark} color={brand} bg="#F4F1EA" border="border-black/10" h="h-24" />
          <div className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-black/10 bg-white">
            <img className="h-8 w-8 object-contain" src={logoImageUrl(mark)} alt={`${name} mark at 32 pixels`} />
            <img className="h-4 w-4 object-contain" src={logoImageUrl(mark)} alt={`${name} mark at 16 pixels`} />
          </div>
        </div>
      </div>

      </>}

      {/* Wordmark-only request (literal + no pictorial symbol) → the code-typeset
          marks above ARE the logo; skip the diffusion image grid entirely. */}
      {!(art.literal && !(art.symbol || '').trim()) && (
        <LogoImages
          name={art.name?.trim() || ''}
          brand={brand}
          accent={colors[1] ? (colors[1].startsWith('#') ? colors[1] : '#' + colors[1]) : undefined}
          symbol={art.symbol}
          colorNames={art.colorNames}
          serif={!!art.serif}
          literal={art.literal}
          colorsLocked={art.colorsLocked}
          userStyle={art.userStyle}
          background={art.background}
          saved={art.imgCache}
          onCache={cacheImg}
        />
      )}

      {colors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-glass/[0.08] px-4 py-3">
          <span className="text-[11px] uppercase tracking-wide text-dim">Palette</span>
          {colors.map((c, i) => {
            const hex = c.startsWith('#') ? c : '#' + c
            return (
              <button
                key={i}
                onClick={() => void navigator.clipboard?.writeText(hex.toUpperCase())}
                title={`Copy ${hex}`}
                className="flex items-center gap-1.5 rounded-md bg-glass/[0.05] px-2 py-1 text-[11px] text-ink"
              >
                <span className="h-3.5 w-3.5 rounded-sm border border-glass/20" style={{ backgroundColor: hex }} />
                {hex.toUpperCase()}
              </button>
            )
          })}
          {art.font && <span className="ml-1 text-[11px] italic text-dim">{art.font}</span>}
        </div>
      )}
    </CardShell>
  )
}

// ===== BlueprintCard ==========================================================

const BP_PAD = 56 // px padding around drawing for dimensions/labels
const BP_SCALE = 22 // px per unit

export function BlueprintCard({ art }: { art: BlueprintArt }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [view3d, setView3d] = useState(false)
  const [walkMode, setWalkMode] = useState(false) // 3D opened straight into walk-through
  // Multi-floor: a set of sheets (Site Plan, Ground Floor, …). Falls back to a
  // single legacy drawing. The selected floor drives the SVG and the 3D model.
  const floors: BPFloor[] = useMemo(() => art.floors && art.floors.length
    ? art.floors
    : [{ name: 'Plan', viewBox: art.viewBox || { w: 40, h: 28 }, shapes: art.shapes, dimensions: art.dimensions, annotations: art.annotations }],
  [art.floors, art.viewBox, art.shapes, art.dimensions, art.annotations])
  const [floorIdx, setFloorIdx] = useState(0)
  const floor = floors[Math.min(floorIdx, floors.length - 1)]
  const vb = floor.viewBox || { w: 40, h: 28 }
  // Site vs building floors: the 3D stacks all building floors into one model;
  // a site plan renders as its own lot. (A floor is a "site" if named so or it
  // carries trees / a pool.)
  const isSiteFloor = (f: BPFloor) =>
    /site|plot|\blot\b|landscap|grounds/.test((f.name || '').toLowerCase()) ||
    (f.shapes || []).some((s) => s.type === 'tree' || (s.type === 'ellipse' && /pool/.test((s as { label?: string }).label?.toLowerCase() || '')))
  const curIsSite = isSiteFloor(floor)
  // Blueprint3D rebuilds its renderer when floors change. Keep that input
  // stable across account-save, theme and other unrelated parent renders.
  const threeFloors: BPFloor[] = useMemo(() => {
    if (curIsSite) return [floor]
    const buildingFloors = floors.filter((f) => !isSiteFloor(f))
    return buildingFloors.length ? buildingFloors : floors
  }, [floors, floor, curIsSite])
  const step = art.grid?.step ?? 2
  const showGrid = art.grid?.show ?? true
  const units = art.units || ''
  const title = art.title || 'Nalu Blueprint'
  const base = slug(title, 'nalu-blueprint')

  const innerW = vb.w * BP_SCALE
  const innerH = vb.h * BP_SCALE
  const W = innerW + BP_PAD * 2
  const H = innerH + BP_PAD * 2
  const X = (u: number) => BP_PAD + u * BP_SCALE
  const Y = (u: number) => BP_PAD + u * BP_SCALE

  const STROKE = '#79b8ff'
  const FAINT = 'rgba(121,184,255,0.14)'
  const TEXT = '#cfe3ff'
  const DIM = '#8fb6e6'

  const gridLines: React.ReactNode[] = []
  if (showGrid && step > 0) {
    for (let x = 0; x <= vb.w + 0.001; x += step) gridLines.push(<line key={`gx${x}`} x1={X(x)} y1={Y(0)} x2={X(x)} y2={Y(vb.h)} stroke={FAINT} strokeWidth={1} />)
    for (let y = 0; y <= vb.h + 0.001; y += step) gridLines.push(<line key={`gy${y}`} x1={X(0)} y1={Y(y)} x2={X(vb.w)} y2={Y(y)} stroke={FAINT} strokeWidth={1} />)
  }

  const renderShape = (s: BPShape, i: number): React.ReactNode => {
    const sw = ('stroke' in s && s.stroke ? s.stroke : 1.5)
    switch (s.type) {
      case 'rect':
        return (
          <g key={i}>
            <rect x={X(s.x)} y={Y(s.y)} width={s.w * BP_SCALE} height={s.h * BP_SCALE} fill="none" stroke={STROKE} strokeWidth={sw} />
            {s.label && <text x={X(s.x) + 4} y={Y(s.y) + 14} fill={TEXT} fontSize={11} fontFamily="Inter, sans-serif">{s.label}</text>}
          </g>
        )
      case 'line':
        return <line key={i} x1={X(s.x1)} y1={Y(s.y1)} x2={X(s.x2)} y2={Y(s.y2)} stroke={STROKE} strokeWidth={sw} />
      case 'circle':
        return (
          <g key={i}>
            <circle cx={X(s.cx)} cy={Y(s.cy)} r={s.r * BP_SCALE} fill="none" stroke={STROKE} strokeWidth={sw} />
            {s.label && <text x={X(s.cx)} y={Y(s.cy)} fill={TEXT} fontSize={11} textAnchor="middle" dominantBaseline="middle" fontFamily="Inter, sans-serif">{s.label}</text>}
          </g>
        )
      case 'ellipse':
        return (
          <g key={i}>
            <ellipse cx={X(s.cx)} cy={Y(s.cy)} rx={s.rx * BP_SCALE} ry={s.ry * BP_SCALE} fill="none" stroke={STROKE} strokeWidth={sw} />
            {s.label && <text x={X(s.cx)} y={Y(s.cy)} fill={TEXT} fontSize={11} textAnchor="middle" dominantBaseline="middle" fontFamily="Inter, sans-serif">{s.label}</text>}
          </g>
        )
      case 'tree': {
        const r = s.r * BP_SCALE
        return (
          <g key={i}>
            <circle cx={X(s.cx)} cy={Y(s.cy)} r={r} fill="rgba(121,184,255,0.06)" stroke={STROKE} strokeWidth={1} />
            <circle cx={X(s.cx)} cy={Y(s.cy)} r={r * 0.62} fill="none" stroke={DIM} strokeWidth={0.8} />
            <circle cx={X(s.cx)} cy={Y(s.cy)} r={1.6} fill={DIM} />
            {s.label && <text x={X(s.cx)} y={Y(s.cy) + r + 11} fill={TEXT} fontSize={9} textAnchor="middle" fontFamily="Inter, sans-serif">{s.label}</text>}
          </g>
        )
      }
      case 'polyline':
        return <polyline key={i} points={s.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ')} fill="none" stroke={STROKE} strokeWidth={sw} />
      case 'text':
        return <text key={i} x={X(s.x)} y={Y(s.y)} fill={TEXT} fontSize={12} fontFamily="Inter, sans-serif">{s.text}</text>
      case 'door': {
        const r = s.w * BP_SCALE
        const dir = s.swing === 'right' ? 1 : -1
        const hx = X(s.x)
        const hy = Y(s.y)
        // Vertical-wall doors (dir:"v") rotate the whole symbol 90° about the
        // hinge, so openings in side walls draw correctly instead of sideways.
        const vertical = (s as { dir?: string }).dir === 'v'
        return (
          <g key={i} {...(vertical ? { transform: `rotate(90 ${hx} ${hy})` } : {})}>
            {/* jamb gap */}
            <line x1={hx} y1={hy} x2={hx + r} y2={hy} stroke="rgba(11,15,22,1)" strokeWidth={3} />
            {/* leaf (open) */}
            <line x1={hx} y1={hy} x2={hx} y2={hy + dir * r} stroke={STROKE} strokeWidth={1.5} />
            {/* swing arc */}
            <path d={`M ${hx} ${hy + dir * r} A ${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${hx + r} ${hy}`} fill="none" stroke={DIM} strokeWidth={1} strokeDasharray="3 2" />
          </g>
        )
      }
      case 'window': {
        const len = s.w * BP_SCALE
        const x = X(s.x)
        const y = Y(s.y)
        const vertical = (s as { dir?: string }).dir === 'v'
        return (
          <g key={i} {...(vertical ? { transform: `rotate(90 ${x} ${y})` } : {})}>
            <line x1={x} y1={y} x2={x + len} y2={y} stroke="rgba(11,15,22,1)" strokeWidth={4} />
            <line x1={x} y1={y - 2} x2={x + len} y2={y - 2} stroke={STROKE} strokeWidth={1} />
            <line x1={x} y1={y} x2={x + len} y2={y} stroke={STROKE} strokeWidth={1} />
            <line x1={x} y1={y + 2} x2={x + len} y2={y + 2} stroke={STROKE} strokeWidth={1} />
          </g>
        )
      }
      default:
        return null
    }
  }

  const renderDim = (d: BPDimension, i: number): React.ReactNode => {
    const mx = (X(d.x1) + X(d.x2)) / 2
    const my = (Y(d.y1) + Y(d.y2)) / 2
    return (
      <g key={`d${i}`}>
        <line x1={X(d.x1)} y1={Y(d.y1)} x2={X(d.x2)} y2={Y(d.y2)} stroke={DIM} strokeWidth={1} markerStart="url(#bpArrowStart)" markerEnd="url(#bpArrowEnd)" />
        {d.text && (
          <text x={mx} y={my - 4} fill={DIM} fontSize={10} textAnchor="middle" fontFamily="Inter, sans-serif">
            {d.text}{units && !/\b(ft|m|cm|mm|in|px)\b/.test(d.text) ? ` ${units}` : ''}
          </text>
        )}
      </g>
    )
  }

  const renderAnno = (a: BPAnnotation, i: number): React.ReactNode => (
    <g key={`a${i}`}>
      {a.leaderTo && <line x1={X(a.x)} y1={Y(a.y)} x2={X(a.leaderTo[0])} y2={Y(a.leaderTo[1])} stroke={DIM} strokeWidth={1} strokeDasharray="3 2" />}
      <circle cx={X(a.x)} cy={Y(a.y)} r={2.5} fill={DIM} />
      <text x={X(a.x) + 6} y={Y(a.y) - 4} fill={TEXT} fontSize={11} fontFamily="Inter, sans-serif">{a.text}</text>
    </g>
  )

  const serialize = (): string => {
    const node = svgRef.current
    if (!node) return ''
    const clone = node.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
  }

  const exportSvg = () => {
    const svg = serialize()
    if (svg) downloadText(svg, `${base}.svg`, 'image/svg+xml')
  }

  const exportPng = () => {
    const svg = serialize()
    if (!svg) return
    const scale = 2
    const img = new Image()
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = W * scale
      canvas.height = H * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        return
      }
      ctx.fillStyle = '#0b0e16'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((b) => {
        if (b) downloadBlob(b, `${base}.png`)
        URL.revokeObjectURL(url)
      }, 'image/png')
    }
    img.onerror = () => URL.revokeObjectURL(url)
    img.src = url
  }

  const exportPdf = async () => {
    const svg = serialize()
    if (!svg) return
    const scale = 2
    const img = new Image()
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = W * scale
      canvas.height = H * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        return
      }
      ctx.fillStyle = '#0b0e16'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const png = canvas.toDataURL('image/png')
      URL.revokeObjectURL(url)
      const { jsPDF } = await import('jspdf')
      const orient = W >= H ? 'landscape' : 'portrait'
      const pdf = new jsPDF({ orientation: orient, unit: 'pt', format: 'a4' })
      const pw = pdf.internal.pageSize.getWidth()
      const ph = pdf.internal.pageSize.getHeight()
      const r = Math.min((pw - 48) / W, (ph - 48) / H)
      const dw = W * r
      const dh = H * r
      pdf.setFillColor(11, 14, 22)
      pdf.rect(0, 0, pw, ph, 'F')
      pdf.addImage(png, 'PNG', (pw - dw) / 2, (ph - dh) / 2, dw, dh)
      pdf.save(`${base}.pdf`)
    }
    img.onerror = () => URL.revokeObjectURL(url)
    img.src = url
  }

  return (
    <CardShell
      icon={<Ruler size={15} />}
      tint="bg-sky-500/15 text-sky-300"
      title={title}
      subtitle={`Technical drawing${units ? ` · ${units}` : ''}${art.scale ? ` · ${art.scale}` : ''} · ${vb.w}×${vb.h}`}
      actions={
        <>
          <ActionBtn onClick={() => { setView3d(true); setWalkMode(true) }} primary tint="bg-amber-500/20 text-amber-200 hover:bg-amber-500/30">
            <Footprints size={13} /> Walk through
          </ActionBtn>
          <ActionBtn onClick={() => { setView3d((v) => !(v && !walkMode)); setWalkMode(false) }} primary tint="bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30">
            {view3d && !walkMode ? <PencilRuler size={13} /> : <Box size={13} />} {view3d && !walkMode ? '2D Plan' : 'View 3D'}
          </ActionBtn>
          <ActionBtn onClick={exportSvg}><FileCode2 size={13} /> SVG</ActionBtn>
          <ActionBtn onClick={() => void exportPdf()}><Download size={13} /> PDF</ActionBtn>
          <ActionBtn onClick={exportPng}>
            <ImageIcon size={13} /> PNG
          </ActionBtn>
        </>
      }
    >
      {floors.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-glass/[0.08] bg-canvas px-3 py-2">
          {floors.map((f, i) => (
            <button
              key={i}
              onClick={() => setFloorIdx(i)}
              className={`rounded-md px-2.5 py-1 text-[11px] ${
                i === floorIdx ? 'bg-sky-500/20 text-sky-200' : 'bg-glass/[0.05] text-dim hover:bg-glass/10'
              }`}
            >
              {f.name || `Level ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {view3d ? (
        <CardErrorBoundary label="The 3D view">
          <Suspense fallback={<div className="flex h-[30rem] items-center justify-center bg-canvas text-sm text-dim">Building 3D model…</div>}>
            <Blueprint3D key={walkMode ? 'walk' : 'orbit'} floors={threeFloors} mode={curIsSite ? 'site' : 'building'} units={art.units} storeKey={base} startWalk={walkMode} />
          </Suspense>
        </CardErrorBoundary>
      ) : (
      <div className="bg-canvas p-4">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          data-blueprint="1"
          preserveAspectRatio="xMidYMid meet"
          className="mx-auto block h-auto w-full"
          style={{ maxHeight: '72vh', background: '#0b0e16' }}
        >
          <defs>
            <marker id="bpArrowEnd" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill={DIM} />
            </marker>
            <marker id="bpArrowStart" markerWidth="8" markerHeight="8" refX="1" refY="4" orient="auto">
              <path d="M8,0 L0,4 L8,8 Z" fill={DIM} />
            </marker>
          </defs>
          {gridLines}
          {(floor.shapes || []).map(renderShape)}
          {(floor.dimensions || []).map(renderDim)}
          {(floor.annotations || []).map(renderAnno)}
        </svg>
      </div>
      )}
    </CardShell>
  )
}

// ===== ShoppingCard ===========================================================
// AI-curated shopping list. Live product APIs return junk without a paid key, so
// the AI picks real products + retailers and we build reliable SEARCH links
// (Google Shopping / Amazon / the named store) that always resolve.

const STORE_URL: Record<string, (q: string) => string> = {
  ikea: (q) => `https://www.ikea.com/us/en/search/?q=${q}`,
  amazon: (q) => `https://www.amazon.com/s?k=${q}`,
  wayfair: (q) => `https://www.wayfair.com/keyword.php?keyword=${q}`,
  article: (q) => `https://www.article.com/search?q=${q}`,
  'west elm': (q) => `https://www.westelm.com/search/results.html?words=${q}`,
  cb2: (q) => `https://www.cb2.com/search?query=${q}`,
  'crate & barrel': (q) => `https://www.crateandbarrel.com/search?query=${q}`,
  'crate and barrel': (q) => `https://www.crateandbarrel.com/search?query=${q}`,
  'pottery barn': (q) => `https://www.potterybarn.com/search/results.html?words=${q}`,
  target: (q) => `https://www.target.com/s?searchTerm=${q}`,
  'home depot': (q) => `https://www.homedepot.com/s/${q}`,
  lowes: (q) => `https://www.lowes.com/search?searchTerm=${q}`,
  "lowe's": (q) => `https://www.lowes.com/search?searchTerm=${q}`,
  allmodern: (q) => `https://www.allmodern.com/keyword.php?keyword=${q}`,
  burrow: (q) => `https://burrow.com/search?q=${q}`,
  floyd: (q) => `https://floyddetroit.com/search?q=${q}`,
}
function storeLink(retailer: string | undefined, query: string): string {
  const q = encodeURIComponent(query)
  const key = (retailer || '').trim().toLowerCase()
  for (const k of Object.keys(STORE_URL)) if (key.includes(k)) return STORE_URL[k](q)
  return `https://www.google.com/search?tbm=shop&q=${q}`
}

// Keyless image generation (Pollinations/FLUX) — a stable seed keeps the image
// from changing on every re-render.
const seedOf = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 100000
}
const genImg = (prompt: string, w: number, h: number, seed: string) =>
  `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&model=flux&seed=${seedOf(seed)}`
const productImg = (it: ShopItem) =>
  genImg(`professional e-commerce product photo of ${it.name}, ${it.category || 'home furnishing'}, on a clean light studio background, soft shadow, centered, no text, no watermark`, 256, 256, it.name)
const roomImg = (art: ShoppingArt) => {
  const feature = (art.items || []).slice(0, 6).map((i) => i.name).join(', ')
  return genImg(`photorealistic interior design magazine photograph of a beautifully styled ${art.title || 'room'}, ${art.summary || ''}, furnished with ${feature}, natural window light, wide angle, elegant, high-end, no text, no people`, 1024, 576, (art.title || '') + feature)
}
const roomVideoPrompt = (art: ShoppingArt) => {
  const feature = (art.items || []).slice(0, 6).map((i) => i.name).join(', ')
  return `slow cinematic walkthrough panning smoothly through a beautifully furnished ${art.title || 'room'}, ${art.summary || ''}, featuring ${feature}, warm natural light, photorealistic interior, magazine quality, no text`
}

export function ShoppingCard({ art }: { art: ShoppingArt }) {
  const scoped = useScopedArtifact()
  const items = Array.isArray(art.items) ? art.items : []
  const title = art.title || 'Shopping List'
  // group by category, preserving first-seen order
  const groups: { name: string; items: ShopItem[] }[] = []
  for (const it of items) {
    const cat = it.category || 'Items'
    let g = groups.find((x) => x.name === cat)
    if (!g) { g = { name: cat, items: [] }; groups.push(g) }
    g.items.push(it)
  }
  const copyList = () => {
    const lines = items.map((it) => `• ${it.name}${it.price ? ` — ${it.price}` : ''}${it.retailer ? ` (${it.retailer})` : ''}\n  ${storeLink(it.retailer, it.query || it.name)}`)
    void navigator.clipboard?.writeText(`${title}\n${art.summary || ''}\n\n${lines.join('\n')}`)
  }

  // "See it in a room" — a real 3D room with the pieces auto-placed (the literal
  // version), plus an AI-rendered scene + on-demand walkthrough video.
  const [show3d, setShow3d] = useState(scoped)
  const roomPlan = useMemo(() => planRoomFromItems(items), [items])
  const [video, setVideo] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; url?: string; msg?: string }>({ state: 'idle' })
  const makeVideo = async () => {
    if (scoped) return
    setVideo({ state: 'loading' })
    try {
      // $0-first: local MiniMax-H3 → in-browser engine → free cloud pool.
      const out = await generateVideo({ prompt: roomVideoPrompt(art) })
      setVideo({ state: 'done', url: out.url })
    } catch (e) {
      setVideo({ state: 'error', msg: e instanceof Error ? e.message : 'Video request failed' })
    }
  }

  return (
    <CardShell
      icon={<ShoppingBag size={15} />}
      tint="bg-accent/20 text-gold"
      title={title}
      subtitle={`${items.length} item${items.length === 1 ? '' : 's'}${art.budget ? ` · ${art.budget}` : ''}`}
      actions={<ActionBtn onClick={copyList}><Copy size={13} /> Copy list</ActionBtn>}
    >
      {/* See the items in a room: a real 3D room with the pieces auto-placed
          (walk it / record it), plus an AI-rendered scene + walkthrough video. */}
      <div className="border-b border-glass/[0.08] bg-canvas p-4 sm:p-5">
        <div className="relative overflow-hidden rounded-xl border border-glass/10 bg-glass/[0.03]">
          {show3d ? (
            <CardErrorBoundary label="The 3D room">
              <Suspense fallback={<div className="flex aspect-video items-center justify-center text-sm text-dim">Building your room…</div>}>
                <Blueprint3D floors={[roomPlan.floor as never]} mode="building" storeKey={`room-${slug(title, 'nalu-room')}`} initialFurniture={roomPlan.furniture as never} />
              </Suspense>
            </CardErrorBoundary>
          ) : video.state === 'done' && video.url ? (
            <video src={video.url} controls autoPlay loop className="aspect-video w-full bg-black" />
          ) : (
            <img
              src={scoped ? undefined : roomImg(art)}
              alt={`${title} — styled room`}
              loading="lazy"
              className="aspect-video w-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          )}
          {!show3d && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-glass/90">The room, furnished</div>
            </div>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {!scoped && <button
            onClick={() => setShow3d((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${show3d ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100' : 'border-accent/30 bg-accent/10 text-gold hover:bg-accent/20'}`}
          >
            <Box size={13} /> {show3d ? 'Back to preview' : `Walk the room in 3D (${roomPlan.placed} pieces)`}
          </button>}
          {!scoped && !show3d && (
            <button
              onClick={() => void makeVideo()}
              disabled={video.state === 'loading'}
              className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-gold hover:bg-accent/20 disabled:opacity-60"
            >
              <Footprints size={13} /> {video.state === 'loading' ? 'Filming the room… (~60s)' : video.state === 'done' ? 'Re-film walkthrough' : 'Walkthrough video'}
            </button>
          )}
          {video.state === 'error' && <span className="text-[11px] text-red-300">{video.msg}</span>}
          <span className="ml-auto text-[10px] text-dim">{show3d ? 'Furnish · Walk through · Record tour' : 'AI-rendered preview'}</span>
        </div>
      </div>
      <div className="bg-canvas px-4 pb-4 pt-3 sm:px-5">
        {art.summary && <p className="mb-4 max-w-2xl text-[13px] italic leading-relaxed text-ink">{art.summary}</p>}
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="mb-2 flex items-center gap-2.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">{g.name}</span>
                <span className="h-px flex-1 bg-gradient-to-r from-accent/30 to-transparent" />
              </div>
              <div className="divide-y divide-glass/[0.06] overflow-hidden rounded-xl border border-glass/[0.08] bg-glass/[0.02]">
                {g.items.map((it, i) => {
                  const href = storeLink(it.retailer, it.query || it.name)
                  return (
                    <div key={i} className="group flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-glass/[0.03] sm:px-4">
                      <a href={href} target="_blank" rel="noopener noreferrer" className="shrink-0">
                        <img
                          src={scoped ? undefined : productImg(it)}
                          alt={it.name}
                          loading="lazy"
                          className="h-12 w-12 rounded-lg border border-glass/10 bg-glass/[0.04] object-cover sm:h-14 sm:w-14"
                          onError={(e) => { const t = e.currentTarget as HTMLImageElement; t.style.visibility = 'hidden' }}
                        />
                      </a>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[13.5px] font-medium text-ink">{it.name}</span>
                          {it.retailer && <span className="text-[11px] text-dim">{it.retailer}</span>}
                        </div>
                        {it.reason && <div className="mt-0.5 truncate text-[12px] leading-snug text-dim">{it.reason}</div>}
                      </div>
                      {it.price && <span className="shrink-0 text-[13px] font-semibold tabular-nums text-gold">{it.price}</span>}
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-gold transition-colors hover:bg-accent/20"
                      >
                        Shop <ExternalLink size={11} />
                      </a>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        {art.budget && (
          <div className="mt-5 flex items-center justify-between border-t border-glass/[0.1] pt-3.5">
            <span className="text-[11px] uppercase tracking-[0.14em] text-dim">Estimated total</span>
            <span className="text-base font-semibold text-ink">{art.budget}</span>
          </div>
        )}
        <div className="mt-2.5 text-[10px] leading-relaxed text-dim">Each link opens a live search at the retailer (or Google Shopping). Prices are designer estimates, not live quotes.</div>
      </div>
    </CardShell>
  )
}
