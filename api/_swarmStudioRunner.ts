import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { appendSwarmResult } from './_swarm'
import { executeSwarmStudio, type SwarmStudioArtifact } from './_swarmStudio'
import { swarmStudioHandlers } from './_swarmStudioHandlers'
import { prepareSwarmStudioMedia } from './_swarmStudioMedia'
import type { SwarmGenerationScope, SwarmStudioKind } from './_swarmGeneration'
import type { SwarmJob, SwarmSnapshot, SwarmStore } from './_swarmStore'

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

export async function runSwarmStudioJob(options: {
  store: Pick<SwarmStore, 'read' | 'mutateLeased'>; owner: string; job: SwarmJob
  signal: AbortSignal; timeoutMs: number; onProgress: (message: string) => Promise<void>
}) {
  const marker = options.job.artifact
  if (marker?.type !== 'studio-generation' || typeof marker.sourceJobId !== 'string' || !options.job.taskId || !options.job.leaseToken) {
    throw new Error('A durable Studio continuation is required.')
  }
  let mediaBackend: ConnectionBackend | undefined
  try {
    return await executeSwarmStudio({ store: options.store, ownerId: options.owner,
      request: { sourceJobId: marker.sourceJobId, taskId: options.job.taskId,
        expectedStudioKind: marker.studioKind as SwarmStudioKind, executionId: options.job.id, leaseToken: options.job.leaseToken },
      handlers: swarmStudioHandlers, signal: options.signal, timeoutMs: options.timeoutMs,
      onProgress: options.onProgress, persist: persistSwarmStudioArtifact,
      prepareArtifact: async (scope, artifact, signal) => {
        if (!['image', 'video'].includes(artifact.studioKind)) return artifact
        mediaBackend = connectionBackend(); await mediaBackend.connect()
        return prepareSwarmStudioMedia(mediaBackend.client, scope, artifact, signal)
      },
    })
  } finally { await mediaBackend?.close().catch(() => {}) }
}
