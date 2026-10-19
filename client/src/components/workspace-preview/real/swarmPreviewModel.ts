/** Local sample data only. This model has no clocks, storage, network or task
 * execution. The controller supplies IDs/timestamps and explicitly completes
 * or cancels each sample reply. */
export type SwarmAgentId = 'Nalu' | 'Rocky' | 'Milo'
export type SwarmThread = 'group' | SwarmAgentId
export type SwarmTaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'paused'
export interface SwarmProject {
  id: string; title: string; brief: string; members: SwarmAgentId[]; createdAt: number; updatedAt: number
}
export interface SwarmRoom { id: string; projectId: string; thread: SwarmThread; title: string }
export interface SwarmTask {
  id: string; projectId: string; title: string; assignee: SwarmAgentId; status: SwarmTaskStatus
  summary: string; chatId?: string; updatedAt: number; threads?: SwarmThread[]
}
export interface SwarmMessage {
  id: string; projectId: string; thread: SwarmThread; speaker: 'You' | SwarmAgentId
  content: string; createdAt: number; turnId?: string; sample: true
}
export interface SwarmTurn {
  id: string; projectId: string; thread: SwarmThread; replySpeaker: SwarmAgentId
  userMessageId: string; replyId: string; status: 'pending' | 'completed' | 'cancelled'
  createdAt: number; updatedAt: number
}
export interface SwarmState {
  version: 1; mode: 'sample'; projects: SwarmProject[]; tasks: SwarmTask[]
  messages: SwarmMessage[]; turns: SwarmTurn[]
}
export type SwarmAction =
  | { type: 'create-project'; id: string; title: string; brief?: string; at: number }
  | { type: 'update-project'; projectId: string; title?: string; brief?: string; at: number }
  | { type: 'add-task'; task: SwarmTask }
  | { type: 'assign-task'; projectId: string; taskId: string; assignee: SwarmAgentId; at: number }
  | { type: 'update-task'; projectId: string; taskId: string; status?: SwarmTaskStatus; title?: string; summary?: string; at: number }
  | { type: 'send'; projectId: string; thread: SwarmThread; content: string; messageId: string; turnId: string; replyId: string; at: number; replySpeaker?: SwarmAgentId }
  | { type: 'complete'; turnId: string; content: string; at: number }
  | { type: 'cancel'; turnId: string; at: number }
  | { type: 'stop-thread'; projectId: string; thread: SwarmThread; at: number }

export const SWARM_AGENTS: readonly SwarmAgentId[] = ['Nalu', 'Rocky', 'Milo']
const TASK_STATUSES: readonly SwarmTaskStatus[] = ['queued', 'running', 'waiting', 'done', 'paused']
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15
const validAgent = (value: unknown): value is SwarmAgentId => SWARM_AGENTS.includes(value as SwarmAgentId)
const content = (value: unknown, limit = 12_000) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const projectFor = (state: SwarmState, projectId: string) => state.projects.find(project => project.id === projectId)
export const isSwarmRoom = (state: SwarmState, projectId: string, thread: unknown): thread is SwarmThread => {
  const project = projectFor(state, projectId)
  return !!project && (thread === 'group' || validAgent(thread) && project.members.includes(thread))
}
const validRoom = isSwarmRoom
const taskThreads = (task: SwarmTask): SwarmThread[] => task.threads ?? ['group', task.assignee]
const validTaskThreads = (threads: unknown, members: readonly SwarmAgentId[]) => threads === undefined || Array.isArray(threads)
  && threads.length > 0 && new Set(threads).size === threads.length
  && threads.every(thread => thread === 'group' || validAgent(thread) && members.includes(thread))

export const swarmRoomId = (projectId: string, thread: SwarmThread): string => `${encodeURIComponent(projectId)}::${encodeURIComponent(thread)}`
export function swarmRooms(state: SwarmState, projectId: string): SwarmRoom[] {
  const project = projectFor(state, projectId)
  if (!project) return []
  return (['group', ...project.members] as SwarmThread[]).map(thread => ({ id: swarmRoomId(projectId, thread), projectId, thread, title: thread === 'group' ? 'Group chat' : thread }))
}
export const selectSwarmMessages = (state: SwarmState, projectId: string, thread: SwarmThread): SwarmMessage[] => validRoom(state, projectId, thread) ? state.messages.filter(message => message.projectId === projectId && message.thread === thread) : []
export const selectSwarmTasks = (state: SwarmState, projectId: string): SwarmTask[] => projectFor(state, projectId) ? state.tasks.filter(task => task.projectId === projectId) : []
export const selectSwarmThreadTasks = (state: SwarmState, projectId: string, thread: SwarmThread): SwarmTask[] => validRoom(state, projectId, thread)
  ? state.tasks.filter(task => task.projectId === projectId && taskThreads(task).includes(thread)) : []
export const selectSwarmPending = (state: SwarmState, projectId: string, thread: SwarmThread): SwarmTurn[] => validRoom(state, projectId, thread) ? state.turns.filter(turn => turn.projectId === projectId && turn.thread === thread && turn.status === 'pending') : []

/** Validate an untrusted local restore before selectors or reducers use it.
 * Account/owner authorization belongs to the controller, not this data model. */
export function isSwarmState(value: unknown): value is SwarmState {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const unique = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length
  if (!record(value) || value.version !== 1 || value.mode !== 'sample' || !Array.isArray(value.projects) || !Array.isArray(value.tasks) || !Array.isArray(value.messages) || !Array.isArray(value.turns)) return false
  if (!value.projects.every(project => record(project) && validId(project.id) && typeof project.title === 'string' && !!project.title.trim() && typeof project.brief === 'string' && validTime(project.createdAt) && validTime(project.updatedAt) && Array.isArray(project.members) && project.members.length > 0 && project.members.every(validAgent) && new Set(project.members).size === project.members.length)) return false
  const projects = value.projects as SwarmProject[]
  const projectById = new Map(projects.map(project => [project.id, project]))
  const room = (projectId: unknown, thread: unknown) => typeof projectId === 'string' && !!projectById.get(projectId) && (thread === 'group' || validAgent(thread) && projectById.get(projectId)!.members.includes(thread))
  if (!value.tasks.every(task => record(task) && validId(task.id) && typeof task.projectId === 'string' && projectById.get(task.projectId)?.members.includes(task.assignee as SwarmAgentId) && validTaskThreads(task.threads, projectById.get(task.projectId)!.members) && TASK_STATUSES.includes(task.status as SwarmTaskStatus) && typeof task.title === 'string' && !!task.title.trim() && typeof task.summary === 'string' && validTime(task.updatedAt) && (task.chatId === undefined || validId(task.chatId)))) return false
  if (!value.messages.every(message => record(message) && validId(message.id) && room(message.projectId, message.thread) && (message.speaker === 'You' || validAgent(message.speaker) && projectById.get(message.projectId as string)!.members.includes(message.speaker) && (message.thread === 'group' || message.speaker === message.thread)) && typeof message.content === 'string' && !!message.content.trim() && validTime(message.createdAt) && message.sample === true && (message.turnId === undefined || validId(message.turnId)))) return false
  const messages = value.messages as SwarmMessage[]
  const messageById = new Map(messages.map(message => [message.id, message]))
  if (!value.turns.every(turn => {
    if (!record(turn) || !validId(turn.id) || !validId(turn.userMessageId) || !validId(turn.replyId) || !room(turn.projectId, turn.thread) || !validAgent(turn.replySpeaker) || !projectById.get(turn.projectId as string)!.members.includes(turn.replySpeaker) || (turn.thread !== 'group' && turn.replySpeaker !== turn.thread) || typeof turn.status !== 'string' || !['pending', 'completed', 'cancelled'].includes(turn.status) || !validTime(turn.createdAt) || !validTime(turn.updatedAt)) return false
    const user = messageById.get(turn.userMessageId), reply = messageById.get(turn.replyId)
    if (!user || user.speaker !== 'You' || user.projectId !== turn.projectId || user.thread !== turn.thread || user.turnId !== turn.id) return false
    return turn.status === 'completed' ? !!reply && reply.turnId === turn.id && reply.speaker === turn.replySpeaker && reply.projectId === turn.projectId && reply.thread === turn.thread : !reply
  })) return false
  const tasks = value.tasks as SwarmTask[], turns = value.turns as SwarmTurn[]
  return unique(projects) && unique(tasks) && unique(messages) && unique(turns) && new Set(turns.map(turn => turn.replyId)).size === turns.length
}

/** Merge concurrent local-preview snapshots. Messages are append-only and a
 * settled reply cannot become pending again when an older tab writes a draft.
 * Deterministic tie breaks let tabs converge without bouncing storage events. */
export function mergeSwarmStates(left: SwarmState, right: SwarmState): SwarmState {
  const choose = <T,>(a: T, b: T, at: number, bt: number): T => at !== bt ? at > bt ? a : b : JSON.stringify(a) >= JSON.stringify(b) ? a : b
  const union = <T extends { id: string },>(a: T[], b: T[], winner: (a: T, b: T) => T): T[] => {
    const items = new Map(a.map(item => [item.id, item]))
    for (const item of b) items.set(item.id, items.has(item.id) ? winner(items.get(item.id)!, item) : item)
    return [...items.values()]
  }
  const updated = <T extends { updatedAt: number },>(a: T, b: T) => choose(a, b, a.updatedAt, b.updatedAt)
  const projects = union(left.projects, right.projects, updated).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const tasks = union(left.tasks, right.tasks, updated).sort((a, b) => a.id.localeCompare(b.id))
  const turns = union(left.turns, right.turns, (a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return b
    if (b.status === 'pending' && a.status !== 'pending') return a
    // An explicit stop wins a simultaneous completion, including a slow tab.
    if (a.status !== b.status) return a.status === 'cancelled' ? a : b
    return updated(a, b)
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const messages = union(left.messages, right.messages, (a, b) => choose(a, b, a.createdAt, b.createdAt))
  const byId = new Map(messages.map(message => [message.id, message]))
  for (const turn of turns) {
    if (turn.status !== 'completed') byId.delete(turn.replyId)
    else {
      // Keep the reply paired with the winning completed turn, not a competing
      // tab's response assembled from a different board snapshot.
      const source = left.turns.includes(turn) ? left : right
      const reply = source.messages.find(message => message.id === turn.replyId)
      if (reply) byId.set(reply.id, reply)
    }
  }
  const merged: SwarmState = { version: 1, mode: 'sample', projects, tasks, turns,
    messages: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }
  // Invalid/colliding imported identities must not break the current session.
  return isSwarmState(merged) ? merged : left
}

export function initialSwarmState(now: number = Date.UTC(2026, 9, 18, 12)): SwarmState {
  const at = validTime(now) ? now : 0
  const projects: SwarmProject[] = [
    { id: 'swarm-launch', title: 'Coastal launch', brief: 'Bring the launch website, spending plan and team brief together for a calm, coordinated release.', members: [...SWARM_AGENTS], createdAt: at, updatedAt: at },
    { id: 'swarm-travel', title: 'Lisbon long weekend', brief: 'Plan three relaxed days in Lisbon for two people, with walkable neighborhoods and a clear travel budget. Dates are still to be decided.', members: [...SWARM_AGENTS], createdAt: at, updatedAt: at },
  ]
  const tasks: SwarmTask[] = [
    { id: 'launch-website', projectId: 'swarm-launch', title: 'Review the launch website', assignee: 'Nalu', threads: ['group', 'Nalu'], status: 'queued', summary: 'Review the saved Coastal launch website and collect changes for the release.', chatId: 'preview-website', updatedAt: at },
    { id: 'launch-budget', projectId: 'swarm-launch', title: 'Check the launch budget', assignee: 'Rocky', threads: ['group', 'Rocky'], status: 'queued', summary: 'Review the saved launch budget, check assumptions and identify costs to confirm.', chatId: 'preview-budget', updatedAt: at },
    { id: 'launch-brief', projectId: 'swarm-launch', title: 'Review the team brief', assignee: 'Milo', threads: ['group', 'Milo'], status: 'waiting', summary: 'The saved launch brief needs your feedback before it is shared.', chatId: 'preview-brief', updatedAt: at },
    { id: 'travel-plan', projectId: 'swarm-travel', title: 'Outline three days in Lisbon', assignee: 'Nalu', threads: ['group', 'Nalu'], status: 'queued', summary: 'Group the itinerary by neighborhood and leave time between activities.', updatedAt: at },
    { id: 'travel-budget', projectId: 'swarm-travel', title: 'Set the trip budget', assignee: 'Rocky', threads: ['group', 'Rocky'], status: 'paused', summary: 'Agree on a spending cap before comparing accommodation and transport.', updatedAt: at },
    { id: 'travel-stay', projectId: 'swarm-travel', title: 'Choose dates and a neighborhood', assignee: 'Milo', threads: ['group', 'Milo'], status: 'waiting', summary: 'Confirm the dates and how much walking feels comfortable.', updatedAt: at },
  ]
  const openers: Record<string, Record<SwarmAgentId, { group: string; direct: string }>> = {
    'swarm-launch': {
      Nalu: { group: 'I can help bring the website, budget and team brief together. What needs to be ready for launch first?', direct: 'Let’s work through the launch website. What would you like visitors to understand or do first?' },
      Rocky: { group: 'I’m here for the spending plan. Do you have a total budget in mind, or should we start with the saved figures?', direct: 'What’s the spending cap for this launch? We can use it to work through the budget and flag anything that needs a closer look.' },
      Milo: { group: 'I can help with the team brief. What should everyone understand before release?', direct: 'Let’s make the team brief clear. Who is it for, and what decision should it help them make?' },
    },
    'swarm-travel': {
      Nalu: { group: 'Let’s shape the Lisbon weekend around your pace. Are there any places you definitely want to include?', direct: 'For three days in Lisbon, would you prefer a loose neighborhood plan or a more structured itinerary?' },
      Rocky: { group: 'I can help work through the travel budget. What would you like to spend for the two of you?', direct: 'What’s your budget for the weekend, and should it include flights? That will help us separate the essentials from the nice-to-haves.' },
      Milo: { group: 'I can help narrow down dates and a neighborhood. How much walking feels comfortable for you?', direct: 'Do you have dates in mind yet? Tell me what matters most in a neighborhood: quiet evenings, restaurants, or easy transport.' },
    },
  }
  const messages: SwarmMessage[] = projects.flatMap(project => [
    ...project.members.map(agent => ({ id: agent === 'Nalu' ? `${project.id}:welcome` : `${project.id}:welcome:${agent}`, projectId: project.id, thread: 'group' as const, speaker: agent, content: openers[project.id][agent].group, createdAt: at, sample: true as const })),
    ...project.members.map(agent => ({ id: `${project.id}:hello:${agent}`, projectId: project.id, thread: agent, speaker: agent, content: openers[project.id][agent].direct, createdAt: at, sample: true as const })),
  ])
  return { version: 1, mode: 'sample', projects, tasks, messages, turns: [] }
}

export function reduceSwarm(state: SwarmState, action: SwarmAction): SwarmState {
  if (state.version !== 1 || state.mode !== 'sample') return state
  if (action.type === 'create-project') {
    const title = content(action.title, 120)
    if (!validId(action.id) || !title || !validTime(action.at) || projectFor(state, action.id)) return state
    return { ...state, projects: [...state.projects, { id: action.id, title, brief: content(action.brief, 2000), members: [...SWARM_AGENTS], createdAt: action.at, updatedAt: action.at }] }
  }
  if (action.type === 'update-project') {
    const project = projectFor(state, action.projectId)
    if (!project || !validTime(action.at) || (action.title !== undefined && !content(action.title, 120))) return state
    return { ...state, projects: state.projects.map(item => item.id !== project.id ? item : { ...item, ...(action.title !== undefined ? { title: content(action.title, 120) } : {}), ...(action.brief !== undefined ? { brief: content(action.brief, 2000) } : {}), updatedAt: Math.max(item.updatedAt, action.at) }) }
  }
  if (action.type === 'add-task') {
    const task = action.task, project = projectFor(state, task.projectId)
    if (!project || !validId(task.id) || state.tasks.some(item => item.id === task.id) || !project.members.includes(task.assignee) || !validTaskThreads(task.threads, project.members) || !TASK_STATUSES.includes(task.status) || !content(task.title, 180) || !validTime(task.updatedAt)) return state
    return { ...state, tasks: [...state.tasks, { ...task, threads: [...taskThreads(task)], title: content(task.title, 180), summary: content(task.summary, 2000), ...(task.chatId && validId(task.chatId) ? { chatId: task.chatId } : { chatId: undefined }) }] }
  }
  if (action.type === 'assign-task' || action.type === 'update-task') {
    const project = projectFor(state, action.projectId)
    const task = state.tasks.find(item => item.id === action.taskId && item.projectId === action.projectId)
    if (!project || !task || !validTime(action.at)) return state
    if (action.type === 'assign-task' && !project.members.includes(action.assignee)) return state
    if (action.type === 'update-task' && ((action.status !== undefined && !TASK_STATUSES.includes(action.status)) || (action.title !== undefined && !content(action.title, 180)))) return state
    // Materialize a legacy task's original rooms before changing its owner.
    const changes = action.type === 'assign-task' ? { assignee: action.assignee, threads: [...taskThreads(task)] } : {
      ...(action.status !== undefined ? { status: action.status } : {}),
      ...(action.title !== undefined ? { title: content(action.title, 180) } : {}),
      ...(action.summary !== undefined ? { summary: content(action.summary, 2000) } : {}),
    }
    return { ...state, tasks: state.tasks.map(item => item.id !== task.id ? item : { ...item, ...changes, updatedAt: Math.max(item.updatedAt, action.at) }) }
  }
  if (action.type === 'send') {
    const text = content(action.content)
    if (!validRoom(state, action.projectId, action.thread) || !text || !validTime(action.at) || ![action.messageId, action.turnId, action.replyId].every(validId) || action.messageId === action.replyId) return state
    const reserved = (id: string) => state.messages.some(message => message.id === id) || state.turns.some(turn => turn.replyId === id)
    if (state.turns.some(turn => turn.id === action.turnId) || reserved(action.messageId) || reserved(action.replyId)) return state
    const replySpeaker = action.thread === 'group' ? action.replySpeaker || 'Nalu' : action.thread
    if (!projectFor(state, action.projectId)!.members.includes(replySpeaker)) return state
    return { ...state,
      messages: [...state.messages, { id: action.messageId, projectId: action.projectId, thread: action.thread, speaker: 'You', content: text, createdAt: action.at, turnId: action.turnId, sample: true }],
      turns: [...state.turns, { id: action.turnId, projectId: action.projectId, thread: action.thread, replySpeaker, userMessageId: action.messageId, replyId: action.replyId, status: 'pending', createdAt: action.at, updatedAt: action.at }],
    }
  }
  if (action.type === 'stop-thread') {
    if (!validRoom(state, action.projectId, action.thread) || !validTime(action.at)) return state
    if (!selectSwarmPending(state, action.projectId, action.thread).length) return state
    return { ...state, turns: state.turns.map(turn => turn.projectId === action.projectId && turn.thread === action.thread && turn.status === 'pending' ? { ...turn, status: 'cancelled', updatedAt: Math.max(turn.updatedAt, action.at) } : turn) }
  }
  if (action.type === 'cancel' || action.type === 'complete') {
    const turn = state.turns.find(item => item.id === action.turnId)
    if (!turn || turn.status !== 'pending' || !validTime(action.at)) return state
    const at = Math.max(turn.updatedAt, action.at)
    if (action.type === 'cancel') return { ...state, turns: state.turns.map(item => item.id === turn.id ? { ...item, status: 'cancelled', updatedAt: at } : item) }
    const text = content(action.content)
    const userMessage = state.messages.find(message => message.id === turn.userMessageId)
    if (!text || !validRoom(state, turn.projectId, turn.thread) || !userMessage || userMessage.projectId !== turn.projectId || userMessage.thread !== turn.thread || userMessage.speaker !== 'You' || state.messages.some(message => message.id === turn.replyId)) return state
    return { ...state,
      messages: [...state.messages, { id: turn.replyId, projectId: turn.projectId, thread: turn.thread, speaker: turn.replySpeaker, content: text, createdAt: at, turnId: turn.id, sample: true }],
      turns: state.turns.map(item => item.id === turn.id ? { ...item, status: 'completed', updatedAt: at } : item),
    }
  }
  return state
}

/** A deterministic response for the explicitly labeled sample workspace. The
 * project brief is shared, but task context is limited to this conversation.
 * Private messages from other rooms are never read or copied. Producing a
 * response does not change the board. */
export function sampleReply({ state, projectId, recipient, text }: { state: SwarmState; projectId: string; recipient: SwarmThread; text: string }): string | null {
  const project = projectFor(state, projectId), question = content(text).replace(/\s+/g, ' ')
  if (state.mode !== 'sample' || !project || !validRoom(state, projectId, recipient) || !question) return null
  const allTasks = selectSwarmThreadTasks(state, projectId, recipient)
  const tasks = allTasks
  const topicPatterns = [/\b(website|site|page|visitors?)\b/i, /\b(budget|costs?|spend|spending|prices?|money|cap)\b/i, /\b(brief|release|audience)\b/i, /\b(itinerary|activities|days)\b/i, /\b(dates|neighborhood|walking|stay)\b/i]
  const topic = topicPatterns.find(pattern => pattern.test(question))
  const mentioned = topic ? allTasks.find(task => topic.test(task.title)) || allTasks.find(task => topic.test(task.summary)) : undefined
  const focus = mentioned || tasks.find(task => task.status === 'waiting') || tasks.find(task => task.status !== 'done') || tasks[0]
  const status = (task: SwarmTask) => task.status === 'running' ? 'in progress' : task.status === 'waiting' ? 'waiting for your input' : task.status
  const board = tasks.length ? tasks.map(task => `• ${task.title} — ${task.assignee}, ${status(task)}.`).join('\n') : 'There aren’t any tasks assigned here yet.'
  if (/^(hi|hello|hey)( there| everyone| nalu| rocky| milo)?[!. ]*$/i.test(question)) return `Hey! What would you like to work on${recipient === 'group' || recipient === 'Nalu' ? ` for ${project.title}` : focus ? ` with ${focus.title.toLowerCase().replace(/^(review|check|set|choose|outline) /, '')}` : ''}?`
  if (/^(thanks|thank you|cheers)[!. ]*$/i.test(question)) return 'You’re welcome! Let me know what you’d like to work through next.'
  if (/\b(stop|pause|cancel)\b/i.test(question)) return `To hold a task, set its status to Paused. To cancel a pending reply, use Stop.${focus ? ` ${focus.title} is currently ${status(focus)}.` : ''} I haven’t changed anything from this message.`
  if (/\b(status|progress|update|going|doing|overview|summary|oversight)\b/i.test(question)) {
    const relevant = mentioned ? `• ${mentioned.title} — ${mentioned.assignee}, ${status(mentioned)}.` : board
    const waiting = mentioned?.status === 'waiting' ? mentioned : !mentioned ? tasks.find(task => task.status === 'waiting') : undefined
    return `Here’s where ${mentioned ? 'that' : project.title} stands:\n\n${relevant}${waiting ? `\n\n${waiting.summary} What feedback would you like to give?` : ''}`
  }
  if (/\b(who|assign|owner|owns|responsible|team)\b/i.test(question)) return mentioned
    ? `${mentioned.assignee} is assigned to “${mentioned.title}”. It’s ${status(mentioned)}. ${mentioned.summary}`
    : `Here’s how the work is divided for ${project.title}:\n\n${board}`
  if (/\b(budget|costs?|spend|spending|prices?|money|cap)\b/i.test(question)) {
    const budget = allTasks.find(task => /budget|cost|spend/i.test(`${task.title} ${task.summary}`))
    return `${budget ? `${budget.assignee} is assigned to the budget, which is ${status(budget)}. ${budget.summary}` : 'We can start by setting a budget for this project.'}\n\nWhat spending cap should we use, and which costs need to fit within it? I don’t have a confirmed total or live prices here.`
  }
  if (/\b(next|priority|priorities|first|plan)\b/i.test(question)) return focus
    ? `${focus.status === 'done' ? 'That task is marked done, so I’d check whether anything needs a final revision' : focus.status === 'paused' ? 'That task is paused, so I’d first confirm what needs to be resolved before resuming' : `I’d start with “${focus.title}”`}. ${focus.summary}\n\n${focus.status === 'waiting' ? 'What would you like to clarify before moving ahead?' : 'What’s the most important outcome for this step?'}`
    : `Let’s choose one concrete deliverable for ${project.title}.${project.brief ? ` The goal is: ${project.brief}` : ''} What would you like to have ready first?`
  if (/\b(travel|trip|flights?|hotels?|itinerary|destination|dates|neighborhood)\b/i.test(question)) return `${project.brief || 'Let’s start with where you want to go, your dates and your budget.'}\n\nI’d settle the dates first, then choose a base and group activities nearby. Are your dates fixed, or is there some flexibility?`
  if (/\b(write|draft|build|create|make|change|revise|add)\b/i.test(question)) {
    if (focus && /website|site|page/i.test(`${focus.title} ${focus.summary}`)) return 'For the website, I’d lead with a clear promise, show what the product does, then give visitors one obvious next step. Who is the page for, and what should they do after reading it?'
    if (focus && /brief/i.test(`${focus.title} ${focus.summary}`)) return 'I’d structure the brief around the goal, what’s changing, who owns each part, and the decision you need from the reader. Who will read it, and what do they need to decide?'
    return `Let’s pin down what the first draft should cover.${focus ? ` It connects to “${focus.title}”: ${focus.summary}` : project.brief ? ` ${project.brief}` : ''} Who is it for, and what should it help them do?`
  }
  return `${focus ? `${focus.summary}${focus.status === 'waiting' ? ' Your input is the next thing needed.' : ''}` : project.brief || `Let’s give ${project.title} a clear goal.`}\n\nWhat would you like to figure out first?`
}
