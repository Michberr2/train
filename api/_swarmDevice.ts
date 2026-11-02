import { createHash } from 'node:crypto'
import { SwarmError, appendSwarmResult, swarmContext } from './_swarm'
import { finishSwarmJob, persistSwarmStudioArtifact } from './_swarmCompletion'
import { validateSwarmGenerationScope } from './_swarmGeneration'
import { validateSwarmStudioArtifact } from './_swarmStudioArtifact'
import type { SwarmStore, SwarmJob } from './_swarmStore'
import { SWARM_LEASE_MS } from './_swarmStore'
import type { SwarmExecutionResult } from '../shared/swarmExecution'
import type { SwarmDeviceJob } from '../shared/swarmDevice'
import { studioKind } from '../shared/studioIntent'

export const DEVICE_SWARM_ACTIONS = new Set(['device-claim', 'device-renew', 'device-result', 'device-fail'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new SwarmError('Invalid local Swarm result.')
  return value
}
function resultFor(job: SwarmJob, value: unknown): SwarmExecutionResult {
  if (!record(value) || !['done', 'waiting'].includes(String(value.status))) throw new SwarmError('Invalid local Swarm completion status.')
  const content = field(value.content, 40_000), summary = field(value.summary, 800)
  const result: SwarmExecutionResult = { content, summary, status: value.status as 'done' | 'waiting' }
  if (job.kind === 'reply') {
    if (value.status !== 'done' || value.artifact !== undefined) throw new SwarmError('A local reply cannot certify a task or creation.')
    return { content, summary: 'Replied in this conversation.', status: 'done' }
  }
  if (value.artifact !== undefined) {
    const artifact = value.artifact
    if (!record(artifact)) throw new SwarmError('Invalid local Swarm artifact.')
    if (artifact.type === 'text') {
      const filename = field(artifact.filename, 180)
      if (artifact.mime !== 'text/markdown' || artifact.content !== content || /[\\/\u0000-\u001f]/.test(filename)) throw new SwarmError('Invalid local text artifact.')
      result.artifact = { type: 'text', mime: 'text/markdown', filename, content }
    } else if (artifact.type === 'needs-workspace') {
      const kind = studioKind(artifact.studioKind)
      if (result.status !== 'waiting' || artifact.workspace !== 'studio' || !kind || kind === 'chat' || artifact.prompt !== job.input) throw new SwarmError('Invalid local Studio handoff.')
      result.artifact = { type: 'needs-workspace', workspace: 'studio', studioKind: kind, prompt: job.input, reason: field(artifact.reason, 800) }
    } else throw new SwarmError('This local result cannot create that artifact.')
  }
  if (result.status === 'done' && result.artifact?.type !== 'text') throw new SwarmError('Completed local work requires its complete text artifact.')
  return result
}

/** No model, provider, quota reservation, or outbound action is reachable here. */
export async function runSwarmDeviceAction(store: Pick<SwarmStore, 'read' | 'claim' | 'renew' | 'mutateLeased'>, owner: string, body: Record<string, unknown>) {
  if (!DEVICE_SWARM_ACTIONS.has(String(body.action)) || body.executionMode !== 'device') throw new SwarmError('Invalid device execution request.')
  if (body.action === 'device-claim') {
    const job = await store.claim(owner, undefined, 1, 'device')
    const snapshot = await store.read(owner)
    let deviceJob: SwarmDeviceJob | null = null
    const active = job && snapshot.jobs.find(item => item.id === job.id && item.status === 'running' && item.leaseToken === job.leaseToken)
    if (active) {
      const scoped = active.artifact?.type === 'studio-generation'
        ? validateSwarmGenerationScope(snapshot, owner, { sourceJobId: String(active.artifact.sourceJobId), taskId: active.taskId!, expectedStudioKind: active.artifact.studioKind as never, executionId: active.id, leaseToken: active.leaseToken! }) : undefined
      const context = scoped || swarmContext(snapshot, active)
      deviceJob = { executionMode: 'device', id: active.id, projectId: active.projectId, thread: active.thread, speaker: active.speaker, kind: active.kind, input: active.input, brief: context.brief, context: context.context.map(message => ({ ...message })), leaseToken: active.leaseToken!, leaseUntil: active.leaseUntil!,
        ...(scoped ? { studio: { kind: scoped.studioKind, sourceJobId: scoped.sourceJobId, taskId: scoped.taskId } } : {}) }
    }
    return { state: snapshot.state, revision: snapshot.revision, deviceJob }
  }
  const jobId = field(body.jobId, 300), token = field(body.leaseToken, 300)
  const snapshot = await store.read(owner), job = snapshot.jobs.find(item => item.id === jobId && item.executionMode === 'device')
  if (!job) throw new SwarmError('This local work was not found.', 404)
  if (body.action === 'device-renew') {
    const stages: Record<string, string> = { planning: 'Planning on this computer.', researching: 'Reading public sources for this device.', writing: 'Writing on this computer.', reviewing: 'Reviewing on this computer.', waiting: 'Waiting for information or a workspace.', done: 'Saving the local result.' }
    if (body.stage !== undefined && !stages[String(body.stage)]) throw new SwarmError('Invalid local work stage.')
    const current = await store.mutateLeased(owner, jobId, token, draft => {
      const active = draft.jobs.find(item => item.id === jobId)!, now = Date.now()
      active.leaseUntil = now + SWARM_LEASE_MS; active.updatedAt = now
      if (body.stage) {
        active.summary = stages[String(body.stage)]
        const task = draft.state.tasks.find(item => item.id === active.taskId && item.executionId === active.id)
        if (task) { task.summary = active.summary; task.updatedAt = now }
      }
    })
    if (!current) throw new SwarmError('This local execution was stopped or changed.', 409)
    return { state: current.state, revision: current.revision }
  }
  if (body.action === 'device-result' && !record(body.result)) throw new SwarmError('Invalid local Swarm result.')
  const resultHash = hash(JSON.stringify(body.action === 'device-fail' ? { failed: true } : body.result)), tokenHash = hash(token)
  if (job.deviceReceipt?.tokenHash === tokenHash && job.deviceReceipt.resultHash === resultHash) return { state: snapshot.state, revision: snapshot.revision }
  const result = body.action === 'device-result' && job.artifact?.type !== 'studio-generation' ? resultFor(job, body.result) : undefined
  const saved = await store.mutateLeased(owner, jobId, token, draft => {
    const active = draft.jobs.find(item => item.id === jobId)!
    if (active.executionMode !== 'device') throw new SwarmError('This work belongs to another execution transport.', 409)
    if (body.action === 'device-fail') {
      active.status = 'failed'; active.summary = active.error = 'This device could not finish the work. Retry when you are ready.'; active.updatedAt = Date.now()
      delete active.leaseToken; delete active.leaseUntil
      const task = draft.state.tasks.find(item => item.id === active.taskId && item.executionId === active.id)
      if (task) { task.status = 'failed'; task.summary = active.summary; task.updatedAt = active.updatedAt; delete task.progress }
      const turn = draft.state.turns.find(item => item.id === active.turnId)
      if (turn) { turn.status = 'failed'; turn.updatedAt = active.updatedAt }
      if (active.kind === 'reply') appendSwarmResult(draft, active, 'I couldn’t finish that reply on this device. Please try again.', active.updatedAt)
    } else if (active.artifact?.type === 'studio-generation') {
      const scope = validateSwarmGenerationScope(draft, owner, { sourceJobId: String(active.artifact.sourceJobId), taskId: active.taskId!, expectedStudioKind: active.artifact.studioKind as never, executionId: active.id, leaseToken: token })
      if (['image', 'video'].includes(scope.studioKind)) throw new SwarmError('Local media completion requires an owned uploaded asset; media inference is not ready yet.')
      if (!record(body.result)) throw new SwarmError('Invalid local Studio result.')
      let artifact
      try { artifact = validateSwarmStudioArtifact(scope.studioKind, body.result.payload) } catch { throw new SwarmError('This local creation is incomplete. Your saved work is unchanged.') }
      if (scope.studioKind === 'website') {
        const previous = artifact.payload.quality
        artifact.payload.quality = { ...(record(previous) ? previous : {}), runtime: { status: 'partial', widths: [], checks: [], limitations: ['Generated on this device; browser interactions still need verification.'] } }
        artifact.status = 'waiting'; artifact.summary = 'Website source saved. Open it in Studio to verify its interactions; runtime completion is not yet verified.'
      }
      persistSwarmStudioArtifact(draft, scope, artifact, Date.now())
    } else finishSwarmJob(draft, jobId, result!, Date.now())
    active.deviceReceipt = { tokenHash, resultHash }
  })
  if (!saved) throw new SwarmError('This local execution was stopped or changed.', 409)
  return { state: saved.state, revision: saved.revision }
}
