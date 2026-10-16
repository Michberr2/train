import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getBrand, useBrand, toRgb, isCustomBrand } from './brandKit'
import { requestStudioImage, studioImageSession } from './studioImages'
import { type ChartSpec } from './chartRender'
import { rasterizeLogo } from './logoRaster'
import { makeDeckScenes, resolveSlideLayout, type SceneAssets, type SlideScene } from './slideScene'
import { exportPptxScenes, exportPdfScenes } from './slideSceneExport'
import { ensureSlideFonts, readableFontFallbacks } from './slideFonts'
import { SlideSceneView } from './SlideSceneView'

export type Layout = 'bullets' | 'stat' | 'kpis' | 'columns' | 'chart' | 'quote' | 'table'
export type Slide = {
  title?: string; bullets?: string[]; notes?: string; image?: string; chart?: ChartSpec
  layout?: Layout
  stat?: { value: string; label: string; sub?: string }
  kpis?: { value: string; label: string; delta?: string }[]
  columns?: { heading: string; items: string[]; accent?: boolean }[]
  quote?: { text: string; attribution?: string }
  table?: { headers: string[]; rows: string[][]; highlightCol?: number }
}
// Preserve the user's wording and symbols. Font coverage is checked at export;
// unsupported glyphs must never be silently rewritten or deleted.
function deckText(v: unknown): string {
  return (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim()
}
// Deep-clean every text field of a deck so ALL render paths (preview, PPTX, PDF)
// draw legible, on-brand text.
export function sanitizeDeck(d: Deck): Deck {
  const t = deckText
  const list = <T,>(value: T[] | undefined): T[] => Array.isArray(value) ? value.filter((item) => item != null) : []
  const cs = (sl: Slide): Slide => ({
    ...sl,
    title: t(sl.title),
    bullets: Array.isArray(sl.bullets) ? sl.bullets.map(t) : sl.bullets ? [t(sl.bullets)] : [],
    stat: sl.stat ? { value: t(sl.stat.value), label: t(sl.stat.label), sub: sl.stat.sub ? t(sl.stat.sub) : undefined } : undefined,
    kpis: list(sl.kpis).map((k) => ({ value: t(k.value), label: t(k.label), delta: k.delta ? t(k.delta) : undefined })),
    columns: list(sl.columns).map((c) => ({ ...c, heading: t(c.heading), items: Array.isArray(c.items) ? c.items.map(t) : c.items ? [t(c.items)] : [] })),
    quote: sl.quote ? { text: t(sl.quote.text), attribution: sl.quote.attribution ? t(sl.quote.attribution) : undefined } : undefined,
    table: sl.table ? { ...sl.table, headers: list(sl.table.headers).map(t), rows: list(sl.table.rows).map((r) => Array.isArray(r) ? r.map(t) : [t(r)]) } : undefined,
    chart: sl.chart ? { ...sl.chart, title: t(sl.chart.title), takeaway: t(sl.chart.takeaway), labels: Array.isArray(sl.chart.labels) ? sl.chart.labels.map(t) : [], series: list(sl.chart.series).map((series) => ({ ...series, name: t(series.name), values: Array.isArray(series.values) ? Array.from(series.values) : [] })) } : undefined,
  })
  return { ...d, title: t(d?.title), subtitle: t(d?.subtitle), slides: list(d?.slides).filter((sl) => typeof sl === 'object').map(cs) }
}
// A resolved design language from the Nalu design engine (api/_design.ts). Every
// studio generator now emits one on its payload so each deck/doc/email renders in
// its OWN palette + type + shape, not one hardcoded look. All fields optional so
// older payloads (no design) fall back to the modern default below.
export type DesignSpec = {
  id?: string
  name?: string
  light?: { bg?: string; surface?: string; ink?: string; muted?: string; accent?: string; accent2?: string }
  dark?: { bg?: string; surface?: string; ink?: string; muted?: string; accent?: string; accent2?: string }
  fonts?: { display?: string; body?: string; mono?: string; displaySerif?: boolean; bodySerif?: boolean }
  radius?: number
  motif?: string
}
export type Deck = { title?: string; subtitle?: string; cover?: string; slides?: Slide[]; design?: DesignSpec }

const PAPER = 'F3F2EE' // soft warm light-gray content slides (calm editorial baseline)

function cleanName(t?: string): string {
  return (t || 'pitch-deck').replace(/[\\/:*?"<>|]+/g, '').trim() || 'pitch-deck'
}

const hx = (v?: string, fb = '') => (typeof v === 'string' ? v.replace(/^#/, '') : '') || fb
// Lighten a bare-hex color toward white by t (0..1) → a faint on-brand surface tint.
const tintHex = (v: string, t: number) => {
  const [r, g, b] = toRgb(v)
  const m = (c: number) => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')
  return (m(r) + m(g) + m(b)).toUpperCase()
}
// Resolve the render palette + type. Priority: the deck's DESIGN LANGUAGE (from the
// engine) → the user's brand kit → the modern default. The whole renderer (PPTX, PDF,
// HTML) reads these fields, so one deck can be warm-editorial and the next brutalist.
function deckStyle(title?: string, design?: DesignSpec) {
  const b = getBrand()
  const d = design || {}
  const L = d.light || {}
  const K = d.dark || {}
  const f = d.fonts || {}
  // A Brand Kit the user explicitly chose (anything but the default "Nalu" house
  // brand) takes PRIORITY over the auto-picked design language — so YOUR brand
  // actually shows up on the deck. With no custom brand, the design engine drives it.
  // BLEND: the design LANGUAGE drives the composition + mood (cover background, paper,
  // text colors) so decks VARY by topic; a CUSTOM brand (detected by value, not name)
  // contributes only its ACCENT pop + fonts + logo. This keeps every deck on-brand
  // WITHOUT flattening them all to one brand-colored look. Text/background pairs always
  // come from the same language, so contrast stays safe.
  const custom = isCustomBrand(b)
  const accent = (designVal?: string, fb = 'C25E3A') => (custom ? hx(b?.accent, hx(designVal, fb)) : hx(designVal, hx(b?.accent, fb)))
  // Contrast guard for the ONE cross-source pair (brand accent over a language background):
  // if the accent would clash (too dark on the dark cover / too light on the light paper),
  // fall back to the language's own accent, which is designed for that surface.
  const litFor = (val: string, onDarkBg: boolean, fallback: string) => {
    const [r, g, bl] = toRgb(val)
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255
    return (onDarkBg ? l < 0.3 : l > 0.82) ? fallback : val
  }
  const head = custom && b?.headingFont ? b.headingFont : f.display || b?.headingFont || 'Poppins'
  const body = custom && b?.bodyFont ? b.bodyFont : f.body || b?.bodyFont || 'Arial'
  // Eyebrow/footer label = the DECK's own subject (its title's brand part), NOT the
  // app brand — so a deck about "Pulse" reads "PULSE", never "NALU".
  const label = (title || '').toUpperCase().split(/[:–—|-]/)[0].trim().slice(0, 22)
  const shared = {
    head,
    body,
    radius: typeof d.radius === 'number' ? d.radius : 12,
    label,
    logo: b?.logo || b?.logoMark || '',
  }
  // STRICT COLOR GUIDE — the deck follows the ACTIVE Brand Kit EXACTLY (the brand bar
  // advertises it "applies to decks"): cover, headings, body, accents, surfaces AND chart
  // colors all come from the brand palette — nothing borrowed from an auto-picked design
  // language, so "follow just the color guide" is literally true. This applies to the
  // house Nalu brand too, not only a customized one — so a Nalu deck reads navy + gold,
  // never a random design-language color. The design engine still drives fonts, motif and
  // photo art-direction. Every cross-surface pair is contrast-guarded so a mis-set swatch
  // (a light "text", a light "dark") can never render illegible.
  if (b) {
    const lum = (v: string) => { const [r, g, bl] = toRgb(v); return (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255 }
    const dark = hx(b.dark, '141416') // cover background (from the guide)
    const coverDark = lum(dark) < 0.55 // is the cover background actually dark?
    // Content ink = brand text, but never illegible on the white content sheet.
    const ink = litFor(hx(b.text, '1A1A1A'), false, '1A1A1A')
    // Accent on white content, deepened if too pale — re-guarded so a pale PRIMARY can't slip through.
    const accentOnWhite = litFor(hx(b.accent), false, litFor(hx(b.primary), false, ink))
    // Accent, title and muted on the COVER follow whichever way the cover actually leans.
    const coverAccent = coverDark
      ? litFor(hx(b.accent), true, hx(b.subtle, hx(b.onDark, 'FFFFFF')))
      : accentOnWhite
    const onCover = coverDark ? hx(b.onDark, 'FFFFFF') : ink // title/text on the cover
    const coverMuted = coverDark ? hx(b.subtle, 'C9CBD2') : '6B6B6B' // subtitle/footer on the cover
    return {
      navy: ink, // headline on paper → brand text (guarded)
      dark, // cover background → brand dark
      coverAccent, // accent on the cover → brand accent (guarded for the cover's lightness)
      gold: accentOnWhite, // accent on content → brand accent (guarded)
      accent2: litFor(hx(b.primary), false, accentOnWhite), // secondary accent → brand primary
      ink, // content text/headlines → brand text (guarded)
      onDark: onCover, // text on the cover → readable on the actual cover color
      subtle: coverMuted, // muted on the cover → readable on the actual cover color
      muted: '626872', // readable small labels on the white paper
      paper: 'FFFFFF', // content paper → clean white (the guide sets ink, not the sheet)
      surface: tintHex(hx(b.primary, 'E9E9EC'), 0.92), // faint brand tint for cards / alt rows
      ...shared,
    }
  }
  return {
    navy: hx(L.ink, '141414'), // headline on paper → LANGUAGE
    dark: hx(K.bg, '141416'), // cover background → LANGUAGE (the variety)
    coverAccent: litFor(accent(hx(K.accent, L.accent)), true, hx(K.accent, hx(L.accent, 'C25E3A'))), // accent on the dark cover → BRAND pop (contrast-guarded)
    gold: litFor(accent(L.accent), false, hx(L.accent, 'C25E3A')), // ACCENT on content → BRAND pop (contrast-guarded)
    accent2: litFor(accent(hx(L.accent2, L.accent)), false, hx(L.accent2, hx(L.accent, 'C25E3A'))),
    ink: hx(L.ink, '1A1A1A'), // content text/headlines → LANGUAGE
    onDark: hx(K.ink, 'FFFFFF'), // text on the dark cover → LANGUAGE
    subtle: hx(K.muted, 'B9B9BE'), // muted light (on dark cover) → LANGUAGE
    muted: hx(L.muted, '8A8A8A'), // gray for labels/footers (on paper)
    paper: hx(L.bg, PAPER), // content paper → LANGUAGE
    surface: hx(L.surface, hx(L.bg, PAPER)),
    ...shared,
  }
}

type PreparedAssets = SceneAssets & { unavailable: number; missing: number; pending: number; total: number; errors: string[] }
const emptyAssets = (): PreparedAssets => ({ unavailable: 0, missing: 0, pending: 0, total: 0, errors: [], photos: {} })
const photoManifest = (data: Deck) => data.slides?.map(sl => [sl.image, resolveSlideLayout(sl)])
function imageRequests(data: Deck) {
  const requests: { key: string; prompt: string; size: string }[] = []
  if (data.cover?.trim()) requests.push({ key: 'cover', prompt: data.cover.trim(), size: '1600x900' })
  data.slides?.forEach((sl, i) => {
    if (sl.image?.trim() && ['bullets', 'stat', 'quote'].includes(resolveSlideLayout(sl))) requests.push({ key: String(i), prompt: sl.image.trim(), size: '900x940' })
  })
  return requests
}
function imagePause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Image generation cancelled.', 'AbortError'))
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Image generation cancelled.', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve() }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
/** Only explicit generation invokes a provider. Read-only mounts and exports
 * resolve already-saved account images, even after reload or on another device. */
async function prepareMedia(data: Deck, style: ReturnType<typeof deckStyle>, options: { generate?: boolean; signal?: AbortSignal; photos?: Record<string, string>; progress?: (assets: PreparedAssets, complete: number) => void } = {}): Promise<PreparedAssets> {
  const owner = studioImageSession()
  const requests = imageRequests(data)
  const assets = emptyAssets()
  assets.total = requests.length
  assets.missing = requests.length
  for (const request of requests) {
    const saved = options.photos?.[request.key]
    if (saved) { assets.photos![request.key] = saved; assets.missing-- }
  }
  const assertCurrent = () => {
    if (options.signal?.aborted) throw new DOMException('Image generation cancelled.', 'AbortError')
    if (studioImageSession() !== owner) throw new Error('Your account changed while the images were loading. Open the deck again.')
  }
  // Logo work is separate from generated photos; palette changes never generate
  // another photograph. Use the current cover's actual lightness.
  if (style.logo) {
    const [r, g, b] = toRgb(style.dark)
    const isDark = .2126 * r + .7152 * g + .0722 * b < 140
    const [cover, head] = await Promise.all([
      rasterizeLogo(style.logo, { height: 160, bgDark: isDark }).catch(() => null),
      rasterizeLogo(style.logo, { height: 160, bgDark: false }).catch(() => null),
    ])
    assertCurrent()
    if (cover) { assets.logoCover = cover.dataUrl; assets.logoRatio = cover.w / cover.h }
    if (head) { assets.logoHead = head.dataUrl; assets.logoRatio = head.w / head.h }
    if (!cover || !head) assets.unavailable++
  }
  let next = 0, complete = 0, stopQueue = false
  await Promise.all(Array.from({ length: Math.min(2, requests.length) }, async () => {
    while (next < requests.length && !stopQueue) {
      assertCurrent()
      const request = requests[next++]
      if (assets.photos![request.key]) { complete++; continue }
      try {
        const input = { prompt: request.prompt, size: request.size }
        let result = await requestStudioImage(input, options.generate ? 'generate' : 'lookup', options.signal)
        // A second view can follow an existing job without creating another one.
        const until = Date.now() + 150000
        while (options.generate && result.status === 'pending' && Date.now() < until) {
          await imagePause(3000, options.signal); assertCurrent()
          result = await requestStudioImage(input, 'lookup', options.signal)
        }
        assertCurrent()
        if (result.status === 'ready') { assets.photos![request.key] = result.image.url; assets.missing-- }
        else if (result.status === 'pending') { assets.pending++; assets.missing-- }
      } catch (error) {
        assertCurrent()
        assets.errors.push(error instanceof Error ? error.message : 'An image could not be prepared.')
        if ((error as { status?: number })?.status === 429) stopQueue = true
      }
      complete++
      options.progress?.({ ...assets, photos: { ...assets.photos }, errors: [...assets.errors] }, complete)
    }
  }))
  assertCurrent()
  return assets
}

function assertScenesFit(scenes: SlideScene[]) {
  const index = scenes.findIndex(scene => scene.issues.length)
  if (index !== -1) throw new Error(`Slide ${index + 1}: ${scenes[index].issues[0]}`)
}

/** Prepare exactly the same measured scene model used by the interactive card. */
export async function prepareDeckScenes(data: Deck): Promise<SlideScene[]> {
  data = sanitizeDeck(data)
  const style = deckStyle(data.title, data.design)
  await ensureSlideFonts([style.head, style.body])
  const assets = await prepareMedia(data, style)
  const scenes = makeDeckScenes(data, style, assets)
  assertScenesFit(scenes)
  return scenes
}

/** Shared with Autopilot output nodes. Native PowerPoint text and charts remain editable. */
export async function buildPptxBlob(data: Deck): Promise<{ blob: Blob; filename: string }> {
  const scenes = await prepareDeckScenes(data)
  return { blob: await exportPptxScenes(scenes, deckText(data.title) || 'Presentation'), filename: `${cleanName(deckText(data.title))}.pptx` }
}

const buttonClass = 'rounded-lg border border-glass/20 px-3 py-2 text-xs font-semibold text-ink hover:bg-glass/10 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
const fieldClass = 'w-full rounded-lg border border-glass/20 bg-glass/5 px-3 py-2 text-sm text-ink outline-none focus:border-glass/50'

function DeckFields({ deck, index, onChange }: { deck: Deck; index: number; onChange: (deck: Deck) => void }) {
  const sl = deck.slides?.[index - 1]
  const change = (patch: Partial<Slide>) => onChange({ ...deck, slides: deck.slides?.map((s, i) => i === index - 1 ? { ...s, ...patch } : s) })
  const field = (label: string, value: string | undefined, update: (value: string) => void, rows = 2) => (
    <label className="block space-y-1.5 text-xs font-semibold text-dim" key={label}>{label}
      <textarea aria-label={label} className={fieldClass} rows={rows} value={value || ''} onChange={e => update(e.target.value)} />
    </label>
  )
  if (!sl) return <div className="grid gap-4">{field('Deck title', deck.title, title => onChange({ ...deck, title }))}{field('Subtitle', deck.subtitle, subtitle => onChange({ ...deck, subtitle }))}</div>
  return <div className="grid gap-4">
    {field('Slide title', sl.title, title => change({ title }))}
    {!!sl.bullets?.length && field('Key points — one per line', sl.bullets.join('\n'), value => change({ bullets: value.split('\n') }), 5)}
    {sl.stat && <div className="grid gap-3 sm:grid-cols-2">{field('Metric value', sl.stat.value, value => change({ stat: { ...sl.stat!, value } }), 1)}{field('Metric label', sl.stat.label, label => change({ stat: { ...sl.stat!, label } }))}{field('Metric context', sl.stat.sub, sub => change({ stat: { ...sl.stat!, sub } }))}</div>}
    {sl.kpis?.map((kpi, j) => <fieldset key={j} className="grid gap-3 rounded-xl border border-glass/10 p-3 sm:grid-cols-3"><legend className="px-1 text-xs text-dim">Metric {j + 1}</legend>{(['value', 'label', 'delta'] as const).map(key => field(`${key[0].toUpperCase() + key.slice(1)} ${j + 1}`, kpi[key], value => change({ kpis: sl.kpis!.map((k, i) => i === j ? { ...k, [key]: value } : k) })))}</fieldset>)}
    {sl.columns?.map((col, j) => <fieldset key={j} className="grid gap-3 rounded-xl border border-glass/10 p-3"><legend className="px-1 text-xs text-dim">Column {j + 1}</legend>{field(`Column ${j + 1} heading`, col.heading, heading => change({ columns: sl.columns!.map((c, i) => i === j ? { ...c, heading } : c) }))}{field(`Column ${j + 1} points`, col.items.join('\n'), value => change({ columns: sl.columns!.map((c, i) => i === j ? { ...c, items: value.split('\n') } : c) }), 4)}</fieldset>)}
    {sl.quote && <>{field('Quotation', sl.quote.text, text => change({ quote: { ...sl.quote!, text } }), 4)}{field('Attribution', sl.quote.attribution, attribution => change({ quote: { ...sl.quote!, attribution } }))}</>}
    {sl.table && <div className="overflow-x-auto"><table className="w-full"><thead><tr>{sl.table.headers.map((cell, ci) => <th key={ci} className="min-w-32 p-1">{field(`Heading ${ci + 1}`, cell, value => change({ table: { ...sl.table!, headers: sl.table!.headers.map((v, i) => i === ci ? value : v) } }))}</th>)}</tr></thead><tbody>{sl.table.rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className="min-w-32 p-1">{field(`Row ${ri + 1}, column ${ci + 1}`, cell, value => change({ table: { ...sl.table!, rows: sl.table!.rows.map((r, i) => i === ri ? r.map((v, j) => j === ci ? value : v) : r) } }))}</td>)}</tr>)}</tbody></table></div>}
    {sl.chart && <>{field('Chart title', sl.chart.title, title => change({ chart: { ...sl.chart!, title } }))}{field('Chart takeaway', sl.chart.takeaway, takeaway => change({ chart: { ...sl.chart!, takeaway } }))}<p className="text-xs text-dim">To change chart data or add slides, ask Nalu to revise this deck.</p></>}
    {field('Speaker notes', sl.notes, notes => change({ notes }), 5)}
  </div>
}

export default function SlidesCard({ data: rawData, onUpdate }: { data: Deck; onUpdate?: (deck: Deck) => void }) {
  const [data, setData] = useState(() => sanitizeDeck(rawData))
  const [selected, setSelected] = useState(0)
  const [allSlides, setAllSlides] = useState(false)
  const [notes, setNotes] = useState(false)
  const [editing, setEditing] = useState<Deck | null>(null)
  const [presenting, setPresenting] = useState(false)
  const [busy, setBusy] = useState<'pptx' | 'pdf' | null>(null)
  const [error, setError] = useState('')
  const [assets, setAssets] = useState<PreparedAssets>(emptyAssets)
  const [loading, setLoading] = useState(true)
  const [fontsReady, setFontsReady] = useState(false)
  const [fontError, setFontError] = useState('')
  const [fontAttempt, setFontAttempt] = useState(0)
  const [generatingImages, setGeneratingImages] = useState(false)
  const [imageProgress, setImageProgress] = useState(0)
  const [imageRefresh, setImageRefresh] = useState(0)
  const imageController = useRef<AbortController | null>(null)
  const mediaScope = useRef('')
  const assetsScope = useRef('')
  const deckScope = useRef('')
  const exportLock = useRef(false)
  const presentButton = useRef<HTMLButtonElement>(null)
  const presentation = useRef<HTMLDivElement>(null)
  const brand = useBrand()
  const style = useMemo(() => deckStyle(data.title, data.design), [data.title, data.design, brand])
  useEffect(() => { setData(sanitizeDeck(rawData)); setEditing(null) }, [rawData])
  useEffect(() => { setSelected(i => Math.min(i, data.slides?.length || 0)) }, [data.slides?.length])
  const owner = studioImageSession()
  const mediaKey = JSON.stringify([owner, data.cover, photoManifest(data), style.logo, style.dark])
  mediaScope.current = mediaKey
  const deckKey = JSON.stringify([owner, data, style])
  deckScope.current = deckKey
  const currentAssets = assetsScope.current === mediaKey ? assets : emptyAssets()
  useEffect(() => {
    let disposed = false
    setFontsReady(false)
    setFontError('')
    ensureSlideFonts([style.head, style.body]).then(() => { if (!disposed) setFontsReady(true) }).catch(e => { if (!disposed) setFontError(e.message) })
    return () => { disposed = true }
  }, [style.head, style.body, fontAttempt])
  useEffect(() => {
    const controller = new AbortController()
    const reviewedPhotos = assetsScope.current === mediaKey ? assets.photos : undefined
    setGeneratingImages(false)
    setLoading(true)
    assetsScope.current = mediaKey
    if (!reviewedPhotos) setAssets(emptyAssets())
    prepareMedia(data, style, { signal: controller.signal, photos: reviewedPhotos }).then(prepared => {
      if (!controller.signal.aborted && mediaScope.current === mediaKey) { setAssets(prepared); setLoading(false) }
    }).catch(e => { if (!controller.signal.aborted && mediaScope.current === mediaKey) { setError(e.message); setLoading(false) } })
    return () => { controller.abort(); imageController.current?.abort(); imageController.current = null }
  }, [mediaKey, imageRefresh])
  const generateImages = async () => {
    if (imageController.current || loading || assetsScope.current !== mediaKey) return
    const controller = new AbortController()
    imageController.current = controller
    const scope = mediaKey
    setGeneratingImages(true); setImageProgress(0); setError('')
    try {
      const prepared = await prepareMedia(data, style, { generate: true, signal: controller.signal, photos: currentAssets.photos, progress: (current, complete) => {
        if (!controller.signal.aborted && mediaScope.current === scope) { setAssets(current); setImageProgress(complete) }
      } })
      if (!controller.signal.aborted && mediaScope.current === scope) {
        setAssets(prepared)
        if (prepared.errors.length) setError(prepared.errors[0])
      }
    } catch (e) {
      if (!controller.signal.aborted && mediaScope.current === scope) setError(e instanceof Error ? e.message : 'The images could not be prepared.')
    } finally {
      if (imageController.current === controller) { imageController.current = null; setGeneratingImages(false) }
    }
  }
  const scenes = useMemo(() => makeDeckScenes(data, style, currentAssets), [data, style, currentAssets, fontsReady])
  const selectedScene = scenes[selected] || scenes[0]
  useEffect(() => {
    if (!presenting) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    presentation.current?.focus()
    return () => { document.body.style.overflow = previous; presentButton.current?.focus() }
  }, [presenting])
  const download = async (kind: 'pptx' | 'pdf') => {
    if (exportLock.current || generatingImages) return
    const exportOwner = owner, exportScope = deckKey
    exportLock.current = true; setBusy(kind); setError('')
    try {
      await ensureSlideFonts([style.head, style.body])
      const prepared = await prepareMedia(data, style, { photos: currentAssets.photos })
      if (studioImageSession() !== exportOwner || deckScope.current !== exportScope) throw new Error('The deck changed during export. Please try again.')
      setAssets(prepared)
      const ready = makeDeckScenes(data, style, prepared)
      assertScenesFit(ready)
      const blob = kind === 'pptx' ? await exportPptxScenes(ready, data.title || 'Presentation') : await exportPdfScenes(ready, data.title || 'Presentation')
      if (studioImageSession() !== exportOwner || deckScope.current !== exportScope) throw new Error('The deck changed during export. Please try again.')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `${cleanName(data.title)}.${kind}`
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000)
    } catch (e) { setError(`${kind === 'pdf' ? 'PDF' : 'PowerPoint'} export: ${e instanceof Error ? e.message : 'Please try again.'}`) }
    finally { exportLock.current = false; setBusy(null) }
  }
  const nav = (delta: number) => setSelected(i => Math.max(0, Math.min(scenes.length - 1, i + delta)))
  const navigation = <div className="flex flex-wrap items-center justify-between gap-2 py-3">
    <div className="flex items-center gap-2"><button className={buttonClass} onClick={() => nav(-1)} disabled={selected === 0} aria-label="Previous slide">←</button><span className="min-w-16 text-center text-xs tabular-nums text-dim">{selected + 1} / {scenes.length}</span><button className={buttonClass} onClick={() => nav(1)} disabled={selected === scenes.length - 1} aria-label="Next slide">→</button></div>
    {!presenting && <div className="flex gap-2"><button className={buttonClass} onClick={() => setNotes(v => !v)} aria-pressed={notes}>Notes</button><button className={buttonClass} onClick={() => setAllSlides(v => !v)} aria-pressed={allSlides}>{allSlides ? 'Focus slide' : 'All slides'}</button><button className={buttonClass} onClick={() => setEditing(structuredClone(data))}>Edit slide</button></div>}
  </div>
  return <section className="my-4 min-w-0 border-y border-glass/15 py-3" aria-label={`${data.title || 'Presentation'} deck`}>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 basis-40"><div className="text-[10px] font-bold uppercase tracking-widest text-dim">Presentation</div><h3 className="truncate text-sm font-semibold text-ink">{data.title || 'Untitled deck'}</h3><p className="text-xs text-dim">{scenes.length} slides including cover · 16:9</p></div>
      <button ref={presentButton} className={buttonClass} onClick={() => setPresenting(true)}>Present</button>
      <button className={buttonClass} onClick={() => void download('pptx')} disabled={busy !== null || loading || !fontsReady || generatingImages}>{busy === 'pptx' ? 'Building…' : 'PowerPoint'}</button>
      <button className={buttonClass} onClick={() => void download('pdf')} disabled={busy !== null || loading || !fontsReady || generatingImages}>{busy === 'pdf' ? 'Building…' : 'Download PDF'}</button>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}
    {(loading || (!fontsReady && !fontError)) && <p role="status" className="mb-2 text-xs text-dim">Preparing presentation assets…</p>}
    {fontError && <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 text-sm text-ink"><p>{fontError}</p><button className={buttonClass} onClick={() => setFontAttempt(n => n + 1)}>Retry fonts</button></div>}
    {currentAssets.total > 0 && <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-glass/5 p-3">
      <p className="min-w-0 flex-1 text-xs text-dim">{generatingImages ? `Preparing imagery · ${imageProgress} of ${currentAssets.total}` : currentAssets.pending ? 'Some images are still being prepared. Check again shortly.' : currentAssets.missing ? `${currentAssets.missing} image${currentAssets.missing === 1 ? '' : 's'} can be generated and saved to your account.` : 'Saved imagery is ready in the preview and downloads.'}</p>
      {generatingImages ? <button className={buttonClass} onClick={() => { imageController.current?.abort(); imageController.current = null; setGeneratingImages(false); setImageRefresh(n => n + 1) }}>Stop</button> : <>
        {currentAssets.pending > 0 && <button className={buttonClass} onClick={() => setImageRefresh(n => n + 1)} disabled={loading}>Check images</button>}
        {currentAssets.missing > 0 && <button className={buttonClass} onClick={() => void generateImages()} disabled={loading || busy !== null}>Generate imagery</button>}
      </>}
    </div>}
    {currentAssets.errors.length > 0 && !generatingImages && <p role="status" className="mb-2 text-xs text-dim">{currentAssets.errors[0]}</p>}
    {currentAssets.unavailable > 0 && <p role="status" className="mb-2 text-xs text-dim">{currentAssets.unavailable} image{currentAssets.unavailable === 1 ? ' is' : 's are'} unavailable. The preview and downloads use the layout shown here.</p>}
    <div className="mb-3 flex gap-2 overflow-x-auto pb-2" aria-label="Choose slide">{scenes.map((scene, i) => <button key={i} className={`w-32 shrink-0 rounded-lg border p-1 text-left ${i === selected ? 'border-glass/70 bg-glass/10' : 'border-glass/10 hover:border-glass/30'}`} aria-label={`Slide ${i + 1}: ${scene.title}`} aria-current={i === selected ? 'true' : undefined} onClick={() => { setSelected(i); setAllSlides(false); setEditing(null) }}><SlideSceneView scene={scene} thumbnail /><span className="mt-1 block truncate px-1 text-[10px] text-dim">{i + 1}. {scene.title}</span></button>)}</div>
    <div className={allSlides ? 'max-h-[78vh] space-y-4 overflow-y-auto' : ''}>{(allSlides ? scenes : [selectedScene]).map((scene, i) => <div key={allSlides ? i : selected} className="overflow-hidden rounded-lg border border-glass/10"><SlideSceneView scene={scene} /></div>)}</div>
    {navigation}
    {!!selectedScene.issues.length && <div role="alert" className="mb-3 rounded-lg border border-amber-500/30 p-3 text-sm text-ink">{selectedScene.issues.map((issue, i) => <p key={i}>{issue}</p>)}<p className="mt-2 text-xs text-dim">Edit this slide before exporting. Your full text is retained.</p></div>}
    {notes && <aside className="mb-3 rounded-xl bg-glass/5 p-4"><h4 className="mb-2 text-xs font-semibold text-dim">Speaker notes · Slide {selected + 1}</h4><p className="whitespace-pre-wrap text-sm text-ink">{selectedScene.notes || 'No speaker notes on this slide.'}</p></aside>}
    {editing && <form onSubmit={e => { e.preventDefault(); const next = sanitizeDeck(editing); setData(next); onUpdate?.(next); setEditing(null); setError('') }} className="rounded-xl border border-glass/20 p-4"><h4 className="mb-4 text-sm font-semibold text-ink">Edit slide {selected + 1}</h4><DeckFields deck={editing} index={selected} onChange={setEditing} /><div className="mt-4 flex gap-2"><button type="submit" className={buttonClass}>Save changes</button><button type="button" className={buttonClass} onClick={() => setEditing(null)}>Cancel</button></div></form>}
    <p className="mt-2 text-[10px] text-dim">PowerPoint keeps text and charts editable and uses your selected font names. PDF embeds the fonts used in this preview.{readableFontFallbacks([style.head, style.body]).length > 0 && ` Font substitutions: ${readableFontFallbacks([style.head, style.body]).join('; ')}.`}</p>
    {presenting && createPortal(<div ref={presentation} role="dialog" aria-modal="true" aria-label="Present deck" tabIndex={-1} className="fixed inset-0 z-[9999] flex flex-col bg-[#090b10] p-3 text-white outline-none sm:p-6" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPresenting(false) }
      else if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key) || (e.key === ' ' && e.target === presentation.current)) { e.preventDefault(); nav(1) }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); nav(-1) }
      else if (e.key === 'Home') { e.preventDefault(); setSelected(0) }
      else if (e.key === 'End') { e.preventDefault(); setSelected(scenes.length - 1) }
      else if (e.key === 'Tab') { const buttons = Array.from(presentation.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []); const first = buttons[0], last = buttons[buttons.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === presentation.current)) { e.preventDefault(); last?.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() } }
    }}><div className="mb-3 flex items-center justify-between gap-3"><p className="truncate text-sm">{data.title}</p><button className="shrink-0 rounded-lg border border-white/30 px-3 py-2 text-sm" onClick={() => setPresenting(false)}>Exit presentation</button></div><div className="flex min-h-0 flex-1 items-center justify-center"><div className="w-full" style={{ maxWidth: 'min(1600px, calc((100dvh - 160px) * 16 / 9))' }}><SlideSceneView scene={selectedScene} /></div></div><div className="mx-auto flex items-center gap-5 pt-3"><button className="rounded-lg border border-white/30 px-4 py-2 disabled:opacity-30" onClick={() => nav(-1)} disabled={selected === 0} aria-label="Previous slide">←</button><span className="text-xs tabular-nums">{selected + 1} / {scenes.length}</span><button className="rounded-lg border border-white/30 px-4 py-2 disabled:opacity-30" onClick={() => nav(1)} disabled={selected === scenes.length - 1} aria-label="Next slide">→</button></div></div>, document.body)}
  </section>
}
