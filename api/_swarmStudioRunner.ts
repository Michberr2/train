import { persistSwarmStudioArtifact } from './_swarmCompletion'
import { connectionBackend, type ConnectionBackend } from './_connectionBackend'
import { executeSwarmStudio } from './_swarmStudio'
import { swarmStudioHandlers } from './_swarmStudioHandlers'
import { prepareSwarmStudioMedia } from './_swarmStudioMedia'
import type { SwarmStudioKind } from './_swarmGeneration'
import type { SwarmJob, SwarmStore } from './_swarmStore'

export { persistSwarmStudioArtifact } from './_swarmCompletion'

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
