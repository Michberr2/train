import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parseFlowDraft } from './flowDraft'
import { parseFlowFilter, selectFlowBranch, parsePlannerAction, routerEdgeLabels, routerGraphErrors } from '../../../../shared/autopilotDecisions'
import AutopilotNodeCard from './AutopilotNodeCard'
import AutopilotTemplates from './AutopilotTemplates'
import { arrangeAutopilotNodes } from './autopilotLayout'
import { AUTOPILOT_NODE_WIDTH, connectionCurve, outputPort, layoutAutopilotConnections } from './autopilotConnections'
import './autopilotControls.css'
import {
  Bot, Play, Plus, Trash2, X, Loader2, Clock, Power, ChevronRight, ChevronUp, ChevronDown, Paperclip,
  CircleDollarSign, Palette, MessageSquare, Code2, Bitcoin, Home, Scale,
  HeartPulse, Stethoscope, Building2, HardHat, Megaphone, BrainCircuit, FlaskConical, Sigma, Maximize2, FileText, BarChart3, Table2,
  Mail, Download, CheckCircle2, XCircle, PanelLeft, Users, Link2, Plug, type LucideIcon,
  Zap, GitBranch, Filter, ShieldCheck, Search, Globe, Database, Wand2, Activity, Webhook,
  Layers, History, Copy, Upload, ListTree, Minus, Settings2, MoreHorizontal, RefreshCw,
} from 'lucide-react'
import { streamChat as requestChat } from './agentApi'
import { runGraph, isScheduleDue, withAbort, nodeAttemptLimit } from './autopilotRuntime'
import { importLegacyAutomations } from './legacyAutomations'
import { HEDGE_FUND_ROLES, hedgeFundTeam } from './hedgeFund'
import { hedgeFundOutputContract, guardHedgeFundOutput } from '../../../../shared/hedgeFundRisk'
import { referenceDocumentContext } from '../../../../shared/referenceDocument'
import { extractAttachment, attachmentExtractionSummary } from './extractText'
import { listConnections, sendVia, sendPipelineVia, pipelineReviewStatus, appDef, type Connection } from '../../lib/connections'
import ConnectionManager from './ConnectionManager'
import { sessionWasCleared, loadFromServer } from '../../lib/sync'
import { deSlop as deSlopEmail } from '../../lib/emailStyle'
import { generateVideo } from '../../lib/videoEngine'
import { getBrand } from './brandKit'
import Markdown from './Markdown'
import { cleanPlainText as cleanSnippet, textFileBody, textFileName } from '../../../../shared/autopilotText'
import { markdownFileBody } from '../../../../shared/autopilotFiles'
import { graphErrors, needsOpenWorkspace } from '../../../../shared/autopilotCapabilities'
import { listOutputs, refreshOutputs, storeOutput, getOutputBlob, deleteOutput, downloadBlobFile, buildEmlBlob, openMailto, buildIcsBlob, buildGmailFiltersXml, buildVcfBlob, type OutputMeta, type IcsEvent, type MailRule, type VcfContact } from './agentOutputs'
import { buildEvaluator } from './formulaEval'
import { getToken } from '../../lib/localAuth'
import RemoteTaskActivity from '../RemoteTaskActivity'
import TeamDirectory from '../TeamDirectory'

// Nalu Agents — a minimal, no-code agent pipeline builder. Drop Nalu
// specialists and OUTPUT steps onto the canvas, wire them, run or schedule.
// Output steps produce real files (Word docs, PowerPoints, Excel workbooks,
// email drafts) that auto-download to your Downloads folder AND are stored in
// the Outputs library. Left rail: every flow, what's running, every output.

// Pipeline steps must never pass an incomplete response to a downstream action.
async function streamChat(...args: Parameters<typeof requestChat>) {
  const result = await requestChat(...args)
  if (args[2].signal?.aborted) throw new DOMException('Run stopped', 'AbortError')
  if (result.error) throw new Error(result.error)
  if (!result.text.trim() && !result.toolCalls.length) throw new Error('The model returned no answer. Please retry.')
  return result
}

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
  // 10x additions: triggers, control flow, and action/tool nodes
  | 'trigger' | 'router' | 'filter' | 'approval' | 'websearch' | 'fetchurl' | 'http' | 'memory' | 'foreach' | 'planner'
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
// 10x: triggers, control-flow and action/tool nodes — the pieces that turn a
// scheduled report generator into a reactive, tool-using automation platform.
type ControlGroup = 'trigger' | 'logic' | 'tool'
const CONTROLS: { type: NodeType; name: string; desc: string; icon: LucideIcon; tint: string; group: ControlGroup }[] = [
  { type: 'trigger', name: 'Trigger', desc: 'Start on a schedule, a webhook/form, or an API call', icon: Zap, tint: '#FBBF24', group: 'trigger' },
  { type: 'router', name: 'Router / Switch', desc: 'Branch: AI or a rule sends the input down ONE path', icon: GitBranch, tint: '#A78BFA', group: 'logic' },
  { type: 'filter', name: 'Filter / Gate', desc: 'Only continue when a condition passes (else stop cleanly)', icon: Filter, tint: '#F59E0B', group: 'logic' },
  { type: 'foreach', name: 'For-each (map)', desc: 'Split a list + run a step on EACH item in parallel, then join', icon: Layers, tint: '#60A5FA', group: 'logic' },
  { type: 'planner', name: 'Autopilot Agent', desc: 'Give it a GOAL — it plans, searches/fetches, and delivers', icon: Wand2, tint: '#F472B6', group: 'logic' },
  { type: 'approval', name: 'Approval', desc: 'Pause for your Approve / Edit / Reject before continuing', icon: ShieldCheck, tint: '#34D399', group: 'logic' },
  { type: 'websearch', name: 'Web search', desc: 'Live web search — real results feed downstream', icon: Search, tint: '#38BDF8', group: 'tool' },
  { type: 'fetchurl', name: 'Read a URL', desc: 'Fetch + read a web page into the flow', icon: Globe, tint: '#22D3EE', group: 'tool' },
  { type: 'http', name: 'HTTP request', desc: 'Call any API (GET/POST) and pass the result on', icon: Webhook, tint: '#C084FC', group: 'tool' },
  { type: 'memory', name: 'Memory', desc: 'Remember values between runs (set / append / get)', icon: Database, tint: '#93C5FD', group: 'tool' },
]
const controlDef = (t: NodeType) => CONTROLS.find((c) => c.type === t)
const isControl = (t: NodeType) => CONTROLS.some((c) => c.type === t)
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
  // ---- Social media & content roles (feed the Social post / Email output steps) ----
  { key: 'smm', title: 'Social Media Manager', engine: 'social', desc: 'Calendar, posting, growth', charter: 'You run the brand\'s social presence end to end across Instagram, TikTok, LinkedIn, X, Facebook, Pinterest and Threads. Build the weekly content calendar (platform, format, hook, CTA, posting time), keep a consistent voice, and grow reach + engagement. DELIVERABLE FORMAT: today\'s posts ready to publish — for EACH: platform, the hook (first line/2-sec), the full caption, 5-10 mixed hashtags, the visual direction, and the exact post time. Then the week ahead as a table. Hand finished posts to the Social post step so they auto-publish through the connected account. KPIs: reach, saves/shares, follower growth, engagement rate.' },
  { key: 'content', title: 'Content Creator', engine: 'social', desc: 'Post ideas, hooks, scripts', charter: 'You are an idea machine: generate fresh, on-brand, high-engagement content daily — carousels, reels/short-video scripts, single posts, threads. Lead with a scroll-stopping hook, one idea per slide/beat, and a clear payoff. DELIVERABLE FORMAT: 3-5 ready concepts, each with the hook, the slide-by-slide or shot-by-shot outline, the caption, and why it will perform. Vary formats and angles so nothing repeats. Feed the best into the Social post step.' },
  { key: 'copy', title: 'Copywriter', engine: 'writing', desc: 'Captions, emails, ad copy', charter: 'You write words that convert: captions, email newsletters, ad copy, landing headlines, CTAs — always in the brand voice, always specific, never filler. DELIVERABLE FORMAT: the finished copy ready to ship (subject lines + body for email; hook + caption for social; headline + subhead + CTA for ads), plus one alt version to A/B. State the one metric each piece is optimized for.' },
  { key: 'community', title: 'Community Manager', engine: 'social', desc: 'Replies, DMs, engagement', charter: 'You keep the community warm: draft on-brand replies to comments and DMs, spot and route leads, surface recurring questions into content, and flag anything that needs a human. DELIVERABLE FORMAT: reply drafts ready to send (grouped by platform), a list of lead/opportunity DMs with a suggested response, and the top 3 themes worth turning into posts.' },
  { key: 'brand', title: 'Brand Strategist', engine: 'studio', desc: 'Voice, positioning, look', charter: 'You own how the brand looks and sounds: positioning, voice-and-tone rules, visual identity (palette with hex, type, motifs), and the content pillars everything ladders up to. DELIVERABLE FORMAT: the brand guardrails for this cycle — voice do/don\'t, the 3-5 content pillars, the visual direction (exact colors, fonts, imagery style), and 3 example posts that nail it. Everyone else follows your guardrails.' },
  { key: 'emailmkt', title: 'Email Marketer', engine: 'marketing', desc: 'Newsletters, sequences, sends', charter: 'You own the email channel: newsletters, welcome and nurture sequences, and campaign sends. Write the full email (subject, preview text, body, CTA) in the brand voice, segment the audience, and pick the send time. DELIVERABLE FORMAT: the ready-to-send email(s) — subject + preview + body — plus which segment and when. Hand each to the Email step so it can send through the connected account. KPIs: open rate, click rate, conversions.' },
]
const roleDef = (key?: string): RoleDef | undefined => COMPANY_ROLES.find((r) => r.key === key) || (HEDGE_FUND_ROLES.find((r) => r.key === key) as RoleDef | undefined)
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
// Sentinel a filter/approval returns to STOP its branch cleanly (not an error).
const STOP_SENTINEL = '__NALU_STOP_9f3a__'
// A non-AI condition test for filter/router branches.
function evalCond(mode: string | undefined, cond: string | undefined, input: string): boolean {
  const t = input || ''
  const c = (cond || '').trim()
  const num = () => parseFloat((t.match(/-?\d[\d,.]*/)?.[0] || '').replace(/,/g, ''))
  switch (mode) {
    case 'notempty': return t.trim().length > 0
    case 'contains': return c ? t.toLowerCase().includes(c.toLowerCase()) : t.trim().length > 0
    case 'gt': return Number.isFinite(num()) && num() > parseFloat(c || '0')
    case 'lt': return Number.isFinite(num()) && num() < parseFloat(c || '0')
    default: return t.trim().length > 0
  }
}
// For-each: split an upstream text blob into a list of items to map over.
function splitItems(input: string, by: PNode['splitBy']): string[] {
  const t = (input || '').trim()
  if (!t) return []
  if (by === 'json') {
    try { const j = JSON.parse(t.slice(t.indexOf('[') >= 0 ? t.indexOf('[') : 0)); if (Array.isArray(j)) return j.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).filter(Boolean) } catch { /* fall through */ }
  }
  if (by === 'commas') return t.split(',').map((s) => s.trim()).filter(Boolean)
  if (by === 'numbered') {
    const m = t.split(/\n(?=\s*(?:\d+[.)]|[-*•]))/).map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean)
    if (m.length > 1) return m
  }
  // default: one item per non-empty line (strip bullets/numbers)
  return t.split('\n').map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean)
}
// Autopilot Agent (planner): ask the model for the next tool action or a final answer.
const PLANNER_PROMPT = (goal: string, scratch: string[], step: number, max: number) =>
  `You are an autonomous agent working toward a GOAL. You may use tools to gather what you need, then deliver.\n` +
  `GOAL: ${goal}\n\n` +
  (scratch.length ? `WHAT YOU KNOW SO FAR:\n${scratch.join('\n\n').slice(-8000)}\n\n` : '') +
  `This is step ${step + 1} of at most ${max}. Decide ONE next action and reply with ONLY minified JSON:\n` +
  `- To search the web: {"action":"search","query":"..."}\n` +
  `- To read a page: {"action":"fetch","url":"https://..."}\n` +
  `- When you have enough to deliver: {"action":"finish","answer":"<the full final deliverable>"}\n` +
  `Prefer to finish as soon as you can do a great job. Output JSON only.`
// Thrown by an approval node with no decision yet → the engine pauses the run.
class AwaitingApproval extends Error {}
// Describe-to-Build: turn a plain-English ask into a pipeline plan (JSON).
const BUILD_PROMPT = (ask: string, catalog: { agents: unknown; outputs: unknown; controls: unknown }) =>
  `Build an executable Nalu flow from the user's request. Return ONLY JSON. Available steps: ${JSON.stringify(catalog)}.
Use 1-16 purposeful steps, with explicit IDs and directed edges. Preserve parallel work, conditional branches, and joins; do not flatten everything into a chain. Use agent steps for reasoning, websearch/fetchurl for explicit source gathering, router/filter for decisions, foreach for iteration, and the appropriate artifact/output for the final deliverable. Internal routing decisions need no web search. For scheduled reports without an explicitly requested file format, prefer markdown output so the file can finish while the workspace is closed. Factual agent steps should have webSearch:true unless the user wants only supplied data.
Each node kind must be a concrete supported type. "output" is a category, never a node kind. Use kind:"markdown", "textfile", "doc", "pdf", "slides", "sheet", "website", "email", or another exact output type in the catalog.
Complete example: {"name":"Research brief","schedule":"manual","time":"08:00","nodes":[{"id":"scan","kind":"agent","agent":"general","label":"Research","prompt":"Research the requested topic and cite sources.","webSearch":true},{"id":"report","kind":"markdown","label":"Save the brief","prompt":"{{input}}"}],"edges":[{"from":"scan","to":"report"}]}.
Include only necessary supported configuration: router routeBy:"condition|ai", branches:[{label,cond}], outgoing edge label matching each branch; filter condMode:"contains|gt|lt|notempty|ai", cond; http method,url,headers; fetchurl url; email to,subject; memory memOp:"get|set|append",memKey; foreach splitBy:"lines|json|numbered|commas",maxItems; planner maxSteps; output format. Use {{input}} for upstream results. Never invent an email recipient, credential, endpoint, connection ID, or real-world business fact. Leave missing configuration empty for the user to fill in. No cycles. Every router branch must lead to a step. Schedule only as requested, otherwise manual. The plan will be reviewed before saving and starts disabled.
USER REQUEST: ${ask}`
const nodeMeta = (n: PNode): { name: string; icon: LucideIcon; tint: string } => {
  if (n.type === 'agent' && n.role) {
    const r = roleDef(n.role)
    if (r) return { name: r.title, icon: agentDef(r.engine).icon, tint: n.role.startsWith('hf-') ? '#34D399' : '#7DD3FC' }
  }
  if (n.type === 'agent') return agentDef(n.agent || 'general')
  return controlDef(n.type) || OUTPUTS.find((o) => o.type === n.type) || OUTPUTS[0]
}

// ---- flow model + persistence -----------------------------------------------
type NodeState = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'skipped'
type Branch = { label: string; cond?: string }
type PNode = { id: string; x: number; y: number; type: NodeType; agent?: string; role?: string; label: string; prompt: string; to?: string; subject?: string; auto?: boolean; time?: string; lastRunDay?: string; platform?: string; webhook?: string; format?: string; roleTitle?: string; roleNotes?: string; refDoc?: RefDoc; connectionId?: string
  // 10x fields:
  triggerKind?: 'schedule' | 'webhook' | 'manual' // trigger node
  routeBy?: 'ai' | 'condition'; branches?: Branch[] // router node
  condMode?: 'contains' | 'gt' | 'lt' | 'notempty' | 'ai'; cond?: string // filter node
  approveVia?: 'push' | 'email'; autoApproveMins?: number // approval node
  method?: string; url?: string; headers?: string // http node
  memKey?: string; memOp?: 'set' | 'append' | 'get' // memory node
  webSearch?: boolean // current factual evidence, enabled by default
  useTools?: boolean // agent node — let the specialist search/fetch/browse mid-step
  splitBy?: 'lines' | 'json' | 'numbered' | 'commas'; maxItems?: number // foreach node
  maxSteps?: number // planner node
}
type Edge = { from: string; to: string; label?: string } // label = the router branch this edge belongs to
type Schedule = 'manual' | 'hourly' | 'daily' | 'weekly' | 'continuous' | 'members'
type Company = { what: string; mission: string; notes?: string }
// A durable run record that travels WITH the flow (so it survives a hard refresh
// and syncs to the server). `heartbeat` is bumped by whoever is actively running;
// if it goes stale the run is orphaned and can be safely resumed/taken over.
type FlowRun = { status: 'running' | 'done' | 'error' | 'stuck' | 'stopped' | 'awaiting'; step: number; total: number; startedAt: number; updatedAt: number; heartbeat: number; node?: string; nodeLabel?: string; error?: string
  // Router/filter branch cuts made SO FAR ("from>to" edge keys). Persisted so a
  // resume / server-takeover doesn't lose them and re-run untaken branches. */
  cutEdges?: string[]; yielded?: boolean; serverManaged?: boolean; checkpoints?: Record<string, unknown>; pendingEffect?: { nodeId: string; startedAt: number } }
// A durable snapshot of one run for the Run Inspector: per-node input/output/status/ms.
type RunSnap = { id: string; flowId: string; flowName: string; at: number; status: string; ms: number; nodes: Record<string, { label: string; type: string; input: string; output: string; state: string; ms: number }> }
// A pending human-approval decision, stored on the flow until the user answers.
type Approval = { decision: 'approve' | 'edit' | 'reject'; text?: string; at: number }
// A saved snapshot of the flow's structure the user can roll back to.
type Version = { id: string; at: number; note: string; nodes: PNode[]; edges: Edge[] }
// refDoc: a document the user uploads from their computer that every agent in the
// flow gets as authoritative reference context on each run.
type RefDoc = { name: string; text: string; coverage?: string }
type Flow = { id: string; name: string; nodes: PNode[]; edges: Edge[]; schedule: Schedule; time: string; timeZone?: string; enabled: boolean; lastRun?: number; results?: Record<string, string>; company?: Company; artifacts?: Record<string, OutputMeta>; defaultKey?: string; run?: FlowRun; refDoc?: RefDoc
  // 10x: persistent per-flow memory (survives runs), pending approvals, exposed-as-API,
  // and the last run's inspector snapshot.
  memory?: Record<string, string>; approvals?: Record<string, Approval>; apiEnabled?: boolean; apiSecret?: string; snap?: RunSnap; versions?: Version[] }
type Run = { id: string; flowId: string; flowName: string; startedAt: number; finishedAt?: number; status: 'running' | 'done' | 'error' | 'stopped' | 'awaiting'; note?: string }
const FLOWS_KEY = 'nalu-agent-flows'
const RUNS_KEY = 'nalu-agent-runs'
// A single step gets this long to produce output before it's declared STUCK and
// broken (so a hung model call can never spin forever). A run's heartbeat older
// than RUN_STALE_MS means the tab that owned it is gone — safe to resume.
const NODE_TIMEOUT_MS = 150_000
const RUN_STALE_MS = 180_000
const HEARTBEAT_MS = 6_000
// A node gets several attempts with exponential backoff before it's declared
// failed — so a transient provider blip (429 burst under concurrent load, a 5xx,
// a dropped stream, or an empty response) NEVER fails a step that would succeed on
// a retry a moment later. This is the difference between "agents randomly fail"
// and "it just works".
const MAX_NODE_ATTEMPTS = 5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Exponential backoff with jitter for retry N (2-based): ~0.6s, 1.2s, 2.4s, 4s cap.
const retryBackoffMs = (attempt: number) => Math.min(600 * 2 ** (attempt - 2), 4000) + Math.floor(Math.random() * 400)
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3)

function starterFlow(): Flow {
  const n1: PNode = { id: uid(), x: 40, y: 40, type: 'agent', agent: 'general', label: 'Scan the news', prompt: "Research today's most important financial and world-economy news: central bank moves, market swings, major earnings, geopolitics. Return a tight bulleted digest with numbers." }
  const n2: PNode = { id: uid(), x: 400, y: 170, type: 'agent', agent: 'finance', label: 'Analyze like a PM', prompt: 'You are given a news digest below. Analyze it like a hedge fund PM: the 3 themes that matter, what they mean for equities/bonds/commodities, and 2-3 positioning ideas with risk framing.\n\n{{input}}' }
  const n3: PNode = { id: uid(), x: 760, y: 40, type: 'doc', label: 'Morning brief doc', prompt: 'A crisp, scannable morning market brief.' }
  return { id: uid(), name: 'New pipeline', nodes: [n1, n2, n3], edges: [{ from: n1.id, to: n2.id }, { from: n2.id, to: n3.id }], schedule: 'daily', time: '08:00', enabled: false }
}

// ---- Pure builders (no React state) — shared by the "+" menu AND the default
// templates below, so both stay identical. ----------------------------------
function buildAutoPosterFlow(): Flow {
  const idea: PNode = { id: uid(), x: 40, y: 60, type: 'agent', agent: 'social', label: 'Post idea', prompt: "You are our social media strategist. Come up with ONE fresh, on-brand, high-engagement post idea for today about our niche — a specific hook + the 5-7 points it should cover. Vary it daily so we never repeat. Return the idea and the points." }
  const post: PNode = { id: uid(), x: 420, y: 60, type: 'social', label: 'Daily post', platform: 'Instagram', webhook: '', prompt: 'Turn the idea below into a scroll-stopping post.\n\n{{input}}' }
  return { id: uid(), name: 'Auto-poster', nodes: [idea, post], edges: [{ from: idea.id, to: post.id }], schedule: 'daily', time: '09:00', enabled: false }
}
function buildHedgeFundFlow(name: string, tickers: string): Flow {
  const team = hedgeFundTeam(tickers)
  const mk = (n: { key: string; title: string; engine: string; task: string }, x: number, y: number): PNode =>
    ({ id: uid(), x, y, type: 'agent', agent: n.engine, role: n.key, label: n.title, prompt: n.task })
  const analysts = team.analysts.map((n, i) => mk(n, 40 + (i % 3) * 340, 40 + Math.floor(i / 3) * 210))
  const macro = mk(team.macro, 40 + (analysts.length % 3) * 340, 40 + Math.floor(analysts.length / 3) * 210)
  const risk = mk(team.risk, 1220, 120)
  const portfolio = mk(team.portfolio, 1580, 120)
  const memo: PNode = { id: uid(), x: 1940, y: 120, type: 'doc', label: 'Investment research memo', prompt: "Summarize the supplied research and checked portfolio result. Preserve its status and execution:none. If research-only, list the missing policy inputs and do not invent quantities, balances, or numerical confidence. If a proposal passed deterministic checks, reproduce only its supplied quantities and policy limits, label it an unexecuted proposal, and retain sources, timestamps, assumptions, and uncertainty." }
  const feeders = [...analysts, macro]
  return {
    id: uid(), name: name.trim() || 'Nalu Hedge Fund', schedule: 'daily', time: '07:00', enabled: false,
    company: { what: `An AI-run hedge fund analyzing ${tickers.trim() || 'a watchlist'} with a full investment committee — famous investor personas plus analytical, macro, risk and portfolio agents.`, mission: 'Make disciplined, risk-managed investment decisions daily using real-time data and multiple investing philosophies.' },
    nodes: [...analysts, macro, risk, portfolio, memo],
    edges: [
      ...feeders.map((a) => ({ from: a.id, to: risk.id })),
      ...feeders.map((a) => ({ from: a.id, to: portfolio.id })),
      { from: risk.id, to: portfolio.id },
      { from: portfolio.id, to: memo.id },
    ],
  }
}

// ---- Line-of-business COMPANY TEMPLATES — a ready team of roles wired to the
// right output (social posts / email / docs) so it produces + ships work daily.
// Each becomes a one-click template under "+ Company". Roles feed the output node,
// which publishes through the user's saved Connection when one is linked.
type CompanyTemplate = { key: string; name: string; blurb: string; tint: string; roles: string[]; output: NodeType; outputLabel: string; platform?: string; mission: string }
const COMPANY_TEMPLATES: CompanyTemplate[] = [
  { key: 'social-team', name: 'Social Media Team', blurb: 'Brand strategist + social manager + content creator + copywriter → daily posts, ready to auto-publish', tint: '#38BDF8', roles: ['brand', 'smm', 'content', 'copy', 'community'], output: 'social', outputLabel: 'Daily post', platform: 'Instagram', mission: 'Grow the audience and engagement with on-brand, high-performing posts every day, published on schedule to the connected accounts.' },
  { key: 'content-studio', name: 'Content Studio', blurb: 'A creative agency in a box — ideas, carousels, scripts, captions and a newsletter', tint: '#A78BFA', roles: ['brand', 'content', 'copy', 'smm', 'emailmkt'], output: 'social', outputLabel: 'Publish the post', platform: 'Instagram', mission: 'Produce a steady stream of standout content across social + email, all in one consistent brand voice.' },
  { key: 'sales-team', name: 'Sales Team', blurb: 'Analyst + sales lead + copywriter → researched prospects and outreach email, ready to send', tint: '#34D399', roles: ['analyst', 'sales', 'copy', 'ea'], output: 'email', outputLabel: 'Outreach email', mission: 'Fill the pipeline: find real prospects, qualify them, and send outreach that books meetings — every day.' },
  { key: 'ecommerce', name: 'E-commerce Store', blurb: 'CMO + social manager + copywriter + support → promos, posts and customer replies', tint: '#F59E0B', roles: ['cmo', 'smm', 'copy', 'support', 'emailmkt'], output: 'social', outputLabel: 'Promo post', platform: 'Instagram', mission: 'Drive sales: daily promos + social, email campaigns, and fast on-brand customer replies.' },
  { key: 'newsletter', name: 'Newsletter', blurb: 'Analyst + copywriter + email marketer → a finished newsletter, ready to send to your list', tint: '#F472B6', roles: ['analyst', 'copy', 'emailmkt'], output: 'email', outputLabel: 'The newsletter', mission: 'Ship one excellent newsletter on schedule: a fresh angle, tight writing, and a clear CTA, sent to the connected email account.' },
]
function buildTemplateFlow(t: CompanyTemplate): Flow {
  const roleNodes = t.roles.map((rk, i) => {
    const r = roleDef(rk) as RoleDef
    return { id: uid(), x: 40 + (i % 3) * 340, y: 40 + Math.floor(i / 3) * 200, type: 'agent' as NodeType, agent: r.engine, role: rk, label: r.title, prompt: `Do your job for the company today. Build finished, ready-to-ship work in your lane and hand it downstream.` }
  })
  const outMeta = OUTPUTS.find((o) => o.type === t.output)
  const outNode: PNode = { id: uid(), x: 40 + (roleNodes.length % 3) * 340 + 360, y: 60, type: t.output, label: t.outputLabel, prompt: 'Turn the team\'s work below into the finished, ready-to-publish piece.\n\n{{input}}', ...(t.platform ? { platform: t.platform, webhook: '' } : {}), ...(outMeta ? {} : {}) }
  return {
    id: uid(), name: t.name, schedule: 'daily', time: '08:00', enabled: false,
    company: { what: `${t.name} — ${t.blurb}`, mission: t.mission },
    nodes: [...roleNodes, outNode],
    edges: roleNodes.map((n) => ({ from: n.id, to: outNode.id })),
  }
}

// ---- Default starter pipelines EVERY user gets on login. Each carries a stable
// `defaultKey` + stable id. Deleting one tombstones its key (nalu-deleted-flows)
// so it's gone FOREVER — never re-seeded on this device or any other. --------
const DELETED_FLOWS_KEY = 'nalu-deleted-flows'
function deletedFlowKeys(): Set<string> {
  try { const a = JSON.parse(localStorage.getItem(DELETED_FLOWS_KEY) || '[]'); return new Set(Array.isArray(a) ? a.map(String) : []) } catch { return new Set() }
}
function tombstoneFlowKey(key: string) {
  try { const s = deletedFlowKeys(); s.add(key); localStorage.setItem(DELETED_FLOWS_KEY, JSON.stringify([...s])) } catch { /* */ }
}
const DEFAULT_TEMPLATES: Array<{ key: string; id: string; build: () => Flow }> = [
  { key: 'nalu-labs', id: 'default-nalu-labs', build: () => ({ ...starterFlow(), name: 'Nalu Labs — Daily Brief' }) },
  { key: 'autoposter', id: 'default-autoposter', build: buildAutoPosterFlow },
  { key: 'nalu-fund', id: 'default-nalu-fund', build: () => buildHedgeFundFlow('Nalu Hedge Fund', 'AAPL, MSFT, NVDA, GOOGL, AMZN') },
]
const PREBUILT_PIPELINES = [
  { key: 'nalu-labs', name: 'Nalu Labs — Daily Brief', description: 'Research the news, analyze what matters, and create a morning brief.', output: 'Word document · 3 steps', build: DEFAULT_TEMPLATES[0].build },
  { key: 'autoposter', name: 'Auto-poster', description: 'Develop a post idea and turn it into a social post. Set your topic and platform in the steps.', output: 'Social post · 2 steps', build: buildAutoPosterFlow },
  { key: 'nalu-fund', name: 'Nalu Hedge Fund', description: 'A full research committee with analyst, macro, risk, and portfolio perspectives.', output: 'Investment memo · 19 steps', build: DEFAULT_TEMPLATES[2].build },
  ...COMPANY_TEMPLATES.map(t => ({ key: t.key, name: t.name, description: t.blurb, output: `${OUTPUTS.find(o => o.type === t.output)?.name || 'Output'} · ${t.roles.length + 1} steps`, build: () => buildTemplateFlow(t) })),
]
// Seed any default the user hasn't already got and hasn't permanently deleted.
function withDefaults(saved: Flow[]): Flow[] {
  const dead = deletedFlowKeys()
  const haveKeys = new Set(saved.map((f) => f.defaultKey).filter(Boolean) as string[])
  const haveIds = new Set(saved.map((f) => f.id))
  const missing = DEFAULT_TEMPLATES
    .filter((t) => !dead.has(t.key) && !haveKeys.has(t.key) && !haveIds.has(t.id))
    .map((t) => ({ ...t.build(), id: t.id, defaultKey: t.key }))
  let legacy: ReturnType<typeof importLegacyAutomations> = []
  try { legacy = importLegacyAutomations(localStorage.getItem('nalu-automations'), saved, dead) } catch { /* storage unavailable */ }
  return [...saved, ...legacy, ...missing].map(f => ({ ...f, timeZone: (f as Flow).timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone }))
}
function loadFlows(): Flow[] {
  try {
    const arr = JSON.parse(localStorage.getItem(FLOWS_KEY) || 'null') as Flow[] | null
    // v1 flows carried agent-only nodes without a `type` — default it in.
    if (Array.isArray(arr)) return withDefaults(arr.map((f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, type: n.type || 'agent' })) })))
  } catch { /* fresh */ }
  return withDefaults([])
}
const saveFlows = (flows: Flow[]) => { try { localStorage.setItem(FLOWS_KEY, JSON.stringify(flows)) } catch { /* */ } }
const loadRuns = (): Run[] => {
  try {
    const a = JSON.parse(localStorage.getItem(RUNS_KEY) || '[]')
    if (!Array.isArray(a)) return []
    // A run only "runs" inside a live tab. Anything still marked 'running' on load
    // is from a tab that was closed/refreshed mid-run — it's dead, not cycling.
    return a.map((r: Run) => (r && r.status === 'running'
      ? { ...r, status: 'stopped' as const, finishedAt: r.finishedAt || r.startedAt, note: r.note || 'interrupted (tab closed)' }
      : r))
  } catch { return [] }
}
const saveRuns = (runs: Run[]) => { try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(0, 100))) } catch { /* */ } }
const RUNS_PREVIEW = 6 // show the latest few; the rest live behind "Show all"

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
  const blockers = [...graphErrors(f.nodes, f.edges), ...routerGraphErrors(f.nodes, f.edges)]
  const warnings: string[] = []
  for (const n of f.nodes) {
    const hasIn = f.edges.some((e) => e.to === n.id)
    if (n.type === 'email' && !n.to?.trim()) warnings.push(`"${n.label}": no recipient — the .eml draft is created without a To address.`)
    if (n.type !== 'agent' && !hasIn && !n.prompt.trim()) warnings.push(`"${n.label}": output has no input wired and no brief — it will build from its name only.`)
  }
  if (f.schedule !== 'manual') {
    const foreground = f.nodes.filter(needsOpenWorkspace)
    if (foreground.length) warnings.push(`Keep Nalu open for these steps: ${foreground.map(n => n.label).join(', ')}. Word documents, email drafts, social carousels and portable files can finish with the workspace closed.`)
  }
  return { blockers, warnings }
}

const NODE_W = AUTOPILOT_NODE_WIDTH
const ZMIN = 0.3, ZMAX = 2 // canvas user-zoom bounds

// Model output for the small in-node preview: strip markdown syntax so it
// reads as clean prose (no ##, **, ---, [links](…) — the expand view renders
// the real formatting).


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
  const runsRef = useRef(runs); runsRef.current = runs
  const [outputs, setOutputs] = useState<OutputMeta[]>(listOutputs)
  const [outputError, setOutputError] = useState<string | null>(null)
  const [outputsExpanded, setOutputsExpanded] = useState(false)
  const outputsLoading = useRef(false)
  const loadSavedOutputs = useCallback(async () => {
    if (outputsLoading.current || sessionWasCleared()) return
    outputsLoading.current = true
    try { setOutputs(await refreshOutputs()); setOutputError(null) }
    catch (error) { setOutputError(error instanceof Error ? error.message : 'Could not load saved outputs.') }
    finally { outputsLoading.current = false }
  }, [])
  useEffect(() => {
    const refresh = () => { void loadSavedOutputs() }
    refresh()
    window.addEventListener('nalu-hydrated', refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('nalu-hydrated', refresh); window.removeEventListener('focus', refresh) }
  }, [loadSavedOutputs])
  const [states, setStates] = useState<Record<string, NodeState>>({})
  const [live, setLive] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<string | null>(null) // flowId being run
  const [connecting, setConnecting] = useState<string | null>(null)
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [nodeModal, setNodeModal] = useState<{ nodeId: string; tab: 'prompt' | 'notes' } | null>(null)
  const [addMenu, setAddMenu] = useState<false | 'add'>(false)
  const [addTab, setAddTab] = useState<'model' | 'company' | 'blocks'>('model') // section inside the unified Add menu
  const [settingsOpen, setSettingsOpen] = useState(false) // Run settings popover
  const [buildDraft, setBuildDraft] = useState<Flow | null>(null)
  const [buildError, setBuildError] = useState('')
  const [buildPhase, setBuildPhase] = useState('Planning your flow…')
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [flowView, setFlowView] = useState<'steps' | 'canvas'>('canvas')
  const [editingNode, setEditingNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  const stepEditorRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!editingNode) return
    const previous = document.activeElement as HTMLElement | null
    stepEditorRef.current?.querySelector<HTMLInputElement>('input[aria-label="Step name"]')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [editingNode])
  useEffect(() => { setEditingNode(null); setConnecting(null); setSelectedEdge(null) }, [flowId])
  const [buildOpen, setBuildOpen] = useState(false) // Describe-to-Build prompt
  const [buildText, setBuildText] = useState('')
  const [building, setBuilding] = useState(false)
  const [inspectOpen, setInspectOpen] = useState(false) // Run inspector panel
  const [apiOpen, setApiOpen] = useState(false) // Webhook / Flow-as-API settings
  const [moreOpen, setMoreOpen] = useState(false) // ⋯ menu (versions/export/import)
  const [versionsOpen, setVersionsOpen] = useState(false) // Version history modal
  const [copied, setCopied] = useState('')
  const importInput = useRef<HTMLInputElement>(null)
  const [coSetup, setCoSetup] = useState<null | { name: string; what: string; mission: string; notes: string }>(null)
  const [coNotesOpen, setCoNotesOpen] = useState(false)
  const [hfSetup, setHfSetup] = useState<null | { name: string; tickers: string }>(null)
  const [newMenu, setNewMenu] = useState(false)
  // Connections — connect Gmail/LinkedIn/etc ONCE, reuse everywhere. Loaded from
  // the server (secrets stay server-side); the list is metadata only.
  const [connMgr, setConnMgr] = useState(false)
  const [conns, setConns] = useState<Connection[]>([])
  const loadConns = useCallback(() => {
    void listConnections().then(setConns).catch(() => { /* Connections opens with a visible retry message. */ })
  }, [])
  useEffect(() => { loadConns() }, [loadConns])
  const refDocInput = useRef<HTMLInputElement>(null)
  // Attach a document from the user's computer as reference context for the flow.
  const refDocReads = useRef(new Map<string, number>())
  const readRefDocFile = useCallback(async (file: File, nodeId?: string) => {
    const targetFlow = flow?.id, token = getToken(), key = `${targetFlow}:${nodeId || 'flow'}`
    const generation = (refDocReads.current.get(key) || 0) + 1
    refDocReads.current.set(key, generation)
    try {
      const attachment = await extractAttachment(file)
      if (token !== getToken() || sessionWasCleared() || refDocReads.current.get(key) !== generation) return
      if (!attachment.text?.trim() || ['unsupported', 'failed', 'needs-ocr', 'image'].includes(attachment.extraction?.status || '')) {
        throw new Error(`${attachmentExtractionSummary(attachment)}. ${attachment.extraction?.notes.join(' ') || 'Choose a document with selectable text.'}`)
      }
      const refDoc: RefDoc = { name: file.name, text: attachment.text, coverage: [attachmentExtractionSummary(attachment), ...(attachment.extraction?.notes || [])].join('. ') }
      setFlows(fs => fs.map(f => f.id !== targetFlow ? f : nodeId ? { ...f, nodes: f.nodes.map(n => n.id === nodeId ? { ...n, refDoc } : n) } : { ...f, refDoc }))
    } catch (error) {
      if (token === getToken() && !sessionWasCleared() && refDocReads.current.get(key) === generation) setRunWarn(`Could not attach ${file.name}: ${error instanceof Error ? error.message : 'Document extraction failed.'}`)
    }
  }, [flow?.id])
  const onRefDocFile = (file: File) => { void readRefDocFile(file) }
  // Attach a reference to ONE individual agent (their own source of truth).
  const nodeRefInput = useRef<HTMLInputElement>(null)
  const nodeRefTarget = useRef<string>('')
  const onNodeRefFile = (file: File) => { const nodeId = nodeRefTarget.current; if (nodeId) void readRefDocFile(file, nodeId) }
  const [runsExpanded, setRunsExpanded] = useState(false)
  const [runWarn, setRunWarn] = useState<string | null>(null)
  const [durs, setDurs] = useState<Record<string, number>>({})
  const [railOpen, setRailOpen] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [nodeSizes, setNodeSizes] = useState<Record<string, { width: number; height: number }>>({})
  const canvasNodeIds = flow?.nodes.map(node => node.id).join('\n')
  useLayoutEffect(() => {
    if (flowView !== 'canvas') return
    const cards = Array.from(canvasRef.current?.querySelectorAll<HTMLElement>('[data-step-id]') || [])
    const measure = () => {
      const next = Object.fromEntries(cards.map(card => [card.dataset.stepId!, { width: card.offsetWidth, height: card.offsetHeight }]))
      setNodeSizes(current => Object.keys(current).length === cards.length && cards.every(card => current[card.dataset.stepId!]?.height === next[card.dataset.stepId!].height && current[card.dataset.stepId!]?.width === next[card.dataset.stepId!].width) ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    cards.forEach(card => observer.observe(card))
    return () => observer.disconnect()
  }, [canvasNodeIds, flowView])
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
  // pan/drag are scoped to the pointer that started them, so a stray second touch
  // can't hijack or abort an in-progress pan or node-drag.
  const dragRef = useRef<{ id: string; dx: number; dy: number; pointerId: number } | null>(null)
  const panRef = useRef<{ x: number; y: number; sl: number; st: number; pointerId: number } | null>(null)
  // ---- canvas zoom: null = auto-fit; a number = the user's chosen scale ----
  const [userZoom, setUserZoom] = useState<number | null>(1)
  const [prevFlowId, setPrevFlowId] = useState<string | undefined>(undefined)
  const zoomAnchorRef = useRef<{ s0: number; s1: number; cx: number; cy: number; sl: number; st: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // 10x control-flow: a router records which branch labels it took; the engine cuts the rest.
  const routeRef = useRef<Record<string, string[]>>({})
  const pausedRef = useRef<string | null>(null) // node id an approval gate is waiting on
  const fitScaleRef = useRef(1)
  const flowsRef = useRef(flows); flowsRef.current = flows

  // Debounce flow persistence: dragging a node calls patchNode on every
  // pointermove, so an un-debounced save would JSON.stringify + write the whole
  // flows array (with results/snapshots) dozens of times a second. A trailing
  // write ~300ms after the last change captures the settled state; a flush on
  // unmount/tab-hide guarantees nothing is lost.
  const flowsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (flowsSaveTimer.current) clearTimeout(flowsSaveTimer.current)
    flowsSaveTimer.current = setTimeout(() => { flowsSaveTimer.current = null; saveFlows(flowsRef.current) }, 300)
  }, [flows])
  useEffect(() => {
    const flush = () => {
      if (flowsSaveTimer.current) { clearTimeout(flowsSaveTimer.current); flowsSaveTimer.current = null }
      // Don't re-write after sign-out cleared localStorage (see the chat flush).
      if (sessionWasCleared()) return
      saveFlows(flowsRef.current)
    }
    const onVis = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVis); flush() }
  }, [])
  useEffect(() => saveRuns(runs), [runs])

  const patchFlow = useCallback((fid: string, patch: Partial<Flow> | ((f: Flow) => Partial<Flow>)) => {
    setFlows((fs) => fs.map((f) => (f.id === fid ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f)))
  }, [])
  useEffect(() => {
    const refresh = (event: Event) => {
      if (sessionWasCleared()) return
      if (event instanceof StorageEvent && event.key && event.key !== FLOWS_KEY && event.key !== DELETED_FLOWS_KEY) return
      if (flowsSaveTimer.current) { clearTimeout(flowsSaveTimer.current); flowsSaveTimer.current = null }
      const incoming = loadFlows()
      setFlows((current) => {
        // A hydrate may finish while this tab is running. Preserve its live checkpoint.
        const localRun = abortRef.current ? current.find((item) => item.run?.status === 'running') : undefined
        return localRun ? [...incoming.filter((item) => item.id !== localRun.id), localRun] : incoming
      })
    }
    window.addEventListener('nalu-hydrated', refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener('nalu-hydrated', refresh); window.removeEventListener('storage', refresh) }
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
      x: (e.clientX - (r?.left || 0) + (canvasRef.current?.scrollLeft || 0)) / s + canvasSize.minX,
      y: (e.clientY - (r?.top || 0) + (canvasRef.current?.scrollTop || 0)) / s + canvasSize.minY,
    }
  }
  const onNodeDragStart = (e: React.PointerEvent, n: PNode) => {
    const p = canvasPos(e)
    dragRef.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, pointerId: e.pointerId }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  // ---- zoom: set a new scale while keeping the point (cx,cy) under the pointer
  // fixed. The layout-effect below applies the compensating scroll after the
  // spacer resizes, so zooming in/out feels anchored (not jumpy). fitScaleRef is
  // updated SYNCHRONOUSLY here so a fast burst of wheel events accumulates instead
  // of all reading the same stale pre-render scale (which under-zoomed).
  const applyZoom = useCallback((nextScale: number, cx: number, cy: number) => {
    const el = canvasRef.current
    if (!el) return
    const s1 = Math.max(ZMIN, Math.min(ZMAX, nextScale))
    // Reuse a still-pending anchor (mid-burst) so s0/scroll stay the burst's start.
    const pending = zoomAnchorRef.current
    if (!pending && Math.abs(s1 - fitScaleRef.current) < 0.0005) return
    zoomAnchorRef.current = pending
      ? { ...pending, s1 }
      : { s0: fitScaleRef.current, s1, cx, cy, sl: el.scrollLeft, st: el.scrollTop }
    fitScaleRef.current = s1
    setUserZoom(s1)
  }, [])
  const zoomAtCenter = (factor: number) => applyZoom(fitScaleRef.current * factor, viewSize.w / 2, viewSize.h / 2)
  const resetZoom = () => applyZoom(1, viewSize.w / 2, viewSize.h / 2)
  const fitToScreen = () => { zoomAnchorRef.current = null; setUserZoom(null); const el = canvasRef.current; if (el) { el.scrollLeft = 0; el.scrollTop = 0 } }
  const onCanvasMove = (e: React.PointerEvent) => {
    // Mouse drag-to-pan (touch panning is handled natively by the scroll container).
    const pan = panRef.current
    if (pan && pan.pointerId === e.pointerId && canvasRef.current) {
      canvasRef.current.scrollLeft = pan.sl - (e.clientX - pan.x)
      canvasRef.current.scrollTop = pan.st - (e.clientY - pan.y)
      return
    }
    const p = canvasPos(e)
    if (connecting) setMouse(p)
    const d = dragRef.current
    if (d && d.pointerId === e.pointerId) patchNode(d.id, { x: Math.max(0, p.x - d.dx), y: Math.max(0, p.y - d.dy) })
  }
  const onCanvasPanStart = (e: React.PointerEvent) => {
    // Touch/pen pan + pinch are handled by the browser (touch-action: pan-x pan-y),
    // so we only start a manual drag-pan for the MOUSE.
    if (e.pointerType !== 'mouse') return
    const t = e.target as HTMLElement
    if (t.closest('[data-node], button, input, textarea, select, path')) return
    panRef.current = { x: e.clientX, y: e.clientY, sl: canvasRef.current?.scrollLeft || 0, st: canvasRef.current?.scrollTop || 0, pointerId: e.pointerId }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onCanvasPointerUp = (e: React.PointerEvent) => {
    // Only clear the pan/drag that THIS pointer owns — a second finger lifting must
    // not abort the first finger's / the mouse's in-progress gesture.
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null
  }
  // After a zoom changes the scale, restore scroll so the anchored point stays put.
  useLayoutEffect(() => {
    const a = zoomAnchorRef.current, el = canvasRef.current
    if (!a || !el) return
    el.scrollLeft = Math.max(0, (a.sl + a.cx) / a.s0 * a.s1 - a.cx)
    el.scrollTop = Math.max(0, (a.st + a.cy) / a.s0 * a.s1 - a.cy)
    zoomAnchorRef.current = null
  }, [userZoom])
  // ⌘/Ctrl + wheel (and trackpad pinch, which fires wheel+ctrlKey) → zoom toward
  // the cursor. Native listener with passive:false so we can preventDefault.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return // plain wheel/trackpad = scroll
      e.preventDefault()
      const r = el.getBoundingClientRect()
      applyZoom(fitScaleRef.current * Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [applyZoom])
  const addNode = (type: NodeType, agent?: string, role?: string, customTitle?: string) => {
    if (!flow) return
    const r = roleDef(role)
    const meta = r ? { name: r.title } : type === 'agent' ? agentDef(agent || 'general') : controlDef(type) || OUTPUTS.find((o) => o.type === type)
    // Sensible defaults so a freshly dropped control/tool node just works.
    const defaults: Partial<PNode> =
      type === 'router' ? { routeBy: 'ai', branches: [{ label: 'yes' }, { label: 'no' }] }
        : type === 'filter' ? { condMode: 'notempty' }
        : type === 'http' ? { method: 'GET' }
        : type === 'trigger' ? { triggerKind: 'schedule' }
        : type === 'memory' ? { memOp: 'set', memKey: 'value' }
        : type === 'foreach' ? { splitBy: 'lines', maxItems: 20, agent: 'general', prompt: 'Handle this item:\n{{item}}' }
        : type === 'planner' ? { maxSteps: 4, agent: 'general', prompt: 'Goal: ' }
        : {}
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
      ...defaults,
    }
    patchFlow(flow.id, (f) => ({ nodes: [...f.nodes, n] }))
    setAddMenu(false); setEditingNode(n.id)
  }
  const removeNode = (nid: string) => {
    if (!flow) return
    setEditingNode(null)
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
  const runFlow = useCallback(async (target?: Flow, manual = true, resume = false) => {
    const source = target || flowsRef.current.find((x) => x.id === flowId) || flowsRef.current[0]
    if (!source || !source.nodes.length || abortRef.current) return
    // Server checkpoints include partial map/planner work and uncertain HTTP
    // outcomes. The browser must not reinterpret them as a fresh local node.
    if (resume && source.run?.pendingEffect) {
      setRunWarn('This HTTP request has an unconfirmed outcome. Check the destination before explicitly starting a new run; Resume will not replay it.')
      return
    }
    if (resume && source.run && (source.run.yielded || Object.keys(source.run.checkpoints || {}).length || source.run.serverManaged && ['running', 'awaiting'].includes(source.run.status))) {
      const token = getToken()
      if (!token) { setRunWarn('Sign in to continue this saved server run. Its checkpoint is preserved.'); return }
      const controller = new AbortController()
      abortRef.current = controller
      setRunning(source.id)
      let stopping: Promise<unknown> | undefined
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      const stop = () => { stopping = fetch('/api/data', { method: 'POST', headers, body: JSON.stringify({ action: 'flow-run', flowId: source.id, mode: 'stop', expectedStartedAt: source.run!.startedAt }), signal: AbortSignal.timeout(20000) }).catch(() => {}) }
      controller.signal.addEventListener('abort', stop, { once: true })
      try {
        const review = source.run.node ? source.approvals?.[source.run.node] : undefined
        const approval = source.run.status === 'awaiting' && review ? { nodeId: source.run.node, decision: review.decision, text: review.text } : undefined
        const response = await fetch('/api/data', { method: 'POST', headers, body: JSON.stringify({ action: 'flow-run', flowId: source.id, mode: 'resume', expectedStartedAt: source.run.startedAt, approval }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(245000)]) })
        const result = await response.json()
        if (!response.ok || !result.ok) throw new Error(result.error || 'The saved pipeline could not continue. Its checkpoint is preserved.')
        setRunWarn(result.yielded ? 'Progress saved. Remaining work is queued to continue.' : result.status === 'awaiting' ? 'Waiting for your review.' : null)
      } catch (error) {
        if (!controller.signal.aborted) setRunWarn(error instanceof Error ? error.message : 'Could not reach the saved pipeline. Check its activity before retrying.')
      } finally {
        controller.signal.removeEventListener('abort', stop)
        if (stopping) await stopping
        abortRef.current = null
        setRunning(null)
        await loadFromServer()
      }
      return
    }
    // Decisions belong to one run; memory is mutable only within this run snapshot.
    const f: Flow = { ...source, approvals: resume ? source.approvals : {}, memory: { ...(source.memory || {}) } }
    if (!resume) patchFlow(f.id, { approvals: {} })
    const t0 = resume && f.run?.startedAt ? f.run.startedAt : Date.now()
    const previous = resume ? runsRef.current.find((run) => run.flowId === f.id && run.startedAt === t0) : undefined
    const runId = previous?.id || uid()
    setRuns((rs) => previous
      ? rs.map((run) => run.id === runId ? { ...run, status: 'running', note: undefined, finishedAt: undefined } : run)
      : [{ id: runId, flowId: f.id, flowName: f.name, startedAt: t0, status: 'running' }, ...rs])
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
    const total = order.length
    // RESUME: a run interrupted by a hard refresh keeps every step it already
    // finished — seed those from the persisted results so we only run the rest.
    const results: Record<string, string> = resume ? { ...(f.results || {}) } : {}
    // Run-inspector capture: per-node input, final state, and duration.
    const snapInput: Record<string, string> = {}
    const snapState: Record<string, string> = {}
    const snapMs: Record<string, number> = {}
    const finished = new Set<string>(resume ? order.filter((id) => results[id] != null) : [])
    setStates(Object.fromEntries(f.nodes.map((n) => [n.id, finished.has(n.id) ? 'done' : order.includes(n.id) ? 'queued' : 'idle'])))
    setDurs({})
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const failedIds = new Set<string>()
    const stuckIds = new Set<string>()
    let firstError = ''
    const deps = new Map(f.nodes.map((n) => [n.id, f.edges.filter((e) => e.to === n.id).map((e) => e.from)]))
    // 10x control-flow: routers/filters CUT edges so only the taken branch runs;
    // cut branches are clean-skipped (cutIds) and DON'T mark the run as errored.
    const edgeKey = (from: string, to: string) => `${from}>${to}`
    const cutEdges = new Set<string>()
    // RESUME: rehydrate branch cuts made before the interruption. A router that
    // already ran is resume-skipped (its result is kept), so without this its cut
    // edges would be lost and the untaken branch would wrongly run.
    if (resume && Array.isArray(f.run?.cutEdges)) for (const k of f.run!.cutEdges!) cutEdges.add(k)
    const cutIds = new Set<string>()
    const liveDeps = (nid: string) => (deps.get(nid) || []).filter((d) => !cutEdges.has(edgeKey(d, nid)))
    const cutAllOut = (nid: string) => f.edges.filter((e) => e.from === nid).forEach((e) => cutEdges.add(edgeKey(e.from, e.to)))
    let paused = false
    routeRef.current = {}
    pausedRef.current = null
    const CONC = 3 // independent branches run in parallel (LLM-provider friendly)
    // Durable run record + incremental result save: the run survives a refresh
    // (completed steps persist) and its heartbeat lets another tab/the server
    // take over an orphaned run. Persisting is debounced by the sync layer.
    const persist = (status: FlowRun['status'], extra: Partial<FlowRun> = {}) =>
      patchFlow(f.id, () => ({
        results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.slice(0, 24000)])),
        ...(status !== 'running' ? { lastRun: Date.now() } : {}),
        run: { status, step: finished.size, total, startedAt: t0, updatedAt: Date.now(), heartbeat: Date.now(), error: firstError || undefined, cutEdges: [...cutEdges], ...extra },
      }))
    persist('running')
    const hb = setInterval(() => { if (!ctrl.signal.aborted) persist('running') }, HEARTBEAT_MS)
    try {
      // Independent branches run concurrently; safe operations retry with backoff.
      // Sends and mutations get one attempt so a lost acknowledgement cannot duplicate them.
      const execOne = async (nid: string) => {
          const node = f.nodes.find((n) => n.id === nid)
          if (!node) { finished.add(nid); return }
          setStates((st) => ({ ...st, [nid]: 'running' }))
          const input = liveDeps(nid).map((d) => results[d]).filter(Boolean).join('\n\n---\n\n')
          snapInput[nid] = input
          const started = Date.now()
          let lastErrMsg = '' // the real reason this node failed, shown on the node
          const maxAttempts = nodeAttemptLimit(node.type, node.method, MAX_NODE_ATTEMPTS)
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (ctrl.signal.aborted) break
            // Backoff BEFORE a retry (attempt 2+) so a transient blip clears — an
            // immediate retry usually just hits the same 429/5xx again.
            if (attempt > 1) {
              setLive((lv) => ({ ...lv, [nid]: `Attempt ${attempt}/${maxAttempts} (last: ${lastErrMsg || 'no output'}) — retrying…` }))
              await sleep(retryBackoffMs(attempt))
              if (ctrl.signal.aborted) break
            }
            // Per-step watchdog: its own controller aborts on run-stop OR timeout.
            const nodeCtrl = new AbortController()
            const onAbort = () => nodeCtrl.abort()
            ctrl.signal.addEventListener('abort', onAbort)
            let timedOut = false
            const timer = setTimeout(() => { timedOut = true; nodeCtrl.abort() }, NODE_TIMEOUT_MS)
            try {
              const out = await withAbort(runNode(node, input, f, nodeCtrl, manual, (t) => {
                if (!nodeCtrl.signal.aborted) setLive((lv) => ({ ...lv, [nid]: t }))
              }, (m) => {
                if (!nodeCtrl.signal.aborted) patchFlow(f.id, (cur) => ({ artifacts: { ...(cur.artifacts || {}), [nid]: m } }))
              }, `flow_${f.id}_${t0}`), nodeCtrl.signal)
              if (ctrl.signal.aborted || nodeCtrl.signal.aborted) throw new DOMException('Run stopped', 'AbortError')
              if (out) {
                // filter/approval STOP → cut this branch cleanly (skipped, not error)
                if (out === STOP_SENTINEL) {
                  cutAllOut(nid); cutIds.add(nid); finished.add(nid)
                  setStates((st) => ({ ...st, [nid]: 'skipped' }))
                  snapState[nid] = 'skipped'; snapMs[nid] = Date.now() - started
                  setDurs((d) => ({ ...d, [nid]: Date.now() - started }))
                  persist('running'); return
                }
                results[nid] = out.slice(0, 24000) // protect storage quota
                // Use the same unambiguous branch mapping as the server runner.
                if (node.type === 'router') {
                  const taken = routeRef.current[nid] || []
                  const brs = node.branches?.length ? node.branches : [{ label: 'A' }, { label: 'B' }]
                  const outgoing = f.edges.filter((e) => e.from === nid)
                  const labels = routerEdgeLabels(brs, outgoing)
                  if (taken.length !== 1) throw new Error('The router did not select exactly one branch.')
                  outgoing.forEach((e, i) => {
                    if (labels[i] !== taken[0]) cutEdges.add(edgeKey(e.from, e.to))
                  })
                }
                setStates((st) => ({ ...st, [nid]: 'done' }))
                snapState[nid] = 'done'; snapMs[nid] = Date.now() - started
                setDurs((d) => ({ ...d, [nid]: Date.now() - started }))
                finished.add(nid)
                persist('running') // durable checkpoint — survives a refresh
                return
              }
              throw new Error('empty result')
            } catch (e) {
              if (e instanceof AwaitingApproval) { paused = true; pausedRef.current = nid; setStates((st) => ({ ...st, [nid]: 'queued' })); return }
              if (ctrl.signal.aborted) break
              if (timedOut) {
                // Stuck/blocked → break this step now (no more retries).
                stuckIds.add(nid)
                firstError ||= `"${node.label}" got stuck (no result in ${Math.round(NODE_TIMEOUT_MS / 1000)}s)`
                setLive((lv) => ({ ...lv, [nid]: `Stuck — broke after ${Math.round(NODE_TIMEOUT_MS / 1000)}s. Downstream steps skipped.` }))
                break
              }
              lastErrMsg = e instanceof Error ? e.message : 'error'
              if (attempt === 1 && maxAttempts > 1) setLive((lv) => ({ ...lv, [nid]: `First attempt failed (${lastErrMsg}) — retrying…` }))
              else if (attempt === maxAttempts) { firstError ||= `"${node.label}" failed: ${lastErrMsg}` }
            } finally {
              clearTimeout(timer)
              ctrl.signal.removeEventListener('abort', onAbort)
            }
          }
          failedIds.add(nid)
          finished.add(nid)
          setStates((st) => ({ ...st, [nid]: ctrl.signal.aborted ? 'idle' : 'error' }))
          // Show the actual reason ON the node (not just in the run summary), so a
          // failure is never a mystery "queued → failed".
          if (!ctrl.signal.aborted && !stuckIds.has(nid)) setLive((lv) => ({ ...lv, [nid]: `Failed: ${lastErrMsg || 'the model returned nothing'}` }))
          snapState[nid] = stuckIds.has(nid) ? 'stuck' : ctrl.signal.aborted ? 'stopped' : 'error'; snapMs[nid] = Date.now() - started
          setDurs((d) => ({ ...d, [nid]: Date.now() - started }))
          persist('running')
        }
      await runGraph({
        order, edges: f.edges, finished, failed: failedIds, cut: cutIds, cutEdges,
        concurrency: CONC, shouldStop: () => paused || ctrl.signal.aborted, execute: execOne,
        skip: (nid, failed) => {
          setStates((st) => ({ ...st, [nid]: 'skipped' }))
          setLive((lv) => ({ ...lv, [nid]: failed ? 'Skipped — an upstream step failed.' : 'Skipped — this branch was not taken.' }))
          snapState[nid] = 'skipped'
        },
      })
      // Approval gate reached with no decision → park the run as "awaiting" and stop
      // cleanly; the user's Approve/Edit/Reject resumes it from here.
      if (paused && !ctrl.signal.aborted) {
        persist('awaiting', { node: pausedRef.current || undefined, nodeLabel: f.nodes.find((n) => n.id === pausedRef.current)?.label })
        setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, status: 'awaiting', note: 'awaiting approval' } : r)))
        return
      }
      setOutputs(listOutputs())
      const files = f.nodes.filter((n) => n.type !== 'agent' && results[n.id]).length
      const secs = Math.round((Date.now() - t0) / 1000)
      const stuck = stuckIds.size > 0
      const runStatus: FlowRun['status'] = ctrl.signal.aborted ? 'stopped' : stuck ? 'stuck' : failedIds.size ? 'error' : 'done'
      // Build the durable Run Inspector snapshot from this run.
      const snap: RunSnap = {
        id: runId, flowId: f.id, flowName: f.name, at: Date.now(), status: runStatus, ms: Date.now() - t0,
        nodes: Object.fromEntries(f.nodes.map((n) => [n.id, {
          label: n.label || nodeMeta(n).name, type: n.type,
          input: (snapInput[n.id] || '').slice(0, 8000),
          output: (results[n.id] || '').slice(0, 8000),
          state: snapState[n.id] || (results[n.id] ? 'done' : cutIds.has(n.id) ? 'skipped' : 'idle'),
          ms: snapMs[n.id] || 0,
        }])),
      }
      persist(runStatus, {})
      patchFlow(f.id, { snap })
      const listStatus: Run['status'] = ctrl.signal.aborted ? 'stopped' : failedIds.size || stuck ? 'error' : 'done'
      const failNote = stuck ? ` · ${stuckIds.size} stuck` : failedIds.size ? ` · ${failedIds.size} failed/skipped` : ''
      setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, finishedAt: Date.now(), status: listStatus, note: `${finished.size}/${total} steps · ${files} files · ${secs}s${failNote}` } : r)))
    } catch (error) {
      firstError ||= error instanceof Error ? error.message : 'The pipeline could not finish.'
      persist(ctrl.signal.aborted ? 'stopped' : 'error')
      setRunWarn(firstError)
      setRuns((rs) => rs.map((r) => r.id === runId ? { ...r, finishedAt: Date.now(), status: ctrl.signal.aborted ? 'stopped' : 'error', note: firstError } : r))
    } finally {
      clearInterval(hb)
      setRunning(null)
      abortRef.current = null
    }
  }, [flowId, patchFlow])

  // RESUME AFTER A HARD REFRESH: a run whose heartbeat went stale (its tab is
  // gone) is orphaned — pick it up where it left off and finish the rest. The
  // server cron does the same for tabs that never reopen, so a running pipeline
  // always continues unless it genuinely fails.
  const resumedRef = useRef(new Set<string>())
  useEffect(() => {
    const resumeOrphan = () => {
      if (abortRef.current) return
      const now = Date.now()
      const orphan = flowsRef.current.find(
        (f) => f.run?.status === 'running' && f.nodes.length > 0 && now - (f.run.heartbeat || 0) > RUN_STALE_MS && !resumedRef.current.has(`${f.id}:${f.run.startedAt}`),
      )
      if (orphan) {
        resumedRef.current.add(`${orphan.id}:${orphan.run?.startedAt}`)
        setFlowId(orphan.id)
        void runFlow(orphan, false, true)
      }
    }
    const t = setTimeout(resumeOrphan, 1800) // let server-hydrate settle first
    const interval = setInterval(resumeOrphan, 15_000)
    return () => { clearTimeout(t); clearInterval(interval) }
  }, [runFlow])

  // Approval decision → record it and RESUME the paused run from the gate.
  const resolveApproval = (nid: string, decision: 'approve' | 'edit' | 'reject') => {
    const f = flowsRef.current.find((x) => x.id === flowId)
    if (!f || f.run?.status !== 'awaiting' || f.run.node !== nid) return
    let text: string | undefined
    if (decision === 'edit') {
      const cur = f.edges.filter((e) => e.to === nid).map((e) => f.results?.[e.from]).filter(Boolean).join('\n')
      const t = window.prompt('Edit the content to continue with:', cur.slice(0, 2000))
      if (t == null) return
      text = t
    }
    const approvals = { ...(f.approvals || {}), [nid]: { decision, text, at: Date.now() } }
    // Server approvals travel atomically with the bound resume request; do not
    // race a stale whole-flow sync against its new completed checkpoint.
    if (!f.run.serverManaged) patchFlow(f.id, { approvals })
    const updated: Flow = { ...f, approvals }
    setTimeout(() => { if (!abortRef.current) void runFlow(updated, false, true) }, 60)
  }

  // ---- 10x: versioning, export/import, duplicate, webhook secret ----
  const snapshotVersion = (note: string) => {
    if (!flow) return
    const v: Version = { id: uid(), at: Date.now(), note, nodes: JSON.parse(JSON.stringify(flow.nodes)), edges: JSON.parse(JSON.stringify(flow.edges)) }
    patchFlow(flow.id, (f) => ({ versions: [v, ...(f.versions || [])].slice(0, 20) }))
    setCopied('Version saved'); setTimeout(() => setCopied(''), 1500)
  }
  const restoreVersion = (v: Version) => {
    if (!flow) return
    // Save the current state first so a rollback is itself reversible.
    snapshotVersion('before rollback')
    patchFlow(flow.id, { nodes: JSON.parse(JSON.stringify(v.nodes)), edges: JSON.parse(JSON.stringify(v.edges)) })
    setVersionsOpen(false)
  }
  const exportFlow = () => {
    if (!flow) return
    // Strip run state + secrets; export the reusable definition only.
    const { run: _run, results: _results, snap: _snap, apiSecret: _sec, approvals: _ap, ...clean } = flow
    void _run; void _results; void _snap; void _sec; void _ap
    const blob = new Blob([JSON.stringify({ nalu: 'autopilot-flow', v: 1, flow: { ...clean, enabled: false, apiEnabled: false } }, null, 2)], { type: 'application/json' })
    downloadBlobFile(blob, `${(flow.name || 'pipeline').replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'pipeline'}.nalu.json`)
  }
  const importFlow = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { flow?: Partial<Flow> } | Partial<Flow>
      const src = (parsed && typeof parsed === 'object' && 'flow' in parsed && parsed.flow ? parsed.flow : parsed) as Partial<Flow>
      if (!Array.isArray(src.nodes)) throw new Error('not a Nalu pipeline file')
      // Re-id everything so an import never collides with an existing flow/node.
      const idMap = new Map<string, string>()
      const nodes = (src.nodes as PNode[]).map((n) => { const nid = uid(); idMap.set(n.id, nid); return { ...n, id: nid } })
      const edges = (src.edges || []).map((e) => ({ ...e, from: idMap.get(e.from) || e.from, to: idMap.get(e.to) || e.to })).filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
      const nf: Flow = { id: uid(), name: `${src.name || 'Imported pipeline'}`, nodes, edges, schedule: (src.schedule as Schedule) || 'manual', time: src.time || '08:00', enabled: false, company: src.company, refDoc: src.refDoc, memory: src.memory }
      setFlows((prev) => [nf, ...prev]); setFlowId(nf.id)
      setCopied('Imported ✓'); setTimeout(() => setCopied(''), 1500)
    } catch (e) { alert(`Couldn't import: ${(e as Error).message}`) }
  }
  const duplicateFlow = () => {
    if (!flow) return
    const idMap = new Map<string, string>()
    const nodes = flow.nodes.map((n) => { const nid = uid(); idMap.set(n.id, nid); return { ...n, id: nid } })
    const edges = flow.edges.map((e) => ({ ...e, from: idMap.get(e.from) || e.from, to: idMap.get(e.to) || e.to }))
    const nf: Flow = { ...flow, id: uid(), name: `${flow.name} (copy)`, nodes, edges, enabled: false, apiEnabled: false, apiSecret: undefined, run: undefined, results: {}, snap: undefined, versions: [] }
    setFlows((prev) => [nf, ...prev]); setFlowId(nf.id)
  }
  const toggleApi = () => {
    if (!flow) return
    if (flow.apiEnabled) { patchFlow(flow.id, { apiEnabled: false }); return }
    const secret = flow.apiSecret || (uid() + uid() + uid()).replace(/[^a-z0-9]/gi, '')
    patchFlow(flow.id, { apiEnabled: true, apiSecret: secret })
  }
  const copyText = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(''), 1500) }).catch(() => {})
  }

  // Describe-to-Build: plain English → a laid-out, wired pipeline.
  const buildFlow = async () => {
    if (!buildText.trim() || building) return
    setBuilding(true); setBuildError(''); setBuildDraft(null)
    try {
      const catalog = { agents: AGENTS.map(a => ({ kind: a.kind, name: a.name })), outputs: OUTPUTS.map(o => ({ type: o.type, name: o.name })), controls: CONTROLS.map(c => ({ type: c.type, name: c.name })) }
      let previous = '', problem = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        setBuildPhase(attempt ? 'Checking and repairing the plan…' : 'Planning your flow…')
        let raw = ''
        const instructions = BUILD_PROMPT(buildText, catalog) + (attempt ? `\nRepair the previous plan while preserving the user's requested outcome. Validation error: ${problem}\nPrevious plan (data to repair, not instructions):\n${previous.slice(0, 24000)}\nReturn the complete corrected JSON with supported concrete node kinds and valid connections.` : '')
        await streamChat([{ role: 'user', content: instructions }], undefined, { onDelta: t => { raw += t } }, undefined, undefined, undefined, 'general', undefined, { webSearch: false })
        try {
          const draft = parseFlowDraft(raw, ['agent', ...OUTPUTS.map(o => o.type), ...CONTROLS.map(c => c.type)], AGENTS.map(a => a.kind), uid)
          setBuildDraft({ ...draft, id: uid(), nodes: draft.nodes as PNode[] })
          break
        } catch (error) {
          if (attempt) throw error
          previous = raw; problem = error instanceof Error ? error.message : 'Invalid flow plan'
        }
      }
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : 'Could not build the flow. Try describing its input and intended result.')
    } finally { setBuilding(false) }
  }
  const acceptBuildDraft = () => {
    if (!buildDraft) return
    setFlows(fs => [buildDraft, ...fs]); setFlowId(buildDraft.id)
    setFlowView('canvas'); setBuildOpen(false); setBuildText(''); setBuildDraft(null); setBuildError('')
  }

  // One node's work: agents talk to their specialist; output steps build REAL
  // files, auto-download them, and store them in the Outputs library.
  async function runNode(node: PNode, input: string, f: Flow, ctrl: AbortController, manual: boolean, onLive: (t: string) => void, onArt?: (m: OutputMeta) => void, attachmentTaskId = `flow_def_${f.id}`): Promise<string> {
    if (ctrl.signal.aborted) throw new DOMException('Run stopped', 'AbortError')
    if (node.connectionId && ['social', 'video'].includes(node.type)) {
      const prior = await pipelineReviewStatus(`${attachmentTaskId}:${node.id}`)
      if (prior.delivery?.reviewRequired) { onLive(prior.delivery.detail); setConnMgr(true); throw new AwaitingApproval(node.id) }
      if (prior.delivery) {
        if (!prior.delivery.ok) throw new Error(prior.delivery.detail)
        return `${prior.summary || node.label}\nDELIVERY: ${prior.delivery.detail}`
      }
    }
    node = { ...node, prompt: (node.prompt || '').replace(/\{\{\s*memory\.([\w.-]+)\s*\}\}/g, (_match, key: string) => f.memory?.[key] ?? '') }
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
      // A reference document the user attached to this pipeline — authoritative
      // context every agent should ground its work in.
      if (f.refDoc?.text?.trim()) {
        prompt = `${referenceDocumentContext(f.refDoc)}\n\n${prompt}`
      }
      // A reference attached to THIS individual — even more specific to their role.
      if (node.refDoc?.text?.trim()) {
        prompt = `${referenceDocumentContext(node.refDoc)}\n\n${prompt}`
      }
      prompt += '\n\n' + hedgeFundOutputContract(node.role)
      let out = ''
      let streamErr = ''
      const r = await streamChat([{ role: 'user', content: prompt }], undefined, {
        signal: ctrl.signal,
        onDelta: (t) => { out += t; onLive(out) },
        onError: (m) => { streamErr = m },
      }, undefined, undefined, undefined, node.agent, undefined, { webSearch: node.webSearch !== false, researchPrompt: (node.prompt || '').replace(/\{\{[^}]+\}\}/g, '').trim() })
      const result = out.trim() || r.text.trim()
      if (!result) throw new Error(streamErr || 'The model returned no answer.')
      return guardHedgeFundOutput(node.role, result, { policyText: node.refDoc?.text || f.refDoc?.text })
    }
    // ---- 10x: template expansion for {{input}} + {{memory.KEY}} in any node ----
    const tpl = (s: string) => (s || '')
      .split('{{input}}').join(input || '')
      .replace(/\{\{\s*memory\.([\w.-]+)\s*\}\}/g, (_m, k: string) => (f.memory?.[k] ?? ''))
    // ---- 10x: trigger node (root) — passes the incoming payload / a seed onward ----
    if (node.type === 'trigger') {
      return input || tpl(node.prompt).trim() || 'Triggered run'
    }
    // ---- 10x: Web search tool — real results feed downstream ----
    if (node.type === 'websearch') {
      const q = (tpl(node.prompt).trim() || input || node.label).slice(0, 300)
      onLive(`Searching the web for "${q}"…`)
      const rs = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'search', query: q }), signal: ctrl.signal })
      if (!rs.ok) throw new Error(`Web search failed (HTTP ${rs.status}).`)
      const d = (await rs.json().catch(() => ({}))) as { results?: { title?: string; url?: string; snippet?: string }[] }
      const res = Array.isArray(d.results) ? d.results.slice(0, 8) : []
      const text = res.map((x, i) => `${i + 1}. ${x.title || ''}\n   ${x.url || ''}\n   ${x.snippet || ''}`).join('\n\n')
      if (!text) throw new Error('No usable web results. Resume to retry this research step.')
      onLive(text)
      return `WEB SEARCH EXCERPTS for "${q}" — pages have not been read; verify claims before using them:\n\n${text}`
    }
    // ---- 10x: Read-a-URL tool — fetch + read a page into the flow ----
    if (node.type === 'fetchurl') {
      const url = (tpl(node.url || node.prompt) || input).match(/https?:\/\/[^\s"'<>]+/)?.[0] || ''
      if (!url) throw new Error('no URL to read — put one in the node')
      onLive(`Reading ${url}…`)
      const rs = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'fetch', url }), signal: ctrl.signal })
      if (!rs.ok) throw new Error(`Reading the page failed (HTTP ${rs.status}).`)
      const d = (await rs.json().catch(() => ({}))) as { text?: string; content?: string; markdown?: string; status?: string; error?: string; accessedAt?: string; publishedAt?: string }
      if (d.status === 'unavailable') throw new Error(d.error || 'The source could not be read.')
      const text = (d.text || d.markdown || d.content || '').slice(0, 12000)
      if (!text) throw new Error('page had no readable text')
      return `PAGE CONTENT — ${url} · Accessed ${d.accessedAt || 'unknown'} · Published ${d.publishedAt || 'unknown'}:\n\n${text}`
    }
    // ---- 10x: HTTP request tool — call any (CORS-enabled) API ----
    if (node.type === 'http') {
      const method = (node.method || 'GET').toUpperCase()
      const url = tpl(node.url || '').trim()
      if (!/^https?:\/\//.test(url)) throw new Error('HTTP node needs a full https:// URL')
      let headers: Record<string, string> = {}
      try { if (node.headers?.trim()) headers = JSON.parse(tpl(node.headers)) } catch { /* ignore bad header json */ }
      const body = method === 'GET' || method === 'HEAD' ? undefined : tpl(node.prompt || '') || input
      onLive(`${method} ${url}…`)
      const rs = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body, signal: ctrl.signal })
      const txt = (await rs.text().catch(() => '')).slice(0, 12000)
      onLive(`HTTP ${rs.status}`)
      if (!rs.ok) throw new Error(`HTTP ${rs.status} ${method} ${url}: ${txt.slice(0, 180)}`)
      return `HTTP ${rs.status} ${method} ${url}\n\n${txt}`
    }
    // ---- 10x: Memory node — persist values between runs ----
    if (node.type === 'memory') {
      const key = (node.memKey || 'value').trim()
      const op = node.memOp || 'set'
      if (op === 'get') { const v = f.memory?.[key] || ''; onLive(`memory.${key} = ${v.slice(0, 120)}`); return v || `(memory.${key} is empty)` }
      const val = (op === 'append' ? `${f.memory?.[key] || ''}\n${input}`.trim() : (input || tpl(node.prompt))).slice(0, 8000)
      f.memory = { ...(f.memory || {}), [key]: val }
      patchFlow(f.id, (cur) => ({ memory: { ...(cur.memory || {}), [key]: val } }))
      onLive(`Saved memory.${key}`)
      return input || val || `memory.${key} updated`
    }
    // ---- 10x: Router / Switch — decide which ONE branch takes the input ----
    if (node.type === 'router') {
      const branches = node.branches && node.branches.length ? node.branches : [{ label: 'A' }, { label: 'B' }]
      routerEdgeLabels(branches, f.edges.filter(edge => edge.from === node.id))
      let taken: string
      if ((node.routeBy || 'ai') === 'ai') {
        let pick = ''
        await streamChat([{ role: 'user', content: `Route the INPUT to EXACTLY ONE of these labels: ${branches.map((b) => b.label).join(' | ')}.${node.prompt ? ` Rule: ${node.prompt}` : ''}\nReply with ONLY the single best label, nothing else.\n\nINPUT:\n${(input || '(empty)').slice(0, 4000)}` }], undefined, { signal: ctrl.signal, onDelta: (t) => { pick += t } }, undefined, undefined, undefined, 'general', undefined, { webSearch: false })
        taken = selectFlowBranch(pick, branches)
      } else {
        taken = (branches.find((b) => evalCond('contains', b.cond, input)) || branches[branches.length - 1]).label
      }
      routeRef.current[node.id] = [taken]
      onLive(`→ took "${taken}"`)
      return input || `routed → ${taken}`
    }
    // ---- 10x: Filter / Gate — continue only when the condition passes ----
    if (node.type === 'filter') {
      let pass: boolean
      if ((node.condMode || 'notempty') === 'ai') {
        let ans = ''
        await streamChat([{ role: 'user', content: `Answer ONLY "yes" or "no". Condition: ${node.cond || node.prompt || 'is this worth continuing?'}\n\nINPUT:\n${(input || '').slice(0, 4000)}` }], undefined, { signal: ctrl.signal, onDelta: (t) => { ans += t } }, undefined, undefined, undefined, 'general', undefined, { webSearch: false })
        pass = parseFlowFilter(ans)
      } else pass = evalCond(node.condMode, node.cond, input)
      onLive(pass ? 'Passed ✓' : 'Stopped — condition not met')
      return pass ? (input || 'passed') : STOP_SENTINEL
    }
    // ---- 10x: Approval gate — pause for the user's decision ----
    if (node.type === 'approval') {
      const dec = f.approvals?.[node.id]
      if (!dec) {
        if (manual) onLive('⏸ Waiting for your approval…')
        if (node.connectionId) { try { await sendVia(node.connectionId, 'email', { to: node.to || '', subject: `Approve: ${node.label}`, body: (input || '').slice(0, 1500), text: (input || '').slice(0, 1500) }) } catch { /* */ } }
        throw new AwaitingApproval(node.id)
      }
      if (dec.decision === 'reject') { onLive('Rejected — stopped.'); return STOP_SENTINEL }
      if (dec.decision === 'edit') { onLive('Approved with edits.'); return dec.text || input }
      onLive('Approved ✓')
      return input || 'approved'
    }
    // ---- 10x: For-each (map) — split a list + run a step on EACH item, then join ----
    if (node.type === 'foreach') {
      const items = splitItems(input, node.splitBy).slice(0, Math.max(1, Math.min(24, node.maxItems || 20)))
      if (!items.length) return '(nothing to map over)'
      const itemPrompt = node.prompt?.trim() || 'Process this item:\n{{item}}'
      const outs: string[] = new Array(items.length).fill('')
      let done = 0
      const CONC = 4
      let idx = 0
      const worker = async () => {
        for (;;) {
          const i = idx++
          if (i >= items.length || ctrl.signal.aborted) return
          const p = itemPrompt.split('{{item}}').join(items[i]).split('{{input}}').join(items[i])
          let o = ''
          try {
            await streamChat([{ role: 'user', content: p }], undefined, { signal: ctrl.signal, onDelta: (t) => { o += t } }, undefined, undefined, undefined, node.agent || 'general', undefined, { webSearch: node.webSearch !== false, researchPrompt: (node.prompt || '').replace(/\{\{[^}]+\}\}/g, '').trim() })
          } catch (e) { throw new Error(`Item ${i + 1} failed: ${(e as Error).message}`) }
          if (!o.trim()) throw new Error(`Item ${i + 1} returned no output.`)
          outs[i] = o.trim()
          done++
          onLive(`Mapped ${done}/${items.length}…\n\n${outs.filter(Boolean).map((x, j) => `【${j + 1}】 ${x}`).join('\n\n')}`)
        }
      }
      const mapped = await Promise.allSettled(Array.from({ length: Math.min(CONC, items.length) }, worker))
      const failure = mapped.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw failure.reason
      return outs.map((x, i) => `【Item ${i + 1}】\n${x}`).join('\n\n---\n\n')
    }
    // ---- 10x: Autopilot Agent (planner) — plan → use tools → deliver, in a loop ----
    if (node.type === 'planner') {
      const goal = tpl(node.prompt).trim() || input || node.label
      const maxSteps = Math.max(1, Math.min(8, node.maxSteps || 4))
      const scratch: string[] = input ? [`CONTEXT PASSED IN:\n${input.slice(0, 4000)}`] : []
      for (let step = 0; step < maxSteps; step++) {
        onLive(`Planning (step ${step + 1}/${maxSteps})…${scratch.length ? '\n\n' + scratch.join('\n\n').slice(-3000) : ''}`)
        let raw = ''
        await streamChat([{ role: 'user', content: PLANNER_PROMPT(goal, scratch, step, maxSteps) }], undefined, { signal: ctrl.signal, onDelta: (t) => { raw += t } }, undefined, undefined, undefined, node.agent || 'general', undefined, { webSearch: false })
        const act = parsePlannerAction(raw)
        if (act.action === 'search') {
          onLive(`🔎 ${act.query}`)
          const rs = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'search', query: act.query.slice(0, 300) }), signal: ctrl.signal }).then(async r => { if (!r.ok) throw new Error('Planner search failed. Retry this step.'); return r.json() }) as { results?: { title?: string; url?: string; snippet?: string }[] }
          const txt = (rs.results || []).slice(0, 6).map((x, i) => `${i + 1}. ${x.title} — ${x.url}\n   ${x.snippet || ''}`).join('\n')
          scratch.push(`SEARCH EXCERPTS ONLY (pages not read) "${act.query}":\n${txt || '(no results)'}`)
        } else if (act.action === 'fetch') {
          onLive(`🌐 ${act.url}`)
          const rs = await fetch('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'fetch', url: act.url }), signal: ctrl.signal }).then(async r => { if (!r.ok) throw new Error('Planner page read failed. Retry this step.'); return r.json() }) as { status?: string; url?: string; text?: string; error?: string }
          scratch.push(`${rs.status === 'read' ? 'READ' : 'UNAVAILABLE'} ${rs.url || act.url}:\n${(rs.text || rs.error || 'Page not read. This is not evidence.').slice(0, 6500)}`)
        } else {
          const answer = act.answer
          onLive(answer)
          return answer.trim() || '(agent produced no output)'
        }
      }
      // Ran out of steps — synthesize a final answer from the scratchpad.
      let fin = ''
      await streamChat([{ role: 'user', content: `GOAL: ${goal}\n\nYou have gathered:\n${scratch.join('\n\n').slice(0, 12000)}\n\nNow write the best possible final deliverable for the goal. Output only the deliverable.` }], undefined, { signal: ctrl.signal, onDelta: (t) => { fin += t; onLive(fin) } }, undefined, undefined, undefined, node.agent || 'general', undefined, { webSearch: false })
      if (!fin.trim()) throw new Error('The planner returned no final deliverable.')
      return fin.trim()
    }
    if (node.type === 'email') {
      const to = node.to || ''
      const subject = node.subject || node.label || 'From Nalu Agents'
      let body = node.prompt.trim()
      if (body.includes('{{input}}')) body = body.split('{{input}}').join(input)
      else body = [body, input].filter(Boolean).join('\n\n')
      body = deSlopEmail(cleanSnippet(body)) // clean prose (no markdown) + strip AI filler
      const blob = buildEmlBlob(to, subject, body)
      const filename = `${subject.replace(/[^\w ]+/g, '').trim().slice(0, 40) || 'email'}.eml`
      downloadBlobFile(blob, filename)
      const emlMeta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, runId: attachmentTaskId, nodeId: node.id, kind: 'email', filename, size: blob.size, ts: Date.now() }
      await storeOutput(emlMeta, blob)
      onArt?.(emlMeta)
      // If a mail account is connected to this step, actually SEND it; otherwise
      // draft it (download + open your mail app) so nothing depends on a connection.
      let sent = ''
      let delivered = false
      if (node.connectionId && to) {
        const r = await sendPipelineVia(`${attachmentTaskId}:${node.id}`, node, 'email', { to, subject, body, text: body })
        if (!r.ok) throw new Error(`Email was not sent: ${r.detail}. The draft is saved in Outputs.`)
        delivered = true
        sent = ` — ${r.detail}`
      } else if (manual) {
        openMailto(to, subject, body)
      }
      onLive(`${node.connectionId && to ? 'Email' : 'Drafted'} "${subject}"${to ? ` to ${to}` : ''}${sent || ` — .eml saved to Outputs${manual ? '; opening your mail app' : ''}`}.`)
      return `EMAIL${delivered ? ' SENT' : ' DRAFTED'} — subject: ${subject}\n${body}`
    }
    // artifact output steps: build via the real generators, then export the file.
    onLive('Generating…')
    const brief = node.prompt.trim()
    // The reference doc(s) + company notes must shape the OUTPUT too (not just the
    // agent steps) — otherwise a flow's attached reference and hard rules silently
    // don't affect the generated deck/doc/sheet. Fold them in as leading context.
    const refCtx = [
      f.company?.notes?.trim() ? `HARD RULES for this output (follow exactly, they override defaults): ${f.company.notes.trim()}` : '',
      referenceDocumentContext(f.refDoc),
      referenceDocumentContext(node.refDoc),
    ].filter(Boolean).join('\n\n')
    const withCtx = (p: string) => (refCtx ? `${refCtx}\n\n${p}` : p)
    const material = input ? `\n\n--- THE MATERIAL (build the entire piece from this substance; keep its numbers and structure) ---\n${input.slice(0, 14000)}` : ''
    const safeName = (t: string, ext: string) => `${(t || node.label || 'output').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 48) || 'output'}.${ext}`
    const finish = async (blob: Blob, filename: string, kind: OutputMeta['kind'], passAlong: string) => {
      downloadBlobFile(blob, filename)
      const meta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, runId: attachmentTaskId, nodeId: node.id, kind, filename, size: blob.size, ts: Date.now() }
      await storeOutput(meta, blob)
      onArt?.(meta)
      onLive(`Created ${filename} — downloaded & saved to Outputs.`)
      return passAlong
    }
    if (node.type === 'doc' || node.type === 'pdf') {
      const r = await fetch('/api/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: withCtx((brief || `A polished document titled "${node.label}".`) + material), images: [] }), signal: ctrl.signal })
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
      const r = await fetch('/api/slides', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: withCtx((brief || `A polished presentation titled "${node.label}".`) + material) }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.slides)) throw new Error(d.error || 'slides failed')
      const { buildPptxBlob } = await import('./SlidesCard')
      const { blob, filename } = await buildPptxBlob(d)
      return finish(blob, filename, 'slides', textifyDeck(d))
    }
    if (node.type === 'sheet') {
      const r = await fetch('/api/sheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: withCtx((brief || `A useful workbook titled "${node.label}".`) + material) }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.sheets)) throw new Error(d.error || 'sheet failed')
      const { buildWorkbookBlob } = await import('./SheetCard')
      const blob = await buildWorkbookBlob(d, getBrand())
      return finish(blob, safeName(d.title, 'xlsx'), 'sheet', `WORKBOOK: ${d.title || node.label} — ${(d.sheets || []).map((s: { name?: string }) => s.name).join(', ')}`)
    }
    if (node.type === 'website') {
      const r = await fetch('/api/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: withCtx((brief || `A polished website for "${node.label}".`) + material), kind: 'webpage', brand: getBrand() || undefined }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !d.html) throw new Error(d.error || 'website failed')
      const blob = new Blob([d.html], { type: 'text/html' })
      return finish(blob, safeName(node.label, 'html'), 'website', `WEBSITE BUILT (${Math.round(d.html.length / 1024)}KB html): ${node.label}`)
    }
    if (node.type === 'image') {
      const token = getToken()
      const r = await fetch('/api/image', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ prompt: [brief, input.slice(0, 500)].filter(Boolean).join(' — ') || node.label }), signal: ctrl.signal })
      const d = await r.json()
      if (!r.ok || !d.url) throw new Error(d.error || 'image failed')
      const ir = await fetch(d.url, { signal: ctrl.signal })
      const blob = await ir.blob()
      if (!blob.type.startsWith('image/')) throw new Error('image did not resolve')
      return finish(blob, safeName(node.label, blob.type.includes('png') ? 'png' : 'jpg'), 'image', `IMAGE CREATED: ${node.label}`)
    }
    if (node.type === 'video') {
      // $0-first ladder: real MiniMax-H3 on the user's machine if running, else
      // the free cloud pool. Skip the in-browser recorder here — pipeline nodes
      // may run without a foreground canvas, where realtime capture is unreliable.
      const out = await generateVideo({ prompt: [brief, input.slice(0, 400)].filter(Boolean).join(' — ') || node.label, skipOnDevice: true, signal: ctrl.signal })
      const vr = await fetch(out.url, { signal: ctrl.signal })
      const blob = await vr.blob()
      const filename = safeName(node.label, 'mp4')
      const meta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, runId: attachmentTaskId, nodeId: node.id, kind: 'video', filename, size: blob.size, ts: Date.now() }
      await storeOutput(meta, blob); onArt?.(meta); downloadBlobFile(blob, filename)
      const summary = `VIDEO CREATED: ${node.label}`
      if (node.connectionId || node.webhook?.trim()) {
        const delivery = await sendPipelineVia(`${attachmentTaskId}:${node.id}`, node, 'post', { videoUrl: out.url, outputId: meta.id, filename, text: brief || node.label, resultSummary: summary })
        if (delivery.reviewRequired) { onLive(delivery.detail); setConnMgr(true); throw new AwaitingApproval(node.id) }
        if (!delivery.ok) throw new Error(`Video saved; publishing failed: ${delivery.detail}`)
        return `${summary}\nDELIVERY: ${delivery.detail}`
      }
      return summary
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
      const r = await fetch('/api/sheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: withCtx((brief || `A useful data table for "${node.label}".`) + material) }), signal: ctrl.signal })
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
      const body = markdownFileBody(brief, input, node.label)
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
        const vmeta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, runId: attachmentTaskId, nodeId: node.id, kind: 'video', filename: vfn, size: vb.size, ts: Date.now() }
        await storeOutput(vmeta, vb); onArt?.(vmeta)
        let pub = ''
        if (node.connectionId || node.webhook?.trim()) {
          const delivery = await sendPipelineVia(`${attachmentTaskId}:${node.id}`, node, 'post', { platform, type: 'video', videoUrl: vd.url, outputId: vmeta.id, filename: vfn, text: brief || node.label, resultSummary: `${platform.toUpperCase()} VIDEO POST — ${node.label}` })
          if (delivery.reviewRequired) { onLive(delivery.detail); setConnMgr(true); throw new AwaitingApproval(node.id) }
          if (!delivery.ok) throw new Error(`Video saved; publishing failed: ${delivery.detail}`)
          pub = ` · ${delivery.detail}`
        }
        onLive(`${platform} video post created${pub}.`)
        return `${platform.toUpperCase()} VIDEO POST — ${node.label}`
      }
      // build a platform-native carousel/post from the pipeline's material.
      // /api/design(carousel) returns STRUCTURED data (slides + theme + caption
      // + hashtags) — we render it to a self-contained .html artifact and pull
      // caption/hashtags straight from the fields (no fragile HTML scraping).
      const r = await fetch('/api/design', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Create a ${platform} post/carousel. ${brief || `Topic: ${node.label}.`}${material}`, kind: 'carousel', brand: getBrand() || undefined }),
        signal: ctrl.signal,
      })
      const d = await r.json()
      if (!r.ok || !Array.isArray(d.slides) || d.slides.length < 1) throw new Error(d.error || 'post failed')
      const { carouselToHtml } = await import('./CarouselCard')
      const html = carouselToHtml(d as import('./types').CarouselArt)
      const caption = String(d.caption || '').trim().slice(0, 2200)
      const tags = (Array.isArray(d.hashtags) ? d.hashtags : []).filter((t: unknown) => typeof t === 'string').slice(0, 12).join(' ')
      const firstImg = (d.slides.find((s: { img?: string }) => s && typeof s.img === 'string' && s.img) || {}).img || ''
      const blob = new Blob([html], { type: 'text/html' })
      const filename = safeName(`${platform}-${node.label}`, 'html')
      downloadBlobFile(blob, filename)
      const meta: OutputMeta = { id: uid(), flowId: f.id, flowName: f.name, nodeLabel: node.label, runId: attachmentTaskId, nodeId: node.id, kind: 'website', filename, size: blob.size, ts: Date.now() }
      await storeOutput(meta, blob)
      onArt?.(meta)
      // Save the draft before delivery. Failed delivery must fail the step;
      // the server records this run's attempt to prevent duplicate publishing.
      let published = ''
      if (node.connectionId || node.webhook?.trim()) {
        const r = await sendPipelineVia(`${attachmentTaskId}:${node.id}`, node, 'post', { platform, caption, hashtags: tags, image: firstImg, text: `${caption}\n\n${tags}`, filename, html })
        if (r.reviewRequired) { onLive(r.detail); setConnMgr(true); throw new AwaitingApproval(node.id) }
        if (!r.ok) throw new Error(`Post saved; publishing failed: ${r.detail}`)
        published = ` · ${r.detail}`
      }
      onLive(`${platform} post created${published}. Caption + ${tags.split(' ').filter(Boolean).length} hashtags ready.`)
      return `${platform.toUpperCase()} POST — ${node.label}\nCAPTION: ${caption}\nHASHTAGS: ${tags}`
    }
    if (node.type !== 'textfile') throw new Error(`Unsupported pipeline step: ${node.type}. Edit or rebuild this step.`)
    // textfile — the pipeline output as a clean .txt
    const body = textFileBody(brief.replace(/\{\{\s*memory\.([\w.-]+)\s*\}\}/g, (_m, key: string) => f.memory?.[key] ?? ''), input)
    const blob = new Blob([body], { type: 'text/plain' })
    return finish(blob, textFileName(node.label), 'text', body)
  }

  // Run ONE company member on their own clock: input = the latest stored
  // outputs of their upstream steps; their result is saved back to the flow.
  const runMember = useCallback(async (f: Flow, node: PNode) => {
    if (abortRef.current) return
    const runId = uid()
    setRuns((rs) => [{ id: runId, flowId: f.id, flowName: `${f.name} — ${node.label}`, startedAt: Date.now(), status: 'running' }, ...rs])
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, NODE_TIMEOUT_MS)
    setRunning(f.id)
    setStates((st) => ({ ...st, [node.id]: 'running' }))
    try {
      const input = f.edges.filter((e) => e.to === node.id).map((e) => f.results?.[e.from]).filter(Boolean).join('\n\n---\n\n')
      const out = await withAbort(runNode(node, input, f, ctrl, false, (t) => {
        if (!ctrl.signal.aborted) setLive((lv) => ({ ...lv, [node.id]: t }))
      }, (m) => {
        if (!ctrl.signal.aborted) patchFlow(f.id, (cur) => ({ artifacts: { ...(cur.artifacts || {}), [node.id]: m } }))
      }), ctrl.signal)
      if (ctrl.signal.aborted) throw new DOMException('Run stopped', 'AbortError')
      const day = new Date().toDateString()
      patchFlow(f.id, (cur) => ({
        results: { ...(cur.results || {}), [node.id]: out },
        lastRun: Date.now(),
        nodes: cur.nodes.map((n) => (n.id === node.id ? { ...n, lastRunDay: day } : n)),
      }))
      setStates((st) => ({ ...st, [node.id]: 'done' }))
      setOutputs(listOutputs())
      setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, finishedAt: Date.now(), status: 'done' } : r)))
    } catch (error) {
      const stopped = ctrl.signal.aborted && !timedOut
      const message = timedOut ? 'This step timed out. Please retry.' : stopped ? 'Stopped.' : error instanceof Error ? error.message : 'This step failed.'
      setLive((lv) => ({ ...lv, [node.id]: message }))
      setStates((st) => ({ ...st, [node.id]: stopped ? 'idle' : 'error' }))
      setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, finishedAt: Date.now(), status: stopped ? 'stopped' : 'error', note: message } : r)))
    } finally {
      clearTimeout(timer)
      setRunning(null)
      abortRef.current = null
    }
  }, [patchFlow])

  // ---- scheduler (runs while the app is open) ----
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      for (const f of flowsRef.current) {
        if (!f.enabled || f.schedule === 'manual' || !f.nodes.length || f.run?.status === 'awaiting' || f.run?.status === 'running') continue
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
        const due = isScheduleDue(f.schedule, f.time || '08:00', f.lastRun || 0, now, f.timeZone)
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
  const usePrebuiltPipeline = (key: string) => {
    const template = PREBUILT_PIPELINES.find(t => t.key === key)
    if (!template) return
    const built = template.build()
    const f: Flow = { ...built, nodes: arrangeAutopilotNodes(built.nodes, built.edges), enabled: false }
    setFlows(fs => [f, ...fs]); setFlowId(f.id); setStates({}); setLive({})
    setTemplatesOpen(false); setFlowView('canvas'); setRailOpen(false)
  }
  // One-click auto-poster: an idea agent → platform-native Social post, scheduled
  // daily. The user just sets the topic, the platform, and (optionally) a webhook.
  const newAutoPoster = () => {
    const f = buildAutoPosterFlow()
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
  // Nalu Hedge Fund model — a full AI investment committee for the given tickers:
  // persona + analytical agents + a real-time macro/events analyst feed the Risk
  // Manager and the Portfolio Manager, which writes the decision memo.
  const createHedgeFund = (name: string, tickers: string) => {
    const f = buildHedgeFundFlow(name, tickers)
    setFlows((fs) => [f, ...fs]); setFlowId(f.id); setStates({}); setLive({})
  }
  const createTemplate = (t: CompanyTemplate) => {
    const f = buildTemplateFlow(t)
    setFlows((fs) => [f, ...fs]); setFlowId(f.id); setStates({}); setLive({})
  }
  const deleteFlow = (fid: string) => {
    // Default pipelines are tombstoned on delete so they never re-seed anywhere.
    const gone = flowsRef.current.find((f) => f.id === fid)
    if (gone?.defaultKey) tombstoneFlowKey(gone.defaultKey)
    setFlows((fs) => { const next = fs.filter((f) => f.id !== fid); return next.length ? next : [{ ...starterFlow(), name: 'New pipeline' }] })
  }
  const redownload = async (m: OutputMeta) => {
    try {
      const blob = await getOutputBlob(m.id)
      if (!blob) throw new Error('This file is unavailable on this device. Open Outputs on the device that created it.')
      downloadBlobFile(blob, m.filename)
    } catch (error) { setRunWarn(error instanceof Error ? error.message : 'Could not download this output.') }
  }
  const removeOutput = async (m: OutputMeta) => {
    try { await deleteOutput(m.id); setOutputs(listOutputs()) }
    catch (error) { setRunWarn(error instanceof Error ? error.message : 'Could not delete this output.') }
  }

  const nodeResult = (nid: string) => live[nid] ?? flow?.results?.[nid] ?? ''
  const canvasSize = useMemo(() => layoutAutopilotConnections(flow?.nodes || [], flow?.edges || [], nodeSizes), [flow?.nodes, flow?.edges, nodeSizes])
  // Reset zoom SYNCHRONOUSLY when the pipeline changes, so a newly-opened flow never
  // flashes at the previous flow's manual zoom (a passive effect leaks for one frame).
  if (flowId !== prevFlowId) {
    setPrevFlowId(flowId)
    if (userZoom !== 1) setUserZoom(1)
    zoomAnchorRef.current = null
  }
  // AUTO-FIT: scale the pipeline down (never up) so it always fits the screen.
  const rawFit = Math.max(0.01, Math.min(1, viewSize.w / canvasSize.w, viewSize.h / canvasSize.h))
  // Effective scale = the user's zoom if they've set one, else the auto-fit.
  const effScale = userZoom == null ? rawFit : Math.max(ZMIN, Math.min(ZMAX, userZoom))
  fitScaleRef.current = effScale

  if (!flow) return null
  const expandedNode = expanded ? flow.nodes.find((n) => n.id === expanded) : null
  const KIND_ICON: Record<OutputMeta['kind'], LucideIcon> = { doc: FileText, pdf: FileText, slides: BarChart3, sheet: Table2, csv: Table2, email: Mail, website: FileText, image: FileText, video: FileText, text: FileText, calendar: Clock, mailrules: Mail, contacts: Mail }

  const renderNodeEditor = (n: PNode) => {
    const meta = nodeMeta(n)
    const st = states[n.id] || 'idle'
    const out = nodeResult(n.id)
    return (
      <div className="ap-step-editor">
        <div  className="flex cursor-grab touch-none items-center gap-2 rounded-t-xl border-b border-glass/[0.08] px-2.5 py-1.5 active:cursor-grabbing" style={{ background: `${meta.tint}12` }}>
          {n.type === 'agent' && n.role ? (
            <select aria-label="Role" value={n.roleTitle ? '__custom__' : n.role} onChange={(e) => {
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
            <select aria-label="Specialist" value={n.agent} onChange={(e) => patchNode(n.id, { agent: e.target.value })} onPointerDown={(e) => e.stopPropagation()}
              className="rounded bg-transparent text-[11.5px] font-medium text-ink outline-none">
              {AGENTS.map((a) => <option key={a.kind} value={a.kind} className="bg-panel2">{a.name}</option>)}
            </select>
          ) : isControl(n.type) ? (
            <span className="flex items-center gap-1 text-[11.5px] font-medium text-ink">
              {controlDef(n.type)?.name}
              <span className="text-dim">· {controlDef(n.type)?.group === 'trigger' ? 'trigger' : controlDef(n.type)?.group === 'logic' ? 'logic' : 'tool'}</span>
            </span>
          ) : (
            // output TYPE is pickable right on the step
            <span className="flex items-center gap-1 text-[11.5px] font-medium text-ink">
              <select aria-label="Output type" value={n.type} onChange={(e) => patchNode(n.id, { type: e.target.value as NodeType })} onPointerDown={(e) => e.stopPropagation()}
                className="rounded bg-transparent text-[11.5px] font-medium text-ink outline-none">
                {OUTPUTS.map((o) => <option key={o.type} value={o.type} className="bg-panel2">{o.name}</option>)}
              </select>
              <span className="text-dim">· output</span>
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {st === 'running' && <Loader2 size={11} className="animate-spin text-gold" />}
            {st === 'queued' && <Clock size={10} className="text-dim" />}
          </span>
        </div>
        <div className="p-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <input aria-label="Step name" value={n.label} onChange={(e) => patchNode(n.id, { label: e.target.value })} onPointerDown={(e) => e.stopPropagation()}
              title="Click to rename this agent"
              className="w-full flex-1 rounded border border-transparent bg-glass/[0.05] px-1.5 py-0.5 text-[12px] font-medium text-ink outline-none transition-colors placeholder:text-dim hover:border-glass/25 hover:bg-glass/[0.09] focus:border-gold/50 focus:bg-glass/[0.12]"
              placeholder={n.type === 'agent' ? 'Name this agent…' : 'Step name'} />
            {flow.schedule === 'members' && n.type === 'agent' && (
              <input type="time" value={n.time || ''} onChange={(e) => patchNode(n.id, { time: e.target.value })} onPointerDown={(e) => e.stopPropagation()} title="This member works at…"
                className="shrink-0 rounded bg-glass/[0.06] px-1 py-0.5 text-[10px] text-ink outline-none" />
            )}
          </div>
          {/* Prompt + Notes open focused modals, keeping the card centered on the live OUTPUT. */}
          <div className="mb-1.5 flex gap-1.5">
            <button onClick={(e) => { e.stopPropagation(); setNodeModal({ nodeId: n.id, tab: 'prompt' }) }} onPointerDown={(e) => e.stopPropagation()}
              title="Edit the prompt" className="flex flex-1 items-center gap-1.5 rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2 py-1.5 text-[11px] text-ink transition-colors hover:border-glass/25 hover:bg-glass/[0.08]">
              <MessageSquare size={11} className="shrink-0 text-gold" />
              <span className="flex-1 text-left font-medium">Prompt</span>
              {n.prompt?.trim() ? <CheckCircle2 size={11} className="shrink-0 text-emerald-300/80" /> : <span className="shrink-0 text-[9.5px] text-dim">empty</span>}
            </button>
            {n.type === 'agent' && (
              <button onClick={(e) => { e.stopPropagation(); setNodeModal({ nodeId: n.id, tab: 'notes' }) }} onPointerDown={(e) => e.stopPropagation()}
                title="Rules this agent must follow" className="flex flex-1 items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-500/[0.05] px-2 py-1.5 text-[11px] text-ink transition-colors hover:border-amber-400/45 hover:bg-amber-500/[0.1]">
                <FileText size={11} className="shrink-0 text-amber-300/90" />
                <span className="flex-1 text-left font-medium">Notes</span>
                {n.roleNotes?.trim() ? <CheckCircle2 size={11} className="shrink-0 text-emerald-300/80" /> : <span className="shrink-0 text-[9.5px] text-dim">empty</span>}
              </button>
            )}
          </div>
          {/* 10x control/tool node config */}
          {n.type === 'trigger' && (
            <select value={n.triggerKind || 'schedule'} onChange={(e) => patchNode(n.id, { triggerKind: e.target.value as PNode['triggerKind'] })} onPointerDown={(e) => e.stopPropagation()}
              className="mb-1.5 w-full rounded-lg bg-glass/[0.06] px-2 py-1.5 text-[11px] text-ink outline-none">
              <option value="schedule" className="bg-panel2">On the flow's schedule</option>
              <option value="webhook" className="bg-panel2">When a webhook / API call arrives</option>
              <option value="manual" className="bg-panel2">Manual / test only</option>
            </select>
          )}
          {n.type === 'router' && (
            <div className="mb-1.5 space-y-1" onPointerDown={(e) => e.stopPropagation()}>
              <select value={n.routeBy || 'ai'} onChange={(e) => patchNode(n.id, { routeBy: e.target.value as 'ai' | 'condition' })} className="w-full rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                <option value="ai" className="bg-panel2">AI decides which branch</option>
                <option value="condition" className="bg-panel2">By condition (text contains…)</option>
              </select>
              {(n.branches || []).map((b, bi) => (
                <div key={bi} className="flex items-center gap-1">
                  <input value={b.label} onChange={(e) => { const bs = [...(n.branches || [])]; bs[bi] = { ...bs[bi], label: e.target.value }; patchNode(n.id, { branches: bs }) }} placeholder="branch" className="w-20 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />
                  {n.routeBy === 'condition' && <input value={b.cond || ''} onChange={(e) => { const bs = [...(n.branches || [])]; bs[bi] = { ...bs[bi], cond: e.target.value }; patchNode(n.id, { branches: bs }) }} placeholder="contains…" className="min-w-0 flex-1 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />}
                  <button onClick={() => patchNode(n.id, { branches: (n.branches || []).filter((_, i) => i !== bi) })} className="shrink-0 text-dim hover:text-red-300"><X size={10} /></button>
                </div>
              ))}
              <button onClick={() => patchNode(n.id, { branches: [...(n.branches || []), { label: `branch ${(n.branches || []).length + 1}` }] })} className="text-[10px] text-gold hover:underline">+ branch</button>
              <div className="text-[9px] leading-tight text-dim">Wire this node's output to each branch's next step IN ORDER — edge 1 = branch 1.</div>
            </div>
          )}
          {n.type === 'filter' && (
            <div className="mb-1.5 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
              <select value={n.condMode || 'notempty'} onChange={(e) => patchNode(n.id, { condMode: e.target.value as PNode['condMode'] })} className="rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                <option value="notempty" className="bg-panel2">not empty</option>
                <option value="contains" className="bg-panel2">contains</option>
                <option value="gt" className="bg-panel2">number &gt;</option>
                <option value="lt" className="bg-panel2">number &lt;</option>
                <option value="ai" className="bg-panel2">AI yes/no</option>
              </select>
              {(n.condMode === 'contains' || n.condMode === 'gt' || n.condMode === 'lt' || n.condMode === 'ai') && (
                <input value={n.cond || ''} onChange={(e) => patchNode(n.id, { cond: e.target.value })} placeholder={n.condMode === 'ai' ? 'question…' : 'value…'} className="min-w-0 flex-1 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />
              )}
            </div>
          )}
          {(n.type === 'http' || n.type === 'fetchurl') && (
            <div className="mb-1.5 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
              {n.type === 'http' && (
                <select value={n.method || 'GET'} onChange={(e) => patchNode(n.id, { method: e.target.value })} className="rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m} className="bg-panel2">{m}</option>)}
                </select>
              )}
              <input value={n.url || ''} onChange={(e) => patchNode(n.id, { url: e.target.value })} placeholder="https://…  ({{input}} ok)" className="min-w-0 flex-1 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />
            </div>
          )}
          {n.type === 'memory' && (
            <div className="mb-1.5 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
              <select value={n.memOp || 'set'} onChange={(e) => patchNode(n.id, { memOp: e.target.value as PNode['memOp'] })} className="rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                <option value="set" className="bg-panel2">set</option>
                <option value="append" className="bg-panel2">append</option>
                <option value="get" className="bg-panel2">get</option>
              </select>
              <input value={n.memKey || ''} onChange={(e) => patchNode(n.id, { memKey: e.target.value })} placeholder="key name" className="min-w-0 flex-1 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />
            </div>
          )}
          {n.type === 'foreach' && (
            <div className="mb-1.5 space-y-1" onPointerDown={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-dim">split by</span>
                <select value={n.splitBy || 'lines'} onChange={(e) => patchNode(n.id, { splitBy: e.target.value as PNode['splitBy'] })} className="rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                  <option value="lines" className="bg-panel2">line</option>
                  <option value="numbered" className="bg-panel2">list item</option>
                  <option value="commas" className="bg-panel2">comma</option>
                  <option value="json" className="bg-panel2">JSON array</option>
                </select>
                <span className="ml-auto text-[10px] text-dim">max</span>
                <input type="number" min={1} max={50} value={n.maxItems ?? 20} onChange={(e) => patchNode(n.id, { maxItems: Math.max(1, Math.min(50, +e.target.value || 20)) })} className="w-12 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-dim">each →</span>
                <select value={n.agent || 'general'} onChange={(e) => patchNode(n.id, { agent: e.target.value })} className="min-w-0 flex-1 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                  {AGENTS.map((a) => <option key={a.kind} value={a.kind} className="bg-panel2">{a.name.replace('Nalu ', '')}</option>)}
                </select>
              </div>
              <div className="text-[9.5px] text-dim">Use <span className="font-mono text-ink">{'{{item}}'}</span> in the prompt below for each item.</div>
            </div>
          )}
          {n.type === 'planner' && (
            <div className="mb-1.5 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
              <span className="text-[10px] text-dim">brain</span>
              <select value={n.agent || 'general'} onChange={(e) => patchNode(n.id, { agent: e.target.value })} className="min-w-0 flex-1 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none">
                {AGENTS.map((a) => <option key={a.kind} value={a.kind} className="bg-panel2">{a.name.replace('Nalu ', '')}</option>)}
              </select>
              <span className="text-[10px] text-dim">steps</span>
              <input type="number" min={1} max={8} value={n.maxSteps ?? 4} onChange={(e) => patchNode(n.id, { maxSteps: Math.max(1, Math.min(8, +e.target.value || 4)) })} className="w-12 rounded bg-glass/[0.06] px-1.5 py-1 text-[11px] text-ink outline-none" />
            </div>
          )}
          {(n.type === 'agent' || n.type === 'foreach') && <label className="mb-2 flex items-center gap-2 px-1 text-xs text-ink"><input type="checkbox" checked={n.webSearch !== false} onChange={e => patchNode(n.id, { webSearch: e.target.checked })} /> Check the web for current facts</label>}
          {/* Per-individual reference — this agent's own source of truth. */}
          {n.type === 'agent' && (
            <button onClick={(e) => { e.stopPropagation(); nodeRefTarget.current = n.id; nodeRefInput.current?.click() }} onPointerDown={(e) => e.stopPropagation()}
              title="Attach a reference just for this agent" className="mb-1.5 flex w-full items-center gap-1.5 rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2 py-1.5 text-[11px] text-ink transition-colors hover:border-glass/25 hover:bg-glass/[0.08]">
              <Paperclip size={11} className="shrink-0 text-gold" />
              <span className="flex-1 truncate text-left font-medium" title={n.refDoc?.coverage}>{n.refDoc ? n.refDoc.name : 'Reference'}{n.refDoc?.coverage && <small className="block truncate text-[9px] font-normal text-dim">{n.refDoc.coverage}</small>}</span>
              {n.refDoc ? <span onClick={(e) => { e.stopPropagation(); patchNode(n.id, { refDoc: undefined }) }} className="shrink-0 text-dim hover:text-red-300"><X size={10} /></span> : <span className="shrink-0 text-[9.5px] text-dim">optional</span>}
            </button>
          )}
          {/* Publish/send through a saved Connection (Gmail, Instagram, LinkedIn…). */}
          {(n.type === 'social' || n.type === 'email' || n.type === 'video') && (
            <div className="mb-1.5 flex items-center gap-1.5 rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2 py-1" onPointerDown={(e) => e.stopPropagation()}>
              <Plug size={11} className="shrink-0 text-gold" />
              <select value={n.connectionId || ''}
                onChange={(e) => { if (e.target.value === '__connect__') { setConnMgr(true); loadConns() } else { const selected = conns.find(c => c.id === e.target.value); patchNode(n.id, { connectionId: e.target.value || undefined, ...(n.type === 'social' && selected?.app === 'tiktok' && selected.method !== 'webhook' && selected.method !== 'endpoint' ? { format: 'video', platform: 'TikTok' } : {}) }) } }}
                className="min-w-0 flex-1 rounded bg-transparent text-[10.5px] text-ink outline-none">
                <option value="" className="bg-panel2">{n.type === 'email' ? 'Draft only (no send)' : 'Save only (no publish)'}</option>
                {conns.filter((c) => c.id === n.connectionId || (n.type === 'email' ? appDef(c.app).kind === 'email' : appDef(c.app).kind !== 'email' && (n.type !== 'video' || c.meta.capabilities?.includes('video') || ['webhook', 'endpoint'].includes(c.method)))).map((c) => <option key={c.id} value={c.id} disabled={c.status !== 'connected'} className="bg-panel2">{n.type === 'email' ? 'Send with' : 'Publish to'} {c.label}{c.status !== 'connected' ? ' · Finish setup' : ''}</option>)}
                <option value="__connect__" className="bg-panel2">＋ Connect an app…</option>
              </select>
            </div>
          )}
          {flow.artifacts?.[n.id] && (
            <button onClick={() => void redownload(flow.artifacts![n.id])} onPointerDown={(e) => e.stopPropagation()}
              title="Download this file again"
              className="mb-1.5 flex w-full items-center gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2 py-1.5 text-left transition-colors hover:bg-emerald-500/20">
              <Download size={11} className="shrink-0 text-emerald-300" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">{flow.artifacts[n.id].filename}</span>
              <span className="shrink-0 text-[9.5px] tabular-nums text-dim">{Math.max(1, Math.round(flow.artifacts[n.id].size / 1024))} KB</span>
            </button>
          )}
          {/* Keep the step's saved result available beside its configuration. */}
          <div className={`rounded-lg border bg-black/30 p-2 transition-colors ${st === 'running' ? 'border-accent/45' : st === 'error' ? 'border-red-400/30' : 'border-glass/[0.08]'}`}>
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-dim">
                {st === 'running' && <Loader2 size={9} className="animate-spin text-gold" />}
                Output{durs[n.id] ? ` · ${Math.max(1, Math.round(durs[n.id] / 1000))}s` : ''}{st === 'skipped' ? ' · skipped' : st === 'error' ? ' · failed' : st === 'done' ? ' · done' : ''}
              </span>
              {out && <button onClick={(e) => { e.stopPropagation(); setExpanded(n.id) }} onPointerDown={(e) => e.stopPropagation()} className="flex items-center gap-1 text-[10px] text-gold hover:text-ink"><Maximize2 size={9} /> Expand</button>}
            </div>
            {/* Auto-FOLLOW the stream, but only while the reader is still pinned near
                the bottom — so scrolling up to re-read (or selecting text) mid-run isn't
                yanked back. rAF defers the write out of React's commit (no forced reflow). */}
            <div ref={(el) => { if (el && st === 'running') requestAnimationFrame(() => { if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight }) }} onPointerDown={(e) => e.stopPropagation()}
              className="max-h-56 min-h-[3.25rem] touch-auto select-text overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink/85 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {out ? cleanSnippet(out).slice(-4000) : <span className="text-dim">{st === 'running' ? 'Working…' : st === 'queued' ? 'Queued — waiting on inputs…' : 'Runs here when you press Run.'}</span>}
            </div>
          </div>
          <button className="ap-delete-step" onClick={() => removeNode(n.id)}><Trash2 size={15} />Delete step</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ap-workspace flex flex-1 overflow-hidden">
      {/* ---- left rail: flows / runs / outputs ---- */}
      {railOpen && <button className="ap-rail-backdrop" aria-label="Dismiss workflows" onClick={() => setRailOpen(false)} />}
      {railOpen && (
        <div className="ap-rail flex flex-col">
          <div className="ap-rail-header">Your workflows<button aria-label="Close workflows" onClick={() => setRailOpen(false)}><X size={18} /></button></div>
          <button onClick={() => { setConnMgr(true); loadConns() }} title="Connect your apps — Gmail, LinkedIn, Instagram and more"
            className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-glass/[0.1] bg-glass/[0.05] px-2.5 py-1.5 text-left hover:bg-glass/[0.1]">
            <Plug size={13} className="shrink-0 text-gold" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">Connections</span>
            <span className="shrink-0 rounded-full bg-glass/[0.12] px-1.5 text-[10px] text-dim">{conns.length}</span>
          </button>
          <div className="flex items-center justify-between px-3 pb-1 pt-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-dim">Pipelines</span>
            <div className="relative">
              <button onClick={() => setNewMenu((v) => !v)} title="New pipeline — build anything" className="flex h-6 w-6 items-center justify-center rounded-md text-gold hover:bg-glass/10"><Plus size={14} /></button>
              {newMenu && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setNewMenu(false)} />
                  <div className="absolute right-0 top-7 z-40 w-56 overflow-hidden rounded-xl border border-glass/[0.14] bg-panel2 py-1 shadow-xl">
                    <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-dim">New pipeline</div>
                    <button onClick={() => { newFlow(); setNewMenu(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]"><span className="block text-[12px] font-medium text-gold">Blank pipeline</span><span className="block text-[10px] text-dim">Start empty — drag in any models, roles or outputs</span></button>
                    <div className="my-1 border-t border-glass/[0.08]" />
                    <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-dim">Start from a template</div>
                    <button onClick={() => { setCoSetup({ name: '', what: '', mission: '', notes: '' }); setNewMenu(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]"><span className="block text-[12px] text-ink">Company</span><span className="block text-[10px] text-dim">A full baseline team (CEO, COO, CFO…)</span></button>
                    <button onClick={() => { setHfSetup({ name: 'Nalu Hedge Fund', tickers: '' }); setNewMenu(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]"><span className="block text-[12px] text-ink">Nalu Hedge Fund</span><span className="block text-[10px] text-dim">A full AI investment committee</span></button>
                    {COMPANY_TEMPLATES.map((t) => (
                      <button key={t.key} onClick={() => { createTemplate(t); setNewMenu(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]"><span className="block text-[12px] text-ink">{t.name}</span><span className="block text-[10px] text-dim">{t.blurb}</span></button>
                    ))}
                    <button onClick={() => { newAutoPoster(); setNewMenu(false) }} className="block w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]"><span className="block text-[12px] text-ink">Auto-poster</span><span className="block text-[10px] text-dim">Daily social posts on a schedule</span></button>
                  </div>
                </>
              )}
            </div>
          </div>
          {flows.map((f) => (
            <div key={f.id} className={`group mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${f.id === flow.id ? 'bg-accent/12 text-gold' : 'text-ink hover:bg-glass/[0.06]'}`}>
              <button onClick={() => { setFlowId(f.id); setStates({}); setLive({}); if (window.innerWidth <= 1100) setRailOpen(false) }} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {running === f.id && <Loader2 size={12} className="shrink-0 animate-spin text-gold" />}
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </button>
              {f.enabled && f.schedule !== 'manual' && <Clock size={10} className="shrink-0 text-emerald-300" />}
              <button onClick={() => deleteFlow(f.id)} className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:text-red-300 group-hover:flex"><Trash2 size={11} /></button>
            </div>
          ))}

          <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-dim">Runs</div>
          {runs.length === 0 && <div className="px-4 py-1 text-[11px] text-dim">Nothing has run yet.</div>}
          {(runsExpanded ? runs : runs.slice(0, RUNS_PREVIEW)).map((r) => (
            <div key={r.id} className="mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink">
              {r.status === 'running' ? <Loader2 size={12} className="shrink-0 animate-spin text-gold" />
                : r.status === 'awaiting' ? <ShieldCheck size={12} className="shrink-0 text-emerald-300" />
                : r.status === 'done' ? <CheckCircle2 size={12} className="shrink-0 text-emerald-300" />
                : <XCircle size={12} className="shrink-0 text-red-300" />}
              <span className="min-w-0 flex-1 truncate">{r.flowName}</span>
              <span className="shrink-0 text-[10px] text-dim">{new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}
          {runs.length > RUNS_PREVIEW && (
            <button onClick={() => setRunsExpanded((v) => !v)} className="mx-2 mt-0.5 flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-gold hover:bg-glass/[0.06]">
              {runsExpanded ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> Show all {runs.length} runs</>}
            </button>
          )}

          <div className="flex items-center justify-between px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-dim">Outputs
            <button onClick={() => void loadSavedOutputs()} title="Refresh saved outputs" aria-label="Refresh saved outputs" className="p-1 hover:text-gold"><RefreshCw size={12} /></button>
          </div>
          {outputError && <div role="status" className="px-4 py-1 text-[11px] text-amber-200">{outputError}</div>}
          {outputs.length === 0 && <div className="px-4 py-1 pb-4 text-[11px] text-dim">Files your pipelines create land here (and in Downloads).</div>}
          {(outputsExpanded ? outputs : outputs.slice(0, 10)).map((m) => {
            const I = KIND_ICON[m.kind] || FileText
            return (
              <div key={m.id} className="group mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-ink hover:bg-glass/[0.06]">
                <I size={12} className="shrink-0 text-dim" />
                <button onClick={() => void redownload(m)} title="Download again" className="min-w-0 flex-1 truncate text-left hover:text-gold">{m.filename}</button>
                <button onClick={() => void redownload(m)} className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:text-gold group-hover:flex"><Download size={11} /></button>
                <button onClick={() => void removeOutput(m)} title={`Delete ${m.filename}`} aria-label={`Delete ${m.filename}`}  className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:text-red-300 group-hover:flex"><Trash2 size={11} /></button>
              </div>
            )
          })}
          {outputs.length > 10 && <button onClick={() => setOutputsExpanded((value) => !value)} className="mx-4 py-1 text-left text-[11px] text-gold">{outputsExpanded ? 'Show fewer outputs' : `Show all ${outputs.length} outputs`}</button>}
          <details className="mt-auto"><summary>Activity & team</summary><RemoteTaskActivity readToken={getToken} /><TeamDirectory readToken={getToken} /></details>
          <div className="px-4 py-3 text-[10px] leading-relaxed text-dim">Text files from background runs are saved to your account. Browser-created files are saved on this device. Outputs shows your 60 newest files.</div>
        </div>
      )}

      {/* ---- main column ---- */}
      <div className="ap-main flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Main actions stay visible; configuration and secondary actions have their own menus. */}
        <div className="ap-toolbar">
          <button onClick={() => setRailOpen((v) => !v)} aria-label="Your workflows" aria-expanded={railOpen} title="Your saved pipelines" className="flex h-8 shrink-0 items-center justify-center gap-2 rounded-lg text-dim hover:bg-glass/10 hover:text-ink"><PanelLeft size={15} /><span>Pipelines</span></button>
          <div className="ap-title"><span>Autopilot workflow</span><input aria-label="Workflow name" value={flow.name} onChange={e => patchFlow(flow.id, { name: e.target.value })} placeholder="Name your workflow" /></div>
          <button className="ap-build" onClick={() => setBuildOpen(true)}><Wand2 size={17} />Build with AI</button>

          {/* hidden file inputs (reference doc for flow / per-agent, and import) */}
          <input ref={refDocInput} type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.xml,.log,.tsv,.yaml,.yml,.pdf,.docx,.xlsx,.pptx,text/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onRefDocFile(f); e.target.value = '' }} />
          <input ref={nodeRefInput} type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.xml,.log,.tsv,.yaml,.yml,.pdf,.docx,.xlsx,.pptx,text/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onNodeRefFile(f); e.target.value = '' }} />
          <input ref={importInput} type="file" accept=".json,application/json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFlow(f); e.target.value = '' }} />

          {/* ── ＋ Add — one menu for models, company roles, steps/tools, outputs, and Build-with-AI ── */}
          <div className="ap-add relative shrink-0">
            <button aria-label="Add" onClick={() => setAddMenu(addMenu ? false : 'add')}
              className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12.5px] hover:bg-glass/[0.12] ${addMenu ? 'bg-glass/[0.12] text-ink' : 'bg-glass/[0.07] text-ink'}`}>
              <Plus size={15} className="text-gold" /> <span>Add step</span>
            </button>
            {addMenu === 'add' && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setAddMenu(false)} />
                <div className="ap-toolbar-menu fixed inset-x-2 top-[3.25rem] z-40 w-auto overflow-hidden rounded-xl border border-glass/[0.14] bg-panel2 shadow-2xl sm:absolute sm:inset-x-auto sm:left-0 sm:top-10 sm:w-72 sm:max-w-[86vw]">
                  <button onClick={() => { setBuildOpen(true); setAddMenu(false) }} className="flex w-full items-center gap-2 border-b border-glass/[0.08] bg-accent/[0.08] px-3 py-2 text-left hover:bg-accent/[0.16]">
                    <Wand2 size={14} className="shrink-0 text-accent" />
                    <span className="min-w-0"><span className="block text-[12.5px] font-semibold text-accent">Build with AI</span><span className="block truncate text-[10px] text-dim">Describe it — Nalu wires the whole pipeline</span></span>
                  </button>
                  <div className="flex gap-0.5 border-b border-glass/[0.08] p-1">
                    {([['model', 'Models'], ['company', 'Roles'], ['blocks', 'Steps']] as const).map(([k, label]) => (
                      <button key={k} onClick={() => setAddTab(k)} className={`flex-1 rounded-md px-2 py-1 text-[11.5px] font-medium ${addTab === k ? 'bg-glass/15 text-ink' : 'text-dim hover:text-ink'}`}>{label}</button>
                    ))}
                  </div>
                  <div className="max-h-[min(60vh,22rem)] overflow-y-auto py-1">
                    {addTab === 'model' && AGENTS.map((a) => (
                      <button key={a.kind} onClick={() => { addNode('agent', a.kind); setAddMenu(false) }} className="w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                        <span className="block text-[12px] text-ink">{a.name}</span><span className="block truncate text-[10px] text-dim">{a.desc}</span>
                      </button>
                    ))}
                    {addTab === 'company' && (
                      <>
                        <button onClick={() => { const t = window.prompt('Name the new role (e.g. "VP of Partnerships")'); if (t && t.trim()) { addNode('agent', 'general', undefined, t.trim()); setAddMenu(false) } }}
                          className="w-full border-b border-glass/[0.08] px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                          <span className="block text-[12px] font-semibold text-gold">＋ New role…</span><span className="block truncate text-[10px] text-dim">Name it, then give it working notes</span>
                        </button>
                        {COMPANY_ROLES.map((r) => (
                          <button key={r.key} onClick={() => { addNode('agent', r.engine, r.key); setAddMenu(false) }} className="w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                            <span className="block text-[12px] text-ink">{r.title}</span><span className="block truncate text-[10px] text-dim">{r.desc}</span>
                          </button>
                        ))}
                        <div className="mt-1 border-t border-glass/[0.08] px-3 py-1 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-dim">Nalu Hedge Fund</div>
                        {HEDGE_FUND_ROLES.map((r) => (
                          <button key={r.key} onClick={() => { addNode('agent', r.engine, r.key); setAddMenu(false) }} className="w-full px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                            <span className="block text-[12px] text-ink">{r.title}</span><span className="block truncate text-[10px] text-dim">{r.desc}</span>
                          </button>
                        ))}
                      </>
                    )}
                    {addTab === 'blocks' && (
                      <>
                        {(['trigger', 'logic', 'tool'] as ControlGroup[]).map((g) => (
                          <div key={g}>
                            <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-dim">{g === 'trigger' ? 'Trigger' : g === 'logic' ? 'Control flow' : 'Tools & actions'}</div>
                            {CONTROLS.filter((c) => c.group === g).map((c) => (
                              <button key={c.type} onClick={() => { addNode(c.type); setAddMenu(false) }} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                                <c.icon size={13} className="mt-0.5 shrink-0" style={{ color: c.tint }} />
                                <span className="min-w-0"><span className="block text-[12px] text-ink">{c.name}</span><span className="block truncate text-[10px] text-dim">{c.desc}</span></span>
                              </button>
                            ))}
                          </div>
                        ))}
                        <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-dim">Output files</div>
                        {OUTPUTS.map((o) => (
                          <button key={o.type} onClick={() => { addNode(o.type); setAddMenu(false) }} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-glass/[0.08]">
                            <o.icon size={13} className="mt-0.5 shrink-0" style={{ color: o.tint }} />
                            <span className="min-w-0"><span className="block text-[12px] text-ink">{o.name}</span><span className="block truncate text-[10px] text-dim">{o.desc}</span></span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── ⚙ Settings — output, schedule, on/off, reference doc, company notes ── */}
          <div className="relative shrink-0">
            <button onClick={() => setSettingsOpen((v) => !v)} aria-label="Workflow settings" title="Schedule and workflow settings"
              className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12.5px] hover:bg-glass/[0.12] ${settingsOpen ? 'bg-glass/[0.12] text-ink' : 'bg-glass/[0.07] text-ink'}`}>
              <Settings2 size={15} className={flow.enabled && flow.schedule !== 'manual' ? 'text-emerald-300' : 'text-dim'} />
              <span className="hidden text-[12px] md:inline">{flow.schedule === 'manual' ? 'Manual' : flow.schedule === 'members' ? 'Members' : flow.schedule[0].toUpperCase() + flow.schedule.slice(1)}</span>
            </button>
            {settingsOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} />
                <div className="ap-toolbar-menu fixed inset-x-2 top-[3.25rem] z-40 max-h-[80vh] w-auto space-y-2.5 overflow-y-auto rounded-xl border border-glass/[0.14] bg-panel2 p-3 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-10 sm:max-h-none sm:w-72 sm:max-w-[86vw]">
                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">Produces</label>
                    <select aria-label="Workflow output" value={flowOutput} onChange={(e) => setFlowOutput(e.target.value as NodeType | 'none')}
                      className="w-full rounded-lg bg-glass/[0.07] px-2 py-1.5 text-[12.5px] text-ink outline-none">
                      <option value="none" className="bg-panel2">Text</option>
                      {OUTPUTS.map((o) => <option key={o.type} value={o.type} className="bg-panel2">{o.name}</option>)}
                    </select>
                  </div>
                  {validateFlow(flow).warnings.filter(w => w.startsWith('Keep Nalu open')).map(w => <p key={w} className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-200">{w}</p>)}
                  <div>
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">Schedule</label>
                    <div className="flex gap-1.5">
                      <select aria-label="Workflow schedule" value={flow.schedule} onChange={(e) => patchFlow(flow.id, { schedule: e.target.value as Schedule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
                        className="min-w-0 flex-1 rounded-lg bg-glass/[0.07] px-2 py-1.5 text-[12.5px] text-ink outline-none">
                        <option value="manual" className="bg-panel2">Run manually</option>
                        <option value="hourly" className="bg-panel2">Hourly</option>
                        <option value="daily" className="bg-panel2">Daily</option>
                        <option value="weekly" className="bg-panel2">Weekly (Mon)</option>
                        <option value="continuous" className="bg-panel2">24/7 — self-sustaining</option>
                        <option value="members" className="bg-panel2">Per-member times</option>
                      </select>
                      {(flow.schedule === 'daily' || flow.schedule === 'weekly') && (
                        <input aria-label="Scheduled time" type="time" value={flow.time} onChange={(e) => patchFlow(flow.id, { time: e.target.value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
                          className="rounded-lg bg-glass/[0.07] px-2 py-1.5 text-[12.5px] text-ink outline-none" />
                      )}
                    </div>
                    {flow.schedule !== 'manual' && (
                      <button onClick={() => patchFlow(flow.id, { enabled: !flow.enabled, timeZone: flow.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone })}
                        className={`mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium ${flow.enabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-glass/[0.07] text-dim'}`}>
                        <Power size={13} /> {flow.enabled ? 'Scheduling is ON' : 'Scheduling is OFF'}
                      </button>
                    )}
                  </div>
                  <div className="border-t border-glass/[0.08] pt-2.5">
                    <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">Reference doc <span className="normal-case tracking-normal text-dim/60">— every agent sees it</span></label>
                    {flow.refDoc ? (
                      <div className="flex items-center gap-1.5 rounded-lg bg-gold/15 px-2.5 py-1.5 text-[12px] text-ink" title={flow.refDoc.name}>
                        <Paperclip size={12} className="shrink-0 text-gold" />
                        <span className="min-w-0 flex-1 truncate" title={flow.refDoc.coverage}>{flow.refDoc.name}{flow.refDoc.coverage && <small className="block truncate text-[10px] text-dim">{flow.refDoc.coverage}</small>}</span>
                        <button onClick={() => patchFlow(flow.id, { refDoc: undefined })} title="Remove" className="shrink-0 text-dim hover:text-red-300"><X size={12} /></button>
                      </div>
                    ) : (
                      <button onClick={() => refDocInput.current?.click()} className="flex w-full items-center gap-1.5 rounded-lg bg-glass/[0.07] px-2.5 py-1.5 text-[12px] text-ink hover:bg-glass/[0.12]">
                        <Paperclip size={13} className="text-gold" /> Attach a document…
                      </button>
                    )}
                  </div>
                  {flow.company && (
                    <button onClick={() => { setCoNotesOpen((v) => !v); setSettingsOpen(false) }}
                      className={`flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] ${flow.company.notes ? 'bg-amber-500/15 text-amber-200' : 'bg-glass/[0.07] text-ink'} hover:brightness-110`}>
                      <FileText size={13} /> Company notes {flow.company.notes ? '· set' : ''}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── ⋯ More — inspector, webhook, versions, export/import, duplicate ── */}
          <div className="relative shrink-0">
            <button onClick={() => setMoreOpen((v) => !v)} aria-label="More workflow actions" title="More workflow actions"
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-glass/[0.12] hover:text-ink ${flow.apiEnabled ? 'text-sky-300' : ''} ${moreOpen ? 'bg-glass/[0.12]' : 'bg-glass/[0.07]'}`}><MoreHorizontal size={16} /></button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                <div className="ap-toolbar-menu fixed inset-x-2 top-[3.25rem] z-40 w-auto overflow-hidden rounded-xl border border-glass/[0.14] bg-panel2 py-1 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-10 sm:w-56">
                  <button onClick={() => { setInspectOpen(true); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><ListTree size={13} className="text-dim" /> Run inspector</button>
                  <button onClick={() => { setApiOpen(true); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><Webhook size={13} className={flow.apiEnabled ? 'text-sky-300' : 'text-dim'} /> Webhook / API{flow.apiEnabled ? ' · live' : ''}</button>
                  <div className="my-1 border-t border-glass/[0.08]" />
                  <button onClick={() => { snapshotVersion('manual save'); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><History size={13} className="text-dim" /> Save a version</button>
                  <button onClick={() => { setVersionsOpen(true); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><History size={13} className="text-dim" /> Version history{flow.versions?.length ? ` (${flow.versions.length})` : ''}</button>
                  <div className="my-1 border-t border-glass/[0.08]" />
                  <button onClick={() => { exportFlow(); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><Download size={13} className="text-dim" /> Export (.json)</button>
                  <button onClick={() => { importInput.current?.click(); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><Upload size={13} className="text-dim" /> Import a pipeline…</button>
                  <button onClick={() => { duplicateFlow(); setMoreOpen(false) }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-glass/[0.08]"><Copy size={13} className="text-dim" /> Duplicate</button>
                </div>
              </>
            )}
          </div>

          {/* Durable run state — survives a hard refresh (resuming / stuck / failed). */}
          {flow.run && flow.run.status !== 'done' && running !== flow.id && (
            <span title={flow.run.error || ''}
              className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-[11px] font-medium ${
                flow.run.status === 'running' ? 'bg-amber-500/15 text-amber-200'
                  : flow.run.status === 'stuck' || flow.run.status === 'error' ? 'bg-red-500/20 text-red-200'
                    : 'bg-glass/[0.07] text-dim'}`}>
              {flow.run.status === 'running' ? <><Loader2 size={11} className="animate-spin" /> <span className="hidden sm:inline">Resuming{typeof flow.run.step === 'number' && flow.run.total ? ` ${flow.run.step}/${flow.run.total}` : ''}…</span></>
                : flow.run.status === 'stuck' ? <><XCircle size={11} /> <span className="hidden sm:inline">Needs attention</span></>
                  : flow.run.status === 'error' ? <><XCircle size={11} /> <span className="hidden sm:inline">Failed</span></>
                    : flow.run.status === 'awaiting' ? <><ShieldCheck size={11} /> <span className="hidden sm:inline">Awaiting approval</span></>
                    : <><Clock size={11} /> <span className="hidden sm:inline">Stopped</span></>}
            </span>
          )}
          {running ? (
            <button onClick={() => abortRef.current?.abort()} className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-red-500/20 px-3 text-[13px] font-medium text-red-200 hover:bg-red-500/30">
              <Loader2 size={14} className="animate-spin" /> Stop
            </button>
          ) : (
            <>
              {flow.run && ['stuck', 'error', 'stopped'].includes(flow.run.status) && (
                <button onClick={() => void runFlow(flow, false, true)} disabled={!flow.nodes.length}
                  title="Continue this run from its saved results"
                  className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-2.5 text-[13px] font-semibold text-[#15170f] hover:brightness-110 disabled:opacity-40">
                  <Play size={14} /> Resume
                </button>
              )}
              <button onClick={() => void runFlow()} disabled={!flow.nodes.length}
                title="Start a fresh run of every step"
                className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-gradient-to-r from-[#c9a86a] to-accent px-3 text-[13px] font-semibold text-[#15170f] hover:brightness-110 disabled:opacity-40">
                <Play size={14} /> Run
              </button>
            </>
          )}
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

        {flow.run?.status === 'awaiting' && flow.run.node && <section className="ap-approval" aria-label="Review pending approval">
          <div className="ap-approval-heading"><ShieldCheck size={20} /><div><h2>Your review is needed</h2><p>{flow.run.nodeLabel || flow.nodes.find(n => n.id === flow.run!.node)?.label || 'Approval step'}</p></div></div>
          <div className="ap-approval-preview" tabIndex={0} aria-label="Content to review">{flow.edges.filter(e => e.to === flow.run!.node).map(e => flow.results?.[e.from]).filter(Boolean).join('\n') || 'This step is waiting for your decision.'}</div>
          <div className="ap-approval-actions">{flow.nodes.find(n => n.id === flow.run!.node)?.type === 'approval' ? <><button onClick={() => resolveApproval(flow.run!.node!, 'approve')}>Approve</button><button onClick={() => resolveApproval(flow.run!.node!, 'edit')}>Edit</button><button onClick={() => resolveApproval(flow.run!.node!, 'reject')}>Reject</button></> : <><button onClick={() => setConnMgr(true)}>Review post</button><button onClick={() => void runFlow(flow, false, true)}>Resume after review</button></>}</div>
        </section>}
        <div className="ap-flowbar">
          <p>{flow.nodes.length ? `${flow.nodes.length} steps · ${flow.edges.length} connections · ${flow.enabled && flow.schedule !== 'manual' ? 'Scheduled' : 'Run when you’re ready'}` : 'Start with your idea. Nalu will help connect the steps.'}</p>
          <div className="ap-flowbar-actions">
            <button className="ap-secondary ap-templates-button" onClick={() => setTemplatesOpen(true)}><Layers size={16} />Templates</button>
            <button className="ap-secondary ap-arrange" aria-label="Arrange" title="Arrange steps" disabled={!flow.nodes.length} onClick={() => { patchFlow(flow.id, { nodes: arrangeAutopilotNodes(flow.nodes, flow.edges) }); setUserZoom(1); if (canvasRef.current) { canvasRef.current.scrollTop = 0; canvasRef.current.scrollLeft = 0 } }}><Layers size={14} /><span>Arrange</span></button>
            <div className="ap-view-toggle" aria-label="Flow view">{(['canvas', 'steps'] as const).map(view => <button key={view} onClick={() => setFlowView(view)} aria-pressed={flowView === view}>{view === 'canvas' ? 'Connections' : 'Steps'}</button>)}</div>
          </div>
        </div>
        {/* canvas */}
        <div className="ap-stage relative flex-1 overflow-hidden">
        <div ref={canvasRef} onPointerMove={flowView === 'canvas' ? onCanvasMove : undefined} onPointerDown={flowView === 'canvas' ? onCanvasPanStart : undefined}
          onPointerUp={onCanvasPointerUp} onPointerCancel={onCanvasPointerUp}
          onClick={() => { if (addMenu) setAddMenu(false); setSelectedEdge(null) }}
          className="absolute inset-0 cursor-grab overflow-auto [touch-action:pan-x_pan-y] active:cursor-grabbing [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={flowView === 'canvas' ? { backgroundImage: 'radial-gradient(circle, rgba(128,140,158,0.12) 1px, transparent 1px)', backgroundSize: '26px 26px' } : { cursor: 'default' }}>
          {/* spacer sized to the SCALED canvas, so zooming IN can still scroll to every node */}
          <div style={flowView === 'canvas' ? { width: canvasSize.w * effScale, height: canvasSize.h * effScale } : { width: '100%' }}>
          <div className={`relative origin-top-left ${flowView === 'steps' ? 'mx-auto flex max-w-3xl flex-col gap-5 p-4 pb-24' : ''}`} style={flowView === 'canvas' ? { width: canvasSize.w, height: canvasSize.h, transform: `scale(${effScale})` } : undefined}>
            <svg style={flowView === 'steps' ? { display: 'none' } : { overflow: 'visible' }} aria-label="Workflow connections" className="pointer-events-none absolute inset-0" width={canvasSize.w} height={canvasSize.h} viewBox={`${canvasSize.minX} ${canvasSize.minY} ${canvasSize.w} ${canvasSize.h}`}>
              {flow.edges.map((e, i) => {
                const a = flow.nodes.find((n) => n.id === e.from)
                const b = flow.nodes.find((n) => n.id === e.to)
                const route = canvasSize.routes[i]
                if (!a || !b || !route) return null
                const hot = states[e.from] === 'running' || states[e.to] === 'running'
                const edgeLabel = e.label && e.label.length > 18 ? `${e.label.slice(0, 17)}…` : e.label
                return (
                  <g key={i} data-flow-edge="true">
                    <path d={route.path} fill="none" stroke={hot || selectedEdge === i ? '#d5ae6f' : 'rgb(var(--ws-dim) / .6)'} strokeWidth={hot || selectedEdge === i ? 3 : 2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={hot ? '6 5' : undefined}>
                      {hot && <animate attributeName="stroke-dashoffset" from="22" to="0" dur="0.7s" repeatCount="indefinite" />}
                    </path>
                    <path d={route.path} fill="none" stroke="transparent" strokeWidth={14} className="pointer-events-auto cursor-pointer"
                      role="button" tabIndex={0} aria-label={`Connection from ${a.label} to ${b.label}${e.label ? `: ${e.label}` : ''}`} onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelectedEdge(i); setConnecting(null) } }} onClick={ev => { ev.stopPropagation(); setSelectedEdge(i); setConnecting(null) }}>
                      <title>Review connection</title>
                    </path>
                    {edgeLabel && <g transform={`translate(${route.label.x}, ${route.label.y})`}><title>{e.label}</title><rect x={-Math.max(38, edgeLabel.length * 3.8)} y={-13} width={Math.max(76, edgeLabel.length * 7.6)} height={26} rx={8} fill="var(--ap-edge-label)" stroke="rgb(var(--ws-glass) / .2)" /><text textAnchor="middle" dominantBaseline="central" fontSize={11} fill="rgb(var(--ws-ink))">{edgeLabel}</text></g>}
                  </g>
                )
              })}
              {connecting && (() => { const a = flow.nodes.find((n) => n.id === connecting); return a ? <path d={connectionCurve(outputPort(a), mouse)} fill="none" stroke="#E4B96F" strokeWidth={2} strokeDasharray="5 4" /> : null })()}
            </svg>

            {(flowView === 'steps' ? topoOrder(flow.nodes, flow.edges).map(id => flow.nodes.find(n => n.id === id)!) : flow.nodes).map((n, stepIndex) => (
              <AutopilotNodeCard key={n.id} node={n} meta={nodeMeta(n)} state={flow.run?.status === 'awaiting' && flow.run.node === n.id ? 'awaiting' : states[n.id] || 'idle'} result={nodeResult(n.id)} index={stepIndex}
                canvas={flowView === 'canvas'} canvasOffset={{ x: -canvasSize.minX, y: -canvasSize.minY }} connecting={connecting} onDrag={e => onNodeDragStart(e, n)}
                onInput={() => finishConnect(n.id)} onOutput={() => { setConnecting(connecting === n.id ? null : n.id); setSelectedEdge(null) }}
                onEdit={() => setEditingNode(n.id)} onResult={() => setExpanded(n.id)} />
            ))}

          </div>
          </div>
          </div>
          {!flow.nodes.length && <div className="ap-empty"><Wand2 size={28} /><h2>Turn an idea into a workflow</h2><p>Describe what you need. Nalu will build the steps for you to review and run.</p><button onClick={() => { setBuildDraft(null); setBuildError(''); setBuildOpen(true) }}>Describe a workflow</button><button onClick={() => setAddMenu('add')}>Add your first step</button></div>}
          {/* Zoom controls — pinned to the canvas corner (sibling of the scroll area,
              so they don't scroll away). Large tap targets so they work on touch too. */}
          {flowView === 'canvas' && <>
            <p className="ap-canvas-hint">Drag to explore · Use the side handles to connect steps</p>
            <div className="ap-zoom"><button aria-label="Zoom out" onClick={() => zoomAtCenter(1 / 1.2)}><Minus size={17} /></button><button aria-label="Reset zoom" onClick={resetZoom}>{Math.round(effScale * 100)}%</button><button aria-label="Zoom in" onClick={() => zoomAtCenter(1.2)}><Plus size={17} /></button><button aria-label="Fit to screen" onClick={fitToScreen}><Maximize2 size={15} />Fit</button></div>
          </>}
          {connecting && <div className="ap-connection-banner"><span>Connect <b>{flow.nodes.find(n => n.id === connecting)?.label}</b> to</span><select aria-label="Connect to step" value="" onChange={e => finishConnect(e.target.value)}><option value="">Choose a step…</option>{flow.nodes.filter(n => n.id !== connecting).map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select><button className="ap-secondary" onClick={() => setConnecting(null)}>Cancel</button></div>}
          {selectedEdge !== null && flow.edges[selectedEdge] && <div className="ap-connection-banner"><span>{flow.nodes.find(n => n.id === flow.edges[selectedEdge].from)?.label} → {flow.nodes.find(n => n.id === flow.edges[selectedEdge].to)?.label}</span><button className="ap-secondary" onClick={() => { patchFlow(flow.id, f => ({ edges: f.edges.filter((_, i) => i !== selectedEdge) })); setSelectedEdge(null) }}>Disconnect</button><button className="ap-secondary" onClick={() => setSelectedEdge(null)}>Keep connection</button></div>}

        </div>
      </div>

      {templatesOpen && <AutopilotTemplates templates={PREBUILT_PIPELINES} onUse={usePrebuiltPipeline} onClose={() => setTemplatesOpen(false)} onCompany={() => { setTemplatesOpen(false); setCoSetup({ name: '', what: '', mission: '', notes: '' }) }} />}
      {editingNode && flow.nodes.some(n => n.id === editingNode) && <div className="ap-editor-backdrop" onClick={() => setEditingNode(null)}>
        <section ref={stepEditorRef} className="ap-editor-dialog" role="dialog" aria-modal="true" aria-label="Edit step" onClick={e => e.stopPropagation()} onKeyDown={e => {
          if (e.key === 'Escape' && !nodeModal) { e.stopPropagation(); setEditingNode(null) }
          if (e.key !== 'Tab') return
          const targets = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(el => el.offsetParent !== null)
          const first = targets[0], last = targets[targets.length - 1]
          if (e.shiftKey && document.activeElement === first && last) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && document.activeElement === last && first) { e.preventDefault(); first.focus() }
        }}><header><h2>Edit step</h2><button onClick={() => setEditingNode(null)}>Done editing</button></header><div className="ap-editor-content">{renderNodeEditor(flow.nodes.find(n => n.id === editingNode)!)}</div></section>
      </div>}

      {/* company setup — REQUIRED before a company exists: what it is + what it does */}
      {buildOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur" onClick={() => !building && setBuildOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Build a flow" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-glass/15 bg-panel2 p-5" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-ink">{buildDraft ? 'Review your flow' : 'What should Autopilot do?'}</h2>
            <p className="mt-2 text-sm text-dim">Describe the input, the result you want, and when it should run. You can edit every step before running it.</p>
            <label className="mt-4 block text-xs text-dim" htmlFor="flow-request">Your instructions</label>
            <textarea id="flow-request" value={buildText} onChange={e => { setBuildText(e.target.value); setBuildDraft(null) }} rows={4} placeholder="Every Monday, research recent changes in my industry, compare the sources, and save a concise report for me to review." className="mt-1 w-full rounded-xl border border-glass/15 bg-glass/5 p-3 text-sm text-ink outline-none focus:border-accent" disabled={building} />
            {buildError && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-200">{buildError}</p>}
            {buildDraft && <div className="mt-4 space-y-3">
              <label className="block text-xs text-dim">Flow name<input value={buildDraft.name} onChange={e => setBuildDraft({ ...buildDraft, name: e.target.value })} className="mt-1 block w-full rounded-lg bg-glass/5 p-2 text-sm text-ink" /></label>
              <p className="text-xs text-dim">{buildDraft.schedule === 'manual' ? 'Runs when you press Run.' : `Suggested schedule: ${buildDraft.schedule}${buildDraft.schedule === 'daily' ? ` at ${buildDraft.time}` : ''}. Scheduling starts off; enable it when ready.`}</p>
              <ol className="space-y-2">{buildDraft.nodes.map((n, i) => <li key={n.id} className="rounded-xl border border-glass/10 p-3"><div className="text-sm font-medium text-ink">{i + 1}. {n.label}</div><p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-dim">{n.prompt || 'Configure this step after saving.'}</p><p className="mt-2 text-xs text-gold">{buildDraft.edges.filter(e => e.from === n.id).map(e => `${e.label ? e.label + ' → ' : 'Next: '}${buildDraft.nodes.find(next => next.id === e.to)?.label}`).join(' · ') || 'Final result'}</p></li>)}</ol>
              {[...validateFlow(buildDraft).blockers, ...validateFlow(buildDraft).warnings].map((warning, i) => <p key={i} className="text-xs text-amber-200">{warning}</p>)}
            </div>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setBuildOpen(false)} disabled={building} className="rounded-lg px-4 py-2 text-sm text-dim">Cancel</button>
              <button onClick={buildFlow} disabled={building || !buildText.trim()} className="rounded-lg border border-glass/15 px-4 py-2 text-sm text-ink disabled:opacity-50">{building ? buildPhase : buildDraft ? 'Rebuild plan' : 'Create a plan'}</button>
              {buildDraft && <button onClick={acceptBuildDraft} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-[#15170f]">Use this flow</button>}
            </div>
          </div>
        </div>
      )}
      {/* ── Run Inspector ── per-step input / output / state / timing of the last run */}
      {inspectOpen && flow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setInspectOpen(false)}>
          <div className="flex max-h-[84vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-glass/[0.16] bg-panel2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-glass/[0.1] px-4 py-3">
              <ListTree size={15} className="text-accent" />
              <span className="text-sm font-semibold text-ink">Run inspector</span>
              {flow.snap && <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${flow.snap.status === 'done' ? 'bg-emerald-500/20 text-emerald-200' : flow.snap.status === 'stopped' ? 'bg-glass/[0.1] text-dim' : 'bg-red-500/20 text-red-200'}`}>{flow.snap.status} · {Math.max(1, Math.round((flow.snap.ms || 0) / 1000))}s</span>}
              <button onClick={() => setInspectOpen(false)} className="ml-auto text-dim hover:text-ink"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {!flow.snap ? (
                <div className="py-16 text-center text-[13px] text-dim">No run yet. Hit <b className="text-ink">Run</b> and the inspector will show what each step received and produced.</div>
              ) : (
                <div className="space-y-2.5">
                  {topoOrder(flow.nodes, flow.edges).map((nid) => flow.snap!.nodes[nid] && ({ nid, s: flow.snap!.nodes[nid] })).filter(Boolean).map((x) => {
                    const { nid, s } = x as { nid: string; s: RunSnap['nodes'][string] }
                    const tint = s.state === 'done' ? 'border-emerald-400/30' : s.state === 'skipped' ? 'border-glass/[0.12]' : s.state === 'idle' ? 'border-glass/[0.08]' : 'border-red-400/30'
                    return (
                      <div key={nid} className={`rounded-xl border ${tint} bg-glass/[0.03] p-3`}>
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="text-[12.5px] font-semibold text-ink">{s.label}</span>
                          <span className="rounded bg-glass/[0.08] px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-dim">{s.type}</span>
                          <span className={`text-[10px] font-medium ${s.state === 'done' ? 'text-emerald-300' : s.state === 'skipped' ? 'text-dim' : s.state === 'idle' ? 'text-dim' : 'text-red-300'}`}>{s.state}{s.ms ? ` · ${Math.max(1, Math.round(s.ms / 1000))}s` : ''}</span>
                        </div>
                        {s.input && <div className="mb-1.5"><div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-dim">Input</div><div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[11px] leading-relaxed text-dim">{s.input.slice(0, 2000)}</div></div>}
                        <div><div className="mb-0.5 flex items-center gap-2"><span className="text-[9.5px] font-semibold uppercase tracking-wide text-dim">Output</span>{s.output && <button onClick={() => copyText('Output copied', s.output)} className="text-dim hover:text-ink"><Copy size={11} /></button>}</div><div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-[11.5px] leading-relaxed text-ink">{s.output ? s.output.slice(0, 4000) : <span className="text-dim">(no output)</span>}</div></div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* ── Webhook / Flow-as-API settings ── */}
      {apiOpen && flow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setApiOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-glass/[0.16] bg-panel2 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink"><Webhook size={16} className="text-sky-300" /> Trigger this pipeline from anywhere</div>
            <p className="mb-3 text-[12px] leading-relaxed text-dim">Turn this pipeline into a webhook. Any app (Zapier, Make, a form, your own code) can POST to the URL below to run it on demand — the request body becomes the input, and the final result comes back in the response.</p>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-glass/[0.05] px-3 py-2.5">
              <input type="checkbox" checked={!!flow.apiEnabled} onChange={toggleApi} className="accent-sky-400" />
              <span className="text-[13px] text-ink">Expose as a webhook / API</span>
              {flow.apiEnabled && <span className="ml-auto rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-medium text-sky-200">Live</span>}
            </label>
            {flow.apiEnabled && flow.apiSecret && (() => {
              const base = typeof window !== 'undefined' ? window.location.origin : 'https://n4lu.com'
              const url = `${base}/api/hook?flow=${flow.id}&secret=${flow.apiSecret}`
              const curl = `curl -X POST "${url}" \\\n  -H "Content-Type: text/plain" \\\n  -d "your input here"`
              return (
                <div className="mt-3 space-y-2.5">
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dim">POST URL</div>
                    <div className="flex items-center gap-1.5 rounded-lg border border-glass/[0.12] bg-black/25 p-2">
                      <code className="min-w-0 flex-1 truncate text-[11px] text-sky-200">{url}</code>
                      <button onClick={() => copyText('URL copied', url)} className="shrink-0 rounded bg-glass/[0.1] p-1 text-dim hover:text-ink"><Copy size={12} /></button>
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dim">Try it (curl)</div>
                    <div className="flex items-start gap-1.5 rounded-lg border border-glass/[0.12] bg-black/25 p-2">
                      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[10.5px] leading-relaxed text-dim">{curl}</code>
                      <button onClick={() => copyText('curl copied', curl)} className="shrink-0 rounded bg-glass/[0.1] p-1 text-dim hover:text-ink"><Copy size={12} /></button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => { patchFlow(flow.id, { apiSecret: (uid() + uid() + uid()).replace(/[^a-z0-9]/gi, '') }) }} className="rounded-lg bg-glass/[0.08] px-2.5 py-1.5 text-[11.5px] text-dim hover:text-ink">Roll secret</button>
                    <p className="text-[10.5px] leading-snug text-dim">Add a <b className="text-ink/80">Trigger</b> node as your first step so the incoming payload flows in. Keep the secret private — anyone with it can run this pipeline.</p>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}
      {/* ── Version history ── */}
      {versionsOpen && flow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setVersionsOpen(false)}>
          <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-glass/[0.16] bg-panel2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-glass/[0.1] px-4 py-3">
              <History size={15} className="text-accent" />
              <span className="text-sm font-semibold text-ink">Version history</span>
              <button onClick={() => { snapshotVersion('manual save') }} className="ml-auto rounded-lg bg-glass/[0.08] px-2.5 py-1 text-[11.5px] text-ink hover:bg-glass/[0.15]">Save current</button>
              <button onClick={() => setVersionsOpen(false)} className="text-dim hover:text-ink"><X size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {!flow.versions?.length ? (
                <div className="py-12 text-center text-[13px] text-dim">No saved versions yet. Hit <b className="text-ink">Save current</b> before a big change so you can roll back.</div>
              ) : (
                <div className="space-y-1.5">
                  {flow.versions.map((v) => (
                    <div key={v.id} className="flex items-center gap-2 rounded-lg border border-glass/[0.1] bg-glass/[0.03] px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-ink">{v.note}</div>
                        <div className="text-[10.5px] text-dim">{new Date(v.at).toLocaleString()} · {v.nodes.length} step{v.nodes.length === 1 ? '' : 's'}</div>
                      </div>
                      <button onClick={() => restoreVersion(v)} className="shrink-0 rounded-lg bg-accent/20 px-2.5 py-1 text-[11.5px] font-medium text-accent hover:bg-accent/30">Restore</button>
                      <button onClick={() => patchFlow(flow.id, (f) => ({ versions: (f.versions || []).filter((x) => x.id !== v.id) }))} className="shrink-0 text-dim hover:text-red-300"><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Small copy/save toast */}
      {copied && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-emerald-500/90 px-4 py-1.5 text-[12px] font-medium text-[#0c1f16] shadow-lg">{copied}</div>
      )}
      {coSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setCoSetup(null)}>
          <div className="w-full max-w-md rounded-2xl border border-glass/[0.16] bg-panel2 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold text-ink">Set up your company</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-dim">Every employee's work is grounded in this — you can tweak each position after it's created.</div>
            <label className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Company name</label>
            <input autoFocus value={coSetup.name} onChange={(e) => setCoSetup({ ...coSetup, name: e.target.value })} placeholder="Acme Coffee Co."
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

      {hfSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setHfSetup(null)}>
          <div className="w-full max-w-lg rounded-2xl border border-emerald-400/25 bg-panel2 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[13px] font-semibold text-ink">Nalu Hedge Fund model</div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-dim">Research your watchlist through analyst, macro, risk, and portfolio perspectives. These are AI roles using investing approaches, with sourced research and clearly stated uncertainty. Attach your completed risk policy to the pipeline to check proposed quantities against your holdings, prices, cash, and limits. Orders are never executed here.</p>
            <a href="/fund-risk-policy.example.json" download className="mt-2 inline-block text-[11.5px] text-emerald-300 underline">Download risk policy example</a>
            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Fund name</label>
            <input autoFocus value={hfSetup.name} onChange={(e) => setHfSetup({ ...hfSetup, name: e.target.value })} placeholder="Nalu Hedge Fund"
              className="mt-1 w-full rounded-lg border border-glass/[0.12] bg-glass/[0.05] px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim focus:border-glass/30" />
            <label className="mt-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-dim">Tickers / watchlist</label>
            <input value={hfSetup.tickers} onChange={(e) => setHfSetup({ ...hfSetup, tickers: e.target.value })} placeholder="AAPL, NVDA, MSFT, TSLA"
              className="mt-1 w-full rounded-lg border border-glass/[0.12] bg-glass/[0.05] px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-dim focus:border-glass/30" />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button onClick={() => setHfSetup(null)} className="rounded-lg px-3 py-1.5 text-[12px] text-dim hover:bg-glass/10 hover:text-ink">Cancel</button>
              <button onClick={() => { createHedgeFund(hfSetup.name, hfSetup.tickers); setHfSetup(null) }}
                className="rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-3.5 py-1.5 text-[12.5px] font-semibold text-[#08130d] hover:brightness-110">
                Build the fund
              </button>
            </div>
          </div>
        </div>
      )}

      {connMgr && <ConnectionManager onClose={() => setConnMgr(false)} onChange={loadConns} />}

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

      {/* Prompt / Notes editor — big, focused, autosaves as you type. */}
      {nodeModal && (() => {
        const nm = flow.nodes.find((n) => n.id === nodeModal.nodeId)
        if (!nm) return null
        const isAgent = nm.type === 'agent'
        const tab: 'prompt' | 'notes' = nodeModal.tab === 'notes' && isAgent ? 'notes' : 'prompt'
        const promptPlaceholder = nm.type === 'agent'
          ? 'What should this agent do? Use {{input}} for the previous step’s output.'
          : nm.type === 'email' ? 'Email body — {{input}} = upstream output.'
            : nm.type === 'foreach' ? 'What to do with EACH item. Use {{item}} for the current item, e.g. “Write a 2-line personalized opener for {{item}}.”'
            : nm.type === 'planner' ? 'The GOAL to accomplish autonomously, e.g. “Research the top 3 competitors to {{input}} and summarize their pricing.” The agent will search/read on its own.'
            : `Style / brief for the ${nodeMeta(nm).name.toLowerCase()} (the upstream output is the material). {{input}} = upstream output.`
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur" onClick={() => setNodeModal(null)}>
            <div className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-glass/[0.16] bg-panel2" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 border-b border-glass/[0.1] px-4 py-2.5">
                <span className="truncate text-sm font-medium text-ink">{nm.label || 'Step'}</span>
                {isAgent ? (
                  <div className="ml-2 flex gap-1 rounded-lg bg-glass/[0.06] p-0.5">
                    <button onClick={() => setNodeModal({ nodeId: nm.id, tab: 'prompt' })} className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${tab === 'prompt' ? 'bg-glass/15 text-ink' : 'text-dim hover:text-ink'}`}>Prompt</button>
                    <button onClick={() => setNodeModal({ nodeId: nm.id, tab: 'notes' })} className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${tab === 'notes' ? 'bg-amber-500/20 text-amber-100' : 'text-dim hover:text-ink'}`}>Notes</button>
                  </div>
                ) : <span className="text-[12px] text-dim">· Prompt</span>}
                <button onClick={() => setNodeModal(null)} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md bg-glass/10 text-ink hover:bg-glass/20"><X size={14} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {tab === 'prompt' ? (
                  <>
                    {nm.type === 'email' && (
                      <div className="mb-3 grid grid-cols-2 gap-2">
                        <input value={nm.to || ''} onChange={(e) => patchNode(nm.id, { to: e.target.value })} placeholder="to@email.com"
                          className="rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-dim focus:border-glass/30" />
                        <input value={nm.subject || ''} onChange={(e) => patchNode(nm.id, { subject: e.target.value })} placeholder="Subject"
                          className="rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-dim focus:border-glass/30" />
                      </div>
                    )}
                    {nm.type === 'social' && (
                      <div className="mb-3 grid gap-2 sm:grid-cols-2">
                        <select value={nm.platform || 'Instagram'} onChange={(e) => patchNode(nm.id, { platform: e.target.value })}
                          className="rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-glass/30">
                          {['Instagram', 'TikTok', 'LinkedIn', 'X (Twitter)', 'Pinterest', 'Threads', 'Facebook'].map((pl) => <option key={pl} value={pl} className="bg-panel2">{pl}</option>)}
                        </select>
                        <select value={nm.format || 'carousel'} onChange={(e) => patchNode(nm.id, { format: e.target.value })}
                          className="rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-glass/30">
                          <option value="carousel" className="bg-panel2">Carousel / image post</option>
                          <option value="video" className="bg-panel2">Video (reel / TikTok) — Nalu Video</option>
                        </select>
                        <input value={nm.webhook || ''} onChange={(e) => patchNode(nm.id, { webhook: e.target.value })} placeholder="Auto-post webhook (Zapier/Make/Buffer) — optional"
                          className="rounded-lg border border-glass/[0.12] bg-glass/[0.04] px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-dim focus:border-glass/30 sm:col-span-2" />
                      </div>
                    )}
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-dim">Prompt</label>
                    <textarea autoFocus value={nm.prompt} onChange={(e) => patchNode(nm.id, { prompt: e.target.value })} rows={12}
                      placeholder={promptPlaceholder}
                      className="w-full resize-y rounded-lg border border-glass/[0.14] bg-glass/[0.04] p-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-glass/30" />
                    <p className="mt-2 text-[11.5px] text-dim"><b className="font-semibold text-ink/80">{'{{input}}'}</b> is replaced by the previous step’s output when this step runs.</p>
                  </>
                ) : (
                  <>
                    <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/80">Notes — hard rules for this agent</label>
                    <textarea autoFocus value={nm.roleNotes || ''} onChange={(e) => patchNode(nm.id, { roleNotes: e.target.value })} rows={11}
                      placeholder="How this agent must work — exact rules that override defaults: e.g. always cite sources, keep under 200 words, use our brand voice, never contact competitors."
                      className="w-full resize-y rounded-lg border border-amber-400/25 bg-amber-500/[0.05] p-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-dim focus:border-amber-400/45" />
                    <p className="mt-2 text-[11.5px] text-dim">These override default behavior and are injected into every run of this agent.</p>
                  </>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-glass/[0.1] px-4 py-2.5">
                <span className="text-[11px] text-dim">Saved automatically</span>
                <button onClick={() => setNodeModal(null)} className="rounded-lg bg-gradient-to-r from-[#c9a86a] to-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-[#15170f] hover:brightness-110">Save &amp; close</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
