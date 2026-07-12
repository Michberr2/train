// Server-side scheduler: runs AutoPilot flows on their schedule EVEN WHEN THE
// SITE IS CLOSED. Vercel Cron (or any external pinger) hits this; it reads every
// user's flows from the DB, runs the ones that are due, and writes the results
// back so they're waiting when the user next opens n4lu.com / n4lu.ai.
import { chatComplete } from './_llm'

type Edge = { from: string; to: string }
type PNode = { id: string; type?: string; agent?: string; role?: string; prompt?: string; label?: string; lastRunDay?: string; roleTitle?: string; roleNotes?: string }
type Company = { what?: string; mission?: string; notes?: string }
type FlowRun = { status: 'running' | 'done' | 'error' | 'stuck' | 'stopped'; step?: number; total?: number; startedAt?: number; updatedAt?: number; heartbeat?: number; node?: string; nodeLabel?: string; error?: string }
type Flow = {
  id: string; name?: string; nodes?: PNode[]; edges?: Edge[]
  schedule?: 'manual' | 'hourly' | 'daily' | 'weekly' | 'continuous' | 'members'
  time?: string; enabled?: boolean; lastRun?: number; results?: Record<string, string>; company?: Company; run?: FlowRun
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
  if (!f.enabled || f.schedule === 'manual' || !f.nodes?.length) return false
  const last = f.lastRun || 0
  if (f.schedule === 'continuous') return now - last > 1_800_000 // ~30 min
  if (f.schedule === 'hourly') return now - last > 3_300_000 // ~55 min
  if (f.schedule === 'daily' || f.schedule === 'members') {
    const d = new Date(now)
    const [hh, mm] = (f.time || '08:00').split(':').map((n) => parseInt(n, 10) || 0)
    const scheduled = new Date(d); scheduled.setHours(hh, mm, 0, 0)
    const ranToday = last > 0 && new Date(last).toDateString() === d.toDateString()
    return now >= scheduled.getTime() && !ranToday
  }
  if (f.schedule === 'weekly') {
    const d = new Date(now)
    const ranThisWeek = last > 0 && now - last < 6 * 86_400_000
    return d.getDay() === 1 && !ranThisWeek // Monday
  }
  return false
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

async function runFlow(f: Flow): Promise<{ results: Record<string, string>; status: FlowRun['status']; error?: string }> {
  const nodes = f.nodes || [], edges = f.edges || []
  const deps = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.to === n.id).map((e) => e.from)]))
  // RESUME: keep every step already finished (e.g. by the tab before it closed).
  const results: Record<string, string> = { ...(f.results || {}) }
  const failed = new Set<string>()
  const stuck = new Set<string>()
  let firstError = ''
  for (const nid of topoOrder(nodes, edges)) {
    const node = nodes.find((n) => n.id === nid)
    if (!node || node.type !== 'agent') continue // outputs (docs/sheets/video) are built client-side; agents produce the deliverable text here
    // Fail-fast: if any upstream step failed/got stuck, this step can't run.
    if ((deps.get(nid) || []).some((d) => failed.has(d))) { failed.add(nid); continue }
    // Orphan RESUME only: skip steps the closed tab already finished. A scheduled
    // (due) run always re-runs every step so it refreshes daily.
    if (f.run?.status === 'running' && results[nid] != null) continue
    const input = (deps.get(nid) || []).map((d) => results[d]).filter(Boolean).join('\n\n---\n\n')
    let prompt = (node.prompt || '').trim() || `You are the "${node.label || node.agent || 'agent'}" step in a pipeline. Do your specialty on the input.`
    if (prompt.includes('{{input}}')) prompt = prompt.split('{{input}}').join(input || '(no upstream input)')
    else if (input) prompt += `\n\n--- INPUT FROM THE PREVIOUS AGENT ---\n${input}`
    const prev = f.results?.[nid]
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
    const startedAt = Date.now()
    try {
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
  }
  const status: FlowRun['status'] = stuck.size ? 'stuck' : failed.size ? 'error' : 'done'
  return { results, status, error: firstError || undefined }
}

export async function runDueCrons(client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<{ user_id: string; value: string }> }> }): Promise<{ usersChecked: number; flowsRan: number }> {
  const now = Date.now()
  let usersChecked = 0, flowsRan = 0
  const rows = (await client.query("SELECT user_id, value FROM nalu_user_data WHERE key = 'nalu-agent-flows'")).rows
  usersChecked = rows.length
  for (const row of rows) {
    let flows: Flow[]
    try { flows = JSON.parse(row.value) } catch { continue }
    if (!Array.isArray(flows)) continue
    let changed = false
    for (const f of flows) {
      const due = isDue(f, now)
      const orphan = isOrphanedRun(f, now) // a run whose tab closed mid-flight — take it over
      if (!due && !orphan) continue
      const total = topoOrder(f.nodes || [], f.edges || []).length
      // AutoPilot ledger (per-user): show the run as it happens on the phone —
      // a 'running' row now, flipped to done/failed below. Best-effort.
      const runId = `flow_${f.id}_${now}`
      try {
        await client.query(
          `INSERT INTO nalu_tasks (id, user_id, source, title, detail, status, progress, updated_at)
           VALUES ($1, $2, 'flywheel', $3, $4, 'running', 0, NOW()) ON CONFLICT (id) DO NOTHING`,
          [runId, row.user_id, (f.name || 'Automation').slice(0, 300), `${total} agent step${total === 1 ? '' : 's'}`],
        )
      } catch { /* ledger is best-effort */ }
      const { results, status, error } = await runFlow(f)
      try {
        await client.query(
          `UPDATE nalu_tasks SET status = $2, progress = 1,
             events = events || jsonb_build_array(jsonb_build_object('t', NOW(), 'm', $3::text)),
             updated_at = NOW() WHERE id = $1`,
          [runId, error ? 'failed' : 'done', error ? `Failed: ${String(error).slice(0, 200)}` : 'Completed'],
        )
      } catch { /* ledger is best-effort */ }
      f.results = results
      f.lastRun = now
      // Record a terminal run state so the client shows it finished (or broke)
      // and doesn't try to resume something the server already completed.
      f.run = { status, step: total, total, startedAt: f.run?.startedAt || now, updatedAt: now, heartbeat: now, error }
      const day = new Date(now).toDateString()
      f.nodes = (f.nodes || []).map((n) => (n.type === 'agent' ? { ...n, lastRunDay: day } : n))
      changed = true; flowsRan++
    }
    if (changed) {
      await client.query(
        "INSERT INTO nalu_user_data (user_id, key, value, updated_at) VALUES ($1, 'nalu-agent-flows', $2, NOW()) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
        [row.user_id, JSON.stringify(flows)],
      )
    }
  }
  return { usersChecked, flowsRan }
}
