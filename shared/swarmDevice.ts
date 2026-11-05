import type { SwarmExecutionInput } from './swarmExecution'
import type { StudioKind } from './studioIntent'

// Independent jobs overlap their planning, research and artifact lifecycles.
// The device's model queue separately limits GPU memory to one loaded model.
export const DEVICE_SWARM_PARALLELISM = 4

/** Only the authenticated job's pinned thread context crosses this boundary. */
export interface SwarmDeviceJob extends Pick<SwarmExecutionInput, 'speaker' | 'kind' | 'input' | 'brief' | 'context' | 'personality' | 'allowCustomSpeaker'> {
  executionMode: 'device'
  id: string
  projectId: string
  thread: string
  leaseToken: string
  leaseUntil: number
  studio?: { kind: Exclude<StudioKind, 'chat'>; sourceJobId: string; taskId: string }
}
