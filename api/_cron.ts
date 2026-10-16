// Server-side scheduler: runs AutoPilot flows on their schedule EVEN WHEN THE
// SITE IS CLOSED. Vercel Cron (or any external pinger) hits this; it reads every
// user's flows from the DB, runs the ones that are due, and writes the results
// back so they're waiting when the user next opens n4lu.com / n4lu.ai.
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareFlows } from './_cloudflareFlows'
import { CloudflareTaskLedger } from './_cloudflareTaskLedger'
import { groundFromPrompt } from './_grounding'
import { fetchPage, search } from './_webResearch'
import { chatComplete } from './_llm'
import { storeGeneratedArtifact, type ArtifactStore, type ArtifactMeta } from './_autopilotArtifacts'
import { buildPortableOutput } from './_autopilotOutput'
import { PORTABLE_OUTPUT_TYPES } from '../shared/autopilotFiles'
import { BACKGROUND_OUTPUT_TYPES, graphErrors, needsOpenWorkspace } from '../shared/autopilotCapabilities'
import { buildRichOutput, richDeliveryPayload } from './_autopilotRichOutput'
import { sendPipelineOutput } from './connect'
import { isScheduleDue } from '../shared/autopilotSchedule'

type Edge = { from: string; to: string; label?: string }
type Branch = { label: string; cond?: string }
type PNode = { webSearch?: boolean; id: string; type?: string; agent?: string; role?: string; prompt?: string; label?: string; lastRunDay?: string; roleTitle?: string; roleNotes?: string
  to?: string; subject?: string; connectionId?: string; webhook?: string; platform?: string; format?: string
  triggerKind?: string; routeBy?: 'ai' | 'condition'; branches?: Branch[]; condMode?: string; cond?: string; method?: string; url?: string; headers?: string; memKey?: string; memOp?: 'set' | 'append' | 'get'
  splitBy?: 'lines' | 'json' | 'numbered' | 'commas'; maxItems?: number; maxSteps?: number; refDoc?: { name?: string; text?: string } }
type Company = { what?: string; mission?: string; notes?: string }
type FlowRun = { status: 'running' | 'done' | 'error' | 'stuck' | 'stopped' | 'awaiting'; step?: number; total?: number; startedAt?: number; updatedAt?: number; heartbeat?: number; node?: string; nodeLabel?: string; error?: string; cutEdges?: string[] }
type Flow = {
  id: string; name?: string; nodes?: PNode[]; edges?: Edge[]
  schedule?: 'manual' | 'hourly' | 'daily' | 'weekly' | 'continuous' | 'members'
  time?: string; timeZone?: string; enabled?: boolean; lastRun?: number; results?: Record<string, string>; company?: Company; run?: FlowRun
  refDoc?: { name: string; text: string } // user-attached reference doc for every agent
  memory?: Record<string, string> // 10x: persistent per-flow memory across runs
  approvals?: Record<string, { decision: 'approve' | 'edit' | 'reject'; text?: string; at: number }>
  artifacts?: Record<string, ArtifactMeta>
  apiEnabled?: boolean; apiSecret?: string // 10x: exposed as an inbound webhook / API
}
// A run whose heartbeat is older than this has lost its tab (hard refresh / close)
// — the server takes it over and finishes it. Generous so a briefly-backgrounded
// tab is never stolen mid-run.
const ORPHAN_MS = 180_000
const NODE_TIMEOUT_MS = 90_000
function isOrphanedRun(f: Flow, now: number): boolean {
  return !!f.run && f.run.status === 'running' && !!f.nodes?.length && now - (f.run.heartbeat || 0) > ORPHAN_MS
}
const ROLE_TITLES: Record<string, string> = {
  ceo: 'CEO', coo: 'COO', cfo: 'CFO', cto: 'CTO', cio: 'CIO', cmo: 'CMO', design: 'Head of Design', accountant: 'Accountant', legal: 'Legal Counsel', analyst: 'Analyst', ea: 'Executive Assistant', pm: 'Product Manager', sales: 'Sales Lead', hr: 'Head of People', support: 'Support Lead',
  // Nalu Hedge Fund personas + agents (so scheduled fund runs stay in character).
  'hf-buffett': 'Warren Buffett (invest like Buffett — moats, margin of safety)', 'hf-munger': 'Charlie Munger (quality, mental models)', 'hf-graham': 'Ben Graham (deep value, margin of safety)', 'hf-wood': 'Cathie Wood (disruptive innovation growth)', 'hf-burry': 'Michael Burry (contrarian deep value + catalysts)', 'hf-ackman': 'Bill Ackman (concentrated activist)', 'hf-lynch': 'Peter Lynch (GARP, PEG)', 'hf-fisher': 'Phil Fisher (scuttlebutt quality growth)', 'hf-druckenmiller': 'Stanley Druckenmiller (macro + asymmetric bets)', 'hf-damodaran': 'Aswath Damodaran (rigorous DCF valuation)', 'hf-taleb': 'Nassim Taleb (tail risk, antifragility)', 'hf-pabrai': 'Mohnish Pabrai (Dhandho, low-risk high-uncertainty)', 'hf-jhunjhunwala': 'Rakesh Jhunjhunwala (high-conviction growth)',
  'hf-fundamentals': 'Fundamentals Analyst', 'hf-valuation': 'Valuation Analyst', 'hf-technicals': 'Technical Analyst', 'hf-sentiment': 'Sentiment Analyst', 'hf-growth': 'Growth Analyst', 'hf-macro': 'Real-Time Macro & Events Analyst (scan the live web for disasters, pandemics, rates, geopolitics)', 'hf-risk': 'Risk Manager (set position limits)', 'hf-portfolio': 'Portfolio Manager (final buy/sell/short/hold decisions)',
}

// Is this flow due to run right now?
function isDue(f: Flow, now: number): boolean {
  if (!f.enabled || f.schedule === 'manual' || !f.nodes?.length || f.run?.status === 'awaiting') return false
  return isScheduleDue(f.schedule || 'manual', f.time || '08:00', f.lastRun || 0, new Date(now), f.timeZone || 'UTC')
}

// Topological order (Kahn) so each agent gets its upstream results first.
function topoOrder(nodes: PNode[], edges: Edge[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const outs = new Map(nodes.map((n) => [n.id, [] as string[]]))
  for (const e of edges) { if (indeg.has(e.to) && indeg.has(e.from)) { indeg.set(e.to, (indeg.get(e.to) || 0) + 1); outs.get(e.from)!.push(e.to) } }
  const q = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (q.length) {
    const id = q.shift() as string
    order.push(id)
    for (const t of outs.get(id) || []) { indeg.set(t, (indeg.get(t) || 0) - 1); if ((indeg.get(t) || 0) === 0) q.push(t) }
  }
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id) // include any leftover (cycle safety)
  return order
}

// For-each: split an upstream text blob into items (mirrors the client's splitItems).
function splitItemsSrv(input: string, by: PNode['splitBy']): string[] {
  const t = (input || '').trim()
  if (!t) return []
  if (by === 'json') { try { const j = JSON.parse(t.slice(Math.max(0, t.indexOf('[')))); if (Array.isArray(j)) return j.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).filter(Boolean) } catch { /* */ } }
  if (by === 'commas') return t.split(',').map((s) => s.trim()).filter(Boolean)
  if (by === 'numbered') { const m = t.split(/\n(?=\s*(?:\d+[.)]|[-*•]))/).map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean); if (m.length > 1) return m }
  return t.split('\n').map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean)
}
// Autopilot Agent (planner) — next-action prompt + parser (mirrors the client).
const plannerPromptSrv = (goal: string, scratch: string[], step: number, max: number) =>
  `You are an autonomous agent working toward a GOAL. Use tools to gather what you need, then deliver.\nGOAL: ${goal}\n\n` +
  (scratch.length ? `WHAT YOU KNOW SO FAR:\n${scratch.join('\n\n').slice(-8000)}\n\n` : '') +
  `This is step ${step + 1} of at most ${max}. Reply with ONLY minified JSON:\n- {"action":"search","query":"..."}\n- {"action":"fetch","url":"https://..."}\n- {"action":"finish","answer":"<full final deliverable>"}\nFinish as soon as you can do a great job. JSON only.`
function parsePlannerActionSrv(raw: string): { action: 'search' | 'fetch' | 'finish'; query?: string; url?: string; answer?: string } {
  const s = raw || '', start = s.indexOf('{'), end = s.lastIndexOf('}')
  if (start >= 0 && end > start) { try { const j = JSON.parse(s.slice(start, end + 1)) as { action?: string; query?: string; url?: string; answer?: string }; if (j.action === 'search' || j.action === 'fetch' || j.action === 'finish') return j as ReturnType<typeof parsePlannerActionSrv> } catch { /* */ } }
  const url = s.match(/https?:\/\/[^\s"'<>]+/)?.[0]
  if (/"action"\s*:\s*"fetch"/.test(s) && url) return { action: 'fetch', url }
  const q = s.match(/"query"\s*:\s*"([^"]+)"/)?.[1]
  if (q) return { action: 'search', query: q }
  return { action: 'finish', answer: s }
}

type ProgressFn = (step: number, total: number, label: string) => void | Promise<void>
type ArtifactContext = { client: ArtifactStore; userId: string; runId: string; startedAt: number }
async function runFlow(f: Flow, onProgress?: ProgressFn, shouldStop?: () => Promise<boolean>, artifacts?: ArtifactContext, previousWork?: Record<string, string>): Promise<{ results: Record<string, string>; status: FlowRun['status']; error?: string; memory?: Record<string, string>; node?: string; nodeLabel?: string; cutEdges: string[] }> {
  const nodes = f.nodes || [], edges = f.edges || []
  const invalid = graphErrors(nodes, edges)
  if (invalid.length) return { results: {}, status: 'error', error: invalid.join(' '), cutEdges: [] }
  const deps = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.to === n.id).map((e) => e.from)]))
  // RESUME: keep every step already finished (e.g. by the tab before it closed).
  const previousResults = { ...(previousWork || f.results || {}) }
  const resuming = f.run?.status === 'running' || f.run?.status === 'awaiting'
  const results: Record<string, string> = resuming ? { ...(f.results || {}) } : {}
  // Keep completed steps available to progress persistence and resumptions.
  f.results = results
  const failed = new Set<string>()
  const completedAgents = new Set<string>()
  const cut = new Set<string>() // nodes clean-skipped because their branch wasn't taken (NOT errors)
  const stuck = new Set<string>()
  let firstError = ''
  const order = topoOrder(nodes, edges)
  // 10x: control/tool nodes run server-side too (so SCHEDULED flows using them work
  // tab-closed). Portable formats share durable storage and browser serializers.
  const SERVER_RUNS = new Set(['agent', 'trigger', 'websearch', 'fetchurl', 'http', 'memory', 'router', 'filter', 'approval', 'foreach', 'planner', ...BACKGROUND_OUTPUT_TYPES])
  const mem: Record<string, string> = { ...(f.memory || {}) }
  const cutEdges = new Set<string>()
  // TAKEOVER: rehydrate branch cuts the client made before its tab closed, so a
  // router that already ran (and is resume-skipped below) doesn't lose its cut and
  // let the untaken branch fire. Only when resuming an in-flight run.
  if (resuming && Array.isArray(f.run?.cutEdges)) for (const k of f.run.cutEdges) cutEdges.add(k)
  const eKey = (a: string, b: string) => `${a}>${b}`
  const liveDeps = (id: string) => (deps.get(id) || []).filter((d) => !cutEdges.has(eKey(d, id)))
  const tpl = (s: string, input: string) => (s || '').split('{{input}}').join(input || '').replace(/\{\{\s*memory\.([\w.-]+)\s*\}\}/g, (_m, k: string) => (mem[k] ?? ''))
  const stepTotal = order.length
  for (const nid of order) {
    if (await shouldStop?.()) return { results, status: 'stopped', memory: mem, cutEdges: [...cutEdges] }
    const node = nodes.find((n) => n.id === nid)
    if (!node || !node.type || completedAgents.has(nid)) continue
    // Survivor semantics (mirror the client): topo order guarantees every parent
    // is already resolved here. A node runs if ANY parent survived (succeeded and
    // wasn't cut) — so a MERGE after a router fires on the taken branch. It's only
    // skipped when EVERY parent is gone: all cut → clean cut; any failed → error.
    {
      const ld = liveDeps(nid)
      const hadDeps = (deps.get(nid) || []).length > 0
      if (hadDeps && ld.length === 0) { cut.add(nid); continue } // every incoming branch cut → not taken
      // Every parent must resolve, including browser-only output steps. A
      // skipped file/delivery cannot supply input or count as successful work.
      const parents = ld.filter((d) => nodes.some((n) => n.id === d))
      if (parents.length > 0) {
        const survivors = parents.filter((d) => results[d] != null && !failed.has(d) && !cut.has(d))
        if (survivors.length === 0) {
          if (parents.some((d) => failed.has(d))) failed.add(nid)
          else cut.add(nid)
          continue
        }
      }
    }
    if (resuming && results[nid] != null) continue
    if (!SERVER_RUNS.has(node.type) || needsOpenWorkspace(node)) {
      failed.add(nid); stuck.add(nid)
      firstError ||= `Open Autopilot in Nalu and resume to complete "${node.label || node.type}". This step needs the workspace open.`
      continue
    }
    const input = liveDeps(nid).map((d) => results[d]).filter(Boolean).join('\n\n---\n\n')
    if ((BACKGROUND_OUTPUT_TYPES as readonly string[]).includes(node.type)) {
      try {
        if (!artifacts) throw new Error('Saved-output storage is unavailable. Resume to retry this step.')
        // Expand memory before rendering, keeping {{input}} until the shared
        // builder consumes it so upstream text is never appended twice.
        const brief = (node.prompt || '').replace(/\{\{\s*memory\.([\w.-]+)\s*\}\}/g, (_m, key: string) => mem[key] ?? '')
        await onProgress?.(Object.keys(results).length, stepTotal, `Building ${node.label || node.type}`)
        if (await shouldStop?.()) return { results, status: 'stopped', memory: mem, cutEdges: [...cutEdges] }
        const saved = await storeGeneratedArtifact(artifacts.client, artifacts.userId, {
          flowId: f.id, flowName: f.name || 'Automation', nodeId: nid, nodeLabel: node.label || node.type,
          runId: artifacts.runId, ts: artifacts.startedAt,
        }, async () => {
          const output = await ((PORTABLE_OUTPUT_TYPES as readonly string[]).includes(node.type!) ? buildPortableOutput({ ...node, prompt: brief }, input, f) : buildRichOutput({ ...node, prompt: brief }, input, f))
          if (await shouldStop?.()) throw new Error('Run stopped before the output was saved.')
          return output
        })
        if (await shouldStop?.()) return { results, status: 'stopped', memory: mem, cutEdges: [...cutEdges] }
        f.artifacts = { ...f.artifacts, [nid]: saved.meta }
        const shouldDeliver = (node.type === 'email' && !!node.to?.trim() && !!node.connectionId) || (node.type === 'social' && !!(node.connectionId || node.webhook?.trim()))
        let delivered = ''
        if (shouldDeliver) {
          await onProgress?.(Object.keys(results).length, stepTotal, `Saved ${saved.meta.filename}; delivering`)
          if (await shouldStop?.()) return { results, status: 'stopped', memory: mem, cutEdges: [...cutEdges] }
          const delivery = await sendPipelineOutput(artifacts.client, artifacts.userId, `${artifacts.runId}:${nid}`, node, node.type === 'email' ? 'email' : 'post', richDeliveryPayload(node, saved))
          if (delivery.reviewRequired) return { results, status: 'awaiting', node: nid, nodeLabel: node.label || 'Post review', memory: mem, cutEdges: [...cutEdges] }
          if (!delivery.ok) throw new Error(delivery.detail)
          delivered = `\n\nDELIVERY: ${delivery.detail}`
        }
        results[nid] = saved.result + delivered
        f.memory = mem
        if (f.run) f.run = { ...f.run, cutEdges: [...cutEdges] }
        // Commit the artifact checkpoint before a dependent action can run.
        await onProgress?.(Object.keys(results).length, stepTotal, `Saved ${saved.meta.filename}`)
      } catch (e) {
        delete results[nid]
        failed.add(nid)
        firstError ||= `"${node.label || nid}" ${e instanceof Error ? e.message : 'file could not be saved'}`
      }
      continue
    }
    // ---- control/tool nodes (mirror the client engine) ----
    if (node.type === 'trigger') { results[nid] = input || tpl(node.prompt || '', input) || 'Triggered run'; continue }
    if (node.type === 'memory') {
      const key = (node.memKey || 'value').trim(), op = node.memOp || 'set'
      if (op === 'get') { results[nid] = mem[key] || ''; continue }
      mem[key] = (op === 'append' ? `${mem[key] || ''}\n${input}`.trim() : (input || tpl(node.prompt || '', input))).slice(0, 8000)
      results[nid] = input || mem[key]; continue
    }
    if (node.type === 'fetchurl') {
      try {
        const url = (tpl(node.url || node.prompt || '', input) || input).match(/https?:\/\/[^\s"'<>]+/)?.[0] || ''
        const page = await fetchPage(url)
        if (page.status !== 'read') throw new Error(page.error || 'Page could not be read')
        results[nid] = `PAGE ${page.url} · Accessed ${page.accessedAt} · Published ${page.publishedAt || 'unknown'}\n\n${page.text}`
      } catch (e) { failed.add(nid); firstError ||= `"${node.label || nid}" ${e instanceof Error ? e.message : 'read failed'}` }
      continue
    }
    if (node.type === 'http') {
      try {
        const method = (node.method || 'GET').toUpperCase()
        const url = (tpl(node.url || node.prompt || '', input) || input).match(/https?:\/\/[^\s"'<>]+/)?.[0] || ''
        if (!url) { failed.add(nid); continue }
        let hdrs: Record<string, string> = {}
        try { if (node.headers) hdrs = JSON.parse(tpl(node.headers, input)) } catch { /* */ }
        const body = method === 'GET' || method === 'HEAD' ? undefined : tpl(node.prompt || '', input) || input
        const rr = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...hdrs }, body, signal: AbortSignal.timeout(NODE_TIMEOUT_MS) })
        if (!rr.ok) throw new Error(`HTTP ${rr.status} ${method} request failed`)
        results[nid] = `${node.type === 'http' ? `HTTP ${rr.status} ${method} ${url}` : `PAGE ${url}`}\n\n${(await rr.text()).slice(0, 12000)}`
      } catch (e) { failed.add(nid); firstError ||= `"${node.label || nid}" ${e instanceof Error ? e.message : 'request failed'}` }
      continue
    }
    if (node.type === 'websearch') {
      try {
        const q = (tpl(node.prompt || '', input).trim() || input || node.label || '').slice(0, 300)
        const found = await search(q)
        if (!found.results.length) throw new Error('No usable web results. Resume to retry this research step.')
        results[nid] = found.text
      } catch (e) { failed.add(nid); firstError ||= `"${node.label || nid}" ${e instanceof Error ? e.message : 'search failed'}` }
      continue
    }
    if (node.type === 'router') {
      const brs = node.branches && node.branches.length ? node.branches : [{ label: 'A' }, { label: 'B' }]
      let taken = brs[0].label
      try {
        if ((node.routeBy || 'ai') === 'ai') {
          const pick = await chatComplete([{ role: 'user', content: `Route the INPUT to EXACTLY ONE label: ${brs.map((b) => b.label).join(' | ')}.${node.prompt ? ` Rule: ${node.prompt}` : ''}\nReply ONLY the label.\n\nINPUT:\n${(input || '(empty)').slice(0, 4000)}` }], { maxTokens: 20, temperature: 0 })
          const p = pick.trim().toLowerCase(); taken = (brs.find((b) => p.includes(b.label.toLowerCase())) || brs[0]).label
        } else taken = (brs.find((b) => (input || '').toLowerCase().includes((b.cond || '').toLowerCase())) || brs[brs.length - 1]).label
      } catch { /* keep first */ }
      edges.filter((e) => e.from === nid).forEach((e, i) => { const lbl = e.label || brs[i]?.label; if (lbl && lbl !== taken) cutEdges.add(eKey(e.from, e.to)) })
      results[nid] = input || `routed → ${taken}`; continue
    }
    if (node.type === 'filter') {
      let pass = true
      try {
        if ((node.condMode || 'notempty') === 'ai') { const a = await chatComplete([{ role: 'user', content: `Answer ONLY yes or no. Condition: ${node.cond || node.prompt || 'worth continuing?'}\n\nINPUT:\n${(input || '').slice(0, 4000)}` }], { maxTokens: 5, temperature: 0 }); pass = /\byes\b/i.test(a) }
        else if (node.condMode === 'contains') pass = (input || '').toLowerCase().includes((node.cond || '').toLowerCase())
        else pass = (input || '').trim().length > 0
      } catch { /* pass */ }
      if (!pass) { edges.filter((e) => e.from === nid).forEach((e) => cutEdges.add(eKey(e.from, e.to))); results[nid] = ''; continue }
      results[nid] = input || 'passed'; continue
    }
    if (node.type === 'approval') {
      const decision = f.approvals?.[nid]
      if (!decision || !['approve', 'edit', 'reject'].includes(decision.decision)) {
        return { results, status: 'awaiting', node: nid, nodeLabel: node.label || 'Approval', memory: mem, cutEdges: [...cutEdges] }
      }
      if (decision.decision === 'reject') {
        edges.filter((e) => e.from === nid).forEach((e) => cutEdges.add(eKey(e.from, e.to)))
        results[nid] = ''
      } else results[nid] = decision.decision === 'edit' ? decision.text ?? input : input || 'approved'
      continue
    }
    if (node.type === 'foreach') {
      const items = splitItemsSrv(input, node.splitBy).slice(0, Math.max(1, Math.min(node.maxItems || 20, 24)))
      if (!items.length) { results[nid] = '(nothing to map over)'; continue }
      const itemPrompt = (node.prompt || '').trim() || 'Process this item:\n{{item}}'
      const outs: string[] = []
      const itemEvidence = node.webSearch === false ? '' : await groundFromPrompt(itemPrompt.replace(/\{\{[^}]+\}\}/g, '').trim())
      // Batches of 3 keep wall-clock down without hammering the provider.
      for (let i = 0; i < items.length; i += 3) {
        const batch = items.slice(i, i + 3)
        const done = await Promise.all(batch.map(async (it) => {
          const p = itemEvidence + '\n\n' + itemPrompt.split('{{item}}').join(it).split('{{input}}').join(it)
          try { return (await chatComplete([{ role: 'user', content: p }], { maxTokens: 1200, timeoutMs: NODE_TIMEOUT_MS, temperature: 0.6 })).trim() }
          catch (e) { return `(item failed: ${e instanceof Error ? e.message : 'error'})` }
        }))
        outs.push(...done)
      }
      results[nid] = outs.map((x, i) => `【Item ${i + 1}】\n${x}`).join('\n\n---\n\n'); continue
    }
    if (node.type === 'planner') {
      const goal = tpl(node.prompt || '', input).trim() || input || node.label || 'the goal'
      const maxSteps = Math.max(1, Math.min(6, node.maxSteps || 4))
      const scratch: string[] = input ? [`CONTEXT PASSED IN:\n${input.slice(0, 4000)}`] : []
      let final = ''
      for (let step = 0; step < maxSteps; step++) {
        let raw = ''
        try { raw = await chatComplete([{ role: 'user', content: plannerPromptSrv(goal, scratch, step, maxSteps) }], { maxTokens: 1600, timeoutMs: NODE_TIMEOUT_MS, temperature: 0.4 }) } catch { break }
        const act = parsePlannerActionSrv(raw)
        if (act.action === 'search' && act.query) {
          try {
            const found = await search(act.query.slice(0, 300))
            scratch.push(found.text)
          } catch { scratch.push(`SEARCH "${act.query}" failed.`) }
        } else if (act.action === 'fetch' && act.url) {
          try { const page = await fetchPage(act.url); scratch.push(`${page.status === 'read' ? 'READ' : 'UNAVAILABLE'} ${act.url}:\n${page.text.slice(0, 6500)}`) } catch { scratch.push(`FETCH ${act.url} failed.`) }
        } else { final = act.answer || raw; break }
      }
      if (!final) { try { final = await chatComplete([{ role: 'user', content: `GOAL: ${goal}\n\nGathered:\n${scratch.join('\n\n').slice(0, 12000)}\n\nWrite the best final deliverable for the goal. Output only the deliverable.` }], { maxTokens: 2000, timeoutMs: NODE_TIMEOUT_MS, temperature: 0.6 }) } catch { final = scratch.join('\n\n') } }
      results[nid] = (final || '').slice(0, 24000) || '(agent produced no output)'; continue
    }
    // Independent specialists can work together. Output joins still wait for
    // every upstream step, and all database checkpoints remain serial.
    if (f.run) f.run.cutEdges = [...cutEdges]
    f.memory = { ...mem }
    const ready = nodes.filter(candidate => candidate.type === 'agent' && !completedAgents.has(candidate.id) && results[candidate.id] == null && !failed.has(candidate.id) && !cut.has(candidate.id) &&
      (!(deps.get(candidate.id) || []).length || (liveDeps(candidate.id).length > 0 && liveDeps(candidate.id).every(id => results[id] != null && !failed.has(id) && !cut.has(id)))))
    const batch = [node, ...ready.filter(candidate => candidate.id !== nid)].slice(0, 3)
    for (const candidate of batch) completedAgents.add(candidate.id)
    await onProgress?.(Object.keys(results).length, stepTotal, batch.map(n => n.label || n.roleTitle || n.agent || 'step').join(' + '))
    await Promise.all(batch.map(async node => {
      const nid = node.id
      const input = liveDeps(nid).map(id => results[id]).filter(Boolean).join('\n\n---\n\n')
      let prompt = tpl((node.prompt || '').trim() || `You are the "${node.label || node.agent || 'agent'}" step in a pipeline. Do your specialty on the input.`, input)
      if (!(node.prompt || '').includes('{{input}}') && input) prompt += `\n\n--- INPUT FROM THE PREVIOUS AGENT ---\n${input}`
      const prev = previousResults[nid]
      if (prev) prompt += `\n\n--- YOUR PREVIOUS WORK (build on it, update what changed, never repeat verbatim) ---\n${prev.slice(0, 3000)}`
      // Role + company + notes context (mirrors the client) so scheduled runs are
      // just as accurate — the user's company notes and per-agent notes are honored.
      const title = node.roleTitle || ROLE_TITLES[node.role || ''] || ''
      const co = f.company
      const charter = [
        title ? `You are the ${title} of "${f.name || 'the company'}".` : '',
        co?.what ? `THE COMPANY: ${co.what}` : '',
        co?.mission ? `THE MANDATE: ${co.mission}` : '',
        co?.notes ? `IMPORTANT COMPANY NOTES — hard rules that OVERRIDE defaults, follow exactly: ${co.notes}` : '',
        node.roleNotes ? `HOW YOU MUST WORK — exact instructions for you that OVERRIDE defaults: ${node.roleNotes}` : '',
      ].filter(Boolean).join(' ')
      if (charter) prompt = `${charter}\n\nYOUR TASK:\n${prompt}`
      // A reference document the user attached to this flow — authoritative context.
      if (f.refDoc?.text?.trim()) {
        prompt = `REFERENCE DOCUMENT the user attached for this pipeline — "${f.refDoc.name}". Treat it as authoritative context and ground your work in it:\n"""\n${f.refDoc.text.slice(0, 12000)}\n"""\n\n${prompt}`
      }
      if (node.refDoc?.text?.trim()) prompt = `REFERENCE FOR THIS STEP — ${node.refDoc.name || 'Attached document'}:\n${node.refDoc.text.slice(0, 12000)}\n\n${prompt}`
      const startedAt = Date.now()
      try {
        const evidence = node.webSearch === false ? '' : await groundFromPrompt((node.prompt || '').replace(/\{\{[^}]+\}\}/g, '').trim())
        if (evidence) prompt = `${evidence}\n\nTASK AND INPUT:\n${prompt}`
        const out = await chatComplete([{ role: 'user', content: prompt }], { maxTokens: 2200, timeoutMs: NODE_TIMEOUT_MS, temperature: 0.6 })
        if (out && out.trim()) results[nid] = out.slice(0, 24000)
        else { failed.add(nid); firstError ||= `"${node.label || nid}" returned nothing` }
      } catch (e) {
        // A step that hangs past the timeout is BROKEN (stuck), not retried forever.
        const elapsed = Date.now() - startedAt
        failed.add(nid)
        if (elapsed >= NODE_TIMEOUT_MS * 0.9) { stuck.add(nid); firstError ||= `"${node.label || nid}" got stuck` }
        else firstError ||= `"${node.label || nid}" failed: ${e instanceof Error ? e.message : 'error'}`
      }
    }))
    await onProgress?.(Object.keys(results).length, stepTotal, `Completed ${batch.map(n => n.label || n.agent || 'step').join(' + ')}`)
  }
  if (await shouldStop?.()) return { results, status: 'stopped', memory: mem, cutEdges: [...cutEdges] }
  const status: FlowRun['status'] = stuck.size ? 'stuck' : failed.size ? 'error' : 'done'
  return { results, status, error: firstError || undefined, memory: mem, cutEdges: [...cutEdges] }
}

// ── On-demand single-flow runner (mobile "Run now" / "Continue" / "Stop") ─────
// Runs ONE of a user's flows immediately, updating a per-user task-ledger row per
// node so the phone shows "where things are at" live, and writing the flow's
// results + run-state back (same encoding runDueCrons uses). Everything is scoped
// to userId — a flow id that isn't in this user's row is never touched.
type MinimalClient = CloudflareStore | { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

function deepParseFlows(v: unknown): Flow[] | null {
  let cur: unknown = v
  for (let i = 0; i < 6; i++) {
    if (Array.isArray(cur)) return cur as Flow[]
    if (typeof cur !== 'string') return null
    try { cur = JSON.parse(cur) } catch { return null }
  }
  return Array.isArray(cur) ? (cur as Flow[]) : null
}

// Merge only this flow's execution state under a row lock. A simultaneous stop
// or a save from another device must survive the worker's progress heartbeat.
async function saveFlow(client: MinimalClient, userId: string, flow: Flow, active = false, lease?: string, observedStartedAt?: number): Promise<boolean> {
  if (client instanceof CloudflareStore) return new CloudflareFlows(client).save(userId, flow, active, lease!, observedStartedAt)
  await client.query('BEGIN')
  try {
    const row = await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-agent-flows' FOR UPDATE", [userId])
    const latest = deepParseFlows(row.rows[0]?.value)
    const idx = latest?.findIndex((item) => String(item.id) === String(flow.id)) ?? -1
    if (!latest || idx < 0) { await client.query('ROLLBACK'); return false }
    const current = latest[idx]
    if (active && current.run?.startedAt && current.run.startedAt !== flow.run?.startedAt) {
      await client.query('ROLLBACK'); return false
    }
    if (active && current.run?.status === 'stopped' && flow.run) flow.run.status = 'stopped'
    const runDays = new Map((flow.nodes || []).map((node) => [node.id, node.lastRunDay]))
    latest[idx] = { ...current, results: flow.results, run: flow.run, lastRun: flow.lastRun, memory: flow.memory, approvals: flow.approvals, artifacts: flow.artifacts,
      nodes: current.nodes?.map((node) => runDays.get(node.id) ? { ...node, lastRunDay: runDays.get(node.id) } : node) }
    await client.query(
      "UPDATE nalu_user_data SET value=$2,updated_at=NOW() WHERE user_id=$1 AND key='nalu-agent-flows'",
      [userId, JSON.stringify(latest)],
    )
    await client.query('COMMIT')
    return flow.run?.status !== 'stopped'
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
}

// Upsert one row in the AutoPilot task ledger (mirrors data.ts task-log; used
// here so we don't import across route files). Scoped to userId.
async function ledger(
  client: MinimalClient, userId: string, id: string,
  f: { source?: string; title?: string; detail?: string | null; status?: string | null; progress?: number | null; event?: string | null }, lease?: { flowId: string; token: string },
): Promise<void> {
  if (client instanceof CloudflareStore) { await new CloudflareTaskLedger(client).log(userId, id, { ...f, source: f.source || 'pipeline' }, lease); return }
  await client.query(
    `INSERT INTO nalu_tasks (id, user_id, source, title, detail, status, progress, events, meta, updated_at)
     VALUES ($1, $2, COALESCE($3,'pipeline'), COALESCE($4,''), $5, COALESCE($6,'running'), COALESCE($7::real,0),
             CASE WHEN $8::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $8::text)) END,
             '{}'::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       title      = CASE WHEN $4 IS NOT NULL AND $4 <> '' THEN EXCLUDED.title ELSE nalu_tasks.title END,
       detail     = COALESCE($5, nalu_tasks.detail),
       status     = COALESCE($6, nalu_tasks.status),
       progress   = COALESCE($7::real, nalu_tasks.progress),
       events     = CASE WHEN $8::text IS NULL THEN nalu_tasks.events
                         ELSE nalu_tasks.events || jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $8::text)) END,
       updated_at = NOW()
     WHERE nalu_tasks.user_id = $2`,
    [id, userId, f.source ?? null, f.title ?? null, f.detail ?? null, f.status ?? null, f.progress ?? null, f.event ?? null],
  )
}

const stepCount = (f: Flow): number => (f.nodes || []).length

type RunSource = { lease?: string; scheduledAt?: number; hook?: { secret: string; payload: string } }

/** One server runner per account and flow. A stop bypasses the runner lock so
 * it can interrupt the owner; the owner observes it between nodes. */
export async function runOneFlow(
  client: MinimalClient, userId: string, flowId: string, mode: 'run' | 'resume' | 'stop', force = false, source: RunSource = {},
): Promise<{ ok: boolean; status?: string; step?: number; total?: number; error?: string; code?: number }> {
  if (mode === 'stop') return runOneFlowUnlocked(client, userId, flowId, mode, force)
  if (client instanceof CloudflareStore) {
    const flows = new CloudflareFlows(client), lease = await flows.claim(userId, flowId)
    if (!lease) return { ok: false, error: 'a server worker already owns this run', code: 409 }
    try { return await runOneFlowUnlocked(client, userId, flowId, mode, force, { ...source, lease }) }
    finally { await flows.release(userId, flowId, lease).catch(() => {}) }
  }
  const lockKey = JSON.stringify([userId, flowId])
  const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey])
  if (!lock.rows[0]?.locked) return { ok: false, error: 'a server worker already owns this run', code: 409 }
  try { return await runOneFlowUnlocked(client, userId, flowId, mode, force, source) }
  finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]).catch(() => {}) }
}

/** Run / resume / stop one flow for a user. mode: 'run' (fresh), 'resume', 'stop'. */
async function runOneFlowUnlocked(
  client: MinimalClient, userId: string, flowId: string, mode: 'run' | 'resume' | 'stop', force = false, source: RunSource = {},
): Promise<{ ok: boolean; status?: string; step?: number; total?: number; error?: string; code?: number }> {
  const flows = deepParseFlows(await readFlows(client, userId))
  if (!flows) return { ok: false, error: 'no pipelines for this account', code: 404 }
  const idx = flows.findIndex((f) => String(f.id) === String(flowId))
  if (idx < 0) return { ok: false, error: 'pipeline not found', code: 404 }
  const f = flows[idx]
  const observedStartedAt = f.run?.startedAt
  const now = Date.now()
  // Recheck schedule and hook authorization under the same ownership lock used
  // by manual runs. Concurrent cron requests cannot launch a second fresh run.
  if (source.scheduledAt != null) {
    const orphan = isOrphanedRun(f, source.scheduledAt)
    if (!isDue(f, source.scheduledAt) && !orphan) return { ok: false, error: 'pipeline is no longer due', code: 409 }
    mode = orphan ? 'resume' : 'run'
  }
  if (source.hook) {
    if (!f.apiEnabled) return { ok: false, error: 'this pipeline is not exposed as a webhook', code: 403 }
    if (!f.apiSecret || f.apiSecret !== source.hook.secret) return { ok: false, error: 'bad or missing secret', code: 401 }
  }

  // A live browser tab owns the run if its heartbeat is fresh — don't stomp it.
  const ownedByLiveTab = f.run?.status === 'running' && now - (f.run.heartbeat || 0) < ORPHAN_MS
  if (mode === 'stop') {
    if (client instanceof CloudflareStore) return new CloudflareFlows(client).stop(userId, flowId, f.run?.startedAt)
    // A worker may finish a checkpoint after our initial read. Stop only the
    // originally observed run and update its latest status under the row lock;
    // writing our earlier snapshot would discard its results and saved files.
    await client.query('BEGIN')
    try {
      const row = await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-agent-flows' FOR UPDATE", [userId])
      const latest = deepParseFlows(row.rows[0]?.value)
      const current = latest?.find((item) => String(item.id) === String(flowId))
      if (!latest || !current) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'pipeline not found', code: 404 }
      }
      if (current.run?.startedAt !== f.run?.startedAt) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'a newer run has started; refresh before stopping it', code: 409 }
      }
      current.run = { ...(current.run || { step: 0, total: stepCount(current), startedAt: now }), status: 'stopped', heartbeat: now, updatedAt: now }
      await client.query("UPDATE nalu_user_data SET value=$2,updated_at=NOW() WHERE user_id=$1 AND key='nalu-agent-flows'", [userId, JSON.stringify(latest)])
      // An approval pause or orphan has no worker left to settle its activity.
      // Cancel that run's existing task in this same transaction. Preserve
      // terminal history and never create a separate, misleading stop task.
      if (current.run.startedAt != null) await client.query(
        `UPDATE nalu_tasks SET status='cancelled', detail='Stopped from mobile',
           events=events || jsonb_build_array(jsonb_build_object('t', NOW(), 'm', 'Stopped from mobile')),
           updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND status IN ('queued','running','waiting')`,
        [`flow_${current.id}_${current.run.startedAt}`, userId],
      )
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    return { ok: true, status: 'stopped' }
  }
  if (ownedByLiveTab && !force) return { ok: false, error: 'a live session already owns this run', code: 409 }

  const total = stepCount(f)
  // Recurring agents build on their last report, while the new run still has
  // empty completion/approval checkpoints and must execute each node again.
  const previousWork = source.scheduledAt != null && mode === 'run' ? { ...f.results } : undefined
  const startedAt = mode === 'resume' ? f.run?.startedAt || now : Math.max(now, (f.run?.startedAt || 0) + 1)
  const taskId = `flow_${f.id}_${startedAt}`
  if (mode === 'run') { f.results = {}; f.run = undefined; f.approvals = {}; f.artifacts = {} } // fresh: re-run every node and request fresh decisions
  if (source.hook?.payload) {
    const trigger = f.nodes?.find((node) => node.type === 'trigger')
    if (trigger) f.results = { [trigger.id]: source.hook.payload.slice(0, 24000) }
  }
  // resume: keep f.results; mark running so runFlow's skip keeps finished steps
  f.run = { status: 'running', step: mode === 'resume' ? Object.keys(f.results || {}).length : 0, total, startedAt, updatedAt: now, heartbeat: now, cutEdges: f.run?.cutEdges } as FlowRun
  if (!await saveFlow(client, userId, f, false, source.lease, observedStartedAt)) return { ok: false, error: 'pipeline changed before the run started', code: 409 }
  const lease = source.lease ? { flowId, token: source.lease } : undefined
  const activitySource = source.scheduledAt != null ? 'flywheel' : 'pipeline'
  const startedVia = source.scheduledAt != null ? 'Started scheduled run' : source.hook ? 'Started by webhook' : 'Started from mobile'
  await ledger(client, userId, taskId, { source: activitySource, title: f.name || 'AutoPilot', status: 'running', progress: 0, detail: mode === 'resume' ? 'Resuming…' : 'Starting…', event: mode === 'resume' ? 'Resumed from checkpoint' : startedVia }, lease)

  const onProgress: ProgressFn = async (step, tot, label) => {
    f.run = { ...f.run, status: 'running', step, total: tot, startedAt, updatedAt: Date.now(), heartbeat: Date.now(), nodeLabel: label } as FlowRun
    await ledger(client, userId, taskId, { detail: `${label} · step ${step}/${tot}`, progress: tot ? step / tot : 0, event: label }, lease)
    await saveResults(client, userId, taskId, f.results || {}, lease)
    await saveFlow(client, userId, f, true, source.lease)
  }
  const shouldStop = async () => {
    if (client instanceof CloudflareStore && !await new CloudflareFlows(client).renew(userId, flowId, source.lease!)) return true
    const current = deepParseFlows(await readFlows(client, userId))?.find((flow) => String(flow.id) === String(flowId))
    return !current || current.run?.status === 'stopped' || (!!current.run?.startedAt && current.run.startedAt !== startedAt)
  }
  const { results, status, error, memory, node, nodeLabel, cutEdges } = await runFlow(f, onProgress, shouldStop, { client, userId, runId: taskId, startedAt }, previousWork)
  f.results = results
  await saveResults(client, userId, taskId, results, lease)
  if (memory) f.memory = memory
  f.lastRun = Date.now()
  const completed = (f.nodes || []).filter((node) => results[node.id] != null).length
  f.run = { status, step: status === 'done' ? total : completed, total, startedAt, updatedAt: Date.now(), heartbeat: Date.now(), error, node, nodeLabel, cutEdges } as FlowRun
  const day = new Date(now).toDateString()
  f.nodes = (f.nodes || []).map((n) => (n.type === 'agent' && results[n.id] != null ? { ...n, lastRunDay: day } : n))
  await saveFlow(client, userId, f, true, source.lease)
  const finalStatus = f.run.status === 'stopped' ? 'cancelled' : status === 'awaiting' ? 'waiting' : error || status === 'error' || status === 'stuck' ? 'failed' : 'done'
  const detail = finalStatus === 'cancelled' ? 'Stopped' : finalStatus === 'waiting' ? `Waiting for your approval: ${nodeLabel || 'Approval'}` : error ? `Failed: ${String(error).slice(0, 160)}` : `Done · ${total} step${total === 1 ? '' : 's'}`
  await ledger(client, userId, taskId, { status: finalStatus, progress: finalStatus === 'done' ? 1 : total ? completed / total : 0, detail, event: detail }, lease)
  return { ok: finalStatus !== 'failed', status: finalStatus === 'cancelled' ? 'stopped' : status === 'awaiting' ? 'awaiting' : finalStatus, step: finalStatus === 'done' ? total : completed, total, ...(finalStatus === 'failed' ? { error: error || 'pipeline failed', code: 500 } : {}) }
}

export async function runDueCrons(client: MinimalClient): Promise<{ usersChecked: number; flowsRan: number }> {
  const now = Date.now()
  const rows = client instanceof CloudflareStore ? await new CloudflareFlows(client).all() : (await client.query("SELECT user_id, value FROM nalu_user_data WHERE key = 'nalu-agent-flows'")).rows
  let flowsRan = 0
  for (const row of rows) {
    for (const f of deepParseFlows(row.value) || []) {
      if (!isDue(f, now) && !isOrphanedRun(f, now)) continue
      const result = await runOneFlow(client, String(row.user_id), f.id, 'run', false, { scheduledAt: now })
      if (result.status) flowsRan++
    }
  }
  return { usersChecked: rows.length, flowsRan }
}

// Inbound hooks share run ownership, durable checkpoints and explicit approvals
// with scheduled/manual runs. Payloads never bypass downstream approval nodes.
export async function runFlowByHook(
  client: MinimalClient, flowId: string, secret: string, payload: string,
): Promise<{ ok: boolean; status?: number; output?: string; error?: string }> {
  const rows = client instanceof CloudflareStore ? await new CloudflareFlows(client).all() : (await client.query("SELECT user_id, value FROM nalu_user_data WHERE key = 'nalu-agent-flows'")).rows
  for (const row of rows) {
    const f = deepParseFlows(row.value)?.find((flow) => String(flow.id) === String(flowId))
    if (!f) continue
    const userId = String(row.user_id)
    const result = await runOneFlow(client, userId, flowId, 'run', false, { hook: { secret, payload } })
    if (!result.ok) return { ok: false, status: result.code || 500, error: result.error || 'Pipeline did not complete.' }
    const saved = deepParseFlows(await readFlows(client, userId))?.find((flow) => String(flow.id) === String(flowId))
    if (!saved) return { ok: false, status: 404, error: 'pipeline not found' }
    if (result.status === 'awaiting') return { ok: true, status: 202, output: `Waiting for your approval: ${saved.run?.nodeLabel || 'Approval'}` }
    if (result.status === 'stopped') return { ok: false, status: 409, error: 'Pipeline was stopped.' }
    const outIds = new Set((saved.edges || []).map((edge) => edge.from))
    const results = saved.results || {}
    const leaves = (saved.nodes || []).filter((node) => !outIds.has(node.id)).map((node) => results[node.id]).filter(Boolean)
    const output = (leaves[leaves.length - 1] || Object.values(results).filter(Boolean).pop() || '').slice(0, 24000)
    return { ok: true, status: 200, output }
  }
  return { ok: false, status: 404, error: 'pipeline not found' }
}

async function readFlows(client: MinimalClient, userId: string): Promise<unknown> {
  return client instanceof CloudflareStore ? new CloudflareFlows(client).read(userId) : (await client.query("SELECT value FROM nalu_user_data WHERE user_id=$1 AND key='nalu-agent-flows'", [userId])).rows[0]?.value
}
async function saveResults(client: MinimalClient, userId: string, taskId: string, results: Record<string,string>, lease?: { flowId: string; token: string }) {
  if (client instanceof CloudflareStore) return new CloudflareFlows(client).results(userId,taskId,results,lease)
  await client.query("UPDATE nalu_tasks SET meta=meta||$3::jsonb WHERE user_id=$1 AND id=$2", [userId,taskId,JSON.stringify({results})])
}
