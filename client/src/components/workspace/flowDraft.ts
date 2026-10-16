// Normalize AI plans before they can reach the persisted flow/runtime model.
export type DraftNode = { id: string; type: string; label: string; prompt: string; x: number; y: number; [key: string]: unknown }
export type DraftEdge = { from: string; to: string; label?: string }
export type FlowDraft = { name: string; schedule: 'manual' | 'hourly' | 'daily' | 'weekly'; time: string; enabled: false; nodes: DraftNode[]; edges: DraftEdge[] }
const stringFields = ['agent', 'to', 'subject', 'platform', 'webhook', 'format', 'connectionId', 'triggerKind', 'routeBy', 'condMode', 'cond', 'approveVia', 'method', 'url', 'headers', 'memKey', 'memOp', 'splitBy', 'roleTitle', 'roleNotes']
const outputAliases: Record<string, string> = {
  doc: 'doc', document: 'doc', docx: 'doc', word: 'doc', 'word document': 'doc', pdf: 'pdf',
  slides: 'slides', pptx: 'slides', powerpoint: 'slides', presentation: 'slides',
  sheet: 'sheet', spreadsheet: 'sheet', xlsx: 'sheet', excel: 'sheet',
  markdown: 'markdown', md: 'markdown', textfile: 'textfile', 'text file': 'textfile', text: 'textfile', txt: 'textfile', 'plain text': 'textfile',
  website: 'website', html: 'website', webpage: 'website', email: 'email', eml: 'email',
  calendar: 'calendar', ics: 'calendar', contacts: 'contacts', vcf: 'contacts', mailrules: 'mailrules',
  csv: 'csv', json: 'json', image: 'image', png: 'image', jpg: 'image', jpeg: 'image', video: 'video', mp4: 'video', social: 'social',
}
const stepName = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase().replace(/^\./, '').replace(/[_-]+/g, ' ') : ''
function normalizeStepType(value: Record<string, any>, types: string[]) {
  const raw = stepName(value.type || value.kind || 'agent')
  if (types.includes(raw)) return raw
  if (['output', 'artifact', 'file', 'deliverable'].includes(raw)) {
    const output = value.output && typeof value.output === 'object' ? value.output : {}
    const hint = [value.outputType, value.output_type, value.artifactType, value.artifact_type, output.type, output.kind, output.format, typeof value.output === 'string' ? value.output : '', value.format, value.kind !== value.type ? value.kind : ''].map(stepName).find(name => name && !['output', 'artifact', 'file', 'deliverable'].includes(name))
    const concrete = hint ? outputAliases[hint] : types.includes('markdown') ? 'markdown' : 'textfile'
    if (concrete && types.includes(concrete)) return concrete
    throw new Error(`The plan requested an unsupported output format: ${hint || 'unspecified'}.`)
  }
  const alias = outputAliases[raw]
  if (alias && types.includes(alias)) return alias
  throw new Error(`The plan used an unsupported step: ${raw}.`)
}
export function parseFlowDraft(raw: string, types: string[], agents: string[], uid: () => string): FlowDraft {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) throw new Error('No flow plan was returned. Try describing the input and desired result.')
  const plan = JSON.parse(json)
  if (!Array.isArray(plan.nodes) || !plan.nodes.length || plan.nodes.length > 16) throw new Error('A flow needs between 1 and 16 complete steps.')
  const ids = new Map<string, string>()
  const nodes: DraftNode[] = plan.nodes.map((entry: any, index: number) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Step ${index + 1} is incomplete.`)
    const value = { ...(entry.config && typeof entry.config === 'object' ? entry.config : {}), ...entry }
    const type = normalizeStepType(value, types)
    const logicalId = String(value.id || `step${index + 1}`)
    if (ids.has(logicalId)) throw new Error(`The plan repeated step ID ${logicalId}. Try rebuilding it.`)
    const id = uid(); ids.set(logicalId, id)
    const node: DraftNode = { id, type, label: String(value.label || `Step ${index + 1}`).slice(0, 100), prompt: String(value.prompt || ''), x: 40, y: 40 }
    for (const field of stringFields) if (typeof value[field] === 'string') node[field] = value[field]
    if (type === 'agent' || type === 'foreach' || type === 'planner') node.agent = agents.includes(String(value.agent)) ? value.agent : 'general'
    if (typeof value.webSearch === 'boolean') node.webSearch = value.webSearch
    if (typeof value.useTools === 'boolean') node.useTools = value.useTools
    if (typeof value.auto === 'boolean') node.auto = value.auto
    if (Number.isFinite(value.maxItems)) node.maxItems = Math.max(1, Math.min(20, Math.floor(value.maxItems)))
    if (Number.isFinite(value.maxSteps)) node.maxSteps = Math.max(1, Math.min(12, Math.floor(value.maxSteps)))
    if (Array.isArray(value.branches)) node.branches = value.branches.slice(0, 8).map((b: any) => ({ label: String(b.label || '').trim(), ...(typeof b.cond === 'string' ? { cond: b.cond } : {}) })).filter((b: any) => b.label)
    return node
  })
  if (!Array.isArray(plan.edges) && nodes.some(n => n.type === 'router')) throw new Error('This branching flow is missing its connections. Try rebuilding the plan.')
  const edges: DraftEdge[] = Array.isArray(plan.edges) ? plan.edges.map((edge: any) => {
    const from = ids.get(String(edge.from)), to = ids.get(String(edge.to))
    if (!from || !to || from === to) throw new Error('The plan contains a connection to a missing step or itself.')
    return { from, to, ...(typeof edge.label === 'string' && edge.label.trim() ? { label: edge.label.trim() } : {}) }
  }) : nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }))
  const seen = new Set<string>()
  for (const edge of edges) {
    const key = `${edge.from}>${edge.to}`
    if (seen.has(key)) throw new Error('The plan repeats a connection. Try rebuilding it.')
    seen.add(key)
    const source = nodes.find(n => n.id === edge.from)!
    if (source.type === 'router' && !(source.branches as { label: string }[] || []).some(b => b.label === edge.label)) throw new Error(`Choose a valid branch for the connection leaving ${source.label}.`)
  }
  for (const node of nodes.filter(n => n.type === 'router')) {
    const branches = node.branches as { label: string }[] || []
    if (branches.length < 2 || new Set(branches.map(b => b.label)).size !== branches.length || branches.some(b => !edges.some(e => e.from === node.id && e.label === b.label))) throw new Error(`${node.label} needs at least two distinct branches, each connected to a step.`)
  }
  const indegree = new Map(nodes.map(n => [n.id, edges.filter(e => e.to === n.id).length]))
  const queue = nodes.filter(n => !indegree.get(n.id)).map(n => n.id)
  const levels = new Map(queue.map(id => [id, 0])); let visited = 0
  while (queue.length) {
    const id = queue.shift()!; visited++
    for (const e of edges.filter(e => e.from === id)) {
      levels.set(e.to, Math.max(levels.get(e.to) || 0, (levels.get(id) || 0) + 1))
      indegree.set(e.to, indegree.get(e.to)! - 1)
      if (!indegree.get(e.to)) queue.push(e.to)
    }
  }
  if (visited !== nodes.length) throw new Error('The plan contains a loop. Use a For each step for repeated work.')
  const rows = new Map<number, number>()
  for (const node of nodes) { const level = levels.get(node.id) || 0; const row = rows.get(level) || 0; rows.set(level, row + 1); node.x = 40 + level * 340; node.y = 40 + row * 260 }
  return { name: String(plan.name || 'New flow').slice(0, 100), schedule: ['manual', 'hourly', 'daily', 'weekly'].includes(plan.schedule) ? plan.schedule : 'manual', time: /^([01]\d|2[0-3]):[0-5]\d$/.test(plan.time) ? plan.time : '08:00', enabled: false, nodes, edges }
}
