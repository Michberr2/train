import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  FolderGit2,
  FolderInput,
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
  ChevronLeft,
  ChevronRight,
  Shield,
  MapPin,
  Sparkles,
  Wand2,
  Brain,
} from 'lucide-react'
import { streamChat, recoverToolCalls, findJsonObjects, isToolCallShape, type WireMessage } from './agentApi'
import { lazy, Suspense } from 'react'
import Markdown from './Markdown'
import { useTheme } from '../ThemeProvider'
import MediaLoader, { WolfWord } from './MediaLoader'
import CardErrorBoundary from './CardErrorBoundary'
import { extractAttachment, type Attachment } from './extractText'
import type { SheetDoc } from './SheetCard'
import { normalizeDoc } from './DocCard'
import type { DocDoc, DocBlock } from './DocCard'
import type { Deck } from './SlidesCard'
import type { DesignArtifact, DesignKind } from './types'
import { getBrand, ensureDefaultBrand, setBrand, deriveBrand } from './brandKit'
import BrandBar from './BrandBar'
// Heavy (three.js / pptxgenjs / docx / xlsx / fabric) — load only when a card is
// shown, so they never weigh down the main site bundle / slow the whole site.
const CADCard = lazy(() => import('./CADCard'))
const SlidesCard = lazy(() => import('./SlidesCard'))
const SheetCard = lazy(() => import('./SheetCard'))
const DocCard = lazy(() => import('./DocCard'))
// Nalu Studio kind→card switch (canvas/palette/brand/blueprint + DesignCard for
// webpage/poster). Lazy so fabric/jspdf/docx never touch the main bundle.
const DesignArtifactCard = lazy(() => import('./DesignArtifactCard'))
const AgentsPanel = lazy(() => import('./AgentsPanel'))
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
import StudioPanel, { TOOLS as STUDIO_TOOLS } from './StudioPanel'
import MapPanel from './MapPanel'
import ProjectsPanel from './ProjectsPanel'
import SkillsPanel from './SkillsPanel'
import AutomationsPanel from './AutomationsPanel'
import SettingsPanel from './SettingsPanel'
import { pushChatsFull } from '../../lib/sync'

// ---- model ---------------------------------------------------------------

interface Msg {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string // chain-of-thought (plain English) when Deep think is on
  sheet?: SheetDoc
  doc?: DocDoc
  video?: string
  cad?: string
  design?: DesignArtifact
  deck?: Deck
  attachments?: Attachment[] // files attached to this (user) message
  loading?: 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides'
}
interface Chat {
  id: string
  title: string
  messages: Msg[]
  createdAt: number
  notes?: string // freeform notes the AI references for this chat
  attachments?: Attachment[] // files attached to this chat (referenceable)
  projectId?: string // the project this chat belongs to (undefined = unfiled)
}
interface Project {
  id: string
  name: string
  createdAt: number
}

type View = 'chat' | 'studio' | 'map' | 'agents' | 'projects' | 'skills' | 'automations' | 'settings'

const CHATS_KEY = 'nalu-chats'
const ACTIVE_KEY = 'nalu-active-chat'
const MODEL_KEY = 'nalu-model'
// Tombstones: ids the user explicitly deleted. Append-only + synced, so a
// deletion is PERMANENT and never resurrected by a stale copy on any device.
const DELETED_CHATS_KEY = 'nalu-deleted-chats'
const DELETED_PROJECTS_KEY = 'nalu-deleted-projects'
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

// Split text into segments, marking the trigger words for highlighting.
function thinkSegments(text: string): { t: string; word?: string }[] {
  const out: { t: string; word?: string }[] = []
  let last = 0
  text.replace(THINK_WORDS, (m, _w, idx: number) => {
    if (idx > last) out.push({ t: text.slice(last, idx) })
    out.push({ t: m, word: m.toLowerCase() })
    last = idx + m.length
    return m
  })
  if (last < text.length) out.push({ t: text.slice(last) })
  return out
}

const NAV_ITEMS: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'chat', label: 'Chats', icon: MessageSquare },
  { view: 'studio', label: 'Studio', icon: Palette },
  { view: 'map', label: 'Map', icon: MapPin },
  { view: 'agents', label: 'AutoPilot', icon: Bot },
]

const VIEW_TITLES: Record<Exclude<View, 'chat'>, string> = {
  studio: 'Studio',
  map: 'Map',
  agents: 'AutoPilot',
  projects: 'Projects',
  skills: 'Skills',
  automations: 'Automations',
  settings: 'Settings',
}

const PROJECTS_KEY = 'nalu-chat-projects'
function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
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
      attachments: lightenAttachments(c.attachments, dropMedia ? 0 : 4000),
      messages: c.messages.map((m) => ({
        ...m,
        attachments: lightenAttachments(m.attachments, dropMedia ? 0 : 2000),
        // video/image are large base64 — drop only when over the size budget
        video: dropMedia && isDataUrl(m.video) ? undefined : m.video,
      })),
    }))
  let out = JSON.stringify(base(false))
  if (out.length > MAX) out = JSON.stringify(base(true)) // drop media, KEEP docs/sheets/decks/designs
  return out
}

function persistChats(chats: Chat[]): void {
  // 1) SERVER: always the complete, artifact-preserving payload.
  try { pushChatsFull(dbSerialize(chats)) } catch { /* sync best-effort */ }

  // 2) BROWSER localStorage: tier down to fit the ~5MB quota (docs still live
  //    on the server via step 1, so the browser copy can be slimmer).
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
          title: c.title,
          createdAt: c.createdAt,
          projectId: c.projectId,
          notes: typeof c.notes === 'string' ? c.notes.slice(0, 4000) : c.notes,
          messages: c.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '', reasoning: m.reasoning })),
        })),
      ),
    // Skeleton — guarantees the chat LIST (and every deletion) survives.
    () => JSON.stringify(chats.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, projectId: c.projectId, messages: [] }))),
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
  user: { displayName: string } | null
  onLogout: () => void
}

// A leading question word ("what is a business plan", "explain the report") is an
// explanation ask, not a build request — keep those in normal chat.
const QUESTION_LEAD = /^\s*(what(?:'s| is| are)?|explain|tell me|how (?:do|does|can|to)|why|define|who\b|when\b|where\b|can you (?:explain|tell)|difference between)/i

// Detect "make me an image" style asks → route to the image endpoint.
const IMAGE_INTENT =
  /\b(generate|create|make|draw|render|paint|sketch|produce|whip up)\b[^.?!]*\b(images?|pictures?|photos?|photographs?|illustrations?|artwork|drawings?|wallpapers?|portraits?|paintings?|avatars?|headshots?|backgrounds?)\b|\b(image|picture|photo|illustration|drawing|painting|portrait|render) of\b|^\/(image|img|draw)\b/i
function isImagePrompt(text: string): boolean {
  return IMAGE_INTENT.test(text)
}

// Detect "build me a spreadsheet / excel" style asks → spreadsheet builder.
const SHEET_INTENT =
  /\b(spread ?sheets?|excels?|xlsx?|\.xls|google ?sheets?|pivot tables?|work ?books?|balance sheets?|cap tables?|time ?sheets?)\b|^\/(sheet|excel|xls)\b|\b(make|build|create|generate|do|put together|whip up|prepare|need|want|give me)\b[^.?!]*\b(spread ?sheets?|sheets?|tables?|trackers?|budgets?|rosters?|schedules?|inventory|ledgers?|gantt|workbooks?|financial models?|calculators?|p ?& ?l|income statements?)\b/i
function isSheetPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  if (MEDIA_OF.test(text)) return false
  return SHEET_INTENT.test(text)
}

// Detect "write me a business plan / doc / report" → route to the doc builder.
// "video of X" / "animate X" is a VIDEO ask no matter what nouns X contains
// ("video of a floor plan" was routing to the document builder).
const MEDIA_OF =
  /\b(generate|create|make|produce|render|do|whip up|film|shoot)\b[^.?!]*\b(videos?|animations?|clips?|movies?|reels?|gifs?)\b|\b(videos?|animations?|clips?|movies?|reels?|gifs?)\s+(of|showing|about|that|where|with|using|from|for)\b|^\/video\b|\banimate\b|\b(generate|create|make)\b[^.?!]*\b(image|photo|picture)s?\b/i

// Long-form works: books, scientific articles, theses, big legal instruments,
// anything with an explicit large page/chapter count. These run the chaptered
// outline→sections pipeline (no length cap) instead of the one-shot doc call.
const LONGFORM_INTENT =
  /\b(books?|novels?|novellas?|manuscripts?|memoirs?|textbooks?|monographs?|dissertations?|thesis|theses|scientific (articles?|papers?|reviews?)|research (articles?|papers?)|journal articles?|literature reviews?|systematic reviews?|comprehensive (guide|manual|treatise)|treatises?)\b|\b(\d{2,3})[- ]?(page|pages|chapter|chapters)\b|\b(long[- ]form|full[- ]length)\b/i
function isLongDocPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  if (MEDIA_OF.test(text)) return false
  return LONGFORM_INTENT.test(text) && (isDocPrompt(text) || /\b(write|draft|create|make|produce|generate)\b/i.test(text))
}

// Studio memory: follow-up edit verbs — a request like "make the roof bigger"
// revises the LAST matching artifact in this chat instead of starting over.
const STUDIO_EDIT_VERB =
  /\b(make|change|turn|add|remove|delete|update|fix|swap|adjust|edit|revise|recolou?r|resize|move|replace|rename|redo|restyle|rewrite|shorten|lengthen|expand|animate|center|align|darker|lighter|bigger|smaller|instead|actually|tweak)\b/i

const DOC_INTENT =
  /\b(business plans?|marketing plans?|project plans?|word documents?|word docs?|google docs?|\.docx|reports?|proposals?|white ?papers?|cover letters?|résumés?|resumes?|\bcvs?\b|memos?|press releases?|essays?|write-?ups?|one ?pagers?|documents?)\b|^\/(doc|word)\b|\b(write|draft|create|build|make|generate|do|put together|prepare|whip up|need|want|give me)\b[^.?!]*\b(plans?|reports?|proposals?|essays?|letters?|documents?|docs?|memos?|briefs?|white ?papers?|whitepapers?|pdfs?|articles?|write-?ups?|one ?pagers?)\b/i
function isDocPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  if (MEDIA_OF.test(text)) return false
  return DOC_INTENT.test(text)
}

// Detect "make me a video" style asks → route to the video endpoint.
const VIDEO_INTENT =
  /\b(generate|create|make|produce|render|do|whip up)\b[^.?!]*\b(videos?|animations?|clips?|movies?|reels?|gifs?)\b|\banimate\b|\bvideo of\b|^\/video\b/i
function isVideoPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  return VIDEO_INTENT.test(text)
}

// CAD / 3D-model / AutoCAD intent → inline Nalu CAD viewer.
const CAD_INTENT =
  /\b(auto ?cad|open ?scad|\bcad\b|cad (?:model|part|design|file)|3d models?|3d-?print(?:ed|able)?|3d print|stl files?|\.stl\b|parametric (?:part|model|design))\b|^\/cad\b|\b(design|model|make|build|create|3d ?print)\b[^.?!]*\b(brackets?|gears?|flanges?|enclosures?|housings?|mounts?|bolts?|nuts?|screws?|gadgets?|widgets?|knobs?|hooks?|stands?|holders?|adapters?|spacers?|cases?|clips?|parts?|fixtures?|jigs?|vases?|containers?)\b/i
function isCadPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  if (MEDIA_OF.test(text)) return false
  return CAD_INTENT.test(text)
}

// Web/UI design intent → inline Nalu Design (live HTML artifact).
const DESIGN_INTENT =
  /\b(web ?sites?|web ?pages?|landing pages?|web ?apps?|html pages?|web design|user interface|dashboard ui|web components?|infographics?|posters?|home ?pages?)\b|^\/design\b|\b(design|build|create|make|code|develop)\b[^.?!]*\b(web ?site|landing page|web ?page|web ?app|\bui\b|interface|dashboard|html|web component|hero section|pricing page|home ?page|\bsite\b)\b/i
function isDesignPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  return DESIGN_INTENT.test(text)
}

// ---- Nalu Studio sub-type routing (most-specific first) --------------------
// Every creative ask resolves to one DesignKind sent to /api/design as
// {prompt, kind}; the server trusts the client's kind (no guessing).
const PALETTE_INTENT =
  /\b(colou?r ?palettes?|colou?r ?schemes?|swatch(?:es)?|colou?r ?themes?|colou?r ?combos?|colou?r ?combinations?|\bpalettes?\b|hex(?: codes?)?)\b|^\/palette\b/i
const BRAND_INTENT =
  /\b(brand(?:ing)? guidelines?|brand identit(?:y|ies)|brand kits?|style ?guides?|visual identit(?:y|ies)|brand books?|brand guides?)\b|^\/brand\b/i
const BLUEPRINT_INTENT =
  /\b(blue ?prints?|floor ?plans?|floorplans?|house plans?|site plans?|building plans?|technical drawings?|schematics?|annotated (?:diagram|drawing)|elevations?|wireframe diagram)\b|^\/blueprint\b/i
// House / interior-design / walkthrough asks → a blueprint (which carries the
// 3D model + first-person walkthrough + furnish tools). Catches "make a
// walkthrough of a mansion", "design my house", "3d home tour", etc. The
// negative lookahead keeps web/app/logo asks ("design a home page") out.
const WALKTHROUGH_INTENT =
  /\b(walk\s?through|walk-through|house\s?tour|home\s?tour|3d\s?(?:house|home|tour|walk))\b|\b(design|build|make|create|model|render|lay\s?out)\b(?![^.?!]*\b(website|web ?app|web ?page|home ?page|landing page|app|logo|poster|deck|slide)\b)[^.?!]{0,40}\b(house|home|mansion|villa|apartment|condo|bungalow|cottage|floor ?plan|bedroom|kitchen|bathroom|living room)\b|^\/(walkthrough|house|home|tour)\b/i
const LOGO_INTENT =
  /\b(logos?|logotypes?|word ?marks?|brand ?marks?|logo ?marks?|app ?icons?|monograms?|emblems?|logo design|favicons?|lockups?)\b|^\/logo\b/i
const SHOP_INTENT =
  /\b(shop(?:ping)?(?: for| list)?|buy|purchase|where (?:can|do) i (?:get|buy)|add to cart|furnish(?:ing)? (?:list|my)|outfit (?:my|the)|things i (?:need|should buy))\b[^.?!]*\b(room|house|home|apartment|bedroom|kitchen|living|bathroom|office|desk|setup|outfit|nursery|patio|furniture|items?)\b|^\/shop\b/i
const CANVAS_INTENT =
  /\b(editable|vector|figma|canvas|social (?:post|graphic)|instagram (?:post|story)|flyer|poster art|graphic)\b[^.?!]*\b(design|make|create|graphic|post|canvas)\b|\beditable (?:design|graphic|canvas)\b|\bfigma-?like\b|^\/canvas\b/i
// Motion graphics → an animated, looping self-contained HTML "HyperFrame".
const CAROUSEL_INTENT =
  /\b(carousel|slide ?show|swipe ?post|multi.?slide|instagram (post|carousel)|ig (post|carousel)|linkedin (post|carousel)|social (media )?(post|carousel)|tiktok slides?|photo ?dump)\b/i
const MOTION_INTENT =
  /\b(motion graphic|animated|animation|kinetic typography|title card|logo (?:reveal|animation|intro)|promo (?:video|animation)|loop(?:ing)? (?:animation|background|graphic)|intro animation|lower third|hyperframe|gif-?style)\b|^\/(motion|animate)\b/i
// Playable games → a self-contained PlayCanvas HTML game (Nalu Game Studio).
const GAME_INTENT =
  /\b(make|build|create|generate|code|design|develop|program|write)\b[^.?!]*\b(video ?game|game|platformer|shoot-?(?:er|em-?up)|arcade game|endless runner|tower defense|rpg|maze game|pong|snake game|flappy|breakout|tetris|racing game|driving game|first-?person|fps game)\b|\b(playable (?:game|demo)|mini-?games?|2d game|3d game|browser game|game where you)\b|^\/game\b/i

/** Resolve a creative ask to a DesignKind, or null to fall through to the agent
 *  loop. Order: logo → palette → brand → blueprint → canvas → poster/webpage. */
function designKind(text: string): DesignKind | null {
  // A plain "what is a logo / explain palettes" question stays in chat.
  if (QUESTION_LEAD.test(text)) return null
  // Specific, high-confidence creative kinds win first.
  if (SHOP_INTENT.test(text)) return 'shopping'
  // Game before motion so "make an animated platformer game" builds a game.
  if (GAME_INTENT.test(text)) return 'game'
  // Carousel before generic design so "instagram carousel post" is slides, not a site.
  if (CAROUSEL_INTENT.test(text)) return 'carousel'
  // Motion before logo so "animated logo reveal" is a motion graphic, not a logo.
  if (MOTION_INTENT.test(text)) return 'motion'
  if (LOGO_INTENT.test(text)) return 'logo'
  if (PALETTE_INTENT.test(text)) return 'palette'
  if (BRAND_INTENT.test(text)) return 'brand'
  if (BLUEPRINT_INTENT.test(text)) return 'blueprint'
  // An EXPLICIT document / spreadsheet / deck ask always beats the greedy
  // house/room walkthrough matcher and the generic webpage fallback below — so
  // "excel budget for my house" or "powerpoint about my mansion" route correctly.
  if (isSheetPrompt(text) || isSlidesPrompt(text) || isDocPrompt(text)) return null
  if (WALKTHROUGH_INTENT.test(text)) return 'blueprint'
  if (CANVAS_INTENT.test(text)) return 'canvas'
  if (isDesignPrompt(text)) return /\b(poster|infographic)\b/i.test(text) ? 'poster' : 'webpage'
  return null
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
  const t = text.trim()
  if (t.length < 4) return null
  if (hasImages && BREAKDOWN_INTENT.test(t)) return 'Breakdown board'
  if (isVideoPrompt(t)) return 'Video' // video asks outrank every other artifact
  if (isLongDocPrompt(t) && !isSheetPrompt(t)) return 'Long-form document'
  if (isDocPrompt(t) && !isSheetPrompt(t)) return 'Document'
  if (isSlidesPrompt(t)) return 'PowerPoint'
  if (isCadPrompt(t)) return '3D model'
  const k = designKind(t)
  if (k) {
    if (k === 'blueprint' && WALKTHROUGH_INTENT.test(t) && !BLUEPRINT_INTENT.test(t)) return '3D walkthrough'
    return KIND_LABEL[k] || 'Design'
  }
  if (isSheetPrompt(t)) return 'Spreadsheet'
  if (isImagePrompt(t)) return 'Image'
  return null
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

// Presentation intent → inline Nalu Slides (PowerPoint / PDF).
const SLIDES_INTENT =
  /\b(pitch decks?|slide ?decks?|presentations?|power ?points?|pptx?|slide ?shows?|slides?|keynotes?|google slides|decks?)\b|^\/(slides|deck|ppt)\b|\b(make|build|create|design|generate|do|put together|whip up|prepare)\b[^.?!]*\b(decks?|presentations?|slides?|pitch|slideshow)\b/i
function isSlidesPrompt(text: string): boolean {
  if (QUESTION_LEAD.test(text)) return false
  if (MEDIA_OF.test(text)) return false
  return SLIDES_INTENT.test(text)
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

// Every tool the agent can call — used to strip ANY tool-call syntax from what
// the user sees, in whatever format the model emits it.
const ALL_TOOL_SPECS = [...WEB_TOOLS, ...TOOLS]
const TOOL_NAME_RE = new RegExp(
  `\\b(${ALL_TOOL_SPECS.map((t) => t.function.name).join('|')})\\b`,
  'i',
)

// Guarantee the user NEVER sees tool-call code, in ANY format the model invents
// (<invoke> XML, JSON fenced/bare, Python/function-call). The answer is
// always clean prose — tools run separately. We reuse recoverToolCalls' stripper,
// then aggressively nuke any leftover markup.
function cleanForDisplay(s: string): string {
  if (!s) return s
  // Shield ```chart blocks (real inline-chart data, incl. still-streaming ones)
  // from the tool-call strippers — their JSON ({"name": …}) looks exactly like
  // a dropped tool call to the heuristics below.
  const chartGuards: string[] = []
  const shielded = s.replace(/```chart\b[\s\S]*?(?:```|$)/gi, (m) => {
    chartGuards.push(m)
    return `\u0000CHART${chartGuards.length - 1}\u0000`
  })
  // Primary: the full recovery stripper removes all recognized tool-call forms.
  let out = recoverToolCalls(shielded, ALL_TOOL_SPECS).cleaned
  // Belt-and-suspenders for partial/streaming/garbled output:
  out = out
    .replace(/<\/?think>/gi, '')
    // any invoke/parameter/function_calls XML (closed, unclosed, or orphan tags)
    .replace(/<\s*(?:antml:)?(?:invoke|function_calls?)\b[\s\S]*?(?:<\s*\/\s*(?:antml:)?(?:invoke|function_calls?)\s*>|$)/gi, '')
    .replace(/<\s*\/?\s*(?:antml:)?(?:invoke|parameter|function_calls?|tool_call)\b[^>]*>/gi, '')
    // a fenced code block is hidden ONLY if it's a tool call (names a tool or has
    // a function/params key) — real code the user asked for is preserved
    .replace(/```[\w]*\s*([\s\S]*?)```/g, (m, body: string) =>
      TOOL_NAME_RE.test(body) || /["'](?:function|tool|tool_name|recipient_name|params)["']\s*:/.test(body) ? '' : m,
    )
  // bare tool-call JSON objects dropped mid-text
  for (const raw of findJsonObjects(out)) {
    try {
      if (isToolCallShape(JSON.parse(raw))) out = out.split(raw).join('')
    } catch {
      /* not JSON — leave it */
    }
  }
  // a trailing, still-streaming unclosed tool call (fence, object, or invoke)
  out = out
    .replace(/```[\w]*\s*[\s\S]*$/i, (m: string) => (TOOL_NAME_RE.test(m) || /["'](?:function|tool|params|query|url|path)["']/.test(m) ? '' : m))
    .replace(/\{\s*["'](?:function|tool|name|recipient_name|query|url|path)["']\s*:[\s\S]*$/i, '')
    .replace(new RegExp(`(?:tool_call|invoke)?\\s*${TOOL_NAME_RE.source}\\s*[({][\\s\\S]*$`, 'i'), (m: string) => (TOOL_NAME_RE.test(m) ? '' : m))
  out = out.replace(/\u0000CHART(\d+)\u0000/g, (_, i: string) => chartGuards[+i] || '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// Deep-think split: while the model is reasoning, the chain-of-thought (plain
// English) sits on the LEFT, the answer on the RIGHT, divided by a light-grey
// line. When the turn finishes the thoughts slide out and the answer goes
// full-width, leaving a "View thinking" button to reopen the left pane.
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
    if (wasLive.current && !isLive) setOpen(false) // finished → slide thoughts out
    if (!wasLive.current && isLive) setOpen(true) // a new turn started → reopen
    wasLive.current = isLive
  }, [isLive])

  if (!reasoning) return <>{children}</>

  return (
    <div className="flex items-stretch">
      {/* Left: thoughts in plain English. Slides out when thinking finishes. */}
      <div
        aria-hidden={!open}
        className={`min-w-0 shrink-0 overflow-hidden transition-all duration-300 ease-out ${
          open ? 'mr-3 w-[42%] border-r border-glass/[0.2] pr-3 opacity-100' : 'w-0 opacity-0'
        }`}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-dim">
          <Brain size={12} /> Thinking
          <button
            onClick={() => setOpen(false)}
            className="ml-auto rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink"
            title="Hide thinking"
          >
            <ChevronLeft size={13} />
          </button>
        </div>
        <div className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed text-dim ${isLive ? 'streaming-caret' : ''}`}>
          {cleanForDisplay(reasoning)}
        </div>
      </div>
      {/* Right: the answer. Goes full-width once thoughts slide out. */}
      <div className="min-w-0 flex-1">
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-glass/[0.14] bg-glass/[0.05] px-2.5 py-1 text-xs text-dim transition-colors hover:bg-glass/10 hover:text-ink"
          >
            <Brain size={12} /> View thinking
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

export default function Workspace({ user, onLogout }: Props) {
  // Restore the last view on refresh (Studio/Map/AutoPilot/Chats) — back to your
  // last touch point. Skip 'settings' so a refresh never dumps you into settings.
  const [view, setView] = useState<View>(() => {
    const v = localStorage.getItem('nalu-view') as View | null
    return v && v !== 'settings' ? v : 'chat'
  })
  const [model] = useState<string>(() => loadModel())
  const [chats, setChats] = useState<Chat[]>(() => loadChats())
  const [projects, setProjects] = useState<Project[]>(() => loadProjects())
  // Active project: undefined = "All chats". New chats are filed under it.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [newProjectName, setNewProjectName] = useState<string | null>(null) // inline create
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
  const { isDark, toggleTheme } = useTheme()
  // Light mode = black logo; dark mode = white (inverted) logo.
  const logoClass = `brightness-0 ${isDark ? 'invert' : ''}`
  const [routeName, setRouteName] = useState('Nalu')
  const [query, setQuery] = useState('')
  // Sidebar is a push-column on desktop but an off-canvas overlay on phones, so
  // it defaults open on desktop and closed on mobile (chat gets the full width).
  // Start collapsed so the chat gets the full, clean width on open; the user
  // can flip it open with the panel toggle whenever they want.
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false)
  }, [])
  const abortRef = useRef<AbortController | null>(null)
  const lastCadCodeRef = useRef('') // current CAD model, so follow-ups edit it
  const lastSentPromptRef = useRef('') // stopped mid-generation → prompt returns for editing
  const chatsRef = useRef<Chat[]>([]) // always-latest chats (for reads after awaits)
  const attachPromiseRef = useRef<Promise<void> | null>(null) // in-flight extraction
  const scrollRef = useRef<HTMLDivElement>(null)
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
  useEffect(() => {
    chatsRef.current = chats
    persistChats(chats)
  }, [chats])
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId)
    setPendingIds([]) // a different chat → no carried-over prompt chips
  }, [activeId])
  // Remember the current view so a refresh returns to your last touch point.
  useEffect(() => { if (view !== 'settings') localStorage.setItem('nalu-view', view) }, [view])
  useEffect(() => {
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects))
    } catch {
      /* ignore */
    }
  }, [projects])

  const createProject = useCallback((name: string) => {
    const n = name.trim()
    if (!n) return
    const id = uid()
    setProjects((ps) => [{ id, name: n, createdAt: Date.now() }, ...ps])
    setActiveProjectId(id)
    setNewProjectName(null)
  }, [])
  const deleteProject = useCallback((id: string) => {
    addTombstone(DELETED_PROJECTS_KEY, id) // permanent — survives re-sync from any device
    // Unfile this project's chats (keep them under "All"), then drop the project.
    setChats((cs) => cs.map((c) => (c.projectId === id ? { ...c, projectId: undefined } : c)))
    setProjects((ps) => ps.filter((p) => p.id !== id))
    setActiveProjectId((cur) => (cur === id ? null : cur))
  }, [])
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
      if (m.video) out.push({ kind: 'video', label: 'Video', mi: i })
    })
    return out
  }, [active])

  // Everything Nalu has built across ALL chats — the Studio gallery previews it.
  const creations = useMemo(() => {
    const out: { key: string; chatId: string; mi: number; kind: string; title: string; html?: string; img?: string }[] = []
    chats.forEach((c) =>
      c.messages.forEach((m, mi) => {
        const base = { key: `${c.id}:${mi}`, chatId: c.id, mi }
        if (m.design) {
          const d = m.design as { kind: string; html?: string; name?: string }
          out.push({ ...base, kind: d.kind, title: d.name || c.title || d.kind, html: typeof d.html === 'string' ? d.html : undefined })
        } else if (m.deck) out.push({ ...base, kind: 'deck', title: m.deck.title || c.title || 'Presentation' })
        else if (m.sheet) out.push({ ...base, kind: 'sheet', title: m.sheet.title || c.title || 'Spreadsheet' })
        else if (m.doc) out.push({ ...base, kind: 'doc', title: m.doc.title || c.title || 'Document' })
        else if (m.video) out.push({ ...base, kind: 'video', title: c.title || 'Video' })
        else if (m.cad) out.push({ ...base, kind: 'cad', title: c.title || 'CAD model' })
        else if (m.role === 'assistant' && typeof m.content === 'string') {
          // Generated images live as markdown in the message text.
          const im = m.content.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
          if (im) out.push({ ...base, kind: 'image', title: c.title || 'Image', img: im[1] })
        }
      }),
    )
    return out.reverse()
  }, [chats])

  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const scrollToMsg = useCallback((mi: number) => {
    msgRefs.current[mi]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])
  // Open a Studio creation in its chat (switch chat + view, then scroll to it).
  const openCreation = useCallback((chatId: string, mi: number) => {
    setActiveId(chatId)
    setView('chat')
    closeSidebarOnMobile()
    setTimeout(() => scrollToMsg(mi), 140)
  }, [scrollToMsg])
  const deleteMessage = useCallback(
    (mi: number) => {
      if (!activeId) return
      setChats((cs) =>
        cs.map((c) => (c.id === activeId ? { ...c, messages: c.messages.filter((_, i) => i !== mi) } : c)),
      )
    },
    [activeId],
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, streaming])

  const newChat = useCallback(() => {
    // Do NOT abort in-flight work — a video/doc generation keeps running in the
    // background and lands in ITS chat even after you move on.
    setStreaming(false)
    setActiveId(null)
    setInput('')
    setView('chat')
    taRef.current?.focus()
  }, [])

  const deleteChat = useCallback((id: string) => {
    addTombstone(DELETED_CHATS_KEY, id) // permanent — survives re-sync from any device
    setChats((cs) => cs.filter((c) => c.id !== id))
    setActiveId((cur) => (cur === id ? null : cur))
  }, [])

  // Move a chat into a project (or out, projectId = null).
  const [chatMenu, setChatMenu] = useState<string | null>(null) // which chat's "move" menu is open
  const moveChatToProject = useCallback((chatId: string, projectId: string | null) => {
    setChats((cs) => cs.map((c) => (c.id === chatId ? { ...c, projectId: projectId ?? undefined } : c)))
    setChatMenu(null)
  }, [])

  // ---- Attachments + Notes (per chat, referenced by the AI) ----------------
  const [attaching, setAttaching] = useState(false)
  // Attachments just added but not yet sent — these show as chips in the prompt.
  // After sending they clear from the prompt but stay saved (drawer + AI context).
  const [pendingIds, setPendingIds] = useState<string[]>([])

  // Ensure there's an active chat to hang attachments/notes on; returns its id.
  const ensureChat = useCallback((): string => {
    if (activeId && chats.some((c) => c.id === activeId)) return activeId
    const id = uid()
    setChats((cs) => [{ id, title: 'New chat', messages: [], createdAt: Date.now(), projectId: activeProjectId ?? undefined }, ...cs])
    setActiveId(id)
    setView('chat')
    return id
  }, [activeId, chats, activeProjectId])

  const addAttachments = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (!list.length) return
      const id = ensureChat()
      setAttaching(true)
      // Record the in-flight extraction so send() can WAIT for it — otherwise a
      // question sent before a slow PDF finishes parsing would miss the file.
      const job = (async () => {
        try {
          const extracted = await Promise.all(list.map((f) => extractAttachment(f)))
          setChats((cs) =>
            cs.map((c) => (c.id === id ? { ...c, attachments: [...(c.attachments || []), ...extracted] } : c)),
          )
          setPendingIds((ids) => [...ids, ...extracted.map((e) => e.id)])
        } finally {
          setAttaching(false)
        }
      })()
      attachPromiseRef.current = job
      await job
      if (attachPromiseRef.current === job) attachPromiseRef.current = null
    },
    [ensureChat],
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
    async (text: string, opts?: { keepView?: boolean }) => {
      const content = text.trim()
      if (!content || streaming) return
      // If the user ×'d out of the intent chip for this exact prompt, skip every
      // studio/artifact route and answer in plain chat instead.
      const plain = dismissedIntent !== null && dismissedIntent === content
      setInput('')
      setDismissedIntent(null)
      setPendingIds([]) // attachments stay saved (drawer + AI), just clear the prompt chips

      // Resolve the target chat id + full history SYNCHRONOUSLY from current
      // state — never from inside the setChats updater (which React runs
      // later), so the page switches to the conversation immediately instead
      // of leaving you on the home screen having to click into the chat.
      lastSentPromptRef.current = content
      const chatId = activeId ?? uid()
      const existing = chats.find((c) => c.id === chatId)
      const history: Msg[] = [...(existing?.messages ?? []), { role: 'user', content }]

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
      const ctxChat = chatsRef.current.find((c) => c.id === chatId) || existing
      // Images attached to this chat (downscaled on import) — fed to the vision
      // model AND embeddable into generated docs.
      const imageAtts = (ctxChat?.attachments || []).filter((a) => a.isImage && a.dataUrl)
      const ctxParts: string[] = []
      if (ctxChat?.notes && ctxChat.notes.trim())
        ctxParts.push(`## Notes (kept by the user for you to reference)\n${ctxChat.notes.trim()}`)
      for (const a of ctxChat?.attachments || []) {
        if (a.isImage) {
          // The image itself is sent to the vision model as an image part below;
          // here just name it so text-only paths (doc/sheet) know it exists.
          ctxParts.push(`## Attached image: ${a.name}`)
        } else {
          ctxParts.push(`## Attached document: ${a.name}\n${a.text}${a.truncated ? '\n…[truncated]' : ''}`)
        }
      }
      const ctxBlock = ctxParts.length
        ? `\n\n---\n[Attached context for this request — use it; don't repeat it verbatim.]\n\n${ctxParts.join('\n\n---\n\n')}`
        : ''
      // For artifact generators (doc/sheet/slides/design/cad) we fold the context
      // into the prompt; the chat path injects it as a separate message below.
      const withCtx = (prompt: string) => (ctxBlock ? prompt + ctxBlock : prompt)

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
          next = [{ id: chatId, title, messages: [], createdAt: Date.now(), projectId: activeProjectId ?? undefined }, ...cs]
        }
        return next.map((c) =>
          c.id === chatId
            ? { ...c, messages: [...history, { role: 'assistant', content: '' }] }
            : c,
        )
      })
      setActiveId(chatId)
      // Generating from the Studio keeps you IN the Studio (the result previews
      // there); every other path jumps to the chat where the reply streams.
      if (!opts?.keepView) setView('chat')

      const wire: WireMessage[] = history.map((m) => ({ role: m.role, content: m.content }))
      const ctrl = new AbortController()
      abortRef.current = ctrl

      // ---- HOLISTIC INTENT — understand the whole prompt, cleanly. Fast regex
      // decides clear cases instantly; when signals CONFLICT (or a build-ish ask
      // matches nothing), a quick LLM classifier reads the whole message and
      // picks the single intended output; `forcedKind` overrides routing below. ----
      let forcedKind: string | null = null
      if (!plain) {
        const cand: string[] = []
        if (isVideoPrompt(content)) cand.push('video')
        if (isImagePrompt(content)) cand.push('image')
        if (isSheetPrompt(content)) cand.push('spreadsheet')
        if (isSlidesPrompt(content)) cand.push('slides')
        if (isCadPrompt(content)) cand.push('cad')
        if (isDocPrompt(content) && !isSheetPrompt(content)) cand.push(isLongDocPrompt(content) ? 'book' : 'document')
        const dkGuess = designKind(content)
        if (dkGuess) cand.push(dkGuess === 'webpage' ? 'website' : dkGuess)
        const uniq = [...new Set(cand)]
        const buildish = /\b(make|build|create|design|generate|produce|write|draft|do|put together|whip up|render|film|shoot)\b/i.test(content)
        if (uniq.length >= 2 || (uniq.length === 0 && buildish && content.length > 24)) {
          try {
            const cr = await fetch('/api/web', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'intent', prompt: content, signals: uniq, hasImage: imageAtts.length > 0 }),
              signal: ctrl.signal,
            })
            const cj = (await cr.json().catch(() => ({}))) as { kind?: string }
            if (cj.kind && cj.kind !== 'chat') forcedKind = cj.kind
          } catch { /* classifier optional — fall back to regex order */ }
        }
      }
      // Translate the classifier's decision into the branch predicates. When the
      // classifier fired, EXACTLY one route is true and the rest are forced off.
      const wantK = (k: string, fallback: boolean): boolean => (forcedKind ? forcedKind === k : fallback)
      setStreaming(true)

      let acc = ''
      let accReasoning = ''
      let accSheet: SheetDoc | undefined
      let accDoc: DocDoc | undefined
      let accVideo: string | undefined
      let accCad: string | undefined
      let accDesign: DesignArtifact | undefined
      let accDeck: Deck | undefined
      let accLoading: 'image' | 'sheet' | 'doc' | 'video' | 'cad' | 'design' | 'slides' | undefined
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
            msgs[msgs.length - 1] = {
              role: 'assistant',
              content,
              reasoning: accReasoning || undefined,
              sheet: accSheet,
              doc: accDoc,
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
        if (!revealRaf) revealRaf = requestAnimationFrame(reveal)
      }

      // Photo → executive breakdown board: real vision analysis of the attached
      // photo(s), then a premium presentation board built from that analysis,
      // with the actual photo embedded via {{PHOTO_n}} placeholders.
      if (!plain && imageAtts.length > 0 && wantK('board', BREAKDOWN_INTENT.test(content))) {
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
        const msgs = ctxChat?.messages || []
        const out: { doc?: DocDoc; sheet?: SheetDoc; deck?: Deck; cad?: string; designs: Record<string, DesignArtifact>; recent?: { type: string; kind?: string } } = { designs: {} }
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
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
        if (plain || !STUDIO_EDIT_VERB.test(content) || content.length > 500) return null
        if (/\b(new|another|fresh|separate)\b[^.?!]*\b(doc|document|sheet|deck|site|game|logo|poster|design|blueprint|video)\b/i.test(content)) return null
        if (isVideoPrompt(content) || isImagePrompt(content)) return null
        const T: Array<[RegExp, { type: string; kind?: string }]> = [
          [/\b(slides?|deck|presentation|powerpoint)\b/i, { type: 'deck' }],
          [/\b(spreadsheet|sheet|workbook|tab|column|row|cell|formula)\b/i, { type: 'sheet' }],
          [/\b(blueprint|floor ?plan)\b/i, { type: 'design', kind: 'blueprint' }],
          [/\blogo\b/i, { type: 'design', kind: 'logo' }],
          [/\bpalette\b/i, { type: 'design', kind: 'palette' }],
          [/\bposter\b/i, { type: 'design', kind: 'poster' }],
          [/\b(carousel|slideshow|swipe post|social post)\b/i, { type: 'design', kind: 'carousel' }],
          [/\b(brand book|brand guide(lines)?)\b/i, { type: 'design', kind: 'brand' }],
          [/\bgame\b/i, { type: 'design', kind: 'game' }],
          [/\b(animation|motion graphic)\b/i, { type: 'design', kind: 'motion' }],
          [/\bboard\b/i, { type: 'design', kind: 'board' }],
          [/\b(website|web ?page|site|landing page|hero|nav(bar)?|homepage)\b/i, { type: 'design', kind: 'webpage' }],
          [/\b(3d model|cad\b)\b/i, { type: 'cad' }],
          [/\b(document|\bdoc\b|report|letter|memo|essay|article|chapter|the book)\b/i, { type: 'doc' }],
        ]
        const has = (t: { type: string; kind?: string }) =>
          t.type === 'doc' ? !!lastArts.doc : t.type === 'sheet' ? !!lastArts.sheet : t.type === 'deck' ? !!lastArts.deck : t.type === 'cad' ? !!lastArts.cad : !!(t.kind && lastArts.designs[t.kind])
        for (const [re, t] of T) if (re.test(content) && has(t)) return t
        // a short bare follow-up ("make it more minimal") targets the most recent artifact
        if (content.length < 160 && lastArts.recent && has(lastArts.recent) && !isDocPrompt(content) && !isSheetPrompt(content) && !isSlidesPrompt(content)) return lastArts.recent
        return null
      })()

      // doc / sheet / deck follow-up edits → revise-in-place via prev payloads
      if (editTarget?.type === 'doc' && lastArts.doc) {
        setRouteName('Nalu Docs — editing')
        accLoading = 'doc'
        flush()
        try {
          const r = await fetch('/api/doc', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content), prevDoc: JSON.stringify(lastArts.doc).slice(0, 90000), images: [] }),
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
          if (r.ok && Array.isArray(data.sheets) && data.sheets.length) { accSheet = data; acc = '' }
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
          if (r.ok && Array.isArray(data.slides) && data.slides.length) { accDeck = data; acc = '' }
          else acc = `⚠️ ${data.error || `Edit failed ${r.status}`}`
        } catch (e) { accLoading = undefined; if (!ctrl.signal.aborted) acc = `⚠️ ${e instanceof Error ? e.message : 'Edit failed'}` }
        flush(); setStreaming(false); setRouteName('Nalu'); abortRef.current = null
        return
      }

      // LONG-FORM: books / scientific articles / big legal documents — outline
      // first, then every chapter generated in turn and streamed into the doc
      // as it grows. No page cap; a failed chapter retries then is skipped.
      if (!plain && wantK('book', isLongDocPrompt(content) && !isSheetPrompt(content))) {
        setRouteName('Nalu Docs — long form')
        accLoading = 'doc'
        flush()
        try {
          const boost = await runBoost('Nalu Docs')
          const or = await fetch('/api/doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) + boost, mode: 'outline' }),
            signal: ctrl.signal,
          })
          const outline = (await or.json().catch(() => ({}))) as {
            title?: string; subtitle?: string; cover?: string; kind?: string
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
          accDoc = normalizeDoc({ title: outline.title, subtitle: outline.subtitle, cover: outline.cover, blocks: [] })
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
                    prompt: content, mode: 'section', docTitle: outline.title, docKind: outline.kind || 'report',
                    heading: ch.heading, brief: ch.brief, targetWords: ch.targetWords,
                    index: ci, total: chapters.length,
                    context: summaries.slice(-6).join('\n'),
                  }),
                  signal: ctrl.signal,
                })
                const sj = (await sr.json().catch(() => ({}))) as { blocks?: DocBlock[] }
                if (sr.ok && Array.isArray(sj.blocks) && sj.blocks.length) blocks = sj.blocks
              } catch { /* retry once */ }
            }
            if (blocks) {
              accDoc = normalizeDoc({ ...accDoc, blocks: [...(accDoc.blocks || []), ...blocks] })
              const text = blocks.map((b) => ('text' in b && b.text) || '').join(' ')
              summaries.push(`Ch.${ci + 1} "${ch.heading}": ${text.slice(0, 260)}`)
            } else if (!ctrl.signal.aborted) {
              summaries.push(`Ch.${ci + 1} "${ch.heading}": (skipped)`)
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

      if (!plain && wantK('document', isDocPrompt(content) && !isSheetPrompt(content))) {
        setRouteName('Nalu Docs')
        accLoading = 'doc'
        flush()
        try {
          // Two-agent build: the domain expert (e.g. Nalu Financial) drafts the
          // substance, then Nalu Docs designs the document from it.
          const boost = await runBoost('Nalu Docs')
          // Caption attached images (vision) so the text model can place them.
          const docImgs = imageAtts.length
            ? await Promise.all(
                imageAtts.map(async (a) => ({ src: a.dataUrl as string, caption: await captionImage(a.dataUrl as string, model, ctrl.signal) })),
              )
            : []
          const r = await fetch('/api/doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) + boost, images: docImgs.map((im) => ({ caption: im.caption })) }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as DocDoc & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.blocks) && data.blocks.length) {
            const blocks = await embedDocImages(data.blocks, docImgs)
            accDoc = normalizeDoc({ title: data.title, subtitle: data.subtitle, cover: data.cover, blocks })
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
      if (!plain && wantK('slides', isSlidesPrompt(content))) {
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
            accDeck = { title: data.title, subtitle: data.subtitle, slides: data.slides }
            acc = ''
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
      if (!plain && wantK('cad', isCadPrompt(content))) {
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
              prevCode: lastCadCodeRef.current || lastArts.cad || '',
            }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { code?: string; error?: string }
          accLoading = undefined
          if (r.ok && data.code) {
            accCad = data.code
            lastCadCodeRef.current = data.code
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
      const lastWebHtml = (() => {
        const msgs = ctxChat?.messages || []
        for (let i = msgs.length - 1; i >= 0; i--) {
          const d = msgs[i]?.design as { kind?: string; html?: string } | undefined
          if (d?.html && (d.kind === 'webpage' || d.kind === 'board')) return d.html
        }
        return ''
      })()
      const WEB_EDIT_VERB = /\b(make|change|turn|add|remove|delete|update|fix|swap|adjust|edit|recolou?r|resize|move|replace|rename|redo|restyle|animate|center|align|darker|lighter|bigger|smaller|sticky)\b/i
      const NEW_SITE_ASK = /\b(new|another|different|fresh|separate)\b[^.?!]*\b(site|website|page|app|design)\b|\b(website|site|landing page|web ?app|homepage)\s+(for|about)\b/i
      // a VIDEO ask always goes to the video engine — even when it mentions
      // walkthrough/blueprint (those words otherwise route to the 3D builder)
      const DESIGN_KINDS = ['website', 'logo', 'palette', 'brand', 'blueprint', 'poster', 'canvas', 'shopping', 'motion', 'game', 'board', 'carousel']
      let studioKind = plain || isVideoPrompt(content)
        ? null
        : forcedKind
          ? (DESIGN_KINDS.includes(forcedKind) ? (forcedKind === 'website' ? 'webpage' : (forcedKind as ReturnType<typeof designKind>)) : null)
          : designKind(content)
      // Studio memory: a design-kind edit revises the LAST artifact of that kind
      const prevArt = editTarget?.type === 'design' && editTarget.kind ? lastArts.designs[editTarget.kind] : undefined
      if (prevArt && editTarget?.kind) studioKind = editTarget.kind as typeof studioKind
      const isWebEdit =
        !plain && !!lastWebHtml && WEB_EDIT_VERB.test(content) && !NEW_SITE_ASK.test(content) &&
        (studioKind === 'webpage' ||
          (!studioKind &&
            /\b(page|site|website|hero|nav(bar)?|header|footer|section|headline|tagline|button|cta|colors?|palette|fonts?|layout|board)\b/i.test(content) &&
            !isDocPrompt(content) && !isSheetPrompt(content) && !isSlidesPrompt(content) && !isCadPrompt(content) &&
            !isVideoPrompt(content) && !isImagePrompt(content)))
      if (isWebEdit) studioKind = 'webpage'
      if (studioKind) {
        setRouteName('Nalu Studio')
        accLoading = 'design'
        flush()
        try {
          const r = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt:
                withCtx(content) +
                (prevArt && (editTarget?.kind === 'logo' || editTarget?.kind === 'palette' || editTarget?.kind === 'shopping')
                  ? `\n\nPREVIOUS ${editTarget.kind.toUpperCase()} JSON (revise THIS — keep everything not mentioned in the request identical; output the full updated JSON):\n${JSON.stringify(prevArt).slice(0, 9000)}`
                  : ''),
              kind: studioKind,
              brand: getBrand() || undefined,
              ...(prevArt && 'html' in prevArt && (prevArt as { html?: string }).html
                ? { prevHtml: (prevArt as { html: string }).html }
                : isWebEdit
                  ? { prevHtml: lastWebHtml }
                  : {}),
              ...(prevArt && editTarget?.kind === 'blueprint' ? { prevBlueprint: JSON.stringify(prevArt).slice(0, 60000) } : {}),
            }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { error?: string }
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
            accDesign = normalizeArtifact(studioKind, data)
            acc = ''
            // A freshly generated palette / brand becomes the active Brand Kit
            // immediately, so docs, decks and sheets the user downloads next
            // KEEP the palette they just gave (not the house default). They can
            // still re-pin any older palette via "Make routine".
            if (accDesign.kind === 'palette' || accDesign.kind === 'brand') {
              const b = deriveBrand(accDesign)
              if (b) setBrand(b)
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
      if (!plain && wantK('spreadsheet', isSheetPrompt(content))) {
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
            accSheet = { title: data.title, sheets: data.sheets }
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
      if (!plain && wantK('video', isVideoPrompt(content))) {
        setRouteName('Nalu Video')
        accLoading = 'video'
        flush()
        const vidPrompt = content.replace(/^\/video\s+/i, '').trim() || content
        try {
          let vImage = imageAtts[0]?.dataUrl as string | undefined
          if (!vImage && /\b(blueprint|floor ?plan|walk.?through|this (plan|design)|grow|3d)\b/i.test(content)) {
            vImage = await blueprintSnapshot()
          }
          const r = await fetch('/api/video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: vidPrompt, ...(vImage ? { image: vImage } : {}) }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string }
          accLoading = undefined
          if (r.ok && data.url) {
            accVideo = data.url
            acc = ''
          } else {
            acc = `⚠️ ${data.error || `Video error ${r.status}`}`
          }
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
      if (!plain && wantK('image', isImagePrompt(content))) {
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
        const { text, reasoning, autoResearch, toolCalls } = await streamChat(
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
        )
        // Recover tool calls a model emitted as plain text instead of the
        // tool_calls field (known serving gap: GLM emits JSON, DeepSeek emits
        // <tool_name>…</tool_name>). Run them for real and strip the call syntax
        // from what the user sees (keeping any "Let me research…" preamble).
        let calls = toolCalls
        let shownText = text
        // When the SERVER already did the research (autoResearch), the model got
        // no tools — its text is the final answer. Skip the recovery/tool loop
        // entirely so nothing re-runs and the turn ends cleanly.
        if (!autoResearch && !calls.length) {
          // In deep-think mode the model often emits its tool-call JSON inside the
          // REASONING section (before the answer marker). Recover from BOTH the
          // answer and the reasoning so the tools actually run and the raw JSON is
          // stripped from whichever pane it appeared in.
          const recA = recoverToolCalls(text, tools)
          const recR = recoverToolCalls(reasoning, tools)
          const found = [...recA.calls, ...recR.calls]
          if (found.length) {
            calls = found
            acc = acc.slice(0, acc.length - text.length) + recA.cleaned
            shownText = recA.cleaned
            if (recR.calls.length && reasoning) {
              accReasoning = accReasoning.slice(0, accReasoning.length - reasoning.length) + recR.cleaned
            }
            flush()
          }
        }
        conv.push({ role: 'assistant', content: shownText || null, tool_calls: calls.length ? calls : undefined })
        if (autoResearch || !calls.length) break
        for (const tc of calls) {
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
      if (!sawAny) {
        acc = '⚠️ No response from the Nalu engine. Please try again in a moment.'
      }
      // Deep-think fallback: if the model produced reasoning but never the answer
      // marker, don't strand it in the left pane — show it as the answer.
      if (accReasoning && !acc.trim()) {
        acc = accReasoning
        accReasoning = ''
      }
      flush() // ensure the final, complete text is rendered (no pending frame lost)
      setStreaming(false)
      abortRef.current = null
    },
    [activeId, chats, streaming, model, activeRepo, activeProjectId, dismissedIntent, thinkLevel],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setStreaming(false)
    // hand the prompt back so it can be edited and re-sent
    if (lastSentPromptRef.current) setInput((cur) => (cur.trim() ? cur : lastSentPromptRef.current))
  }, [])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  const selectChat = useCallback((id: string) => {
    setActiveId(id)
    setView('chat')
    closeSidebarOnMobile()
  }, [closeSidebarOnMobile])

  const matchesQuery = (c: Chat) => (query.trim() ? c.title.toLowerCase().includes(query.toLowerCase()) : true)
  // Chats with no project (shown at the bottom under "Chats").
  const unfiledChats = chats.filter((c) => !c.projectId).filter(matchesQuery)

  // One chat row — reused inside a project folder and in the unfiled list.
  const renderChatRow = (c: Chat) => (
    <div key={c.id} className="mb-0.5">
      <div
        className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] cursor-pointer ${
          c.id === activeId ? 'bg-glass/10' : 'hover:bg-glass/5'
        }`}
        onClick={() => selectChat(c.id)}
      >
        <MessageSquare size={13} className="text-dim shrink-0" />
        <span className="truncate flex-1">{c.title}</span>
        <div className="relative flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); setChatMenu((m) => (m === c.id ? null : c.id)) }}
            className={`shrink-0 text-dim hover:text-ink transition-opacity ${chatMenu === c.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
            title="Move to project"
            aria-label="Move to project"
          >
            <FolderInput size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); deleteChat(c.id) }}
            className="opacity-0 group-hover:opacity-100 text-dim hover:text-ink transition-opacity shrink-0"
            aria-label="Delete chat"
          >
            <Trash2 size={12} />
          </button>
          {chatMenu === c.id && (
            <>
              <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setChatMenu(null) }} />
              <div className="absolute right-0 top-6 z-50 w-44 overflow-hidden rounded-lg border border-glass/15 bg-panel2 py-1 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-dim">Move to</div>
                <button onClick={() => moveChatToProject(c.id, null)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-glass/10 ${!c.projectId ? 'text-gold' : 'text-ink'}`}>
                  <MessageSquare size={12} /> No project
                </button>
                {projects.map((p) => (
                  <button key={p.id} onClick={() => moveChatToProject(c.id, p.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-glass/10 ${c.projectId === p.id ? 'text-gold' : 'text-ink'}`}>
                    <FolderGit2 size={12} className="text-gold" /> <span className="truncate">{p.name}</span>
                  </button>
                ))}
                {projects.length === 0 && <div className="px-3 py-1.5 text-[11px] text-dim">No projects yet</div>}
              </div>
            </>
          )}
        </div>
      </div>
      {c.id === activeId && (
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

  return (
    <div
      className="relative isolate h-[100dvh] w-screen flex text-ink overflow-hidden font-sans"
      style={{ backgroundColor: isDark ? 'rgb(11,12,16)' : 'rgb(247,249,251)' }}
    >
      {/* Background model photo — a DEDICATED layer behind everything, so no
          opaque panel can ever cover it (the old inline root background could be
          hidden). Kept prominent; the wash above only softens it for readability. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-center bg-cover"
        style={{ backgroundImage: `url(${bgFor(routeName)})`, transition: 'background-image 600ms ease' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background: isDark
            ? 'radial-gradient(1100px 760px at 6% -12%, rgba(56,120,255,0.18), transparent 55%), radial-gradient(950px 680px at 102% -4%, rgba(40,90,200,0.14), transparent 55%), linear-gradient(180deg, rgba(11,12,16,0.48), rgba(11,12,16,0.64))'
            : 'radial-gradient(1200px 620px at 50% -14%, rgba(93,156,214,0.10), transparent 60%), linear-gradient(180deg, rgba(247,249,251,0.52), rgba(238,242,247,0.66))',
        }}
      />

      {/* Mobile backdrop — taps close the off-canvas sidebar. */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar — push column on desktop, off-canvas overlay on phones. */}
      <aside
        className={`${sidebarOpen ? 'w-64' : 'w-0'} fixed inset-y-0 left-0 z-40 md:static md:z-auto transition-[width] duration-200 shrink-0 overflow-hidden border-r border-glass/[0.18] ws-glass flex flex-col`}
      >
        <div className="h-12 flex items-center gap-2 px-3 shrink-0">
          <img src="/wolf-icon.png" alt="Nalu" className={`${logoClass} w-6 h-6 rounded-md`} />
          <span className="text-sm font-semibold tracking-tight">Nalu</span>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => { newChat(); closeSidebarOnMobile() }}
            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-glass/5 hover:bg-glass/10 transition-colors"
          >
            <Plus size={15} /> New chat
          </button>
        </div>

        <div className="px-3 pb-2">
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

        {/* Nav — compact 2×2 tiles instead of a stack of full-width buttons */}
        <nav className="grid grid-cols-2 gap-1.5 px-2 pb-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const activeNav = view === item.view
            return (
              <button
                key={item.view}
                onClick={() => { setView(item.view); closeSidebarOnMobile() }}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
                  activeNav ? 'bg-primary/[0.14] text-primary font-medium ring-1 ring-primary/25' : 'text-dim hover:bg-glass/[0.06] hover:text-ink'
                }`}
              >
                <Icon size={15} className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </nav>

        {view === 'chat' && (
          <>
            {/* Projects — fold chats under a project. */}
            <div className="px-2 pt-1">
              <div className="flex items-center px-1 pb-1 text-[11px] uppercase tracking-wide text-dim">
                <span>Projects</span>
                <button
                  onClick={() => setNewProjectName('')}
                  title="New project"
                  className="ml-auto rounded p-0.5 text-dim hover:bg-glass/10 hover:text-ink"
                >
                  <Plus size={13} />
                </button>
              </div>
              {newProjectName !== null && (
                <input
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createProject(newProjectName)
                    if (e.key === 'Escape') setNewProjectName(null)
                  }}
                  onBlur={() => (newProjectName.trim() ? createProject(newProjectName) : setNewProjectName(null))}
                  placeholder="Project name…"
                  className="mt-1 w-full rounded-lg border border-glass/15 bg-glass/[0.05] px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-glass/30"
                />
              )}
              {/* Each project is a folder; opening it reveals its chats nested inside. */}
              {projects.map((p) => {
                const projChats = chats.filter((c) => c.projectId === p.id).filter(matchesQuery)
                const open = activeProjectId === p.id
                return (
                  <div key={p.id}>
                    <div
                      className={`group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] cursor-pointer ${
                        open ? 'bg-glass/[0.07] text-ink' : 'text-dim hover:bg-glass/5'
                      }`}
                      onClick={() => setActiveProjectId(open ? null : p.id)}
                    >
                      <ChevronRight size={13} className={`shrink-0 text-dim transition-transform ${open ? 'rotate-90' : ''}`} />
                      <FolderGit2 size={13} className="shrink-0 text-gold" />
                      <span className="truncate flex-1">{p.name}</span>
                      {!open && <span className="shrink-0 text-[10px] text-dim group-hover:hidden">{chats.filter((c) => c.projectId === p.id).length}</span>}
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteProject(p.id) }}
                        className="hidden shrink-0 text-dim hover:text-ink group-hover:block"
                        aria-label="Delete project"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {open && (
                      <div className="ml-2 mt-0.5 mb-1 space-y-0.5 border-l border-glass/[0.12] pl-1.5">
                        {projChats.length === 0 ? (
                          <div className="px-2 py-1 text-[11px] text-dim">Empty — “New chat” adds one here.</div>
                        ) : (
                          projChats.map(renderChatRow)
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Chats not filed under any project. */}
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {unfiledChats.length > 0 && (
                <div className="px-1 pt-2 pb-1 text-[11px] uppercase tracking-wide text-dim">Chats</div>
              )}
              {unfiledChats.length === 0 && projects.length === 0 && (
                <div className="px-2 py-3 text-xs text-dim">No chats yet.</div>
              )}
              {unfiledChats.map(renderChatRow)}
            </div>
          </>
        )}
        {view !== 'chat' && <div className="flex-1" />}

        <div className="border-t border-glass/[0.18] p-2 space-y-0.5">
          <button
            onClick={() => setView('settings')}
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
            <img src="/wolf-icon.png" alt="" className="w-3.5 h-3.5 shrink-0 object-contain" /> Download Nalu Desktop
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
              {(user?.displayName || 'N').charAt(0).toUpperCase()}
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
      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-12 flex items-center gap-2 px-3 border-b border-glass/[0.18] shrink-0">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-8 h-8 rounded-md hover:bg-glass/10 flex items-center justify-center text-white"
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <span className="truncate text-sm text-dim">{topBarTitle}</span>
          <button
            onClick={toggleTheme}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-glass/[0.14] bg-glass/[0.06] px-2.5 py-1.5 text-xs text-dim hover:bg-glass/10 hover:text-ink transition-colors"
            aria-label="Toggle light or dark theme"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
            <span className="hidden sm:inline">{isDark ? 'Light' : 'Dark'}</span>
          </button>
          {view === 'chat' && (
            <div className="flex shrink-0 items-center gap-2">
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
          )}
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
            creations={creations}
            onOpen={openCreation}
            streaming={streaming}
            renderCreation={(c) => {
              // Render the creation's REAL interactive card (the same components
              // chat uses) so EVERY kind previews right inside the Studio.
              const chat = chats.find((x) => x.id === c.chatId)
              const m = chat?.messages[c.mi]
              if (!m) return null
              if (m.design)
                return (
                  <CardErrorBoundary label="The design">
                    <Suspense fallback={<MediaLoader kind="design" />}>
                      <DesignArtifactCard
                        art={m.design}
                        onUpdate={(art) =>
                          setChats((cs) =>
                            cs.map((ch) =>
                              ch.id === c.chatId
                                ? { ...ch, messages: ch.messages.map((mm, k) => (k === c.mi ? { ...mm, design: art } : mm)) }
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
                    <Suspense fallback={<MediaLoader kind="slides" />}><SlidesCard data={m.deck} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.sheet)
                return (
                  <CardErrorBoundary label="The spreadsheet">
                    <Suspense fallback={<MediaLoader kind="sheet" />}><SheetCard data={m.sheet} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.doc)
                return (
                  <CardErrorBoundary label="The document">
                    <Suspense fallback={<MediaLoader kind="doc" />}><DocCard data={m.doc} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.cad)
                return (
                  <CardErrorBoundary label="The 3D model">
                    <Suspense fallback={<MediaLoader kind="cad" />}><CADCard code={m.cad} /></Suspense>
                  </CardErrorBoundary>
                )
              if (m.video) return <video src={m.video} controls className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl" />
              if (typeof m.content === 'string') {
                const im = m.content.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
                if (im) return <img src={im[1]} alt={m.content.slice(2, 80)} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-xl" />
              }
              return null
            }}
            onGenerate={(prompt) => {
              // Stay in the Studio so the design renders here first; it also lands in chat.
              closeSidebarOnMobile()
              void send(prompt, { keepView: true })
            }}
          />
        )}
        {view === 'map' && <MapPanel />}
        {view === 'agents' && (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-dim"><Loader2 size={18} className="mr-2 animate-spin" /> Loading AutoPilot…</div>}>
            <AgentsPanel />
          </Suspense>
        )}
        {view === 'projects' && <ProjectsPanel />}
        {view === 'skills' && <SkillsPanel />}
        {view === 'automations' && <AutomationsPanel />}
        {view === 'settings' && (
          <SettingsPanel displayName={user?.displayName} onLogout={onLogout} />
        )}

        {view === 'chat' &&
          (messages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center px-4">
              <img src="/wolf-icon.png" alt="Nalu" className="w-12 h-12 mb-4 object-contain drop-shadow" />
              <h1 className="text-2xl sm:text-3xl font-light mb-8 text-center">
                {greeting}
              </h1>
              <div className="w-full max-w-2xl">
                <Composer
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
          ) : (
            <>
              <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      ref={(el) => {
                        msgRefs.current[i] = el
                      }}
                      className={`scroll-mt-20 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {m.role === 'user' ? (
                        // Your messages render as an iMessage-style blue bubble on the
                        // right — no avatar — so it's obvious which side is you.
                        <div className="max-w-[78%] rounded-2xl rounded-br-md bg-gradient-to-b from-[#3b82f6] to-[#2f6fed] px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-white shadow-sm">
                          {m.content}
                        </div>
                      ) : (
                        // Nalu's answer: full-width, left-aligned, no avatar.
                        <div className="w-full min-w-0">
                          <div className="text-xs text-dim mb-1">Nalu</div>
                          <AssistantThink reasoning={m.reasoning} isLive={streaming && i === messages.length - 1}>
                          <>
                            {m.loading ? (
                              <MediaLoader kind={m.loading} />
                            ) : m.content ? (
                              // Render full Markdown LIVE while streaming, so the
                              // styling appears as the text arrives (rAF-throttled
                              // upstream keeps it smooth). A subtle caret trails it.
                              <div className={streaming && i === messages.length - 1 ? 'streaming-caret' : undefined}>
                                <Markdown>{cleanForDisplay(m.content)}</Markdown>
                              </div>
                            ) : !m.sheet && !m.doc && !m.video && !m.cad && !m.design && !m.deck && streaming && i === messages.length - 1 ? (
                              // Waiting for the first token — the Nalu mark breathes
                              // with three soft dots while waiting for the first token.
                              <div className="flex items-center gap-2 py-0.5">
                                <img src="/wolf-icon.png" alt="" className={`${logoClass} w-5 h-5 nalu-think`} />
                                <WolfWord className="text-[13px]" />
                              </div>
                            ) : null}
                            <div
                              className={i === messages.length - 1 && (m.sheet || m.doc || m.deck || m.design || m.cad || m.video) ? 'nalu-materialize' : undefined}
                              onAnimationEnd={(e) => e.currentTarget.classList.remove('nalu-materialize')}
                            >
                            {m.sheet && (
                              <CardErrorBoundary label="The spreadsheet">
                                <Suspense fallback={<MediaLoader kind="sheet" />}>
                                  <SheetCard data={m.sheet} />
                                </Suspense>
                              </CardErrorBoundary>
                            )}
                            {m.doc && (
                              <CardErrorBoundary label="The document">
                                <Suspense fallback={<MediaLoader kind="doc" />}>
                                  <DocCard data={m.doc} />
                                </Suspense>
                              </CardErrorBoundary>
                            )}
                            {m.deck && (
                              <CardErrorBoundary label="The deck">
                                <Suspense fallback={<MediaLoader kind="slides" />}>
                                  <SlidesCard data={m.deck} />
                                </Suspense>
                              </CardErrorBoundary>
                            )}
                            {m.cad && (
                              <CardErrorBoundary label="The 3D model">
                                <Suspense fallback={<MediaLoader kind="cad" />}>
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
                              <CardErrorBoundary label="The design">
                                <Suspense fallback={<MediaLoader kind="design" />}>
                                  <DesignArtifactCard
                                    art={m.design}
                                    onUpdate={(art) => {
                                      // "Finish build" (and future in-card edits) persist onto the message
                                      if (!activeId) return
                                      setChats((cs) =>
                                        cs.map((c) =>
                                          c.id === activeId
                                            ? { ...c, messages: c.messages.map((mm, k) => (k === i ? { ...mm, design: art } : mm)) }
                                            : c,
                                        ),
                                      )
                                    }}
                                  />
                                </Suspense>
                              </CardErrorBoundary>
                            )}
                            {m.video && (
                              <span className="block">
                                <video
                                  src={m.video}
                                  controls
                                  className="my-2 max-h-[28rem] w-auto max-w-full rounded-xl border border-glass/[0.14]"
                                />
                                <button
                                  onClick={() => void downloadMedia(m.video as string, 'nalu-video.mp4')}
                                  className="mb-2 text-xs font-medium text-gold underline-offset-4 hover:underline"
                                >
                                  Download video
                                </button>
                              </span>
                            )}
                            </div>
                          </>
                          </AssistantThink>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t border-glass/[0.18] px-4 py-3">
                <div className="max-w-3xl mx-auto">
                  <BrandBar />
                  <Composer
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
          ))}
      </main>

      {/* No right drawer — everything Nalu builds renders IN FULL in the chat. */}
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
    const url = URL.createObjectURL(blobFor(a))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
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
                  <span className="truncate flex-1">{a.name}</span>
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
  input: string
  setInput: (v: string) => void
  streaming: boolean
  onSend: () => void
  onStop: () => void
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  taRef: React.RefObject<HTMLTextAreaElement>
  onAttach: (files: FileList) => void
  attaching: boolean
  attachments: Attachment[]
  onRemoveAttachment: (id: string) => void
  dismissedIntent: string | null
  onDismissIntent: () => void
  thinkLevel: number
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [showTools, setShowTools] = useState(false)
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
      className={`relative rounded-2xl border bg-glass/[0.11] backdrop-blur-2xl px-3 py-2.5 transition-colors ${dragOver ? 'border-accent ring-2 ring-accent/40' : intent ? 'border-accent/55 shadow-[0_0_0_1px_rgba(175,140,86,0.25)]' : 'border-glass/[0.14] focus-within:border-glass/20'}`}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-panel/80 backdrop-blur-sm">
          <span className="flex items-center gap-2 text-sm font-medium text-gold"><Paperclip size={15} /> Drop files or photos to attach</span>
        </div>
      )}
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
              <span className="truncate">{a.name}</span>
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
        title="Attach any file — photos, PDFs, docs, spreadsheets, code, data"
        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-glass/10 text-ink hover:bg-glass/20 disabled:opacity-50"
        aria-label="Attach"
      >
        {attaching ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
      </button>
      {/* Composer with an inline highlight backdrop: typing think / ultrathink /
          packmind lights up gold/blue so you SEE the thinking tier engage. */}
      <div className="relative min-w-0 flex-1">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[13.5px] py-1 leading-normal text-ink"
        >
          {thinkSegments(input).map((s, i) =>
            s.word ? (
              <span
                key={`${s.word}-${i}`}
                className="think-word"
                style={{ color: THINK_COLORS[s.word!], fontFamily: THINK_FONT, fontStyle: 'italic', fontWeight: 500 }}
              >{s.t}</span>
            ) : (
              <span key={i}>{s.t}</span>
            ),
          )}
        </div>
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder="Ask Nalu anything…"
          className="relative w-full bg-transparent text-transparent caret-ink outline-none resize-none text-[13.5px] placeholder:text-dim max-h-40 py-1 leading-normal"
          style={{ height: 'auto' }}
          onInput={(e) => {
            const t = e.currentTarget
            t.style.height = 'auto'
            t.style.height = Math.min(t.scrollHeight, 160) + 'px'
          }}
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
          onClick={onSend}
          disabled={!input.trim()}
          className="w-8 h-8 rounded-lg bg-white text-black disabled:bg-glass/15 disabled:text-glass/40 flex items-center justify-center shrink-0 transition-colors"
          aria-label="Send"
        >
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      )}
      </div>
    </div>
  )
}
