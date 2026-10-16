import WorkspaceIntro from './WorkspaceIntro'
// Nalu Memory — a second BRAIN. It aggregates everything the account has done
// (chats, Studio items, Map items, AutoPilot pipelines, attachments in & out) — the
// same data that syncs across n4lu.com / n4lu.ai / Desktop / Mobile — and lays it out
// as a living brain: a luminous core, the brain's LOBES as major regions, and each
// memory clustered under the lobe it belongs to. Click any node for a breakdown of
// what's inside. As you keep asking questions the lobes fill in and the brain grows —
// the substrate the Inkling model learns you from. Web-only (ships only in the web client).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Brain, MessageSquare, Palette, MapPin, Bot, ArrowDownToLine, ArrowUpFromLine, X, ExternalLink } from 'lucide-react'

// ---- brain regions -------------------------------------------------------------
// Each lobe owns a family of memory and its own shade of blue (the app's aesthetic).
type LobeId = 'frontal' | 'temporal' | 'parietal' | 'occipital' | 'limbic'
interface Lobe { id: LobeId; name: string; role: string; color: string; how: string; grow: string[] }
const LOBES: Lobe[] = [
  { id: 'frontal', name: 'Frontal', role: 'Planning & agents — AutoPilot, automations, strategy', color: '#2f6bff',
    how: 'Your planning center. Like the human frontal lobe (decisions, planning, executive control), it holds everything Nalu does FOR you — AutoPilot pipelines, automations, and strategy, sales & marketing thinking.',
    grow: ['Build AutoPilot pipelines & automations', 'Ask strategy, sales and go-to-market questions', 'Let agents run tasks on a schedule'] },
  { id: 'temporal', name: 'Temporal', role: 'Language & conversation — chats, writing, email', color: '#39a7ff',
    how: 'Your language center. Like the human temporal lobe (language, meaning, verbal memory), it holds your conversations and everything written — chats, essays, letters and email.',
    grow: ['Keep chatting — every conversation is a neuron', 'Draft writing (essays, letters, posts) and emails', 'Ask follow-up questions to deepen a thread'] },
  { id: 'parietal', name: 'Parietal', role: 'Numbers & space — sheets, finance, maps', color: '#22d3ee',
    how: 'Your numbers-and-space center. Like the human parietal lobe (quantities, geometry, navigation), it holds spreadsheets, financial models, and everything you map.',
    grow: ['Build spreadsheets & financial models', 'Open and save map layers, zoning and parcels', 'Ask finance, budgeting and data questions'] },
  { id: 'occipital', name: 'Occipital', role: 'Vision & design — designs, decks, images, video', color: '#4f86d9',
    how: 'Your visual center. Like the human occipital lobe (sight and imagery), it holds everything visual Nalu makes — designs, decks, logos, images and video.',
    grow: ['Generate designs, logos and brand kits', 'Build slide decks and presentations', 'Create images and video'] },
  { id: 'limbic', name: 'Limbic', role: 'Knowledge & memory — documents, research, notes', color: '#4aa3e0',
    how: 'Your knowledge & memory core. Like the human limbic system (long-term memory and what matters to you), it holds documents, research, and reference knowledge.',
    grow: ['Write and save documents & reports', 'Do research and keep the findings', 'Save legal, health and personal reference notes'] },
]
const LOBE_BY: Record<LobeId, Lobe> = Object.fromEntries(LOBES.map((l) => [l.id, l])) as Record<LobeId, Lobe>
const CORE = '#e6a83a' // the PRIMARY node — warm Nalu gold so it's always visible (light or dark) and distinct from the blue lobes

// Every node renders as the Nalu wolf logo, tinted to its colour. We tint once per
// colour into an offscreen sprite and blit it each frame (cheap).
const WOLF: HTMLImageElement | null = typeof Image !== 'undefined' ? new Image() : null
if (WOLF) WOLF.src = '/wolf-icon.png'
const tintCache = new Map<string, HTMLCanvasElement>()
function tintedWolf(color: string): HTMLCanvasElement | null {
  if (!WOLF || !WOLF.complete || !WOLF.naturalWidth) return null
  const hit = tintCache.get(color)
  if (hit) return hit
  const S = 80
  const c = document.createElement('canvas'); c.width = S; c.height = S
  const g = c.getContext('2d'); if (!g) return null
  g.drawImage(WOLF, 0, 0, S, S)
  g.globalCompositeOperation = 'source-in' // keep the wolf shape, recolour it
  g.fillStyle = color; g.fillRect(0, 0, S, S)
  tintCache.set(color, c)
  return c
}

type Kind = 'doc' | 'sheet' | 'deck' | 'design' | 'email' | 'video' | 'cad' | 'image'
const KIND_LOBE: Record<Kind, LobeId> = { doc: 'limbic', sheet: 'parietal', deck: 'occipital', design: 'occipital', email: 'temporal', video: 'occipital', cad: 'occipital', image: 'occipital' }
const KIND_LABEL: Record<Kind, string> = { doc: 'Document', sheet: 'Sheet', deck: 'Deck', design: 'Design', email: 'Email', video: 'Video', cad: 'CAD', image: 'Image' }

// topic -> lobe, so conversations cluster into the right region
const TOPICS: { id: string; label: string; lobe: LobeId; re: RegExp }[] = [
  { id: 'finance', label: 'Finance', lobe: 'parietal', re: /\b(financ\w*|invest\w*|budget\w*|revenue|valuation|arr|mrr|ebitda|profit|pricing|fundrais\w*|equity|stocks?)\b/i },
  { id: 'legal', label: 'Legal', lobe: 'limbic', re: /\b(contract|lease|nda|legal|agreement|clause|compliance|terms|policy)\b/i },
  { id: 'realestate', label: 'Real Estate', lobe: 'parietal', re: /\b(real estate|property|rental|landlord|tenant|mortgage|cap rate|noi|listing)\b/i },
  { id: 'health', label: 'Health', lobe: 'limbic', re: /\b(workout|nutrition|diet|meal plan|fitness|wellness|health|medical|clinical|patient)\b/i },
  { id: 'marketing', label: 'Marketing', lobe: 'frontal', re: /\b(marketing|brand\w*|campaign|social (media )?post|seo|content (calendar|plan)|audience|funnel|carousel)\b/i },
  { id: 'tech', label: 'Tech', lobe: 'frontal', re: /\b(software|code|api|app|website|saas|platform|engineer\w*|deploy\w*|database|frontend|backend)\b/i },
  { id: 'sales', label: 'Sales', lobe: 'frontal', re: /\b(sales|pitch|prospect|deal|pipeline|go.?to.?market|outreach|cold email)\b/i },
  { id: 'education', label: 'Education', lobe: 'temporal', re: /\b(lesson|course|study guide|worksheet|curriculum|tutorial|teach\w*|homework|exam|quiz)\b/i },
  { id: 'science', label: 'Science', lobe: 'parietal', re: /\b(research|scientific|physics|chemistry|biology|experiment|hypothesis|paper|study)\b/i },
  { id: 'writing', label: 'Writing', lobe: 'temporal', re: /\b(essay|article|blog|story|letter|memo|novel|screenplay|poem|newsletter)\b/i },
  { id: 'travel', label: 'Travel', lobe: 'parietal', re: /\b(travel|trip|itinerary|vacation|flight|hotel|destination|tour)\b/i },
  { id: 'design', label: 'Design', lobe: 'occipital', re: /\b(logo|brand kit|palette|typography|ui|ux|mockup|wireframe|landing page)\b/i },
]

// ---- data shapes (mirror Workspace localStorage) --------------------------------
interface Att { name?: string }
interface Msg { role: 'user' | 'assistant'; content?: string; attachments?: Att[]; sheet?: unknown; doc?: unknown; email?: unknown; video?: unknown; cad?: unknown; design?: unknown; deck?: unknown; image?: unknown }
interface Chat { id: string; title?: string; messages?: Msg[]; createdAt?: number; projectId?: string; attachments?: Att[] }

interface NodeMeta { chatId?: string; lobe?: LobeId; counts?: Record<string, number>; sub?: string }
type NType = 'core' | 'lobe' | 'chat' | 'topic' | Kind | 'map' | 'flow'
interface GNode { id: string; label: string; type: NType; color: string; r: number; x: number; y: number; vx: number; vy: number; fixed?: boolean; meta: NodeMeta }
interface GLink { a: string; b: string; k: number }
interface Summary { chats: number; studio: number; map: number; autopilot: number; attIn: number; attOut: number; qa: number; lobeCounts: Record<LobeId, number> }

function readJSON<T>(key: string): T | null { try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null } catch { return null } }
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const attachments = (value: unknown): Att[] => arr(value).filter((v): v is Record<string, unknown> & { name: string } => record(v) && nonempty(v.name))
const namedRecord = (v: unknown): v is Record<string, unknown> & { id: string } => record(v) && nonempty(v.id)
const recordLabel = (value: Record<string, unknown>, fallback: string) => [value.name, value.title, value.label].find(nonempty) || fallback
const MEMORY_KEYS = new Set(['nalu-chats', 'nalu-agent-flows', 'nalu-automations', 'nalu-map-active-layers', 'nalu-map-shapes'])

// Saved data can come from older clients or a partially recovered browser store.
// Normalize only the read model; never rewrite or delete the original records.
function memoryChats(value: unknown): Chat[] {
  const seen = new Set<string>()
  return arr(value).flatMap((chat): Chat[] => {
    if (!record(chat) || typeof chat.id !== 'string' || !chat.id.trim() || seen.has(chat.id)) return []
    seen.add(chat.id)
    return [{
      id: chat.id,
      title: typeof chat.title === 'string' && chat.title.trim() ? chat.title : 'Untitled chat',
      attachments: attachments(chat.attachments),
      messages: arr(chat.messages).filter((m): m is Record<string, unknown> & { role: Msg['role'] } => record(m) && (m.role === 'user' || m.role === 'assistant')).map((m) => {
        const message: Msg = { role: m.role, content: typeof m.content === 'string' ? m.content : '', attachments: attachments(m.attachments) }
        for (const kind of ['doc', 'sheet', 'deck', 'design', 'email'] as const) if (record(m[kind])) message[kind] = m[kind]
        // CAD source and video URLs are strings in the persisted message model.
        for (const kind of ['cad', 'video'] as const) if (nonempty(m[kind])) message[kind] = m[kind]
        if (record(m.image) || nonempty(m.image)) message.image = m.image
        return message
      }),
    }]
  })
}

// Build the whole brain from local knowledge.
function buildBrain(): { nodes: GNode[]; links: GLink[]; summary: Summary } {
  const chats = memoryChats(readJSON<unknown>('nalu-chats'))
  const flows = arr(readJSON<unknown[]>('nalu-agent-flows')).filter(namedRecord)
  const autos = arr(readJSON<unknown[]>('nalu-automations')).filter(namedRecord)
  const mapLayers = [...new Set(arr(readJSON<unknown[]>('nalu-map-active-layers')).filter(nonempty))]
  const mapShapes = arr(readJSON<unknown[]>('nalu-map-shapes')).filter(record)

  const nodes: GNode[] = []
  const links: GLink[] = []
  const seen = new Set<string>()
  const lobeCounts: Record<LobeId, number> = { frontal: 0, temporal: 0, parietal: 0, occipital: 0, limbic: 0 }
  const summary: Summary = { chats: 0, studio: 0, map: 0, autopilot: 0, attIn: 0, attOut: 0, qa: 0, lobeCounts }

  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const add = (n: Omit<GNode, 'x' | 'y' | 'vx' | 'vy'>, near?: { x: number; y: number }) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const a = rnd() * Math.PI * 2, rad = 60 + rnd() * 120
    const x = (near ? near.x : 0) + Math.cos(a) * rad
    const y = (near ? near.y : 0) + Math.sin(a) * rad
    nodes.push({ ...n, x, y, vx: 0, vy: 0 })
  }

  // The core is pinned at the gravity center (0,0) — everything orbits it.
  seen.add('core')
  nodes.push({ id: 'core', label: 'Your Nalu', type: 'core', color: CORE, r: 20, fixed: true, meta: {}, x: 0, y: 0, vx: 0, vy: 0 })
  // lobes seeded in a rough brain ring around the core
  const lobePos: Record<LobeId, { x: number; y: number }> = {} as Record<LobeId, { x: number; y: number }>
  LOBES.forEach((l, i) => {
    const ang = (-90 + (i * 360) / LOBES.length) * (Math.PI / 180)
    const p = { x: Math.cos(ang) * 240, y: Math.sin(ang) * 200 }
    lobePos[l.id] = p
    seen.add('lobe:' + l.id)
    nodes.push({ id: 'lobe:' + l.id, label: l.name, type: 'lobe', color: l.color, r: 11, meta: { lobe: l.id, counts: {} }, x: p.x, y: p.y, vx: 0, vy: 0 })
    links.push({ a: 'core', b: 'lobe:' + l.id, k: 0.9 })
  })

  const topicHits = new Map<string, number>()
  for (const c of chats) {
    if (!c || !c.id) continue
    summary.chats++
    // attachments INTO the ai (user uploads on the chat + user messages)
    summary.attIn += arr(c.attachments).length
    const msgs = arr(c.messages) as Msg[]
    let qa = 0
    const artifactKinds: Kind[] = []
    for (const m of msgs) {
      if (!m) continue
      if (m.role === 'user') { summary.attIn += arr(m.attachments).length; if (typeof m.content === 'string' && m.content.trim()) qa++ }
      else summary.attOut += arr(m.attachments).length
      for (const k of ['doc', 'sheet', 'deck', 'design', 'email', 'cad'] as Kind[]) if ((m as unknown as Record<string, unknown>)[k]) { summary.studio++; artifactKinds.push(k) }
      for (const k of ['image', 'video'] as Kind[]) if ((m as unknown as Record<string, unknown>)[k]) { summary.attOut++; artifactKinds.push(k) }
    }
    summary.qa += qa
    // which lobe does this chat belong to? dominant topic, else the first artifact, else temporal
    const text = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ').slice(0, 16000)
    const topics = TOPICS.filter((t) => t.re.test(text))
    for (const t of topics) topicHits.set(t.id, (topicHits.get(t.id) || 0) + 1)
    const lobe: LobeId = topics[0]?.lobe || (artifactKinds[0] ? KIND_LOBE[artifactKinds[0]] : 'temporal')
    lobeCounts[lobe]++
    const cid = 'chat:' + c.id
    const kindCounts: Record<string, number> = {}
    for (const k of artifactKinds) kindCounts[k] = (kindCounts[k] || 0) + 1
    add({ id: cid, label: c.title || 'Untitled chat', type: 'chat', color: LOBE_BY[lobe].color, r: 5.5, meta: { chatId: c.id, lobe, counts: kindCounts, sub: `${msgs.length} messages` } }, lobePos[lobe])
    links.push({ a: 'lobe:' + lobe, b: cid, k: 0.5 })
    // a few artifact nodes hanging off the chat (cap to keep it readable)
    let made = 0
    for (const m of msgs) {
      if (made >= 4) break
      for (const k of ['deck', 'design', 'sheet', 'doc'] as Kind[]) {
        const v = (m as unknown as Record<string, unknown>)[k]
        if (v && made < 4) {
          const title = v && typeof v === 'object' && typeof (v as { title?: unknown }).title === 'string' ? (v as { title: string }).title : KIND_LABEL[k]
          const aid = `${cid}:${k}:${made}`
          add({ id: aid, label: title || KIND_LABEL[k], type: k, color: LOBE_BY[KIND_LOBE[k]].color, r: 4, meta: { chatId: c.id, sub: KIND_LABEL[k] } }, lobePos[lobe])
          links.push({ a: cid, b: aid, k: 0.8 })
          made++
        }
      }
    }
  }

  // topic nodes attached to their lobe
  for (const t of TOPICS) {
    const n = topicHits.get(t.id)
    if (!n) continue
    add({ id: 'topic:' + t.id, label: t.label, type: 'topic', color: LOBE_BY[t.lobe].color, r: 6 + Math.min(6, n), meta: { lobe: t.lobe, sub: `${n} chat${n === 1 ? '' : 's'}` } }, lobePos[t.lobe])
    links.push({ a: 'lobe:' + t.lobe, b: 'topic:' + t.id, k: 0.35 })
  }

  // map items -> parietal
  summary.map = mapLayers.length + mapShapes.length
  ;[...mapLayers, ...mapShapes].slice(0, 24).forEach((m, i) => {
    const label = typeof m === 'string' ? m : recordLabel(m, `Layer ${i + 1}`)
    const id = 'map:' + i
    add({ id, label: label.slice(0, 30), type: 'map', color: LOBE_BY.parietal.color, r: 4.5, meta: { lobe: 'parietal', sub: 'Map layer' } }, lobePos.parietal)
    links.push({ a: 'lobe:parietal', b: id, k: 0.4 })
  })

  // autopilot items -> frontal
  summary.autopilot = flows.length + autos.length
  ;[...flows, ...autos].slice(0, 24).forEach((f, i) => {
    const label = recordLabel(f, `Pipeline ${i + 1}`)
    const id = 'flow:' + i
    add({ id, label: label.slice(0, 30), type: 'flow', color: LOBE_BY.frontal.color, r: 5, meta: { lobe: 'frontal', sub: 'AutoPilot pipeline' } }, lobePos.frontal)
    links.push({ a: 'lobe:frontal', b: id, k: 0.45 })
  })

  // Each lobe physically STRENGTHENS with use — its size grows with how many
  // memories feed it, so the brain builds out unevenly based on what you actually
  // do (a human brain thickens the regions it uses most).
  for (const l of LOBES) {
    const node = nodes.find((n) => n.id === 'lobe:' + l.id)
    if (!node) continue
    const members = nodes.filter((n) => n.meta.lobe === l.id && n.type !== 'lobe').length
    node.meta.counts = { members }
    node.r = 9 + Math.min(13, Math.sqrt(members) * 2.4)
  }
  // The core grows as the whole brain fills in.
  const core = nodes.find((n) => n.id === 'core')
  if (core) core.r = 18 + Math.min(10, Math.sqrt(summary.chats + summary.studio + summary.map + summary.autopilot) * 1.3)
  return { nodes, links, summary }
}

// how "formed" the brain is: lobes with content, scaled by volume
function brainProgress(s: Summary): { pct: number; activeLobes: number } {
  const active = (Object.values(s.lobeCounts) as number[]).filter((n) => n > 0).length
  const total = s.chats + s.studio + s.map + s.autopilot
  const volume = Math.min(1, total / 60) // ~60 memories reads as a full first brain
  const pct = Math.round(((active / LOBES.length) * 0.5 + volume * 0.5) * 100)
  return { pct, activeLobes: active }
}

export default function MemoryPanel({ onOpenChat }: { onOpenChat?: (chatId: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [brain, setBrain] = useState(buildBrain)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Resolve the current node each render, so an open drawer cannot retain an old
  // title/count or an Open chat action for a deleted entry after hydration.
  const selected = brain.nodes.find((node) => node.id === selectedId) || null
  const cam = useRef({ x: 0, y: 0, z: 1 })
  const hoverRef = useRef<GNode | null>(null)
  const selRef = useRef<string | null>(null)
  useEffect(() => { selRef.current = selected?.id ?? null }, [selected])

  useEffect(() => {
    const refresh = () => {
      const next = buildBrain()
      hoverRef.current = null
      setSelectedId((id) => id && next.nodes.some((node) => node.id === id) ? id : null)
      setBrain(next)
    }
    const onStorage = (event: StorageEvent) => {
      if ((!event.storageArea || event.storageArea === localStorage) && (event.key === null || MEMORY_KEYS.has(event.key))) refresh()
    }
    window.addEventListener('nalu-hydrated', refresh)
    window.addEventListener('nalu-session-cleared', refresh)
    window.addEventListener('storage', onStorage)
    // Cover a hydration that completed between the initial render and subscription.
    refresh()
    return () => {
      window.removeEventListener('nalu-hydrated', refresh)
      window.removeEventListener('nalu-session-cleared', refresh)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')!
    const nodes = brain.nodes
    const links = brain.links
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const adj = new Map<string, Set<string>>()
    for (const l of links) { (adj.get(l.a) || adj.set(l.a, new Set()).get(l.a)!).add(l.b); (adj.get(l.b) || adj.set(l.b, new Set()).get(l.b)!).add(l.a) }

    let W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1)
    const resize = () => { W = wrap.clientWidth; H = wrap.clientHeight; dpr = Math.min(2, window.devicePixelRatio || 1); canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px' }
    resize()
    const ro = new ResizeObserver(resize); ro.observe(wrap)

    let alpha = 1, t = 0
    const step = () => {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const d2 = dx * dx + dy * dy || 0.01
          if (d2 > 96000) continue
          const f = (1500 * alpha) / d2, d = Math.sqrt(d2), ux = dx / d, uy = dy / d
          if (!a.fixed) { a.vx += ux * f; a.vy += uy * f }
          if (!b.fixed) { b.vx -= ux * f; b.vy -= uy * f }
        }
      }
      for (const l of links) {
        const a = byId.get(l.a), b = byId.get(l.b); if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const rest = 62 + (a.r + b.r) * 2, f = (d - rest) * 0.02 * l.k * alpha, ux = dx / d, uy = dy / d
        if (!a.fixed) { a.vx += ux * f; a.vy += uy * f }
        if (!b.fixed) { b.vx -= ux * f; b.vy -= uy * f }
      }
      for (const n of nodes) {
        if (n.fixed) { n.vx = 0; n.vy = 0; continue }
        n.vx += -n.x * 0.0015 * alpha; n.vy += -n.y * 0.0015 * alpha
        n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy
      }
      if (alpha > 0.03) alpha *= 0.994
    }

    const draw = () => {
      t += 0.016
      const isDark = document.documentElement.classList.contains('dark')
      const hov = hoverRef.current, sel = selRef.current
      const active = hov ? adj.get(hov.id) : sel ? adj.get(sel) : null
      const focusId = hov?.id || sel
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H) // transparent — NO background box; sits on the app itself
      ctx.save()
      ctx.translate(W / 2 + cam.current.x, H / 2 + cam.current.y)
      ctx.scale(cam.current.z, cam.current.z)
      // links
      ctx.lineWidth = 1 / cam.current.z
      for (const l of links) {
        const a = byId.get(l.a), b = byId.get(l.b); if (!a || !b) continue
        const lit = focusId && (l.a === focusId || l.b === focusId)
        ctx.strokeStyle = lit ? 'rgba(150,195,255,0.5)' : 'rgba(110,160,235,0.11)'
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      // nodes (with glow)
      for (const n of nodes) {
        const dim = focusId && n.id !== focusId && !active?.has(n.id)
        const pulse = n.type === 'core' ? 1 + Math.sin(t * 1.6) * 0.06 : n.type === 'lobe' ? 1 + Math.sin(t * 1.2 + n.x) * 0.04 : 1
        const r = n.r * pulse
        // The core (primary) wolf renders BLACK in light mode (near-white in dark so it
        // stays visible); every other node keeps its lobe colour.
        const col = n.type === 'core' ? (isDark ? '#eef2f8' : '#141414') : n.color
        ctx.globalAlpha = dim ? 0.2 : 1
        // glow halo in the node's colour
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2)
        g.addColorStop(0, col + 'cc'); g.addColorStop(0.5, col + '33'); g.addColorStop(1, col + '00')
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2); ctx.fill()
        // A selected node just gets a brighter, larger glow — NO outline ring.
        if (n.id === sel) {
          const sg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 4.4)
          sg.addColorStop(0, col + 'aa'); sg.addColorStop(0.6, col + '22'); sg.addColorStop(1, col + '00')
          ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(n.x, n.y, r * 4.4, 0, Math.PI * 2); ctx.fill()
        }
        // the node IS the Nalu wolf logo, tinted. A soft dark drop-shadow gives every
        // wolf contrast on a BRIGHT wallpaper (light mode) without any background box.
        const wolf = tintedWolf(col)
        if (wolf) {
          const sz = r * 2.5
          ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = Math.max(4, r * 0.75); ctx.shadowOffsetY = 0.5
          ctx.drawImage(wolf, n.x - sz / 2, n.y - sz / 2, sz, sz)
          ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetY = 0
        } else { ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill() }
        const showLabel = n.type === 'core' || n.type === 'lobe' || n.type === 'topic' || n.id === focusId || active?.has(n.id) || cam.current.z > 1.6
        if (showLabel && !dim) {
          ctx.globalAlpha = 1
          ctx.font = `${(n.type === 'core' ? 14 : n.type === 'lobe' ? 12 : 11) / cam.current.z}px ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          // Theme-aware labels with an OPPOSITE-colour halo, so they read on the light
          // sky (dark text + white halo) or in dark mode (light text + dark halo).
          ctx.shadowColor = isDark ? 'rgba(2,6,16,0.92)' : 'rgba(255,255,255,0.95)'; ctx.shadowBlur = 5
          ctx.fillStyle = isDark ? 'rgba(244,248,255,0.98)' : 'rgba(20,28,42,0.96)'
          ctx.fillText(n.label.slice(0, 28), n.x, n.y + r + 13 / cam.current.z)
          ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'
        }
      }
      ctx.globalAlpha = 1; ctx.restore()
    }

    let raf = 0
    const loop = () => { step(); draw(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)

    const toWorld = (cx: number, cy: number) => ({ x: (cx - W / 2 - cam.current.x) / cam.current.z, y: (cy - H / 2 - cam.current.y) / cam.current.z })
    const pick = (cx: number, cy: number): GNode | null => {
      const w = toWorld(cx, cy); let best: GNode | null = null, bd = 1e9
      for (const n of nodes) { const dx = n.x - w.x, dy = n.y - w.y, d = dx * dx + dy * dy, rr = (n.r + 7) * (n.r + 7); if (d < rr && d < bd) { bd = d; best = n } }
      return best
    }
    let dragNode: GNode | null = null, panning = false, lastX = 0, lastY = 0, moved = false
    const rect = () => canvas.getBoundingClientRect()
    const onDown = (e: PointerEvent) => { const r = rect(); const n = pick(e.clientX - r.left, e.clientY - r.top); moved = false; lastX = e.clientX; lastY = e.clientY; if (n && n.type !== 'core') { dragNode = n; n.fixed = true } else panning = true; canvas.setPointerCapture(e.pointerId) }
    const onMove = (e: PointerEvent) => {
      const r = rect(); const cx = e.clientX - r.left, cy = e.clientY - r.top
      if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 3) moved = true
      if (dragNode) { const w = toWorld(cx, cy); dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0; alpha = Math.max(alpha, 0.4) }
      else if (panning) { cam.current.x += e.clientX - lastX; cam.current.y += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY }
      else hoverRef.current = pick(cx, cy)
      canvas.style.cursor = hoverRef.current || dragNode ? 'pointer' : 'grab'
    }
    const onUp = (e: PointerEvent) => {
      const r = rect()
      const clicked = !moved ? pick(e.clientX - r.left, e.clientY - r.top) : null
      if (dragNode && dragNode.type !== 'core') dragNode.fixed = false
      dragNode = null; panning = false
      if (clicked) setSelectedId(clicked.id) // a click opens the breakdown
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = rect(); const cx = e.clientX - r.left - W / 2 - cam.current.x, cy = e.clientY - r.top - H / 2 - cam.current.y
      const f = Math.exp(-e.deltaY * 0.0015), nz = Math.min(4, Math.max(0.25, cam.current.z * f)), ratio = nz / cam.current.z
      cam.current.x -= cx * (ratio - 1); cam.current.y -= cy * (ratio - 1); cam.current.z = nz
    }
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => { cancelAnimationFrame(raf); ro.disconnect(); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('wheel', onWheel) }
  }, [brain])

  const s = brain.summary
  const total = s.chats + s.studio + s.map + s.autopilot
  const prog = brainProgress(s)

  return (
    <div className="ws-memory ws-feature-page flex flex-1 min-h-0 flex-col text-ink font-sans">
      <WorkspaceIntro compact label="Memory" title="All the little things." description="The ideas, conversations, and work that make Nalu yours."/>
      <div ref={wrapRef} className="relative flex-1 min-h-0 overflow-hidden">
        <canvas ref={canvasRef} className="absolute inset-0 touch-none" />
        {total <= 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center">
            <div className="max-w-sm text-ink/75">
              <Brain size={32} className="mx-auto mb-3 opacity-70 text-[#3b82f6]" />
              <p className="text-sm">Your brain is empty. Start chatting and building — every conversation, Studio item, map layer, pipeline and attachment becomes a neuron, and the lobes fill in as you go.</p>
            </div>
          </div>
        )}
        {/* legend: the lobes — a theme-adaptive glass chip (light in light mode) */}
        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-white/70 px-3 py-2 shadow-sm backdrop-blur-md dark:bg-black/40">
          {LOBES.map((l) => (
            <span key={l.id} className="flex items-center gap-1.5 text-[11px] text-ink/80"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color, boxShadow: `0 0 6px ${l.color}` }} /> {l.name}</span>
          ))}
        </div>

        {/* breakdown panel */}
        {selected && (
          <Breakdown node={selected} summary={s} prog={prog} onClose={() => setSelectedId(null)} onOpenChat={onOpenChat} />
        )}
      </div>
    </div>
  )
}

// The drawer adapts to the theme: a LIGHT frosted-glass panel in light mode, a dark
// one in dark mode — so it's legible either way and never a "dark background" in light
// mode. Text uses the theme `ink` token (dark on light, light on dark).
function Row({ icon, label, value, color }: { icon: ReactNode; label: string; value: number; color?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-black/[0.045] dark:bg-white/[0.07] px-3 py-2.5">
      <span className="grid h-6 w-6 place-items-center rounded-md" style={{ color: color || '#3b82f6', background: (color || '#3b82f6') + '26' }}>{icon}</span>
      <span className="flex-1 text-[12.5px] text-ink/90">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-ink">{value}</span>
    </div>
  )
}

function Breakdown({ node, summary: s, prog, onClose, onOpenChat }: { node: GNode; summary: Summary; prog: { pct: number; activeLobes: number }; onClose: () => void; onOpenChat?: (id: string) => void }) {
  const isCore = node.type === 'core'
  const lobe = node.type === 'lobe' ? LOBE_BY[node.meta.lobe as LobeId] : node.meta.lobe ? LOBE_BY[node.meta.lobe] : null
  const c = node.meta.counts || {}
  const openBtn = node.meta.chatId && onOpenChat
    ? <button onClick={() => onOpenChat!(node.meta.chatId!)} className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#2f6bff] py-2.5 text-[12.5px] font-medium text-white hover:bg-[#4d84ff]"><ExternalLink size={13} /> Open chat</button>
    : null
  return (
    <div className="absolute right-3 top-3 bottom-3 flex w-[304px] max-w-[80%] flex-col overflow-hidden rounded-2xl bg-white/85 dark:bg-[#0f1420]/90 shadow-2xl shadow-black/20 dark:shadow-black/50 backdrop-blur-2xl">
      <div className="flex items-center gap-2.5 px-4 py-3.5">
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: node.color, boxShadow: `0 0 8px ${node.color}` }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{node.label}</div>
          <div className="text-[11px] text-ink/55">{isCore ? 'Your Nalu brain' : node.type === 'lobe' ? `${lobe?.name} lobe` : node.meta.sub || node.type}</div>
        </div>
        <button onClick={onClose} className="text-ink/55 hover:text-ink"><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 space-y-2.5">
        {isCore && (
          <>
            <div className="rounded-xl bg-gradient-to-br from-[#2f6bff]/20 to-[#22d3ee]/12 px-3.5 py-3">
              <div className="flex items-baseline justify-between"><span className="text-[12px] text-ink/70">Brain forming</span><span className="text-lg font-bold text-ink">{prog.pct}%</span></div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15"><div className="h-full rounded-full bg-gradient-to-r from-[#2f6bff] to-[#22c3d6]" style={{ width: `${prog.pct}%` }} /></div>
              <div className="mt-1.5 text-[11px] text-ink/65">{prog.activeLobes}/5 lobes active · {s.qa} questions asked</div>
            </div>
            <Row icon={<MessageSquare size={13} />} label="Chats" value={s.chats} color="#2f6bff" />
            <Row icon={<Palette size={13} />} label="Studio items" value={s.studio} color="#4f86d9" />
            <Row icon={<MapPin size={13} />} label="Map items" value={s.map} color="#12a6bf" />
            <Row icon={<Bot size={13} />} label="AutoPilot items" value={s.autopilot} color="#2f6bff" />
            <Row icon={<ArrowDownToLine size={13} />} label="Attachments in" value={s.attIn} color="#3778c4" />
            <Row icon={<ArrowUpFromLine size={13} />} label="Attachments out" value={s.attOut} color="#5a9be0" />
            <p className="pt-1 text-[11px] leading-relaxed text-ink/65">Every question you ask adds a neuron. Nalu is assembling a private brain from your work — organized by the brain's lobes — that the Inkling model learns you from as you keep going.</p>
          </>
        )}
        {node.type === 'lobe' && lobe && (
          <>
            <Row icon={<Brain size={13} />} label="Memories in this lobe" value={(c.members as number) || 0} color={lobe.color} />
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: lobe.color }}>How it works</div>
              <p className="text-[12.5px] leading-relaxed text-ink/85">{lobe.how}</p>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: lobe.color }}>Grow this lobe</div>
              <ul className="space-y-1.5">
                {lobe.grow.map((g, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-xl bg-black/[0.045] dark:bg-white/[0.06] px-3 py-2.5 text-[12px] text-ink/90">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: lobe.color }} />
                    <span>{g}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-[11px] leading-relaxed text-ink/60">The more you feed it, the bigger and stronger this region grows — building a brain that works like yours.</p>
          </>
        )}
        {node.type === 'chat' && (
          <>
            <Row icon={<MessageSquare size={13} />} label="Messages" value={parseInt(node.meta.sub || '0') || 0} color={node.color} />
            {(['deck', 'design', 'sheet', 'doc'] as Kind[]).map((k) => (c[k] ? <Row key={k} icon={<Palette size={13} />} label={KIND_LABEL[k] + 's'} value={c[k] as number} color={node.color} /> : null))}
            {openBtn}
          </>
        )}
        {(node.type === 'topic' || node.type === 'map' || node.type === 'flow' || (['doc', 'sheet', 'deck', 'design', 'email', 'video', 'cad', 'image'] as string[]).includes(node.type)) && (
          <>
            <div className="rounded-xl bg-black/[0.045] dark:bg-white/[0.06] px-3 py-2.5 text-[12px] text-ink/85">{node.meta.sub || node.type}{lobe ? ` · ${lobe.name} lobe` : ''}</div>
            {openBtn}
          </>
        )}
      </div>
    </div>
  )
}
