// nalu-client.ts
// Bridge from the web Dashboard (n4lu.com / n4lu.ai) to a user's locally-
// running Nalu (Odysseus) instance over HTTPS + Bearer token.
//
// Odysseus uses *server-side* chat sessions. Before /api/chat_stream will
// accept a message it needs:
//   1. A session row in the DB (POST /api/session with endpoint_id + model).
//   2. That session's `model` field non-empty.
// We hide that lifecycle behind `ensureSession()` so callers just see
// `streamChat({chatId, message})` and get an SSE Response back.
//
// SSE wire shape is translated on the fly so Dashboard.tsx's existing parser
// (event: delta / tool_call_delta / finish) keeps working unchanged.

export interface NaluPairing {
  host: string
  port: number
  token: string
  pairedAt: number
}

export interface NaluModel {
  endpointId: string
  endpointName: string
  endpointUrl: string
  model: string
  supportsTools: boolean
}

const STORAGE_PAIRING = 'nalu-pairing'
const STORAGE_MODEL = 'nalu-model' // last selected {endpointId, model}
const STORAGE_SESSIONS = 'nalu-sessions' // map<dashboardChatId, odysseusSessionId>

// ---------- Pairing ---------------------------------------------------------

export function getPairing(): NaluPairing | null {
  try {
    const raw = localStorage.getItem(STORAGE_PAIRING)
    if (!raw) return null
    const p = JSON.parse(raw) as NaluPairing
    if (!p.host || !p.port || !p.token) return null
    return p
  } catch {
    return null
  }
}

export function setPairing(p: NaluPairing): void {
  localStorage.setItem(STORAGE_PAIRING, JSON.stringify(p))
}

export function clearPairing(): void {
  localStorage.removeItem(STORAGE_PAIRING)
  localStorage.removeItem(STORAGE_MODEL)
  localStorage.removeItem(STORAGE_SESSIONS)
}

export function baseUrl(p: NaluPairing): string {
  // Always HTTPS: browsers block http://localhost from an https:// origin.
  // start-macos.sh provisions a mkcert-signed cert at boot.
  return `https://${p.host}:${p.port}`
}

function authHeaders(p: NaluPairing): Record<string, string> {
  return { Authorization: `Bearer ${p.token}` }
}

// ---------- Health ----------------------------------------------------------

export interface PingResult {
  ok: boolean
  name?: string
  version?: string
  error?: string
}

export async function ping(p: NaluPairing): Promise<PingResult> {
  try {
    const res = await fetch(`${baseUrl(p)}/api/companion/ping`, {
      headers: authHeaders(p),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const data = await res.json()
    return { ok: !!data.ok, name: data.name, version: data.version }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------- Models ---------------------------------------------------------

export async function getModels(p: NaluPairing): Promise<NaluModel[]> {
  const res = await fetch(`${baseUrl(p)}/api/companion/models`, {
    headers: authHeaders(p),
  })
  if (!res.ok) return []
  const data = await res.json()
  const eps = Array.isArray(data?.endpoints) ? data.endpoints : []
  const out: NaluModel[] = []
  for (const ep of eps) {
    const models: string[] = Array.isArray(ep.models) ? ep.models : []
    for (const m of models) {
      out.push({
        endpointId: String(ep.endpoint_id || ''),
        endpointName: String(ep.name || ''),
        endpointUrl: String(ep.endpoint_url || ''),
        model: m,
        supportsTools: !!ep.supports_tools,
      })
    }
  }
  return out
}

export interface SelectedModel {
  endpointId: string
  model: string
}

export function getSelectedModel(): SelectedModel | null {
  try {
    const raw = localStorage.getItem(STORAGE_MODEL)
    if (!raw) return null
    const m = JSON.parse(raw) as SelectedModel
    if (!m.endpointId || !m.model) return null
    return m
  } catch {
    return null
  }
}

export function setSelectedModel(m: SelectedModel): void {
  localStorage.setItem(STORAGE_MODEL, JSON.stringify(m))
  // Selecting a new model invalidates session mappings — they're pinned to a
  // specific endpoint+model server-side. Easier to drop and recreate.
  localStorage.removeItem(STORAGE_SESSIONS)
}

// ---------- Sessions -------------------------------------------------------

function getSessionMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_SESSIONS) || '{}')
  } catch {
    return {}
  }
}

function setSessionMap(m: Record<string, string>): void {
  localStorage.setItem(STORAGE_SESSIONS, JSON.stringify(m))
}

async function createSession(
  p: NaluPairing,
  endpointId: string,
  model: string,
): Promise<string> {
  const form = new FormData()
  form.set('endpoint_id', endpointId)
  form.set('model', model)
  form.set('name', 'web')
  // skip_validation: we trust the user's local install knows what models it
  // actually has — and probing /v1/models with the wrong creds can 401 in
  // local development.
  form.set('skip_validation', 'true')
  const res = await fetch(`${baseUrl(p)}/api/session`, {
    method: 'POST',
    headers: authHeaders(p),
    body: form,
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`createSession ${res.status}: ${txt.slice(0, 200)}`)
  }
  const data = await res.json()
  // Odysseus SessionResponse uses `id`.
  const id = String(data?.id || '')
  if (!id) throw new Error('Odysseus did not return a session id')
  return id
}

/** Lazily create-or-reuse an Odysseus session for a Dashboard chat. */
async function ensureSession(
  p: NaluPairing,
  dashboardChatId: string,
  endpointId: string,
  model: string,
): Promise<string> {
  const map = getSessionMap()
  const cached = map[dashboardChatId]
  if (cached) return cached
  const id = await createSession(p, endpointId, model)
  map[dashboardChatId] = id
  setSessionMap(map)
  return id
}

export function forgetSession(dashboardChatId: string): void {
  const map = getSessionMap()
  if (map[dashboardChatId]) {
    delete map[dashboardChatId]
    setSessionMap(map)
  }
}

// ---------- Memory --------------------------------------------------------

export interface NaluMemoryEntry {
  id: string
  text: string
  category?: string
  source?: string
  timestamp?: string
  pinned?: boolean
}

export async function getMemory(p: NaluPairing): Promise<NaluMemoryEntry[]> {
  const res = await fetch(`${baseUrl(p)}/api/memory`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`getMemory ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.memory) ? data.memory : []
  return list.map((m: Record<string, unknown>) => ({
    id: String(m.id ?? ''),
    text: String(m.text ?? ''),
    category: typeof m.category === 'string' ? m.category : undefined,
    source: typeof m.source === 'string' ? m.source : undefined,
    timestamp: typeof m.timestamp === 'string' ? m.timestamp : undefined,
    pinned: !!m.pinned,
  }))
}

export async function addMemory(
  p: NaluPairing,
  text: string,
  category: string = 'fact',
): Promise<void> {
  const form = new FormData()
  form.set('text', text)
  form.set('category', category)
  form.set('source', 'web-dashboard')
  const res = await fetch(`${baseUrl(p)}/api/memory/add`, {
    method: 'POST',
    headers: authHeaders(p),
    body: form,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`addMemory ${res.status}: ${t.slice(0, 200)}`)
  }
}

export async function deleteMemory(p: NaluPairing, id: string): Promise<void> {
  const res = await fetch(`${baseUrl(p)}/api/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`deleteMemory ${res.status}`)
}

// ---------- Endpoints -----------------------------------------------------

export interface NewEndpoint {
  baseUrl: string
  name?: string
  apiKey?: string
  /** false = scope to the pairing owner; true (default) = visible to all. */
  shared?: boolean
}

export interface AddedEndpoint {
  id: string
  name: string
  baseUrl: string
  models: string[]
  online: boolean
  status: string
}

export async function addEndpoint(
  p: NaluPairing,
  ep: NewEndpoint,
): Promise<AddedEndpoint> {
  const form = new FormData()
  form.set('base_url', ep.baseUrl)
  if (ep.name) form.set('name', ep.name)
  if (ep.apiKey) form.set('api_key', ep.apiKey)
  form.set('shared', ep.shared === false ? 'false' : 'true')
  // skip_probe=false (default) so Odysseus pings the URL and stores the
  // returned model list — avoids the user having to manually enter models.
  const res = await fetch(`${baseUrl(p)}/api/model-endpoints`, {
    method: 'POST',
    headers: authHeaders(p),
    body: form,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`addEndpoint ${res.status}: ${t.slice(0, 250)}`)
  }
  const data = await res.json()
  return {
    id: String(data?.id ?? ''),
    name: String(data?.name ?? ''),
    baseUrl: String(data?.base_url ?? ''),
    models: Array.isArray(data?.models) ? data.models : [],
    online: !!data?.online,
    status: String(data?.status ?? ''),
  }
}

// ---------- Chat streaming ------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
}

export interface StreamChatOpts {
  /** Stable per-Dashboard-chat id; we map it to an Odysseus session. */
  chatId: string
  /** The full message history the Dashboard knows about. Only the LAST user
   *  message is sent over the wire — Odysseus keeps history server-side. */
  messages: ChatMessage[]
  workspace?: string
  mode?: 'chat' | 'agent'
  signal?: AbortSignal
  /** Upload IDs (from uploadFiles) to attach to THIS turn only. */
  attachmentIds?: string[]
}

// ---------- Uploads -------------------------------------------------------

export interface UploadedFile {
  id: string
  name: string
  mime: string
  size: number
  width?: number
  height?: number
}

// ---------- Settings ------------------------------------------------------

/** Whole settings blob from /api/auth/settings. Admins see all keys;
 *  non-admins get a scrubbed copy with secrets blanked. */
export async function getSettings(p: NaluPairing): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl(p)}/api/auth/settings`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`getSettings ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

/** Admin-only. Patches keys in DEFAULT_SETTINGS — Odysseus ignores unknowns
 *  and clamps numeric ranges server-side. */
export async function setSettings(
  p: NaluPairing,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl(p)}/api/auth/settings`, {
    method: 'POST',
    headers: { ...authHeaders(p), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`setSettings ${res.status}: ${t.slice(0, 200)}`)
  }
  return (await res.json()) as Record<string, unknown>
}

// ---------- Notes ---------------------------------------------------------

export interface NaluNote {
  id: string
  title: string
  content: string
  pinned: boolean
  label?: string | null
  noteType?: string | null
  updatedAt?: string | null
}

export async function listNotes(p: NaluPairing): Promise<NaluNote[]> {
  const res = await fetch(`${baseUrl(p)}/api/notes`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`listNotes ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.notes) ? data.notes : []
  return list.map((n: Record<string, unknown>) => ({
    id: String(n.id ?? ''),
    title: String(n.title ?? ''),
    content: String(n.content ?? ''),
    pinned: !!n.pinned,
    label: typeof n.label === 'string' ? n.label : null,
    noteType: typeof n.note_type === 'string' ? n.note_type : null,
    updatedAt: typeof n.updated_at === 'string' ? n.updated_at : null,
  }))
}

export async function createNote(
  p: NaluPairing,
  body: { title: string; content?: string; pinned?: boolean },
): Promise<NaluNote> {
  const res = await fetch(`${baseUrl(p)}/api/notes`, {
    method: 'POST',
    headers: { ...authHeaders(p), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: body.title,
      content: body.content ?? '',
      pinned: !!body.pinned,
      note_type: 'note',
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`createNote ${res.status}: ${t.slice(0, 200)}`)
  }
  const n = (await res.json()) as Record<string, unknown>
  return {
    id: String(n.id ?? ''),
    title: String(n.title ?? ''),
    content: String(n.content ?? ''),
    pinned: !!n.pinned,
    label: typeof n.label === 'string' ? n.label : null,
    noteType: typeof n.note_type === 'string' ? n.note_type : null,
    updatedAt: typeof n.updated_at === 'string' ? n.updated_at : null,
  }
}

export async function deleteNote(p: NaluPairing, id: string): Promise<void> {
  const res = await fetch(`${baseUrl(p)}/api/notes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`deleteNote ${res.status}`)
}

// ---------- Tasks (scheduled) --------------------------------------------

export interface NaluTask {
  id: string
  name: string
  prompt?: string | null
  taskType: string
  schedule?: string | null
  nextRun?: string | null
  lastRun?: string | null
  status: string
  triggerType?: string | null
}

export async function listTasks(p: NaluPairing): Promise<NaluTask[]> {
  const res = await fetch(`${baseUrl(p)}/api/tasks`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`listTasks ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.tasks) ? data.tasks : []
  return list.map((t: Record<string, unknown>) => ({
    id: String(t.id ?? ''),
    name: String(t.name ?? ''),
    prompt: typeof t.prompt === 'string' ? t.prompt : null,
    taskType: String(t.task_type ?? 'llm'),
    schedule: typeof t.schedule === 'string' ? t.schedule : null,
    nextRun: typeof t.next_run === 'string' ? t.next_run : null,
    lastRun: typeof t.last_run === 'string' ? t.last_run : null,
    status: String(t.status ?? ''),
    triggerType: typeof t.trigger_type === 'string' ? t.trigger_type : null,
  }))
}

export async function pauseTask(p: NaluPairing, id: string): Promise<void> {
  const res = await fetch(
    `${baseUrl(p)}/api/tasks/${encodeURIComponent(id)}/pause`,
    { method: 'POST', headers: authHeaders(p) },
  )
  if (!res.ok) throw new Error(`pauseTask ${res.status}`)
}

export async function deleteTask(p: NaluPairing, id: string): Promise<void> {
  const res = await fetch(`${baseUrl(p)}/api/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`deleteTask ${res.status}`)
}

// ---------- Deep Research -------------------------------------------------

export interface NaluResearchEntry {
  id: string
  query: string
  category: string
  sourceCount: number
  status: string
  duration: string
  rounds: string | number
  startedAt: number
  completedAt: number
  archived: boolean
}

export async function listResearch(p: NaluPairing): Promise<NaluResearchEntry[]> {
  const res = await fetch(`${baseUrl(p)}/api/research/library`, {
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`listResearch ${res.status}`)
  const items = await res.json()
  if (!Array.isArray(items)) return []
  return items.map((r: Record<string, unknown>) => ({
    id: String(r.id ?? ''),
    query: String(r.query ?? ''),
    category: String(r.category ?? ''),
    sourceCount: Number(r.source_count ?? 0),
    status: String(r.status ?? 'done'),
    duration: String(r.duration ?? ''),
    rounds: (r.rounds as string | number) ?? '',
    startedAt: Number(r.started_at ?? 0),
    completedAt: Number(r.completed_at ?? 0),
    archived: !!r.archived,
  }))
}

/** Open the rendered research report in a new tab (anchored at the local
 *  Odysseus HTML report endpoint). */
export function researchReportUrl(p: NaluPairing, id: string): string {
  return `${baseUrl(p)}/api/research/report/${encodeURIComponent(id)}`
}

// ---------- Email --------------------------------------------------------

export interface NaluEmailAccount {
  id: string
  name: string
  isDefault: boolean
  enabled: boolean
  imapUser: string
}

export interface NaluEmailListItem {
  uid: string | number
  subject: string
  from?: string
  fromName?: string
  date?: string
  dateEpoch?: number
  seen?: boolean
  flagged?: boolean
}

export interface NaluEmailFull extends NaluEmailListItem {
  fromAddress?: string
  to?: string
  cc?: string
  body?: string
  bodyHtml?: string
  attachments?: Array<Record<string, unknown>>
}

export async function listEmailAccounts(p: NaluPairing): Promise<NaluEmailAccount[]> {
  const res = await fetch(`${baseUrl(p)}/api/email/accounts`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`listEmailAccounts ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data) ? data : (Array.isArray(data?.accounts) ? data.accounts : [])
  return list.map((a: Record<string, unknown>) => ({
    id: String(a.id ?? ''),
    name: String(a.name ?? ''),
    isDefault: !!a.is_default,
    enabled: !!a.enabled,
    imapUser: String(a.imap_user ?? ''),
  }))
}

export async function listEmails(
  p: NaluPairing,
  opts: { folder?: string; limit?: number; accountId?: string; filter?: string } = {},
): Promise<NaluEmailListItem[]> {
  const params = new URLSearchParams()
  params.set('folder', opts.folder ?? 'INBOX')
  params.set('limit', String(opts.limit ?? 30))
  if (opts.accountId) params.set('account_id', opts.accountId)
  if (opts.filter) params.set('filter', opts.filter)
  const res = await fetch(`${baseUrl(p)}/api/email/list?${params}`, {
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`listEmails ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.emails) ? data.emails : []
  return list.map((e: Record<string, unknown>) => ({
    uid: (e.uid as string | number) ?? '',
    subject: String(e.subject ?? '(no subject)'),
    from: typeof e.from === 'string' ? e.from : (typeof e.from_address === 'string' ? e.from_address : ''),
    fromName: typeof e.from_name === 'string' ? e.from_name : undefined,
    date: typeof e.date === 'string' ? e.date : undefined,
    dateEpoch: typeof e.date_epoch === 'number' ? e.date_epoch : undefined,
    seen: !!e.seen,
    flagged: !!e.flagged,
  }))
}

export async function readEmail(
  p: NaluPairing,
  uid: string | number,
  opts: { folder?: string; accountId?: string } = {},
): Promise<NaluEmailFull> {
  const params = new URLSearchParams()
  params.set('folder', opts.folder ?? 'INBOX')
  if (opts.accountId) params.set('account_id', opts.accountId)
  const res = await fetch(
    `${baseUrl(p)}/api/email/read/${encodeURIComponent(String(uid))}?${params}`,
    { headers: authHeaders(p) },
  )
  if (!res.ok) throw new Error(`readEmail ${res.status}`)
  const e = (await res.json()) as Record<string, unknown>
  return {
    uid,
    subject: String(e.subject ?? ''),
    fromName: typeof e.from_name === 'string' ? e.from_name : undefined,
    fromAddress: typeof e.from_address === 'string' ? e.from_address : undefined,
    date: typeof e.date === 'string' ? e.date : undefined,
    to: typeof e.to === 'string' ? e.to : undefined,
    cc: typeof e.cc === 'string' ? e.cc : undefined,
    body: typeof e.body === 'string' ? e.body : undefined,
    bodyHtml: typeof e.body_html === 'string' ? e.body_html : undefined,
    attachments: Array.isArray(e.attachments) ? (e.attachments as Array<Record<string, unknown>>) : undefined,
  }
}

// ---------- Calendar -----------------------------------------------------

export interface NaluCalendarEvent {
  uid: string
  summary: string
  start: string
  end?: string
  allDay?: boolean
  calendarName?: string
  location?: string
  description?: string
}

export async function listCalendarEvents(
  p: NaluPairing,
  opts: { start: Date; end: Date; calendar?: string },
): Promise<NaluCalendarEvent[]> {
  const params = new URLSearchParams()
  params.set('start', opts.start.toISOString())
  params.set('end', opts.end.toISOString())
  if (opts.calendar) params.set('calendar', opts.calendar)
  const res = await fetch(`${baseUrl(p)}/api/calendar/events?${params}`, {
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`listCalendarEvents ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.events) ? data.events : []
  return list.map((e: Record<string, unknown>) => ({
    uid: String(e.uid ?? e.id ?? ''),
    summary: String(e.summary ?? '(untitled)'),
    start: String(e.dtstart ?? e.start ?? ''),
    end: typeof e.dtend === 'string' ? e.dtend : (typeof e.end === 'string' ? e.end : undefined),
    allDay: !!e.all_day,
    calendarName: typeof e.calendar_name === 'string' ? e.calendar_name : undefined,
    location: typeof e.location === 'string' ? e.location : undefined,
    description: typeof e.description === 'string' ? e.description : undefined,
  }))
}

// ---------- Cookbook (hardware fit + cached models) ----------------------

export interface NaluHardware {
  os?: string
  cpu?: string
  totalRamGb?: number
  availableRamGb?: number
  hasGpu?: boolean
  gpuName?: string
  gpuCount?: number
  gpuVramGb?: number
  gpus?: Array<{ name?: string; vram_gb?: number }>
}

export async function getHardware(p: NaluPairing): Promise<NaluHardware> {
  const res = await fetch(`${baseUrl(p)}/api/hwfit/system`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`getHardware ${res.status}`)
  const s = (await res.json()) as Record<string, unknown>
  return {
    os: typeof s.os === 'string' ? s.os : undefined,
    cpu: typeof s.cpu === 'string' ? s.cpu : undefined,
    totalRamGb: typeof s.total_ram_gb === 'number' ? s.total_ram_gb : undefined,
    availableRamGb: typeof s.available_ram_gb === 'number' ? s.available_ram_gb : undefined,
    hasGpu: !!s.has_gpu,
    gpuName: typeof s.gpu_name === 'string' ? s.gpu_name : undefined,
    gpuCount: typeof s.gpu_count === 'number' ? s.gpu_count : undefined,
    gpuVramGb: typeof s.gpu_vram_gb === 'number' ? s.gpu_vram_gb : undefined,
    gpus: Array.isArray(s.gpus) ? (s.gpus as Array<{ name?: string; vram_gb?: number }>) : undefined,
  }
}

export interface NaluRecommendedModel {
  name: string
  repoId?: string
  size?: string
  quant?: string
  contextLength?: number
  score?: number
  fits?: boolean
  vramRequiredGb?: number
  ramRequiredGb?: number
  useCase?: string
}

export async function getRecommendedModels(
  p: NaluPairing,
  opts: { limit?: number; search?: string; fitOnly?: boolean } = {},
): Promise<NaluRecommendedModel[]> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? 12))
  params.set('sort', 'score')
  if (opts.search) params.set('search', opts.search)
  if (opts.fitOnly) params.set('fit_only', 'true')
  const res = await fetch(`${baseUrl(p)}/api/hwfit/models?${params}`, {
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`getRecommendedModels ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.models) ? data.models : []
  return list.map((m: Record<string, unknown>) => ({
    name: String(m.name ?? m.repo_id ?? ''),
    repoId: typeof m.repo_id === 'string' ? m.repo_id : undefined,
    size: typeof m.size === 'string' ? m.size : undefined,
    quant: typeof m.quant === 'string' ? m.quant : undefined,
    contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
    score: typeof m.score === 'number' ? m.score : undefined,
    fits: !!m.fits,
    vramRequiredGb: typeof m.vram_required_gb === 'number' ? m.vram_required_gb : undefined,
    ramRequiredGb: typeof m.ram_required_gb === 'number' ? m.ram_required_gb : undefined,
    useCase: typeof m.use_case === 'string' ? m.use_case : undefined,
  }))
}

export interface NaluCachedModel {
  path: string
  name?: string
  sizeBytes?: number
}

export async function getCachedModels(p: NaluPairing): Promise<NaluCachedModel[]> {
  const res = await fetch(`${baseUrl(p)}/api/model/cached`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`getCachedModels ${res.status}`)
  const data = await res.json()
  // The endpoint returns a heterogeneous shape — extract the list defensively.
  const list = Array.isArray(data?.models)
    ? data.models
    : Array.isArray(data?.cached)
      ? data.cached
      : Array.isArray(data)
        ? data
        : []
  return list.map((m: Record<string, unknown>) => ({
    path: String(m.path ?? m.dir ?? m.local_dir ?? ''),
    name: typeof m.name === 'string' ? m.name : (typeof m.repo_id === 'string' ? m.repo_id : undefined),
    sizeBytes: typeof m.size_bytes === 'number' ? m.size_bytes : (typeof m.size === 'number' ? m.size : undefined),
  }))
}

// ---------- Documents -----------------------------------------------------

export interface NaluDocument {
  id: string
  title: string
  language?: string | null
  content: string
  versionCount?: number
  updatedAt?: string | null
}

interface DocumentListItem {
  id: string
  title: string
  language?: string | null
  updatedAt?: string | null
}

export async function listDocuments(p: NaluPairing): Promise<DocumentListItem[]> {
  const params = new URLSearchParams()
  params.set('limit', '50')
  params.set('sort', 'recent')
  const res = await fetch(`${baseUrl(p)}/api/documents/library?${params}`, {
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`listDocuments ${res.status}`)
  const data = await res.json()
  const list = Array.isArray(data?.documents) ? data.documents : []
  return list.map((d: Record<string, unknown>) => ({
    id: String(d.id ?? ''),
    title: String(d.title ?? '(untitled)'),
    language: typeof d.language === 'string' ? d.language : null,
    updatedAt: typeof d.updated_at === 'string' ? d.updated_at : null,
  }))
}

export async function getDocument(p: NaluPairing, id: string): Promise<NaluDocument> {
  const res = await fetch(`${baseUrl(p)}/api/document/${encodeURIComponent(id)}`, {
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`getDocument ${res.status}`)
  const d = (await res.json()) as Record<string, unknown>
  return {
    id: String(d.id ?? ''),
    title: String(d.title ?? ''),
    language: typeof d.language === 'string' ? d.language : null,
    content: String(d.current_content ?? ''),
    versionCount: typeof d.version_count === 'number' ? d.version_count : undefined,
    updatedAt: typeof d.updated_at === 'string' ? d.updated_at : null,
  }
}

export async function updateDocument(
  p: NaluPairing,
  id: string,
  content: string,
): Promise<NaluDocument> {
  const res = await fetch(`${baseUrl(p)}/api/document/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { ...authHeaders(p), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`updateDocument ${res.status}: ${t.slice(0, 200)}`)
  }
  const d = (await res.json()) as Record<string, unknown>
  return {
    id: String(d.id ?? ''),
    title: String(d.title ?? ''),
    language: typeof d.language === 'string' ? d.language : null,
    content: String(d.current_content ?? ''),
    versionCount: typeof d.version_count === 'number' ? d.version_count : undefined,
    updatedAt: typeof d.updated_at === 'string' ? d.updated_at : null,
  }
}

export async function deleteDocument(p: NaluPairing, id: string): Promise<void> {
  const res = await fetch(`${baseUrl(p)}/api/document/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(p),
  })
  if (!res.ok) throw new Error(`deleteDocument ${res.status}`)
}

// ---------- MCP Servers ---------------------------------------------------

export interface NaluMcpServer {
  id: string
  name: string
  transport: string
  isEnabled: boolean
  status: string
  toolCount: number
  enabledToolCount: number
  error?: string | null
  needsOauth?: boolean
  authUrl?: string | null
}

export async function listMcpServers(p: NaluPairing): Promise<NaluMcpServer[]> {
  const res = await fetch(`${baseUrl(p)}/api/mcp/servers`, { headers: authHeaders(p) })
  if (!res.ok) throw new Error(`listMcpServers ${res.status}`)
  const list = await res.json()
  if (!Array.isArray(list)) return []
  return list.map((s: Record<string, unknown>) => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? ''),
    transport: String(s.transport ?? ''),
    isEnabled: !!s.is_enabled,
    status: String(s.status ?? 'disconnected'),
    toolCount: Number(s.tool_count ?? 0),
    enabledToolCount: Number(s.enabled_tool_count ?? 0),
    error: typeof s.error === 'string' ? s.error : null,
    needsOauth: !!s.needs_oauth,
    authUrl: typeof s.auth_url === 'string' ? s.auth_url : null,
  }))
}

export async function setMcpServerEnabled(
  p: NaluPairing,
  serverId: string,
  enabled: boolean,
): Promise<void> {
  const form = new FormData()
  form.set('is_enabled', enabled ? 'true' : 'false')
  const res = await fetch(
    `${baseUrl(p)}/api/mcp/servers/${encodeURIComponent(serverId)}`,
    { method: 'PATCH', headers: authHeaders(p), body: form },
  )
  if (!res.ok) throw new Error(`setMcpServerEnabled ${res.status}`)
}

export async function reconnectMcpServer(
  p: NaluPairing,
  serverId: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl(p)}/api/mcp/servers/${encodeURIComponent(serverId)}/reconnect`,
    { method: 'POST', headers: authHeaders(p) },
  )
  if (!res.ok) throw new Error(`reconnectMcpServer ${res.status}`)
}

export async function deleteMcpServer(
  p: NaluPairing,
  serverId: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl(p)}/api/mcp/servers/${encodeURIComponent(serverId)}`,
    { method: 'DELETE', headers: authHeaders(p) },
  )
  if (!res.ok) throw new Error(`deleteMcpServer ${res.status}`)
}

export async function uploadFiles(
  p: NaluPairing,
  files: File[],
): Promise<UploadedFile[]> {
  if (!files.length) return []
  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)
  const res = await fetch(`${baseUrl(p)}/api/upload`, {
    method: 'POST',
    headers: authHeaders(p),
    body: form,
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`uploadFiles ${res.status}: ${t.slice(0, 200)}`)
  }
  const data = await res.json()
  const list = Array.isArray(data?.files) ? data.files : []
  return list.map((f: Record<string, unknown>) => ({
    id: String(f.id ?? ''),
    name: String(f.name ?? ''),
    mime: String(f.mime ?? ''),
    size: Number(f.size ?? 0),
    width: typeof f.width === 'number' ? f.width : undefined,
    height: typeof f.height === 'number' ? f.height : undefined,
  }))
}

/** Return a Response whose body emits the SAME SSE shape Dashboard.tsx parses
 *  (event: delta / tool_call_delta / finish). Translates Odysseus's plain
 *  `data: {delta|type}` format on the fly. */
export async function streamChat(
  pairing: NaluPairing,
  opts: StreamChatOpts,
): Promise<Response> {
  const selected = getSelectedModel()
  if (!selected) {
    return new Response(
      'No Nalu model selected. Pick one from the model menu before chatting.',
      { status: 400 },
    )
  }

  let sessionId: string
  try {
    sessionId = await ensureSession(
      pairing,
      opts.chatId,
      selected.endpointId,
      selected.model,
    )
  } catch (e) {
    return new Response((e as Error).message, { status: 502 })
  }

  const last = opts.messages[opts.messages.length - 1]
  const message =
    last?.role === 'user' && typeof last.content === 'string' ? last.content : ''

  const form = new FormData()
  form.set('message', message)
  form.set('session', sessionId)
  form.set('mode', opts.mode ?? 'chat')
  if (opts.workspace) form.set('workspace', opts.workspace)
  if (opts.attachmentIds && opts.attachmentIds.length > 0) {
    // Odysseus chat_stream accepts attachments via either a JSON body or a
    // form field carrying a JSON-encoded array of upload IDs. We're posting
    // multipart, so use the form-field path.
    form.set('attachments', JSON.stringify(opts.attachmentIds))
  }

  const upstream = await fetch(`${baseUrl(pairing)}/api/chat_stream`, {
    method: 'POST',
    headers: authHeaders(pairing),
    body: form,
    signal: opts.signal,
  })

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    return new Response(text || `Odysseus returned ${upstream.status}`, {
      status: upstream.status || 502,
    })
  }

  const encoder = new TextEncoder()
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder('utf-8')

  const adapted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) {
        controller.enqueue(
          encoder.encode('event: finish\ndata: {"reason":"stop"}\n\n'),
        )
        controller.close()
        return
      }
      const chunk = decoder.decode(value, { stream: true })
      for (const block of chunk.split('\n\n')) {
        const m = block.match(/^data:\s*(.+)$/m)
        if (!m) continue
        const raw = m[1].trim()
        if (raw === '[DONE]') {
          controller.enqueue(
            encoder.encode('event: finish\ndata: {"reason":"stop"}\n\n'),
          )
          continue
        }
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(raw)
        } catch {
          continue
        }
        // Text deltas: Odysseus uses {"delta": "..."} (no `type` field).
        if (typeof payload.delta === 'string' && payload.delta) {
          const text = JSON.stringify({ text: payload.delta })
          controller.enqueue(encoder.encode(`event: delta\ndata: ${text}\n\n`))
          continue
        }
        // Structured events: tool_start, tool_output, agent_step, metrics, etc.
        if (typeof payload.type === 'string') {
          controller.enqueue(
            encoder.encode(`event: nalu_event\ndata: ${JSON.stringify(payload)}\n\n`),
          )
          // Inline tool screenshots as markdown image deltas so they render
          // in the existing chat renderer without a dedicated UI component.
          if (
            payload.type === 'tool_output' &&
            typeof payload.screenshot === 'string' &&
            payload.screenshot.startsWith('data:image/')
          ) {
            const toolName =
              typeof payload.tool === 'string' ? payload.tool : 'screenshot'
            const md = `\n\n![${toolName}](${payload.screenshot})\n\n`
            const text = JSON.stringify({ text: md })
            controller.enqueue(encoder.encode(`event: delta\ndata: ${text}\n\n`))
          }
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })

  return new Response(adapted, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
