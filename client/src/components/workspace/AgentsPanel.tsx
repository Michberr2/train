import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, Play, Plus, Trash2, X, Loader2, Clock, Power, ChevronRight,
  CircleDollarSign, Palette, MessageSquare, Code2, Bitcoin, Home, Scale,
  HeartPulse, Stethoscope, Building2, HardHat, Megaphone, BrainCircuit, FlaskConical, Sigma, Maximize2, FileText, BarChart3, Table2,
  Mail, Download, CheckCircle2, XCircle, PanelLeft, Users, type LucideIcon,
} from 'lucide-react'
import { streamChat } from './agentApi'
import { getBrand } from './brandKit'
import Markdown from './Markdown'
import { listOutputs, storeOutput, getOutputBlob, deleteOutput, downloadBlobFile, buildEmlBlob, openMailto, buildIcsBlob, buildGmailFiltersXml, buildVcfBlob, type OutputMeta, type IcsEvent, type MailRule, type VcfContact } from './agentOutputs'
import { buildEvaluator } from './formulaEval'

// Nalu Agents — a minimal, no-code agent pipeline builder. Drop Nalu
// specialists and OUTPUT steps onto the canvas, wire them, run or schedule.
// Output steps produce real files (Word docs, PowerPoints, Excel workbooks,
// email drafts) that auto-download to your Downloads folder AND are stored in
// the Outputs library. Left rail: every flow, what's running, every output.

// ---- agents + output steps --------------------------------------------------
type AgentDef = { kind: string; name: string; desc: string; icon: LucideIcon; tint: string }
const AGENTS: AgentDef[] = [
  { kind: 'general', name: 'Nalu', desc: 'Generalist — writing, planning, synthesis', icon: MessageSquare, tint: '#5B9BFF' },
  { kind: 'finance', name: 'Nalu Financial', desc: 'Elite markets, wealth & macro strategist', icon: CircleDollarSign, tint: '#34D399' },
  { kind: 'studio', name: 'Nalu Studio', desc: 'Design direction, brand & creative', icon: Palette, tint: '#E4B96F' },
  { kind: 'code', name: 'Nalu Code', desc: 'Engineering — writes & reviews code', icon: Code2, tint: '#9FD0FF' },
  { kind: 'reasoning', name: 'Nalu Reason', desc: 'Deep reasoning for hard problems', icon: BrainCircuit, tint: '#C084FC' },
  { kind: 'science', name: 'Nalu Science', desc: 'Formulas, physics/chem/bio & drug R&D', icon: FlaskConical, tint: '#22D3EE' },
  { kind: 'math', name: 'Nalu Math', desc: 'Proofs, calculus, algebra — step-by-step solutions', icon: Sigma, tint: '#818CF8' },
  { kind: 'crypto', name: 'Nalu Crypto', desc: 'Blockchain, DeFi & digital assets', icon: Bitcoin, tint: '#FBBF24' },
  { kind: 'realestate', name: 'Nalu Real Estate', desc: 'Elite property, investing & interior design', icon: Home, tint: '#F87171' },
  { kind: 'medical', name: 'Nalu Medical', desc: 'Elite clinical medicine, every specialty + med school', icon: Stethoscope, tint: '#4ADE80' },
  { kind: 'cre', name: 'Nalu CRE', desc: 'Commercial real estate: deals, leases, construction & live costs', icon: Building2, tint: '#38BDF8' },
  { kind: 'construction', name: 'Nalu Construction', desc: 'Master builder: estimating, field means & methods, live costs', icon: HardHat, tint: '#FB923C' },
  { kind: 'hr', name: 'Nalu HR', desc: 'Elite people ops: hiring, comp, ER, employment law', icon: Users, tint: '#FDBA74' },
  { kind: 'legal', name: 'Nalu Legal', desc: 'Law, contracts & compliance', icon: Scale, tint: '#A3A3A3' },
  { kind: 'health', name: 'Nalu Health', desc: 'Health, nutrition & fitness', icon: HeartPulse, tint: '#FB7185' },
  { kind: 'social', name: 'Nalu Social', desc: 'Viral posts, carousels, captions & hashtags', icon: Megaphone, tint: '#38BDF8' },
  { kind: 'marketing', name: 'Nalu Marketing', desc: 'Growth, SEO, content & campaigns', icon: Megaphone, tint: '#F472B6' },
]
type NodeType = 'agent' | 'doc' | 'pdf' | 'slides' | 'sheet' | 'csv' | 'website' | 'image' | 'video' | 'email' | 'textfile' | 'calendar' | 'mailrules' | 'contacts' | 'markdown' | 'json' | 'social'
const OUTPUTS: { type: NodeType; name: string; desc: string; icon: LucideIcon; tint: string }[] = [
  { type: 'social', name: 'Social post', desc: 'Platform-native post + caption — auto-publish via webhook', icon: Megaphone, tint: '#38BDF8' },
  { type: 'doc', name: 'Word document', desc: 'Designed .docx built from the input', icon: FileText, tint: '#9FD0FF' },
  { type: 'pdf', name: 'PDF', desc: 'Designed .pdf built from the input', icon: FileText, tint: '#F87171' },
  { type: 'slides', name: 'PowerPoint', desc: 'Branded .pptx deck from the input', icon: BarChart3, tint: '#E4B96F' },
  { type: 'sheet', name: 'Spreadsheet', desc: 'Excel .xlsx with live formulas', icon: Table2, tint: '#34D399' },
  { type: 'website', name: 'Website', desc: 'Complete .html site from the input', icon: FileText, tint: '#C084FC' },
  { type: 'image', name: 'Image', desc: 'Generated image (.jpg) from the input', icon: FileText, tint: '#FBBF24' },
  { type: 'video', name: 'Video', desc: 'Generated clip (.mp4) from the input', icon: FileText, tint: '#5B9BFF' },
  { type: 'email', name: 'Email', desc: 'Draft (.eml) + opens your mail app', icon: Mail, tint: '#F472B6' },
  { type: 'textfile', name: 'Text file', desc: 'Plain .txt of the pipeline output', icon: FileText, tint: '#A3A3A3' },
  { type: 'calendar', name: 'Meetings (.ics)', desc: 'Calendar invites — import into Outlook/Google', icon: Clock, tint: '#7DD3FC' },
  { type: 'mailrules', name: 'Email rules', desc: 'Gmail-importable inbox filters (.xml) + Outlook steps', icon: Mail, tint: '#A78BFA' },
  { type: 'csv', name: 'CSV', desc: 'Plain .csv data file — opens anywhere', icon: Table2, tint: '#4ADE80' },
  { type: 'contacts', name: 'Contacts (.vcf)', desc: 'vCards — import into Apple/Google/Outlook contacts', icon: Mail, tint: '#F9A8D4' },
  { type: 'markdown', name: 'Markdown (.md)', desc: 'Clean .md of the pipeline output', icon: FileText, tint: '#93C5FD' },
  { type: 'json', name: 'JSON (.json)', desc: 'Structured data extracted from the input', icon: Code2, tint: '#FCD34D' },
]
// COMPANY EMPLOYEES — real company roles built on the Nalu engines. Compose a
// self-sustaining company: every role acts autonomously, has full live web
// access, and can produce anything (decisions, docs, budgets, designs, code).
type RoleDef = { key: string; title: string; engine: string; desc: string; charter: string }
const COMPANY_ROLES: RoleDef[] = [
  { key: 'ceo', title: 'CEO', engine: 'reasoning', desc: 'Vision, priorities, final calls', charter: 'You own direction and capital allocation: set priorities with owners, deadlines and success criteria; kill work that does not serve the mandate; escalate nothing — decide. DELIVERABLE FORMAT: (1) top priorities ranked with owner + deliverable + metric, (2) decisions made today with one-line rationale, (3) risks you are watching. KPIs: revenue growth, runway, shipping cadence. Numbers-first, one page max.' },
  { key: 'coo', title: 'COO', engine: 'general', desc: 'Operations, process, execution', charter: 'You make the company run: convert strategy into processes, owners, timelines and SLAs; unblock every team daily; hunt waste. DELIVERABLE FORMAT: the operating plan as a table (workstream, owner, due, status, blocker + fix). KPIs: on-time delivery rate, cycle time, cost per unit of output. Escalate only true CEO decisions; solve everything else yourself.' },
  { key: 'cfo', title: 'CFO', engine: 'finance', desc: 'Budgets, forecasts, capital', charter: 'You own the money: 13-week cash view, budget vs actuals, unit economics (CAC, LTV, gross margin, payback), pricing, and capital allocation calls. DELIVERABLE FORMAT: cash position, burn/runway, variances vs plan with causes, then 2-3 allocation recommendations with expected ROI — dollar math always shown. KPIs: runway months, gross margin, forecast accuracy. Flag any spend that does not map to the mandate.' },
  { key: 'cto', title: 'CTO', engine: 'code', desc: 'Tech strategy & engineering', charter: 'You own the technology: architecture decisions with tradeoffs stated, build-vs-buy with cost math, security posture, tech-debt budget, and real code or pseudocode when it clarifies. DELIVERABLE FORMAT: what ships today, what is blocked and the unblock, architecture calls made (decision + why + reversibility), risks. KPIs: deploy frequency, uptime, lead time for changes. Bias to shipping the simplest thing that works.' },
  { key: 'cio', title: 'CIO', engine: 'code', desc: 'Systems, security, vendors', charter: 'You own internal systems: the tool stack (pick, consolidate, kill), vendor evaluation with pricing, security posture (access, backups, MFA, incident playbooks), and data flows between systems. DELIVERABLE FORMAT: recommendation, cost-per-seat math, migration steps, risks. KPIs: tooling spend per head, incident count, time to onboard a new hire.' },
  { key: 'cmo', title: 'CMO', engine: 'marketing', desc: 'Brand, growth, campaigns', charter: 'You own growth: positioning and message, channel strategy ranked by CAC, campaign briefs with hooks and CTAs ready to publish, content calendar, and funnel math. DELIVERABLE FORMAT: the growth move of the day (channel, audience, copy angle, asset, expected impact with numbers) + funnel snapshot (traffic, signup, activation, paid). KPIs: CAC, conversion rates, week-over-week signup growth. Write copy that could ship verbatim.' },
  { key: 'design', title: 'Head of Design', engine: 'studio', desc: 'Creative & brand direction', charter: 'You own the craft: brand system consistency, UX decisions justified by user goals, and creative direction concrete enough to build TODAY — layouts with real dimensions, type scale, exact hex colors, spacing, states. DELIVERABLE FORMAT: the deliverable spec (component, page, or asset) with measurements and final copy, plus what done looks like. KPIs: activation rate on designed flows, brand consistency, design-to-build turnaround. Never hand-wave — specify.' },
  { key: 'accountant', title: 'Accountant', engine: 'finance', desc: 'Books, statements, tax calendar', charter: 'You keep clean books: categorize every transaction, reconcile accounts, produce P&L, balance-sheet and cash-flow views, track AR/AP aging, and own the tax calendar (filings, estimates, 1099s/W-2s). DELIVERABLE FORMAT: ledger summary (in, out, net), items needing categorization or receipts, payables due within 7 days, next tax deadline with days remaining. KPIs: close time, uncategorized count, on-time filings. Flag anything unusual immediately.' },
  { key: 'legal', title: 'Legal Counsel', engine: 'legal', desc: 'Contracts, compliance, risk', charter: 'You protect the company without slowing it: contract review with redlines and the WHY, compliance (privacy, employment, industry rules), IP protection, and risk triage rated likelihood times impact. DELIVERABLE FORMAT: issue, practical fix, draft language ready to paste, residual risk. KPIs: contract turnaround, open risk count, zero surprise liabilities. Business-first: give the safe path that still ships.' },
  { key: 'analyst', title: 'Analyst', engine: 'general', desc: 'Research, competitors, market', charter: 'You are the company\'s eyes: monitor the market, competitors (pricing, launches, hiring), customers, and macro conditions with LIVE web research every time. DELIVERABLE FORMAT: 5-8 bullets max, each with the number that matters and the source; end with the one implication for us today. KPIs: signal-to-noise, catches before competitors react. Never pad; if nothing changed, say so in one line.' },
  { key: 'ea', title: 'Executive Assistant', engine: 'general', desc: 'Email triage, meetings, reservations', charter: 'You run the office with zero fluff: triage and organize email (concrete inbox rules for Gmail/Outlook — sender/subject to label, archive, star), schedule meetings with exact title, start/end, attendees and location ready for the calendar, book reservations (venue, date, time, party size, contact, with the request drafted to send), manage travel, and prep one-page briefings before every meeting. DELIVERABLE FORMAT: numbered sections — Meetings, Reservations, Inbox rules, Prep notes — each complete enough to execute without questions. KPIs: zero double-bookings, inbox rules that stick.' },
  { key: 'pm', title: 'Product Manager', engine: 'reasoning', desc: 'Specs, roadmap, priorities', charter: 'You turn strategy into build-ready specs: user stories with acceptance criteria, edge cases enumerated, out-of-scope stated, and a ruthless P0/P1/P2 priority order with the why. DELIVERABLE FORMAT: one spec per priority — problem, user story, acceptance criteria as checkboxes, edge cases, the metric to watch after ship. KPIs: spec-to-ship time, rework rate, feature adoption. If a spec needs a decision, propose the answer, do not ask.' },
  { key: 'sales', title: 'Sales Lead', engine: 'general', desc: 'Pipeline, prospects, outreach', charter: 'You fill the pipeline: research REAL prospects on the live web (company, contact name and title, public email, why they fit), qualify against a clear ICP, write outreach that earns replies (short, specific, one CTA), and run follow-up sequences. DELIVERABLE FORMAT: pipeline table (prospect, stage, next step, dollar value) + outreach drafts ready to send + funnel numbers (contacted, replied, meeting, closed). KPIs: meetings booked, reply rate, pipeline coverage at 3x target.' },
  { key: 'hr', title: 'Head of People', engine: 'hr', desc: 'Hiring, onboarding, culture', charter: 'You build the team: hiring plans tied to the roadmap, job posts that attract the right people, structured interview loops with scorecards, 30/60/90 onboarding, comp bands with market data, and culture rituals that scale. DELIVERABLE FORMAT: for any role — the post, the loop (stages and what each screens for), the scorecard, the onboarding checklist. KPIs: time-to-hire, 90-day retention, offer-accept rate.' },
  { key: 'support', title: 'Support Lead', engine: 'general', desc: 'Customers, replies, FAQs', charter: 'You own the customer: reply drafts in the company voice (empathetic, direct, solution-first), macros for the top issues, FAQ and doc updates driven by real tickets, churn-risk flags, and escalation calls with clear reasoning. DELIVERABLE FORMAT: replies ready to send verbatim + a top-issues table (issue, count, root cause, fix owner). KPIs: first-response time, resolution rate, CSAT. Every ticket teaches the product team something — say what.' },
]
const roleDef = (key?: string) => COMPANY_ROLES.find((r) => r.key === key)
const roleCharter = (r: RoleDef, f: { name: string; company?: Company }) =>
  [
    `You are the ${r.title} of "${f.name}".`,
    f.company?.what ? `THE COMPANY: ${f.company.what}` : '',
    f.company?.mission ? `THE MANDATE — what this company is supposed to do: ${f.company.mission}` : '',
    f.company?.notes ? `IMPORTANT COMPANY NOTES — treat these as hard rules that OVERRIDE any default behavior, follow them exactly: ${f.company.notes}` : '',
    r.charter,
    'You have FULL live web access on every turn (web_search, fetch_url, deep_research) — research anything current before deciding, and cite what you used. Act autonomously like a real executive: deliver finished work and decisions, never questions back.',
  ].filter(Boolean).join(' ')

const agentDef = (kind: string) => AGENTS.find((a) => a.kind === kind) || AGENTS[0]
const nodeMeta = (n: PNode): { name: string; icon: LucideIcon; tint: string } => {
  if (n.type === 'agent' && n.role) {
    const r = roleDef(n.role)
    if (r) return { name: r.title, icon: agentDef(r.engine).icon, tint: '#7DD3FC' }
  }
  return n.type === 'agent' ? agentDef(n.agent || 'general') : (OUTPUTS.find((o) => o.type === n.type) || OUTPUTS[0])
}

// ---- flow model + persistence -----------------------------------------------
type NodeState = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'skipped'
type PNode = { id: string; x: number; y: number; type: NodeType; agent?: string; role?: string; label: string; prompt: string; to?: string; subject?: string; auto?: boolean; time?: string; lastRunDay?: string; platform?: string; webhook?: string; format?: string; roleTitle?: string; roleNotes?: string }
type Edge = { from: string; to: string }
type Schedule = 'manual' | 'hourly' | 'daily' | 'weekly' | 'continuous' | 'members'
type Company = { what: string; mission: string; notes?: string }
type Flow = { id: string; name: string; nodes: PNode[]; edges: Edge[]; schedule: Schedule; time: string; enabled: boolean; lastRun?: number; results?: Record<string, string>; company?: Company; artifacts?: Record<string, OutputMeta> }
type Run = { id: string; flowId: string; flowName: string; startedAt: number; finishedAt?: number; status: 'running' | 'done' | 'error' | 'stopped'; note?: string }
const FLOWS_KEY = 'nalu-agent-flows'
const RUNS_KEY = 'nalu-agent-runs'
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3)

function starterFlow(): Flow {
  const n1: PNode = { id: uid(), x: 40, y: 40, type: 'agent', agent: 'general', label: 'Scan the news', prompt: "Research today's most important financial and world-economy news: central bank moves, market swings, major earnings, geopolitics. Return a tight bulleted digest with numbers." }
  const n2: PNode = { id: uid(), x: 400, y: 170, type: 'agent', agent: 'finance', label: 'Analyze like a PM', prompt: 'You are given a news digest below. Analyze it like a hedge fund PM: the 3 themes that matter, what they mean for equities/bonds/commodities, and 2-3 positioning ideas with risk framing.\n\n{{input}}' }
  const n3: PNode = { id: uid(), x: 760, y: 40, type: 'doc', label: 'Morning brief doc', prompt: 'A crisp, scannable morning market brief.' }
  return { id: uid(), name: 'Daily market brief', nodes: [n1, n2, n3], edges: [{ from: n1.id, to: n2.id }, { from: n2.id, to: n3.id }], schedule: 'daily', time: '08:00', enabled: false }
}
function loadFlows(): Flow[] {
  try {
    const arr = JSON.parse(localStorage.getItem(FLOWS_KEY) || 'null') as Flow[] | null
    // v1 flows carried agent-only nodes without a `type` — default it in.
    if (Array.isArray(arr) && arr.length) return arr.map((f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, type: n.type || 'agent' })) }))
  } catch { /* fresh */ }
  return [starterFlow()]
}
const saveFlows = (flows: Flow[]) => { try { localStorage.setItem(FLOWS_KEY, JSON.stringify(flows)) } catch { /* */ } }
const loadRuns = (): Run[] => { try { const a = JSON.parse(localStorage.getItem(RUNS_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
const saveRuns = (runs: Run[]) => { try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(0, 20))) } catch { /* */ } }

function topoOrder(nodes: PNode[], edges: Edge[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  const q = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id)
  const out: string[] = []
  while (q.length) {
    const id = q.shift() as string
    out.push(id)
    for (const e of edges) {
      if (e.from !== id || !indeg.has(e.to)) continue
      const d = (indeg.get(e.to) || 0) - 1
      indeg.set(e.to, d)
      if (d === 0) q.push(e.to)
    }
  }
  return out
}

// Pre-flight validation: catch broken graphs BEFORE spending tokens.
function validateFlow(f: Flow): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = []
  const warnings: string[] = []
  const order = topoOrder(f.nodes, f.edges)
  if (order.length < f.nodes.length) blockers.push('The pipeline has a wiring loop — remove a circular connection.')
  for (const n of f.nodes) {
    const hasIn = f.edges.some((e) => e.to === n.id)
    if (n.type === 'email' && !n.to?.trim()) warnings.push(`"${n.label}": no recipient — the .eml draft is created without a To address.`)
    if (n.type !== 'agent' && !hasIn && !n.prompt.trim()) warnings.push(`"${n.label}": output has no input wired and no brief — it will build from its name only.`)
  }
  return { blockers, warnings }
}

const NODE_W = 280
const outPort = (n: PNode) => ({ x: n.x + NODE_W, y: n.y + 42 })
const inPort = (n: PNode) => ({ x: n.x, y: n.y + 42 })

// Model output for the small in-node preview: strip markdown syntax so it
// reads as clean prose (no ##, **, ---, [links](…) — the expand view renders
// the real formatting).
function cleanSnippet(s: string): string {
  return s
    .replace(/^\s*\|?[\s|:-]+\|[\s|:-]*$/gm, '') // markdown table separator rows
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*(---+|\*\*\*+|___+)\s*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\|/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Textify an artifact for downstream nodes (an email after a doc gets content).
const textifyDoc = (d: { title?: string; blocks?: Array<{ text?: string; items?: string[] }> }) =>
  [d.title, ...(d.blocks || []).flatMap((b) => [b.text || '', ...(b.items || [])])].filter(Boolean).join('\n')
const textifyDeck = (d: { title?: string; slides?: Array<{ title?: string; bullets?: string[] }> }) =>
  [d.title, ...(d.slides || []).flatMap((s) => [s.title || '', ...(s.bullets || [])])].filter(Boolean).join('\n')

export default function AgentsPanel() {
  const [flows, setFlows] = useState<Flow[]>(loadFlows)
  const [flowId, setFlowId] = useState<string | undefined>(undefined)
  const flow = flows.find((f) => f.id === flowId) || flows[0]
  useEffect(() => { if (!flowId || !flows.some((f) => f.id === flowId)) setFlowId(flows[0]?.id) }, [flows, flowId])
  const [runs, setRuns] = useState<Run[]>(loadRuns)
  const [outputs, setOutputs] = useState<OutputMeta[]>(listOutputs)
  const [states, setStates] = useState<Record<string, NodeState>>({})
  const [live, setLive] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<string | null>(null) // flowId being run
  const [connecting, setConnecting] = useState<string | null>(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addMenu, setAddMenu] = useState<false | 'model' | 'company' | 'output'>(false)
  const [coSetup, setCoSetup] = useState<null | { name: string; what: string; mission: string; notes: string }>(null)
  const [coNotesOpen, setCoNotesOpen] = useState(false)
  const [runWarn, setRunWarn] = useState<string | null>(null)
  const [durs, setDurs] = useState<Record<string, number>>({})
  const [railOpen, setRailOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 900)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [viewSize, setViewSize] = useState({ w: 1200, h: 700 })
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => setViewSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fitScaleRef = useRef(1)
  const flowsRef = useRef(flows); flowsRef.current = flows

  useEffect(() => saveFlows(flows), [flows])
  useEffect(() => saveRuns(runs), [runs])

  const patchFlow = useCallback((fid: string, patch: Partial<Flow> | ((f: Flow) => Partial<Flow>)) => {
    setFlows((fs) => fs.map((f) => (f.id === fid ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f)))
  }, [])
  const patchNode = (nid: string, patch: Partial<PNode>) => {
    if (!flow) return
    patchFlow(flow.id, (f) => ({ nodes: f.nodes.map((n) => (n.id === nid ? { ...n, ...patch } : n)) }))
  }

  // ---- canvas ----
  const canvasPos = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect()
    const s = fitScaleRef.current
    return {
      x: (e.clientX - (r?.left || 0) + (canvasRef.current?.scrollLeft || 0)) / s,
      y: (e.clientY - (r?.top || 0) + (canvasRef.current?.scrollTop || 0)) / s,
    }
  }
  const onNodeDragStart = (e: React.PointerEvent, n: PNode) => {
    const p = canvasPos(e)
    dragRef.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onCanvasMove = (e: React.PointerEvent) => {
    // drag-to-pan: grabbing the empty canvas scrolls it (no scrollbars shown)
    const pan = panRef.current
    if (pan && canvasRef.current) {
      canvasRef.current.scrollLeft = pan.sl - (e.clientX - pan.x)
      canvasRef.current.scrollTop = pan.st - (e.clientY - pan.y)
      return
    }
    const p = canvasPos(e)
    setMouse(p)
    const d = dragRef.current
    if (d) patchNode(d.id, { x: Math.max(0, p.x - d.dx), y: Math.max(0, p.y - d.dy) })
  }
  const onCanvasPanStart = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-node], button, input, textarea, select, path')) return
    panRef.current = { x: e.clientX, y: e.clientY, sl: canvasRef.current?.scrollLeft || 0, st: canvasRef.current?.scrollTop || 0 }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const addNode = (type: NodeType, agent?: string, role?: string, customTitle?: string) => {
    if (!flow) return
    const r = roleDef(role)
    const meta = r ? { name: r.title } : type === 'agent' ? agentDef(agent || 'general') : OUTPUTS.find((o) => o.type === type)
    const n: PNode = {
      id: uid(),
      x: 50 + (flow.nodes.length % 3) * 340,
      y: 40 + Math.floor(flow.nodes.length / 3) * 300,
      type,
      ...(type === 'agent' ? { agent: r ? r.engine : agent || 'general' } : {}),
      ...(r ? { role: r.key } : {}),
      ...(customTitle ? { role: 'custom', roleTitle: customTitle } : {}), // a brand-new custom role
      label: customTitle || (meta?.name || 'Step').replace('Nalu ', ''),
      prompt: '',
    }
    patchFlow(flow.id, (f) => ({ nodes: [...f.nodes, n] }))
    setAddMenu(false)
  }
  const removeNode = (nid: string) => {
    if (!flow) return
    patchFlow(flow.id, (f) => ({ nodes: f.nodes.filter((n) => n.id !== nid), edges: f.edges.filter((e) => e.from !== nid && e.to !== nid) }))
  }
  const finishConnect = (toId: string) => {
    if (!flow || !connecting || connecting === toId) { setConnecting(null); return }
    if (!flow.edges.some((e) => e.from === connecting && e.to === toId)) patchFlow(flow.id, (f) => ({ edges: [...f.edges, { from: connecting, to: toId }] }))
    setConnecting(null)
  }

  // "Output type" for the whole flow: picking one auto-wires that output step
  // to the end of the pipeline (replacing a previously picked one).
  const flowOutput = flow?.nodes.find((n) => n.auto)?.type || 'none'
  const setFlowOutput = (t: NodeType | 'none') => {
    if (!flow) return
    patchFlow(flow.id, (f) => {
      let nodes = f.nodes.slice()
      let edges = f.edges.slice()
      const prev = nodes.find((n) => n.auto)
      if (prev) {
        nodes = nodes.filter((n) => n.id !== prev.id)
        edges = edges.filter((e) => e.from !== prev.id && e.to !== prev.id)
      }
      if (t !== 'none' && t !== 'agent') {
        const meta = OUTPUTS.find((o) => o.type === t)
        const leaves = nodes.filter((n) => !edges.some((e) => e.from === n.id))
        const node: PNode = {
          id: uid(),
          x: nodes.length ? Math.max(...nodes.map((n) => n.x)) + 340 : 60,
          y: nodes.length ? Math.min(...nodes.map((n) => n.y)) : 60,
          type: t,
          label: meta?.name || 'Output',
          prompt: '',
          auto: true,
        }
        nodes = [...nodes, node]
        edges = [...edges, ...leaves.map((l) => ({ from: l.id, to: node.id }))]
      }
      return { nodes, edges }
    })
  }

  // ---- execution ----
  const setStatesNoop = () => undefined
  const runFlow = useCallback(async (target?: Flow, manual = true) => {
    const f = target || flowsRef.current.find((x) => x.id === flowId) || flowsRef.current[0]
    if (!f || !f.nodes.length || abortRef.current) return
    const runId = uid()
    setRuns((rs) => [{ id: runId, flowId: f.id, flowName: f.name, startedAt: Date.now(), status: 'running' }, ...rs])
    // pre-flight: block on wiring loops, surface soft warnings
    const check = validateFlow(f)
    if (check.blockers.length) {
      setRunWarn(check.blockers[0])
      setRuns((rs) => rs.filter((r) => r.id !== runId))
      return
    }
    setRunWarn(check.warnings[0] || null)
    setRunning(f.id)
    setLive({})
    const order = topoOrder(f.nodes, f.edges)
    setStates(Object.fromEntries(f.nodes.map((n) => [n.id, order.includes(n.id) ? 'queued' : 'idle'])))
    setDurs({})
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const results: Record<string, string> = {}
    const failedIds = new Set<string>()
    const finished = new Set<string>()
    const deps = new Map(f.nodes.map((n) => [n.id, f.edges.filter((e) => e.to === n.id).map((e) => e.from)]))
    const CONC = 3 // independent branches run in parallel (LLM-provider friendly)
    const t0 = Date.now()
    try {
      // ROBUST EXECUTION: independent branches run concurrently; a failed step
      // retries once, and on final failure only ITS dependents are skipped —
      // the rest of the company keeps working.
      await new Promise<void>((resolve) => {
        const pending = new Set(order)
        let active = 0
        const execOne = async (nid: string) => {
          const node = f.nodes.find((n) => n.id === nid)
          if (!node) { finished.add(nid); return }
          setStates((st) => ({ ...st, [nid]: 'running' }))
          const input = (deps.get(nid) || []).map((d) => results[d]).filter(Boolean).join('\n\n---\n\n')
          const started = Date.now()
          for (let attempt = 1; attempt <= 2; attempt++) {
            if (ctrl.signal.aborted) break
            try {
              const out = await runNode(node, input, f, ctrl, manual, (t) => setLive((lv) => ({ ...lv, [nid]: t })), (m) =>
                patchFlow(f.id, (cur) => ({ artifacts: { ...(cur.artifacts || {}), [nid]: m } })))
              if (out) {
                results[nid] = out.slice(0, 24000) // protect storage quota
                setStates((st) => ({ ...st, [nid]: 'done' }))
                setDurs((d) => ({ ...d, [nid]: Date.now() - started }))
                finished.add(nid)
                return
              }
              throw new Error('empty result')
            } catch (e) {
              if (ctrl.signal.aborted) break
              if (attempt === 1) {
                setLive((lv) => ({ ...lv, [nid]: 'First attempt failed — retrying…' }))
              } else {
                console.warn('node failed after retry', node.label, e)
              }
            }
          }
          failedIds.add(nid)
          finished.add(nid)
          setStates((st) => ({ ...st, [nid]: ctrl.signal.aborted ? 'idle' : 'error' }))
          setDurs((d) => ({ ...d, [nid]: Date.now() - started }))
        }
        const pump = () => {
          if (ctrl.signal.aborted) { if (!active) resolve(); return }
          // cascade skips: any node whose upstream failed/skipped cannot run
          let changed = true
          while (changed) {
            changed = false
            for (const nid of [...pending]) {
              if ((deps.get(nid) || []).some((d) => failedIds.has(d))) {
                pending.delete(nid)
                failedIds.add(nid)
                finished.add(nid)
                setStates((st) => ({ ...st, [nid]: 'skipped' }))
                setLive((lv) => ({ ...lv, [nid]: 'Skipped — an upstream step failed.' }))
                changed = true
              }
            }
          }
          let launched = 0
          for (const nid of [...pending]) {
            if (active + launched >= CONC) break
            if ((deps.get(nid) || []).every((d) => finished.has(d) && !failedIds.has(d))) {
              pending.delete(nid)
              launched++
              active++
              void execOne(nid).finally(() => { active--; pump() })
            }
          }
          if (!pending.size && !active) resolve()
          else if (!active && !launched && pending.size) { pending.clear(); resolve() }
        }
        pump()
      })
      patchFlow(f.id, { results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.slice(0, 24000)])), lastRun: Date.now() })
      setOutputs(listOutputs())
      const fails = [...failedIds].filter((id) => (setStatesNoop(), true)).length
      const files = f.nodes.filter((n) => n.type !== 'agent' && results[n.id]).length
      const secs = Math.round((Date.now() - t0) / 1000)
      const status = ctrl.signal.aborted ? 'stopped' : fails ? 'error' : 'done'
      setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, finishedAt: Date.now(), status, note: `${Object.keys(results).length}/${order.length} steps · ${files} files · ${secs}s${fails ? ` · ${fails} failed/skipped` : ''}` } : r)))
    } finally {
      setRunning(null)
      abortRef.current = null
    }
  }, [flowId, patchFlow])

  // One node's work: agents talk to their specialist; output steps build REAL
  // files, auto-download them, and store them in the Outputs library.
  async function runNode(node: PNode, input: string, f: Flow, ctrl: AbortController, manual: boolean, onLive: (t: string) => void, onArt?: (m: OutputMeta) => void): Promise<string> {
    if (node.type === 'agent') {
      let prompt = node.prompt.trim() || `You are the ${agentDef(node.agent || 'general').name} step in a pipeline. Do your specialty on the input.`
      if (prompt.includes('{{input}}')) prompt = prompt.split('{{input}}').join(input || '(no upstream input)')
      else if (input) prompt += `\n\n--- INPUT FROM THE PREVIOUS AGENT ---\n${input}`
      // Predefined role OR a user-defined custom role (node.roleTitle).
      const role = roleDef(node.role) || (node.roleTitle ? { key: 'custom', title: node.roleTitle, engine: node.agent || 'general', desc: '', charter: '' } : undefined)
      if (role) {
        // self-sustaining continuity: each member sees their own last work and
        // builds on it instead of starting cold every day.
        const prevOwn = f.results?.[node.id]
        const notes = node.roleNotes ? `\n\nHOW YOU MUST WORK — these are exact instructions for you and OVERRIDE any default behavior: ${node.roleNotes}` : ''
        prompt = `${roleCharter(role, f)}${notes}\n\nYOUR TASK TODAY:\n${prompt}${prevOwn ? `\n\n--- YOUR PREVIOUS WORK (last run — build on it, update what changed, never repeat verbatim) ---\n${prevOwn.slice(0, 3500)}` : ''}`
      }
      let out = ''
      const r = await streamChat([{ role: 'user', content: prompt }], undefined, { signal: ctrl.signal, onDelta: (t) => { out += t; onLive(out) } }, undefined, undefined, undefined, node.agent)
      return out || r.text
    }
    if (node.type === 'email') {
      const to = node.to || ''
      const subject = node.subject || node.label || 'From Nalu Agents'
      let body = node.prompt.trim()
      if (body.includes('{{input}}')) body = body.split('{{input}}').join(input)
      else body = [body, input].filter(Boolean).join('\n\n')
      body = cleanSnippet(body) // emails read as clean prose, not markdown syntax
      const blob = buildEmlBlob(to, subject, body)
      const filename = `${subject.replace(/[^\w ]+/g, '').trim().slice(0, 40) || 'email'}.eml`
      downloadBlobFile(blob, filename)
      const emlMeta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, kind: 'email', filename, size: blob.size, ts: Date.now() }
      await storeOutput(emlMeta, blob)
      onArt?.(emlMeta)
      if (manual) openMailto(to, subject, body)
      onLive(`Drafted "${subject}"${to ? ` to ${to}` : ''} — .eml downloaded & saved to Outputs${manual ? '; opening your mail app' : ''}.`)
      return `EMAIL DRAFTED — subject: ${subject}\n${body.slice(0, 400)}`
    }
    // artifact output steps: build via the real generators, then export the file
    onLive('Generating…')
    const brief = node.prompt.trim()
    const material = input ? `\n\n--- THE MATERIAL (build the entire piece from this substance; keep its numbers and structure) ---\n${input.slice(0, 14000)}` : ''
    const safeName = (t: string, ext: string) => `${(t || node.label || 'output').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 48) || 'output'}.${ext}`
    const finish = async (blob: Blob, filename: string, kind: OutputMeta['kind'], passAlong: string) => {
      downloadBlobFile(blob, filename)
      const meta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, kind, filename, size: blob.size, ts: Date.now() }
      await storeOutput(meta, blob)
      onArt?.(meta)
      onLive(`Created ${filename} — downloaded & saved to Outputs.`)
      return passAlong
    }
    if (node.type === 'doc' || node.type === 'pdf') {
      const r = await fetch('/api/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: (brief || `A polished document titled "${node.label}".`) + material, images: [] }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.blocks)) throw new Error(d.error || 'doc failed')
      const mod = await import('./DocCard')
      if (node.type === 'pdf') {
        const blob = await mod.buildPdfBlob(d)
        return finish(blob, mod.docFilename(d).replace(/\.docx$/, '.pdf'), 'pdf', textifyDoc(d))
      }
      const blob = await mod.buildDocxBlob(d)
      return finish(blob, mod.docFilename(d), 'doc', textifyDoc(d))
    }
    if (node.type === 'slides') {
      const r = await fetch('/api/slides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: (brief || `A polished presentation titled "${node.label}".`) + material }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.slides)) throw new Error(d.error || 'slides failed')
      const { buildPptxBlob } = await import('./SlidesCard')
      const { blob, filename } = await buildPptxBlob(d)
      return finish(blob, filename, 'slides', textifyDeck(d))
    }
    if (node.type === 'sheet') {
      const r = await fetch('/api/sheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: (brief || `A useful workbook titled "${node.label}".`) + material }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.sheets)) throw new Error(d.error || 'sheet failed')
      const { buildWorkbookBlob } = await import('./SheetCard')
      const blob = await buildWorkbookBlob(d, getBrand())
      return finish(blob, safeName(d.title, 'xlsx'), 'sheet', `WORKBOOK: ${d.title || node.label} — ${(d.sheets || []).map((s: { name?: string }) => s.name).join(', ')}`)
    }
    if (node.type === 'website') {
      const r = await fetch('/api/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: (brief || `A polished website for "${node.label}".`) + material, kind: 'webpage', brand: getBrand() || undefined }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !d.html) throw new Error(d.error || 'website failed')
      const blob = new Blob([d.html], { type: 'text/html' })
      return finish(blob, safeName(node.label, 'html'), 'website', `WEBSITE BUILT (${Math.round(d.html.length / 1024)}KB html): ${node.label}`)
    }
    if (node.type === 'image') {
      const r = await fetch('/api/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: [brief, input.slice(0, 500)].filter(Boolean).join(' — ') || node.label }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !d.url) throw new Error(d.error || 'image failed')
      const ir = await fetch(d.url, { signal: ctrl.signal })
      const blob = await ir.blob()
      if (!blob.type.startsWith('image/')) throw new Error('image did not resolve')
      return finish(blob, safeName(node.label, blob.type.includes('png') ? 'png' : 'jpg'), 'image', `IMAGE CREATED: ${node.label}`)
    }
    if (node.type === 'video') {
      const r = await fetch('/api/video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: [brief, input.slice(0, 400)].filter(Boolean).join(' — ') || node.label }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !d.url) throw new Error(d.error || 'video failed')
      const vr = await fetch(d.url, { signal: ctrl.signal })
      const blob = await vr.blob()
      return finish(blob, safeName(node.label, 'mp4'), 'video', `VIDEO CREATED: ${node.label}`)
    }
    if (node.type === 'calendar') {
      // model turns the upstream plan into STRICT event JSON → real .ics
      let raw = ''
      await streamChat(
        [{ role: 'user', content: `From the material below, produce the meetings/reservations to put on the calendar${brief ? ` (instructions: ${brief})` : ''}. Output ONLY a minified JSON array, no prose: [{"title":"...","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM","location":"...","description":"...","attendees":["a@b.com"]}]. Use concrete near-future dates/times.\n\nMATERIAL:\n${input.slice(0, 8000) || node.label}` }],
        undefined, { signal: ctrl.signal, onDelta: (t) => { raw += t } }, undefined, undefined, undefined, 'general',
      )
      const m = raw.match(/\[[\s\S]*\]/)
      const events = (m ? (JSON.parse(m[0]) as IcsEvent[]) : []).filter((e) => e && e.start)
      if (!events.length) throw new Error('no events extracted')
      const blob = buildIcsBlob(events)
      const summary = events.map((e) => `• ${e.title} — ${e.start}${e.location ? ` @ ${e.location}` : ''}`).join('\n')
      return finish(blob, safeName(node.label || 'meetings', 'ics'), 'calendar', `CALENDAR CREATED (${events.length} events — double-click the .ics to add to Outlook/Google):\n${summary}`)
    }
    if (node.type === 'mailrules') {
      // model designs the inbox rules → Gmail-importable filters .xml
      let raw = ''
      await streamChat(
        [{ role: 'user', content: `Design inbox-organization rules${brief ? ` (instructions: ${brief})` : ''} based on the material below. Output ONLY a minified JSON array, no prose: [{"name":"...","from":"","subject":"","hasWords":"","label":"Folder/Label name","archive":false,"markRead":false,"star":false}]. 6-12 practical rules (newsletters, receipts, calendar invites, VIPs, notifications...).\n\nMATERIAL:\n${input.slice(0, 6000) || node.label}` }],
        undefined, { signal: ctrl.signal, onDelta: (t) => { raw += t } }, undefined, undefined, undefined, 'general',
      )
      const m = raw.match(/\[[\s\S]*\]/)
      const rules = (m ? (JSON.parse(m[0]) as MailRule[]) : []).filter((r) => r && (r.from || r.subject || r.hasWords || r.to))
      if (!rules.length) throw new Error('no rules extracted')
      const blob = buildGmailFiltersXml(rules)
      const summary = rules.map((r) => `• ${r.name || r.label}: ${[r.from && `from ${r.from}`, r.subject && `subject "${r.subject}"`, r.hasWords && `contains "${r.hasWords}"`].filter(Boolean).join(', ')} → ${r.label || 'label'}${r.archive ? ' + archive' : ''}`).join('\n')
      return finish(blob, safeName(node.label || 'email-rules', 'xml'), 'mailrules', `EMAIL RULES CREATED (${rules.length} — Gmail: Settings → Filters → Import. Outlook: Settings → Rules, mirror these):\n${summary}`)
    }
    if (node.type === 'csv') {
      const r = await fetch('/api/sheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: (brief || `A useful data table for "${node.label}".`) + material }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.sheets) || !d.sheets[0]) throw new Error(d.error || 'csv failed')
      const sh = d.sheets[0]
      const ev = buildEvaluator(d.sheets)
      const cell = (v: unknown) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
      const rows = [(sh.columns || []).map(cell).join(',')]
      ;(sh.rows || []).forEach((row: unknown[], ri: number) => rows.push(row.map((c, ci) => cell(typeof c === 'string' && c.startsWith('=') ? ev.value(0, ri, ci) : c)).join(',')))
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
      return finish(blob, safeName(d.title || node.label, 'csv'), 'csv', `CSV: ${d.title || node.label} — ${(sh.rows || []).length} rows`)
    }
    if (node.type === 'contacts') {
      let raw = ''
      await streamChat(
        [{ role: 'user', content: `Extract/produce the CONTACTS from the material below${brief ? ` (instructions: ${brief})` : ''}. Output ONLY a minified JSON array, no prose: [{"name":"...","org":"...","title":"...","email":"...","phone":"..."}].\n\nMATERIAL:\n${input.slice(0, 8000) || node.label}` }],
        undefined, { signal: ctrl.signal, onDelta: (t) => { raw += t } }, undefined, undefined, undefined, 'general',
      )
      const m = raw.match(/\[[\s\S]*\]/)
      const contacts = (m ? (JSON.parse(m[0]) as VcfContact[]) : []).filter((c) => c && (c.name || c.email))
      if (!contacts.length) throw new Error('no contacts extracted')
      const blob = buildVcfBlob(contacts)
      return finish(blob, safeName(node.label || 'contacts', 'vcf'), 'contacts', `CONTACTS (${contacts.length} vCards — double-click to import):\n` + contacts.map((c) => `• ${c.name}${c.org ? ` — ${c.org}` : ''}${c.email ? ` <${c.email}>` : ''}`).join('\n'))
    }
    if (node.type === 'markdown') {
      let body = brief.includes('{{input}}') ? brief.split('{{input}}').join(input) : [brief && `# ${node.label}`, input].filter(Boolean).join('\n\n')
      if (!body.trim()) body = input || node.label
      const blob = new Blob([body], { type: 'text/markdown' })
      return finish(blob, safeName(node.label || 'notes', 'md'), 'text', body.slice(0, 500))
    }
    if (node.type === 'json') {
      let raw = ''
      await streamChat(
        [{ role: 'user', content: `Turn the material below into ONE structured JSON document${brief ? ` (schema/instructions: ${brief})` : ''}. Output ONLY the JSON object or array, no prose.\n\nMATERIAL:\n${input.slice(0, 9000) || node.label}` }],
        undefined, { signal: ctrl.signal, onDelta: (t) => { raw += t } }, undefined, undefined, undefined, 'general',
      )
      const m = raw.match(/[\[{][\s\S]*[\]}]/)
      if (!m) throw new Error('no JSON produced')
      const pretty = JSON.stringify(JSON.parse(m[0]), null, 2)
      const blob = new Blob([pretty], { type: 'application/json' })
      return finish(blob, safeName(node.label || 'data', 'json'), 'text', pretty.slice(0, 500))
    }
    if (node.type === 'social') {
      const platform = node.platform || 'Instagram'
      const isVideoPost = node.format === 'video' || /tiktok|reel|short/i.test(platform)
      if (isVideoPost) {
        const vr = await fetch('/api/video', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: `${platform} vertical video: ${brief || node.label}. ${input.slice(0, 400)}`, vertical: true }),
          signal: ctrl.signal,
        })
        const vd = await vr.json()
        if (!vr.ok || !vd.url) throw new Error(vd.error || 'video post failed')
        const vb = await (await fetch(vd.url, { signal: ctrl.signal })).blob()
        const vfn = safeName(`${platform}-${node.label}`, 'mp4')
        downloadBlobFile(vb, vfn)
        const vmeta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, kind: 'video', filename: vfn, size: vb.size, ts: Date.now() }
        await storeOutput(vmeta, vb); onArt?.(vmeta)
        const hook = node.webhook?.trim()
        let pub = ''
        if (hook && /^https?:\/\//.test(hook)) { try { await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, type: 'video', videoUrl: vd.url, filename: vfn, at: new Date().toISOString() }) }); pub = ` · sent to your ${platform} publisher` } catch { pub = ' · webhook unreachable' } }
        onLive(`${platform} video post created${pub}.`)
        return `${platform.toUpperCase()} VIDEO POST — ${node.label}`
      }
      // build a platform-native carousel/post from the pipeline's material
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Create a ${platform} post/carousel. ${brief || `Topic: ${node.label}.`}${material}`, kind: 'carousel', brand: getBrand() || undefined }),
        signal: ctrl.signal,
      })
      const d = await r.json()
      if (!r.ok || !d.html) throw new Error(d.error || 'post failed')
      // pull caption + hashtags text out of the built HTML for publishing
      const capMatch = String(d.html).match(/caption-text[^>]*>([\s\S]*?)<\/[a-z]/i)
      const caption = (capMatch ? capMatch[1] : '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2200)
      const tags = ([...String(d.html).matchAll(/#[A-Za-z][A-Za-z0-9_]{2,}/g)].map((m) => m[0]).filter((t, i, a) => a.indexOf(t) === i)).slice(0, 12).join(' ')
      const firstImg = (String(d.html).match(/data:image\/[a-z]+;base64,[^"')\s]+/) || [])[0] || ''
      const blob = new Blob([d.html], { type: 'text/html' })
      const filename = safeName(`${platform}-${node.label}`, 'html')
      downloadBlobFile(blob, filename)
      await storeOutput({ id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, kind: 'website', filename, size: blob.size, ts: Date.now() }, blob)
      onArt?.({ id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, kind: 'website', filename, size: blob.size, ts: Date.now() })
      // AUTO-PUBLISH: if a webhook (Zapier/Make/Buffer/IFTTT) is linked, POST the
      // post to it so it publishes to the real account. Best-effort; the file is
      // saved regardless so nothing is lost if the hook is down.
      let published = ''
      const hook = node.webhook?.trim()
      if (hook && /^https?:\/\//.test(hook)) {
        try {
          await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform, caption, hashtags: tags, image: firstImg, filename, at: new Date().toISOString() }) })
          published = ` · sent to your ${platform} publisher`
        } catch { published = ` · webhook unreachable (post still saved)` }
      }
      onLive(`${platform} post created${published}. Caption + ${tags.split(' ').filter(Boolean).length} hashtags ready.`)
      return `${platform.toUpperCase()} POST — ${node.label}\nCAPTION: ${caption}\nHASHTAGS: ${tags}`
    }
    // textfile — the pipeline output as a clean .txt
    let body = brief.includes('{{input}}') ? brief.split('{{input}}').join(input) : [brief, input].filter(Boolean).join('\n\n')
    body = cleanSnippet(body)
    const blob = new Blob([body], { type: 'text/plain' })
    return finish(blob, safeName(node.label, 'txt'), 'text', body.slice(0, 500))
  }

  // Run ONE company member on their own clock: input = the latest stored
  // outputs of their upstream steps; their result is saved back to the flow.
  const runMember = useCallback(async (f: Flow, node: PNode) => {
    if (abortRef.current) return
    const runId = uid()
    setRuns((rs) => [{ id: runId, flowId: f.id, flowName: `${f.name} — ${node.label}`, startedAt: Date.now(), status: 'running' }, ...rs])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(f.id)
    setStates((st) => ({ ...st, [node.id]: 'running' }))
    try {
      const input = f.edges.filter((e) => e.to === node.id).map((e) => f.results?.[e.from]).filter(Boolean).join('\n\n---\n\n')
      const out = await runNode(node, input, f, ctrl, false, (t) => setLive((lv) => ({ ...lv, [node.id]: t })), (m) =>
        patchFlow(f.id, (cur) => ({ artifacts: { ...(cur.artifacts || {}), [node.id]: m } })))
      const day = new Date().toDateString()
      patchFlow(f.id, (cur) => ({
        results: { ...(cur.results || {}), [node.id]: out },
        lastRun: Date.now(),
        nodes: cur.nodes.map((n) => (n.id === node.id ? { ...n, lastRunDay: day } : n)),
      }))
      setStates((st) => ({ ...st, [node.id]: 'done' }))
      setOutputs(listOutputs())
      setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, finishedAt: Date.now(), status: 'done' } : r)))
    } catch {
      setStates((st) => ({ ...st, [node.id]: 'error' }))
      setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, finishedAt: Date.now(), status: 'error' } : r)))
    } finally {
      setRunning(null)
      abortRef.current = null
    }
  }, [patchFlow])

  // ---- scheduler (runs while the app is open) ----
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      for (const f of flowsRef.current) {
        if (!f.enabled || f.schedule === 'manual' || !f.nodes.length) continue
        // 24/7 self-sustaining: the whole company re-runs every 30 minutes.
        if (f.schedule === 'continuous') {
          if (Date.now() - (f.lastRun || 0) > 1_800_000 && !abortRef.current) void runFlow(f, false)
          continue
        }
        // Per-member times: each employee works at their own hour, every day,
        // reading the latest outputs of their upstream teammates.
        if (f.schedule === 'members') {
          const today = now.toDateString()
          for (const n of f.nodes) {
            if (!n.time || n.lastRunDay === today) continue
            const [hh, mm] = n.time.split(':').map(Number)
            const at = new Date(now); at.setHours(hh, mm, 0, 0)
            if (now >= at && !abortRef.current) { void runMember(f, n); break }
          }
          continue
        }
        const last = f.lastRun || 0
        const due =
          f.schedule === 'hourly'
            ? Date.now() - last > 3600_000
            : (() => {
                const [hh, mm] = (f.time || '08:00').split(':').map(Number)
                const at = new Date(now); at.setHours(hh, mm, 0, 0)
                const within = now >= at && now.getTime() - at.getTime() < 120_000
                const fresh = last < at.getTime()
                return f.schedule === 'daily' ? within && fresh : now.getDay() === 1 && within && fresh
              })()
        if (due && !abortRef.current) void runFlow(f, false)
      }
    }
    const iv = setInterval(tick, 30_000)
    return () => clearInterval(iv)
  }, [runFlow, runMember])

  const newFlow = () => {
    const f: Flow = { id: uid(), name: 'New pipeline', nodes: [], edges: [], schedule: 'manual', time: '08:00', enabled: false }
    setFlows((fs) => [f, ...fs]); setFlowId(f.id); setStates({}); setLive({})
  }
  // One-click auto-poster: an idea agent → platform-native Social post, scheduled
  // daily. The user just sets the topic, the platform, and (optionally) a webhook.
  const newAutoPoster = () => {
    const idea: PNode = { id: uid(), x: 40, y: 60, type: 'agent', agent: 'social', label: 'Post idea', prompt: "You are our social media strategist. Come up with ONE fresh, on-brand, high-engagement post idea for today about our niche — a specific hook + the 5-7 points it should cover. Vary it daily so we never repeat. Return the idea and the points." }
    const post: PNode = { id: uid(), x: 420, y: 60, type: 'social', label: 'Daily post', platform: 'Instagram', webhook: '', prompt: 'Turn the idea below into a scroll-stopping post.\n\n{{input}}' }
    const f: Flow = { id: uid(), name: 'Auto-poster', nodes: [idea, post], edges: [{ from: idea.id, to: post.id }], schedule: 'daily', time: '09:00', enabled: false }
    setFlows((fs) => [f, ...fs]); setFlowId(f.id); setStates({}); setLive({})
  }
  // FULL-COMPANY BASELINE — gated behind the setup modal: you must say what the
  // company IS and what it's supposed to DO before it exists; that profile is
  // burned into every member's charter. Solid across the board: research →
  // CEO → every department → EA office work (meetings .ics + email rules) →
  // daily report. Tweak any position after.
  const createCompany = (name: string, what: string, mission: string, notes: string) => {
    const mk = (role: string, x: number, y: number, time: string, prompt: string): PNode => {
      const r = roleDef(role) as RoleDef
      return { id: uid(), x, y, type: 'agent', agent: r.engine, role: r.key, label: r.title, prompt, time }
    }
    const analyst = mk('analyst', 40, 40, '07:30', 'Morning intelligence brief: what happened in our market, competitors, and the economy in the last 24h that matters to this company. Tight bullets with numbers and sources.')
    const ceo = mk('ceo', 400, 150, '08:00', "Read the morning brief below. Set today's top priorities — one per department (COO, CFO, CMO, CTO, Design) — each with an owner, a concrete deliverable, and success criteria. Then list the meetings today needs (who, when, why).\n\n{{input}}")
    const coo = mk('coo', 760, 40, '09:00', 'Execute your priority from the CEO brief: the operational plan for today — process, owners, timeline, blockers cleared.\n\n{{input}}')
    const cfo = mk('cfo', 760, 250, '09:00', 'Execute your priority from the CEO brief: budget/forecast update, cash position, risks — with the dollar math.\n\n{{input}}')
    const cmo = mk('cmo', 760, 460, '09:00', 'Execute your priority from the CEO brief: one concrete growth move shipped today — channel, copy angle, expected impact.\n\n{{input}}')
    const cto = mk('cto', 760, 670, '09:00', 'Execute your priority from the CEO brief: technical plan or build — architecture calls, what ships, what is blocked.\n\n{{input}}')
    const des = mk('design', 760, 880, '09:30', 'Execute your priority from the CEO brief: one design deliverable spec concrete enough to build today.\n\n{{input}}')
    const legal = mk('legal', 1120, 40, '10:00', 'Review today\'s plans below for legal/compliance risk. Flag issues with the practical fix; draft any contract language needed.\n\n{{input}}')
    const acct = mk('accountant', 1120, 250, '16:00', 'End-of-day books: summarize today\'s spend/revenue implications from the plans below, update the running ledger view, list tomorrow\'s payables and any tax deadlines this month.\n\n{{input}}')
    const ea = mk('ea', 400, 460, '08:30', 'Office work from the CEO brief: (1) the exact meetings to schedule (title, start/end, attendees, location), (2) any reservations to book (venue, date, time, party size) with the request drafted, (3) inbox-organization rules for our email this week.\n\n{{input}}')
    const pm = mk('pm', 400, 700, '08:30', 'Turn the CEO priorities into build-ready specs for CTO and Design: user stories, acceptance criteria, edge cases, priority order.\n\n{{input}}')
    const sales = mk('sales', 1120, 460, '09:30', 'From the CMO growth move below: research 8-12 REAL prospects on the live web (company, contact name/title, public email where available, why they fit), qualify each, and write one outreach email template.\n\n{{input}}')
    const hr = mk('hr', 1120, 670, '11:00', 'From the operational plan below: what role does the company need next? Draft the job post, the interview loop, and a 30-day onboarding checklist.\n\n{{input}}')
    const cal: PNode = { id: uid(), x: 40, y: 460, type: 'calendar', label: 'Meetings & reservations', prompt: 'Every meeting and reservation the EA planned, with exact times.' }
    const rules: PNode = { id: uid(), x: 40, y: 700, type: 'mailrules', label: 'Inbox rules', prompt: 'The inbox rules the EA designed.' }
    const prospects: PNode = { id: uid(), x: 1480, y: 360, type: 'csv', label: 'Prospect list', prompt: 'The sales prospect pipeline: company, contact, title, email, fit reason, stage, next step.' }
    const outreach: PNode = { id: uid(), x: 1480, y: 600, type: 'email', label: 'Outreach draft', subject: 'Quick question', prompt: 'The best outreach email from the sales plan, personalized to the strongest prospect.\n\n{{input}}' }
    const rolodex: PNode = { id: uid(), x: 1480, y: 820, type: 'contacts', label: 'Prospect contacts', prompt: 'Every prospect with a name from the sales research.' }
    const rpt: PNode = { id: uid(), x: 1480, y: 100, type: 'doc', label: 'Daily company report', prompt: 'A crisp internal daily report: decisions, department output, pipeline, numbers, legal flags, books, tomorrow.' }
    const f: Flow = {
      id: uid(), name: name.trim() || 'My Company', schedule: 'members', time: '08:00', enabled: false,
      company: { what: what.trim(), mission: mission.trim(), notes: notes.trim() || undefined },
      nodes: [analyst, ceo, coo, cfo, cmo, cto, des, legal, acct, ea, pm, sales, hr, cal, rules, prospects, outreach, rolodex, rpt],
      edges: [
        { from: analyst.id, to: ceo.id },
        { from: ceo.id, to: coo.id }, { from: ceo.id, to: cfo.id }, { from: ceo.id, to: cmo.id },
        { from: ceo.id, to: cto.id }, { from: ceo.id, to: des.id }, { from: ceo.id, to: ea.id }, { from: ceo.id, to: pm.id },
        { from: pm.id, to: cto.id }, { from: pm.id, to: des.id },
        { from: ea.id, to: cal.id }, { from: ea.id, to: rules.id },
        { from: cmo.id, to: sales.id },
        { from: sales.id, to: prospects.id }, { from: sales.id, to: outreach.id }, { from: sales.id, to: rolodex.id },
        { from: coo.id, to: legal.id }, { from: coo.id, to: hr.id },
        { from: coo.id, to: rpt.id }, { from: cfo.id, to: rpt.id }, { from: cmo.id, to: rpt.id },
        { from: cto.id, to: rpt.id }, { from: des.id, to: rpt.id }, { from: legal.id, to: rpt.id },
        { from: acct.id, to: rpt.id }, { from: sales.id, to: rpt.id }, { from: hr.id, to: rpt.id },
      ],
    }
    setFlows((fs) => [f, ...fs]); setFlowId(f.id); setStates({}); setLive({})
  }
  const deleteFlow = (fid: string) => {
    setFlows((fs) => { const next = fs.filter((f) => f.id !== fid); return next.length ? next : [starterFlow()] })
  }
  const redownload = async (m: OutputMeta) => {
    const blob = await getOutputBlob(m.id)
    if (blob) downloadBlobFile(blob, m.filename)
  }

  const nodeResult = (nid: string) => live[nid] ?? flow?.results?.[nid] ?? ''
  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(50, Math.abs(b.x - a.x) / 2)
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
  }
  const canvasSize = useMemo(() => ({
    w: Math.max(720, ...(flow?.nodes || []).map((n) => n.x + NODE_W + 60)),
    h: Math.max(460, ...(flow?.nodes || []).map((n) => n.y + 340)),
  }), [flow?.nodes])
  // AUTO-FIT: scale the pipeline down (never up) so it always fits the screen.
  const fitScale = Math.max(0.42, Math.min(1, viewSize.w / canvasSize.w, viewSize.h / canvasSize.h))
  fitScaleRef.current = fitScale

  if (!flow) return null
  const expandedNode = expanded ? flow.nodes.find((n) => n.id === expanded) : null
  const KIND_ICON: Record<OutputMeta['kind'], LucideIcon> = { doc: FileText, pdf: FileText, slides: BarChart3, sheet: Table2, csv: Table2, email: Mail, website: FileText, image: FileText, video: FileText, text: FileText, calendar: Clock, mailrules: Mail, contacts: Mail }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ---- left rail: flows / runs / outputs ---- */}
      {railOpen && (
        <div className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-glass/[0.08]">
          <div className="flex items-center justify-between px-3 pb-1 pt-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-dim">Pipelines</span>
            <span className="flex items-center gap-0.5">
              <button onClick={() => setCoSetup({ name: '', what: '', mission: '', notes: '' })} title="New company — full baseline team" className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-gold hover:bg-glass/10">+ Co</button>
              <button onClick={newAutoPoster} title="Auto-poster — daily social posts on a schedule" className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-gold hover:bg-glass/10">+ Post</button>
              <button onClick={newFlow} title="New pipeline" className="flex h-6 w-6 items-center justify-center rounded-md text-gold hover:bg-glass/10"><Plus size={13} /></button>
            </span>
          </div>
          {flows.map((f) => (
            <div key={f.id} className={`group mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${f.id === flow.id ? 'bg-accent/12 text-gold' : 'text-ink hover:bg-glass/[0.06]'}`}>
              <button onClick={() => { setFlowId(f.id); setStates({}); setLive({}) }} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {running === f.id && <Loader2 size={12} className="shrink-0 animate-spin text-gold" />}
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </button>
              {f.enabled && f.schedule !== 'manual' && <Clock size={10} className="shrink-0 text-emerald-300" />}
              <button onClick={() => deleteFlow(f.id)} className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:text-red-300 group-hover:flex"><Trash2 size={11} /></button>
            </div>
          ))}

          <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-dim">Runs</div>
          {runs.length === 0 && <div className="px-4 py-1 text-[11px] text-dim">Nothing has run yet.</div>}
          {runs.slice(0, 8).map((r) => (
            <div key={r.id} className="mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink">
              {r.status === 'running' ? <Loader2 size={12} className="shrink-0 animate-spin text-gold" />
                : r.status === 'done' ? <CheckCircle2 size={12} className="shrink-0 text-emerald-300" />
                : <XCircle size={12} className="shrink-0 text-red-300" />}
              <span className="min-w-0 flex-1 truncate">{r.flowName}</span>
              <span className="shrink-0 text-[10px] text-dim">{new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}

          <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-dim">Outputs</div>
          {outputs.length === 0 && <div className="px-4 py-1 pb-4 text-[11px] text-dim">Files your pipelines create land here (and in Downloads).</div>}
          {outputs.slice(0, 10).map((m) => {
            const I = KIND_ICON[m.kind] || FileText
            return (
              <div key={m.id} className="group mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink hover:bg-glass/[0.06]">
                <I size={12} className="shrink-0 text-dim" />
                <button onClick={() => void redownload(m)} title="Download again" className="min-w-0 flex-1 truncate text-left hover:text-gold">{m.filename}</button>
                <button onClick={() => void redownload(m)} className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:text-gold group-hover:flex"><Download size={11} /></button>
                <button onClick={() => { void deleteOutput(m.id); setOutputs(listOutputs().filter((x) => x.id !== m.id)) }} className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:text-red-300 group-hover:flex"><Trash2 size={11} /></button>
              </div>
            )
          })}
          <div className="mt-auto px-4 py-3 text-[10px] leading-relaxed text-dim">Outputs auto-download to your Downloads folder and are stored here on this device.</div>
        </div>
      )}

      {/* ---- main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* slim toolbar */}
        <div className="flex items-center gap-2 border-b border-glass/[0.08] px-3 py-2">
          <button onClick={() => setRailOpen((v) => !v)} title="Toggle sidebar" className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-glass/10 hover:text-ink"><PanelLeft size={14} /></button>
          <input value={flow.name} onChange={(e) => patchFlow(flow.id, { name: e.target.value })}
            className="w-48 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-ink outline-none focus:border-glass/20" placeholder="Pipeline name" />
          {flow.company && (
            <button onClick={() => setCoNotesOpen((v) => !v)} title="Company notes — hard rules every agent follows"
              className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] hover:bg-glass/[0.12] ${flow.company.notes ? 'bg-amber-500/15 text-amber-200' : 'bg-glass/[0.07] text-ink'}`}>
              <FileText size={13} /> Notes
            </button>
          )}
          {/* Three dedicated dropdowns: models, company roles, and outputs. */}
          <div className="relative">
            <button onClick={() => setAddMenu(addMenu === 'model' ? false : 'model')}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-glass/[0.12] ${addMenu === 'model' ? 'bg-glass/[0.12] text-ink' : 'bg-glass/[0.07] text-ink'}`}>
              <Plus size={13} className="text-gold" /> Model
            </button>
            {addMenu === 'model' && (
              <div className="absolute left-0 top-9 z-40 max-h-[26rem] w-64 overflow-y-auto rounded-xl border border-glass/[0.14] bg-panel2 py-1 shadow-xl">
                {AGENTS.map((a) => (
                  <button key={a.kind} onClick={() => addNode('agent', a.kind)} className="w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                    <span className="block text-[12px] text-ink">{a.name}</span><span className="block truncate text-[10px] text-dim">{a.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button onClick={() => setAddMenu(addMenu === 'company' ? false : 'company')}
              className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] hover:bg-glass/[0.12] ${addMenu === 'company' ? 'bg-glass/[0.12] text-ink' : 'bg-glass/[0.07] text-ink'}`}>
              <Plus size={13} className="text-gold" /> Company
            </button>
            {addMenu === 'company' && (
              <div className="absolute left-0 top-9 z-40 max-h-[26rem] w-64 overflow-y-auto rounded-xl border border-glass/[0.14] bg-panel2 py-1 shadow-xl">
                <button onClick={() => { const t = window.prompt('Name the new role (e.g. "VP of Partnerships")'); if (t && t.trim()) { addNode('agent', 'general', undefined, t.trim()); setAddMenu(false) } }}
                  className="w-full border-b border-glass/[0.08] px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                  <span className="block text-[12px] font-semibold text-gold">＋ New role…</span><span className="block truncate text-[10px] text-dim">A custom role — name it, then give it working notes</span>
                </button>
                {COMPANY_ROLES.map((r) => (
                  <button key={r.key} onClick={() => addNode('agent', r.engine, r.key)} className="w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                    <span className="block text-[12px] text-ink">{r.title}</span><span className="block truncate text-[10px] text-dim">{r.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {/* Output type — the single place to pick what the flow PRODUCES; it wires itself in */}
            <label className="flex items-center gap-1.5 text-[11px] text-dim">
              Output
              <select value={flowOutput} onChange={(e) => setFlowOutput(e.target.value as NodeType | 'none')}
                className="rounded-lg bg-glass/[0.07] px-2 py-1.5 text-[12px] text-ink outline-none">
                <option value="none" className="bg-panel2">Text</option>
                {OUTPUTS.map((o) => <option key={o.type} value={o.type} className="bg-panel2">{o.name}</option>)}
              </select>
            </label>
            <select value={flow.schedule} onChange={(e) => patchFlow(flow.id, { schedule: e.target.value as Schedule })}
              className="rounded-lg bg-glass/[0.07] px-2 py-1.5 text-[12px] text-ink outline-none">
              <option value="manual" className="bg-panel2">Run manually</option>
              <option value="hourly" className="bg-panel2">Hourly</option>
              <option value="daily" className="bg-panel2">Daily</option>
              <option value="weekly" className="bg-panel2">Weekly (Mon)</option>
              <option value="continuous" className="bg-panel2">24/7 — self-sustaining</option>
              <option value="members" className="bg-panel2">Per-member times</option>
            </select>
            {(flow.schedule === 'daily' || flow.schedule === 'weekly') && (
              <input type="time" value={flow.time} onChange={(e) => patchFlow(flow.id, { time: e.target.value })}
                className="rounded-lg bg-glass/[0.07] px-2 py-1 text-[12px] text-ink outline-none" />
            )}
            {flow.schedule !== 'manual' && (
              <button onClick={() => patchFlow(flow.id, { enabled: !flow.enabled })}
                className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] ${flow.enabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-glass/[0.07] text-dim'}`}>
                <Power size={12} /> {flow.enabled ? 'On' : 'Off'}
              </button>
            )}
            {running ? (
              <button onClick={() => abortRef.current?.abort()} className="flex items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-[13px] font-medium text-red-200 hover:bg-red-500/30">
                <Loader2 size={14} className="animate-spin" /> Stop
              </button>
            ) : (
              <button onClick={() => void runFlow()} disabled={!flow.nodes.length}
                className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#c9a86a] to-accent px-3.5 py-1.5 text-[13px] font-semibold text-[#15170f] hover:brightness-110 disabled:opacity-40">
                <Play size={14} /> Run
              </button>
            )}
          </div>
        </div>

        {coNotesOpen && flow.company && (
          <div className="border-b border-glass/[0.08] px-3 py-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200/80">Company notes — hard rules every agent follows</div>
            <textarea value={flow.company.notes || ''} onChange={(e) => patchFlow(flow.id, { company: { ...flow.company!, notes: e.target.value } })} rows={2}
              placeholder="e.g. Voice: warm + direct, never salesy. Only operate in Texas. Prices in USD. Anything over $5k needs my approval first."
              className="w-full resize-none rounded-lg border border-amber-400/20 bg-amber-500/[0.04] p-2 text-[12px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-amber-400/40" />
          </div>
        )}

        {runWarn && (
          <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-500/[0.08] px-3 py-1.5 text-[11.5px] text-amber-200">
            <span className="min-w-0 flex-1 truncate">{runWarn}</span>
            <button onClick={() => setRunWarn(null)} className="shrink-0 text-amber-200/70 hover:text-amber-100"><X size={12} /></button>
          </div>
        )}

        {/* canvas */}
        <div ref={canvasRef} onPointerMove={onCanvasMove} onPointerDown={onCanvasPanStart}
          onPointerUp={() => { dragRef.current = null; panRef.current = null }}
          onClick={() => { if (connecting) setConnecting(null); if (addMenu) setAddMenu(false) }}
          className="relative flex-1 cursor-grab overflow-auto active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ backgroundImage: 'radial-gradient(circle, rgba(175,140,86,0.12) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
          <div className="relative origin-top-left" style={{ width: canvasSize.w, height: canvasSize.h, transform: `scale(${fitScale})` }}>
            <svg className="pointer-events-none absolute inset-0" width={canvasSize.w} height={canvasSize.h}>
              {flow.edges.map((e, i) => {
                const a = flow.nodes.find((n) => n.id === e.from)
                const b = flow.nodes.find((n) => n.id === e.to)
                if (!a || !b) return null
                const hot = states[e.from] === 'running' || states[e.to] === 'running'
                return (
                  <g key={i}>
                    <path d={edgePath(outPort(a), inPort(b))} fill="none" stroke={hot ? '#E4B96F' : 'rgba(175,140,86,0.5)'} strokeWidth={hot ? 2.5 : 1.5} strokeDasharray={hot ? '6 5' : undefined}>
                      {hot && <animate attributeName="stroke-dashoffset" from="22" to="0" dur="0.7s" repeatCount="indefinite" />}
                    </path>
                    <path d={edgePath(outPort(a), inPort(b))} fill="none" stroke="transparent" strokeWidth={14} className="pointer-events-auto cursor-pointer"
                      onClick={(ev) => { ev.stopPropagation(); patchFlow(flow.id, (f) => ({ edges: f.edges.filter((_, k) => k !== i) })) }}>
                      <title>Click to remove this connection</title>
                    </path>
                  </g>
                )
              })}
              {connecting && (() => { const a = flow.nodes.find((n) => n.id === connecting); return a ? <path d={edgePath(outPort(a), mouse)} fill="none" stroke="#E4B96F" strokeWidth={2} strokeDasharray="5 4" /> : null })()}
            </svg>

            {flow.nodes.map((n) => {
              const meta = nodeMeta(n)
              const st = states[n.id] || 'idle'
              const out = nodeResult(n.id)
              return (
                <div key={n.id} data-node="1" className={`absolute select-none rounded-xl border bg-panel2/95 shadow-lg backdrop-blur transition-colors ${st === 'running' ? 'border-accent' : st === 'done' ? 'border-emerald-400/50' : st === 'error' ? 'border-red-400/60' : st === 'skipped' ? 'border-amber-400/40 opacity-70' : 'border-glass/[0.14]'}`}
                  style={{ left: n.x, top: n.y, width: NODE_W }}>
                  <div onPointerDown={(e) => onNodeDragStart(e, n)} className="flex cursor-grab items-center gap-2 rounded-t-xl border-b border-glass/[0.08] px-2.5 py-1.5 active:cursor-grabbing" style={{ background: `${meta.tint}12` }}>
                    {n.type === 'agent' && n.role ? (
                      <select value={n.roleTitle ? '__custom__' : n.role} onChange={(e) => {
                        if (e.target.value === '__new__') { const t = window.prompt('Name the new role (e.g. "VP of Partnerships")'); if (t && t.trim()) patchNode(n.id, { role: 'custom', roleTitle: t.trim(), label: t.trim() }); return }
                        if (e.target.value === '__custom__') return
                        const r = roleDef(e.target.value); patchNode(n.id, { role: e.target.value, roleTitle: undefined, agent: r?.engine || n.agent, label: r?.title || n.label })
                      }} onPointerDown={(e) => e.stopPropagation()}
                        className="rounded bg-transparent text-[11.5px] font-medium text-ink outline-none">
                        {COMPANY_ROLES.map((r) => <option key={r.key} value={r.key} className="bg-panel2">{r.title}</option>)}
                        {n.roleTitle && <option value="__custom__" className="bg-panel2">{n.roleTitle}</option>}
                        <option value="__new__" className="bg-panel2">＋ New role…</option>
                      </select>
                    ) : n.type === 'agent' ? (
                      <select value={n.agent} onChange={(e) => patchNode(n.id, { agent: e.target.value })} onPointerDown={(e) => e.stopPropagation()}
                        className="rounded bg-transparent text-[11.5px] font-medium text-ink outline-none">
                        {AGENTS.map((a) => <option key={a.kind} value={a.kind} className="bg-panel2">{a.name}</option>)}
                      </select>
                    ) : (
                      // output TYPE is pickable right on the step
                      <span className="flex items-center gap-1 text-[11.5px] font-medium text-ink">
                        <select value={n.type} onChange={(e) => patchNode(n.id, { type: e.target.value as NodeType })} onPointerDown={(e) => e.stopPropagation()}
                          className="rounded bg-transparent text-[11.5px] font-medium text-ink outline-none">
                          {OUTPUTS.map((o) => <option key={o.type} value={o.type} className="bg-panel2">{o.name}</option>)}
                        </select>
                        <span className="text-dim">· output</span>
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      {st === 'running' && <Loader2 size={11} className="animate-spin text-gold" />}
                      {st === 'queued' && <Clock size={10} className="text-dim" />}
                      <button onClick={() => removeNode(n.id)} onPointerDown={(e) => e.stopPropagation()} className="flex h-5 w-5 items-center justify-center rounded text-dim hover:bg-red-500/20 hover:text-red-200"><X size={10} /></button>
                    </span>
                  </div>
                  <button title="Input" onClick={(e) => { e.stopPropagation(); finishConnect(n.id) }}
                    className={`absolute -left-2 top-[34px] h-4 w-4 rounded-full border-2 transition-colors ${connecting && connecting !== n.id ? 'animate-pulse border-gold bg-accent/60' : 'border-glass/40 bg-panel2 hover:border-gold'}`} />
                  <button title="Output — click, then click another step's input" onClick={(e) => { e.stopPropagation(); setConnecting(connecting === n.id ? null : n.id) }}
                    className={`absolute -right-2 top-[34px] h-4 w-4 rounded-full border-2 transition-colors ${connecting === n.id ? 'border-gold bg-accent' : 'border-glass/40 bg-panel2 hover:border-gold'}`} />
                  <div className="p-2">
                    <div className="mb-1 flex items-center gap-1.5">
                      <input value={n.label} onChange={(e) => patchNode(n.id, { label: e.target.value })}
                        className="w-full flex-1 rounded bg-transparent text-[12px] font-medium text-ink outline-none placeholder:text-dim" placeholder="Step name" />
                      {flow.schedule === 'members' && n.type === 'agent' && (
                        <input type="time" value={n.time || ''} onChange={(e) => patchNode(n.id, { time: e.target.value })} title="This member works at…"
                          className="shrink-0 rounded bg-glass/[0.06] px-1 py-0.5 text-[10px] text-ink outline-none" />
                      )}
                    </div>
                    {n.type === 'email' && (
                      <div className="mb-1 flex gap-1">
                        <input value={n.to || ''} onChange={(e) => patchNode(n.id, { to: e.target.value })} placeholder="to@email.com"
                          className="w-1/2 rounded-lg border border-glass/[0.1] bg-glass/[0.04] px-1.5 py-1 text-[11px] text-ink outline-none placeholder:text-dim" />
                        <input value={n.subject || ''} onChange={(e) => patchNode(n.id, { subject: e.target.value })} placeholder="Subject"
                          className="w-1/2 rounded-lg border border-glass/[0.1] bg-glass/[0.04] px-1.5 py-1 text-[11px] text-ink outline-none placeholder:text-dim" />
                      </div>
                    )}
                    {n.type === 'social' && (
                      <div className="mb-1 space-y-1">
                        <select value={n.platform || 'Instagram'} onChange={(e) => patchNode(n.id, { platform: e.target.value })} onPointerDown={(e) => e.stopPropagation()}
                          className="w-full rounded-lg border border-glass/[0.1] bg-glass/[0.04] px-1.5 py-1 text-[11px] text-ink outline-none">
                          {['Instagram', 'TikTok', 'LinkedIn', 'X (Twitter)', 'Pinterest', 'Threads', 'Facebook'].map((pl) => <option key={pl} value={pl} className="bg-panel2">{pl}</option>)}
                        </select>
                        <select value={n.format || 'carousel'} onChange={(e) => patchNode(n.id, { format: e.target.value })} onPointerDown={(e) => e.stopPropagation()}
                          className="w-full rounded-lg border border-glass/[0.1] bg-glass/[0.04] px-1.5 py-1 text-[11px] text-ink outline-none">
                          <option value="carousel" className="bg-panel2">Carousel / image post</option>
                          <option value="video" className="bg-panel2">Video (reel / TikTok) — Nalu Video</option>
                        </select>
                        <input value={n.webhook || ''} onChange={(e) => patchNode(n.id, { webhook: e.target.value })} placeholder="Auto-post webhook (Zapier/Make/Buffer) — optional"
                          className="w-full rounded-lg border border-glass/[0.1] bg-glass/[0.04] px-1.5 py-1 text-[11px] text-ink outline-none placeholder:text-dim" />
                      </div>
                    )}
                    <textarea value={n.prompt} onChange={(e) => patchNode(n.id, { prompt: e.target.value })} rows={4}
                      placeholder={n.type === 'agent' ? `What should this employee do? {{input}} = upstream output.` : n.type === 'email' ? 'Email body — {{input}} = upstream output.' : `Style/brief for the ${meta.name.toLowerCase()} (the upstream output is the material).`}
                      className="w-full resize-none rounded-lg border border-glass/[0.1] bg-glass/[0.04] p-1.5 text-[11.5px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-glass/25" />
                    {n.type === 'agent' && (
                      <textarea value={n.roleNotes || ''} onChange={(e) => patchNode(n.id, { roleNotes: e.target.value })} rows={2}
                        onPointerDown={(e) => e.stopPropagation()}
                        placeholder="How this agent must work (notes) — exact rules that override defaults: e.g. always cite sources, keep under 200 words, use our brand voice, never contact competitors."
                        className="mt-1.5 w-full resize-none rounded-lg border border-amber-400/20 bg-amber-500/[0.04] p-1.5 text-[11px] leading-relaxed text-ink outline-none placeholder:text-dim/70 focus:border-amber-400/40" />
                    )}
                    {flow.artifacts?.[n.id] && (
                      <button onClick={() => void redownload(flow.artifacts![n.id])} onPointerDown={(e) => e.stopPropagation()}
                        title="Download this file again"
                        className="mt-1 flex w-full items-center gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2 py-1.5 text-left transition-colors hover:bg-emerald-500/20">
                        <Download size={11} className="shrink-0 text-emerald-300" />
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">{flow.artifacts[n.id].filename}</span>
                        <span className="shrink-0 text-[9.5px] tabular-nums text-dim">{Math.max(1, Math.round(flow.artifacts[n.id].size / 1024))} KB</span>
                      </button>
                    )}
                    {(out || st === 'running') && (
                      <div className="mt-1 rounded-lg border border-glass/[0.08] bg-black/25 p-1.5">
                        <div className="mb-0.5 flex items-center justify-between">
                          <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-dim">
                            Output{durs[n.id] ? ` · ${Math.max(1, Math.round(durs[n.id] / 1000))}s` : ''}{st === 'skipped' ? ' · skipped' : st === 'error' ? ' · failed' : ''}
                          </span>
                          {out && <button onClick={() => setExpanded(n.id)} className="flex items-center gap-1 text-[10px] text-gold hover:text-ink"><Maximize2 size={9} /> Expand</button>}
                        </div>
                        <div className="max-h-20 overflow-hidden whitespace-pre-wrap text-[10.5px] leading-snug text-dim">{cleanSnippet(out || '…').slice(-460)}</div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {!flow.nodes.length && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-dim">
                <span className="text-[13px]">Add steps, wire them ● <ChevronRight size={11} className="inline" /> ●, press Run.</span>
                <span className="text-[11px]">Your AI team works while you sleep · Outputs create real files (docs, decks, sheets, emails)</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* company setup — REQUIRED before a company exists: what it is + what it does */}
      {coSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setCoSetup(null)}>
          <div className="w-full max-w-md rounded-2xl border border-glass/[0.16] bg-panel2 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold text-ink">Set up your company</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-dim">Every employee's work is grounded in this — you can tweak each position after it's created.</div>
            <label className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Company name</label>
            <input autoFocus value={coSetup.name} onChange={(e) => setCoSetup({ ...coSetup, name: e.target.value })} placeholder="Hillpointe Coffee Co."
              className="mt-1 w-full rounded-lg border border-glass/[0.12] bg-glass/[0.05] px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim focus:border-glass/30" />
            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">What the company is</label>
            <textarea value={coSetup.what} onChange={(e) => setCoSetup({ ...coSetup, what: e.target.value })} rows={2} placeholder="A specialty coffee roaster selling online and wholesale to cafes in Texas."
              className="mt-1 w-full resize-none rounded-lg border border-glass/[0.12] bg-glass/[0.05] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-glass/30" />
            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">What it's supposed to do</label>
            <textarea value={coSetup.mission} onChange={(e) => setCoSetup({ ...coSetup, mission: e.target.value })} rows={3} placeholder="Grow to $50k/mo: land 3 new wholesale accounts weekly, ship 2 marketing campaigns a month, keep margins above 60%, book tastings with prospects."
              className="mt-1 w-full resize-none rounded-lg border border-glass/[0.12] bg-glass/[0.05] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-glass/30" />
            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Notes for every agent <span className="text-dim/60 normal-case tracking-normal">— hard rules they all follow</span></label>
            <textarea value={coSetup.notes} onChange={(e) => setCoSetup({ ...coSetup, notes: e.target.value })} rows={3} placeholder="e.g. Voice: warm + direct, never salesy. Never contact anyone outside Texas. Always price in USD. Approvals over $5k go to me first."
              className="mt-1 w-full resize-none rounded-lg border border-glass/[0.12] bg-glass/[0.05] px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-glass/30" />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setCoSetup(null)} className="rounded-lg px-3 py-1.5 text-[12px] text-dim hover:bg-glass/10 hover:text-ink">Cancel</button>
              <button
                disabled={!coSetup.name.trim() || !coSetup.what.trim() || !coSetup.mission.trim()}
                onClick={() => { createCompany(coSetup.name, coSetup.what, coSetup.mission, coSetup.notes); setCoSetup(null) }}
                className="rounded-lg bg-gradient-to-r from-[#c9a86a] to-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-[#15170f] hover:brightness-110 disabled:opacity-40">
                Create company
              </button>
            </div>
          </div>
        </div>
      )}

      {/* full result modal */}
      {expandedNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setExpanded(null)}>
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-glass/[0.16] bg-panel2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-glass/[0.1] px-4 py-2.5">
              <span className="text-sm font-medium text-ink">{expandedNode.label}</span>
              <button onClick={() => setExpanded(null)} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md bg-glass/10 text-ink hover:bg-glass/20"><X size={14} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 text-[13.5px] leading-relaxed text-ink">
              <Markdown>{nodeResult(expandedNode.id)}</Markdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
