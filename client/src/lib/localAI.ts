import { configureLocalAIWorkers } from '@nalu/ai-runtime/runtime'
import { configureAgentMemory } from '@nalu/ai-runtime/memory-runtime'
configureLocalAIWorkers({
  gpu: () => new Worker(new URL('./localAI.worker.ts', import.meta.url), { type: 'module' }),
  cpu: () => new Worker(new URL('./browserCPU.worker.ts', import.meta.url), { type: 'module' }),
})
configureAgentMemory({ accountIdentity: () => localStorage.getItem('nalu-token') ? localStorage.getItem('nalu-data-owner') : null })
export * from '@nalu/ai-runtime/runtime'
