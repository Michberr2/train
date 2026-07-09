// Server-side scheduler: runs AutoPilot flows on their schedule EVEN WHEN THE
// SITE IS CLOSED. Vercel Cron (or any external pinger) hits this; it reads every
// user's flows from the DB, runs the ones that are due, and writes the results
// back so they're waiting when the user next opens n4lu.com / n4lu.ai.
import { chatComplete } from './_llm'

type Edge = { from: string; to: string }
type PNode = { id: string; type?: string; agent?: string; role?: string; prompt?: string; label?: string; lastRunDay?: string }
type Flow = {
  id: string; name?: string; nodes?: PNode[]; edges?: Edge[]
  schedule?: 'manual' | 'hourly' | 'daily' | 'weekly' | 'continuous' | 'members'
  time?: string; enabled?: boolean; lastRun?: number; results?: Record<string, string>
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

async function runFlow(f: Flow): Promise<Record<string, string>> {
  const nodes = f.nodes || [], edges = f.edges || []
  const deps = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.to === n.id).map((e) => e.from)]))
  const results: Record<string, string> = { ...(f.results || {}) }
  for (const nid of topoOrder(nodes, edges)) {
    const node = nodes.find((n) => n.id === nid)
    if (!node || node.type !== 'agent') continue // outputs (docs/sheets/video) are built client-side; agents produce the deliverable text here
    const input = (deps.get(nid) || []).map((d) => results[d]).filter(Boolean).join('\n\n---\n\n')
    let prompt = (node.prompt || '').trim() || `You are the "${node.label || node.agent || 'agent'}" step in a pipeline. Do your specialty on the input.`
    if (prompt.includes('{{input}}')) prompt = prompt.split('{{input}}').join(input || '(no upstream input)')
    else if (input) prompt += `\n\n--- INPUT FROM THE PREVIOUS AGENT ---\n${input}`
    const prev = f.results?.[nid]
    if (prev) prompt += `\n\n--- YOUR PREVIOUS WORK (build on it, update what changed, never repeat verbatim) ---\n${prev.slice(0, 3000)}`
    try {
      const out = await chatComplete([{ role: 'user', content: prompt }], { maxTokens: 2200, timeoutMs: 90000, temperature: 0.6 })
      if (out && out.trim()) results[nid] = out.slice(0, 24000)
    } catch { /* skip this node; the rest still run */ }
  }
  return results
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
      if (!isDue(f, now)) continue
      f.results = await runFlow(f)
      f.lastRun = now
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
