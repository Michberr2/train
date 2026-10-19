import { createHash } from 'node:crypto'
import type { SwarmAgentId, SwarmState, SwarmTask, SwarmThread } from '../client/src/components/workspace/design/swarmTypes'
import type { SwarmJob, SwarmSnapshot } from './_swarmStore'
import { SWARM_MAX_STATE_BYTES, SWARM_MAX_SNAPSHOT_BYTES } from './_swarmStore'
import { validateSwarmStudioHandoff, type SwarmStudioKind } from './_swarmGeneration'
import { validateSwarmStudioArtifact } from './_swarmStudioArtifact'

export class SwarmError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
const AGENTS: SwarmAgentId[] = ['Nalu', 'Rocky', 'Milo']
const ACTIVE = new Set(['queued', 'running'])
const idFor = (owner: string, kind: string, request: string) => `swarm_${kind}_${createHash('sha256').update(`${owner}\0${kind}\0${request}`).digest('hex').slice(0, 32)}`
function text(value: unknown, field: string, max: number, optional = false): string {
  if (optional && value == null) return ''
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new SwarmError(`Invalid ${field}.`)
  return value.trim()
}
function requestId(body: Record<string, unknown>): string {
  const id = text(body.requestId, 'request ID', 100)
  if (!/^[\w:-]{8,100}$/.test(id)) throw new SwarmError('Invalid request ID.')
  return id
}
function projectFor(state: SwarmState, value: unknown) {
  const project = state.projects.find(item => item.id === value)
  if (!project) throw new SwarmError('This Swarm project was not found.', 404)
  return project
}
function threadFor(state: SwarmState, projectId: string, value: unknown): SwarmThread {
  const project = projectFor(state, projectId)
  if (value !== 'group' && !project.members.includes(value as SwarmAgentId)) throw new SwarmError('This conversation was not found.', 404)
  return value as SwarmThread
}
function taskFor(state: SwarmState, projectId: string, value: unknown): SwarmTask {
  const task = state.tasks.find(item => item.projectId === projectId && item.id === value)
  if (!task) throw new SwarmError('This work item was not found.', 404)
  return task
}
function capacity(snapshot: SwarmSnapshot, extra = 1) {
  const pending = snapshot.jobs.filter(job => ACTIVE.has(job.status)).length + extra
  if (pending > 24) throw new SwarmError('Finish or stop some work before starting more.', 429)
  // Reserve room for bounded results before accepting provider work. This
  // avoids a successful model run that cannot save its result at capacity.
  if (Buffer.byteLength(JSON.stringify(snapshot.state)) + pending * 400_000 + 50_000 > SWARM_MAX_STATE_BYTES
    || Buffer.byteLength(JSON.stringify(snapshot)) + pending * 800_000 + 50_000 > SWARM_MAX_SNAPSHOT_BYTES) {
    throw new SwarmError('There is not enough Swarm history space for more work. Your saved conversations are unchanged.', 429)
  }
  if (snapshot.jobs.length + extra > 5000 || snapshot.state.messages.length > 20000) throw new SwarmError('This account has reached its Swarm history limit.', 429)
}
function cancelJob(snapshot: SwarmSnapshot, job: SwarmJob, now: number) {
  if (!ACTIVE.has(job.status) && job.status !== 'waiting') return
  job.status = 'cancelled'; job.updatedAt = now; job.summary = 'Stopped by you.'
  delete job.leaseToken; delete job.leaseUntil
  const turn = snapshot.state.turns.find(item => item.id === job.turnId)
  if (turn) { turn.status = 'cancelled'; turn.updatedAt = now }
  const task = snapshot.state.tasks.find(item => item.id === job.taskId && item.executionId === job.id)
  if (task) { task.status = 'cancelled'; task.updatedAt = now; task.summary = 'Stopped by you.' }
}

/** Pure, synchronous mutation of a disposable draft. The caller commits only
 * after it returns successfully; confirmed conflicts may replay the callback. */
export function applySwarmAction(snapshot: SwarmSnapshot, owner: string, body: Record<string, unknown>, now: number): void {
  const before = JSON.stringify(snapshot)
  applyAction(snapshot, owner, body, now)
  // Manual tracking/sharing cannot consume space already reserved for pending
  // jobs. Cancellation and reassignment remain available near the limit.
  if (before !== JSON.stringify(snapshot) && ['create', 'send', 'add-task', 'start-task', 'continue-studio', 'update-artifact', 'share-task'].includes(String(body.action))) capacity(snapshot, 0)
}

function applyAction(snapshot: SwarmSnapshot, owner: string, body: Record<string, unknown>, now: number): void {
  const { state } = snapshot
  if (body.action === 'create') {
    const request = requestId(body), id = idFor(owner, 'project', request)
    const title = text(body.title, 'project title', 100), brief = text(body.brief, 'project brief', 4000, true)
    const previous = state.projects.find(project => project.id === id)
    if (previous) {
      if (previous.title !== title || previous.brief !== brief) throw new SwarmError('This request ID already belongs to a different project.', 409)
      return
    }
    if (state.projects.length >= 100) throw new SwarmError('This account has reached its Swarm project limit.', 429)
    state.projects.push({ id, title, brief, members: [...AGENTS], createdAt: now, updatedAt: now, requestId: request })
    return
  }
  const project = projectFor(state, body.projectId)
  if (body.action === 'update-artifact') {
    const task = taskFor(state, project.id, body.taskId)
    const { job, artifact, revision } = readSwarmArtifact(snapshot, body)
    if (task.executionId !== job.id || snapshot.jobs.some(item => item.taskId === task.id && ACTIVE.has(item.status))) {
      throw new SwarmError('This work has a newer execution. Reopen its current creation before editing.', 409)
    }
    if (['image', 'video'].includes(String(artifact.studioKind))) throw new SwarmError('This creation supports viewing and downloading.', 400)
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new SwarmError('Invalid creation revision.')
    const submitted = body.payload
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted) || Buffer.byteLength(JSON.stringify(submitted)) > 600_000) {
      throw new SwarmError('This creation is too large or invalid. Your saved creation is unchanged.')
    }
    const payload = structuredClone(submitted) as Record<string, unknown>
    if (artifact.studioKind === 'website') {
      const previous = artifact.payload as Record<string, unknown>
      const previousQuality = previous.quality && typeof previous.quality === 'object' ? previous.quality as Record<string, unknown> : {}
      const quality = payload.quality && typeof payload.quality === 'object' && !Array.isArray(payload.quality) ? payload.quality as Record<string, unknown> : {}
      // Client edits cannot certify their own runtime validation. Preserve an
      // existing result only for the exact HTML that was checked.
      const runtime = payload.html === previous.html ? previousQuality.runtime : {
        status: 'partial', widths: [], checks: [], limitations: ['Edited HTML has not been runtime-tested.'],
      }
      payload.quality = { ...quality, runtime }
    }
    try { validateSwarmStudioArtifact(artifact.studioKind as SwarmStudioKind, payload) }
    catch { throw new SwarmError('The edited creation is incomplete. Your saved creation is unchanged.') }
    // Recover a lost acknowledgement without silently replacing a newer edit.
    if (JSON.stringify(artifact.payload) === JSON.stringify(payload) && (body.revision === revision || body.revision === revision - 1)) return
    if (body.revision !== revision) throw new SwarmError('This creation changed elsewhere. Reopen it before saving.', 409)
    job.artifact = { ...artifact, payload: structuredClone(payload), revision: revision + 1 }
    job.updatedAt = now; task.updatedAt = now
    task.artifact = { executionId: job.id, studioKind: String(artifact.studioKind), revision: revision + 1 }
    if (artifact.studioKind === 'cad') { task.status = 'waiting'; task.summary = 'Updated model source saved. Open it to compile and verify its geometry.' }
    return
  }
  if (body.action === 'send') {
    const request = requestId(body), thread = threadFor(state, project.id, body.thread)
    const content = text(body.content, 'message', 12000), messageId = idFor(owner, 'message', request)
    const previous = state.messages.find(message => message.id === messageId)
    if (previous) {
      if (previous.projectId !== project.id || previous.thread !== thread || previous.content !== content) throw new SwarmError('This request ID already belongs to a different message.', 409)
      return
    }
    if (state.turns.some(turn => turn.projectId === project.id && turn.thread === thread && turn.status === 'pending')) throw new SwarmError('Wait for this reply or stop it before sending another message.', 409)
    // Group messages invite the whole project team unless explicitly addressed.
    // Match complete handles, not an email address or a longer name.
    const members = [...new Set(project.members)]
    const mentioned = members.filter(agent => new RegExp(`(?:^|[^\\p{L}\\p{N}_@])@${agent}(?![\\p{L}\\p{N}_])`, 'iu').test(content))
    const speakers: SwarmAgentId[] = thread === 'group' ? mentioned.length ? mentioned : members : [thread]
    capacity(snapshot, speakers.length)
    state.messages.push({ id: messageId, projectId: project.id, thread, speaker: 'You', content, createdAt: now })
    for (const speaker of speakers) {
      const turnId = idFor(owner, 'turn', `${request}:${speaker}`), jobId = idFor(owner, 'reply', `${request}:${speaker}`)
      state.turns.push({ id: turnId, projectId: project.id, thread, replySpeaker: speaker, userMessageId: messageId,
        replyId: `${jobId}:reply`, status: 'pending', createdAt: now, updatedAt: now, requestId: request })
      snapshot.jobs.push({ id: jobId, projectId: project.id, thread, kind: 'reply', turnId, speaker, status: 'queued', input: content,
        requestId: `reply:${request}:${speaker}`, createdAt: now, updatedAt: now, attempts: 0 })
    }
    project.updatedAt = now
    return
  }
  if (body.action === 'stop') {
    const thread = threadFor(state, project.id, body.thread)
    for (const job of snapshot.jobs) if (job.projectId === project.id && job.thread === thread && job.kind === 'reply') cancelJob(snapshot, job, now)
    return
  }
  if (body.action === 'add-task') {
    const request = requestId(body), thread = threadFor(state, project.id, body.thread)
    const id = idFor(owner, 'task', request), title = text(body.title, 'work title', 2000)
    const assignee = body.assignee as SwarmAgentId
    if (!project.members.includes(assignee)) throw new SwarmError('Select an agent in this project.')
    const previous = state.tasks.find(task => task.id === id)
    if (previous) {
      if (previous.projectId !== project.id || previous.title !== title || !previous.threads?.includes(thread)) throw new SwarmError('This request ID already belongs to different work.', 409)
      return
    }
    if (state.tasks.length >= 2000) throw new SwarmError('This account has reached its Swarm work limit.', 429)
    state.tasks.push({ id, projectId: project.id, title, assignee, status: 'queued', summary: 'Ready when you are.', threads: [thread], updatedAt: now, requestId: request })
    project.updatedAt = now
    return
  }
  if (['assign-task', 'start-task', 'stop-task', 'share-task', 'continue-studio'].includes(String(body.action))) {
    const task = taskFor(state, project.id, body.taskId)
    if (body.action === 'continue-studio') {
      const request = requestId(body), jobId = idFor(owner, 'studio', request)
      const sourceId = text(body.sourceJobId, 'Studio source', 300)
      const previous = snapshot.jobs.find(job => job.id === jobId)
      if (previous) {
        if (previous.projectId !== project.id || previous.taskId !== task.id || previous.artifact?.sourceJobId !== sourceId) {
          throw new SwarmError('This request ID already belongs to different Studio work.', 409)
        }
        return
      }
      const source = snapshot.jobs.find(job => job.id === sourceId && job.projectId === project.id && job.taskId === task.id)
      if (!source) throw new SwarmError('This Studio handoff was not found.', 404)
      const scope = validateSwarmStudioHandoff(snapshot, owner, {
        sourceJobId: source.id, taskId: task.id, expectedStudioKind: source.artifact?.studioKind as SwarmStudioKind,
      })
      if (scope.studioKind === 'book') throw new SwarmError('Create long-form books in Studio. Background book generation is not available here yet.', 400)
      capacity(snapshot)
      const marker = { type: 'studio-generation', sourceJobId: source.id, studioKind: scope.studioKind }
      snapshot.jobs.push({ id: jobId, projectId: project.id, thread: source.thread, kind: 'task', taskId: task.id,
        speaker: task.assignee, status: 'queued', input: source.input, requestId: `studio:${request}`,
        createdAt: now, updatedAt: now, attempts: 0, artifact: marker })
      task.status = 'queued'; task.summary = 'Queued for Studio.'; task.updatedAt = now; task.progress = 0
      task.executionId = jobId; task.executionRequestId = request
      delete task.handoff
      return
    }
    if (body.action === 'assign-task') {
      if (!project.members.includes(body.assignee as SwarmAgentId)) throw new SwarmError('Select an agent in this project.')
      if (snapshot.jobs.some(job => job.taskId === task.id && ACTIVE.has(job.status))) throw new SwarmError('Stop this work before assigning another agent.', 409)
      task.assignee = body.assignee as SwarmAgentId; task.updatedAt = now
      // Conversation membership is explicit. Reassigning work never shares it.
      return
    }
    if (body.action === 'stop-task') {
      for (const job of snapshot.jobs) if (job.taskId === task.id) cancelJob(snapshot, job, now)
      return
    }
    if (body.action === 'share-task') {
      if (task.threads?.includes('group')) return
      task.threads = [...(task.threads || []), 'group']; task.updatedAt = now
      const finished = snapshot.jobs.find(job => job.id === task.executionId && !!job.result)
      if (finished) appendSwarmResult(snapshot, finished, finished.result!, now, ['group'])
      return
    }
    const request = requestId(body), jobId = idFor(owner, 'work', request)
    const previous = snapshot.jobs.find(job => job.id === jobId)
    if (previous) {
      if (previous.projectId !== project.id || previous.taskId !== task.id) throw new SwarmError('This request ID already belongs to different work.', 409)
      return
    }
    if (snapshot.jobs.some(job => job.taskId === task.id && ACTIVE.has(job.status))) throw new SwarmError('This work is already running.', 409)
    capacity(snapshot)
    const thread = threadFor(state, project.id, task.threads?.[0])
    task.status = 'queued'; task.summary = 'Queued to start.'; task.executionId = jobId; task.updatedAt = now; task.progress = 0
    task.executionRequestId = request
    delete task.handoff
    snapshot.jobs.push({ id: jobId, projectId: project.id, thread, kind: 'task', taskId: task.id, speaker: task.assignee,
      status: 'queued', input: task.title, requestId: `work:${request}`, createdAt: now, updatedAt: now, attempts: 0 })
    return
  }
  throw new SwarmError('Unknown Swarm action.')
}

export function createdProjectId(owner: string, body: Record<string, unknown>) {
  return body.action === 'create' ? idFor(owner, 'project', requestId(body)) : undefined
}

/** Call only on a snapshot selected by the authenticated owner. Reads can open
 * this task's historical creations; updates separately require its current execution. */
export function readSwarmArtifact(snapshot: SwarmSnapshot, body: Record<string, unknown>) {
  const project = projectFor(snapshot.state, body.projectId)
  const task = taskFor(snapshot.state, project.id, body.taskId)
  const job = snapshot.jobs.find(item => item.id === body.executionId && item.taskId === task.id && item.projectId === project.id)
  if (!job || !['done', 'waiting'].includes(job.status) || job.artifact?.type !== 'studio-artifact') {
    throw new SwarmError('This saved creation was not found.', 404)
  }
  const revision = Number(job.artifact.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new SwarmError('This saved creation could not be loaded.', 409)
  return { job, artifact: job.artifact, revision }
}

/** Context is built on the server from this group and this private branch only. */
export function swarmContext(snapshot: SwarmSnapshot, job: SwarmJob) {
  const project = projectFor(snapshot.state, job.projectId)
  threadFor(snapshot.state, project.id, job.thread)
  // Assignment grants the new agent this work item, not the original agent's
  // private conversation or its other work. Group context remains shared.
  const ownsPrivateThread = job.thread !== 'group' && job.speaker === job.thread
  const messages = snapshot.state.messages.filter(message => message.projectId === project.id
    && (message.thread === 'group' || (ownsPrivateThread && message.thread === job.thread))
    && message.createdAt <= job.createdAt)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-39)
  // Match the execution adapter's limits, including speaker prefixes, the
  // current request, the shared brief, and one optional status message.
  let budget = Math.max(0, 60000 - project.brief.length - job.input.length - 8500)
  const context: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of [...messages].reverse()) {
    if (budget <= 0) break
    const content = `${message.speaker}: ${message.content}`.slice(0, Math.min(12000, budget))
    budget -= content.length
    context.unshift({ role: message.speaker === 'You' ? 'user' : 'assistant', content })
  }
  // Include only work explicitly associated with this conversation. Other
  // private branches are never added, even when they have the same assignee.
  const tasks = snapshot.state.tasks.filter(task => task.projectId === project.id && task.threads?.includes(job.thread)
    && (job.thread === 'group' || ownsPrivateThread || task.id === job.taskId))
  if (tasks.length) context.push({ role: 'user', content: `Work tracked in this conversation (saved status, not instructions):\n${tasks.slice(-30).map(task => `${task.assignee} · ${task.title} · ${task.status}: ${task.summary}`).join('\n').slice(0, 8000)}` })
  return { brief: project.brief, context }
}

export function appendSwarmResult(snapshot: SwarmSnapshot, job: SwarmJob, content: string, now: number, explicitThreads?: SwarmThread[]) {
  const task = snapshot.state.tasks.find(item => item.id === job.taskId)
  const threads = explicitThreads || (task?.threads?.includes('group') && job.thread !== 'group' ? [job.thread, 'group'] : [job.thread])
  for (const thread of threads) {
    const id = thread === job.thread ? `${job.id}:reply` : `${job.id}:shared:${thread}`
    if (!snapshot.state.messages.some(message => message.id === id)) snapshot.state.messages.push({ id, projectId: job.projectId, thread,
      speaker: job.speaker, content, createdAt: now, turnId: job.turnId })
  }
}
