import { appendSwarmResult } from './_swarm'
import type { SwarmSnapshot } from './_swarmStore'
import type { SwarmExecutionResult } from '../shared/swarmExecution'
import type { SwarmGenerationScope } from './_swarmGeneration'
import type { SwarmStudioArtifact } from './_swarmStudioArtifact'

export function finishSwarmJob(snapshot: SwarmSnapshot, id: string, result: SwarmExecutionResult, now: number) {
  const job = snapshot.jobs.find(item => item.id === id)
  if (!job) throw new Error('Swarm work no longer exists.')
  job.status = result.status; job.result = result.content; job.summary = result.summary; job.updatedAt = now
  job.artifact = result.artifact; job.progress = result.status === 'done' ? 1 : undefined
  delete job.leaseToken; delete job.leaseUntil
  const turn = snapshot.state.turns.find(item => item.id === job.turnId)
  if (turn) { turn.status = 'completed'; turn.updatedAt = now }
  const task = snapshot.state.tasks.find(item => item.id === job.taskId && item.executionId === job.id)
  if (task) {
    task.status = result.status; task.summary = result.summary; task.updatedAt = now; task.progress = job.progress
    if (result.artifact?.type === 'needs-workspace') task.handoff = { studioKind: result.artifact.studioKind, prompt: result.artifact.prompt, reason: result.artifact.reason }
    else delete task.handoff
  }
  appendSwarmResult(snapshot, job, result.content, now)
}


export function persistSwarmStudioArtifact(snapshot: SwarmSnapshot, scope: SwarmGenerationScope, artifact: SwarmStudioArtifact, now: number): void {
  const job = snapshot.jobs.find(item => item.id === scope.lease?.jobId)
  const task = snapshot.state.tasks.find(item => item.id === scope.taskId && item.executionId === job?.id)
  if (!job || !task) throw new Error('This Studio work changed before it could be saved.')
  if (Buffer.byteLength(JSON.stringify(artifact)) > 600_000) throw new Error('This creation exceeds the saved-work limit. Split it into smaller creations.')
  job.artifact = { ...artifact, sourceJobId: scope.sourceJobId, revision: 1 }
  job.status = artifact.status; job.result = artifact.summary; job.summary = artifact.summary; job.updatedAt = now
  job.progress = artifact.status === 'done' ? 1 : undefined
  delete job.leaseToken; delete job.leaseUntil
  task.artifact = { executionId: job.id, studioKind: scope.studioKind, revision: 1 }
  task.status = artifact.status; task.summary = artifact.summary; task.updatedAt = now; task.progress = job.progress
  delete task.handoff
  appendSwarmResult(snapshot, job, artifact.summary, now)
}

