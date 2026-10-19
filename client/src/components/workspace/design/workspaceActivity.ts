// Shared read-only activity adapters. They never change chats or execute work.
export interface ActivityMessage {
  id?: string
  role: 'user' | 'assistant'
  content?: string
  updatedAt?: number
  loading?: string
  clarify?: { questions: { q: string; options?: string[]; multi?: boolean }[]; answered?: boolean }
  doc?: unknown; sheet?: unknown; deck?: unknown; design?: unknown
  email?: unknown; video?: unknown; cad?: unknown; image?: unknown
  attachments?: unknown[]
}
export interface ActivityChat {
  id: string
  title: string
  createdAt: number
  titleUpdatedAt?: number
  messages: ActivityMessage[]
  attachments?: unknown[]
}
export type ActivityStatus = 'queued' | 'running' | 'waiting' | 'done' | 'saved' | 'failed' | 'cancelled'
export interface ActivityItem {
  id: string
  chatId?: string
  status: ActivityStatus
  title: string
  detail: string
  progress?: number
  events: { t: string; m: string }[]
  createdAt: number
  updatedAt: number
  source: string
  preview: boolean
  pendingQuestion?: { id: string; text: string }
}

const ARTIFACT_FIELDS = ['doc', 'sheet', 'deck', 'design', 'email', 'video', 'cad', 'image'] as const
const plainText = (value: unknown, limit = 220) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
const time = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8.64e15 ? parsed : 0
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function chatActivity(chats: ActivityChat[], activeChatIds: readonly string[]): ActivityItem[] {
  const active = new Set(activeChatIds)
  return chats.filter(chat => chat && typeof chat.id === 'string' && Array.isArray(chat.messages)).map(chat => {
    const last = chat.messages[chat.messages.length - 1]
    const question = last?.role === 'assistant' && last.clarify && !last.clarify.answered ? last.clarify : null
    // Persisted loading markers can survive a refresh. Only the owner of an
    // actual in-flight request is allowed to call a chat "running".
    const status: ActivityStatus = active.has(chat.id) ? 'running' : question ? 'waiting' : 'saved'
    const hasArtifact = chat.messages.some(message => ARTIFACT_FIELDS.some(key => message[key] != null))
    const updatedAt = chat.messages.reduce((latest, message) => Math.max(latest, time(message.updatedAt)), Math.max(time(chat.createdAt), time(chat.titleUpdatedAt)))
    const questionText = question?.questions.map(item => plainText(item.q, 500)).filter(Boolean).join('\n') || ''
    const latestContent = [...chat.messages].reverse().find(message => plainText(message.content))
    return {
      id: `chat_${chat.id}`, chatId: chat.id, title: plainText(chat.title, 300) || 'Untitled conversation', status,
      detail: status === 'running' ? last?.loading ? `Creating ${last.loading === 'slides' ? 'a presentation' : last.loading === 'design' ? 'your design' : `your ${last.loading}`}…` : 'Working on your request.'
        : status === 'waiting' ? questionText || 'A detail is needed before this work can continue.'
        : plainText(latestContent?.content) || (hasArtifact ? 'Saved work from this conversation.' : 'Saved conversation.'),
      createdAt: time(chat.createdAt), updatedAt, source: hasArtifact || last?.loading ? 'studio' : 'chat', preview: false,
      events: chat.messages.filter(message => time(message.updatedAt) && plainText(message.content)).slice(-4).map(message => ({ t: new Date(time(message.updatedAt)).toISOString(), m: `${message.role === 'user' ? 'You' : 'Nalu'}: ${plainText(message.content)}` })),
      ...(status === 'waiting' && questionText ? { pendingQuestion: { id: `${last?.id || chat.id}:clarification`, text: questionText } } : {}),
    }
  })
}

// The ledger does not promise a linked web chat. Only expose a navigation target
// when the returned ID is present in the current account's actual chat list.
export function remoteActivity(raw: unknown, chats: ActivityChat[]): ActivityItem[] {
  if (!Array.isArray(raw)) return []
  const chatIds = new Set(chats.map(chat => chat.id))
  const statuses = new Set<ActivityStatus>(['queued', 'running', 'waiting', 'done', 'failed', 'cancelled'])
  const seen = new Set<string>()
  return raw.flatMap((task): ActivityItem[] => {
    if (!record(task) || typeof task.id !== 'string' || !task.id || seen.has(task.id) || !statuses.has(task.status as ActivityStatus)) return []
    seen.add(task.id)
    const meta = record(task.meta) ? task.meta : {}
    const candidate = typeof meta.chatId === 'string' ? meta.chatId : meta.kind === 'chat' && task.id.startsWith('chat_') ? task.id.slice(5) : undefined
    const question = record(meta.pendingQuestion) && typeof meta.pendingQuestion.id === 'string' && typeof meta.pendingQuestion.text === 'string' ? { id: meta.pendingQuestion.id, text: meta.pendingQuestion.text } : undefined
    return [{
      id: task.id, ...(candidate && chatIds.has(candidate) ? { chatId: candidate } : {}),
      title: plainText(task.title, 300) || 'Untitled task', status: task.status as ActivityStatus,
      detail: plainText(task.detail, 1000) || (task.status === 'waiting' ? question?.text || 'This task needs your attention.' : plainText(meta.result, 1000)),
      ...(typeof task.progress === 'number' && Number.isFinite(task.progress) ? { progress: Math.max(0, Math.min(1, task.progress)) } : {}),
      events: Array.isArray(task.events) ? task.events.flatMap(event => record(event) && typeof event.m === 'string' && typeof event.t === 'string' ? [{ t: event.t, m: event.m }] : []).slice(-12) : [],
      createdAt: time(task.created_at), updatedAt: time(task.updated_at), source: plainText(task.source, 40) || 'task', preview: false,
      ...(task.status === 'waiting' && question ? { pendingQuestion: question } : {}),
    }]
  })
}

export function mergeWorkspaceActivity(chats: ActivityChat[], activeChatIds: readonly string[], remote: ActivityItem[], samples: ActivityItem[]): ActivityItem[] {
  const local = chatActivity(chats, activeChatIds)
  const activeLocal = local.filter(item => item.status === 'running' || item.status === 'waiting')
  const actualChatIds = new Set(chats.map(chat => chat.id))
  const validRemote = remote.map(item => item.chatId && !actualChatIds.has(item.chatId) ? { ...item, chatId: undefined } : item)
  const realIds = new Set([...activeLocal, ...validRemote].flatMap(item => item.chatId ? [item.chatId] : []))
  const validSamples = samples.filter(item => item.chatId && actualChatIds.has(item.chatId) && !realIds.has(item.chatId))
  const represented = new Set([...realIds, ...validSamples.flatMap(item => item.chatId ? [item.chatId] : [])])
  const saved = local.filter(item => item.status === 'saved' && !represented.has(item.chatId!))
  const priority: Record<ActivityStatus, number> = { waiting: 0, failed: 1, running: 2, queued: 3, done: 4, cancelled: 5, saved: 6 }
  const seen = new Set<string>()
  return [...activeLocal, ...validRemote, ...validSamples, ...saved].filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true }).sort((a, b) => priority[a.status] - priority[b.status] || b.updatedAt - a.updatedAt)
}

export interface WorkspaceActivityController {
  items: ActivityItem[]
  isSample: boolean
  error: string
  refresh: () => void
  demo?: { playing: boolean; setPlaying: (playing: boolean) => void; reset: () => void }
}
