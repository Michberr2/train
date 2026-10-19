import './workspace-avatar.css'
import avatarArtwork from '../avatar/nalu-avatar.png'
import avatarWordmark from '../avatar/wordmark.png'
import WorkspaceIntro from './WorkspaceIntro'
import Scenery from '../Scenery'
import NaluAvatar from '../avatar/NaluAvatar'
import NaluMark from '../landing/NaluMark'
import NaluGlobe from '../NaluGlobe'
import { fallbackStudioIntent, parseStudioIntent, shouldClassifyStudio, studioKind as normalizeStudioKind, type StudioIntent } from '../../../../shared/studioIntent'
import { buildChatMemory } from './crossChatMemory'
import { mergeChatMessages } from '../../../../shared/chatMessages'
import { mergeChatTitle } from '../../../../shared/chatTitle'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useComposerVoice } from './useComposerVoice'
import {
  Plus,
  Search,
  PanelLeft,
  Sun,
  Moon,
  Settings,
  LogOut,
  ArrowUp,
  Square,
  MessageSquare,
  Trash2,
  Pencil,
  Bot,
  type LucideIcon,
} from 'lucide-react'
import {
  GitBranch,
  GitCommit,
  X,
  Paperclip,
  Loader2,
  FileText,
  StickyNote,
  BarChart3,
  Table2,
  Palette,
  Box,
  Film,
  ExternalLink,
  Download,
  ChevronUp,
  ChevronDown,
  Shield,
  MapPin,
  Sparkles,
  Wand2,
  Brain,
  Image as ImageIcon,
  Copy,
  Check,
  RotateCw,
} from 'lucide-react'
import { streamChat, recoverToolCalls, type WireMessage } from './agentApi'
import { getModelSettings } from '../../lib/naluSettings'
import { generateVideo } from '../../lib/videoEngine'
import H3MoviePlayer from './H3MoviePlayer'
import { movieIdFromUrl } from '../../lib/h3Movie'
import { lazy, Suspense } from 'react'
import type { WorkspaceCarouselView } from '../workspace-preview/real/WorkspaceCarousel'
import Markdown from './Markdown'
import { useTheme } from '../ThemeProvider'
import MediaLoader from './MediaLoader'
import CardErrorBoundary from './CardErrorBoundary'
import { extractAttachment, attachmentContext, attachmentExtractionSummary, type Attachment } from './extractText'
import { saveChatAttachment, loadChatAttachment } from './chatAttachments'
import { openArtifactBlob } from './artifactIsolation'
import MessageAttachments from './MessageAttachments'
import { designReferenceBrief, designReferenceInstructions, designHtmlForEdit, prepareDesignResponse, updateDesignMessage } from './designReferences'
import type { SheetDoc } from './SheetCard'
import { normalizeDoc } from './docModel'
import type { DocDoc, DocBlock } from './DocCard'
import type { Deck } from './SlidesCard'
import { cleanDeck, cleanSheet } from './textClean'
import type { DesignArtifact, DesignKind, WebsiteQuality } from './types'
import { getBrand, ensureDefaultBrand, setBrand, deriveBrand } from './brandKit'
import BrandBar from './BrandBar'
// Heavy (three.js / pptxgenjs / docx / xlsx / fabric) — load only when a card is
// shown, so they never weigh down the main site bundle / slow the whole site.
const CADCard = lazy(() => import('./CADCard'))
const SlidesCard = lazy(() => import('./SlidesCard'))
const SheetCard = lazy(() => import('./SheetCard'))
const DocCard = lazy(() => import('./DocCard'))
const EmailCard = lazy(() => import('./EmailCard'))
// Nalu Studio kind→card switch (canvas/palette/brand/blueprint + DesignCard for
// webpage/poster). Lazy so fabric/jspdf/docx never touch the main bundle.
const DesignArtifactCard = lazy(() => import('./DesignArtifactCard'))
const AgentsPanel = lazy(() => import('./AgentsPanel'))
const WorkspaceCarousel = lazy(() => import('../workspace-preview/real/WorkspaceCarousel'))
const WorkspaceAppDock = lazy(() => import('../workspace-preview/real/WorkspaceAppDock'))
const LiveWorkspaceLiveHub = lazy(() => import('../workspace-preview/real/WorkspaceLiveHub'))
const LiveWorkspaceAgentTray = lazy(() => import('../workspace-preview/real/WorkspaceAgentTray'))
const LiveWorkspaceAgentScreens = lazy(() => import('../workspace-preview/real/WorkspaceAgentScreens'))
const LiveWorkspaceChatPopover = lazy(() => import('../workspace-preview/real/WorkspaceChatPopover'))
const PreviewWorkspaceLiveHub = import.meta.env.DEV ? lazy(() => import('../workspace-preview/real/PreviewWorkspaceLiveHub')) : null
const PreviewWorkspaceAgentTray = import.meta.env.DEV ? lazy(() => import('../workspace-preview/real/PreviewWorkspaceAgentTray')) : null
const PreviewWorkspaceAgentScreens = import.meta.env.DEV ? lazy(() => import('../workspace-preview/real/PreviewWorkspaceAgentScreens')) : null
const PreviewWorkspaceChatPopover = import.meta.env.DEV ? lazy(() => import('../workspace-preview/real/PreviewWorkspaceChatPopover')) : null
import { TOOLS, execTool, WEB_TOOLS, execWebTool, isWebTool } from './agentTools'
import {
  getActiveRepo,
  setActiveRepo as persistActiveRepo,
  getToken as ghToken,
  setToken as setGhToken,
  loadRepo,
  commitFiles,
  type ActiveRepo,
} from './github'
import StudioPanel, { TOOLS as STUDIO_TOOLS, type Creation } from './StudioPanel'
import MapPanel from './MapPanel'
import MemoryPanel from './MemoryPanel'
import PlaygroundControls from './PlaygroundControls'
import SkillsPanel from './SkillsPanel'
import AutomationsPanel from './AutomationsPanel'
import SettingsPanel from './SettingsPanel'
import { pushChatsFull, sessionWasCleared, getSyncState, retrySync } from '../../lib/sync'
import { idbGetChats, idbSetChats } from '../../lib/chatStore'
import { getToken } from '../../lib/localAuth'
import WorkspaceAccountMenu from './design/WorkspaceAccountMenu'
import useLiveWorkspaceActivity from './design/useLiveWorkspaceActivity'
import useSwarm from './design/useSwarm'
import { withSwarmActivity } from './design/swarmActivity'
import { isSwarmRoom, type SwarmAgentId, type SwarmRoomReference } from './design/swarmTypes'

// ---- model ---------------------------------------------------------------

interface Msg {
  id?: string
  updatedAt?: number
  role: 'user' | 'assistant'
  content: string
  reasoning?: string // chain-of-thought (plain English) when Deep think is on
  sheet?: SheetDoc
  doc?: DocDoc
  email?: EmailDoc
  video?: string
  cad?: string
  design?: DesignArtifact
  deck?: Deck
  attachments?: Attachment[] // files attached to this (user) message
  loading?: 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides' | 'email'
  // Interactive multiple-choice clarifying questions shown before a Studio build,
  // so the user answers in a tap and the output comes out 10x. Answered → resumed.
  clarify?: { questions: ClarifyQ[]; answered?: boolean; build?: { kind: string; prompt: string; mode?: StudioIntent['mode']; additionalKinds?: StudioIntent['additionalKinds'] } }
}
export type ClarifyQ = { q: string; options: string[]; multi?: boolean }
export interface EmailDoc { to: string; subject: string; body: string }
interface Chat {
  id: string
  title: string
  titleUpdatedAt?: number
  messages: Msg[]
  createdAt: number
  notes?: string // freeform notes the AI references for this chat
  attachments?: Attachment[] // files attached to this chat (referenceable)
  projectId?: string // the project this chat belongs to (undefined = unfiled)
}

type View = 'chat' | 'studio' | 'map' | 'memory' | 'agents' | 'skills' | 'automations' | 'settings'

const CHATS_KEY = 'nalu-chats'
const ACTIVE_KEY = 'nalu-active-chat'
const MODEL_KEY = 'nalu-model'
// Tombstones: ids the user explicitly deleted. Append-only + synced, so a
// deletion is PERMANENT and never resurrected by a stale copy on any device.
const DELETED_CHATS_KEY = 'nalu-deleted-chats'
function addTombstone(key: string, id: string): void {
  try {
    const cur = JSON.parse(localStorage.getItem(key) || '[]')
    const arr: string[] = Array.isArray(cur) ? cur : []
    if (!arr.includes(id)) { arr.push(id); localStorage.setItem(key, JSON.stringify(arr)) }
  } catch { localStorage.setItem(key, JSON.stringify([id])) }
}
// Client-facing model id only. The server maps this to the real backend model
// (kept server-side), so the browser/console never references it.
const DEFAULT_MODEL = 'nalu-catalina'

// Thinking tiers you trigger by TYPING the word in your message:
//   think (basic) · ultrathink (deeper) · packmind (insane). Highest one wins.
const THINK_WORDS = /\b(packmind|ultrathink|think)\b/gi
// On-brand tier colors (site is blue + gold): think = brand blue, ultrathink =
// brand gold, packmind = deep bold blue. Text-only, no fills, no gradients.
const THINK_COLORS: Record<string, string> = { think: '#6B9FFF', ultrathink: '#AF8C56', packmind: '#2563EB' }
const THINK_NAMES: Record<number, string> = { 1: 'think', 2: 'ultrathink', 3: 'packmind' }
// Elegant high-contrast serif (Four Seasons vibe) — all preinstalled on macOS.
const THINK_FONT = '"Didot", "Bodoni 72", "Playfair Display", Georgia, serif'
function detectThinkLevel(text: string): number {
  const t = text.toLowerCase()
  if (/\bpackmind\b/.test(t)) return 3
  if (/\bultrathink\b/.test(t)) return 2
  if (/\bthink\b/.test(t)) return 1
  return 0
}
// A greeting that knows the user by name, nods to their last project, and keeps
// a bit of wolf-pack personality — so the home screen feels catered to them.
function personalGreeting(name?: string, chatTitles?: string[]): string {
  const first = (name || '').trim().split(/\s+/)[0] || 'friend'
  const lastTitle = (chatTitles || []).find((t) => t && !/^new chat$/i.test(t))
  const options = [
    `What are we building today, ${first}?`,
    `Ready when you are, ${first}. What are we building?`,
    `The pack's assembled, ${first}. What's the hunt?`,
    `Point me at something, ${first}, and I'll chase it down.`,
    `${first}, what impossible thing are we making possible today?`,
    `Fresh page, ${first}. Let's fill it with something great.`,
    `I've been sharpening my claws, ${first}. What's first?`,
    `Dream big, ${first}. I'll handle the boring parts.`,
    `Good to see you, ${first}. What are we creating?`,
    `Your move, ${first}. What are we making today?`,
    `The wolf's awake and caffeinated, ${first}. What's the plan?`,
    `Let's turn today into a win, ${first}.`,
    `Whatever you're dreaming up, ${first}, let's go build it.`,
    `New day, new hunt, ${first}. Where to?`,
    `Give me the hard problem, ${first}. I like those.`,
    `Let's make something you'll be proud of, ${first}.`,
    `I'm all ears and teeth, ${first}. What are we tackling?`,
    `Big or small, ${first}, what's on your mind today?`,
    `Let's build something the pack will howl about, ${first}.`,
    `Ready to make magic, ${first}?`,
  ]
  if (lastTitle) options.push(`Back to “${lastTitle}”, ${first}? Or something brand new?`, `We left “${lastTitle}” open, ${first}. Pick it up or start fresh?`)
  return options[Math.floor(Math.random() * options.length)]
}

// Memory is a WEB-ONLY surface (n4lu.ai / n4lu.com). It's absent from Nalu Mobile
// (a separate Expo app) by construction; this guard also hides it if the web bundle
// is ever loaded inside the desktop app's webview.
const IS_WEB_APP = typeof navigator !== 'undefined' && !/electron/i.test(navigator.userAgent || '')

const NAV_ITEMS: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'chat', label: 'Chats', icon: MessageSquare },
  { view: 'studio', label: 'Studio', icon: Palette },
  { view: 'map', label: 'Map', icon: MapPin },
  ...(IS_WEB_APP ? [{ view: 'memory' as View, label: 'Memory', icon: Brain }] : []),
  { view: 'agents', label: 'AutoPilot', icon: Bot },
  { view: 'skills', label: 'Skills', icon: Wand2 },
]

const VIEW_TITLES: Record<Exclude<View, 'chat'>, string> = {
  studio: 'Studio',
  map: 'Map',
  memory: 'Memory',
  agents: 'AutoPilot',
  skills: 'Skills',
  automations: 'Automations',
  settings: 'Settings',
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
function loadChats(): Chat[] {
  try {
    const raw = localStorage.getItem(CHATS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// Strip the heavy bits from attachments (base64 originals + long extracted text)
// so the persisted copy is small; the in-memory copy keeps everything.
function lightenAttachments(atts: Attachment[] | undefined, textLen: number): Attachment[] | undefined {
  if (!atts || !atts.length) return atts
  return atts.map((a) => ({
    ...a,
    text: typeof a.text === 'string' ? a.text.slice(0, textLen) : a.text,
    truncated: true,
    dataUrl: undefined,
  }))
}

// Persisting chats MUST always succeed. If we let a quota error abort the write,
// a deleted chat (or any edit) never lands on disk and the OLD data reloads on
// refresh — so a "deleted" chat comes back. We therefore write progressively
// lighter copies until one fits: full → no attachment blobs → no generated
// artifacts → a bare skeleton. The skeleton still lists exactly the chats that
// exist now, so deletions and new chats are ALWAYS preserved across refreshes.
//
// CRITICAL: localStorage (~5MB) and the server DB are persisted SEPARATELY. The
// browser copy is tiered-down to fit quota, but the SERVER always receives the
// full, artifact-preserving payload (dbSerialize) so docs/sheets/decks/designs
// are NEVER lost. (Previously the stripped browser copy was synced to the DB,
// which silently destroyed saved artifacts once localStorage filled up.)

// Is a string a base64 data: URL (the big, regeneratable media)?
const isDataUrl = (s: unknown): s is string => typeof s === 'string' && s.startsWith('data:')

// Full serialization for the SERVER: keep every structured artifact
// (doc/sheet/deck/cad/design + text). Only drop attachment ORIGINALS (re-
// uploadable) and, if we must fit under the request-body limit, the heaviest
// base64 media (video/images) — but NEVER the docs themselves.
function dbSerialize(chats: Chat[]): string {
  const MAX = 3_600_000 // stay under the serverless ~4.5MB body limit
  const base = (dropMedia: boolean) =>
    chats.map((c) => ({
      ...c,
      attachments: c.attachments?.map(a => ({ ...a, text: a.text?.slice(0, 4000), dataUrl: a.storage || !a.isImage ? undefined : a.dataUrl })),
      messages: c.messages.map((m) => ({
        ...m,
        attachments: m.attachments?.map(a => ({ ...a, text: a.text?.slice(0, 2000), dataUrl: a.storage || !a.isImage ? undefined : a.dataUrl })),
        // video/image are large base64 — drop only when over the size budget
        video: dropMedia && isDataUrl(m.video) ? undefined : m.video,
      })),
    }))
  let out = JSON.stringify(base(false))
  if (out.length > MAX) out = JSON.stringify(base(true)) // drop media, KEEP docs/sheets/decks/designs
  return out
}

// Flips true once the IndexedDB restore has read the existing full history (module-level
// so it survives remounts). Until then, persistChats must NOT write IDB, or a mount-time
// persist of a slim/empty first-paint copy could clobber the durable full history.
let idbReady = false

// Union one chat that exists on BOTH sides (local `a` + stored `b`) at the MESSAGE level:
// take the longer message list as the base, then restore any artifact/text field it's
// missing from the other side — so a slimmed first-paint copy is healed by the full
// IndexedDB copy (and a brand-new local message is never lost). Mirrors the server merge.
function unionChatMessages(a: Chat, b: Chat): Chat {
  const am = Array.isArray(a.messages) ? a.messages : []
  const bm = Array.isArray(b.messages) ? b.messages : []
  const [base, other] = am.length >= bm.length ? [a, b] : [b, a]
  const messages = mergeChatMessages(a.messages, b.messages) as unknown as Msg[]
  // Heal MESSAGES from the longer list (base), but scalar metadata (title/notes/projectId)
  // follows the LIVE copy `a` — a rename or re-file must never revert just because the
  // stored copy happened to carry more messages.
  return { ...other, ...base, messages, ...mergeChatTitle(a, b), notes: a.notes, projectId: a.projectId }
}

function persistChats(chats: Chat[], token: string | null): void {
  if (sessionWasCleared() || token !== getToken()) return
  // 1) SERVER: always the complete, artifact-preserving payload.
  try { pushChatsFull(dbSerialize(chats)) } catch { /* sync best-effort */ }

  // 2) INDEXEDDB: the COMPLETE local history (every doc/deck/image), no tier-down.
  //    IndexedDB's quota is hundreds of MB+ (vs localStorage's ~5MB), so a big history
  //    never overflows and is never silently slimmed — this is the durable local store.
  //    Gated on idbReady: never write until the async restore has read the existing IDB
  //    copy, so an early mount-time persist can't clobber the full history with a slim one.
  if (idbReady) { try { void idbSetChats(JSON.stringify(chats)) } catch { /* best-effort */ } }

  // 3) BROWSER localStorage: a fast FIRST-PAINT copy only, tiered down to fit the ~5MB
  //    quota (the full copy lives in IndexedDB via step 2 + the server via step 1, so
  //    this one can be as slim as a skeleton without any data loss).
  const tiers: Array<() => string> = [
    () => JSON.stringify(chats),
    // Drop attachment originals (base64) — usually the bulk of the weight.
    () =>
      JSON.stringify(
        chats.map((c) => ({
          ...c,
          attachments: lightenAttachments(c.attachments, 2000),
          messages: c.messages.map((m) => ({ ...m, attachments: lightenAttachments(m.attachments, 1000) })),
        })),
      ),
    // Drop big base64 MEDIA but KEEP structured docs/sheets/decks/designs.
    () =>
      JSON.stringify(
        chats.map((c) => ({
          ...c,
          attachments: lightenAttachments(c.attachments, 0),
          messages: c.messages.map((m) => ({
            ...m,
            attachments: lightenAttachments(m.attachments, 0),
            video: isDataUrl(m.video) ? undefined : m.video,
            design: undefined, // designs can embed base64; kept on server
          })),
        })),
      ),
    // Last resort: keep text only (server still has the full artifacts).
    () =>
      JSON.stringify(
        chats.map((c) => ({
          id: c.id,
          title: c.title, titleUpdatedAt: c.titleUpdatedAt,
          createdAt: c.createdAt,
          projectId: c.projectId,
          notes: typeof c.notes === 'string' ? c.notes.slice(0, 4000) : c.notes,
          messages: c.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '', reasoning: m.reasoning })),
        })),
      ),
    // Skeleton — guarantees the chat LIST (and every deletion) survives.
    () => JSON.stringify(chats.map((c) => ({ id: c.id, title: c.title, titleUpdatedAt: c.titleUpdatedAt, createdAt: c.createdAt, projectId: c.projectId, messages: [] }))),
  ]
  for (const build of tiers) {
    try {
      localStorage.setItem(CHATS_KEY, build())
      return
    } catch {
      /* too big for this tier — fall through to a lighter one */
    }
  }
}
function loadModel(): string {
  return DEFAULT_MODEL
}

interface Props {
  user: { id?: string; displayName: string } | null
  onLogout: () => void
  /** Visual presentation only; does not initialize preview data. */
  designEnabled?: boolean
  /** Local-only sample controllers, guarded separately from the design. */
  designPreview?: boolean
}

// A pitch/investor deck → also earns a companion "Investor Meeting Playbook" doc.
// INVESTOR-pitch signal on the raw prompt. Deliberately tight — every token here is
// investor-specific, so it does NOT fire for "a fashion runway show", "raising healthy
// kids", "home valuation", or "a sales pitch deck for our product". Terse-but-genuine
// pitches are still caught by deckLooksPitch() on the BUILT deck (belt-and-suspenders).
const PITCH_INTENT =
  /\b(pitch\s*deck|investors?|fundrais\w*|raise\s+(?:a\s+|our\s+|\$?\d|money|capital|funds?|a?\s*round)|pre-?seed|seed round|series\s*[a-e]\b|\bvc\b|venture\s+capital|cap ?table|angel\s+(?:investors?|round)|demo ?day|term ?sheet|use of funds)\b/i
// A BUILT deck "reads as a pitch" when its slide titles carry the investor arc or it
// shows money charts — so the companion playbook attaches even when the PROMPT was terse
// (e.g. "a deck for Acme"). Belt-and-suspenders with PITCH_INTENT on the raw prompt.
function deckLooksPitch(deck?: Deck): boolean {
  const slides = deck?.slides || []
  if (!slides.length) return false
  const titles = slides.map((s) => (s && s.title) || '').join(' \n ').toLowerCase()
  const arcHits = (titles.match(/\b(problem|solution|market|tam|sam|som|traction|the ask|use of funds|valuation|raise|fundrais\w*|competition|unit economics|\barr\b|\bmrr\b|\bcac\b|\bltv\b|business model|runway|investors?)\b/g) || []).length
  const moneyCharts = slides.filter((s) => s && s.chart && /[$%]/.test(s.chart.unit || '')).length
  return arcHits >= 2 || moneyCharts >= 2
}
// Build the playbook prompt from the finished deck so the doc is grounded in the
// deck's real narrative + numbers (speaker script per slide, Q&A, objections, close).
function deckPlaybookPrompt(deck: { title?: string; subtitle?: string; slides?: unknown[] }): string {
  const compact = (deck.slides || []).map((s, i) => {
    const sl = s as { title?: string; notes?: string; bullets?: string[]; stat?: { value?: string; label?: string }; kpis?: { value?: string; label?: string }[]; columns?: { heading?: string; items?: string[] }[]; chart?: { title?: string; takeaway?: string }; quote?: { text?: string }; table?: { headers?: string[]; rows?: string[][] } }
    const parts: string[] = [`Slide ${i + 1}: ${sl.title || ''}`]
    if (sl.stat?.value) parts.push(`  Stat: ${sl.stat.value} ${sl.stat.label || ''}`)
    if (sl.kpis?.length) parts.push(`  KPIs: ${sl.kpis.map((k) => `${k.value} ${k.label}`).join('; ')}`)
    if (sl.columns?.length) parts.push(`  Columns: ${sl.columns.map((c) => `${c.heading}: ${(c.items || []).join(', ')}`).join(' | ')}`)
    if (sl.chart?.takeaway) parts.push(`  Chart takeaway: ${sl.chart.takeaway}`)
    if (sl.quote?.text) parts.push(`  Quote: ${sl.quote.text}`)
    if (sl.table?.rows?.length) parts.push(`  Table: ${(sl.table.headers || []).join(' | ')} :: ${sl.table.rows.slice(0, 4).map((r) => r.join(' / ')).join(' ; ')}`)
    if (sl.bullets?.length) parts.push(`  Points: ${sl.bullets.join('; ')}`)
    if (sl.notes) parts.push(`  Notes: ${sl.notes}`)
    return parts.join('\n')
  }).join('\n\n')
  return `Create an "Investor Meeting Playbook" document that goes WITH the pitch deck below, so the founder can nail the meeting. It is the founder's cheat sheet, not a summary of the deck. Ground EVERYTHING in the deck's real narrative and numbers; never invent a figure the deck doesn't give (write "[confirm]" instead).

Structure it with these sections, in this order:
1. The 30-Second Pitch - a tight, memorable elevator pitch to open with or to answer "so what do you do?".
2. The Narrative Arc - the story in 4-6 beats (problem, why now, solution, traction, the ask) so the pitch flows as one argument.
3. Slide-by-Slide Speaker Script - for EACH slide (by its title), 2-4 sentences of exactly what to SAY: the ONE point to land, the key number to say out loud, and a one-line transition to the next slide. Confident, specific, no filler.
4. Numbers to Know Cold - the metrics an investor will drill on (market-size basis, CAC/LTV/payback, ARR and growth, burn and runway, the ask and use of funds), each with a one-line defense.
5. Tough Questions and Strong Answers - 8-10 hard investor questions (competition, defensibility, why-now, unit economics, team, go-to-market risk, and the "why will this fail?" question), each with a crisp, honest, confident answer that uses the deck's facts.
6. Objection Handling - the 3-4 likeliest objections and how to reframe each.
7. The Close - how to state the ask and the specific next step to request.

Make it genuinely useful and specific. Use clean headings and short paragraphs / bullets.

THE PITCH DECK:
Title: ${deck.title || ''}${deck.subtitle ? `\nSubtitle: ${deck.subtitle}` : ''}

${compact}`
}
// Download any media URL (video/image, incl. cross-origin) to the user's disk.
async function downloadMedia(url: string, fallbackName: string) {
  try {
    const r = await fetch(url)
    const blob = await r.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fallbackName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  } catch {
    window.open(url, '_blank') // fetch blocked (CORS) — open it for manual save
  }
}

// Rasterize the most recent on-screen blueprint (BlueprintCard SVG) so a video
// ask like "walkthrough of this blueprint" can use it as the start frame.
async function blueprintSnapshot(): Promise<string | undefined> {
  const els = document.querySelectorAll('svg[data-blueprint]')
  const el = els[els.length - 1] as SVGSVGElement | undefined
  if (!el) return undefined
  try {
    let doc = new XMLSerializer().serializeToString(el)
    if (!/xmlns=/.test(doc)) doc = doc.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
    const url = URL.createObjectURL(new Blob([doc], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('svg')); img.src = url })
    const W = 1024
    const H = Math.max(1, Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * W))
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.fillStyle = '#0b0e16'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(img, 0, 0, W, H)
    URL.revokeObjectURL(url)
    return canvas.toDataURL('image/jpeg', 0.92)
  } catch {
    return undefined
  }
}

// ---- Specialist boost: two agents on one artifact -------------------------
// When a doc/sheet/deck ask clearly belongs to a domain expert (finance, legal,
// health…), that specialist drafts the SUBSTANCE first and the artifact engine
// designs the final piece from it — e.g. "document for financial freedom" runs
// Nalu Financial × Nalu Docs instead of a generic writer alone.
const BOOSTS: { kind: string; label: string; re: RegExp }[] = [
  { kind: 'finance', label: 'Nalu Financial', re: /\b(financ\w*|invest\w*|wealth|budget\w*|portfolio|retire\w*|401k|ira\b|roth|stocks?|equit\w*|hedge fund|net worth|taxes|fire number|savings?|debt|dividend|compound)\b/i },
  { kind: 'legal', label: 'Nalu Law', re: /\b(contract|lease|nda|legal|liabilit\w*|terms (of service|of use|and conditions)|compliance|llc|incorporat\w*|will and testament|exhibits? [a-z0-9]|exhibit\b|addendum|amendment|agreement|clause|affidavit|bylaws|memorandum of|eula|privacy policy|licens\w* (agreement|terms)|indemnif\w*|ip assignment|cease and desist|demand letter|power of attorney)\b/i },
  { kind: 'construction', label: 'Nalu Construction', re: /\b(construction|contractor|estimate for|takeoff|framing|drywall|roofing|concrete|rebar|foundation|osha|safety plan|scope of work|schedule of values|punch list|change order|building permit|jobsite|crew)\b/i },
  { kind: 'cre', label: 'Nalu CRE', re: /\b(commercial real estate|nnn|triple net|office building|retail center|shopping center|industrial|warehouse|multifamily|cap rate|noi|rent roll|dscr|cmbs|proforma|pro forma|ground lease|tenant improvement|loi|entitlement|sitework|slab|concrete|blueprint|surveying|construction cost|gmp)\b/i },
  { kind: 'realestate', label: 'Nalu Real Estate', re: /\b(real estate|property|rental|landlord|tenant|mortgage|house (hunt|purchase|buying)|home (buying|selling|staging)|airbnb|interior design|staging|renovat\w*|remodel\w*|floor ?plan|cap ?rate|brrrr)\b/i },
  { kind: 'crypto', label: 'Nalu Crypto', re: /\b(crypto\w*|bitcoin|ethereum|defi|blockchain|token|staking|web3)\b/i },
  { kind: 'math', label: 'Nalu Math', re: /\b(math (worksheet|problem set|study guide|proof)|proof of|solve these|step.by.step solution|calculus|algebra|geometry) (problems?|worksheet|guide|homework)?\b/i },
  { kind: 'social', label: 'Nalu Social', re: /\b(carousel|social (media )?post|instagram|linkedin post|tiktok|reels?|story|pinterest|threads|\bpost\b|caption|content (calendar|series|plan)|hashtags?|go viral|hook)\b/i },
  { kind: 'science', label: 'Nalu Science', re: /\b(scientific (paper|article|study|method)|research (paper|proposal)|physics|chemistry|biology|drug (design|discovery|candidate)|formula|derivation|experiment (design|protocol)|lab report|clinical trial design|pharmacolog\w*|hypothesis)\b/i },
  { kind: 'medical', label: 'Nalu Medical', re: /\b(medical|medicine|clinical|diagnos\w*|treatment|medication|drug|patient|usmle|med school|shelf exam|residency|anatomy|pharmacolog\w*|nursing|study guide for (the )?(usmle|step|mcat|boards))\b/i },
  { kind: 'hr', label: 'Nalu HR', re: /\b(job (post|description)|offer letter|employee handbook|onboarding (plan|checklist)|performance review|pip\b|comp(ensation)? (band|plan)|salary band|severance|hiring plan|interview (loop|kit|questions)|hr polic\w*|pto policy)\b/i },
  { kind: 'health', label: 'Nalu Health', re: /\b(workout|nutrition|diet|meal plan|fitness|training plan|health plan|wellness|macros)\b/i },
  { kind: 'marketing', label: 'Nalu Marketing', re: /\b(marketing|seo|go.?to.?market|launch plan|campaign|content (strategy|calendar)|brand strategy|growth plan)\b/i },
]
function boostFor(text: string): { kind: string; label: string } | null {
  return boostsFor(text)[0] || null
}
/** ALL matching domain experts (best first, cap 2) — a doc that is both legal
 *  AND financial gets briefs from BOTH before the engine designs it. */
function boostsFor(text: string): Array<{ kind: string; label: string }> {
  const scored: Array<{ kind: string; label: string; score: number }> = []
  for (const b of BOOSTS) {
    const hits = text.match(new RegExp(b.re.source, 'gi'))
    if (hits && hits.length) scored.push({ kind: b.kind, label: b.label, score: hits.length })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 2).map(({ kind, label }) => ({ kind, label }))
}
const BOOST_BRIEF = (ask: string) =>
  `You are the domain expert contributing the SUBSTANCE for a piece a separate specialist will design and format. Produce the complete expert content for the request below — the real strategy, specific numbers and dollar math, frameworks, step-by-step plans, tables (as markdown), risks and caveats. Be exhaustive and concrete; no formatting advice, no preamble — just the expert material.\n\nTHE REQUEST:\n${ask}`

// Photo → executive breakdown board: the user attached a photo and asks to
// break down / analyze / board everything in it. Routed BEFORE doc (a
// "breakdown" would otherwise read like a document ask).
const BREAKDOWN_INTENT =
  /\b(break ?downs?|breaks? (it|this|the \w+) down|deconstruct|itemi[sz]e|catalog(ue)?|inventory|(everything|all( the)? (elements|details|parts|objects))\s+(in|about|of)\s+(this|the|that|my)\s+(photo|image|picture|pic|shot)|(architectural|design|executive|presentation|breakdown)\s+board|analy[sz]e\s+(this|the|that|my)\s+(photo|image|picture|pic|house|building|room|design))\b/i

// Live intent detection for the prompt bar — mirrors send()'s exact routing
// order (doc → slides → cad → designKind → sheet → video → image) so the chip
// shown as you type matches what will actually be built.
const KIND_LABEL: Record<string, string> = {
  webpage: 'Website', poster: 'Poster', canvas: 'Canvas', palette: 'Palette',
  brand: 'Brand book', blueprint: 'Blueprint', logo: 'Logo', shopping: 'Shopping list', motion: 'Motion graphic',
  game: 'Game', board: 'Breakdown board', carousel: 'Carousel',
}
export function detectIntent(text: string, hasImages = false): string | null {
  const kind = fallbackStudioIntent(text).kind
  if (hasImages && kind !== 'chat' && BREAKDOWN_INTENT.test(text)) return 'Breakdown board'
  const labels: Partial<Record<StudioIntent['kind'], string>> = {
    website: 'Website', document: 'Document', book: 'Long-form document', spreadsheet: 'Spreadsheet',
    slides: 'PowerPoint', cad: '3D model', video: 'Video', image: 'Image', email: 'Email',
  }
  return kind === 'chat' ? null : labels[kind] || KIND_LABEL[kind] || null
}

// What the vision model is asked for before a breakdown board is designed —
// exhaustive, structured ground truth about the photo.
const BREAKDOWN_VISION_PROMPT = `Analyze this photo exhaustively for a design team building an executive presentation board about it. Organize your analysis under these headings (plain text, be specific and technical):
SUBJECT: what it is, style/era/movement, overall character (2-3 sentences).
ELEMENTS: every significant visible element, one line each — name, description, material/finish, estimated dimensions where inferable. Cover 10-20 elements (for a building: massing, roof, each facade element, glazing, cladding, entry, landscape, lighting; for other subjects: every object/part).
MATERIALS & COLORS: each material and dominant color with an estimated hex value and where it appears.
TEXT: any visible text/signage verbatim.
SPATIAL: layout, proportions, and (for architecture) a plausible read of the floor plan/room arrangement implied by the massing and windows.
CONDITION & CONTEXT: setting, condition, time of day, notable details.
Reply with ONLY the analysis.`

// Natural pixel dims of a data-URL image — so embedded images keep their aspect
// ratio in the .docx / .pdf export. Resolves to 0×0 on failure (callers fall back).
function imageNaturalDims(src: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const im = new Image()
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = () => res({ w: 0, h: 0 })
    im.src = src
  })
}

// One-line caption for an attached image, via the vision model (the doc/sheet
// text model can't see images, so it places them by caption + index).
async function captionImage(
  src: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  let text = ''
  try {
    await streamChat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'In one short sentence, caption this image so it can be placed in a document. Reply with ONLY the caption — no preamble.' },
            { type: 'image_url', image_url: { url: src } },
          ],
        },
      ],
      model,
      { onDelta: (t) => { text += t }, signal },
    )
  } catch {
    /* ignore — fall back to a generic caption */
  }
  return text.trim().replace(/^["']+|["']+$/g, '').slice(0, 160)
}

/** Resolve image blocks the doc model placed by `ref` (index into the user's
 *  attached images) into real embedded images. Any images the model FORGOT to
 *  place are appended at the end, so the user's files always make it in. */
async function embedDocImages(
  blocks: DocBlock[],
  images: { src: string; caption: string }[],
): Promise<DocBlock[]> {
  if (!images.length) return blocks
  const dims = await Promise.all(images.map((im) => imageNaturalDims(im.src)))
  const used = new Set<number>()
  const out: DocBlock[] = blocks.map((b) => {
    const ref = (b as { ref?: unknown }).ref
    if (b.type === 'image' && typeof ref === 'number' && images[ref]) {
      used.add(ref)
      const d = dims[ref]
      return { type: 'image', src: images[ref].src, caption: (b as { caption?: string }).caption || images[ref].caption, w: d.w || undefined, h: d.h || undefined }
    }
    return b
  })
  images.forEach((im, i) => {
    if (!used.has(i)) {
      const d = dims[i]
      out.push({ type: 'image', src: im.src, caption: im.caption, w: d.w || undefined, h: d.h || undefined })
    }
  })
  return out
}

/** Normalize the /api/design response into a typed artifact. A bare string
 *  (legacy cached message that stored raw HTML) maps to a webpage artifact so
 *  old chats keep rendering after the string→union change. webpage responses
 *  omit `kind`, so fall back to the requested kind. */
function normalizeArtifact(kind: DesignKind, raw: unknown): DesignArtifact {
  if (typeof raw === 'string') return { kind: 'webpage', html: raw }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const k = (typeof obj.kind === 'string' ? obj.kind : kind) as DesignKind
  return { ...(obj as object), kind: k } as DesignArtifact
}

// Subtle, model-specific background photo (kept dark via a heavy overlay so the
// page never goes light when the active Nalu specialist changes).
function bgFor(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('catalina')) return '/bg/catalina.png'
  if (/code|reason|cad|design|studio|vision/.test(n)) return '/bg/tech.png'
  if (/financ|crypto|real estate|legal|health|marketing/.test(n)) return '/bg/business.png'
  if (/image|video|slide|doc|sheet/.test(n)) return '/bg/creative.png'
  return '/bg/tech.png'
}

// Tool execution is driven by the response's explicit tool-call signal. Answer
// content may be code, JSON, a quotation or a public product comparison; preserve
// it literally instead of deleting text that happens to resemble tool syntax.
function cleanForDisplay(s: string): string {
  return s.trim()
}

// Thinking is a COLLAPSIBLE block ABOVE the answer (not a side-by-side split, which
// squeezed the answer into half the width). The answer is ALWAYS full-width and clean.
// While the model reasons/searches, the block is open with a live "Thinking…" pulse;
// when the turn finishes it auto-collapses to a "View thinking" button you can reopen.
function AssistantThink({
  reasoning,
  isLive,
  children,
}: {
  reasoning?: string
  isLive: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  const wasLive = useRef(isLive)
  useEffect(() => {
    if (wasLive.current && !isLive) setOpen(false) // finished → collapse the thoughts
    if (!wasLive.current && isLive) setOpen(true) // a new turn started → reopen
    wasLive.current = isLive
  }, [isLive])

  if (!reasoning) return <>{children}</>

  return (
    <div className="min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-glass/[0.14] bg-glass/[0.05] px-2.5 py-1 text-xs text-dim transition-colors hover:bg-glass/10 hover:text-ink"
      >
        {isLive ? <NaluGlobe size={18} /> : <Brain size={14} />}
        {isLive ? 'Thinking…' : 'View thinking'}
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <div
          className={`mb-3 border-l-2 border-glass/[0.18] pl-3 text-[13px] leading-relaxed text-dim whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${isLive ? 'streaming-caret' : ''}`}
        >
          {cleanForDisplay(reasoning)}
        </div>
      )}
      {/* the answer — always full width, never squeezed */}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export default function Workspace({ user, onLogout, designEnabled = false, designPreview = false }: Props) {
  const previewLayout = import.meta.env.DEV && designPreview
  const reviewLayout = designEnabled || previewLayout
  const WorkspaceLiveHub = previewLayout && PreviewWorkspaceLiveHub ? PreviewWorkspaceLiveHub : LiveWorkspaceLiveHub
  const WorkspaceAgentTray = previewLayout && PreviewWorkspaceAgentTray ? PreviewWorkspaceAgentTray : LiveWorkspaceAgentTray
  const WorkspaceAgentScreens = previewLayout && PreviewWorkspaceAgentScreens ? PreviewWorkspaceAgentScreens : LiveWorkspaceAgentScreens
  const WorkspaceChatPopover = previewLayout && PreviewWorkspaceChatPopover ? PreviewWorkspaceChatPopover : LiveWorkspaceChatPopover
  const sessionToken = useRef(getToken()).current
  // Restore the last view on refresh (Studio/Map/AutoPilot/Chats) — back to your
  // last touch point. Skip 'settings' so a refresh never dumps you into settings.
  const [view, setView] = useState<View>(() => {
    const billingReturn = new URLSearchParams(window.location.search).get('billing')
    if (window.location.hash === '#settings' || billingReturn === 'success' || billingReturn === 'cancel') return 'settings'
    const v = localStorage.getItem('nalu-view')
    return v && v !== 'settings' && (v === 'chat' || Object.prototype.hasOwnProperty.call(VIEW_TITLES, v)) ? v as View : 'chat'
  })
  // The carousel is the entry point on every authenticated visit. Retain the
  // saved view underneath it without letting that preference bypass the picker.
  const [launcherOpen, setLauncherOpen] = useState(() => reviewLayout && (!previewLayout
    || new URLSearchParams(location.search).get('view') !== 'memory'))
  const [launcherSelection, setLauncherSelection] = useState<WorkspaceCarouselView>('studio')
  const [hasOpenedSpace, setHasOpenedSpace] = useState(!launcherOpen)
  const [agentScreensOpen, setAgentScreensOpen] = useState(previewLayout && new URLSearchParams(location.search).get('screens') === '1')
  const [selectedAgentItem, setSelectedAgentItem] = useState<string | null>(null)
  const agentScreenTrigger = useRef<HTMLElement | null>(null)
  const [reviewChatOpen, setReviewChatOpenState] = useState(previewLayout && new URLSearchParams(location.search).get('swarm') === '1')
  const reviewChatOpenRef = useRef(reviewChatOpen)
  const setReviewChatOpen = useCallback((open: boolean) => {
    reviewChatOpenRef.current = open
    setReviewChatOpenState(open)
  }, [])
  const reviewMainRef = useRef<HTMLElement>(null)
  const [chatInlineAnchor, setChatInlineAnchor] = useState<HTMLDivElement | null>(null)
  const [chatContentVisible, setChatContentVisible] = useState(false)
  useEffect(() => {
    if (!reviewLayout || !reviewMainRef.current) return
    reviewMainRef.current.inert = launcherOpen || agentScreensOpen
    if (launcherOpen || agentScreensOpen || reviewChatOpenRef.current) return
    const frame = requestAnimationFrame(() => reviewMainRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [reviewLayout, launcherOpen, agentScreensOpen])
  const [navOpen, setNavOpen] = useState(false) // the nav dropdown open/closed
  const [model] = useState<string>(() => loadModel())
  const [chats, setChats] = useState<Chat[]>(() => loadChats())
  // Local design review tracks real request IDs separately from the send guard,
  // whose '__new__' sentinel cannot identify a newly created conversation.
  const [reviewActiveChats, setReviewActiveChats] = useState<string[]>([])
  const baseActivity = useLiveWorkspaceActivity({ chats, activeChatIds: reviewActiveChats, accountId: user?.id, enabled: reviewLayout && !previewLayout })
  const liveSwarm = useSwarm({ accountId: user?.id, enabled: reviewLayout && !previewLayout, active: reviewChatOpen || agentScreensOpen || view === 'memory' })
  const liveActivity = withSwarmActivity({ ...baseActivity, error: [baseActivity.error, liveSwarm.error].filter(Boolean).join(' '), refresh: () => { baseActivity.refresh(); liveSwarm.refresh?.() } }, liveSwarm.state)
  const [swarmNavigationRequest, setSwarmNavigationRequest] = useState<(SwarmRoomReference & { key: number }) | undefined>()
  const [agentConversationRequest, setAgentConversationRequest] = useState<{ agent: SwarmAgentId; key: number }>()
  const [saveState, setSaveState] = useState(getSyncState)
  useEffect(() => {
    const update = () => setSaveState(getSyncState())
    window.addEventListener('nalu-sync-status', update)
    return () => window.removeEventListener('nalu-sync-status', update)
  }, [])
  // Restore the COMPLETE history from IndexedDB (the durable, quota-free local store).
  // localStorage may only hold a slimmed/skeleton first-paint copy, so this heals the full
  // docs/decks/images back into view. UNION by id + per-message (richer wins) — never drops
  // a chat the user just created, and honors deletions so a deleted chat can't resurrect.
  // Runs on mount AND whenever the server hydrate finishes (it writes the full copy to IDB
  // first), so even a browser too small to hold the history in localStorage shows every file.
  const restoreFromIdb = useCallback(() => {
    idbGetChats().then((json) => {
      if (sessionToken !== getToken() || sessionWasCleared()) return
      try {
        const p = json ? JSON.parse(json) : []
        const idbChats: Chat[] = Array.isArray(p) ? p : []
        if (idbChats.length) {
          let dead: Set<string>
          try { dead = new Set(JSON.parse(localStorage.getItem(DELETED_CHATS_KEY) || '[]') as string[]) } catch { dead = new Set() }
          setChats((cur) => {
            const byId = new Map<string, Chat>()
            for (const c of idbChats) if (c && c.id && !dead.has(c.id)) byId.set(c.id, c)
            for (const c of cur) {
              if (!c || !c.id || dead.has(c.id)) continue // tombstone BOTH sides — never resurrect a deleted chat
              const ex = byId.get(c.id)
              byId.set(c.id, ex ? unionChatMessages(c, ex) : c)
            }
            return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          })
        }
      } catch { /* corrupt IDB copy — ignore, server/localStorage still cover it */ }
      idbReady = true // the existing full copy has been read — safe to persist to IDB now
    })
  }, [])
  useEffect(() => { restoreFromIdb() }, [restoreFromIdb])
  useEffect(() => {
    const onHydrated = () => {
      setChats((cur) => (cur.length ? cur : loadChats()))
      restoreFromIdb() // hydrate wrote the full server copy to IDB — pull it into view
    }
    window.addEventListener('nalu-hydrated', onHydrated)
    return () => window.removeEventListener('nalu-hydrated', onHydrated)
  }, [restoreFromIdb])
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY) || null,
  )
  const [input, setInput] = useState('')
  // When the live "Creating: X" chip is showing, the user can × it to force a
  // plain text answer instead of building the studio artifact. We remember the
  // exact prompt they dismissed for; if they edit the text the chip comes back.
  const [dismissedIntent, setDismissedIntent] = useState<string | null>(null)
  // Deep-think toggle: when on, the base model reasons before answering (slower,
  // stronger). Off by default for fast replies.
  // Thinking level is now driven by keywords typed in the message (think /
  // ultrathink / packmind) — no button.
  const thinkLevel = useMemo(() => detectThinkLevel(input), [input])
  // A fresh, delightful greeting each time you land on a new chat.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const greeting = useMemo(() => personalGreeting(user?.displayName, chats.map((c) => c.title)), [activeId, user?.displayName])
  const [streaming, setStreaming] = useState(false)
  const [studioTurn, setStudioTurn] = useState<{ chatId: string; messageId: string } | null>(null)
  const [copiedMsg, setCopiedMsg] = useState<number | null>(null) // index of the msg just copied
  const { isDark, toggleTheme } = useTheme()
  // Light mode = black logo; dark mode = white (inverted) logo.
  const logoClass = `brightness-0 ${isDark ? 'invert' : ''}`
  const [routeName, setRouteName] = useState('Nalu')
  const [query, setQuery] = useState('')
  const [chatsExpanded, setChatsExpanded] = useState(false) // preview latest few; "Show all" reveals the rest
  // Sidebar is a push-column on desktop but an off-canvas overlay on phones, so
  // it defaults open on desktop (nav — including AutoPilot — is visible on load)
  // and closed on mobile (chat gets the full width; sidebar opens as an overlay).
  // Initialise from the width directly so there's no collapsed→open flash.
  const [sidebarOpen, setSidebarOpen] = useState(() => !reviewLayout && typeof window !== 'undefined' && window.innerWidth >= 768)
  const closeSidebarOnMobile = useCallback(() => {
    if (reviewLayout || (typeof window !== 'undefined' && window.innerWidth < 768)) setSidebarOpen(false)
  }, [reviewLayout])
  const openSpace = useCallback((next: WorkspaceCarouselView) => {
    setReviewChatOpen(false)
    setAgentScreensOpen(false)
    setView(next)
    setLauncherSelection(next)
    setLauncherOpen(false)
    setHasOpenedSpace(true)
    closeSidebarOnMobile()
  }, [closeSidebarOnMobile, setReviewChatOpen])
  const openWorkspaceLauncher = useCallback(() => {
    setReviewChatOpen(false)
    setAgentScreensOpen(false)
    if (view !== 'settings' && view !== 'automations') setLauncherSelection(view)
    setLauncherOpen(true)
  }, [view, setReviewChatOpen])
  const openAgentScreens = useCallback((id: string | null) => {
    if (document.activeElement instanceof HTMLElement) agentScreenTrigger.current = document.activeElement
    setSelectedAgentItem(id)
    setAgentScreensOpen(true)
    setLauncherOpen(false)
    setHasOpenedSpace(true)
  }, [])
  const closeAgentScreens = useCallback(() => {
    setAgentScreensOpen(false)
    requestAnimationFrame(() => agentScreenTrigger.current?.focus({ preventScroll: true }))
  }, [])
  const openSwarmActivity = useCallback((room: SwarmRoomReference) => {
    if (previewLayout || !isSwarmRoom(liveSwarm.state, room.projectId, room.thread)) return
    setSwarmNavigationRequest(current => ({ ...room, key: (current?.key || 0) + 1 }))
    setAgentScreensOpen(false)
    setReviewChatOpen(true)
  }, [previewLayout, liveSwarm.state, setReviewChatOpen])
  const selectActivityItem = useCallback((id: string | null) => {
    const item = liveActivity.items.find(item => item.id === id)
    if (item?.swarm) { setSelectedAgentItem(id); openSwarmActivity(item.swarm) }
    else openAgentScreens(id)
  }, [liveActivity.items, openSwarmActivity, openAgentScreens])
  const abortRef = useRef<AbortController | null>(null)
  // Synchronous per-target in-flight guard. `streaming` state is stale during the
  // multi-second intent/clarify preflight, so a fast second Enter could double-fire
  // the SAME turn. We key by target chat (not a global flag) so a deliberate
  // background build in another chat is still allowed — only re-sending into the
  // same target mid-flight is blocked.
  const sendingChatsRef = useRef<Set<string>>(new Set())
  const lastSentPromptRef = useRef('') // stopped mid-generation → prompt returns for editing
  // A Studio build paused to ask clarifying questions: the user's NEXT message
  // answers them and resumes the build with this kind + original prompt.
  const pendingBuildRef = useRef(new Map<string, { kind: string; prompt: string; questions?: ClarifyQ[]; mode?: StudioIntent['mode']; additionalKinds?: StudioIntent['additionalKinds'] }>())
  const chatsRef = useRef<Chat[]>([]) // always-latest chats (for reads after awaits)
  const attachPromiseRef = useRef<Promise<void> | null>(null) // in-flight extraction
  const scrollRef = useRef<HTMLDivElement>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null) // debounced chat persistence
  // Stick-to-bottom: while the answer streams we follow it so it "finishes as you
  // go", but only if you're already at the bottom — scroll up to read history and
  // we stop yanking you down. Resumes the moment you return to the bottom.
  const pinnedRef = useRef(true)
  const onChatScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])
  const taRef = useRef<HTMLTextAreaElement>(null)

  // connected GitHub repo + staged changes
  const [activeRepo, setActiveRepoState] = useState<ActiveRepo | null>(() => getActiveRepo())
  const [changeCount, setChangeCount] = useState(0)
  const changesRef = useRef<Record<string, string>>({})
  const [showConnect, setShowConnect] = useState(false)
  const [tokenInput, setTokenInput] = useState(() => ghToken())
  const [repoInput, setRepoInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [committing, setCommitting] = useState(false)

  const connectRepo = useCallback(async () => {
    const t = tokenInput.trim()
    const [owner, name] = repoInput.trim().split('/')
    if (!t || !owner || !name) return
    setConnecting(true)
    try {
      setGhToken(t)
      const repo = await loadRepo(t, owner, name)
      persistActiveRepo(repo)
      setActiveRepoState(repo)
      changesRef.current = {}
      setChangeCount(0)
      setShowConnect(false)
      setRepoInput('')
    } catch (e) {
      alert(`Connect failed: ${(e as Error).message}`)
    } finally {
      setConnecting(false)
    }
  }, [tokenInput, repoInput])

  const disconnectRepo = useCallback(() => {
    persistActiveRepo(null)
    setActiveRepoState(null)
    changesRef.current = {}
    setChangeCount(0)
  }, [])

  const commit = useCallback(async () => {
    if (!activeRepo || !changeCount) return
    setCommitting(true)
    try {
      const sha = await commitFiles(ghToken(), activeRepo, changesRef.current, 'Nalu: apply changes')
      changesRef.current = {}
      setChangeCount(0)
      alert(`Committed ${sha.slice(0, 7)} to ${activeRepo.owner}/${activeRepo.repo}@${activeRepo.branch}`)
    } catch (e) {
      alert(`Commit failed: ${(e as Error).message}`)
    } finally {
      setCommitting(false)
    }
  }, [activeRepo, changeCount])

  // persist — always lands the write (see persistChats) so deletions stick.
  // The heavy serialize+write is DEBOUNCED: during streaming `chats` updates every
  // animation frame, and persisting each frame meant a full JSON.stringify of the
  // whole transcript + a server push per frame (jank + write amplification). A
  // trailing write ~450ms after the last change captures the settled state; the
  // tab-close/unmount flush below guarantees nothing in-flight is lost.
  useEffect(() => {
    chatsRef.current = chats
    // Checkpoint ongoing streams too: a trailing debounce never fires while
    // tokens keep arriving, leaving a long-running reply entirely unsaved.
    if (!persistTimerRef.current) persistTimerRef.current = setTimeout(() => { persistTimerRef.current = null; persistChats(chatsRef.current, sessionToken) }, streaming ? 2000 : 150)
  }, [chats, streaming])
  useEffect(() => {
    // Land the latest chats immediately when the tab is hidden/closed or the panel
    // unmounts — so a close mid-stream (or right after an edit) never loses the
    // last change waiting on the debounce.
    const flushNow = () => {
      if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null }
      // Skip when signed out: sign-out clears localStorage, and this cleanup can
      // run AFTER that during unmount — writing the chats back would resurrect the
      // previous user's history. sessionWasCleared() flips synchronously in
      // clearLocal(), before the component's cleanup runs.
      if (sessionWasCleared()) return
      try { persistChats(chatsRef.current, sessionToken) } catch { /* best-effort */ }
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flushNow() }
    window.addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('pagehide', flushNow)
      document.removeEventListener('visibilitychange', onVis)
      flushNow()
    }
  }, [])
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId)
    setPendingIds([]) // a different chat → no carried-over prompt chips
  }, [activeId])
  // Remember the current view so a refresh returns to your last touch point.
  useEffect(() => { if (view !== 'settings') localStorage.setItem('nalu-view', view) }, [view])
  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model)
  }, [model])
  // Seed the Nalu house brand once, so docs/decks/sheets/designs are premium by
  // default and the Brand bar is always there to edit.
  useEffect(() => {
    ensureDefaultBrand()
  }, [])

  const active = useMemo(() => chats.find((c) => c.id === activeId) || null, [chats, activeId])
  const messages = active?.messages ?? []

  // Artifacts Nalu BUILT in this chat (docs / decks / sheets / designs / …),
  // shown in the left drawer alongside uploaded attachments + notes. `mi` is the
  // message index so clicking scrolls to the artifact (where its download buttons live).
  const builtArtifacts = useMemo(() => {
    const out: { kind: string; label: string; mi: number }[] = []
    ;(active?.messages ?? []).forEach((m, i) => {
      if (m.doc) out.push({ kind: 'doc', label: m.doc.title || 'Word document', mi: i })
      if (m.deck) out.push({ kind: 'deck', label: m.deck.title || 'Presentation', mi: i })
      if (m.sheet) out.push({ kind: 'sheet', label: m.sheet.title || 'Spreadsheet', mi: i })
      if (m.design) out.push({ kind: 'design', label: m.design.kind === 'brand' ? 'Brand book' : m.design.kind, mi: i })
      if (m.cad) out.push({ kind: 'cad', label: 'CAD model', mi: i })
      if (m.video) out.push({ kind: 'video', label: movieIdFromUrl(m.video) ? 'Movie' : 'Video', mi: i })
      // Generated IMAGES aren't a structured field — Nalu embeds them as markdown
      // data-URL images in the assistant's text (![alt](data:image/…); api/image always
      // returns a base64 data URL). List EACH one (data-URL only, so a linked web image
      // in a normal answer isn't mislabeled a generated file).
      if (m.role === 'assistant' && typeof m.content === 'string') {
        const re = /!\[([^\]]*)\]\(data:image\//gi
        let mm: RegExpExecArray | null
        while ((mm = re.exec(m.content))) out.push({ kind: 'image', label: (mm[1] || '').trim().slice(0, 40) || 'Image', mi: i })
      }
    })
    return out
  }, [active])

  // Everything Nalu has built across ALL chats — the Studio gallery previews it.
  const creations = useMemo(() => {
    const out: Creation[] = []
    chats.forEach((c) =>
      c.messages.forEach((m, mi) => {
        const base = { key: `${c.id}:${mi}`, chatId: c.id, mi, ...(reviewLayout ? { previewData: m } : {}) }
        if (m.design) {
          const d = m.design as { kind: string; html?: string; name?: string; motion?: Creation['motion'] }
          out.push({ ...base, kind: d.kind, title: d.name || c.title || d.kind, html: typeof d.html === 'string' ? d.html : undefined, motion: d.motion })
        } else if (m.deck) out.push({ ...base, kind: 'deck', title: m.deck.title || c.title || 'Presentation' })
        else if (m.sheet) out.push({ ...base, kind: 'sheet', title: m.sheet.title || c.title || 'Spreadsheet' })
        else if (m.doc) out.push({ ...base, kind: 'doc', title: m.doc.title || c.title || 'Document' })
        else if (m.video) out.push({ ...base, kind: movieIdFromUrl(m.video) ? 'movie' : 'video', title: c.title || 'Video' })
        else if (m.cad) out.push({ ...base, kind: 'cad', title: c.title || 'CAD model' })
        else if (m.role === 'assistant' && typeof m.content === 'string') {
          // Generated images live as markdown in the message text.
          const im = m.content.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
          if (im) out.push({ ...base, kind: 'image', title: c.title || 'Image', img: im[1] })
        }
      }),
    )
    return out.reverse()
  }, [chats, reviewLayout])

  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const scrollToMsg = useCallback((mi: number) => {
    msgRefs.current[mi]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])
  // Open a Studio creation in its chat (switch chat + view, then scroll to it).
  const openCreation = useCallback((chatId: string, mi: number) => {
    setActiveId(chatId)
    openSpace('chat')
    setTimeout(() => scrollToMsg(mi), 140)
  }, [scrollToMsg, openSpace])
  const deleteMessage = useCallback(
    (mi: number) => {
      if (!activeId) return
      setChats((cs) =>
        cs.map((c) => (c.id === activeId ? { ...c, messages: c.messages.filter((_, i) => i !== mi) } : c)),
      )
    },
    [activeId],
  )

  // Follow the answer as it streams in (depends on the LAST message's length, so it
  // fires on every token flush — not just when a new message is added). Instant
  // during streaming so it never lags the text; smooth for discrete jumps. Only when
  // pinned to the bottom, so you're never dragged away from history you scrolled up to.
  const lastMsgLen = messages.length ? (typeof messages[messages.length - 1]?.content === 'string' ? (messages[messages.length - 1].content as string).length : 0) : 0
  useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' })
  }, [messages.length, lastMsgLen, streaming])
  // A brand-new answer starts pinned so it follows from the first token.
  useEffect(() => { if (streaming) pinnedRef.current = true }, [streaming])
  // Switching chats lands you at the BOTTOM of the newly-opened conversation and
  // re-pins — otherwise the scroll container keeps the previous chat's offset, so
  // you'd open a chat mid-scroll (or above its latest messages).
  useEffect(() => {
    pinnedRef.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeId, reviewChatOpen, view])

  const newChat = useCallback(() => {
    // Do NOT abort in-flight work — a video/doc generation keeps running in the
    // background and lands in ITS chat even after you move on.
    setStreaming(false)
    setActiveId(null)
    setInput('')
    if (!reviewChatOpenRef.current) setView('chat')
    requestAnimationFrame(() => taRef.current?.focus())
  }, [])

  const deleteChat = useCallback((id: string) => {
    addTombstone(DELETED_CHATS_KEY, id) // permanent — survives re-sync from any device
    setChats((cs) => cs.filter((c) => c.id !== id))
    setActiveId((cur) => (cur === id ? null : cur))
  }, [])

  const [renamingChat, setRenamingChat] = useState<{ id: string; title: string } | null>(null)
  const startRename = (chat: Chat) => {
    setRenamingChat({ id: chat.id, title: chat.title })
    setSidebarOpen(true)
    setChatsExpanded(true)
    setQuery('')
  }
  const saveChatName = () => {
    const title = renamingChat?.title.trim().slice(0, 120)
    if (!renamingChat || !title) return
    const next = chatsRef.current.map(chat => chat.id === renamingChat.id ? { ...chat, title, titleUpdatedAt: Math.max(Date.now(), (chat.titleUpdatedAt || 0) + 1) } : chat)
    chatsRef.current = next
    setChats(next)
    persistChats(next, sessionToken)
    setRenamingChat(null)
  }

  // ---- Attachments + Notes (per chat, referenced by the AI) ----------------
  const [attaching, setAttaching] = useState(false)
  // Attachments just added but not yet sent — these show as chips in the prompt.
  // After sending they clear from the prompt but stay saved (drawer + AI context).
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const pendingIdsRef = useRef<string[]>([])
  const [attachmentError, setAttachmentError] = useState('')

  // Ensure there's an active chat to hang attachments/notes on; returns its id.
  const ensureChat = useCallback((): string => {
    if (activeId && chats.some((c) => c.id === activeId)) return activeId
    const id = uid()
    const next = [{ id, title: 'New chat', messages: [], createdAt: Date.now() }, ...chatsRef.current]
    chatsRef.current = next; setChats(next)
    setActiveId(id)
    if (!reviewChatOpenRef.current) setView('chat')
    return id
  }, [activeId, chats])

  const addAttachments = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (!list.length) return
      const id = ensureChat()
      setAttaching(true)
      // Record the in-flight extraction so send() can WAIT for it — otherwise a
      // question sent before a slow PDF finishes parsing would miss the file.
      setAttachmentError('')
      const previousJob = attachPromiseRef.current
      const work = (async () => {
        await previousJob
        const extracted: Attachment[] = []
        for (const file of list) {
          if (localStorage.getItem('nalu-token') !== sessionToken) return
          extracted.push(await extractAttachment(file))
        }
        if (localStorage.getItem('nalu-token') !== sessionToken) return
        const unread = extracted.filter(a => ['unsupported', 'failed', 'needs-ocr'].includes(a.extraction?.status || ''))
        if (unread.length) setAttachmentError(unread.map(a => `${a.name}: ${attachmentExtractionSummary(a)}`).join(' · '))
        const next = chatsRef.current.map(c => c.id === id ? { ...c, attachments: [...(c.attachments || []), ...extracted] } : c)
        chatsRef.current = next; setChats(next)
        pendingIdsRef.current = [...pendingIdsRef.current, ...extracted.map(a => a.id)]
        setPendingIds(pendingIdsRef.current)
        // Keep local image bytes if upload fails; never silently drop an image.
        for (const attachment of extracted) {
          try {
            const saved = await saveChatAttachment(attachment, id, sessionToken || '')
            if (localStorage.getItem('nalu-token') !== sessionToken) return
            const updated = chatsRef.current.map(c => c.id === id ? { ...c, attachments: c.attachments?.map(a => a.id === saved.id ? saved : a) } : c)
            chatsRef.current = updated; setChats(updated)
          } catch { setAttachmentError('An image is saved on this device but could not sync to your account yet. Nalu will retry when you send.') }
        }
      })()
      const job = Promise.all([previousJob, work]).then(() => {}).catch(() => { setAttachmentError('A file could not be read. Please attach it again.') }).finally(() => { if (attachPromiseRef.current === job) setAttaching(false) })
      attachPromiseRef.current = job
      await job
      if (attachPromiseRef.current === job) attachPromiseRef.current = null
    },
    [ensureChat, sessionToken],
  )

  const removeAttachment = useCallback(
    (attId: string) => {
      if (!activeId) return
      setChats((cs) =>
        cs.map((c) =>
          c.id === activeId ? { ...c, attachments: (c.attachments || []).filter((a) => a.id !== attId) } : c,
        ),
      )
    },
    [activeId],
  )

  const updateNotes = useCallback(
    (notes: string) => {
      const id = ensureChat()
      setChats((cs) => cs.map((c) => (c.id === id ? { ...c, notes } : c)))
    },
    [ensureChat],
  )

  const send = useCallback(
    async (text: string, opts?: { keepView?: boolean; userMessageId?: string; assistantMessageId?: string; studioKind?: string; studioTarget?: Creation; movieSeconds?: number; attachments?: Attachment[] }) => {
      const content = text.trim()
      if (!content || streaming) return
      // A floating conversation keeps its original space, including after async attachment work.
      const keepCurrentView = opts?.keepView || reviewChatOpenRef.current
      // Per-target re-entry guard (see sendingChatsRef): block a second fire into
      // the same chat while its turn is still starting/streaming, but allow a
      // deliberate send into a different chat (background builds keep running).
      const targetChatId = opts?.studioTarget?.chatId ?? activeId
      const guardKey = targetChatId ?? '__new__'
      if (sendingChatsRef.current.has(guardKey)) return
      sendingChatsRef.current.add(guardKey)
      // If the user ×'d out of the intent chip for this exact prompt, skip every
      // studio/artifact route and answer in plain chat instead.
      const explicitCancel = /^(?:cancel|never mind|nevermind|forget (?:it|that))\b/i.test(content)
      const plain = (dismissedIntent !== null && dismissedIntent === content) || explicitCancel
      // If the last turn paused to ask clarifying questions, THIS message is the
      // answer — resume that build (consume the pending state so it fires once).
      const savedQuestion = activeId ? chatsRef.current.find(c => c.id === activeId)?.messages.slice(-1)[0]?.clarify : undefined
      const savedBuild = savedQuestion && !savedQuestion.answered && savedQuestion.build ? { ...savedQuestion.build, questions: savedQuestion.questions } : null
      const changedTopic = explicitCancel || /^(?:instead|new (?:question|topic))\b/i.test(content)
      const resuming = !plain && !opts?.studioKind && !changedTopic && activeId ? pendingBuildRef.current.get(activeId) ?? savedBuild : null
      if (activeId) pendingBuildRef.current.delete(activeId)
      setInput('')
      setDismissedIntent(null)

      // Resolve the target chat id + full history SYNCHRONOUSLY from current
      // state — never from inside the setChats updater (which React runs
      // later), so the page switches to the conversation immediately instead
      // of leaving you on the home screen having to click into the chat.
      lastSentPromptRef.current = content
      const chatId = targetChatId ?? uid()
      if (reviewLayout) setReviewActiveChats(ids => ids.includes(chatId) ? ids : [...ids, chatId])
      const finishReviewActivity = () => { if (reviewLayout) setReviewActiveChats(ids => ids.filter(id => id !== chatId)) }
      // Read history from the always-current ref (not the closure `chats`), so a
      // programmatic caller like regenerate() — which slices the chat then calls
      // send() in the same tick — builds on the freshest message list.
      const existing = (chatsRef.current.find((c) => c.id === chatId)) || chats.find((c) => c.id === chatId)
      const assistantMessageId = opts?.assistantMessageId || uid()
      if (opts?.keepView) setStudioTurn({ chatId, messageId: assistantMessageId })
      const history: Msg[] = [...(existing?.messages ?? []).map(m => m.clarify && !m.clarify.answered ? { ...m, updatedAt: Date.now(), clarify: { ...m.clarify, answered: true } } : m), { id: opts?.userMessageId || uid(), updatedAt: Date.now(), role: 'user', content }]

      // Commit the user's request before attachments or any network operation.
      // A refresh immediately after Send must not lose the new conversation.
      const checkpoint: Chat = { ...(existing || { id: chatId, title: content.length > 40 ? content.slice(0, 40) + '…' : content, createdAt: Date.now() }), messages: [...history, { id: assistantMessageId, updatedAt: Date.now(), role: 'assistant', content: '' }] }
      const checkpointChats = [checkpoint, ...chatsRef.current.filter(c => c.id !== chatId)]
      chatsRef.current = checkpointChats; setChats(checkpointChats)
      persistChats(checkpointChats, sessionToken)
      setActiveId(chatId)
      if (!keepCurrentView) setView('chat')
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setStreaming(true)

      // If a document is still being read (e.g. a slow PDF), WAIT for it so the
      // AI never misses an attachment the user just added.
      if (attachPromiseRef.current) {
        try {
          await attachPromiseRef.current
        } catch {
          /* ignore */
        }
      }
      // Notes + attached documents for THIS chat (read from the freshest state,
      // post-await), so the AI references them in EVERY path — a text answer or a
      // generated doc/sheet/deck/design/CAD.
      if (ctrl.signal.aborted) { sendingChatsRef.current.delete(guardKey); finishReviewActivity(); return }
      const ctxChat = chatsRef.current.find((c) => c.id === chatId) || existing
      const sentAttachments = opts?.attachments || (ctxChat?.attachments || []).filter(a => pendingIdsRef.current.includes(a.id))
      if (sentAttachments.length) history[history.length - 1].attachments = sentAttachments
      const sentIds = new Set(sentAttachments.map(a => a.id))
      pendingIdsRef.current = pendingIdsRef.current.filter(id => !sentIds.has(id)); setPendingIds(pendingIdsRef.current)
      // Images attached to this chat (downscaled on import) — fed to the vision
      // model AND embeddable into generated docs.
      const imageAtts: Attachment[] = []
      let imageLoadError = ''
      for (const attachment of (ctxChat?.attachments || []).filter(a => a.isImage)) {
        try {
          const dataUrl = await loadChatAttachment(attachment, sessionToken || '')
          if (!dataUrl) throw new Error(`The original image “${attachment.name}” is unavailable. Please attach it again.`)
          let restored = { ...attachment, dataUrl }
          try { restored = { ...restored, ...await saveChatAttachment(restored, chatId, sessionToken || '') } } catch { /* inline bytes remain in the chat until sync succeeds */ }
          imageAtts.push(restored)
        } catch (error) { imageLoadError = error instanceof Error ? error.message : 'An attached image could not load. Please retry.' }
      }
      if (ctrl.signal.aborted || localStorage.getItem('nalu-token') !== sessionToken) { sendingChatsRef.current.delete(guardKey); finishReviewActivity(); return }
      if (imageAtts.length) {
        if (imageAtts.every(a => a.storage)) setAttachmentError('')
        const restored = new Map(imageAtts.map(a => [a.id, a]))
        if (history[history.length - 1].attachments) history[history.length - 1].attachments = history[history.length - 1].attachments?.map(a => restored.get(a.id) || a)
        const next = chatsRef.current.map(c => c.id === chatId ? { ...c, attachments: c.attachments?.map(a => restored.get(a.id) || a) } : c)
        chatsRef.current = next; setChats(next)
      }
      const ctxParts: string[] = []
      if (ctxChat?.notes && ctxChat.notes.trim())
        ctxParts.push(`## Notes (kept by the user for you to reference)\n${ctxChat.notes.trim()}`)
      for (const a of ctxChat?.attachments || []) {
        if (a.isImage) {
          // The image itself is sent to the vision model as an image part below;
          // here just name it so text-only paths (doc/sheet) know it exists.
          ctxParts.push(`## Attached image: ${a.name}`)
        } else {
          ctxParts.push(attachmentContext(a))
        }
      }
      const ctxBlock = ctxParts.length
        ? `\n\n---\n[Attached context for this request — use it; don't repeat it verbatim.]\n\n${ctxParts.join('\n\n---\n\n')}`
        : ''
      // For artifact generators (doc/sheet/slides/design/cad) we fold the context
      // into the prompt; the chat path injects it as a separate message below.
      // When RESUMING after clarifying questions, prepend the ORIGINAL request so
      // the generator builds from both the original ask and the user's answers.
      const buildPreamble = resuming
        ? `ORIGINAL REQUEST: ${resuming.prompt}\n\nQuestions asked: ${resuming.questions?.map(q => q.q).join("; ") || "See the conversation"}\n\nThe user has now answered below — use BOTH the original request and these answers:\n\n`
        : ''
      const logoAnswers = resuming ? (resuming.questions || []).reduce((answer, question) => answer.split(question.q).join(''), content).trim() : ''
      const withCtx = (prompt: string) => buildPreamble + (ctxBlock ? prompt + ctxBlock : prompt)
      const writingBrief = { messages: history.map(m => ({ role: m.role, content: m.content })), material: ctxParts.join('\n\n'), memory: buildChatMemory(history) }
      const writingPrompt = buildPreamble + content

      // Two agents on one artifact: run the matching domain specialist first
      // (via forced routing) and hand its expert brief to the artifact engine.
      // Best-effort — a boost failure never blocks the build.
      const runBoost = async (artifactName: string): Promise<string> => {
        const experts = plain ? [] : boostsFor(content)
        if (!experts.length) return ''
        setRouteName(`${experts.map((e) => e.label).join(' + ')} × ${artifactName}`)
        // every matching expert drafts their lane (in parallel), all briefs feed the engine
        const briefs = await Promise.all(
          experts.map(async (b) => {
            let expert = ''
            try {
              await streamChat(
                [{ role: 'user', content: BOOST_BRIEF(withCtx(content)) + (experts.length > 1 ? `\n\n(Contribute ONLY your ${b.label} specialty — another expert covers the rest.)` : '') }],
                model,
                { signal: ctrl.signal, onDelta: (t) => { expert += t } },
                undefined,
                undefined,
                undefined,
                b.kind,
              )
            } catch {
              /* boost is optional — the artifact still builds from the raw ask */
            }
            return expert.trim()
              ? `\n\n--- EXPERT BRIEF from ${b.label} (substantive backbone — keep its numbers, plans and tables) ---\n${expert.trim().slice(0, 9000)}`
              : ''
          }),
        )
        return briefs.join('')
      }

      setChats((cs) => {
        let next = cs
        if (!cs.some((c) => c.id === chatId)) {
          const title = content.length > 40 ? content.slice(0, 40) + '…' : content
          next = [{ id: chatId, title, messages: [], createdAt: Date.now() }, ...cs]
        }
        return next.map((c) =>
          c.id === chatId
            ? { ...c, messages: [...history, { id: assistantMessageId, updatedAt: Date.now(), role: 'assistant', content: '' }] }
            : c,
        )
      })
      setActiveId(chatId)
      // Generating from the Studio keeps you IN the Studio (the result previews
      // there); every other path jumps to the chat where the reply streams.
      if (!keepCurrentView) setView('chat')

      const wire: WireMessage[] = history.map((m) => ({ role: m.role, content: m.clarify ? `${m.content}\n${m.clarify.questions.map(q => q.q + (q.options.length ? ' (' + q.options.join('; ') + ')' : '')).join('\n')}` : m.content }))
      // Enter "streaming" NOW — before the intent/clarify preflight round-trips — so
      // the composer shows Stop and the reply bubble shows the breathing indicator
      // during that 1-3s window (instead of a blank, un-stoppable pause).
      setStreaming(true)

      // Resolve once. The selected Studio tool is explicit; free-form chat uses
      // the whole request and current chat's artifact context. No later keyword
      // matcher can overrule this decision, including a decision to stay in chat.
      const intentContext = (existing?.messages || []).slice(-6).map(m => ({
        role: m.role, text: typeof m.content === 'string' ? m.content.slice(0, 1800) : '',
        artifacts: [m.doc && 'document', m.sheet && 'spreadsheet', m.deck && 'slides', m.cad && 'cad', m.video && 'video', m.email && 'email', m.design?.kind].map(normalizeStudioKind).filter(Boolean),
      }))
      const recentKind = intentContext.slice().reverse().find(m => m.artifacts.length)?.artifacts[0]
      const selectedKind = normalizeStudioKind(opts?.studioKind === 'movie' || /^\/movie\b/i.test(content) ? 'video' : opts?.studioKind)
      let intent: StudioIntent = plain
        ? { kind: 'chat', mode: 'chat', additionalKinds: [] }
        : selectedKind
          ? { kind: selectedKind, mode: opts?.studioTarget ? 'edit' : 'create', additionalKinds: [], source: 'selection' }
          : fallbackStudioIntent(content, recentKind)
      if (!plain && !selectedKind && !resuming && shouldClassifyStudio(content, recentKind)) {
        try {
          const cr = await fetch('/api/web', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'intent', prompt: content, hasImage: imageAtts.length > 0, hasPrev: recentKind, context: intentContext }),
            signal: ctrl.signal,
          })
          const classified = cr.ok ? parseStudioIntent(await cr.json().catch(() => null)) : null
          if (classified) intent = classified
        } catch { /* Keep the conservative single-route fallback. */ }
      }
      if (resuming) intent = parseStudioIntent(resuming) || intent
      const forcedKind = intent.kind
      // Ask based on the whole brief and conversation, and preserve the pending
      // request on the message so answering still works after a reload.
      const useDefaults = /\b(go ahead|best judg(?:ment|ement)|you (?:choose|decide)|no questions|don.t ask)\b/i.test(content)
      const bk: string | null = !plain && forcedKind !== 'chat' && !resuming && !opts?.studioTarget ? forcedKind : null
      if (bk && !useDefaults) {
        try {
          const clr = await fetch('/api/web', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clarify', prompt: buildPreamble + content, kind: bk, context: (existing?.messages.length ? JSON.stringify(existing.messages.slice(-8).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '' }))) : '') + ctxBlock }),
            signal: ctrl.signal,
          })
          const cj = (await clr.json().catch(() => ({}))) as { questions?: (string | ClarifyQ)[] }
          // Normalize to the structured MCQ shape (tolerate a bare-string question).
          const qs: ClarifyQ[] = Array.isArray(cj.questions)
            ? cj.questions.map((q) => (typeof q === 'string' ? { q, options: [] } : q))
                .filter((q) => q && typeof q.q === 'string' && q.q.trim())
                .map((q) => ({ q: q.q.trim(), options: Array.isArray(q.options) ? q.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 4) : [], multi: !!q.multi }))
                .slice(0, 3)
            : []
          if (qs.length) {
            pendingBuildRef.current.set(chatId, { kind: bk, prompt: buildPreamble + content, questions: qs, mode: intent.mode, additionalKinds: intent.additionalKinds })
            const intro = qs.length === 1 ? 'One detail will help me build the right thing:' : 'A few details will help me build the right thing:'
            setChats((cs) =>
              cs.map((c) =>
                c.id === chatId ? { ...c, messages: c.messages.map((m, i) => (m.id === assistantMessageId ? { ...m, updatedAt: Date.now(), role: 'assistant', content: intro, clarify: { questions: qs, build: { kind: bk, prompt: buildPreamble + content, mode: intent.mode, additionalKinds: intent.additionalKinds } } } : m)) } : c,
              ),
            )
            abortRef.current = null
            setStreaming(false) // this turn is done — it asked, now it waits
            sendingChatsRef.current.delete(guardKey)
            finishReviewActivity()
            return
          }
        } catch {
          /* clarify is optional — never block a build on it */
        }
      }
      // Translate the classifier's decision into the branch predicates. When the
      // classifier fired, EXACTLY one route is true and the rest are forced off.
      const wantK = (k: string): boolean => forcedKind === k
      // (streaming was already turned on above, before the preflight round-trips)

      let acc = ''
      let accReasoning = ''
      let accSheet: SheetDoc | undefined
      let accDoc: DocDoc | undefined
      let accEmail: EmailDoc | undefined
      let accVideo: string | undefined
      let accCad: string | undefined
      let accDesign: DesignArtifact | undefined
      let accDeck: Deck | undefined
      let accLoading: 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides' | 'email' | undefined
      // Smooth typewriter reveal for STREAMING TEXT: `acc` holds all received
      // text; `shown` eases up toward acc.length a few percent per frame, so the
      // display is decoupled from bursty network chunks and text flows in
      // smoothly + quickly instead of jumping in blocks.
      let shown = 0
      let revealRaf = 0
      const renderMsg = (content: string) =>
        setChats((cs) =>
          cs.map((c) => {
            if (c.id !== chatId) return c
            const msgs = c.messages.slice()
            const messageIndex = msgs.findIndex(m => m.id === assistantMessageId)
            if (messageIndex < 0) return c
            msgs[messageIndex] = {
              id: assistantMessageId,
              updatedAt: Date.now(),
              role: 'assistant',
              content,
              reasoning: accReasoning || undefined,
              sheet: accSheet,
              doc: accDoc,
              email: accEmail,
              video: accVideo,
              cad: accCad,
              design: accDesign,
              deck: accDeck,
              loading: accLoading,
            }
            return { ...c, messages: msgs }
          }),
        )
      // flush() shows the FULL text — used by the non-streaming card paths and as
      // the final render; it also stops any in-flight reveal so nothing is left
      // half-typed.
      const flush = () => {
        shown = acc.length
        if (revealRaf) { cancelAnimationFrame(revealRaf); revealRaf = 0 }
        renderMsg(acc)
      }
      const reveal = () => {
        const gap = acc.length - shown
        // Small, steady steps → smooth typing. Reveal ~16% of the buffer per frame
        // (min 2 chars), with a higher floor when far behind so it never lags.
        if (gap > 0) {
          const step = gap > 220 ? Math.ceil(gap * 0.5) : Math.max(2, Math.ceil(gap * 0.16))
          shown = Math.min(acc.length, shown + step)
        }
        renderMsg(shown >= acc.length ? acc : acc.slice(0, shown))
        revealRaf = shown < acc.length ? requestAnimationFrame(reveal) : 0
      }
      const scheduleFlush = () => {
        // Streaming OFF → don't reveal progressively; the final flush() shows the
        // whole answer at once.
        if (!getModelSettings().streaming) return
        if (!revealRaf) revealRaf = requestAnimationFrame(reveal)
      }

      // SAFETY NET: everything below routes to a build/agent path that can throw
      // (a network drop mid-stream, a tool executor, a parse). Without this guard
      // a single uncaught throw would skip the setStreaming(false) at the bottom —
      // leaving the spinner spinning forever and soft-locking the chat (send()
      // early-returns while `streaming`). The finally ALWAYS clears streaming.
      try {

      // Stopped DURING the intent/clarify preflight (Stop is now reachable there):
      // the abort already fired, so bail cleanly before entering any build path —
      // otherwise the artifact fetch would reject with AbortError and its catch
      // would render a spurious "⚠️ … failed" bubble. The finally unwinds state.
      if (ctrl.signal.aborted) return

      // Photo → executive breakdown board: real vision analysis of the attached
      // photo(s), then a premium presentation board built from that analysis,
      // with the actual photo embedded via {{PHOTO_n}} placeholders.
      if (!plain && imageAtts.length > 0 && wantK('board')) {
        setRouteName('Nalu Studio')
        accLoading = 'design'
        flush()
        try {
          // 1) The vision model reads the photo — exhaustive structured analysis.
          let analysis = ''
          await streamChat(
            [
              {
                role: 'user',
                content: [
                  { type: 'text', text: `${BREAKDOWN_VISION_PROMPT}\n\nThe user's own request (honor any specific focus): ${content}` },
                  ...imageAtts.map((a) => ({ type: 'image_url' as const, image_url: { url: a.dataUrl as string } })),
                ],
              },
            ],
            model,
            { onDelta: (t) => { analysis += t }, signal: ctrl.signal },
          )
          // 2) The design engine turns the analysis into the executive board.
          const r = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content), kind: 'board', analysis: analysis.trim(), brand: getBrand() || undefined }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { html?: string; name?: string; error?: string }
          accLoading = undefined
          if (r.ok && data.html) {
            // 3) Substitute the real photo(s) into the board.
            let boardHtml = data.html
            imageAtts.forEach((a, i) => { boardHtml = boardHtml.split(`{{PHOTO_${i}}}`).join(a.dataUrl as string) })
            boardHtml = boardHtml.replace(/\{\{PHOTO_\d+\}\}/g, imageAtts[0].dataUrl as string)
            accDesign = { kind: 'board', html: boardHtml, name: data.name || 'Breakdown Board' }
            acc = ''
          } else {
            acc = `⚠️ ${data.error || `Board error ${r.status}`}`
          }
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Board request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Document: build a designed Word/PDF document (business plan, report, …).
      // ---- STUDIO MEMORY — persistent, chat-derived. The last artifact of each
      // kind lives in the saved chat (synced across devices); an edit-ish
      // follow-up revises IT rather than regenerating from scratch. ----------
      const lastArts = (() => {
        const msgs = opts?.studioTarget ? (ctxChat?.messages || []).slice(0, opts.studioTarget.mi + 1) : ctxChat?.messages || []
        const out: { email?: EmailDoc; doc?: DocDoc; sheet?: SheetDoc; deck?: Deck; cad?: string; designs: Record<string, DesignArtifact>; recent?: { type: string; kind?: string } } = { designs: {} }
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m.email && !out.email) { out.email = m.email; out.recent ||= { type: 'email' } }
          if (m.doc && !out.doc) { out.doc = m.doc; out.recent ||= { type: 'doc' } }
          if (m.sheet && !out.sheet) { out.sheet = m.sheet; out.recent ||= { type: 'sheet' } }
          if (m.deck && !out.deck) { out.deck = m.deck; out.recent ||= { type: 'deck' } }
          if (m.cad && !out.cad) { out.cad = m.cad; out.recent ||= { type: 'cad' } }
          const d = m.design as (DesignArtifact & { kind?: string }) | undefined
          if (d?.kind && !out.designs[d.kind]) { out.designs[d.kind] = d as DesignArtifact; out.recent ||= { type: 'design', kind: d.kind } }
        }
        return out
      })()
      const editTarget = (() => {
        if (plain || intent.mode !== 'edit' || forcedKind === 'chat') return null
        const target = forcedKind === 'document' || forcedKind === 'book' ? { type: 'doc' }
          : forcedKind === 'spreadsheet' ? { type: 'sheet' }
          : forcedKind === 'slides' ? { type: 'deck' }
          : forcedKind === 'cad' ? { type: 'cad' }
          : forcedKind === 'email' ? { type: 'email' }
          : { type: 'design', kind: forcedKind === 'website' ? 'webpage' : forcedKind }
        const exists = target.type === 'email' ? lastArts.email : target.type === 'doc' ? lastArts.doc : target.type === 'sheet' ? lastArts.sheet : target.type === 'deck' ? lastArts.deck : target.type === 'cad' ? lastArts.cad : target.kind && lastArts.designs[target.kind]
        return exists ? target : null
      })()

      // doc / sheet / deck follow-up edits → revise-in-place via prev payloads
      if (editTarget?.type === 'doc' && lastArts.doc) {
        setRouteName('Nalu Docs — editing')
        accLoading = 'doc'
        flush()
        try {
          const r = await fetch('/api/doc', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...writingBrief, prompt: writingPrompt, prevDoc: JSON.stringify(lastArts.doc), images: [] }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as DocDoc & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.blocks) && data.blocks.length) { accDoc = normalizeDoc(data); acc = '' }
          else acc = `⚠️ ${data.error || `Edit failed ${r.status}`}`
        } catch (e) { accLoading = undefined; if (!ctrl.signal.aborted) acc = `⚠️ ${e instanceof Error ? e.message : 'Edit failed'}` }
        flush(); setStreaming(false); setRouteName('Nalu'); abortRef.current = null
        return
      }
      if (editTarget?.type === 'sheet' && lastArts.sheet) {
        setRouteName('Nalu Sheets — editing')
        accLoading = 'sheet'
        flush()
        try {
          const r = await fetch('/api/sheet', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content), prevSheet: JSON.stringify(lastArts.sheet).slice(0, 90000) }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as SheetDoc & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.sheets) && data.sheets.length) { accSheet = cleanSheet(data); acc = '' }
          else acc = `⚠️ ${data.error || `Edit failed ${r.status}`}`
        } catch (e) { accLoading = undefined; if (!ctrl.signal.aborted) acc = `⚠️ ${e instanceof Error ? e.message : 'Edit failed'}` }
        flush(); setStreaming(false); setRouteName('Nalu'); abortRef.current = null
        return
      }
      if (editTarget?.type === 'deck' && lastArts.deck) {
        setRouteName('Nalu Slides — editing')
        accLoading = 'slides'
        flush()
        try {
          const r = await fetch('/api/slides', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content), prevDeck: JSON.stringify(lastArts.deck).slice(0, 90000) }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as Deck & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.slides) && data.slides.length) { accDeck = cleanDeck(data); acc = '' }
          else acc = `⚠️ ${data.error || `Edit failed ${r.status}`}`
        } catch (e) { accLoading = undefined; if (!ctrl.signal.aborted) acc = `⚠️ ${e instanceof Error ? e.message : 'Edit failed'}` }
        flush(); setStreaming(false); setRouteName('Nalu'); abortRef.current = null
        return
      }

      // LONG-FORM: books / scientific articles / big legal documents — outline
      // first, then every chapter generated in turn and streamed into the doc
      // as it grows. No page cap; a failed chapter retries then is skipped.
      if (!plain && wantK('book')) {
        setRouteName('Nalu Docs — long form')
        accLoading = 'doc'
        flush()
        try {
          const or = await fetch('/api/doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...writingBrief, prompt: writingPrompt, mode: 'outline' }),
            signal: ctrl.signal,
          })
          const outline = (await or.json().catch(() => ({}))) as {
            title?: string; subtitle?: string; cover?: string; kind?: string
            design?: DocDoc['design']
            sources?: DocDoc['sources']; checkedAt?: string; researchStatus?: DocDoc['researchStatus']
            mediaPreference?: DocDoc['mediaPreference']
            chapters?: Array<{ heading?: string; brief?: string; targetWords?: number }>
            error?: string
          }
          if (!or.ok || !Array.isArray(outline.chapters) || !outline.chapters.length) {
            accLoading = undefined
            acc = `⚠️ ${outline.error || 'Could not plan the document.'}`
            flush(); setStreaming(false); abortRef.current = null
            return
          }
          const chapters = outline.chapters.slice(0, 48)
          accDoc = normalizeDoc({ title: outline.title, subtitle: outline.subtitle, cover: '', design: outline.design, mediaPreference: outline.mediaPreference, sources: outline.sources, checkedAt: outline.checkedAt, researchStatus: outline.researchStatus, blocks: [] })
          accLoading = undefined
          const summaries: string[] = []
          for (let ci = 0; ci < chapters.length; ci++) {
            if (ctrl.signal.aborted) break
            const ch = chapters[ci]
            setRouteName(`Nalu Docs — ${ci + 1}/${chapters.length}: ${String(ch.heading || '').slice(0, 40)}`)
            let blocks: DocBlock[] | null = null
            for (let attempt = 0; attempt < 2 && !blocks; attempt++) {
              try {
                const sr = await fetch('/api/doc', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ...writingBrief, prompt: writingPrompt, mode: 'section', docTitle: outline.title, docKind: outline.kind || 'report',
                    heading: ch.heading, brief: ch.brief, targetWords: ch.targetWords,
                    index: ci, total: chapters.length,
                    context: summaries.slice(-6).join('\n'),
                  }),
                  signal: ctrl.signal,
                })
                const sj = (await sr.json().catch(() => ({}))) as { blocks?: DocBlock[]; sources?: DocDoc['sources']; checkedAt?: string; researchStatus?: DocDoc['researchStatus'] }
                if (sr.ok && Array.isArray(sj.blocks) && sj.blocks.length) {
                  blocks = sj.blocks
                  const sources: Map<string, NonNullable<DocDoc['sources']>[number]> = new Map((accDoc?.sources || []).map(source => [source.url, source]))
                  for (const source of sj.sources || []) sources.set(source.url, source)
                  accDoc = { ...accDoc, sources: [...sources.values()], checkedAt: sj.checkedAt || accDoc?.checkedAt, researchStatus: sj.researchStatus === 'unverified' || accDoc?.researchStatus === 'unverified' ? 'unverified' : sources.size ? 'verified-sources' : sj.researchStatus }
                }
              } catch { /* retry once */ }
            }
            if (blocks) {
              accDoc = normalizeDoc({ ...accDoc, blocks: [...(accDoc.blocks || []), ...blocks] })
              const text = blocks.map((b) => ('text' in b && b.text) || '').join(' ')
              summaries.push(`Ch.${ci + 1} "${ch.heading}": ${text.slice(0, 260)}`)
            } else if (!ctrl.signal.aborted) {
              summaries.push(`Ch.${ci + 1} "${ch.heading}": (generation failed; not included)` )
              accDoc = { ...accDoc, incompleteSections: [...(accDoc?.incompleteSections || []), String(ch.heading || `Chapter ${ci + 1}`)] }
            }
            flush() // progressive: the document grows chapter by chapter on screen
          }
          acc = ''
        } catch (e) {
          accLoading = undefined
          if (!ctrl.signal.aborted) acc = `⚠️ ${e instanceof Error ? e.message : 'Long-form build failed'}`
        }
        flush()
        setStreaming(false)
        setRouteName('Nalu')
        abortRef.current = null
        return
      }

      if (!plain && wantK('email')) {
        setRouteName('Nalu Email')
        accLoading = 'email'
        flush()
        try {
          const r = await fetch('/api/email', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...writingBrief, prompt: writingPrompt, ...(editTarget?.type === 'email' && lastArts.email ? { prevEmail: lastArts.email } : {}) }), signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { to?: string; subject?: string; body?: string; error?: string }
          accLoading = undefined
          if (r.ok && (data.body || data.subject)) { accEmail = { to: data.to || '', subject: data.subject || 'Email', body: data.body || '' }; acc = '' }
          else acc = `⚠️ ${data.error || `Email error ${r.status}`}`
        } catch (e) { accLoading = undefined; if (!ctrl.signal.aborted) acc = `⚠️ ${e instanceof Error ? e.message : 'email failed'}` }
        flush(); setStreaming(false); abortRef.current = null
        return
      } else if (!plain && wantK('document')) {
        setRouteName('Nalu Docs')
        accLoading = 'doc'
        flush()
        try {
          // Two-agent build: the domain expert (e.g. Nalu Financial) drafts the
          // substance, then Nalu Docs designs the document from it.
          // Caption attached images (vision) so the text model can place them.
          const docImgs = imageAtts.length
            ? await Promise.all(
                imageAtts.map(async (a) => ({ src: a.dataUrl as string, caption: await captionImage(a.dataUrl as string, model, ctrl.signal) })),
              )
            : []
          const r = await fetch('/api/doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...writingBrief, prompt: writingPrompt, images: docImgs.map((im) => ({ caption: im.caption })) }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as DocDoc & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.blocks) && data.blocks.length) {
            const blocks = await embedDocImages(data.blocks, data.mediaPreference?.omitAttached ? [] : docImgs)
            accDoc = normalizeDoc({ ...data, cover: '', blocks })
            acc = ''
          } else {
            acc = `⚠️ ${data.error || `Document error ${r.status}`}`
          }
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Document request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Nalu Slides: AI builds a deck → inline preview + PowerPoint/PDF download.
      if (!plain && wantK('slides')) {
        setRouteName('Nalu Slides')
        accLoading = 'slides'
        flush()
        try {
          const boost = await runBoost('Nalu Slides')
          const r = await fetch('/api/slides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) + boost }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as Deck & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.slides) && data.slides.length) {
            accDeck = cleanDeck({ title: data.title, subtitle: data.subtitle, cover: data.cover, slides: data.slides, design: data.design })
            acc = ''
            // "…and a logo for it": routing collapses each message to ONE primary
            // kind (here 'slides'), so a co-requested logo was silently dropped.
            // Build it as its own artifact on the SAME message (deck + logo cards).
            if (intent.additionalKinds.includes('logo')) {
              accLoading = 'design'
              flush()
              try {
                const lr = await fetch('/api/design', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ prompt: withCtx(content), kind: 'logo', logoBrief: { request: resuming?.prompt || content, answers: logoAnswers }, brand: getBrand() || undefined }),
                  signal: ctrl.signal,
                })
                const ld = (await lr.json().catch(() => ({}))) as Record<string, unknown>
                if (lr.ok && ('lockup' in ld || 'mark' in ld || 'initials' in ld || 'html' in ld)) {
                  accDesign = normalizeArtifact('logo', ld)
                }
              } catch { /* logo is a bonus — the deck already succeeded */ }
              accLoading = undefined
            }
            // COMPANION PLAYBOOK: every PITCH deck also ships an "Investor Meeting
            // Playbook" doc (speaker script per slide, numbers to know, tough-Q&A,
            // objection handling, the close) so you can nail the meeting. Built from
            // the finished deck and shown on the SAME message (deck + doc cards).
            // On the ask-questions path the user's ANSWER ("go ahead") replaces the pitch
            // prompt, so also test the ORIGINAL request (resuming.prompt) — plus the built
            // deck — so the playbook never drops just because the answer had no pitch words.
            if ((PITCH_INTENT.test(content) || (resuming && PITCH_INTENT.test(resuming.prompt)) || deckLooksPitch(accDeck)) && !accDoc) {
              setRouteName('Nalu Slides + Playbook')
              accLoading = 'doc'
              flush()
              // The playbook SHIPS WITH every pitch deck — retry once so a transient miss
              // never drops it. A user Stop (AbortError) breaks out; only build misses retry.
              for (let attempt = 0; attempt < 2 && !accDoc; attempt++) {
                try {
                  const pr = await fetch('/api/doc', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: deckPlaybookPrompt(accDeck), images: [] }),
                    signal: ctrl.signal,
                  })
                  const pd = (await pr.json().catch(() => ({}))) as DocDoc & { error?: string }
                  if (pr.ok && Array.isArray(pd.blocks) && pd.blocks.length) { accDoc = normalizeDoc(pd); break }
                } catch (e) {
                  if (e instanceof DOMException && e.name === 'AbortError') break
                  /* transient — retry once more */
                }
              }
              accLoading = undefined
            }
          } else {
            acc = `⚠️ ${data.error || `Slides error ${r.status}`}`
          }
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Slides request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Nalu CAD: AI writes OpenSCAD → inline 3D model viewer (compiled in-browser).
      if (!plain && wantK('cad')) {
        setRouteName('Nalu CAD')
        accLoading = 'cad'
        flush()
        try {
          // Construction-grade exactness: for anything built (a bolt, a slab, a
          // whole building) Nalu Construction first writes the precise
          // dimensional spec, and the CAD engine models to it.
          let spec = ''
          if (/\b(bolt|screw|nut|washer|anchor|bracket|beam|column|joist|truss|stud|slab|footing|foundation|wall|house|building|shed|garage|barn|deck|stair|framing|frame|flange|plate|weld|rebar|roof)\w*\b/i.test(content)) {
            setRouteName('Nalu Construction × Nalu CAD')
            try {
              await streamChat(
                [{ role: 'user', content: `You are writing the EXACT dimensional spec for a 3D CAD model of: ${content}\n\nList every component with REAL-WORLD dimensions in millimetres (hardware sizes and head/thread geometry, member sizes, spacings, thicknesses, embed depths), counts, and how the parts fit together. Compact bullet spec only — no prose, no advice.` }],
                model,
                { signal: ctrl.signal, onDelta: (t) => { spec += t } },
                undefined, undefined, undefined,
                'construction',
              )
            } catch { /* spec is a boost — CAD still builds without it */ }
          }
          const r = await fetch('/api/cad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: withCtx(content) + (spec.trim() ? `\n\nEXACT SPEC from Nalu Construction — model these dimensions precisely:\n${spec.trim().slice(0, 6000)}` : ''),
              prevCode: intent.mode === 'edit' ? lastArts.cad || '' : '',
            }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { code?: string; error?: string }
          accLoading = undefined
          if (r.ok && data.code) {
            accCad = data.code
            acc = ''
          } else {
            acc = `⚠️ ${data.error || `CAD error ${r.status}`}`
          }
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'CAD request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Nalu Studio: AI produces the right editable artifact for the ask —
      // canvas (Figma-like) / palette / brand / blueprint / poster / webpage.
      // Follow-up website tweaks REVISE the existing page (prevHtml) instead of
      // regenerating from scratch, so users can converge on a design.
      // Keep the source and its checks together, bounded to the selected Studio
      // creation. A later board or website must not replace an older edit target.
      const lastWebArtifact = lastArts.designs.webpage as { html?: string; quality?: WebsiteQuality } | undefined
      const lastWebHtml = lastWebArtifact?.html || ''
      const DESIGN_KINDS = ['website', 'logo', 'palette', 'brand', 'blueprint', 'poster', 'canvas', 'shopping', 'motion', 'game', 'board', 'carousel']
      let studioKind: DesignKind | null = !plain && DESIGN_KINDS.includes(forcedKind)
        ? (forcedKind === 'website' ? 'webpage' : forcedKind as DesignKind) : null
      // Studio memory: a design-kind edit revises the LAST artifact of that kind
      const prevArt = editTarget?.type === 'design' && editTarget.kind ? lastArts.designs[editTarget.kind] : undefined
      if (prevArt && editTarget?.kind) studioKind = editTarget.kind as typeof studioKind
      const isWebEdit = !plain && forcedKind === 'website' && intent.mode === 'edit' && !!lastWebHtml
      if (isWebEdit) studioKind = 'webpage'
      if (studioKind) {
        setRouteName('Nalu Studio')
        accLoading = 'design'
        flush()
        // Reference image: if the user attached a picture with a logo/brand/palette
        // ask, READ it with vision and create the artifact in that same spirit
        // (its style, colors, symbol) — instead of ignoring it.
        let refAnalysis = ''
        if (imageAtts.length > 0 && (studioKind === 'logo' || studioKind === 'brand' || studioKind === 'palette' || studioKind === 'poster')) {
          try {
            await streamChat(
              [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: designReferenceBrief(imageAtts, buildPreamble + content, studioKind) },
                    ...imageAtts.flatMap((a, i) => [{ type: 'text' as const, text: `PHOTO_${i}: ${a.name}` }, { type: 'image_url' as const, image_url: { url: a.dataUrl as string } }]),
                  ],
                },
              ],
              model,
              { onDelta: (t) => { refAnalysis += t }, signal: ctrl.signal },
            )
          } catch { /* proceed without the reference */ }
        }
        try {
          if (imageLoadError) throw new Error(imageLoadError)
          if (studioKind === 'poster' && imageAtts.length && !refAnalysis.trim()) throw new Error('The reference images could not be read. Your files are saved; retry to use them in the design.')
          const designRequest = {
              prompt:
                (refAnalysis.trim()
                  ? `REFERENCE IMAGE the user attached — create the ${studioKind} in THIS SAME visual spirit (match its style, colors, and the form of its symbol/mark as described here):\n${refAnalysis.trim()}\n\n----\n\n`
                  : '') +
                withCtx(content) +
                (studioKind === 'poster' && imageAtts.length ? designReferenceInstructions(imageAtts, refAnalysis) : '') +
                (prevArt && (editTarget?.kind === 'logo' || editTarget?.kind === 'palette' || editTarget?.kind === 'shopping')
                  ? `\n\nPREVIOUS ${editTarget.kind.toUpperCase()} JSON (revise THIS — keep everything not mentioned in the request identical; output the full updated JSON):\n${JSON.stringify(prevArt).slice(0, 9000)}`
                  : ''),
              kind: studioKind,
              ...(studioKind === 'webpage' ? { websiteChangeRequest: buildPreamble + content } : {}),
              ...(studioKind === 'logo' ? { logoBrief: { request: resuming?.prompt || content, answers: logoAnswers } } : {}),
              ...(studioKind === 'logo' && refAnalysis.trim() ? { logoReference: refAnalysis.trim() } : {}),
              ...(studioKind === 'logo' && prevArt && editTarget?.kind === 'logo' ? { prevLogo: Object.fromEntries(Object.entries(prevArt).filter(([key]) => !['imgCache', 'options', 'mark', 'lockup'].includes(key))) } : {}),
              brand: getBrand() || undefined,
              ...(prevArt && 'html' in prevArt && (prevArt as { html?: string }).html
                ? { prevHtml: designHtmlForEdit((prevArt as { html: string }).html, imageAtts), prevWebsiteContract: (prevArt as { quality?: WebsiteQuality }).quality?.behaviorContract }
                : isWebEdit
                  ? { prevHtml: lastWebHtml, prevWebsiteContract: lastWebArtifact?.quality?.behaviorContract }
                  : {}),
              ...(prevArt && editTarget?.kind === 'blueprint' ? { prevBlueprint: JSON.stringify(prevArt).slice(0, 60000) } : {}),
          }
          let r = await fetch('/api/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(designRequest), signal: ctrl.signal })
          let data = (await r.json().catch(() => ({}))) as { error?: string }
          // A text-only draft is not a successful photo-based poster. Repair once
          // with the same source images; don't save a fabricated replacement.
          if (r.ok && studioKind === 'poster' && imageAtts.length) {
            try { prepareDesignResponse(studioKind, data, imageAtts) }
            catch {
              r = await fetch('/api/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...designRequest, prompt: designRequest.prompt + '\nREQUIRED REPAIR: return complete HTML and include the supplied subject/headshot via its exact {{PHOTO_n}} placeholder. The previous response omitted the source image or was not valid HTML.' }), signal: ctrl.signal })
              data = await r.json().catch(() => ({}))
            }
          }
          accLoading = undefined
          // html-kinds carry `html`; json-kinds carry their payload key. webpage
          // omits `kind` server-side, so discriminate on the payload, not `kind`.
          const ok =
            r.ok &&
            ('html' in data ||
              'canvas' in data ||
              'colors' in data ||
              'brand' in data ||
              'shapes' in data ||
              'floors' in data ||
              'lockup' in data ||
              'mark' in data ||
              'initials' in data ||
              'items' in data ||
              (studioKind === 'carousel' && 'slides' in data))
          if (ok) {
            accDesign = prepareDesignResponse(studioKind, data, imageAtts)
            acc = ''
            // A freshly generated palette / brand becomes the active Brand Kit
            // immediately, so docs, decks and sheets the user downloads next
            // KEEP the palette they just gave (not the house default). They can
            // still re-pin any older palette via "Make routine".
            if (accDesign.kind === 'palette' || accDesign.kind === 'brand') {
              const b = deriveBrand(accDesign)
              if (b) setBrand(b)
            }
            // Symmetric to the deck path: "a logo AND a pitch deck" — if the primary
            // route landed on the logo but a deck was also asked for, co-build the
            // deck as its own artifact on this same message (logo + deck cards).
            if (studioKind === 'logo' && intent.additionalKinds.includes('slides')) {
              accLoading = 'slides'
              flush()
              try {
                const dr = await fetch('/api/slides', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ prompt: withCtx(content) }),
                  signal: ctrl.signal,
                })
                const dd = (await dr.json().catch(() => ({}))) as Deck & { error?: string }
                if (dr.ok && Array.isArray(dd.slides) && dd.slides.length) {
                  accDeck = cleanDeck({ title: dd.title, subtitle: dd.subtitle, cover: dd.cover, slides: dd.slides, design: dd.design })
                }
              } catch { /* deck is a bonus — the logo already succeeded */ }
              accLoading = undefined
            }
          } else {
            acc = `⚠️ ${data.error || `Studio error ${r.status}`}`
          }
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Design request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Spreadsheet: build a real workbook (Excel formulas) the user can download.
      if (!plain && wantK('spreadsheet')) {
        setRouteName('Nalu Sheets')
        accLoading = 'sheet'
        flush()
        try {
          const boost = await runBoost('Nalu Sheets')
          const r = await fetch('/api/sheet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) + boost }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as SheetDoc & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.sheets) && data.sheets.length) {
            accSheet = cleanSheet({ title: data.title, sheets: data.sheets })
            acc = ''
          } else {
            acc = `⚠️ ${data.error || `Spreadsheet error ${r.status}`}`
          }
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Spreadsheet request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Video generation: route to the (pluggable) video endpoint. An attached
      // photo (or the blueprint on screen) becomes the START FRAME — true
      // image-to-video walkthroughs and blueprint→3D grow reveals.
      if (!plain && wantK('video')) {
        setRouteName('Nalu Video')
        accLoading = 'video'
        flush()
        const vidPrompt = content.replace(/^\/video\s+/i, '').trim() || content
        try {
          let vImage = imageAtts[0]?.dataUrl as string | undefined
          if (!vImage && /\b(blueprint|floor ?plan|walk.?through|this (plan|design)|grow|3d)\b/i.test(content)) {
            vImage = await blueprintSnapshot()
          }
          // $0-first ladder: real MiniMax-H3 on the user's own machine (if the
          // h3-server runner is up) → in-browser on-device engine (any device)
          // → free cloud pool. Each rung reports progress into the loading pill.
          const out = await generateVideo({
            prompt: vidPrompt,
            seconds: opts?.movieSeconds,
            ...(vImage ? { image: vImage } : {}),
            signal: ctrl.signal,
            onProgress: (_f, phase) => { setRouteName(`Nalu Video · ${phase}`) },
            onPreview: (url) => { accVideo = url; flush() },
          })
          accLoading = undefined
          accVideo = out.url
          acc = ''
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Video request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Image generation: if the user is asking for an image, call the image
      // endpoint (Nalu Image / CogView) and render the result inline as Markdown.
      if (!plain && wantK('image')) {
        setRouteName('Nalu Image')
        accLoading = 'image'
        flush()
        const imgPrompt = content.replace(/^\/(image|img|draw)\s+/i, '').trim() || content
        try {
          const r = await fetch('/api/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: imgPrompt }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string }
          accLoading = undefined
          acc =
            r.ok && data.url
              ? `![${imgPrompt.replace(/[[\]]/g, '')}](${data.url})`
              : `⚠️ ${data.error || `Image error ${r.status}`}`
        } catch (e) {
          accLoading = undefined
          acc = `⚠️ ${e instanceof Error ? e.message : 'Image request failed'}`
        }
        flush()
        setStreaming(false)
        abortRef.current = null
        return
      }

      // Agent loop: stream a turn; if the model calls tools, run them against
      // the connected repo and feed results back until it answers with text.
      const repo = activeRepo
      // Web tools are always available (no gaps in data); repo tools add when connected.
      const tools = repo ? [...WEB_TOOLS, ...TOOLS] : WEB_TOOLS
      const context = repo
        ? {
            repo: `${repo.owner}/${repo.repo}`,
            githubConnected: !!ghToken(),
            origin: { owner: repo.owner, repo: repo.repo },
            branch: repo.branch,
          }
        : undefined
      // Prepend the chat's Notes + attached documents so the AI can reference them.
      const conv: WireMessage[] = ctxBlock
        ? [
            { role: 'user', content: `[Context for this conversation — use it when relevant; do not repeat it back verbatim.]${ctxBlock}` },
            ...wire.map((m) => ({ role: m.role, content: m.content })),
          ]
        : wire.map((m) => ({ role: m.role, content: m.content }))
      // Attach any images on this chat to the latest user turn so the vision
      // model can actually SEE them (screenshots, photos). /api/chat routes a
      // message with image parts to Nalu Vision. Images were downscaled on import.
      if (imageAtts.length) {
        for (let i = conv.length - 1; i >= 0; i--) {
          if (conv[i].role === 'user') {
            const txt = typeof conv[i].content === 'string' ? (conv[i].content as string) : ''
            conv[i] = {
              ...conv[i],
              content: [
                { type: 'text', text: txt },
                ...imageAtts.map((a) => ({ type: 'image_url' as const, image_url: { url: a.dataUrl as string } })),
              ],
            }
            break
          }
        }
      }
      let sawAny = false
      // Up to 12 tool rounds so the agent can do genuinely deep, multi-step
      // research (search → read sources → refine → read more) before answering.
      for (let round = 0; round < 12 && !ctrl.signal.aborted; round++) {
        const { text, autoResearch, toolCalls, error, finishReason } = await streamChat(
          conv,
          model,
          {
            signal: ctrl.signal,
            onDelta: (t) => {
              acc += t
              sawAny = true
              scheduleFlush()
            },
            onReasoning: (t) => {
              accReasoning += t
              sawAny = true
              scheduleFlush()
            },
            onError: (m) => {
              acc += (acc ? '\n\n' : '') + `⚠️ ${m}`
              sawAny = true
              flush()
            },
            onRoute: (name) => setRouteName(name),
          },
          tools,
          context,
          thinkLevel,
          undefined, // specialist — keyword-routed for normal chat
          true, // opt into cross-chat memory: this is the main interactive turn
        )
        // Keep partial text visible, but never recover or execute actions from an
        // interrupted response. onError above already provides the retry message.
        if (error || ctrl.signal.aborted) break
        let calls = toolCalls
        let shownText = text
        // A serving adapter may encode the call as text despite an explicit
        // tool_calls finish reason. Recover only that case. Code examples and
        // reasoning are content, not authorization to execute an action.
        if (!autoResearch && !calls.length && finishReason === 'tool_calls') {
          const recovered = recoverToolCalls(text, tools)
          if (recovered.calls.length) {
            calls = recovered.calls
            acc = acc.slice(0, acc.length - text.length) + recovered.cleaned
            shownText = recovered.cleaned
            flush()
          }
        }
        conv.push({ role: 'assistant', content: shownText || null, tool_calls: calls.length ? calls : undefined })
        // Server research can still request native tools to complete the task.
        // Only confirmed calls reach here; textual recovery stays gated above.
        if (!calls.length) break
        for (const tc of calls) {
          if (ctrl.signal.aborted) break
          let label = ''
          try {
            const a = JSON.parse(tc.function.arguments || '{}') as { path?: string; query?: string; url?: string }
            label = String(a.query || a.url || a.path || '')
          } catch {
            /* ignore */
          }
          acc += `\n\n\`▸ ${tc.function.name}${label ? ` ${label}` : ''}\`\n`
          sawAny = true
          flush()
          const result = isWebTool(tc.function.name)
            ? await execWebTool(tc)
            : repo
              ? await execTool(tc, repo, changesRef.current)
              : 'Error: connect a repo to use file tools.'
          conv.push({ role: 'tool', tool_call_id: tc.id, content: result })
        }
        setChangeCount(Object.keys(changesRef.current).length)
      }
      if (!sawAny && !ctrl.signal.aborted) {
        acc = '⚠️ No response from the Nalu engine. Please try again in a moment.'
      }
      // Deep-think fallback: if the model produced reasoning but never the answer
      // marker, don't strand it in the left pane — show it as the answer.
      if (accReasoning && !acc.trim() && !ctrl.signal.aborted) {
        acc = 'Nalu did not finish its answer. Your request is saved; tap Retry to try again.'
        accReasoning = ''
      }
      flush() // ensure the final, complete text is rendered (no pending frame lost)
      } catch (e) {
        // A user-initiated Stop aborts the request — that's not an error, so keep
        // whatever streamed. Any OTHER throw surfaces as a recoverable message so
        // the user never sees a silently-frozen turn.
        if (!ctrl.signal.aborted) {
          const msg = e instanceof Error && e.message ? e.message : 'Something went wrong'
          acc = acc && acc.trim() ? `${acc}\n\n⚠️ ${msg}` : `⚠️ ${msg}. Please try again.`
          try { flush() } catch { /* render is best-effort */ }
        }
      } finally {
        // ALWAYS unwind the streaming state + release the abort controller + the
        // re-entry guard, no matter which route ran or how it ended.
        setStreaming(false)
        abortRef.current = null
        sendingChatsRef.current.delete(guardKey)
        finishReviewActivity()
      }
    },
    [activeId, chats, streaming, model, activeRepo, dismissedIntent, thinkLevel, reviewLayout],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setStreaming(false)
    // (the aborted send's finally clears its own per-target guard entry)
    // hand the prompt back so it can be edited and re-sent
    if (lastSentPromptRef.current) setInput((cur) => (cur.trim() ? cur : lastSentPromptRef.current))
  }, [])

  // Regenerate the assistant reply at index `i`: drop that whole turn (the user
  // prompt that produced it + the reply, and anything after) and re-send the
  // prompt so a fresh answer streams in its place. Used by the ↻ Retry action —
  // essential after an error/dropped stream, and handy for a better take.
  const regenerate = useCallback((i: number) => {
    if (streaming) return
    const msgs = chatsRef.current.find((c) => c.id === activeId)?.messages || []
    let userIdx = -1
    for (let k = Math.min(i, msgs.length - 1); k >= 0; k--) {
      if (msgs[k].role === 'user') { userIdx = k; break }
    }
    if (userIdx < 0) return
    const prompt = typeof msgs[userIdx].content === 'string' ? (msgs[userIdx].content as string) : ''
    if (!prompt.trim()) return
    // Drop this turn (the user prompt that produced it + the reply + anything after)
    // so send() re-adds the prompt and streams a fresh reply in its place. Update
    // chatsRef SYNCHRONOUSLY (not inside the setChats updater, which runs later) so
    // send() — called on the next line — reads the sliced history immediately.
    const sliced = msgs.slice(0, userIdx)
    const clarification = sliced[sliced.length - 1]?.clarify
    if (activeId && clarification?.build) pendingBuildRef.current.set(activeId, { ...clarification.build, questions: clarification.questions })
    const nextChats = chatsRef.current.map((c) => (c.id === activeId ? { ...c, messages: sliced } : c))
    chatsRef.current = nextChats
    setChats(nextChats)
    void send(prompt, { userMessageId: msgs[userIdx].id, assistantMessageId: msgs[i]?.id, attachments: msgs[userIdx].attachments })
  }, [streaming, activeId, send])

  // User answered the interactive clarifying questions → compose their tapped
  // answers into one message and resume the paused build (pendingBuildRef is set).
  const submitClarify = useCallback((msgIndex: number, answers: { q: string; a: string }[], keepView = false) => {
    if (streaming) return
    const pending = chatsRef.current.find(c => c.id === activeId)?.messages[msgIndex]?.clarify
    if (activeId && pending?.build) pendingBuildRef.current.set(activeId, { ...pending.build, questions: pending.questions })
    // Mark this clarify message answered so its chips lock.
    setChats((cs) => cs.map((c) => (c.id === activeId ? { ...c, messages: c.messages.map((m, i) => (i === msgIndex && m.clarify ? { ...m, updatedAt: Date.now(), clarify: { ...m.clarify, answered: true } } : m)) } : c)))
    const composed = answers.filter((x) => x.a.trim()).map((x) => `${x.q} ${x.a}`).join('\n')
    void send(composed.trim() || 'go ahead, use your best judgment', { keepView })
  }, [streaming, activeId, send])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't send while an IME composition is active (Japanese/Chinese/Korean, and
    // some accent/diacritic input) — Enter there is "confirm the candidate", not
    // "send the message". isComposing / keyCode 229 both flag an in-progress compose.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  const selectChat = useCallback((id: string) => {
    setActiveId(id)
    if (!reviewChatOpenRef.current) setView('chat')
    closeSidebarOnMobile()
    if (reviewChatOpenRef.current) requestAnimationFrame(() => taRef.current?.focus())
  }, [closeSidebarOnMobile])

  const matchesQuery = (c: Chat) => (query.trim() ? c.title.toLowerCase().includes(query.toLowerCase()) : true)
  // Include chats previously filed in projects in the same searchable list.
  const filteredChats = chats.filter(matchesQuery)
  const CHATS_PREVIEW = 8
  const visibleChats = chatsExpanded || query.trim() ? filteredChats : filteredChats.slice(0, CHATS_PREVIEW)

  const renderChatRow = (c: Chat, showDetails = true) => (
    <div key={c.id} data-chat-id={c.id} data-active={c.id === activeId} className="mb-0.5">
      {renamingChat?.id === c.id ? (
        <form className="flex items-center gap-1 rounded-lg bg-glass/[0.08] p-1" onSubmit={event => { event.preventDefault(); saveChatName() }}>
          <input autoFocus aria-label="Chat name" maxLength={120} value={renamingChat.title}
            onFocus={event => event.currentTarget.select()}
            onChange={event => setRenamingChat({ id: c.id, title: event.target.value })}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenamingChat(null) } }}
            className="min-w-0 flex-1 rounded-md border border-primary/40 bg-glass/[0.08] px-2 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-primary" />
          <button type="submit" aria-label="Save chat name" title="Save chat name" disabled={!renamingChat.title.trim()} className="rounded-md p-2 text-primary hover:bg-glass/10 disabled:opacity-30"><Check size={16} /></button>
          <button type="button" aria-label="Cancel rename" title="Cancel rename" onClick={() => setRenamingChat(null)} className="rounded-md p-2 text-dim hover:bg-glass/10"><X size={16} /></button>
        </form>
      ) : (
        <div className={`group flex items-center gap-1 rounded-lg pl-2.5 pr-1 text-[13px] ${c.id === activeId ? 'bg-glass/10' : 'hover:bg-glass/5'}`}>
          <button data-chat-history-select aria-current={c.id === activeId ? true : undefined} onClick={() => selectChat(c.id)} title={c.title} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
            <MessageSquare size={13} className="shrink-0 text-dim" /><span className="truncate">{c.title}</span>
          </button>
          <button onClick={() => startRename(c)} aria-label={`Rename chat: ${c.title}`} title="Rename chat" className="shrink-0 rounded-md p-2 text-dim hover:bg-glass/10 hover:text-ink"><Pencil size={13} /></button>
          <button onClick={() => deleteChat(c.id)} aria-label="Delete chat" title="Delete chat" className="shrink-0 rounded-md p-2 text-dim hover:bg-glass/10 hover:text-ink"><Trash2 size={13} /></button>
        </div>
      )}
      {showDetails && c.id === activeId && (
        <ChatDrawer
          attachments={c.attachments || []}
          built={builtArtifacts}
          notes={c.notes || ''}
          onRemove={removeAttachment}
          onNotes={updateNotes}
          onOpenBuilt={scrollToMsg}
          onDeleteBuilt={deleteMessage}
        />
      )}
    </div>
  )

  const topBarTitle =
    view === 'chat' ? active?.title || 'New chat' : VIEW_TITLES[view]
  const studioChat = studioTurn ? chats.find(c => c.id === studioTurn.chatId) : active
  const studioMessageIndex = studioTurn ? studioChat?.messages.findIndex(m => m.id === studioTurn.messageId) ?? -1 : (studioChat?.messages.length ?? 0) - 1
  const studioMessage = studioChat?.messages[studioMessageIndex]
  const studioResultKey = studioChat && studioMessageIndex >= 0 ? `${studioChat.id}:${studioMessageIndex}` : undefined
  const visibleSidebar = reviewLayout ? view === 'chat' : sidebarOpen

  const renderChatTools = () => (
    <div className="flex shrink-0 items-center gap-2">
              <PlaygroundControls />
              {activeRepo ? (
                <>
                  {changeCount > 0 && (
                    <button
                      onClick={commit}
                      disabled={committing}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      <GitCommit size={13} /> {committing ? 'Committing…' : `Commit ${changeCount}`}
                    </button>
                  )}
                  <button
                    onClick={disconnectRepo}
                    title={`Disconnect ${activeRepo.owner}/${activeRepo.repo}`}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-glass/[0.06] hover:bg-glass/10 text-dim"
                  >
                    <GitBranch size={13} /> <span className="hidden sm:inline">{activeRepo.owner}/{activeRepo.repo}</span>
                  </button>
                </>
              ) : null}
              <div className="hidden sm:flex items-center text-xs text-dim px-2.5 py-1.5 rounded-lg bg-glass/[0.06]">
                Talking to {routeName}
              </div>
            </div>
  )

  const renderChatContent = () => (messages.length === 0 ? (
    <div className="ws-chat-home">
      <div className="ws-chat-welcome">
        {reviewLayout ? <NaluMark className="review-welcome-logo" /> : <NaluAvatar size={286} />}
        <span className="ws-eyebrow"><i />Right here with you</span>
        <h1>{reviewLayout ? <><span>Your space.</span><strong>Your Nalu.</strong></> : "I'm right here."}</h1>
        <p>A thought, a question, a new idea.<br/>A little help for whatever comes next.</p>
      </div>
      <div className="ws-home-composer w-full max-w-2xl">
        <Composer
          visible={!reviewLayout || chatContentVisible}
          contextKey={active?.id || 'new-chat'}
          accountToken={sessionToken || ''}
          input={input}
          setInput={setInput}
          streaming={streaming}
          onSend={() => void send(input)}
          onStop={stop}
          onKey={onKey}
          taRef={taRef}
          onAttach={(files) => void addAttachments(files)}
          attaching={attaching}
          attachments={(active?.attachments || []).filter((a) => pendingIds.includes(a.id))}
          onRemoveAttachment={removeAttachment}
          dismissedIntent={dismissedIntent}
          onDismissIntent={() => setDismissedIntent(input.trim())}
          thinkLevel={thinkLevel}
        />
      </div>
      <div className="ws-chat-suggestions" aria-label="Ways to begin">
        <button onClick={() => { setInput('Help me plan my day.'); taRef.current?.focus() }}><StickyNote size={18}/><span>Plan my day<small>A little room to think</small></span></button>
        <button onClick={() => reviewLayout ? openSpace('studio') : setView('studio')}><Palette size={18}/><span>Make something<small>Bring an idea to life</small></span></button>
        <button onClick={() => reviewLayout ? openSpace('agents') : setView('agents')}><Bot size={18}/><span>Leave it with Nalu<small>Your work, moving forward</small></span></button>
      </div>
    </div>
  ) : (
    <>
      <div ref={scrollRef} onScroll={onChatScroll} className="ws-chat-thread flex-1 overflow-y-auto overscroll-contain">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
          {attachmentError && <p role="alert" className="rounded-xl border border-glass/20 bg-panel/80 p-3 text-sm text-ink">{attachmentError}</p>}
          {messages.map((m, i) => (
            <div
              key={i}
              ref={(el) => {
                msgRefs.current[i] = el
              }}
              className={`ws-chat-message scroll-mt-20 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {m.role === 'user' ? (
                // Your messages render as an iMessage-style blue bubble on the
                // right — no avatar — so it's obvious which side is you.
                <div dir="auto" className="ws-user-message max-w-[78%] rounded-2xl rounded-br-md bg-gradient-to-b from-[#3b82f6] to-[#2f6fed] px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-white shadow-sm">
                  {m.content}
                  <MessageAttachments attachments={m.attachments || (i === messages.findIndex(message => message.role === 'user') ? active?.attachments || [] : [])} />
                </div>
              ) : (
                // Nalu's answer: full-width, left-aligned, no avatar.
                <div className="w-full min-w-0">
                  <div className="ws-assistant-identity">
                    {reviewLayout ? <NaluMark className="review-assistant-logo" /> : streaming && i === messages.length - 1 ? <NaluAvatar size={42} phase="thinking"/> : <img src={avatarArtwork} alt=""/>}
                    <span>Nalu<small>{streaming && i === messages.length - 1 ? m.content ? 'Writing your answer' : 'Thinking with you' : 'Here to help'}</small></span>
                    {streaming && i === messages.length - 1 && !!m.content && <NaluGlobe size={22} />}
                  </div>
                  <AssistantThink reasoning={m.reasoning} isLive={streaming && i === messages.length - 1}>
                  <>
                    {m.loading ? (
                      <MediaLoader kind={m.loading} />
                    ) : m.content ? (
                      // Render full Markdown LIVE while streaming, so the
                      // styling appears as the text arrives (rAF-throttled
                      // upstream keeps it smooth). A subtle caret trails it.
                      <div className={`ws-answer-content${streaming && i === messages.length - 1 ? ' streaming-caret nalu-stream-fade' : ''}`}>
                        <Markdown>{cleanForDisplay(m.content)}</Markdown>
                        {m.clarify && !m.clarify.answered && !streaming && (
                          <ClarifyBlock questions={m.clarify.questions} onSubmit={(ans) => submitClarify(i, ans)} />
                        )}
                      </div>
                    ) : !m.sheet && !m.doc && !m.video && !m.cad && !m.design && !m.deck && streaming && i === messages.length - 1 ? (
                      <div className="nalu-answer-wait" role="status">
                        <NaluGlobe size={24} />
                        <span>Thinking with you…</span>
                      </div>
                    ) : null}
                    <div
                      className={i === messages.length - 1 && (m.sheet || m.doc || m.deck || m.design || m.cad || m.video) ? 'nalu-materialize' : undefined}
                      onAnimationEnd={(e) => e.currentTarget.classList.remove('nalu-materialize')}
                    >
                    {m.sheet && (
                      <CardErrorBoundary label="The spreadsheet">
                        <Suspense fallback={<MediaLoader kind="sheet" action="opening" />}>
                          <SheetCard data={m.sheet} />
                        </Suspense>
                      </CardErrorBoundary>
                    )}
                    {m.doc && (
                      <CardErrorBoundary label="The document">
                        <Suspense fallback={<MediaLoader kind="doc" action="opening" />}>
                          <DocCard data={m.doc} />
                        </Suspense>
                      </CardErrorBoundary>
                    )}
                    {m.email && (
                      <CardErrorBoundary label="The email">
                        <Suspense fallback={<MediaLoader kind="email" action="opening" />}>
                          <EmailCard data={m.email} />
                        </Suspense>
                      </CardErrorBoundary>
                    )}
                    {m.deck && (
                      <CardErrorBoundary label="The deck">
                        <Suspense fallback={<MediaLoader kind="slides" action="opening" />}>
                          <SlidesCard data={m.deck} onUpdate={deck => setChats(cs => cs.map(ch =>
                            ch.id === activeId ? { ...ch, messages: ch.messages.map((mm, k) => k === i ? { ...mm, deck } : mm) } : ch
                          ))} />
                        </Suspense>
                      </CardErrorBoundary>
                    )}
                    {m.cad && (
                      <CardErrorBoundary label="The 3D model">
                        <Suspense fallback={<MediaLoader kind="cad" action="opening" />}>
                          <CADCard
                            code={m.cad}
                            prompt={(() => {
                              // the design intent = the user message that asked for it
                              for (let k = i - 1; k >= 0; k--) if (messages[k].role === 'user') return messages[k].content
                              return undefined
                            })()}
                          />
                        </Suspense>
                      </CardErrorBoundary>
                    )}
                    {m.design && (
                      <CardErrorBoundary label="The design" resetKey={m.design} previewHtml={typeof m.design === 'object' && 'html' in m.design && typeof m.design.html === 'string' ? m.design.html : undefined}>
                        <Suspense fallback={<MediaLoader kind="design" action="opening" />}>
                          <DesignArtifactCard
                            art={m.design}
                            onUpdate={(art) => {
                              // "Finish build" (and future in-card edits) persist onto the message
                              if (!activeId) return
                              setChats((cs) =>
                                cs.map((c) =>
                                  c.id === activeId
                                    ? { ...c, messages: c.messages.map((mm, k) => ((m.id ? mm.id === m.id : k === i) ? updateDesignMessage(mm, art, Date.now(), m.design) : mm)) }
                                    : c,
                                ),
                              )
                            }}
                          />
                        </Suspense>
                      </CardErrorBoundary>
                    )}
                    {m.video && (
                      <div className="block">
                        <H3MoviePlayer
                          url={m.video}
                          className="my-2 max-h-[28rem] w-auto max-w-full rounded-xl border border-glass/[0.14]"
                        />
                        {!movieIdFromUrl(m.video) && <button
                          onClick={() => void downloadMedia(m.video as string, 'nalu-video.mp4')}
                          className="mb-2 text-xs font-medium text-gold underline-offset-4 hover:underline"
                        >
                          Download video
                        </button>}
                      </div>
                    )}
                    </div>
                  </>
                  </AssistantThink>
                  {/* Message actions — Copy the answer + Retry (regenerate).
                      Hidden while THIS message is still streaming or loading
                      a media card; retry is the recovery path after an error
                      or a dropped stream. */}
                  {!m.loading && !(streaming && i === messages.length - 1) && (typeof m.content === 'string' && (m.content.trim().length > 0 || !!m.id)) && (
                    <div className="mt-1.5 flex items-center gap-1 text-dim">
                      <button
                        onClick={() => {
                          const t = cleanForDisplay(typeof m.content === 'string' ? m.content : '')
                          navigator.clipboard?.writeText(t)
                            .then(() => { setCopiedMsg(i); setTimeout(() => setCopiedMsg((c) => (c === i ? null : c)), 1500) })
                            .catch(() => {})
                        }}
                        title="Copy"
                        aria-label="Copy message"
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-glass/10 hover:text-ink"
                      >
                        {copiedMsg === i ? <><Check size={12} className="text-emerald-400" /> Copied</> : <><Copy size={12} /> Copy</>}
                      </button>
                      <button
                        onClick={() => regenerate(i)}
                        disabled={streaming}
                        title="Regenerate this response"
                        aria-label="Retry"
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] hover:bg-glass/10 hover:text-ink disabled:opacity-40"
                      >
                        <RotateCw size={12} /> Retry
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ws-chat-composer-dock px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <BrandBar />
          <Composer
            visible={!reviewLayout || chatContentVisible}
            contextKey={active?.id || 'new-chat'}
            accountToken={sessionToken || ''}
            input={input}
            setInput={setInput}
            streaming={streaming}
            onSend={() => void send(input)}
            onStop={stop}
            onKey={onKey}
            taRef={taRef}
            onAttach={(files) => void addAttachments(files)}
            attaching={attaching}
            attachments={(active?.attachments || []).filter((a) => pendingIds.includes(a.id))}
            onRemoveAttachment={removeAttachment}
            dismissedIntent={dismissedIntent}
            onDismissIntent={() => setDismissedIntent(input.trim())}
            thinkLevel={thinkLevel}
          />
        </div>
      </div>
    </>
  ))

  return (
    <div
      className="nalu-workspace relative isolate h-[100dvh] w-screen flex text-ink overflow-hidden font-sans" data-workspace-theme={isDark ? 'dark' : 'light'}
      data-workspace-view={view} data-workspace-design-preview={reviewLayout || undefined}
      data-workspace-launcher={reviewLayout && launcherOpen || undefined}
      data-agent-screens={reviewLayout && agentScreensOpen || undefined}
      onKeyDownCapture={reviewLayout && launcherOpen && !reviewChatOpen ? event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (hasOpenedSpace) setLauncherOpen(false)
        }
      } : undefined}
    >
      {/* The avatar workspace is scoped to the authenticated app. */}

      {reviewLayout && <header className="review-workspace-header">
        <button className="review-header-brand" aria-label="Nalu home" onClick={openWorkspaceLauncher}>
          <span className="review-logo-wordmark"><NaluMark/><b>nalu</b></span>
        </button>
        {WorkspaceAppDock && <Suspense fallback={<nav aria-label="Workspace navigation"/>}><WorkspaceAppDock currentView={view} launcherOpen={launcherOpen || agentScreensOpen} onOpen={openSpace}/></Suspense>}
        <WorkspaceAccountMenu displayName={user?.displayName} saveState={saveState} onLogout={onLogout} onRetrySave={retrySync}
          onSettings={() => { setReviewChatOpen(false); setLauncherOpen(false); setAgentScreensOpen(false); setHasOpenedSpace(true); setView('settings'); closeSidebarOnMobile() }}/>

      </header>}

      {reviewLayout && launcherOpen && WorkspaceCarousel && <Suspense fallback={<div className="review-launcher-loading" role="status">Opening your spaces…</div>}>
        <WorkspaceCarousel initialView={launcherSelection} onOpen={openSpace} onClose={hasOpenedSpace ? () => setLauncherOpen(false) : undefined}/>
      </Suspense>}

      {/* Mobile backdrop — taps close the off-canvas sidebar. */}
      {!reviewLayout && sidebarOpen && (
        <div
          className={`${reviewLayout ? 'review-sidebar-backdrop ' : ''}fixed inset-0 z-30 bg-black/50 md:hidden`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — push column on desktop, off-canvas overlay on phones. */}
      <aside
        ref={element => { if (element) element.inert = !visibleSidebar || reviewLayout && (launcherOpen || agentScreensOpen) }}
        aria-hidden={!visibleSidebar || reviewLayout && (launcherOpen || agentScreensOpen)}
        data-launcher-hidden={reviewLayout && (launcherOpen || agentScreensOpen) || undefined}
        className={`ws-sidebar ${visibleSidebar ? 'w-64' : 'w-0'} fixed inset-y-0 left-0 z-40 md:static md:z-auto transition-[width] duration-200 shrink-0 overflow-hidden border-r border-glass/[0.18] ws-glass flex flex-col`}
      >
        {reviewLayout && <div className="review-history-heading"><span>Your conversations</span><small>{chats.length} saved</small></div>}
        <div className="ws-brand flex items-center gap-2 px-5 shrink-0">
          <button aria-label="Nalu home" onClick={() => { newChat(); closeSidebarOnMobile() }}><img src={avatarWordmark} alt="nalu" /></button>
        </div>

        <div className="ws-sidebar-new-chat px-3 pb-2">
          <button
            onClick={() => { newChat(); closeSidebarOnMobile() }}
            className="ws-new-chat w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
          >
            <Plus size={15} /> New chat
          </button>
        </div>

        <div className="ws-sidebar-search px-3 pb-2">
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-glass/5">
            <Search size={14} className="text-dim" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="bg-transparent outline-none text-sm w-full placeholder:text-dim"
            />
          </div>
        </div>

        <nav className="ws-navigation" aria-label="Workspace sections">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon
            return <button key={item.view} aria-current={view === item.view ? 'page' : undefined}
              onClick={() => { setView(item.view); closeSidebarOnMobile() }}>
              <Icon size={17} strokeWidth={1.5}/><span>{item.label}</span>
            </button>
          })}
        </nav>

        {view === 'chat' && (
          <>
            <div role="status" aria-label="Chat save status" className="px-3 pb-2 text-[11px] text-dim">
              {saveState === 'saved' ? 'Saved to your account' : saveState === 'saving' ? 'Saving chats…' : saveState === 'loading' ? 'Loading saved chats…' : saveState === 'error' ? 'Chats need attention — keep this tab open.' : 'Waiting to sync your chats'}
              {(saveState === 'pending' || saveState === 'error') && <button className="ml-2 underline hover:text-ink" onClick={retrySync}>Retry save</button>}
            </div>
            {/* Every saved chat, including former project chats. */}
            <div className="ws-sidebar-history flex-1 overflow-y-auto px-2 pb-2">
              {filteredChats.length > 0 && (
                <div className="px-1 pt-2 pb-1 text-[11px] uppercase tracking-wide text-dim">Chats</div>
              )}
              {filteredChats.length === 0 && (
                <div className="px-2 py-3 text-xs text-dim">No chats yet.</div>
              )}
              {visibleChats.map(chat => renderChatRow(chat))}
              {!query.trim() && filteredChats.length > CHATS_PREVIEW && (
                <button
                  onClick={() => setChatsExpanded((v) => !v)}
                  className="mt-0.5 flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] font-medium text-gold hover:bg-glass/[0.06]"
                >
                  {chatsExpanded ? <><ChevronUp size={13} /> Show less</> : <><ChevronDown size={13} /> Show all {filteredChats.length} chats</>}
                </button>
              )}
            </div>
          </>
        )}
        {view !== 'chat' && <div className="flex-1" />}

        <div className="ws-sidebar-footer border-t border-glass/[0.18] p-2 space-y-0.5">
          <button
            onClick={() => { setView('settings'); closeSidebarOnMobile() }}
            className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors ${
              view === 'settings' ? 'bg-glass/10 text-ink' : 'text-dim hover:bg-glass/5'
            }`}
          >
            <Settings size={13} className="shrink-0" /> Settings
          </button>
          <a
            href="/download.html" target="_blank" rel="noreferrer"
            className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-dim hover:bg-glass/5 transition-colors"
          >
            {reviewLayout ? <NaluMark className="w-5 h-5 shrink-0" /> : <img src={avatarArtwork} alt="" className="w-5 h-5 rounded shrink-0 object-contain" />} Download Nalu Desktop
          </a>
          <a
            href="/privacy.html"
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-dim hover:bg-glass/5 transition-colors"
          >
            <Shield size={13} className="shrink-0" /> Privacy Policy
          </a>
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-glass/5">
            <div className="w-7 h-7 rounded-full bg-glass/10 flex items-center justify-center text-xs font-medium">
              {reviewLayout ? <NaluMark className="w-5 h-5"/> : (user?.displayName || 'N').charAt(0).toUpperCase()}
            </div>
            <span className="text-sm truncate flex-1">{user?.displayName || 'You'}</span>
            <button
              onClick={onLogout}
              className="text-dim hover:text-ink"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main ref={reviewMainRef} tabIndex={reviewLayout ? -1 : undefined} aria-hidden={reviewLayout && (launcherOpen || agentScreensOpen) || undefined} data-launcher-hidden={reviewLayout && (launcherOpen || agentScreensOpen) || undefined} className="ws-main flex-1 flex flex-col min-w-0">
        <div className="ws-topbar flex items-center gap-2 px-5 shrink-0">
          {!reviewLayout && <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-8 h-8 rounded-md hover:bg-glass/10 flex items-center justify-center text-ink"
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={16} />
          </button>}
          <span className="truncate text-sm text-dim">{topBarTitle}</span>
          {view === 'chat' && active && <button onClick={() => startRename(active)} aria-label="Rename current chat" title="Rename chat" className="shrink-0 rounded-md p-1.5 text-dim hover:bg-glass/10 hover:text-ink"><Pencil size={13} /></button>}
          {!reviewLayout && <button
            onClick={toggleTheme}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-glass/[0.14] bg-glass/[0.06] px-2.5 py-1.5 text-xs text-dim hover:bg-glass/10 hover:text-ink transition-colors"
            aria-label="Toggle light or dark theme"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
            <span className="hidden sm:inline">{isDark ? 'Light' : 'Dark'}</span>
          </button>}
          {view === 'chat' && renderChatTools()}
        </div>

        {showConnect && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => setShowConnect(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl border border-glass/[0.18] bg-glass/[0.06] backdrop-blur-2xl p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <GitBranch size={15} /> Connect a GitHub repo
                </h3>
                <button onClick={() => setShowConnect(false)} className="text-dim hover:text-ink">
                  <X size={16} />
                </button>
              </div>
              <label className="block text-xs text-dim mb-1">GitHub token (repo scope)</label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ghp_…"
                className="w-full mb-3 rounded-lg bg-glass/[0.06] border border-glass/[0.18] px-3 py-2 text-sm outline-none focus:border-glass/20"
              />
              <label className="block text-xs text-dim mb-1">Repository</label>
              <input
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connectRepo()}
                placeholder="owner/repo"
                className="w-full mb-4 rounded-lg bg-glass/[0.06] border border-glass/[0.18] px-3 py-2 text-sm outline-none focus:border-glass/20"
              />
              <button
                onClick={() => void connectRepo()}
                disabled={connecting || !tokenInput.trim() || !repoInput.includes('/')}
                className="w-full rounded-lg bg-white text-black text-sm font-medium py-2 disabled:bg-glass/15 disabled:text-glass/40"
              >
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
              <p className="text-[11px] text-dim mt-3">
                Nalu reads, edits, and commits files via the GitHub API — your token stays in your browser.
              </p>
            </div>
          </div>
        )}

        {view === 'studio' && (
          <StudioPanel
            designEnabled={reviewLayout}
            creations={creations}
            onOpen={openCreation}
            streaming={streaming}
            resultKey={studioResultKey}
            onStop={stop}
            feedback={!streaming && studioMessage?.role === 'assistant' && (studioMessage.clarify && !studioMessage.clarify.answered
              ? <div className="ws-studio-feedback"><p>{studioMessage.content}</p><ClarifyBlock key={studioMessage.id || studioResultKey} questions={studioMessage.clarify.questions} onSubmit={answers => submitClarify(studioMessageIndex, answers, true)}/></div>
              : studioTurn && studioMessage.content && !creations.some(c => c.key === studioResultKey)
                ? <div className="ws-studio-feedback" role="alert"><p>{studioMessage.content}</p><span>Your brief and previous creations are saved. You can adjust the brief and try again.</span></div>
                : null)}
            renderCreation={(c) => {
              // Render the creation's REAL interactive card (the same components
              // chat uses) so EVERY kind previews right inside the Studio.
              const chat = chats.find((x) => x.id === c.chatId)
              const m = chat?.messages[c.mi]
              if (!m) return null
              if (m.design)
                return (
                  <CardErrorBoundary label="The design" resetKey={m.design} previewHtml={typeof m.design === 'object' && 'html' in m.design && typeof m.design.html === 'string' ? m.design.html : undefined}>
                    <Suspense fallback={<MediaLoader kind="design" action="opening" />}>
                      <DesignArtifactCard
                        art={m.design}
                        onUpdate={(art) =>
                          setChats((cs) =>
                            cs.map((ch) =>
                              ch.id === c.chatId
                                ? { ...ch, messages: ch.messages.map((mm, k) => ((m.id ? mm.id === m.id : k === c.mi) ? updateDesignMessage(mm, art, Date.now(), m.design) : mm)) }
                                : ch,
                            ),
                          )
                        }
                      />
                    </Suspense>
                  </CardErrorBoundary>
                )
              if (m.deck)
                return (
                  <CardErrorBoundary label="The deck">
                    <Suspense fallback={<MediaLoader kind="slides" action="opening" />}>
                      <SlidesCard data={m.deck} onUpdate={deck => setChats(cs => cs.map(ch =>
                        ch.id === c.chatId ? { ...ch, messages: ch.messages.map((mm, k) => k === c.mi ? { ...mm, deck } : mm) } : ch
                      ))} />
                    </Suspense>
                  </CardErrorBoundary>
                )
              if (m.sheet)
                return (
                  <CardErrorBoundary label="The spreadsheet">
                    <Suspense fallback={<MediaLoader kind="sheet" action="opening" />}><SheetCard data={m.sheet} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.doc)
                return (
                  <CardErrorBoundary label="The document">
                    <Suspense fallback={<MediaLoader kind="doc" action="opening" />}><DocCard data={m.doc} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.cad)
                return (
                  <CardErrorBoundary label="The 3D model">
                    <Suspense fallback={<MediaLoader kind="cad" action="opening" />}><CADCard code={m.cad} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.video) return <H3MoviePlayer url={m.video} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl" />
              if (typeof m.content === 'string') {
                const im = m.content.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
                if (im) return <img src={im[1]} alt={m.content.slice(2, 80)} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl" />
              }
              return null
            }}
            onGenerate={(prompt, toolKey, target, movieSeconds) => {
              // Stay in the Studio so the design renders here first; it also lands in chat.
              closeSidebarOnMobile()
              void send(prompt, { keepView: true, studioKind: toolKey, studioTarget: target, movieSeconds })
            }}
          />
        )}
        {view === 'map' && <MapPanel />}
        {view === 'memory' && IS_WEB_APP && (reviewLayout && WorkspaceLiveHub ? (
          <Suspense fallback={<div className="review-launcher-loading" role="status">Opening your work…</div>}>
            <WorkspaceLiveHub chats={chats} activeChatIds={reviewActiveChats} activity={liveActivity}
              onOpenChat={id => { setActiveId(id); openSpace('chat') }}
              onOpenSpace={openSpace} onOpenSwarm={openSwarmActivity}
              onNewChat={() => { newChat(); openSpace('chat') }}
              savedMemory={<MemoryPanel chats={chats} designEnabled onOpenChat={id => { setActiveId(id); openSpace('chat') }} />}/>
          </Suspense>
        ) : <MemoryPanel chats={chats} onOpenChat={selectChat} />)}
        {view === 'agents' && (
          <Suspense fallback={<div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-dim">Opening AutoPilot…</div>}>
            <div className="ws-feature-shell"><WorkspaceIntro compact label="AutoPilot" title="Leave it with me." description="Plan the steps, connect your tools, and follow your work as it happens."/><AgentsPanel /></div>
          </Suspense>
        )}
        {view === 'skills' && <SkillsPanel onDraft={prompt => { setInput(prompt); if (reviewLayout) openSpace('chat'); else setView('chat'); requestAnimationFrame(() => taRef.current?.focus()) }} />}
        {view === 'automations' && <AutomationsPanel />}
        {view === 'settings' && (
          <SettingsPanel displayName={user?.displayName} onLogout={onLogout} />
        )}

        {view === 'chat' && (reviewLayout ? (reviewChatOpen ? (
          <div className="review-chat-detached">
            <NaluMark />
            <h2>Your conversation is open below.</h2>
            <button type="button" onClick={() => openSpace('chat')}>Open full chat</button>
          </div>
        ) : <div ref={setChatInlineAnchor} className="workspace-chat-inline-slot" aria-hidden="true" />) : renderChatContent())}
      </main>

      {reviewLayout && agentScreensOpen && WorkspaceAgentScreens && <Suspense fallback={<div className="review-launcher-loading" role="status">Opening agent screens…</div>}>
        <WorkspaceAgentScreens chats={chats} activeChatIds={reviewActiveChats} activity={liveActivity} selectedItemId={selectedAgentItem}
          onSelectItem={selectActivityItem} onOpenSwarm={openSwarmActivity} onOpenChat={id => { setActiveId(id); openSpace('chat') }} onOpenSpace={openSpace} onClose={closeAgentScreens}/>
      </Suspense>}
      {reviewLayout && WorkspaceAgentTray && <Suspense fallback={null}>
        <WorkspaceAgentTray chats={chats} activeChatIds={reviewActiveChats} activity={liveActivity}
          onOpenChat={id => { setActiveId(id); openSpace('chat') }}
          onOpenPicker={() => setReviewChatOpen(false)}
          onOpenAgent={agent => { setSelectedAgentItem(null); setAgentScreensOpen(false); setAgentConversationRequest(current => ({ agent, key: (current?.key || 0) + 1 })); setReviewChatOpen(true) }}
          onOpenMemory={() => openSpace('memory')} selectedItemId={selectedAgentItem || undefined}
          onSelectItem={selectActivityItem} onOpenScreens={() => openAgentScreens(null)}/>
      </Suspense>}

      {reviewLayout && WorkspaceChatPopover && <Suspense fallback={null}>
        <WorkspaceChatPopover swarm={previewLayout ? undefined : liveSwarm} swarmNavigationRequest={swarmNavigationRequest} agentConversationRequest={agentConversationRequest} open={reviewChatOpen} onOpen={() => setReviewChatOpen(true)}
          fullPageAnchor={chatInlineAnchor}
          fullPageVisible={view === 'chat' && !launcherOpen && !agentScreensOpen}
          onChatVisibilityChange={setChatContentVisible}
          onClose={() => setReviewChatOpen(false)}
          onNewChat={newChat} title={active?.title || 'A little space to think'}
          chatItems={chats.map(chat => ({ id: chat.id, title: chat.title }))} activeChatId={activeId} onSelectChat={selectChat}
          chatTools={activeRepo || routeName !== 'Nalu' ? renderChatTools() : undefined}
          persistenceKey={previewLayout ? undefined : `workspace-chat-tabs:${encodeURIComponent(user?.id || 'account')}`}
          history={showChatDetails => reviewChatOpen ? <>
            <div className="workspace-chat-history-heading"><h3>All chats</h3><span>{chats.length}</span></div>
            <label className="workspace-chat-history-search"><Search size={15} aria-hidden="true"/><input
              type="search" aria-label="Search all chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)}/></label>
            <nav className="workspace-chat-history-list" aria-label="Chat history">
              {filteredChats.map(chat => renderChatRow(chat, showChatDetails))}
              {filteredChats.length === 0 && <p>{query.trim() ? 'No chats match your search.' : 'Your conversations will appear here.'}</p>}
            </nav>
          </> : null}>
          {renderChatContent()}
        </WorkspaceChatPopover>
      </Suspense>}

      {/* No right drawer — everything Nalu builds renders IN FULL in the chat. */}
    </div>
  )
}

// Interactive multiple-choice clarifying questions rendered inside an assistant
// message before a Studio build. The user taps answers (single- or multi-select)
// and hits Build; the composed answers resume the paused build. They can also skip
// to let Nalu use its best judgment.
function ClarifyBlock({ questions, onSubmit }: { questions: ClarifyQ[]; onSubmit: (answers: { q: string; a: string }[]) => void }) {
  const [sel, setSel] = useState<Record<number, string[]>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const toggle = (qi: number, opt: string, multi?: boolean) => {
    setSel((s) => {
      const cur = s[qi] || []
      if (multi) return { ...s, [qi]: cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt] }
      return { ...s, [qi]: cur.includes(opt) ? [] : [opt] } // single-select toggles
    })
  }
  const build = () => onSubmit(questions.map((q, qi) => ({ q: q.q, a: custom[qi]?.trim() || (sel[qi] || []).join(', ') })))
  const allAnswered = questions.every((_, qi) => custom[qi]?.trim() || sel[qi]?.length)
  return (
    <div className="mt-2 space-y-3 rounded-xl border border-glass/[0.12] bg-glass/[0.03] p-3">
      {questions.map((q, qi) => (
        <div key={qi}>
          <div className="mb-1.5 text-[13px] font-medium text-ink">{q.q}</div>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt, oi) => {
              const on = (sel[qi] || []).includes(opt)
              return (
                <button key={oi} onClick={() => toggle(qi, opt, q.multi)}
                  className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${on ? 'border-accent/60 bg-accent/20 text-ink' : 'border-glass/15 bg-glass/[0.04] text-dim hover:border-glass/30 hover:text-ink'}`}>
                  {opt}
                </button>
              )
            })}
            {q.multi && <span className="self-center text-[10px] text-dim">pick any</span>}
          </div>
          <input aria-label={`Your answer: ${q.q}`} value={custom[qi] || ''} onChange={e => setCustom(c => ({ ...c, [qi]: e.target.value }))}
            placeholder="Or write your own answer" className="mt-2 w-full rounded-md border border-glass/15 bg-transparent px-2.5 py-2 text-[13px] text-ink placeholder:text-dim" />
        </div>
      ))}
      <div className="flex items-center gap-2 pt-0.5">
        <button onClick={build} disabled={!allAnswered}
          className="rounded-lg bg-gradient-to-r from-[#c9a86a] to-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-[#15170f] hover:brightness-110 disabled:opacity-40">
          Build with these answers
        </button>
        <button onClick={() => onSubmit([])} className="text-[12px] text-dim hover:text-ink">Skip, use best judgment</button>
      </div>
    </div>
  )
}

// ---- composer ------------------------------------------------------------

// Inline drawer under the ACTIVE chat in the left rail: uploaded attachments
// (open / download / remove), artifacts Nalu built in the chat, and an editable
// Notes section the AI references on every message.
const ARTIFACT_ICON: Record<string, LucideIcon> = {
  doc: FileText,
  deck: BarChart3,
  sheet: Table2,
  design: Palette,
  cad: Box,
  video: Film,
  image: ImageIcon,
}
function ChatDrawer({
  attachments,
  built,
  notes,
  onRemove,
  onNotes,
  onOpenBuilt,
  onDeleteBuilt,
}: {
  attachments: Attachment[]
  built: { kind: string; label: string; mi: number }[]
  notes: string
  onRemove: (id: string) => void
  onNotes: (v: string) => void
  onOpenBuilt: (mi: number) => void
  onDeleteBuilt: (mi: number) => void
}) {
  const [tab, setTab] = useState<'files' | 'notes' | null>('files')
  const fileCount = attachments.length + built.length
  // Build a real Blob (from the stored original file, or the extracted text) and
  // use an object URL — far more reliable than opening a giant data: URL, which
  // browsers often block.
  const blobFor = (a: Attachment): Blob => {
    if (a.dataUrl) {
      try {
        const [head, b64] = a.dataUrl.split(',')
        const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream'
        const bin = atob(b64)
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        return new Blob([arr], { type: mime })
      } catch {
        /* fall through to text */
      }
    }
    return new Blob([a.text || ''], { type: 'text/plain' })
  }
  const open = (a: Attachment) => {
    openArtifactBlob(blobFor(a), a.name)
  }
  const download = (a: Attachment) => {
    const url = URL.createObjectURL(blobFor(a))
    const link = document.createElement('a')
    link.href = url
    link.download = a.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  return (
    <div className="ml-3 mt-1 border-l border-glass/[0.12] pl-2">
      <div className="flex gap-1">
        <button
          onClick={() => setTab((t) => (t === 'files' ? null : 'files'))}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
            tab === 'files' ? 'bg-glass/10 text-ink' : 'text-dim hover:bg-glass/5'
          }`}
        >
          <Paperclip size={12} /> Files{fileCount > 0 && <span className="text-[10px] text-dim">{fileCount}</span>}
        </button>
        <button
          onClick={() => setTab((t) => (t === 'notes' ? null : 'notes'))}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
            tab === 'notes' ? 'bg-glass/10 text-ink' : 'text-dim hover:bg-glass/5'
          }`}
        >
          <StickyNote size={12} /> Notes{notes.trim() && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />}
        </button>
      </div>

      {tab === 'files' && (
        <div className="mt-1.5 max-h-64 space-y-2 overflow-y-auto pb-1">
          <div>
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-dim">Attached</div>
            {attachments.length === 0 ? (
              <div className="text-[10px] text-dim">Attach files with the clip in the message box.</div>
            ) : (
              attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-ink hover:bg-glass/5">
                  <FileText size={12} className="shrink-0 text-[#9fd0ff]" />
                  <span className="min-w-0 flex-1" title={attachmentExtractionSummary(a)}><span className="block truncate">{a.name}</span><span className="block truncate text-[9px] text-dim">{attachmentExtractionSummary(a)}</span></span>
                  <button onClick={() => open(a)} title="Open" className="shrink-0 rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink">
                    <ExternalLink size={12} />
                  </button>
                  <button onClick={() => download(a)} title="Download" className="shrink-0 rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink">
                    <Download size={12} />
                  </button>
                  <button onClick={() => onRemove(a.id)} title="Remove" className="shrink-0 rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink">
                    <X size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
          {built.length > 0 && (
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-dim">Built in this chat</div>
              {built.map((bA, i) => {
                const Icon = ARTIFACT_ICON[bA.kind] || FileText
                return (
                  <div key={i} className="flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-ink hover:bg-glass/5">
                    <Icon size={12} className="shrink-0 text-gold" />
                    <button onClick={() => onOpenBuilt(bA.mi)} className="flex-1 truncate text-left hover:text-ink" title="Open in chat (download from there)">
                      {bA.label}
                    </button>
                    <button onClick={() => onOpenBuilt(bA.mi)} title="Open" className="shrink-0 rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink">
                      <ExternalLink size={12} />
                    </button>
                    <button onClick={() => onDeleteBuilt(bA.mi)} title="Delete" className="shrink-0 rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink">
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <textarea
          value={notes}
          onChange={(e) => onNotes(e.target.value)}
          placeholder="Keep facts, context, instructions… Nalu reads these on every message in this chat."
          className="mt-1.5 h-28 w-full resize-y rounded-md border border-glass/15 bg-glass/[0.05] px-2 py-1.5 text-[11px] text-ink outline-none focus:border-glass/30"
        />
      )}
    </div>
  )
}

function Composer({
  visible,
  contextKey,
  accountToken,
  input,
  setInput,
  streaming,
  onSend,
  onStop,
  onKey,
  taRef,
  onAttach,
  attaching,
  attachments,
  onRemoveAttachment,
  dismissedIntent,
  onDismissIntent,
  thinkLevel,
}: {
  visible: boolean
  contextKey: string
  accountToken: string
  input: string
  setInput: (v: string) => void
  streaming: boolean
  onSend: () => void
  onStop: () => void
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  taRef: React.RefObject<HTMLTextAreaElement>
  onAttach: (files: FileList | File[]) => void
  attaching: boolean
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  dismissedIntent: string | null
  onDismissIntent: () => void
  thinkLevel: number
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [showTools, setShowTools] = useState(false)
  const voice = useComposerVoice({ contextKey, accountToken, getInput: () => taRef.current?.value || input, setInput })
  useEffect(() => {
    if (!visible && voice.phase !== 'idle') voice.cancel()
  }, [visible, voice.phase, voice.cancel])
  const listening = voice.phase === 'listening', transcribing = voice.phase === 'transcribing'
  // Programmatic dictation/reset changes must resize the same editable textarea.
  useEffect(() => {
    const t = taRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 160) + 'px'
  }, [input, taRef])
  const [dragOver, setDragOver] = useState(false)
  // Hide the chip when the user ×'d out of it for this exact prompt — editing
  // the text brings it back (the stored dismissal no longer matches).
  const intent = dismissedIntent === input.trim() ? null : detectIntent(input, attachments.some((a) => a.isImage))
  const pickTool = (t: (typeof STUDIO_TOOLS)[number]) => {
    setInput(t.tmpl(input.trim(), ''))
    setShowTools(false)
    setTimeout(() => taRef.current?.focus(), 20)
  }
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true) }}
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer?.files?.length) onAttach(e.dataTransfer.files)
      }}
      className={`ws-composer relative rounded-2xl border bg-glass/[0.11] backdrop-blur-2xl px-3 py-2.5 transition-colors ${dragOver ? 'border-accent ring-2 ring-accent/40' : intent ? 'border-accent/55 shadow-[0_0_0_1px_rgba(175,140,86,0.25)]' : 'border-glass/[0.14] focus-within:border-glass/20'}`}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-panel/80 backdrop-blur-sm">
          <span className="flex items-center gap-2 text-sm font-medium text-gold"><Paperclip size={15} /> Drop files or photos to attach</span>
        </div>
      )}
      {voice.message && <p role={voice.error ? 'alert' : 'status'} className="mb-2 text-xs leading-relaxed text-ink" aria-live="polite">{voice.message}</p>}
      {/* Live intent — highlights what this prompt will build. */}
      {intent && (
        <div className="mb-2 flex items-center gap-1.5">
          <span className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/15 py-1 pl-2.5 pr-1.5 text-[11px] font-medium text-gold">
            <Sparkles size={11} /> Creating: {intent}
            <button
              onClick={onDismissIntent}
              title="Just answer in text instead"
              aria-label="Answer in text instead"
              className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-gold/70 hover:bg-accent/25 hover:text-ink"
            >
              <X size={11} />
            </button>
          </span>
          <span className="text-[10px] text-dim">press Enter to build · × for a text answer</span>
        </div>
      )}
      {/* Attached files — shown right in the prompt so you can see they're there. */}
      {(attachments.length > 0 || attaching) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {attachments.map((a) => (
            <span key={a.id} className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-glass/15 bg-glass/[0.06] px-2 py-1 text-[11px] text-ink">
              {a.isImage && a.dataUrl ? (
                <img src={a.dataUrl} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
              ) : (
                <FileText size={12} className="shrink-0 text-[#9fd0ff]" />
              )}
              <span className="min-w-0" title={attachmentExtractionSummary(a)}><span className="block truncate">{a.name}</span><span className="block truncate text-[9px] text-dim">{attachmentExtractionSummary(a)}</span></span>
              <button onClick={() => onRemoveAttachment(a.id)} className="shrink-0 text-dim hover:text-ink" aria-label="Remove">
                <X size={11} />
              </button>
            </span>
          ))}
          {attaching && (
            <span className="flex items-center gap-1.5 rounded-lg border border-glass/15 bg-glass/[0.06] px-2 py-1 text-[11px] text-dim">
              <Loader2 size={11} className="animate-spin" /> reading…
            </span>
          )}
          {attachments.length > 0 && !attaching && (
            <span className="w-full text-[10px] text-dim">Kept in this chat for Nalu to reference — cleared from your prompt when you send.</span>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length) onAttach(e.target.files)
          e.target.value = ''
        }}
      />
      <div className="relative mb-0.5 shrink-0">
        {false && showTools && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setShowTools(false)} />
            <div className="absolute bottom-full left-0 z-40 mb-2 w-64 rounded-xl border border-glass/[0.12] bg-panel/95 p-1.5 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl">
              <div className="px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-gold">Studio — build anything</div>
              <div className="grid max-h-72 grid-cols-2 gap-1 overflow-y-auto p-0.5">
                {STUDIO_TOOLS.map((t) => {
                  const Icon = t.icon
                  return (
                    <button key={t.key} onClick={() => pickTool(t)}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-glass/[0.07]">
                      <Icon size={13} strokeWidth={1.6} className="shrink-0 text-gold" />
                      <span className="truncate text-[12px] text-ink">{t.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
      <button
        onClick={() => fileRef.current?.click()}
        disabled={attaching}
        title="Attach an image or file — photos, PDFs, docs, spreadsheets, code, data"
        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dim hover:text-ink hover:bg-glass/15 disabled:opacity-50"
        aria-label="Attach image or file"
      >
        {attaching ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={18} strokeWidth={1.75} />}
      </button>
      {voice.supported && (
        <button
          onClick={voice.toggle}
          aria-pressed={listening}
          title={transcribing ? 'Cancel transcription' : voice.phase === 'requesting' ? 'Cancel microphone request' : listening ? 'Finish voice input' : 'Dictate with your voice'}
          className={`mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-glass/15 disabled:opacity-60 ${listening ? 'text-red-400 animate-pulse' : transcribing ? 'text-gold' : 'text-dim hover:text-ink'}`}
          aria-label="Voice input"
        >
          {transcribing ? <Loader2 size={16} className="animate-spin" /> : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="5" y1="9" x2="5" y2="15" />
              <line x1="9.5" y1="5.5" x2="9.5" y2="18.5" />
              <line x1="14" y1="8" x2="14" y2="16" />
              <line x1="18.5" y1="10.5" x2="18.5" y2="13.5" />
            </svg>
          )}
        </button>
      )}
      {/* Plain, native textarea: its own text is visible, so copy/paste, backspace,
          selection and scrolling all "just work". The active thinking tier still shows
          in the badge to the right. Auto-grows to a cap, then scrolls inside itself. */}
      <div className="relative min-w-0 flex-1">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            const t = e.currentTarget
            t.style.height = 'auto'
            t.style.height = Math.min(t.scrollHeight, 160) + 'px'
          }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && input.trim() && voice.phase !== 'idle') voice.cancel(); onKey(event) }}
          onPaste={(e) => {
            // Paste images / videos / any file straight from the clipboard (e.g. a
            // screenshot, or a copied photo/video) → attach it. Plain text still pastes.
            const dt = e.clipboardData
            if (!dt) return
            const files: File[] = []
            if (dt.files && dt.files.length) for (const f of Array.from(dt.files)) files.push(f)
            else if (dt.items) for (const it of Array.from(dt.items)) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f) } }
            if (files.length) { e.preventDefault(); onAttach(files) }
          }}
          rows={1}
          placeholder="Ask Nalu anything…  (paste images or videos too)"
          className="w-full resize-none overflow-y-auto bg-transparent text-ink caret-ink outline-none text-[13.5px] placeholder:text-dim max-h-40 py-1 leading-normal [scrollbar-width:thin]"
          style={{ height: 'auto' }}
        />
      </div>
      {thinkLevel > 0 && (
        <div
          key={thinkLevel}
          className="think-badge mb-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px]"
          style={{ color: THINK_COLORS[THINK_NAMES[thinkLevel]], borderColor: THINK_COLORS[THINK_NAMES[thinkLevel]] }}
          title={thinkLevel === 3 ? 'Packmind — maximum reasoning' : thinkLevel === 2 ? 'Ultrathink — deeper reasoning' : 'Think — step-by-step reasoning'}
        >
          <Brain size={13} /> <span style={{ fontFamily: THINK_FONT, fontStyle: 'italic', fontWeight: 500 }}>{thinkLevel === 3 ? 'Packmind' : thinkLevel === 2 ? 'Ultrathink' : 'Think'}</span>
        </div>
      )}
      {streaming ? (
        <button
          onClick={onStop}
          className="w-8 h-8 rounded-lg bg-glass/10 hover:bg-glass/20 flex items-center justify-center shrink-0"
          aria-label="Stop"
        >
          <Square size={14} />
        </button>
      ) : (
        <button
          onClick={() => { if (voice.phase !== 'idle') voice.cancel(); onSend() }}
          disabled={!input.trim()}
          className="w-8 h-8 rounded-full bg-white text-black disabled:bg-glass/15 disabled:text-glass/40 flex items-center justify-center shrink-0 transition-colors"
          aria-label="Send"
        >
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      )}
      </div>
    </div>
  )
}
