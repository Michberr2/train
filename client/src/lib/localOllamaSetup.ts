import type { LocalProfile } from './localAIProtocol'
import { ollamaCrewModels } from './localOllama'

export function ollamaSetup(profile: LocalProfile, platform: 'windows' | 'unix', currentOrigin: string, cpuOnly = false) {
  const origins = ['https://n4lu.ai', 'https://www.n4lu.ai', 'https://n4lu.com', 'https://www.n4lu.com']
  try { const url = new URL(currentOrigin); if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) origins.push(url.origin) } catch { /* Keep only the four known product origins. */ }
  const allowed = origins.join(',')
  const start = platform === 'windows' ? `$env:OLLAMA_NO_CLOUD="1"\n$env:OLLAMA_HOST="127.0.0.1:11434"\n$env:OLLAMA_ORIGINS="${allowed}"\nollama serve` : `OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 OLLAMA_ORIGINS='${allowed}' ollama serve`
  const localHost = platform === 'windows' ? '$env:OLLAMA_HOST="127.0.0.1:11434"; ' : 'OLLAMA_HOST=127.0.0.1:11434 '
  return { start, pull: ollamaCrewModels(profile, cpuOnly).map(model => `${localHost}ollama pull ${model}`).join('\n') }
}
