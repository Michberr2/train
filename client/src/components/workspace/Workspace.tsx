import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Search,
  PanelLeft,
  Settings,
  LogOut,
  ArrowUp,
  Square,
  MessageSquare,
  Trash2,
  FolderGit2,
  FolderInput,
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
  Shield,
} from 'lucide-react'
import { streamChat, type WireMessage } from './agentApi'
import { lazy, Suspense } from 'react'
import Markdown from './Markdown'
import MediaLoader from './MediaLoader'
import CardErrorBoundary from './CardErrorBoundary'
import { extractAttachment, type Attachment } from './extractText'
import type { SheetDoc } from './SheetCard'
import type { DocDoc } from './DocCard'
import type { Deck } from './SlidesCard'
import type { DesignArtifact, DesignKind } from './types'
import { getBrand, ensureDefaultBrand } from './brandKit'
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
import StudioPanel from './StudioPanel'
import ProjectsPanel from './ProjectsPanel'
import SkillsPanel from './SkillsPanel'
import PluginsPanel from './PluginsPanel'
import AutomationsPanel from './AutomationsPanel'
import SettingsPanel from './SettingsPanel'

// ---- model ---------------------------------------------------------------

interface Msg {
  role: 'user' | 'assistant'
  content: string
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

type View = 'chat' | 'studio' | 'projects' | 'skills' | 'plugins' | 'automations' | 'settings'

const CHATS_KEY = 'nalu-chats'
const ACTIVE_KEY = 'nalu-active-chat'
const MODEL_KEY = 'nalu-model'
// Client-facing model id only. The server maps this to the real backend model
// (kept server-side), so the browser/console never references it.
const DEFAULT_MODEL = 'nalu-catalina'

const NAV_ITEMS: { view: View; label: string; icon: LucideIcon }[] = [
  { view: 'chat', label: 'Chats', icon: MessageSquare },
  { view: 'studio', label: 'Studio', icon: Palette },
]

const VIEW_TITLES: Record<Exclude<View, 'chat'>, string> = {
  studio: 'Studio',
  projects: 'Projects',
  skills: 'Skills',
  plugins: 'Plugins',
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
function loadModel(): string {
  return DEFAULT_MODEL
}

interface Props {
  user: { displayName: string } | null
  onLogout: () => void
}

// Detect "make me an image" style asks so we route them to the image endpoint
// (Nalu Image / CogView) instead of the text chat.
const IMAGE_INTENT =
  /\b(generate|create|make|draw|design|render|paint|sketch|produce)\b[^.?!]*\b(image|picture|photo|photograph|logo|icon|illustration|art|artwork|drawing|wallpaper|graphic|poster|portrait|painting|avatar|banner)\b|\b(image|picture|photo|logo|illustration|drawing|painting|portrait) of\b|^\/(image|img|draw)\b/i
function isImagePrompt(text: string): boolean {
  return IMAGE_INTENT.test(text)
}

// Detect "build me a spreadsheet" style asks → route to the spreadsheet builder.
const SHEET_INTENT =
  /\b(spreadsheet|excel|xlsx|\.xls|google ?sheets?|pivot table)\b|^\/(sheet|excel|xls)\b|\b(make|build|create|generate)\b[^.?!]*\b(table|tracker|budget|roster|schedule|inventory|ledger|gantt)\b/i
function isSheetPrompt(text: string): boolean {
  return SHEET_INTENT.test(text)
}

// Detect "write me a business plan / report / proposal" → route to the doc builder.
const DOC_INTENT =
  /\b(business plan|marketing plan|project plan|word document|word doc|\.docx|report|proposal|white ?paper|cover letter|résumé|resume|\bcv\b|memo|press release|essay|document)\b|^\/(doc|word)\b|\b(write|draft|create|build|make|generate)\b[^.?!]*\b(plan|report|proposal|essay|letter|document|memo|brief|whitepaper)\b/i
function isDocPrompt(text: string): boolean {
  return DOC_INTENT.test(text)
}

// Detect "make me a video" style asks → route to the video endpoint.
const VIDEO_INTENT =
  /\b(generate|create|make|produce|render)\b[^.?!]*\b(video|animation|clip|movie|reel)\b|\banimate\b|^\/video\b/i
function isVideoPrompt(text: string): boolean {
  return VIDEO_INTENT.test(text)
}

// CAD / 3D-model intent → inline Nalu CAD viewer.
const CAD_INTENT =
  /\b(autocad|open ?scad|cad model|cad part|cad design|3d model|3d-?print|3d print|stl file|\.stl\b)\b|^\/cad\b|\b(design|model|make|build|create|3d)\b[^.?!]*\b(bracket|gear|flange|enclosure|housing|mount|bolt|nut|screw|gadget|widget|knob|hook|stand|holder|adapter|spacer|case|clip|gear|part)\b/i
function isCadPrompt(text: string): boolean {
  return CAD_INTENT.test(text)
}

// Web/UI design intent → inline Nalu Design (live HTML artifact).
const DESIGN_INTENT =
  /\b(website|web ?page|landing page|web ?app|html page|web design|user interface|dashboard ui|web component|infographic|poster)\b|^\/design\b|\b(design|build|create|make|code)\b[^.?!]*\b(website|landing page|web ?page|web ?app|ui|interface|dashboard|html|web component|hero section|pricing page)\b/i
function isDesignPrompt(text: string): boolean {
  return DESIGN_INTENT.test(text)
}

// ---- Nalu Studio sub-type routing (most-specific first) --------------------
// Every creative ask resolves to one DesignKind sent to /api/design as
// {prompt, kind}; the server trusts the client's kind (no guessing).
const PALETTE_INTENT =
  /\b(colou?r ?palette|colou?r ?scheme|swatch(es)?|colou?r ?theme|hex(?: codes?)?)\b|^\/palette\b/i
const BRAND_INTENT =
  /\b(brand(?:ing)? guidelines?|brand identity|brand kit|style ?guide|visual identity|brand book)\b|^\/brand\b/i
const BLUEPRINT_INTENT =
  /\b(blueprint|floor ?plan|technical drawing|schematic|annotated (?:diagram|drawing)|elevation|wireframe diagram)\b|^\/blueprint\b/i
// House / interior-design / walkthrough asks → a blueprint (which carries the
// 3D model + first-person walkthrough + furnish tools). Catches "make a
// walkthrough of a mansion", "design my house", "3d home tour", etc. The
// negative lookahead keeps web/app/logo asks ("design a home page") out.
const WALKTHROUGH_INTENT =
  /\b(walk\s?through|walk-through|house\s?tour|home\s?tour|interior design|3d\s?(?:house|home|tour|walk))\b|\b(design|build|make|create|model|render|lay\s?out)\b(?![^.?!]*\b(website|web ?app|web ?page|home ?page|landing page|app|logo|poster|deck|slide)\b)[^.?!]{0,40}\b(house|home|mansion|villa|apartment|condo|bungalow|cottage|floor ?plan|bedroom|kitchen|bathroom|living room)\b|^\/(walkthrough|house|home|tour)\b/i
const LOGO_INTENT =
  /\b(logo|logotype|wordmark|brand ?mark|app ?icon|monogram|emblem)\b|^\/logo\b/i
const SHOP_INTENT =
  /\b(shop(?:ping)?(?: for| list)?|buy|purchase|where (?:can|do) i (?:get|buy)|add to cart|furnish(?:ing)? (?:list|my)|outfit (?:my|the)|things i (?:need|should buy))\b[^.?!]*\b(room|house|home|apartment|bedroom|kitchen|living|bathroom|office|desk|setup|outfit|nursery|patio|furniture|items?)\b|^\/shop\b/i
const CANVAS_INTENT =
  /\b(editable|vector|figma|canvas|social (?:post|graphic)|instagram (?:post|story)|flyer|poster art|graphic)\b[^.?!]*\b(design|make|create|graphic|post|canvas)\b|\beditable (?:design|graphic|canvas)\b|\bfigma-?like\b|^\/canvas\b/i
// Motion graphics → an animated, looping self-contained HTML "HyperFrame".
const MOTION_INTENT =
  /\b(motion graphic|animated|animation|kinetic typography|title card|logo (?:reveal|animation|intro)|promo (?:video|animation)|loop(?:ing)? (?:animation|background|graphic)|intro animation|lower third|hyperframe|gif-?style)\b|^\/(motion|animate)\b/i

/** Resolve a creative ask to a DesignKind, or null to fall through to the agent
 *  loop. Order: logo → palette → brand → blueprint → canvas → poster/webpage. */
function designKind(text: string): DesignKind | null {
  // Specific, high-confidence creative kinds win first.
  if (SHOP_INTENT.test(text)) return 'shopping'
  if (LOGO_INTENT.test(text)) return 'logo'
  if (PALETTE_INTENT.test(text)) return 'palette'
  if (BRAND_INTENT.test(text)) return 'brand'
  if (BLUEPRINT_INTENT.test(text)) return 'blueprint'
  // An EXPLICIT document / spreadsheet / deck ask always beats the greedy
  // house/room walkthrough matcher and the generic webpage fallback below — so
  // "excel budget for my house" or "powerpoint about my mansion" route correctly.
  if (isSheetPrompt(text) || isSlidesPrompt(text) || isDocPrompt(text)) return null
  if (WALKTHROUGH_INTENT.test(text)) return 'blueprint'
  if (MOTION_INTENT.test(text)) return 'motion'
  if (CANVAS_INTENT.test(text)) return 'canvas'
  if (isDesignPrompt(text)) return /\b(poster|infographic)\b/i.test(text) ? 'poster' : 'webpage'
  return null
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
  /\b(pitch deck|slide deck|presentation|power ?point|pptx?|slides|keynote|deck)\b|^\/(slides|deck|ppt)\b|\b(make|build|create|design|generate)\b[^.?!]*\b(deck|presentation|slides|pitch)\b/i
function isSlidesPrompt(text: string): boolean {
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

export default function Workspace({ user, onLogout }: Props) {
  const [view, setView] = useState<View>('chat')
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
  const [streaming, setStreaming] = useState(false)
  const [routeName, setRouteName] = useState('Nalu Catalina')
  const [query, setQuery] = useState('')
  // Sidebar is a push-column on desktop but an off-canvas overlay on phones, so
  // it defaults open on desktop and closed on mobile (chat gets the full width).
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 768,
  )
  const closeSidebarOnMobile = useCallback(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false)
  }, [])
  const abortRef = useRef<AbortController | null>(null)
  const lastCadCodeRef = useRef('') // current CAD model, so follow-ups edit it
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

  // persist
  useEffect(() => {
    chatsRef.current = chats
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(chats))
    } catch {
      // Quota exceeded (big attachments) — drop attachment text from the stored
      // copy so chats still persist; the in-memory copy keeps full text.
      try {
        const slim = chats.map((c) => ({
          ...c,
          attachments: (c.attachments || []).map((a) => ({ ...a, text: a.text.slice(0, 2000), truncated: true, dataUrl: undefined })),
        }))
        localStorage.setItem(CHATS_KEY, JSON.stringify(slim))
      } catch {
        /* give up persisting this update */
      }
    }
  }, [chats])
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId)
    setPendingIds([]) // a different chat → no carried-over prompt chips
  }, [activeId])
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

  const msgRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const scrollToMsg = useCallback((mi: number) => {
    msgRefs.current[mi]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])
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
    abortRef.current?.abort()
    setStreaming(false)
    setActiveId(null)
    setInput('')
    setView('chat')
    taRef.current?.focus()
  }, [])

  const deleteChat = useCallback((id: string) => {
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
  const [docDrawerOpen, setDocDrawerOpen] = useState(true) // right drawer (docs the AI sees)
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
      setDocDrawerOpen(true) // reveal the doc the AI will look at
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
    async (text: string) => {
      const content = text.trim()
      if (!content || streaming) return
      setInput('')
      setPendingIds([]) // attachments stay saved (drawer + AI), just clear the prompt chips

      // Resolve the target chat id + full history SYNCHRONOUSLY from current
      // state — never from inside the setChats updater (which React runs
      // later), so the page switches to the conversation immediately instead
      // of leaving you on the home screen having to click into the chat.
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
      const ctxParts: string[] = []
      if (ctxChat?.notes && ctxChat.notes.trim())
        ctxParts.push(`## Notes (kept by the user for you to reference)\n${ctxChat.notes.trim()}`)
      for (const a of ctxChat?.attachments || [])
        ctxParts.push(`## Attached document: ${a.name}\n${a.text}${a.truncated ? '\n…[truncated]' : ''}`)
      const ctxBlock = ctxParts.length
        ? `\n\n---\n[Attached context for this request — use it; don't repeat it verbatim.]\n\n${ctxParts.join('\n\n---\n\n')}`
        : ''
      // For artifact generators (doc/sheet/slides/design/cad) we fold the context
      // into the prompt; the chat path injects it as a separate message below.
      const withCtx = (prompt: string) => (ctxBlock ? prompt + ctxBlock : prompt)

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
      setView('chat')

      const wire: WireMessage[] = history.map((m) => ({ role: m.role, content: m.content }))
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setStreaming(true)

      let acc = ''
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
        if (gap > 0) shown = Math.min(acc.length, shown + Math.max(3, Math.ceil(gap * 0.28)))
        renderMsg(shown >= acc.length ? acc : acc.slice(0, shown))
        revealRaf = shown < acc.length ? requestAnimationFrame(reveal) : 0
      }
      const scheduleFlush = () => {
        if (!revealRaf) revealRaf = requestAnimationFrame(reveal)
      }

      // Document: build a designed Word/PDF document (business plan, report, …).
      if (isDocPrompt(content) && !isSheetPrompt(content)) {
        setRouteName('Nalu Docs')
        accLoading = 'doc'
        flush()
        try {
          const r = await fetch('/api/doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) }),
            signal: ctrl.signal,
          })
          const data = (await r.json().catch(() => ({}))) as DocDoc & { error?: string }
          accLoading = undefined
          if (r.ok && Array.isArray(data.blocks) && data.blocks.length) {
            accDoc = { title: data.title, subtitle: data.subtitle, blocks: data.blocks }
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
      if (isSlidesPrompt(content)) {
        setRouteName('Nalu Slides')
        accLoading = 'slides'
        flush()
        try {
          const r = await fetch('/api/slides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) }),
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
      if (isCadPrompt(content)) {
        setRouteName('Nalu CAD')
        accLoading = 'cad'
        flush()
        try {
          const r = await fetch('/api/cad', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content), prevCode: lastCadCodeRef.current }),
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
      const studioKind = designKind(content)
      if (studioKind) {
        setRouteName('Nalu Studio')
        accLoading = 'design'
        flush()
        try {
          const r = await fetch('/api/design', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content), kind: studioKind, brand: getBrand() || undefined }),
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
              'items' in data)
          if (ok) {
            accDesign = normalizeArtifact(studioKind, data)
            acc = ''
            // Brand stays EXPLICIT: the user clicks "Make routine" on a palette
            // or brand card to set the global Brand Kit — generating one never
            // hijacks the active routine brand.
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
      if (isSheetPrompt(content)) {
        setRouteName('Nalu Sheets')
        accLoading = 'sheet'
        flush()
        try {
          const r = await fetch('/api/sheet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: withCtx(content) }),
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

      // Video generation: route to the (pluggable) video endpoint.
      if (isVideoPrompt(content)) {
        setRouteName('Nalu Video')
        accLoading = 'video'
        flush()
        const vidPrompt = content.replace(/^\/video\s+/i, '').trim() || content
        try {
          const r = await fetch('/api/video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: vidPrompt }),
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
      if (isImagePrompt(content)) {
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
      let sawAny = false
      // Up to 12 tool rounds so the agent can do genuinely deep, multi-step
      // research (search → read sources → refine → read more) before answering.
      for (let round = 0; round < 12 && !ctrl.signal.aborted; round++) {
        const { text, toolCalls } = await streamChat(
          conv,
          model,
          {
            signal: ctrl.signal,
            onDelta: (t) => {
              acc += t
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
        )
        conv.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined })
        if (!toolCalls.length) break
        for (const tc of toolCalls) {
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
      flush() // ensure the final, complete text is rendered (no pending frame lost)
      setStreaming(false)
      abortRef.current = null
    },
    [activeId, chats, streaming, model, activeRepo, activeProjectId],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setStreaming(false)
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

  const filteredChats = chats
    .filter((c) => (activeProjectId ? c.projectId === activeProjectId : true))
    .filter((c) => (query.trim() ? c.title.toLowerCase().includes(query.toLowerCase()) : true))

  const topBarTitle =
    view === 'chat' ? active?.title || 'New chat' : VIEW_TITLES[view]

  return (
    <div
      className="h-[100dvh] w-screen flex text-[#ededed] overflow-hidden font-sans"
      style={{
        background: [
          'radial-gradient(1100px 760px at 6% -12%, rgba(56,120,255,0.20), transparent 55%)',
          'radial-gradient(950px 680px at 102% -4%, rgba(40,90,200,0.16), transparent 55%)',
          // heavy dark overlay keeps it dark; the model photo only peeks through ~10%
          'linear-gradient(180deg, rgba(11,12,16,0.88), rgba(11,12,16,0.93))',
          `url(${bgFor(routeName)}) center / cover no-repeat`,
        ].join(', '),
        transition: 'background-image 600ms ease',
      }}
    >
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
        className={`${sidebarOpen ? 'w-64' : 'w-0'} fixed inset-y-0 left-0 z-40 md:static md:z-auto transition-[width] duration-200 shrink-0 overflow-hidden border-r border-white/[0.18] bg-[#0f1320]/95 md:bg-white/[0.08] backdrop-blur-2xl flex flex-col`}
      >
        <div className="h-12 flex items-center gap-2 px-3 shrink-0">
          <img src="/wolf-icon.png" alt="Nalu" className="brightness-0 invert w-6 h-6 rounded-md" />
          <span className="text-sm font-semibold tracking-tight">Nalu</span>
        </div>

        <div className="px-3 pb-2">
          <button
            onClick={() => { newChat(); closeSidebarOnMobile() }}
            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-white/5 hover:bg-white/10 transition-colors"
          >
            <Plus size={15} /> New chat
          </button>
        </div>

        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-white/5">
            <Search size={14} className="text-[#8e8e8e]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="bg-transparent outline-none text-sm w-full placeholder:text-[#6e6e6e]"
            />
          </div>
        </div>

        {/* Nav group */}
        <nav className="px-2 pb-2">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const activeNav = view === item.view
            return (
              <button
                key={item.view}
                onClick={() => { setView(item.view); closeSidebarOnMobile() }}
                className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  activeNav ? 'bg-white/10 text-[#ededed]' : 'text-[#afafaf] hover:bg-white/5'
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
              <div className="flex items-center px-1 pb-1 text-[11px] uppercase tracking-wide text-[#6e6e6e]">
                <span>Projects</span>
                <button
                  onClick={() => setNewProjectName('')}
                  title="New project"
                  className="ml-auto rounded p-0.5 text-[#8e8e8e] hover:bg-white/10 hover:text-white"
                >
                  <Plus size={13} />
                </button>
              </div>
              <button
                onClick={() => setActiveProjectId(null)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                  activeProjectId === null ? 'bg-white/10 text-[#ededed]' : 'text-[#afafaf] hover:bg-white/5'
                }`}
              >
                <MessageSquare size={14} className="shrink-0 text-[#8e8e8e]" /> All chats
              </button>
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
                  className="mt-1 w-full rounded-lg border border-white/15 bg-white/[0.05] px-2.5 py-1.5 text-sm text-[#ededed] outline-none focus:border-white/30"
                />
              )}
              {projects.map((p) => {
                const count = chats.filter((c) => c.projectId === p.id).length
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm cursor-pointer ${
                      activeProjectId === p.id ? 'bg-white/10 text-[#ededed]' : 'text-[#afafaf] hover:bg-white/5'
                    }`}
                    onClick={() => setActiveProjectId(p.id)}
                  >
                    <FolderGit2 size={14} className="shrink-0 text-[#c9b891]" />
                    <span className="truncate flex-1">{p.name}</span>
                    <span className="shrink-0 text-[10px] text-[#6e6e6e] group-hover:hidden">{count}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteProject(p.id)
                      }}
                      className="hidden shrink-0 text-[#8e8e8e] hover:text-white group-hover:block"
                      aria-label="Delete project"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wide text-[#6e6e6e]">
              {activeProjectId ? projects.find((p) => p.id === activeProjectId)?.name || 'Chats' : 'Recent'}
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {filteredChats.length === 0 && (
                <div className="px-2 py-3 text-xs text-[#6e6e6e]">
                  {activeProjectId ? 'No chats in this project yet. Start one with New chat.' : 'No chats yet.'}
                </div>
              )}
              {filteredChats.map((c) => (
                <div key={c.id} className="mb-0.5">
                  <div
                    className={`group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm cursor-pointer ${
                      c.id === activeId ? 'bg-white/10' : 'hover:bg-white/5'
                    }`}
                    onClick={() => selectChat(c.id)}
                  >
                    <MessageSquare size={14} className="text-[#8e8e8e] shrink-0" />
                    <span className="truncate flex-1">{c.title}</span>
                    <div className="relative flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setChatMenu((m) => (m === c.id ? null : c.id)) }}
                        className={`shrink-0 text-[#8e8e8e] hover:text-white transition-opacity ${chatMenu === c.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        title="Move to project"
                        aria-label="Move to project"
                      >
                        <FolderInput size={13} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteChat(c.id) }}
                        className="opacity-0 group-hover:opacity-100 text-[#8e8e8e] hover:text-white transition-opacity shrink-0"
                        aria-label="Delete chat"
                      >
                        <Trash2 size={13} />
                      </button>
                      {chatMenu === c.id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setChatMenu(null) }} />
                          <div className="absolute right-0 top-6 z-50 w-44 overflow-hidden rounded-lg border border-white/15 bg-[#13151b] py-1 shadow-xl" onClick={(e) => e.stopPropagation()}>
                            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[#6e6e6e]">Move to</div>
                            <button onClick={() => moveChatToProject(c.id, null)}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-white/10 ${!c.projectId ? 'text-[#c9b891]' : 'text-[#cfcfcf]'}`}>
                              <MessageSquare size={12} /> No project
                            </button>
                            {projects.map((p) => (
                              <button key={p.id} onClick={() => moveChatToProject(c.id, p.id)}
                                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-white/10 ${c.projectId === p.id ? 'text-[#c9b891]' : 'text-[#cfcfcf]'}`}>
                                <FolderGit2 size={12} className="text-[#c9b891]" /> <span className="truncate">{p.name}</span>
                              </button>
                            ))}
                            {projects.length === 0 && <div className="px-3 py-1.5 text-[11px] text-[#6e6e6e]">No projects yet</div>}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  {/* When this chat is active, its files + notes live right under it. */}
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
              ))}
            </div>
          </>
        )}
        {view !== 'chat' && <div className="flex-1" />}

        <div className="border-t border-white/[0.18] p-2 space-y-1">
          <button
            onClick={() => setView('settings')}
            className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
              view === 'settings' ? 'bg-white/10 text-[#ededed]' : 'text-[#afafaf] hover:bg-white/5'
            }`}
          >
            <Settings size={15} className="shrink-0" /> Settings
          </button>
          <a
            href="/privacy.html"
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[#afafaf] hover:bg-white/5 transition-colors"
          >
            <Shield size={15} className="shrink-0" /> Privacy Policy
          </a>
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-white/5">
            <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-xs font-medium">
              {(user?.displayName || 'N').charAt(0).toUpperCase()}
            </div>
            <span className="text-sm truncate flex-1">{user?.displayName || 'You'}</span>
            <button
              onClick={onLogout}
              className="text-[#8e8e8e] hover:text-white"
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
        <div className="h-12 flex items-center gap-2 px-3 border-b border-white/[0.18] shrink-0">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center text-[#afafaf]"
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={16} />
          </button>
          <span className="truncate text-sm text-[#afafaf]">{topBarTitle}</span>
          {view === 'chat' && (
            <div className="ml-auto flex shrink-0 items-center gap-2">
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
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[#afafaf]"
                  >
                    <GitBranch size={13} /> <span className="hidden sm:inline">{activeRepo.owner}/{activeRepo.repo}</span>
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowConnect(true)}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[#afafaf]"
                >
                  <GitBranch size={13} /> <span className="hidden sm:inline">Connect repo</span>
                </button>
              )}
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-[#afafaf] px-2.5 py-1.5 rounded-lg bg-white/[0.06]">
                <img src="/wolf-icon.png" alt="" className="brightness-0 invert h-3.5 w-3.5" />
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
              className="w-full max-w-md rounded-2xl border border-white/[0.18] bg-white/[0.06] backdrop-blur-2xl p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <GitBranch size={15} /> Connect a GitHub repo
                </h3>
                <button onClick={() => setShowConnect(false)} className="text-[#8e8e8e] hover:text-white">
                  <X size={16} />
                </button>
              </div>
              <label className="block text-xs text-[#8e8e8e] mb-1">GitHub token (repo scope)</label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ghp_…"
                className="w-full mb-3 rounded-lg bg-white/[0.06] border border-white/[0.18] px-3 py-2 text-sm outline-none focus:border-white/20"
              />
              <label className="block text-xs text-[#8e8e8e] mb-1">Repository</label>
              <input
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void connectRepo()}
                placeholder="owner/repo"
                className="w-full mb-4 rounded-lg bg-white/[0.06] border border-white/[0.18] px-3 py-2 text-sm outline-none focus:border-white/20"
              />
              <button
                onClick={() => void connectRepo()}
                disabled={connecting || !tokenInput.trim() || !repoInput.includes('/')}
                className="w-full rounded-lg bg-white text-black text-sm font-medium py-2 disabled:bg-white/15 disabled:text-white/40"
              >
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
              <p className="text-[11px] text-[#8e8e8e] mt-3">
                Nalu reads, edits, and commits files via the GitHub API — your token stays in your browser.
              </p>
            </div>
          </div>
        )}

        {view === 'studio' && (
          <StudioPanel
            onGenerate={(prompt) => {
              setView('chat')
              closeSidebarOnMobile()
              void send(prompt)
            }}
          />
        )}
        {view === 'projects' && <ProjectsPanel />}
        {view === 'skills' && <SkillsPanel />}
        {view === 'plugins' && <PluginsPanel />}
        {view === 'automations' && <AutomationsPanel />}
        {view === 'settings' && (
          <SettingsPanel displayName={user?.displayName} onLogout={onLogout} />
        )}

        {view === 'chat' &&
          (messages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center px-4">
              <h1 className="text-2xl sm:text-3xl font-light mb-8 text-center">
                What should we work on?
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
                      className="flex gap-3 scroll-mt-20"
                    >
                      <div
                        className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-medium ${
                          m.role === 'user' ? 'bg-white/10' : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        {m.role === 'user' ? (
                          (user?.displayName || 'Y').charAt(0).toUpperCase()
                        ) : (
                          <img src="/wolf-icon.png" alt="Nalu" className="brightness-0 invert w-4 h-4" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="text-xs text-[#8e8e8e] mb-1">
                          {m.role === 'user' ? 'You' : 'Nalu'}
                        </div>
                        {m.role === 'assistant' ? (
                          <>
                            {m.loading ? (
                              <MediaLoader kind={m.loading} />
                            ) : m.content ? (
                              // Render full Markdown LIVE while streaming, so the
                              // styling appears as the text arrives (rAF-throttled
                              // upstream keeps it smooth). A subtle caret trails it.
                              <div className={streaming && i === messages.length - 1 ? 'streaming-caret' : undefined}>
                                <Markdown>{m.content}</Markdown>
                              </div>
                            ) : !m.sheet && !m.doc && !m.video && !m.cad && !m.design && !m.deck && streaming && i === messages.length - 1 ? (
                              <div className="text-[15px] leading-relaxed text-[#ededed]">▍</div>
                            ) : null}
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
                                  <CADCard code={m.cad} />
                                </Suspense>
                              </CardErrorBoundary>
                            )}
                            {m.design && (
                              <CardErrorBoundary label="The design">
                                <Suspense fallback={<MediaLoader kind="design" />}>
                                  <DesignArtifactCard art={m.design} />
                                </Suspense>
                              </CardErrorBoundary>
                            )}
                            {m.video && (
                              <video
                                src={m.video}
                                controls
                                className="my-2 max-h-[28rem] w-auto max-w-full rounded-xl border border-white/[0.14]"
                              />
                            )}
                          </>
                        ) : (
                          <div className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-[#ededed]">
                            {m.content}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="border-t border-white/[0.18] px-4 py-3">
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
                  />
                </div>
              </div>
            </>
          ))}
      </main>

      {/* Right drawer: documents the AI is looking at + artifacts it built. */}
      {view === 'chat' && ((active?.attachments?.length ?? 0) > 0 || builtArtifacts.length > 0) && (
        <AttachmentDrawer
          open={docDrawerOpen}
          attachments={active?.attachments || []}
          built={builtArtifacts}
          messages={active?.messages || []}
          onToggle={() => setDocDrawerOpen((o) => !o)}
          onRemove={removeAttachment}
          onJumpToMsg={scrollToMsg}
          onDeleteBuilt={deleteMessage}
        />
      )}
    </div>
  )
}

// ---- composer ------------------------------------------------------------

// Lightweight in-drawer preview of an artifact Nalu BUILT (doc, deck, sheet, or
// a live web design), so you can actually see it in the right drawer.
function BuiltPreview({ m }: { m: Msg }) {
  // Live web design (webpage / poster / brand book) — render the real HTML.
  const designHtml = m.design ? (m.design as { html?: string }).html : undefined
  if (typeof designHtml === 'string' && designHtml) {
    return <iframe srcDoc={designHtml} title="preview" sandbox="allow-scripts" className="h-full w-full flex-1 border-0 bg-white" />
  }
  if (m.doc) {
    const blocks = m.doc.blocks || []
    return (
      <div className="mx-3 mb-3 flex-1 overflow-y-auto rounded-lg border border-white/[0.1] bg-[#faf8f3] p-5 text-[#23262b]">
        <div className="mb-1 text-lg font-semibold" style={{ color: '#0F1B2D', fontFamily: 'Georgia, serif' }}>{m.doc.title || 'Document'}</div>
        {m.doc.subtitle && <div className="mb-3 text-xs italic text-[#6b6b6b]">{m.doc.subtitle}</div>}
        {blocks.map((b, i) => {
          if (b.type === 'heading')
            return <div key={i} className="mb-1 mt-3 font-semibold" style={{ color: '#0F1B2D', fontFamily: 'Georgia, serif', fontSize: b.level === 1 ? 16 : 14 }}>{b.text}</div>
          if (b.type === 'paragraph') return <p key={i} className="mb-2 text-[12px] leading-relaxed">{b.text}</p>
          if (b.type === 'bullets')
            return (
              <ul key={i} className="mb-2 ml-4 list-disc text-[12px]">
                {(b.items || []).map((it, j) => <li key={j} className="mb-0.5">{it}</li>)}
              </ul>
            )
          if (b.type === 'table')
            return (
              <div key={i} className="mb-2 overflow-x-auto">
                <table className="w-full border-collapse text-[11px]">
                  <thead><tr>{(b.columns || []).map((c, j) => <th key={j} className="border border-[#ddd] bg-[#0F1B2D] px-2 py-1 text-left text-white">{c}</th>)}</tr></thead>
                  <tbody>{(b.rows || []).map((r, ri) => <tr key={ri}>{(b.columns || []).map((_, ci) => <td key={ci} className="border border-[#e3e3e3] px-2 py-1">{String(r[ci] ?? '')}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )
          return null
        })}
      </div>
    )
  }
  if (m.deck) {
    return (
      <div className="mx-3 mb-3 flex-1 space-y-2 overflow-y-auto">
        <div className="text-sm font-semibold text-[#ededed]">{m.deck.title}</div>
        {(m.deck.slides || []).map((s, i) => (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.04] p-2.5">
            <div className="text-[11px] font-medium text-[#c9b891]">{String(i + 1).padStart(2, '0')} · {s.title}</div>
            <ul className="mt-1 ml-3 list-disc text-[11px] text-[#cfcfcf]">{(s.bullets || []).slice(0, 4).map((b, j) => <li key={j}>{b}</li>)}</ul>
          </div>
        ))}
      </div>
    )
  }
  if (m.sheet) {
    const sh = m.sheet.sheets?.[0]
    return (
      <div className="mx-3 mb-3 flex-1 overflow-auto rounded-lg border border-white/[0.1] bg-white/[0.04] p-2">
        <div className="mb-1 text-xs font-medium text-[#ededed]">{m.sheet.title}</div>
        <table className="w-full border-collapse text-[10px] text-[#cfcfcf]">
          <thead><tr>{(sh?.columns || []).map((c, j) => <th key={j} className="border border-white/10 bg-white/[0.06] px-1.5 py-1 text-left">{c}</th>)}</tr></thead>
          <tbody>{(sh?.rows || []).slice(0, 30).map((r, ri) => <tr key={ri}>{(sh?.columns || []).map((_, ci) => <td key={ci} className="border border-white/[0.06] px-1.5 py-1">{String(r[ci] ?? '')}</td>)}</tr>)}</tbody>
        </table>
      </div>
    )
  }
  return <div className="mx-3 mb-3 flex-1 text-xs text-[#8e8e8e]">Open it in the chat to view or download.</div>
}

// Right drawer: documents Nalu is looking at + a live preview of artifacts it built.
function AttachmentDrawer({
  open,
  attachments,
  built,
  messages,
  onToggle,
  onRemove,
  onJumpToMsg,
  onDeleteBuilt,
}: {
  open: boolean
  attachments: Attachment[]
  built: { kind: string; label: string; mi: number }[]
  messages: Msg[]
  onToggle: () => void
  onRemove: (id: string) => void
  onJumpToMsg: (mi: number) => void
  onDeleteBuilt: (mi: number) => void
}) {
  const [sel, setSel] = useState(0)
  const [previewMi, setPreviewMi] = useState<number | null>(null)
  const a = attachments[Math.min(sel, attachments.length - 1)]
  const blobFor = (f: Attachment): Blob => {
    if (f.dataUrl) {
      try {
        const [head, b64] = f.dataUrl.split(',')
        const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream'
        const bin = atob(b64)
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        return new Blob([arr], { type: mime })
      } catch {
        /* fall through */
      }
    }
    return new Blob([f.text || ''], { type: 'text/plain' })
  }
  const openFile = (f: Attachment) => {
    const url = URL.createObjectURL(blobFor(f))
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const downloadFile = (f: Attachment) => {
    const url = URL.createObjectURL(blobFor(f))
    const link = document.createElement('a')
    link.href = url
    link.download = f.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  if (!open) {
    return (
      <button
        onClick={onToggle}
        title="Show documents & artifacts"
        className="hidden w-9 shrink-0 flex-col items-center gap-2 border-l border-white/[0.12] bg-white/[0.04] py-3 text-[#9fd0ff] hover:bg-white/[0.07] md:flex"
      >
        <FileText size={16} />
        <span className="rounded-full bg-cyan-500/20 px-1 text-[10px] text-cyan-200">{attachments.length + built.length}</span>
      </button>
    )
  }
  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-white/[0.14] bg-white/[0.06] backdrop-blur-2xl md:flex">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        {previewMi !== null ? (
          <>
            <button onClick={() => setPreviewMi(null)} className="rounded p-1 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Back">
              <ChevronLeft size={15} />
            </button>
            <span className="truncate text-sm font-medium text-[#ededed]">Preview</span>
            <button onClick={() => onJumpToMsg(previewMi)} className="ml-auto rounded p-1 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Show in chat">
              <ExternalLink size={14} />
            </button>
          </>
        ) : (
          <>
            <FileText size={15} className="text-[#9fd0ff]" />
            <span className="text-sm font-medium text-[#ededed]">Documents & artifacts</span>
          </>
        )}
        <button onClick={onToggle} className="ml-auto rounded p-1 text-[#8e8e8e] hover:bg-white/10 hover:text-white" aria-label="Hide">
          <X size={15} />
        </button>
      </div>

      {/* Live preview of a built artifact, right in the drawer. */}
      {previewMi !== null && messages[previewMi] ? (
        <BuiltPreview m={messages[previewMi]} />
      ) : (
      <>
      {/* Artifacts Nalu built in this chat — click to preview here; jump or delete. */}
      {built.length > 0 && (
        <div className="border-b border-white/10 px-3 py-2.5">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8e8e8e]">Built in this chat</div>
          <div className="space-y-0.5">
            {built.map((bA, i) => {
              const Icon = ARTIFACT_ICON[bA.kind] || FileText
              return (
                <div key={i} className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 text-[12px] text-[#ededed] hover:bg-white/5">
                  <Icon size={13} className="shrink-0 text-[#c9b891]" />
                  <button onClick={() => setPreviewMi(bA.mi)} className="flex-1 truncate text-left hover:text-white" title="Preview here">
                    {bA.label}
                  </button>
                  <button onClick={() => onJumpToMsg(bA.mi)} className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Show in chat">
                    <ExternalLink size={12} />
                  </button>
                  <button onClick={() => onDeleteBuilt(bA.mi)} className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Delete">
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {attachments.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-white/10 px-2 py-2">
          {attachments.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setSel(i)}
              className={`max-w-[140px] truncate rounded-md px-2 py-1 text-[11px] ${
                i === sel ? 'bg-white/15 text-[#ededed]' : 'bg-white/5 text-[#9a9a9a] hover:bg-white/10'
              }`}
            >
              {f.name}
            </button>
          ))}
        </div>
      )}
      {a && (
        <>
          <div className="flex items-center gap-1 px-3 py-2 text-xs text-[#bdbdbd]">
            <span className="truncate font-medium flex-1">{a.name}</span>
            <button onClick={() => openFile(a)} className="rounded p-1 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Open">
              <ExternalLink size={13} />
            </button>
            <button onClick={() => downloadFile(a)} className="rounded p-1 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Download">
              <Download size={13} />
            </button>
            <button onClick={() => onRemove(a.id)} className="rounded p-1 text-[#9a9a9a] hover:bg-white/10 hover:text-white" title="Remove">
              <X size={13} />
            </button>
          </div>
          {(() => {
            const isPdf = !!a.dataUrl && (a.type.includes('pdf') || /\.pdf$/i.test(a.name))
            const isImg = !!a.dataUrl && (a.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.name))
            if (isPdf)
              return (
                <iframe
                  title={a.name}
                  src={`${a.dataUrl}#toolbar=0&view=FitH`}
                  className="mx-3 mb-3 flex-1 rounded-lg border border-white/[0.12] bg-white"
                />
              )
            if (isImg)
              return (
                <div className="mx-3 mb-3 flex-1 overflow-auto rounded-lg border border-white/[0.12] bg-white/[0.04] p-2">
                  <img src={a.dataUrl} alt={a.name} className="mx-auto max-w-full rounded" />
                </div>
              )
            // Fallback: the readable text Nalu extracted (for .docx / .txt / etc.).
            return (
              <div className="mx-3 mb-3 flex-1 overflow-y-auto rounded-lg border border-white/[0.1] bg-white/[0.04] p-3 text-[12px] leading-relaxed text-[#dcdcdc] whitespace-pre-wrap break-words">
                {a.text ? (
                  <>
                    {a.text}
                    {a.truncated && <div className="mt-2 text-[11px] italic text-[#8e8e8e]">… (truncated — Nalu still sees this much)</div>}
                  </>
                ) : (
                  <span className="italic text-[#8e8e8e]">No preview available for this file.</span>
                )}
              </div>
            )
          })()}
        </>
      )}
      </>
      )}
    </aside>
  )
}

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
    <div className="ml-3 mt-1 border-l border-white/[0.12] pl-2">
      <div className="flex gap-1">
        <button
          onClick={() => setTab((t) => (t === 'files' ? null : 'files'))}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
            tab === 'files' ? 'bg-white/10 text-[#ededed]' : 'text-[#9a9a9a] hover:bg-white/5'
          }`}
        >
          <Paperclip size={12} /> Files{fileCount > 0 && <span className="text-[10px] text-[#6e6e6e]">{fileCount}</span>}
        </button>
        <button
          onClick={() => setTab((t) => (t === 'notes' ? null : 'notes'))}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
            tab === 'notes' ? 'bg-white/10 text-[#ededed]' : 'text-[#9a9a9a] hover:bg-white/5'
          }`}
        >
          <StickyNote size={12} /> Notes{notes.trim() && <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />}
        </button>
      </div>

      {tab === 'files' && (
        <div className="mt-1.5 max-h-64 space-y-2 overflow-y-auto pb-1">
          <div>
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[#6e6e6e]">Attached</div>
            {attachments.length === 0 ? (
              <div className="text-[10px] text-[#6e6e6e]">Attach files with the clip in the message box.</div>
            ) : (
              attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-[#ededed] hover:bg-white/5">
                  <FileText size={12} className="shrink-0 text-[#9fd0ff]" />
                  <span className="truncate flex-1">{a.name}</span>
                  <button onClick={() => open(a)} title="Open" className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white">
                    <ExternalLink size={12} />
                  </button>
                  <button onClick={() => download(a)} title="Download" className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white">
                    <Download size={12} />
                  </button>
                  <button onClick={() => onRemove(a.id)} title="Remove" className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white">
                    <X size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
          {built.length > 0 && (
            <div>
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[#6e6e6e]">Built in this chat</div>
              {built.map((bA, i) => {
                const Icon = ARTIFACT_ICON[bA.kind] || FileText
                return (
                  <div key={i} className="flex items-center gap-1 rounded-md px-1 py-1 text-[11px] text-[#ededed] hover:bg-white/5">
                    <Icon size={12} className="shrink-0 text-[#c9b891]" />
                    <button onClick={() => onOpenBuilt(bA.mi)} className="flex-1 truncate text-left hover:text-white" title="Open in chat (download from there)">
                      {bA.label}
                    </button>
                    <button onClick={() => onOpenBuilt(bA.mi)} title="Open" className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white">
                      <ExternalLink size={12} />
                    </button>
                    <button onClick={() => onDeleteBuilt(bA.mi)} title="Delete" className="shrink-0 rounded p-0.5 text-[#9a9a9a] hover:bg-white/10 hover:text-white">
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
          className="mt-1.5 h-28 w-full resize-y rounded-md border border-white/15 bg-white/[0.05] px-2 py-1.5 text-[11px] text-[#ededed] outline-none focus:border-white/30"
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
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="rounded-2xl border border-white/[0.14] bg-white/[0.11] backdrop-blur-2xl px-3 py-2.5 focus-within:border-white/20 transition-colors">
      {/* Attached files — shown right in the prompt so you can see they're there. */}
      {(attachments.length > 0 || attaching) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {attachments.map((a) => (
            <span key={a.id} className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2 py-1 text-[11px] text-[#ededed]">
              <FileText size={12} className="shrink-0 text-[#9fd0ff]" />
              <span className="truncate">{a.name}</span>
              <button onClick={() => onRemoveAttachment(a.id)} className="shrink-0 text-[#8e8e8e] hover:text-white" aria-label="Remove">
                <X size={11} />
              </button>
            </span>
          ))}
          {attaching && (
            <span className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2 py-1 text-[11px] text-[#9a9a9a]">
              <Loader2 size={11} className="animate-spin" /> reading…
            </span>
          )}
          {attachments.length > 0 && !attaching && (
            <span className="w-full text-[10px] text-[#6e6e6e]">Kept in this chat for Nalu to reference — cleared from your prompt when you send.</span>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.css,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sh,.sql,.log,.tex,text/*,application/pdf,application/json"
        onChange={(e) => {
          if (e.target.files && e.target.files.length) onAttach(e.target.files)
          e.target.value = ''
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={attaching}
        title="Attach a document for Nalu to examine"
        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-[#ededed] hover:bg-white/20 disabled:opacity-50"
        aria-label="Attach"
      >
        {attaching ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
      </button>
      <textarea
        ref={taRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        rows={1}
        placeholder="Ask Nalu to do anything"
        className="flex-1 bg-transparent outline-none resize-none text-[15px] placeholder:text-[#6e6e6e] max-h-40 py-1"
        style={{ height: 'auto' }}
        onInput={(e) => {
          const t = e.currentTarget
          t.style.height = 'auto'
          t.style.height = Math.min(t.scrollHeight, 160) + 'px'
        }}
      />
      {streaming ? (
        <button
          onClick={onStop}
          className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0"
          aria-label="Stop"
        >
          <Square size={14} />
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={!input.trim()}
          className="w-8 h-8 rounded-lg bg-white text-black disabled:bg-white/15 disabled:text-white/40 flex items-center justify-center shrink-0 transition-colors"
          aria-label="Send"
        >
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      )}
      </div>
    </div>
  )
}
