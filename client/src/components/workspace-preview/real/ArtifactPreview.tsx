import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { normalizeDoc, type DocDoc } from '../../workspace/docModel'
import { normalizeWorkbook, type SheetDoc } from '../../workspace/sheetModel'
import { buildEvaluator } from '../../workspace/formulaEval'
import { makeDeckScenes, type SceneStyle } from '../../workspace/slideScene'
import { SlideSceneView } from '../../workspace/SlideSceneView'
import type { Deck } from '../../workspace/SlidesCard'
import MotionPreview from '../../workspace/MotionPreview'
import type { MotionSpec } from '../../workspace/motionFrame'
import './workspace-artifact-preview.css'
const ArtifactCADPreview = lazy(() => import('./ArtifactCADPreview'))

/** The exact saved message, never a second generated or placeholder artifact. */
export type ArtifactPreviewSource = {
  content?: string; design?: unknown; doc?: unknown; sheet?: unknown; deck?: unknown
  video?: unknown; cad?: unknown; audio?: unknown; image?: unknown; attachments?: unknown
}
type Props = { source?: ArtifactPreviewSource; kind?: string; title: string; html?: string; img?: string; compact?: boolean; conversation?: { user?: string; reply?: string } }
type Value = Record<string, unknown>
const object = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
const short = (value: unknown, length = 160) => string(value).replace(/\s+/g, ' ').trim().slice(0, length)
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const color = (value: unknown, fallback: string) => /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(string(value)) ? string(value) : fallback

/** Saved media only. Never turn a prompt or a generation endpoint into a GET. */
function mediaUrl(value: unknown): string {
  const url = string(value).trim()
  if (/^(?:data:(?:image|video|audio)\/|blob:)/i.test(url)) return url
  if (/^\/(?!\/)/.test(url) && !/^\/api\//i.test(url)) return url
  if (!/^https?:\/\//i.test(url) || /(?:pollinations|\/api\/(?:image|video|design|studio-images|cad)(?:[/?]|$))/i.test(url)) return ''
  return url
}

/** Put CSP before every saved token, and remove refresh navigation entirely.
 * Empty sandbox + no pointer/focus access keep HTML a passive, network-free view. */
export function passiveArtifactHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'">`
  const freeze = '<style data-artifact-freeze>*,*::before,*::after{animation-play-state:paused!important;animation-delay:-4s!important;transition:none!important}html,body{overflow:hidden!important}</style>'
  return `<!doctype html>${policy}${freeze}${html.replace(/^\s*<!doctype[^>]*>/i, '').replace(/<meta\b[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '')}`
}

function Frame({ kind, title, label, compact, children, style }: { kind: string; title: string; label: string; compact?: boolean; children: ReactNode; style?: CSSProperties }) {
  return <div className={`workspace-artifact-preview artifact-${kind}`} data-compact={compact} aria-hidden="true" style={style}>
    <div className="artifact-preview-chrome"><span>{short(title, 52)}</span><span>{label}</span></div>{children}
  </div>
}
function Unavailable({ title, kind, detail }: { title: string; kind: string; detail?: string }) {
  return <div className="artifact-preview-unavailable"><strong>{title}</strong><p>{detail || `No saved ${kind} preview. Open the creation to view it.`}</p></div>
}
function SavedImage({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return failed ? <Unavailable title={title} kind="image" detail="The saved image could not load. Open the creation to retry."/> : <img className="artifact-preview-image" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
}

function SheetPreview({ raw }: { raw: Value }) {
  const workbook = useMemo(() => normalizeWorkbook(raw as SheetDoc), [raw])
  const evaluator = useMemo(() => buildEvaluator(workbook.sheets || []), [workbook])
  const sheet = workbook.sheets?.[0]
  return <div className="artifact-preview-sheet"><strong>{workbook.title || sheet?.name}</strong>
    <table><thead><tr>{sheet?.columns?.slice(0, 4).map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{sheet?.rows?.slice(0, 5).map((row, ri) => <tr key={ri}>{row.slice(0, 4).map((cell, ci) => <td key={ci} data-formula={string(cell).startsWith('=')}>{short(evaluator.value(0, ri, ci), 24)}</td>)}</tr>)}</tbody></table>
  </div>
}

function DocumentPreview({ raw }: { raw: Value }) {
  const doc = useMemo(() => normalizeDoc(raw as DocDoc), [raw])
  const palette = doc.design?.light
  const style = palette ? { background: palette.bg, color: palette.ink, '--artifact-muted': palette.muted || palette.ink, '--artifact-accent': palette.accent || palette.ink } as CSSProperties : undefined
  return <div className="artifact-preview-document" style={style}><strong>{doc.title}</strong>{doc.subtitle && <small>{doc.subtitle}</small>}{doc.blocks?.slice(0, 5).map((block, i) => {
    if (block.type === 'heading') return <h4 key={i}>{block.text}</h4>
    if (block.type === 'paragraph') return <p key={i}>{block.text}</p>
    if (block.type === 'bullets') return <ul key={i}>{block.items?.slice(0, 3).map((item, j) => <li key={j}>{item}</li>)}</ul>
    if (block.type === 'table') return <table key={i}><thead><tr>{block.columns?.slice(0, 3).map((c, j) => <th key={j}>{c}</th>)}</tr></thead><tbody>{block.rows?.slice(0, 2).map((r, j) => <tr key={j}>{r.slice(0, 3).map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody></table>
    if (block.type === 'image' && mediaUrl(block.src)) return <img key={i} src={mediaUrl(block.src)} alt="" loading="lazy"/>
    if (block.type === 'chart') return <p key={i}>{short(block.chart?.title)} · {short(block.chart?.takeaway)}</p>
    return null
  })}</div>
}

function DeckPreview({ raw }: { raw: Value }) {
  const scene = useMemo(() => {
    const design = object(raw.design), light = object(design?.light), dark = object(design?.dark), fonts = object(design?.fonts)
    const style: SceneStyle = { head: string(fonts?.display) || 'Inter', body: string(fonts?.body) || 'Inter', dark: color(dark?.bg, '#202634'), onDark: color(dark?.ink, '#faf9fc'), subtle: color(dark?.muted, '#dce0eb'), coverAccent: color(dark?.accent, '#ced7ef'), ink: color(light?.ink, '#283043'), gold: color(light?.accent, '#536284'), muted: color(light?.muted, '#526071'), paper: color(light?.bg, '#f3f2ee'), surface: color(light?.surface, '#e9ecf2'), label: '', radius: number(design?.radius) }
    const deck = { ...raw, slides: [] } as Deck // The real renderer's cover scene; no invented slide content.
    return makeDeckScenes(deck, style, { photos: mediaUrl(raw.cover) ? { cover: mediaUrl(raw.cover) } : {} })[0]
  }, [raw])
  return <div className="artifact-preview-deck"><SlideSceneView scene={scene} thumbnail/></div>
}

function CanvasPreview({ design }: { design: Value }) {
  const mount = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    let dispose: (() => void) | undefined
    setState('loading')
    const scene = object(design.canvas)
    if (!scene || !mount.current) { setState('missing'); return }
    const sanitize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.slice(0, 1000).map(sanitize)
      if (!object(value)) return value
      return Object.fromEntries(Object.entries(value as Value).map(([key, val]) => [key, key === 'src' ? mediaUrl(val) : sanitize(val)]))
    }
    void import('fabric').then(async ({ StaticCanvas }) => {
      if (cancelled || !mount.current) return
      const width = Math.max(1, number(scene.width, 1080)), height = Math.max(1, number(scene.height, 1080))
      const scale = Math.min(720 / width, 480 / height)
      const canvas = new StaticCanvas(mount.current, { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), enableRetinaScaling: false, renderOnAddRemove: false })
      dispose = () => { void canvas.dispose() }
      await canvas.loadFromJSON(sanitize({ ...scene, objects: array(scene.objects) }) as Value, undefined, { signal: controller.signal })
      if (cancelled) return
      canvas.setZoom(scale); canvas.renderAll(); setState('ready')
    }).catch(() => { if (!cancelled) setState('missing') })
    return () => { cancelled = true; controller.abort(); dispose?.() }
  }, [design])
  return <div className="artifact-preview-canvas"><canvas ref={mount}/>{state !== 'ready' && <Unavailable title={string(design.name) || 'Saved canvas'} kind="canvas" detail={state === 'loading' ? 'Rendering saved canvas…' : 'Open the creation to render this saved canvas.'}/>}</div>
}

function BlueprintPreview({ design }: { design: Value }) {
  const floor = object(array(design.floors)[0]) || design, size = object(floor.viewBox)
  const w = Math.max(1, number(size?.w, 1000)), h = Math.max(1, number(size?.h, 700))
  const shapes = array(floor.shapes).map(object).filter((shape): shape is Value => !!shape)
  const pad = Math.max(w, h) * .04
  if (!shapes.length) return <Unavailable title={string(design.title) || 'Saved plan'} kind="plan" detail="This saved plan has no drawing shapes yet."/>
  return <svg className="artifact-preview-blueprint" viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}>
    {shapes.map((s, i) => {
      const stroke = 'currentColor', sw = Math.max(number(s.stroke, 1.5) / 22, Math.max(w, h) / 700)
      const common = { fill: 'none', stroke, strokeWidth: sw }
      if (s.type === 'rect') return <g key={i}><rect {...common} x={number(s.x)} y={number(s.y)} width={number(s.w)} height={number(s.h)}/>{!!s.label && <text x={number(s.x) + number(s.w) / 2} y={number(s.y) + number(s.h) / 2} textAnchor="middle" fill="currentColor" fontSize={w / 45}>{string(s.label)}</text>}</g>
      if (s.type === 'line') return <line key={i} {...common} x1={number(s.x1)} y1={number(s.y1)} x2={number(s.x2)} y2={number(s.y2)}/>
      if (s.type === 'circle' || s.type === 'tree') return <circle key={i} {...common} cx={number(s.cx)} cy={number(s.cy)} r={number(s.r)}/>
      if (s.type === 'ellipse') return <ellipse key={i} {...common} cx={number(s.cx)} cy={number(s.cy)} rx={number(s.rx)} ry={number(s.ry)}/>
      if (s.type === 'polyline') return <polyline key={i} {...common} points={array(s.points).map(p => array(p).map(v => number(v)).join(',')).join(' ')}/>
      if (s.type === 'text') return <text key={i} x={number(s.x)} y={number(s.y)} fill="currentColor" fontSize={w / 45}>{string(s.text)}</text>
      if (s.type === 'door' || s.type === 'window') return <line key={i} {...common} x1={number(s.x)} y1={number(s.y)} x2={number(s.x) + (s.dir === 'v' ? 0 : number(s.w))} y2={number(s.y) + (s.dir === 'v' ? number(s.w) : 0)} strokeDasharray={s.type === 'door' ? `${sw * 3} ${sw * 2}` : undefined}/>
      return null
    })}
  </svg>
}

function SavedVideo({ src, poster, title }: { src: string; poster: string; title: string }) {
  const [ready, setReady] = useState(!!poster)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setReady(!!poster); setFailed(false) }, [src, poster])
  return <div className="artifact-preview-media">{src && !failed && <video src={src} poster={poster || undefined} muted playsInline preload="metadata" tabIndex={-1} onLoadedData={() => setReady(true)} onError={() => setFailed(true)}/>}{!src && poster && <SavedImage src={poster} title={title}/>} {(!ready || failed) && <Unavailable title={title} kind="video" detail={failed ? 'The saved video frame could not load. Open to retry playback.' : 'No saved poster yet. Open the creation for video playback.'}/>}</div>
}

export default function ArtifactPreview({ source, kind = 'creation', title, html: suppliedHtml, img, compact = false, conversation }: Props) {
  const design = object(source?.design), doc = object(source?.doc), sheet = object(source?.sheet), deck = object(source?.deck)
  const html = suppliedHtml || string(design?.html)
  const website = useMemo(() => html ? passiveArtifactHtml(html) : '', [html])
  const frame = (type: string, label: string, content: ReactNode, style?: CSSProperties) => <Frame kind={type} title={title} label={label} compact={compact} style={style}>{content}</Frame>
  if (website && (kind === 'motion' || design?.kind === 'motion')) {
    // The existing player freezes its actual CSS/JS timeline for thumbnails.
    // Its opaque sandbox runs inline animation code; CSP blocks subresources
    // and fetch requests. This retains the existing player's runtime behavior.
    const motionHtml = website.replace("style-src 'unsafe-inline';", "script-src 'unsafe-inline'; style-src 'unsafe-inline';").replace(/<style data-artifact-freeze>[\s\S]*?<\/style>/, '')
    return frame('motion', 'Saved motion still', <div className="artifact-preview-motion"><MotionPreview html={motionHtml} motion={object(design?.motion) as Partial<MotionSpec> | undefined} thumbnail/></div>)
  }
  if (website) return frame('website', 'Saved page', <div className="artifact-preview-website"><iframe title={`Saved preview: ${title}`} srcDoc={website} sandbox="" tabIndex={-1} loading="lazy" referrerPolicy="no-referrer"/></div>)
  if (sheet) return frame('sheet', 'Saved workbook', <SheetPreview raw={sheet}/>)
  if (doc) return frame('document', 'Saved document', <DocumentPreview raw={doc}/>)
  if (deck) return frame('deck', 'Cover slide', <DeckPreview raw={deck}/>)
  if (design?.kind === 'canvas') return frame('canvas', 'Saved canvas', <CanvasPreview design={design}/>)
  if (design?.kind === 'blueprint') return frame('blueprint', 'Saved plan', <BlueprintPreview design={design}/>)
  if (design?.kind === 'palette') return frame('palette', 'Saved colors', <div className="artifact-preview-swatches">{array(design.colors).map(object).filter((c): c is Value => !!c).slice(0, 6).map((c, i) => <div key={i}><i style={{ background: color(c.hex, 'transparent') }}/><span>{short(c.name || c.hex, 20)}</span><small>{string(c.hex)}</small></div>)}</div>)
  if (design?.kind === 'logo') {
    const option = object(array(design.options)[0]), cache = object(design.imgCache)
    const svg = string(option?.lockup || option?.mark || design.lockup || design.mark)
    const saved = Object.values(cache || {}).map(mediaUrl).find(Boolean)
    return frame('logo', 'Saved logo', saved || svg ? <SavedImage src={saved || `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} title={title}/> : <div className="artifact-preview-content"><strong>{string(design.name)}</strong><p>{short(design.concept || design.symbol, 220)}</p><small>No saved logo image. Open the creation to view its options.</small></div>)
  }
  if (design?.kind === 'carousel') {
    const slide = object(array(design.slides)[0]), theme = object(design.theme)
    return frame('carousel', 'First saved slide', <div className="artifact-preview-social" style={{ background: color(theme?.bg, '#202634'), color: color(theme?.ink, '#faf9fc') }}>{mediaUrl(slide?.img) && <img src={mediaUrl(slide?.img)} alt="" loading="lazy"/>}<div><small>{string(slide?.badge)}</small><strong>{string(slide?.headline)}</strong><p>{short(slide?.sub || array(slide?.body).join(' '), 200)}</p></div></div>)
  }
  if (design?.kind === 'brand') {
    const brand = object(design.brand), palette = array(design.palette)
    return frame('brand', 'Saved brand book', <div className="artifact-preview-content"><strong>{string(brand?.name) || title}</strong><p>{short(brand?.tagline || brand?.mission, 210)}</p><div className="artifact-preview-brand-colors">{palette.slice(0, 5).map((c, i) => <i key={i} style={{ background: color(object(c)?.hex, 'transparent') }}/>)}</div><small>{short(brand?.voice, 130)}</small></div>)
  }
  if (design?.kind === 'shopping') return frame('shopping', 'Saved selections', <div className="artifact-preview-shopping">{array(design.items).slice(0, 3).map((value, i) => { const item = object(value); return <div key={i}><strong>{string(item?.name)}</strong><span>{string(item?.price)}</span><small>{short(item?.retailer || item?.reason, 90)}</small></div> })}</div>)
  const image = mediaUrl(img || source?.image || source?.content?.match(/^!\[[^\]]*\]\(([^)\s]+)\)/)?.[1])
  if (image) return frame('image', 'Saved image', <SavedImage src={image} title={title}/>)
  if (source?.video || kind === 'video' || kind === 'movie') {
    const video = object(source?.video), url = mediaUrl(video?.url || source?.video), poster = mediaUrl(video?.poster || video?.thumbnail)
    // Movie job references are not files. Opening the real player resolves them;
    // gallery thumbnails must not poll/resume/trigger rendering.
    const file = /\.(?:mp4|webm|mov)(?:[?#]|$)|^(?:blob:|data:video\/)/i.test(url) ? url : ''
    return frame('video', 'Saved video', <SavedVideo src={file} poster={poster} title={title}/>)
  }
  if (source?.cad) {
    const model = object(source.cad), saved = mediaUrl(model?.poster || model?.thumbnail || model?.image)
    const code = string(model?.code || source.cad)
    return frame('cad', 'Saved model', saved ? <SavedImage src={saved} title={title}/> : <Suspense fallback={<Unavailable title={title} kind="model" detail="Preparing the saved model…"/>}><ArtifactCADPreview code={code} title={title}/></Suspense>)
  }
  if (source?.audio) { const audio = object(source.audio); return frame('audio', 'Saved audio', <div className="artifact-preview-content"><strong>{string(audio?.name) || title}</strong><p>{short(audio?.transcript, 220)}</p><small>Open the creation to listen to the saved audio.</small></div>) }
  if (conversation) return frame('conversation', 'Saved conversation', <div className="artifact-preview-conversation"><p>{short(conversation.user || title, 140)}</p>{conversation.reply && <div><strong>Nalu</strong><p>{short(conversation.reply, compact ? 100 : 200)}</p></div>}</div>)
  return frame('unavailable', `Saved ${kind}`, <Unavailable title={title} kind={kind}/>)
}
