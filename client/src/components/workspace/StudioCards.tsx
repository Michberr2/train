import { useMemo, useRef, useState, lazy, Suspense } from 'react'
import { Palette, Sparkles, Ruler, Download, Copy, Check, FileJson, FileCode2, Image as ImageIcon, FileText, Star, Box, PencilRuler, ShoppingBag, ExternalLink, Footprints } from 'lucide-react'
import CardErrorBoundary from './CardErrorBoundary'

const Blueprint3D = lazy(() => import('./Blueprint3D'))
import { setBrand, deriveBrand } from './brandKit'
import { planRoomFromItems } from './furnishPlan'
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

export type PaletteArt = {
  kind: 'palette'
  name?: string
  description?: string
  colors: PaletteColor[]
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
  | { type: 'door'; x: number; y: number; w: number; swing?: string }
  | { type: 'window'; x: number; y: number; w: number }
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

function CardShell({
  icon,
  tint,
  title,
  subtitle,
  actions,
  children,
}: {
  icon: React.ReactNode
  tint: string
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-white/[0.16] bg-white/[0.04]">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-white/[0.12] px-4 py-2.5">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${tint}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[#ededed]">{title}</div>
          {subtitle && <div className="truncate text-xs text-[#8e8e8e]">{subtitle}</div>}
        </div>
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
      : 'bg-white/[0.07] text-[#ededed] hover:bg-white/[0.12]'
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
  const [done, setDone] = useState(false)
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
    <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-white/[0.02]">
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
        {c.name && <div className="truncate text-xs font-medium text-[#ededed]">{c.name}</div>}
        <div className="flex flex-wrap gap-1.5">
          <CopyChip label="RGB" value={rgbStr(c.hex)} active={copied === 'rgb'} onClick={() => copy('rgb', rgbStr(c.hex))} />
          <CopyChip label="HSL" value={hslStr(c.hex)} active={copied === 'hsl'} onClick={() => copy('hsl', hslStr(c.hex))} />
        </div>
        {c.usage && <div className="text-[11px] leading-snug text-[#8e8e8e]">{c.usage}</div>}
      </div>
    </div>
  )
}

function CopyChip({ label, value, active, onClick }: { label: string; value: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`Copy ${value}`}
      className="flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-[#bcbcbc] hover:bg-white/[0.12] hover:text-[#ededed]"
    >
      {active ? <Check size={9} /> : null}
      {label}
    </button>
  )
}

export function PaletteStrip({ colors }: { colors: PaletteColor[] }) {
  return (
    <div className="flex h-12 w-full overflow-hidden rounded-lg border border-white/[0.1]">
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
    downloadText(JSON.stringify({ name, description: art.description, colors }, null, 2), `${base}.json`, 'application/json')
  const exportPng = async () => {
    const blob = await paintPalettePng(name, colors)
    if (blob) downloadBlob(blob, `${base}.png`)
  }

  if (!colors.length) {
    return (
      <CardShell icon={<Palette size={15} />} tint="bg-rose-500/15 text-rose-300" title={name} subtitle="No colors returned">
        <div className="p-4 text-sm text-[#8e8e8e]">This palette came back empty. Try rephrasing your request.</div>
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
      <div className="bg-[#0c0e14] p-4">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {colors.map((c, i) => (
            <Swatch key={i} c={c} i={i} />
          ))}
        </div>
      </div>
    </CardShell>
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

  // ---- PDF export (jsPDF vector — crisp/selectable, no raster) -------------
  const exportPdf = async () => {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
    const W = pdf.internal.pageSize.getWidth()
    const M = 48
    let y = M

    pdf.setFillColor(11, 14, 22)
    pdf.rect(0, 0, W, pdf.internal.pageSize.getHeight(), 'F')

    pdf.setTextColor(255)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(30)
    pdf.text(name, M, (y += 14))
    if (brand.tagline) {
      pdf.setTextColor(159, 179, 255)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(13)
      pdf.text(pdf.splitTextToSize(brand.tagline, W - M * 2), M, (y += 24))
    }
    if (brand.mission) {
      pdf.setTextColor(200)
      pdf.setFontSize(11)
      const lines = pdf.splitTextToSize(brand.mission, W - M * 2)
      pdf.text(lines, M, (y += 26))
      y += lines.length * 14
    }
    if (brand.voice && brand.voice.length) {
      pdf.setTextColor(150, 160, 180)
      pdf.setFontSize(10)
      pdf.text('Voice: ' + brand.voice.join('  ·  '), M, (y += 22))
    }

    // Palette
    if (palette.length) {
      y += 28
      pdf.setTextColor(255)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(15)
      pdf.text('Color Palette', M, y)
      y += 14
      const sw = (W - M * 2) / palette.length
      palette.forEach((c, i) => {
        const { r, g, b } = hexToRgb(c.hex)
        pdf.setFillColor(r, g, b)
        pdf.rect(M + i * sw, y, sw - 4, 48, 'F')
        const ft = bestText(c.hex) === '#ffffff' ? 255 : 0
        pdf.setTextColor(ft)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(8)
        pdf.text(('#' + normHex(c.hex)).toUpperCase(), M + i * sw + 5, y + 42)
      })
      y += 48
      palette.forEach((c, i) => {
        pdf.setTextColor(170)
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(7)
        pdf.text(pdf.splitTextToSize(c.role || c.name || '', sw - 6), M + i * sw, y + 10)
      })
      y += 18
    }

    // Typography
    y += 24
    pdf.setTextColor(255)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(15)
    pdf.text('Typography', M, y)
    y += 18
    pdf.setFontSize(11)
    pdf.text(`Heading — ${heading.family || 'Inter'} (${(heading.weights || []).join(', ') || '700'})`, M, y)
    y += 16
    pdf.setFont('helvetica', 'normal')
    pdf.text(`Body — ${body.family || 'Inter'} (${(body.weights || []).join(', ') || '400'})`, M, y)
    if (typo.scale && typo.scale.length) {
      y += 16
      pdf.setTextColor(150)
      pdf.setFontSize(9)
      pdf.text('Scale: ' + typo.scale.join(' · ') + ' px', M, y)
    }

    // Do / Don't
    const printList = (heading2: string, items: string[], color: [number, number, number]) => {
      y += 26
      pdf.setTextColor(color[0], color[1], color[2])
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(13)
      pdf.text(heading2, M, y)
      pdf.setTextColor(210)
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)
      for (const it of items) {
        y += 16
        const lines = pdf.splitTextToSize('•  ' + it, W - M * 2)
        pdf.text(lines, M, y)
        y += (lines.length - 1) * 13
      }
    }
    if (dos.length) printList("Do", dos, [110, 231, 183])
    if (donts.length) printList("Don't", donts, [252, 165, 165])

    pdf.save(`${base}.pdf`)
  }

  // ---- DOCX export (editable handoff) -------------------------------------
  const exportDocx = async () => {
    const {
      Document,
      Packer,
      Paragraph,
      HeadingLevel,
      TextRun,
      Table,
      TableRow,
      TableCell,
      WidthType,
    } = await import('docx')
    const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: name })] }))
    if (brand.tagline) children.push(new Paragraph({ children: [new TextRun({ text: brand.tagline, italics: true })] }))
    if (brand.mission) children.push(new Paragraph({ children: [new TextRun(brand.mission)] }))
    if (brand.voice && brand.voice.length)
      children.push(new Paragraph({ children: [new TextRun({ text: 'Voice: ' + brand.voice.join(', '), bold: true })] }))

    if (palette.length) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Color Palette')], spacing: { before: 240 } }))
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: ['Role', 'Name', 'Hex'].map(
                (h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] }),
              ),
            }),
            ...palette.map(
              (c) =>
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph(c.role || '')] }),
                    new TableCell({ children: [new Paragraph(c.name || '')] }),
                    new TableCell({
                      shading: { fill: normHex(c.hex), color: 'auto', type: 'clear' },
                      children: [new Paragraph({ children: [new TextRun({ text: '#' + normHex(c.hex), color: bestText(c.hex).replace('#', '') })] })],
                    }),
                  ],
                }),
            ),
          ],
        }),
      )
    }

    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Typography')], spacing: { before: 240 } }))
    children.push(new Paragraph({ children: [new TextRun({ text: `Heading: ${heading.family || 'Inter'} (${(heading.weights || []).join(', ') || '700'})`, bold: true })] }))
    children.push(new Paragraph({ children: [new TextRun(`Body: ${body.family || 'Inter'} (${(body.weights || []).join(', ') || '400'})`)] }))

    if (dos.length) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Do')], spacing: { before: 240 } }))
      for (const d of dos) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(d)] }))
    }
    if (donts.length) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Don't")], spacing: { before: 240 } }))
      for (const d of donts) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(d)] }))
    }

    const doc = new Document({ sections: [{ children }] })
    const blob = await Packer.toBlob(doc)
    downloadBlob(blob, `${base}.docx`)
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
      <div className="space-y-6 bg-[#0c0e14] p-5">
        {/* Hero */}
        <div className="rounded-xl border border-white/[0.08] bg-gradient-to-br from-[#15121f] to-[#0b0e16] p-5">
          <div className="text-2xl font-bold text-[#ededed]" style={{ fontFamily: headFamily }}>{name}</div>
          {brand.tagline && <div className="mt-1 text-sm text-violet-300" style={{ fontFamily: bodyFamily }}>{brand.tagline}</div>}
          {brand.mission && <p className="mt-3 max-w-prose text-sm leading-relaxed text-[#c5c8d0]" style={{ fontFamily: bodyFamily }}>{brand.mission}</p>}
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
                <div key={i} className="flex items-center gap-2 text-xs text-[#bcbcbc]">
                  <span className="h-3 w-3 shrink-0 rounded-sm border border-white/20" style={{ backgroundColor: '#' + normHex(c.hex) }} />
                  <span className="truncate">{c.role || c.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-[#8e8e8e]">{('#' + normHex(c.hex)).toUpperCase()}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Typography */}
        <section>
          <SectionLabel>Typography</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
              <div className="text-[10px] uppercase tracking-wide text-[#8e8e8e]">Heading · {heading.family || 'Inter'}</div>
              <div className="mt-1 text-2xl font-bold text-[#ededed]" style={{ fontFamily: headFamily }}>Aa Bb Cc</div>
              <div className="text-lg font-semibold text-[#dfe4ee]" style={{ fontFamily: headFamily }}>The quick brown fox</div>
              {heading.usage && <div className="mt-1 text-[11px] text-[#8e8e8e]">{heading.usage}</div>}
            </div>
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
              <div className="text-[10px] uppercase tracking-wide text-[#8e8e8e]">Body · {body.family || 'Inter'}</div>
              <div className="mt-1 text-2xl text-[#ededed]" style={{ fontFamily: bodyFamily }}>Aa Bb Cc</div>
              <div className="text-sm text-[#c5c8d0]" style={{ fontFamily: bodyFamily }}>The quick brown fox jumps over the lazy dog.</div>
              {body.usage && <div className="mt-1 text-[11px] text-[#8e8e8e]">{body.usage}</div>}
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
              {art.logo.direction && <p className="text-sm leading-relaxed text-[#c5c8d0]">{art.logo.direction}</p>}
              <div className="space-y-1 text-xs text-[#bcbcbc]">
                {art.logo.clearspace && <div>Clearspace: <span className="text-[#ededed]">{art.logo.clearspace}</span></div>}
                {art.logo.minSize && <div>Min size: <span className="text-[#ededed]">{art.logo.minSize}</span></div>}
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
                    <li key={i} className="flex gap-2 text-sm text-[#dfe4ee]"><Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />{d}</li>
                  ))}
                </ul>
              </div>
            )}
            {donts.length > 0 && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.06] p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-300">Don't</div>
                <ul className="space-y-1.5">
                  {donts.map((d, i) => (
                    <li key={i} className="flex gap-2 text-sm text-[#dfe4ee]"><span className="mt-0.5 shrink-0 font-bold text-rose-400">×</span>{d}</li>
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
                  <span className="font-mono text-[10px] text-[#8e8e8e]">{s}</span>
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
  return <div className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-[#8e8e8e]">{children}</div>
}

// ===== LogoCard ===============================================================

const cleanSvg = (s?: string): string =>
  (s || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '')

function svgToPng(svg: string, size: number, bg: string | null, cb: (url: string) => void) {
  // The model's SVGs carry ONLY a viewBox (no xmlns, no width/height). As-is they
  // either fail to load in an <img> (no xmlns) or rasterize to a blank/0-size
  // canvas (no intrinsic dimensions). So we derive the aspect ratio from the
  // viewBox and rewrite the root <svg> with xmlns + explicit pixel dimensions.
  const vb = (svg.match(/viewBox\s*=\s*["']([-\d.\s,]+)["']/) || [])[1]
  const p = vb ? vb.trim().split(/[\s,]+/).map(Number) : []
  const vbw = p.length === 4 && p[2] > 0 ? p[2] : 100
  const vbh = p.length === 4 && p[3] > 0 ? p[3] : 100
  const ratio = vbw / vbh
  const cw = ratio >= 1 ? size : Math.max(1, Math.round(size * ratio))
  const ch = ratio >= 1 ? Math.max(1, Math.round(size / ratio)) : size
  let doc = svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs.replace(/\swidth\s*=\s*["'][^"']*["']/i, '').replace(/\sheight\s*=\s*["'][^"']*["']/i, '')
    if (!/xmlns\s*=/.test(a)) a = ` xmlns="http://www.w3.org/2000/svg"${a}`
    return `<svg${a} width="${cw}" height="${ch}">`
  })
  if (!/^\s*<svg/i.test(doc)) doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbw} ${vbh}" width="${cw}" height="${ch}">${doc}</svg>`
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

// AI logo IMAGES (FLUX via keyless Pollinations) — richer designed marks à la
// Nutlope/logocreator + Arindam200/logo-ai: style presets + brand color + name.
const LOGO_STYLES: { key: string; label: string; desc: string }[] = [
  { key: 'minimal', label: 'Minimal', desc: 'minimalist, simple, timeless, refined, elegant negative space' },
  { key: 'modern', label: 'Modern', desc: 'modern, flat geometric design, clean lines, forward-thinking' },
  { key: 'tech', label: 'Tech', desc: 'sleek, futuristic, technological, sharp, precise, high-tech' },
  { key: 'corporate', label: 'Corporate', desc: 'professional, trustworthy, balanced, corporate, refined' },
  { key: 'luxury', label: 'Luxury', desc: 'elegant, luxurious, premium, sophisticated, refined gold detailing' },
  { key: 'playful', label: 'Playful', desc: 'playful, friendly, rounded shapes, bright bold colors, fun' },
  { key: 'abstract', label: 'Abstract', desc: 'abstract, artistic, creative, unique geometric symbol' },
  { key: 'flashy', label: 'Flashy', desc: 'bold, vibrant, eye-catching, dynamic, striking, energetic' },
]
function logoImgUrl(name: string, styleDesc: string, primaryHex: string, seed: number): string {
  const prompt = `A single iconic logo, high-quality award-winning professional brand design, simple memorable mark, only a few clean vector shapes, ${styleDesc}. Primary brand color #${primaryHex}, on a plain solid white background. The brand name is "${name}" — include the brand name in clean modern typography. Centered, crisp, vector, no mockup, no extra text, no watermark.`
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&model=flux&seed=${seed}`
}
function LogoImages({ name, brand }: { name: string; brand: string }) {
  const [style, setStyle] = useState('minimal')
  const [round, setRound] = useState(0)
  const desc = LOGO_STYLES.find((s) => s.key === style)?.desc || ''
  const primary = brand.replace(/^#/, '')
  const seeds = [0, 1, 2].map((n) => 1 + n + round * 3 + style.length * 13)
  const download = async (url: string, i: number) => {
    try {
      const r = await fetch(url)
      const b = await r.blob()
      const u = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = u
      a.download = `${slug(name, 'nalu-logo')}-${style}-${i + 1}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(u), 4000)
    } catch {
      window.open(url, '_blank', 'noopener')
    }
  }
  return (
    <div className="border-t border-white/[0.08] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8e8e8e]">AI logo images</span>
        {LOGO_STYLES.map((s) => (
          <button
            key={s.key}
            onClick={() => setStyle(s.key)}
            className={`rounded px-1.5 py-0.5 text-[10px] ${style === s.key ? 'bg-amber-500/25 text-amber-100' : 'bg-white/10 text-[#bdbdbd] hover:bg-white/20'}`}
          >
            {s.label}
          </button>
        ))}
        <button onClick={() => setRound((r) => r + 1)} className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-[#9a9a9a] hover:bg-white/10 hover:text-white">
          Regenerate
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {seeds.map((sd, i) => {
          const url = logoImgUrl(name, desc, primary, sd)
          return (
            <div key={`${round}-${i}`} className="group relative overflow-hidden rounded-xl border border-white/10 bg-white">
              <img src={url} alt={`${name} logo`} loading="lazy" className="aspect-square w-full object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0.15' }} />
              <button
                onClick={() => void download(url, i)}
                className="absolute bottom-1.5 right-1.5 rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
              >
                Download
              </button>
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 text-[10px] text-[#6f6f6f]">Generated with FLUX (free) · pick a style or regenerate for new options · uses your brand color.</div>
    </div>
  )
}

export function LogoCard({ art }: { art: LogoArt }) {
  // Prefer code-generated options (reliably clean). Legacy artifacts that carry
  // freehand LLM SVG options still render via the same path.
  const options: LogoOption[] =
    art.options && art.options.length
      ? art.options
      : art.initials || art.name
        ? genLogoOptions(art.name || 'Brand', art.initials || initialsFrom(art.name || 'Brand'), !!art.serif)
        : [{ concept: art.concept, mark: art.mark, lockup: art.lockup }]
  const [sel, setSel] = useState(0)
  const opt = options[Math.min(sel, options.length - 1)]
  const lockup = cleanSvg(opt.lockup || opt.mark)
  const mark = cleanSvg(opt.mark || opt.lockup)
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
      <div
        className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )

  return (
    <CardShell
      icon={<Sparkles size={15} />}
      tint="bg-amber-500/15 text-amber-300"
      title={name}
      subtitle={opt.concept || 'Logo — designed in black & white first'}
      actions={
        <>
          <ActionBtn onClick={() => downloadText(lockup, `${base}.svg`, 'image/svg+xml')}>
            <FileCode2 size={13} /> SVG
          </ActionBtn>
          <ActionBtn onClick={() => exportPng(mark, 'mark-black', '#000000', '#FFFFFF')}>
            <ImageIcon size={13} /> Mark PNG
          </ActionBtn>
          <ActionBtn onClick={() => exportPng(lockup, 'logo', brand, '#FFFFFF')} primary tint="bg-amber-500/20 text-amber-200 hover:bg-amber-500/30">
            <ImageIcon size={13} /> PNG
          </ActionBtn>
        </>
      }
    >
      {/* Concept options — a real designer presents a few directions. */}
      {options.length > 1 && (
        <div className="flex gap-2 border-b border-white/[0.08] px-4 py-3">
          {options.map((o, i) => (
            <button
              key={i}
              onClick={() => setSel(i)}
              className={`flex h-16 flex-1 items-center justify-center rounded-lg border bg-white text-black transition ${
                i === sel ? 'border-amber-400 ring-1 ring-amber-400/40' : 'border-black/10 hover:border-black/30'
              }`}
              title={`Concept ${i + 1}`}
            >
              <div className="[&>svg]:h-10 [&>svg]:w-10" dangerouslySetInnerHTML={{ __html: cleanSvg(o.mark || o.lockup) }} />
            </button>
          ))}
        </div>
      )}

      {/* PRIMARY: black & white — the real test a designer runs first. */}
      <div className="px-4 pt-4">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8e8e8e]">Black &amp; white (primary)</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SvgBox svg={lockup} color="#0B0B0B" bg="#FFFFFF" border="border-black/10" h="h-36" />
          <SvgBox svg={lockup} color="#FFFFFF" bg="#0B0B0B" border="border-white/10" h="h-36" />
        </div>
      </div>

      {/* COLOR treatment. */}
      <div className="px-4 pt-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8e8e8e]">In color</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SvgBox svg={lockup} color={brand} bg="#F4F1EA" border="border-black/10" h="h-36" />
          <SvgBox svg={lockup} color="#FFFFFF" bg={brand} border="border-white/10" h="h-36" />
        </div>
      </div>

      {/* The MARK alone, on light + dark + tiny (favicon test). */}
      <div className="px-4 py-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8e8e8e]">The mark · scales to a favicon</div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          <SvgBox svg={mark} color="#0B0B0B" bg="#FFFFFF" border="border-black/10" h="h-24" />
          <SvgBox svg={mark} color="#FFFFFF" bg="#0B0B0B" border="border-white/10" h="h-24" />
          <SvgBox svg={mark} color={brand} bg="#F4F1EA" border="border-black/10" h="h-24" />
          <div className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-black/10 bg-white">
            <div className="text-black [&>svg]:h-8 [&>svg]:w-8" dangerouslySetInnerHTML={{ __html: mark }} />
            <div className="text-black [&>svg]:h-4 [&>svg]:w-4" dangerouslySetInnerHTML={{ __html: mark }} />
          </div>
        </div>
      </div>

      <LogoImages name={name} brand={brand} />

      {colors.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.08] px-4 py-3">
          <span className="text-[11px] uppercase tracking-wide text-[#8e8e8e]">Palette</span>
          {colors.map((c, i) => {
            const hex = c.startsWith('#') ? c : '#' + c
            return (
              <button
                key={i}
                onClick={() => void navigator.clipboard?.writeText(hex.toUpperCase())}
                title={`Copy ${hex}`}
                className="flex items-center gap-1.5 rounded-md bg-white/[0.05] px-2 py-1 text-[11px] text-[#ededed]"
              >
                <span className="h-3.5 w-3.5 rounded-sm border border-white/20" style={{ backgroundColor: hex }} />
                {hex.toUpperCase()}
              </button>
            )
          })}
          {art.font && <span className="ml-1 text-[11px] italic text-[#9a9a9a]">{art.font}</span>}
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
  const floors: BPFloor[] = art.floors && art.floors.length
    ? art.floors
    : [{ name: 'Plan', viewBox: art.viewBox || { w: 40, h: 28 }, shapes: art.shapes, dimensions: art.dimensions, annotations: art.annotations }]
  const [floorIdx, setFloorIdx] = useState(0)
  const floor = floors[Math.min(floorIdx, floors.length - 1)]
  const vb = floor.viewBox || { w: 40, h: 28 }
  // Site vs building floors: the 3D stacks all building floors into one model;
  // a site plan renders as its own lot. (A floor is a "site" if named so or it
  // carries trees / a pool.)
  const isSiteFloor = (f: BPFloor) =>
    /site|plot|\blot\b|landscap|grounds/.test((f.name || '').toLowerCase()) ||
    (f.shapes || []).some((s) => s.type === 'tree' || (s.type === 'ellipse' && /pool/.test((s as { label?: string }).label?.toLowerCase() || '')))
  const buildingFloors = floors.filter((f) => !isSiteFloor(f))
  const curIsSite = isSiteFloor(floor)
  const threeFloors: BPFloor[] = curIsSite ? [floor] : buildingFloors.length ? buildingFloors : floors
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
        return (
          <g key={i}>
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
        return (
          <g key={i}>
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
        <div className="flex flex-wrap gap-1 border-b border-white/[0.08] bg-[#0b0e16] px-3 py-2">
          {floors.map((f, i) => (
            <button
              key={i}
              onClick={() => setFloorIdx(i)}
              className={`rounded-md px-2.5 py-1 text-[11px] ${
                i === floorIdx ? 'bg-sky-500/20 text-sky-200' : 'bg-white/[0.05] text-[#9a9a9a] hover:bg-white/10'
              }`}
            >
              {f.name || `Level ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {view3d ? (
        <CardErrorBoundary label="The 3D view">
          <Suspense fallback={<div className="flex h-[30rem] items-center justify-center bg-[#0c0e14] text-sm text-[#8e8e8e]">Building 3D model…</div>}>
            <Blueprint3D key={walkMode ? 'walk' : 'orbit'} floors={threeFloors} mode={curIsSite ? 'site' : 'building'} units={art.units} storeKey={base} startWalk={walkMode} />
          </Suspense>
        </CardErrorBoundary>
      ) : (
      <div className="bg-[#0b0e16] p-4">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
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
  const [show3d, setShow3d] = useState(false)
  const roomPlan = useMemo(() => planRoomFromItems(items), [items])
  const [video, setVideo] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; url?: string; msg?: string }>({ state: 'idle' })
  const makeVideo = async () => {
    setVideo({ state: 'loading' })
    try {
      const r = await fetch('/api/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: roomVideoPrompt(art) }),
      })
      const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string }
      if (r.ok && data.url) setVideo({ state: 'done', url: data.url })
      else setVideo({ state: 'error', msg: data.error || `Video error ${r.status}` })
    } catch (e) {
      setVideo({ state: 'error', msg: e instanceof Error ? e.message : 'Video request failed' })
    }
  }

  return (
    <CardShell
      icon={<ShoppingBag size={15} />}
      tint="bg-[#AF8C56]/20 text-[#d8b878]"
      title={title}
      subtitle={`${items.length} item${items.length === 1 ? '' : 's'}${art.budget ? ` · ${art.budget}` : ''}`}
      actions={<ActionBtn onClick={copyList}><Copy size={13} /> Copy list</ActionBtn>}
    >
      {/* See the items in a room: a real 3D room with the pieces auto-placed
          (walk it / record it), plus an AI-rendered scene + walkthrough video. */}
      <div className="border-b border-white/[0.08] bg-[#0b0e16] p-4 sm:p-5">
        <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
          {show3d ? (
            <CardErrorBoundary label="The 3D room">
              <Suspense fallback={<div className="flex aspect-video items-center justify-center text-sm text-[#8e8e8e]">Building your room…</div>}>
                <Blueprint3D floors={[roomPlan.floor as never]} mode="building" storeKey={`room-${slug(title, 'nalu-room')}`} initialFurniture={roomPlan.furniture as never} />
              </Suspense>
            </CardErrorBoundary>
          ) : video.state === 'done' && video.url ? (
            <video src={video.url} controls autoPlay loop className="aspect-video w-full bg-black" />
          ) : (
            <img
              src={roomImg(art)}
              alt={`${title} — styled room`}
              loading="lazy"
              className="aspect-video w-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          )}
          {!show3d && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/90">The room, furnished</div>
            </div>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShow3d((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${show3d ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100' : 'border-[#AF8C56]/30 bg-[#AF8C56]/10 text-[#e2c896] hover:bg-[#AF8C56]/20'}`}
          >
            <Box size={13} /> {show3d ? 'Back to preview' : `Walk the room in 3D (${roomPlan.placed} pieces)`}
          </button>
          {!show3d && (
            <button
              onClick={() => void makeVideo()}
              disabled={video.state === 'loading'}
              className="flex items-center gap-1.5 rounded-lg border border-[#AF8C56]/30 bg-[#AF8C56]/10 px-3 py-1.5 text-xs font-medium text-[#e2c896] hover:bg-[#AF8C56]/20 disabled:opacity-60"
            >
              <Footprints size={13} /> {video.state === 'loading' ? 'Filming the room… (~60s)' : video.state === 'done' ? 'Re-film walkthrough' : 'Walkthrough video'}
            </button>
          )}
          {video.state === 'error' && <span className="text-[11px] text-red-300">{video.msg}</span>}
          <span className="ml-auto text-[10px] text-[#6f6f6f]">{show3d ? 'Furnish · Walk through · Record tour' : 'AI-rendered preview'}</span>
        </div>
      </div>
      <div className="bg-[#0b0e16] px-4 pb-4 pt-3 sm:px-5">
        {art.summary && <p className="mb-4 max-w-2xl text-[13px] italic leading-relaxed text-[#c8c2b6]">{art.summary}</p>}
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="mb-2 flex items-center gap-2.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#d8b878]">{g.name}</span>
                <span className="h-px flex-1 bg-gradient-to-r from-[#AF8C56]/30 to-transparent" />
              </div>
              <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
                {g.items.map((it, i) => {
                  const href = storeLink(it.retailer, it.query || it.name)
                  return (
                    <div key={i} className="group flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-white/[0.03] sm:px-4">
                      <a href={href} target="_blank" rel="noopener noreferrer" className="shrink-0">
                        <img
                          src={productImg(it)}
                          alt={it.name}
                          loading="lazy"
                          className="h-12 w-12 rounded-lg border border-white/10 bg-white/[0.04] object-cover sm:h-14 sm:w-14"
                          onError={(e) => { const t = e.currentTarget as HTMLImageElement; t.style.visibility = 'hidden' }}
                        />
                      </a>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[13.5px] font-medium text-[#f0ede6]">{it.name}</span>
                          {it.retailer && <span className="text-[11px] text-[#8e8e8e]">{it.retailer}</span>}
                        </div>
                        {it.reason && <div className="mt-0.5 truncate text-[12px] leading-snug text-[#928d83]">{it.reason}</div>}
                      </div>
                      {it.price && <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[#e7d6b6]">{it.price}</span>}
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-[#AF8C56]/30 bg-[#AF8C56]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#e2c896] transition-colors hover:bg-[#AF8C56]/20"
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
          <div className="mt-5 flex items-center justify-between border-t border-white/[0.1] pt-3.5">
            <span className="text-[11px] uppercase tracking-[0.14em] text-[#8e8e8e]">Estimated total</span>
            <span className="text-base font-semibold text-[#f0ede6]">{art.budget}</span>
          </div>
        )}
        <div className="mt-2.5 text-[10px] leading-relaxed text-[#6f6f6f]">Each link opens a live search at the retailer (or Google Shopping). Prices are designer estimates, not live quotes.</div>
      </div>
    </CardShell>
  )
}