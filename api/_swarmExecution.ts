import { chatComplete } from './_llm'
import { research } from './_webResearch'
import { executeSwarmWork as execute, type SwarmExecutionInput } from '../shared/swarmExecution'
export * from '../shared/swarmExecution'

/** Server callers retain their existing provider transport. */
export function executeSwarmWork(options: SwarmExecutionInput) {
  return execute(options, { complete: chatComplete, research })
}
