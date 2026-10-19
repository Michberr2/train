import { SwarmError, swarmContext } from './_swarm'
import type { SwarmJob, SwarmSnapshot, SwarmStore } from './_swarmStore'
import { STUDIO_KINDS, type StudioKind } from '../shared/studioIntent'
import type { SwarmThread, SwarmAgentId } from '../client/src/components/workspace/design/swarmTypes'

export type SwarmStudioKind = Exclude<StudioKind, 'chat'>
export type SwarmStudioHandoff = {
  sourceJobId: string
  taskId: string
  /** Set by the server's selected generator, never inferred from request context. */
  expectedStudioKind: SwarmStudioKind
}
export type SwarmStudioContinuation = {
  type: 'studio-generation'
  sourceJobId: string
  studioKind: SwarmStudioKind
}
type Reader = Pick<SwarmStore, 'read'>
const scoped = Symbol('validated Swarm generation scope')

/** Server-only value. It contains no account memory, ordinary-chat context,
 * global brand kit, attachments, or client-supplied generation parameters.
 * Do not serialize it to the client: a running scope includes its lease token.
 * Generators must also omit identityBlock/accountContext, retain their normal
 * validation/quota rules, and commit only through store.mutateLeased(). */
export interface SwarmGenerationScope {
  readonly [scoped]: true
  readonly ownerId: string
  readonly sourceJobId: string
  readonly taskId: string
  readonly projectId: string
  readonly thread: SwarmThread
  readonly speaker: SwarmAgentId
  readonly studioKind: SwarmStudioKind
  readonly prompt: string
  readonly brief: string
  readonly context: ReadonlyArray<Readonly<{ role: 'user' | 'assistant'; content: string }>>
  readonly lease?: Readonly<{ jobId: string; token: string }>
}

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value)
const validKind = (value: unknown): value is SwarmStudioKind => typeof value === 'string' && value !== 'chat' && (STUDIO_KINDS as readonly string[]).includes(value)
function fail(message = 'This Studio handoff is no longer available.', status = 409): never { throw new SwarmError(message, status) }

function validateRequest(ownerId: string, request: SwarmStudioHandoff): void {
  // ownerId must come from backend.userId(authToken), not a request body. A
  // caller cannot select a different account by putting owner fields in JSON.
  if (!id(ownerId)) fail('Sign in to continue this work.', 401)
  if (!request || !id(request.sourceJobId) || !id(request.taskId) || !validKind(request.expectedStudioKind)) fail('Invalid Studio handoff.', 400)
}

function sourceFor(snapshot: SwarmSnapshot, request: SwarmStudioHandoff) {
  if (snapshot.state.mode !== 'live') fail('Sample work cannot start production generation.', 400)
  const source = snapshot.jobs.find(job => job.id === request.sourceJobId)
  // Missing and other-account IDs are indistinguishable because the snapshot
  // is read only with the authenticated owner key.
  if (!source) fail('This Studio handoff was not found.', 404)
  const task = snapshot.state.tasks.find(item => item.id === request.taskId)
  const project = snapshot.state.projects.find(item => item.id === source.projectId)
  const artifact = source.artifact
  if (source.kind !== 'task' || source.status !== 'waiting' || source.taskId !== request.taskId || !task || !project
    || task.projectId !== source.projectId || !task.threads?.includes(source.thread)
    || !project.members.includes(source.speaker) || !project.members.includes(task.assignee)
    || (source.thread !== 'group' && !project.members.includes(source.thread))
    || artifact?.type !== 'needs-workspace' || artifact.workspace !== 'studio'
    || artifact.studioKind !== request.expectedStudioKind || !validKind(artifact.studioKind)
    || !source.input.trim() || source.input.length > 12000
    || artifact.prompt !== source.input) fail()
  return { source, task }
}

function scopeFor(ownerId: string, snapshot: SwarmSnapshot, source: SwarmJob, kind: SwarmStudioKind, execution?: SwarmJob): SwarmGenerationScope {
  // The original handoff's cutoff and immutable input remain authoritative.
  // Use the actual continuation speaker so swarmContext's private-thread
  // reassignment guard applies if this task was assigned to another agent.
  const contextJob = execution ? { ...source, speaker: execution.speaker } : source
  const { brief, context } = swarmContext(snapshot, contextJob)
  return Object.freeze({
    [scoped]: true as const, ownerId, sourceJobId: source.id, taskId: source.taskId!,
    projectId: source.projectId, thread: source.thread, speaker: contextJob.speaker,
    studioKind: kind, prompt: source.input, brief,
    context: Object.freeze(context.map(message => Object.freeze({ ...message }))),
    ...(execution ? { lease: Object.freeze({ jobId: execution.id, token: execution.leaseToken! }) } : {}),
  })
}

/** Pure validation for the synchronous store.mutate callback which creates a
 * NEW continuation job. It does not claim, resume, charge, or call a generator.
 * A waiting source attempt remains waiting; task.executionId then moves to the
 * new job ID. The returned unleased scope must never authorize generation. */
export function validateSwarmStudioHandoff(snapshot: SwarmSnapshot, ownerId: string, request: SwarmStudioHandoff): SwarmGenerationScope {
  validateRequest(ownerId, request)
  const { source, task } = sourceFor(snapshot, request)
  if (task.status !== 'waiting' || task.executionId !== source.id
    || snapshot.jobs.some(job => job.taskId === task.id && ['queued', 'running'].includes(job.status))) fail()
  return scopeFor(ownerId, snapshot, source, request.expectedStudioKind)
}

/** A read-only preflight. Repeat validateSwarmStudioHandoff inside the atomic
 * mutation when accepting an explicit Continue action to close the read race. */
export async function resolveSwarmStudioHandoff(store: Reader, ownerId: string, request: SwarmStudioHandoff): Promise<SwarmGenerationScope> {
  validateRequest(ownerId, request)
  return validateSwarmStudioHandoff(await store.read(ownerId), ownerId, request)
}

/** Validate the actual durable worker claim before any provider work. The
 * continuation's marker is persisted by the server, not copied from a client.
 * Its job input/project/thread/task must exactly match the waiting source.
 * Reuse this check on checkpoints and fence the final write with mutateLeased;
 * this read alone cannot protect a result from a subsequent cancellation. */
export function validateSwarmGenerationScope(snapshot: SwarmSnapshot, ownerId: string,
  request: SwarmStudioHandoff & { executionId: string; leaseToken: string }, now = Date.now()): SwarmGenerationScope {
  validateRequest(ownerId, request)
  if (!id(request.executionId) || !id(request.leaseToken) || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) fail('Invalid Studio execution.', 400)
  const { source, task } = sourceFor(snapshot, request)
  const job = snapshot.jobs.find(item => item.id === request.executionId)
  if (!job || job.id === source.id || job.status !== 'running' || job.kind !== 'task'
    || job.leaseToken !== request.leaseToken || !Number.isSafeInteger(job.leaseUntil) || (job.leaseUntil || 0) <= now
    || job.createdAt < source.createdAt || job.projectId !== source.projectId || job.thread !== source.thread
    || job.taskId !== source.taskId || job.input !== source.input || job.speaker !== task.assignee
    || task.status !== 'running' || task.executionId !== job.id
    || job.artifact?.type !== 'studio-generation' || job.artifact.sourceJobId !== source.id
    || job.artifact.studioKind !== request.expectedStudioKind) fail('This Studio execution was stopped or changed.')
  return scopeFor(ownerId, snapshot, source, request.expectedStudioKind, job)
}

export async function resolveSwarmGenerationScope(store: Reader, ownerId: string,
  request: SwarmStudioHandoff & { executionId: string; leaseToken: string }, now: () => number = Date.now): Promise<SwarmGenerationScope> {
  validateRequest(ownerId, request)
  return validateSwarmGenerationScope(await store.read(ownerId), ownerId, request, now())
}

/** In-process guard for future shared generator adapters. A JSON request cannot
 * forge a validated scope, nor can an unleased preflight start generation. */
export function requireLeasedSwarmGeneration(scope: SwarmGenerationScope): void {
  if (!scope || scope[scoped] !== true || !scope.lease) fail('A durable Studio generation claim is required.')
}
