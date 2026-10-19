import { useCallback, useEffect, useRef, useState } from 'react'
import { PREVIEW_OWNER, PREVIEW_TOKEN, PREVIEW_VERSION } from './fixtures'
import {
  initialSwarmState, isSwarmState, isSwarmRoom, mergeSwarmStates, reduceSwarm, sampleReply, selectSwarmMessages, selectSwarmTasks,
  selectSwarmPending, swarmRoomId,
  type SwarmState, type SwarmThread, type SwarmAgentId, type SwarmMessage, type SwarmTask, type SwarmTaskStatus,
} from './swarmPreviewModel'

// Deliberately outside nalu-* account sync: these are local sample conversations.
const STORAGE_KEY = 'workspace-preview-swarm-v1'
type Room = { projectId: string; thread: SwarmThread }
type Snapshot = { owner: string; state: SwarmState; drafts: Record<string, string>; recentRooms: Room[]; activeProjectId: string; recipient: SwarmThread }
function allowed() {
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return false
  return localStorage.getItem('nalu-data-owner') === PREVIEW_OWNER && localStorage.getItem('nalu-token') === PREVIEW_TOKEN
    && localStorage.getItem('nalu-workspace-preview-version') === PREVIEW_VERSION
}
function parseSnapshot(raw: string | null): Snapshot | null {
  try {
    const saved = JSON.parse(raw || 'null') as Snapshot | null
    if (!saved || saved.owner !== PREVIEW_OWNER || !isSwarmState(saved.state)) return null
    const state = saved.state
    const activeProjectId = state.projects.some(project => project.id === saved.activeProjectId) ? saved.activeProjectId : state.projects[0]?.id || ''
    return { owner: PREVIEW_OWNER, state, activeProjectId, recipient: isSwarmRoom(state, activeProjectId, saved.recipient) ? saved.recipient : 'group',
      drafts: saved.drafts && typeof saved.drafts === 'object' && !Array.isArray(saved.drafts) ? Object.fromEntries(Object.entries(saved.drafts).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value.slice(0, 12000)])) : {},
      recentRooms: Array.isArray(saved.recentRooms) ? saved.recentRooms.filter(room => room && typeof room.projectId === 'string' && isSwarmRoom(state, room.projectId, room.thread)).slice(0, 8) : [] }
  } catch { return null }
}
function readSaved(): Snapshot | null {
  try { return parseSnapshot(localStorage.getItem(STORAGE_KEY)) } catch { return null }
}
function load(): Snapshot {
  const saved = allowed() ? readSaved() : null
  if (saved) return saved
  const state = initialSwarmState(Date.now())
  return { owner: PREVIEW_OWNER, state, drafts: {}, recentRooms: [], activeProjectId: state.projects[0]?.id || '', recipient: 'group' }
}
function mergeSnapshot(current: Snapshot, incoming: Snapshot): Snapshot {
  const state = mergeSwarmStates(current.state, incoming.state)
  // A different tab's navigation or typing must not move this tab or erase its
  // composer. Shared project/task/message data still converges across tabs.
  return { ...current, state, drafts: { ...incoming.drafts, ...current.drafts },
    recipient: isSwarmRoom(state, current.activeProjectId, current.recipient) ? current.recipient : 'group',
    recentRooms: current.recentRooms.filter(room => isSwarmRoom(state, room.projectId, room.thread)) }
}

export interface SwarmController {
  state: SwarmState
  activeProjectId: string
  recipient: SwarmThread
  messages: SwarmMessage[]
  tasks: SwarmTask[]
  draft: string
  setDraft: (text: string) => void
  pending: boolean
  pendingCount: number
  creating: boolean
  setCreating: (value: boolean) => void
  error: string
  selectProject: (id: string) => void
  selectRecipient: (thread: SwarmThread) => void
  navigate: (projectId: string, thread: SwarmThread) => void
  send: (text?: string) => boolean
  stop: () => void
  createProject: (title: string, brief: string) => string | null
  addTask: (title: string, assignee: SwarmAgentId) => void
  updateTask: (taskId: string, status: SwarmTaskStatus) => void
  assignTask: (taskId: string, assignee: SwarmAgentId) => void
  recentRooms: Room[]
}

export default function useSwarmPreview(): SwarmController {
  const [snapshot, setSnapshot] = useState(load)
  const latest = useRef(snapshot)
  latest.current = snapshot
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const commit = useCallback((change: (current: Snapshot) => Snapshot) => {
    if (!allowed()) return
    const saved = readSaved()
    const next = change(saved ? mergeSnapshot(latest.current, saved) : latest.current)
    latest.current = next
    setSnapshot(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setError('') }
    catch { setError('This preview could not save locally. Keep this window open to retain your changes.') }
  }, [])
  useEffect(() => {
    const clearSession = () => { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear() }
    const onStorage = (event: StorageEvent) => {
      if (!allowed()) { clearSession(); setError('Reopen the local preview to continue.'); return }
      if (event.key !== STORAGE_KEY) return
      const incoming = parseSnapshot(event.newValue)
      if (!incoming) return
      const saved = readSaved() || incoming
      const next = mergeSnapshot(mergeSnapshot(latest.current, incoming), saved)
      latest.current = next; setSnapshot(next)
      // Repair a stale concurrent write only if shared data actually differs.
      // Personal navigation/drafts alone never cause a storage-event loop.
      if (JSON.stringify(next.state) !== JSON.stringify(saved.state)) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setError('') }
        catch { setError('This preview could not save locally. Keep this window open to retain your changes.') }
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('nalu-session-cleared', clearSession)
    return () => { clearSession(); window.removeEventListener('storage', onStorage); window.removeEventListener('nalu-session-cleared', clearSession) }
  }, [])
  useEffect(() => {
    const pendingIds = new Set(snapshot.state.turns.filter(turn => turn.status === 'pending').map(turn => turn.id))
    for (const [id, timer] of timers.current) if (!pendingIds.has(id)) { clearTimeout(timer); timers.current.delete(id) }
    if (!allowed()) return
    for (const turn of snapshot.state.turns) {
      if (turn.status !== 'pending' || timers.current.has(turn.id)) continue
      // Resume only an explicitly sent sample message, including after reload.
      // Stable turn/reply IDs make parallel tabs harmless; no task is executed.
      timers.current.set(turn.id, setTimeout(() => {
        timers.current.delete(turn.id)
        commit(current => {
          const active = current.state.turns.find(item => item.id === turn.id)
          if (!active || active.status !== 'pending') return current
          const message = current.state.messages.find(item => item.id === active.userMessageId)
          const reply = message && sampleReply({ state: current.state, projectId: active.projectId, recipient: active.thread, text: message.content })
          return { ...current, state: reduceSwarm(current.state, reply
            ? { type: 'complete', turnId: active.id, content: reply, at: Date.now() }
            : { type: 'cancel', turnId: active.id, at: Date.now() }) }
        })
      }, 650))
    }
  }, [snapshot.state, commit])
  const navigate = useCallback((projectId: string, thread: SwarmThread) => {
    if (!isSwarmRoom(latest.current.state, projectId, thread)) return
    commit(current => isSwarmRoom(current.state, projectId, thread) ? { ...current, activeProjectId: projectId, recipient: thread,
      recentRooms: [{ projectId, thread }, ...current.recentRooms.filter(room => room.projectId !== projectId || room.thread !== thread)].slice(0, 8) } : current)
    setCreating(false)
  }, [commit])
  const setDraft = useCallback((text: string) => commit(current => ({ ...current, drafts: { ...current.drafts, [swarmRoomId(current.activeProjectId, current.recipient)]: text.slice(0, 12000) } })), [commit])
  const send = useCallback((text?: string) => {
    const current = latest.current
    const { activeProjectId: projectId, recipient: thread } = current
    const room = swarmRoomId(projectId, thread)
    const content = (text ?? current.drafts[room] ?? '').trim()
    if (!allowed() || !isSwarmRoom(current.state, projectId, thread) || !content || selectSwarmPending(current.state, projectId, thread).length) return false
    const turnId = crypto.randomUUID(), at = Date.now()
    let sent = false
    commit(value => {
      if (!isSwarmRoom(value.state, projectId, thread) || selectSwarmPending(value.state, projectId, thread).length) return value
      const state = reduceSwarm(value.state, { type: 'send', projectId, thread, content, messageId: crypto.randomUUID(), replyId: crypto.randomUUID(), turnId, at })
      if (state === value.state) return value
      sent = true
      return { ...value, state, drafts: { ...value.drafts, [room]: '' } }
    })
    if (!sent) return false
    navigate(projectId, thread)
    return true
  }, [commit, navigate])
  const stop = useCallback(() => {
    const { state, activeProjectId: projectId, recipient: thread } = latest.current
    for (const turn of selectSwarmPending(state, projectId, thread)) { clearTimeout(timers.current.get(turn.id)); timers.current.delete(turn.id) }
    commit(current => ({ ...current, state: reduceSwarm(current.state, { type: 'stop-thread', projectId, thread, at: Date.now() }) }))
  }, [commit])
  const createProject = useCallback((title: string, brief: string) => {
    if (!allowed() || !title.trim()) return null
    const id = `swarm-${crypto.randomUUID()}`
    commit(current => ({ ...current, state: reduceSwarm(current.state, { type: 'create-project', id, title: title.trim().slice(0, 100), brief: brief.trim().slice(0, 2000), at: Date.now() }) }))
    navigate(id, 'group')
    return id
  }, [commit, navigate])
  const updateTask = useCallback((taskId: string, status: SwarmTaskStatus) => commit(current => ({ ...current, state: reduceSwarm(current.state, { type: 'update-task', projectId: current.activeProjectId, taskId, status, at: Date.now() }) })), [commit])
  const addTask = useCallback((title: string, assignee: SwarmAgentId) => {
    if (!title.trim()) return
    commit(current => ({ ...current, state: reduceSwarm(current.state, { type: 'add-task', task: {
      id: `swarm-task-${crypto.randomUUID()}`, projectId: current.activeProjectId, title: title.trim().slice(0, 180), assignee,
      threads: [current.recipient], status: 'queued', summary: 'Ready to discuss in this workspace.', updatedAt: Date.now(),
    } }) }))
  }, [commit])
  const assignTask = useCallback((taskId: string, assignee: SwarmAgentId) => commit(current => ({ ...current, state: reduceSwarm(current.state, { type: 'assign-task', projectId: current.activeProjectId, taskId, assignee, at: Date.now() }) })), [commit])
  return {
    state: snapshot.state, activeProjectId: snapshot.activeProjectId, recipient: snapshot.recipient,
    messages: selectSwarmMessages(snapshot.state, snapshot.activeProjectId, snapshot.recipient), tasks: selectSwarmTasks(snapshot.state, snapshot.activeProjectId),
    draft: snapshot.drafts[swarmRoomId(snapshot.activeProjectId, snapshot.recipient)] || '', setDraft,
    pending: selectSwarmPending(snapshot.state, snapshot.activeProjectId, snapshot.recipient).length > 0,
    pendingCount: Object.values(snapshot.state.turns).filter(turn => turn.status === 'pending').length,
    creating, setCreating, error, navigate, selectProject: id => navigate(id, 'group'), selectRecipient: thread => navigate(snapshot.activeProjectId, thread),
    send, stop, createProject, addTask, updateTask, assignTask, recentRooms: snapshot.recentRooms,
  }
}
