import type { SwarmExecutionInput } from './swarmExecution'
import type { StudioKind } from './studioIntent'

/** Only the authenticated job's pinned thread context crosses this boundary. */
export interface SwarmDeviceJob extends Pick<SwarmExecutionInput, 'speaker' | 'kind' | 'input' | 'brief' | 'context'> {
  executionMode: 'device'
  id: string
  projectId: string
  thread: string
  leaseToken: string
  leaseUntil: number
  studio?: { kind: Exclude<StudioKind, 'chat'>; sourceJobId: string; taskId: string }
}
