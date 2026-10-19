import { isSwarmRoom, selectSwarmPending, swarmRoomId, type SwarmAgentId, type SwarmRoomReference, type SwarmState, type SwarmThread } from './swarmTypes'
import { requestSwarm, sameSwarmAccount, SwarmRequestError, SwarmSessionChanged, type SwarmAccount, type SwarmResponse } from './swarmTransport'

type Payload = Record<string, string>
type Intent = { key: string; requestId: string; action: string; payload: Payload; originalDraft?: string }
interface Preferences { activeProjectId: string; recipient: SwarmThread; drafts: Record<string, string>; recentRooms: SwarmRoomReference[]; intents: Intent[] }
export interface SwarmSnapshot { state: SwarmState; revision: number; preferences: Preferences; creating: boolean; loading: boolean; error: string; sendingRooms: string[]; busyTaskIds: string[] }
interface Options { account: SwarmAccount; readAccount: () => SwarmAccount | null; storage?: Pick<Storage, 'getItem' | 'setItem'>; request?: typeof fetch; uuid?: () => string; timeoutMs?: number }
const emptyState = (): SwarmState => ({ version: 1, mode: 'live', projects: [], tasks: [], messages: [], turns: [] })
const emptyPreferences = (): Preferences => ({ activeProjectId: '', recipient: 'group', drafts: {}, recentRooms: [], intents: [] })
export const emptySwarmSnapshot: SwarmSnapshot = { state: emptyState(), revision: -1, preferences: emptyPreferences(), creating: false, loading: true, error: '', sendingRooms: [], busyTaskIds: [] }
const roomThread = (value: unknown): value is SwarmThread => ['group', 'Nalu', 'Rocky', 'Milo'].includes(String(value))
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const intentActions = new Set(['create', 'send', 'add-task', 'start-task'])
const intentKey = (action: string, payload: Payload, context = '') => JSON.stringify([action, Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)), context])
function readPreferences(storage: Options['storage'], key: string): Preferences {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(key) || 'null')
    if (!record(saved)) return emptyPreferences()
    const drafts = record(saved.drafts) ? Object.fromEntries(Object.entries(saved.drafts).filter(([key, value]) => key.length < 1200 && typeof value === 'string').slice(-200).map(([key, value]) => [key, (value as string).slice(0, 12000)])) : {}
    const recentRooms = Array.isArray(saved.recentRooms) ? saved.recentRooms.filter((room): room is SwarmRoomReference => record(room) && typeof room.projectId === 'string' && roomThread(room.thread)).slice(0, 8) : []
    const intents = Array.isArray(saved.intents) ? saved.intents.filter((item): item is Intent => record(item) && typeof item.key === 'string' && item.key.length < 30000 && typeof item.requestId === 'string' && item.requestId.length <= 200 && typeof item.action === 'string' && intentActions.has(item.action) && record(item.payload) && Object.values(item.payload).every(value => typeof value === 'string' && value.length <= 12000) && (item.originalDraft === undefined || typeof item.originalDraft === 'string')).slice(-100) : []
    return { activeProjectId: typeof saved.activeProjectId === 'string' ? saved.activeProjectId : '', recipient: roomThread(saved.recipient) ? saved.recipient : 'group', drafts, recentRooms, intents }
  } catch { return emptyPreferences() }
}

/** Account-bound controller core. React only subscribes and schedules reads.
 * Persisted local data is navigation/drafts/request receipts, never server work. */
export class SwarmClient {
  readonly account: SwarmAccount
  private options: Options
  private storageKey: string
  private snapshot: SwarmSnapshot
  private listeners = new Set<() => void>()
  private controllers = new Set<AbortController>()
  private writes = new Map<string, Promise<SwarmResponse>>()
  private acknowledgedRetries = new Map<string, SwarmResponse>()
  private read: Promise<void> | null = null
  private readError = ''
  private disposed = false
  private generation = 0
  constructor(options: Options) {
    this.options = options; this.account = options.account
    this.storageKey = `workspace-swarm-navigation-v1:${encodeURIComponent(this.account.owner)}`
    this.snapshot = { ...emptySwarmSnapshot, state: emptyState(), preferences: readPreferences(options.storage, this.storageKey), sendingRooms: [], busyTaskIds: [] }
  }
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  isCurrent = () => !this.disposed && sameSwarmAccount(this.account, this.options.readAccount())
  hasPendingRequests = () => this.writes.size > 0 || this.snapshot.preferences.intents.length > 0
  start = () => { this.disposed = false; this.patch({ sendingRooms: [], busyTaskIds: [] }) }
  dispose = () => { this.disposed = true; this.generation++; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); this.writes.clear(); this.read = null }
  private patch(next: Partial<SwarmSnapshot>) { this.snapshot = { ...this.snapshot, ...next }; for (const listener of this.listeners) listener() }
  private preferences(next: Preferences, extra: Partial<SwarmSnapshot> = {}) {
    let error = extra.error ?? this.snapshot.error
    try { this.options.storage?.setItem(this.storageKey, JSON.stringify(next)) }
    catch { error = 'Your local draft could not be saved. Keep this window open until it is sent.' }
    this.patch({ ...extra, preferences: next, error })
  }
  private normalize(prefs: Preferences, state: SwarmState): Preferences {
    const activeProjectId = state.projects.some(project => project.id === prefs.activeProjectId) ? prefs.activeProjectId : state.projects[0]?.id || ''
    return { ...prefs, activeProjectId, recipient: isSwarmRoom(state, activeProjectId, prefs.recipient) ? prefs.recipient : 'group', recentRooms: prefs.recentRooms.filter(room => isSwarmRoom(state, room.projectId, room.thread)) }
  }
  private acknowledge(intent: Intent, prefs: Preferences): Preferences {
    let next = { ...prefs, intents: prefs.intents.filter(item => item.requestId !== intent.requestId) }
    if (intent.action === 'send') {
      const room = swarmRoomId(intent.payload.projectId, intent.payload.thread as SwarmThread)
      if (prefs.drafts[room] === intent.originalDraft) next = { ...next, drafts: { ...prefs.drafts, [room]: '' } }
    }
    return next
  }
  private apply(response: SwarmResponse) {
    if (!this.isCurrent() || response.revision < this.snapshot.revision) return
    // Equal revisions describe the same committed state; never replace it with
    // an older request's independently held object.
    const state = response.revision > this.snapshot.revision ? response.state : this.snapshot.state
    let prefs = this.normalize(this.snapshot.preferences, state)
    let creating = this.snapshot.creating
    for (const intent of prefs.intents) {
      if (intent.action === 'send') {
        const turn = state.turns.find(turn => turn.requestId === intent.requestId && turn.projectId === intent.payload.projectId && turn.thread === intent.payload.thread)
        const message = turn && state.messages.find(message => message.id === turn.userMessageId && message.projectId === turn.projectId && message.thread === turn.thread && message.speaker === 'You' && message.content === intent.payload.content)
        if (message) prefs = this.acknowledge(intent, prefs)
      } else if (intent.action === 'create') {
        const project = state.projects.find(project => project.requestId === intent.requestId && project.title === intent.payload.title && project.brief === intent.payload.brief)
        if (project) {
          prefs = this.acknowledge(intent, prefs)
          if (creating) { prefs = { ...prefs, activeProjectId: project.id, recipient: 'group' }; creating = false }
        }
      } else if (intent.action === 'add-task') {
        const task = state.tasks.find(task => task.requestId === intent.requestId && task.projectId === intent.payload.projectId && task.title === intent.payload.title && task.threads?.includes(intent.payload.thread as SwarmThread))
        if (task) {
          // The add form may already have received an uncertain network error.
          // Its next explicit retry confirms this receipt instead of adding twice.
          if (!this.writes.has(intent.key)) this.acknowledgedRetries.set(intent.key, response)
          prefs = this.acknowledge(intent, prefs)
        }
      } else if (intent.action === 'start-task') {
        if (state.tasks.some(task => task.id === intent.payload.taskId && task.projectId === intent.payload.projectId && task.executionRequestId === intent.requestId)) prefs = this.acknowledge(intent, prefs)
      }
    }
    const error = this.snapshot.preferences.intents.length > prefs.intents.length || this.snapshot.error === this.readError ? '' : this.snapshot.error
    this.preferences(prefs, { state, revision: response.revision, loading: false, creating, error })
  }
  private async call(body: Record<string, unknown>): Promise<SwarmResponse> {
    if (!this.isCurrent()) throw new SwarmSessionChanged()
    const generation = this.generation, controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20000)
    try {
      const response = await requestSwarm(this.account, body, controller.signal, this.options.readAccount, this.options.request)
      if (!this.isCurrent() || generation !== this.generation) throw new SwarmSessionChanged()
      this.apply(response)
      return response
    } finally { clearTimeout(timeout); this.controllers.delete(controller) }
  }
  refresh = (): Promise<void> => {
    if (this.read) return this.read
    const generation = this.generation
    const pending = this.call({ action: 'list' }).then(() => undefined).catch(error => {
      if (this.isCurrent() && generation === this.generation && !(error instanceof SwarmSessionChanged)) {
        this.readError = error instanceof Error ? error.message : 'Swarm updates are unavailable. Please try again.'
        this.patch({ loading: false, error: this.readError })
      }
    }).finally(() => { if (this.read === pending) this.read = null })
    this.read = pending
    return pending
  }
  private mutate(action: string, payload: Payload, extra: { originalDraft?: string; context?: string } = {}): Promise<SwarmResponse> {
    if (!this.isCurrent()) return Promise.reject(new SwarmSessionChanged())
    // A newer poll may reveal an execution ID before its request receipt. Keep
    // the original start ID until the exact receipt is acknowledged.
    const retained = this.snapshot.preferences.intents.find(item => item.action === action && intentKey(action, item.payload) === intentKey(action, payload))
    const key = retained?.key ?? intentKey(action, payload, extra.context)
    const acknowledged = this.acknowledgedRetries.get(key)
    if (acknowledged) { this.acknowledgedRetries.delete(key); return Promise.resolve(acknowledged) }
    const existing = this.writes.get(key)
    if (existing) return existing
    let intent = this.snapshot.preferences.intents.find(item => item.key === key)
    if (intentActions.has(action) && !intent) {
      intent = { key, requestId: (this.options.uuid || (() => crypto.randomUUID()))(), action, payload, ...(extra.originalDraft !== undefined ? { originalDraft: extra.originalDraft } : {}) }
      this.preferences({ ...this.snapshot.preferences, intents: [...this.snapshot.preferences.intents, intent].slice(-100) })
    }
    const captured = intent, generation = this.generation
    const room = action === 'send' ? swarmRoomId(payload.projectId, payload.thread as SwarmThread) : undefined
    const taskId = payload.taskId
    this.patch({ error: '', sendingRooms: room ? [...new Set([...this.snapshot.sendingRooms, room])] : this.snapshot.sendingRooms, busyTaskIds: taskId ? [...new Set([...this.snapshot.busyTaskIds, taskId])] : this.snapshot.busyTaskIds })
    const pending = this.call({ action, ...payload, ...(captured ? { requestId: captured.requestId } : {}) }).then(response => {
      if (captured && this.isCurrent() && generation === this.generation) this.preferences(this.acknowledge(captured, this.snapshot.preferences), { error: '' })
      return response
    }).catch(error => {
      if (this.isCurrent() && generation === this.generation && !(error instanceof SwarmSessionChanged)) {
        // A concurrent poll can confirm the exact request before its original
        // connection fails. Do not turn that acknowledged send into an error.
        if (captured && !this.snapshot.preferences.intents.some(item => item.requestId === captured.requestId)) return { state: this.snapshot.state, revision: this.snapshot.revision, projectId: captured.action === 'create' ? this.snapshot.state.projects.find(project => project.requestId === captured.requestId)?.id : undefined }
        if (captured && error instanceof SwarmRequestError && !error.uncertain) this.preferences({ ...this.snapshot.preferences, intents: this.snapshot.preferences.intents.filter(item => item.requestId !== captured.requestId) })
        this.patch({ error: error instanceof Error ? error.message : 'That request could not be completed. Please try again.' })
      }
      throw error
    }).finally(() => {
      if (this.writes.get(key) === pending) this.writes.delete(key)
      if (this.isCurrent() && generation === this.generation) this.patch({ sendingRooms: room ? this.snapshot.sendingRooms.filter(item => item !== room) : this.snapshot.sendingRooms, busyTaskIds: taskId ? this.snapshot.busyTaskIds.filter(item => item !== taskId) : this.snapshot.busyTaskIds })
    })
    this.writes.set(key, pending)
    return pending
  }
  setDraft = (text: string) => {
    if (!this.isCurrent()) return
    const prefs = this.snapshot.preferences, room = swarmRoomId(prefs.activeProjectId, prefs.recipient)
    this.preferences({ ...prefs, drafts: { ...prefs.drafts, [room]: text.slice(0, 12000) } })
  }
  setCreating = (creating: boolean) => { if (this.isCurrent()) this.patch({ creating }) }
  navigate = (projectId: string, thread: SwarmThread) => {
    if (!this.isCurrent() || !isSwarmRoom(this.snapshot.state, projectId, thread)) return
    const prefs = this.snapshot.preferences
    this.preferences({ ...prefs, activeProjectId: projectId, recipient: thread, recentRooms: [{ projectId, thread }, ...prefs.recentRooms.filter(room => room.projectId !== projectId || room.thread !== thread)].slice(0, 8) }, { creating: false })
  }
  selectProject = (projectId: string) => this.navigate(projectId, 'group')
  selectRecipient = (thread: SwarmThread) => this.navigate(this.snapshot.preferences.activeProjectId, thread)
  send = async (text?: string): Promise<boolean> => {
    const prefs = this.snapshot.preferences, projectId = prefs.activeProjectId, thread = prefs.recipient
    const originalDraft = prefs.drafts[swarmRoomId(projectId, thread)] || '', content = (text ?? originalDraft).trim()
    if (!this.isCurrent() || !content || !isSwarmRoom(this.snapshot.state, projectId, thread) || this.snapshot.sendingRooms.includes(swarmRoomId(projectId, thread)) || selectSwarmPending(this.snapshot.state, projectId, thread).length) return false
    try { await this.mutate('send', { projectId, thread, content }, { originalDraft }); return true } catch { return false }
  }
  stop = () => { const { activeProjectId: projectId, recipient: thread } = this.snapshot.preferences; if (isSwarmRoom(this.snapshot.state, projectId, thread)) void this.mutate('stop', { projectId, thread }).catch(() => {}) }
  createProject = async (title: string, brief: string): Promise<string | null> => {
    if (!title.trim() || !brief.trim()) return null
    try {
      const response = await this.mutate('create', { title: title.trim().slice(0, 100), brief: brief.trim().slice(0, 2000) })
      const id = response.projectId
      if (!id || !this.isCurrent()) return null
      this.navigate(id, 'group')
      return id
    } catch { return null }
  }
  addTask = async (title: string, assignee: SwarmAgentId): Promise<void> => {
    const { activeProjectId: projectId, recipient: thread } = this.snapshot.preferences
    if (!title.trim() || !isSwarmRoom(this.snapshot.state, projectId, thread)) return
    if (title.trim().length > 2000) {
      const error = 'Keep task instructions within 2,000 characters. Your full text is still here to edit.'
      this.patch({ error }); throw new Error(error)
    }
    await this.mutate('add-task', { projectId, thread, title: title.trim(), assignee })
  }
  private taskAction = async (action: string, taskId: string, extra: Payload = {}): Promise<void> => {
    const projectId = this.snapshot.preferences.activeProjectId
    const task = this.snapshot.state.tasks.find(task => task.id === taskId && task.projectId === projectId)
    if (!task) return
    await this.mutate(action, { projectId, taskId, ...extra }, { context: action === 'start-task' ? task.executionId || '' : undefined })
  }
  assignTask = (taskId: string, assignee: SwarmAgentId) => { void this.taskAction('assign-task', taskId, { assignee }).catch(() => {}) }
  startTask = (taskId: string) => this.taskAction('start-task', taskId)
  stopTask = (taskId: string) => this.taskAction('stop-task', taskId)
  shareTask = (taskId: string) => this.taskAction('share-task', taskId)
}
