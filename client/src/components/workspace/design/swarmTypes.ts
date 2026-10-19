/** Swarm presentation contract. No fixtures, storage, network, or execution. */
export type SwarmAgentId = 'Nalu' | 'Rocky' | 'Milo'
export type SwarmThread = 'group' | SwarmAgentId
export type SwarmTaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'paused' | 'failed' | 'cancelled'
export interface SwarmProject {
  id: string; requestId?: string; title: string; brief: string; members: SwarmAgentId[]; createdAt: number; updatedAt: number
}
export interface SwarmRoom { id: string; projectId: string; thread: SwarmThread; title: string }
export interface SwarmTask {
  id: string; requestId?: string; projectId: string; title: string; assignee: SwarmAgentId; status: SwarmTaskStatus
  summary: string; chatId?: string; updatedAt: number; threads?: SwarmThread[]
  /** Actual execution data supplied by the controller; never inferred by UI. */
  progress?: number; executionId?: string; executionRequestId?: string
  handoff?: { studioKind: string; prompt: string; reason: string }
  artifact?: { executionId: string; studioKind: string; revision: number }
}
export interface SwarmMessage {
  id: string; projectId: string; thread: SwarmThread; speaker: 'You' | SwarmAgentId
  content: string; createdAt: number; turnId?: string; sample?: boolean
}
export interface SwarmTurn {
  id: string; requestId?: string; projectId: string; thread: SwarmThread; replySpeaker: SwarmAgentId
  userMessageId: string; replyId: string; status: 'pending' | 'completed' | 'cancelled' | 'failed'
  createdAt: number; updatedAt: number
}
export interface SwarmState {
  version: 1; mode: 'sample' | 'live'; projects: SwarmProject[]; tasks: SwarmTask[]
  messages: SwarmMessage[]; turns: SwarmTurn[]
}
export interface SwarmRoomReference { projectId: string; thread: SwarmThread }
export interface SwarmStudioArtifact {
  type: 'studio-artifact'; studioKind: string; payload: Record<string, unknown>; status: 'done' | 'waiting'; summary: string
}
export interface SwarmArtifactResponse { artifact: SwarmStudioArtifact; revision: number }
export interface SwarmMedia { attachmentId: string; filename: string; mime: string; size: number; parts: number; sha256: string }
export interface SwarmController {
  state: SwarmState
  activeProjectId: string
  recipient: SwarmThread
  messages: SwarmMessage[]
  tasks: SwarmTask[]
  draft: string
  setDraft: (text: string) => void
  pending: boolean
  sending?: boolean
  pendingCount: number
  creating: boolean
  setCreating: (value: boolean) => void
  error: string
  loading?: boolean
  refresh?: () => void
  selectProject: (id: string) => void
  selectRecipient: (thread: SwarmThread) => void
  navigate: (projectId: string, thread: SwarmThread) => void
  send: (text?: string) => boolean | Promise<boolean>
  stop: () => void
  createProject: (title: string, brief: string) => string | null | Promise<string | null>
  addTask: (title: string, assignee: SwarmAgentId) => void | Promise<void>
  /** Manual tracking in sample mode. Live execution status is read-only in UI. */
  updateTask: (taskId: string, status: SwarmTaskStatus) => void
  assignTask: (taskId: string, assignee: SwarmAgentId) => void
  recentRooms: SwarmRoomReference[]
  /** Explicit user execution requests; the controller owns errors and results. */
  startTask?: (taskId: string) => void | Promise<void>
  stopTask?: (taskId: string) => void | Promise<void>
  shareTask?: (taskId: string) => void | Promise<void>
  continueStudio?: (taskId: string) => Promise<void>
  getArtifact?: (taskId: string, executionId: string, signal?: AbortSignal) => Promise<SwarmArtifactResponse>
  loadArtifactMedia?: (taskId: string, executionId: string, media: SwarmMedia, signal?: AbortSignal) => Promise<Blob>
  updateArtifact?: (taskId: string, executionId: string, revision: number, payload: Record<string, unknown>) => Promise<number>
  busyTaskIds?: readonly string[]
}

export const SWARM_AGENTS: readonly SwarmAgentId[] = ['Nalu', 'Rocky', 'Milo']
export const swarmRoomId = (projectId: string, thread: SwarmThread): string => `${encodeURIComponent(projectId)}::${encodeURIComponent(thread)}`
export const isSwarmRoom = (state: SwarmState, projectId: string, thread: unknown): thread is SwarmThread => {
  const project = state.projects.find(item => item.id === projectId)
  return !!project && (thread === 'group' || project.members.includes(thread as SwarmAgentId))
}
export const selectSwarmMessages = (state: SwarmState, projectId: string, thread: SwarmThread): SwarmMessage[] => isSwarmRoom(state, projectId, thread)
  ? state.messages.filter(message => message.projectId === projectId && message.thread === thread) : []
export const selectSwarmTasks = (state: SwarmState, projectId: string): SwarmTask[] => state.projects.some(project => project.id === projectId)
  ? state.tasks.filter(task => task.projectId === projectId) : []
export const selectSwarmThreadTasks = (state: SwarmState, projectId: string, thread: SwarmThread): SwarmTask[] => isSwarmRoom(state, projectId, thread)
  ? state.tasks.filter(task => task.projectId === projectId && (task.threads ?? ['group', task.assignee]).includes(thread)) : []
export const selectSwarmPending = (state: SwarmState, projectId: string, thread: SwarmThread): SwarmTurn[] => isSwarmRoom(state, projectId, thread)
  ? state.turns.filter(turn => turn.projectId === projectId && turn.thread === thread && turn.status === 'pending') : []

/** Counts cross-project work without copying private messages into other rooms. */
export function swarmProjectOverview(state: SwarmState) {
  return state.projects.map(project => {
    const tasks = selectSwarmTasks(state, project.id)
    return { project, total: tasks.length, running: tasks.filter(task => task.status === 'running').length,
      waiting: tasks.filter(task => task.status === 'waiting').length,
      failed: tasks.filter(task => task.status === 'failed').length }
  })
}
