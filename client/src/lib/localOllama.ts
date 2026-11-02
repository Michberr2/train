import type { LocalProfile, LocalRole } from './localAIProtocol'

// Deliberately not a configurable remote URL. No account token, cookie, proxy,
// cloud endpoint, automatic model pull, or provider fallback belongs here.
export const OLLAMA_ORIGIN = 'http://127.0.0.1:11434'
export const OLLAMA_MODELS: Record<LocalRole, string> = { conversation: 'qwen3.5:2b', writing: 'qwen3.5:4b', code: 'qwen2.5-coder:3b', reasoning: 'qwen3.5:4b' }
// Generic tags may resolve to MLX on Apple Silicon. Its runner can ignore
// num_gpu=0, so CPU-only requests explicitly select a GGUF model instead.
export const OLLAMA_CPU_MODELS: Record<LocalRole, string> = { conversation: 'qwen3.5:2b-q4_K_M', writing: 'qwen3.5:4b-q4_K_M', code: 'qwen2.5-coder:3b', reasoning: 'qwen3.5:4b-q4_K_M' }
export const ollamaModelId = (role: LocalRole, profile: LocalProfile, cpuOnly = false) => profile === 'compact' ? cpuOnly ? 'qwen3.5:0.8b-q8_0' : 'qwen3.5:0.8b' : (cpuOnly ? OLLAMA_CPU_MODELS : OLLAMA_MODELS)[role]
export const ollamaCrewModels = (profile: LocalProfile, cpuOnly = false) => [...new Set(Object.keys(OLLAMA_MODELS).map(role => ollamaModelId(role as LocalRole, profile, cpuOnly)))]
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const local = (value: Record<string, unknown>) => !value.remote_model && !value.remote_host
const MAX_BYTES = 2_000_000

async function connection(path: '/api/status' | '/api/tags' | '/api/show' | '/api/chat', body: unknown, signal: AbortSignal, request: typeof fetch) {
  signal.throwIfAborted()
  let response: Response
  try { response = await request(OLLAMA_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal }) }
  catch { signal.throwIfAborted(); throw new Error('Could not reach Ollama on this computer. Open Ollama, allow this Nalu origin, and approve the browser’s local-network prompt if it appears.') }
  signal.throwIfAborted()
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    if (path === '/api/status' && response.status === 404) throw new Error('Update Ollama so Nalu can verify that cloud inference is disabled. No prompt was sent.')
    throw new Error(`Ollama could not complete the local request (HTTP ${response.status}). Check its setup and installed models.`)
  }
  if (response.redirected || response.url && new URL(response.url).origin !== OLLAMA_ORIGIN) { void response.body?.cancel().catch(() => {}); throw new Error('The local companion redirected away from this computer. No remote response was accepted.') }
  return response
}

async function metadata(path: '/api/status' | '/api/tags' | '/api/show', body: unknown, signal: AbortSignal, request: typeof fetch): Promise<Record<string, unknown>> {
  const response = await connection(path, body, AbortSignal.any([signal, AbortSignal.timeout(8000)]), request)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Ollama returned no local model information.')
  let text = '', bytes = 0
  const decoder = new TextDecoder()
  try {
    while (true) {
      const next = await reader.read(); signal.throwIfAborted()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_BYTES) throw new Error('Ollama returned too much model information.')
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    const value: unknown = JSON.parse(text)
    if (!object(value)) throw new Error('Ollama returned invalid model information.')
    return value
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function verifyModels(models: string[], signal: AbortSignal, request: typeof fetch, cpuOnly = false) {
  const status = await metadata('/api/status', undefined, signal, request)
  if (!object(status.cloud) || status.cloud.disabled !== true) throw new Error('Turn off Ollama cloud features with OLLAMA_NO_CLOUD=1, restart Ollama, then reconnect. No prompt was sent.')
  const catalogue = await metadata('/api/tags', undefined, signal, request)
  if (!Array.isArray(catalogue.models)) throw new Error('Ollama returned an invalid installed-model list.')
  for (const model of models) {
    const installed = catalogue.models.find(item => object(item) && item.name === model)
    if (!object(installed)) throw new Error(`Install ${model} in Ollama, then reconnect. Nalu will not download it or choose a cloud model automatically.`)
    if (!local(installed) || typeof installed.size !== 'number' || installed.size <= 0 || typeof installed.digest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(installed.digest)) throw new Error(`${model} is not a verified model installed on this computer. No prompt was sent.`)
  }
  for (const model of models) {
    const details = await metadata('/api/show', { model }, signal, request)
    const format = object(details.details) && (details.details.format === 'gguf' || details.details.format === 'safetensors' && details.details.runner === 'mlx')
    if (!local(details) || !format || !Array.isArray(details.capabilities) || !details.capabilities.includes('completion')) throw new Error(`${model} cannot be verified as a local text model. No prompt was sent.`)
    if (cpuOnly && object(details.details) && (details.details.format !== 'gguf' || details.details.runner === 'mlx')) throw new Error(`${model} uses a runner that cannot guarantee CPU-only mode. Install the CPU model shown in setup, then reconnect. No prompt was sent.`)
  }
}

export async function checkOllamaCrew(profile: LocalProfile, signal = new AbortController().signal, request: typeof fetch = fetch, cpuOnly = false) {
  const models = ollamaCrewModels(profile, cpuOnly)
  await verifyModels(models, signal, request, cpuOnly)
  return { models, cloudDisabled: true as const }
}

export interface OllamaChatOptions { model: string; messages: { role: string; content: string }[]; maxTokens: number; temperature: number; schema?: Record<string, unknown>; deliberate: boolean; cpuOnly?: boolean }
export interface LocalModelChunk { choices: { delta: { content?: string | null }; finish_reason?: string | null }[] }

/** The existing Nalu SSE layer owns session fences, queueing, schema/tool
 * validation and deadlines. This adapter owns only verified loopback inference. */
export async function* streamOllamaChat(options: OllamaChatOptions, signal: AbortSignal, request: typeof fetch = fetch): AsyncGenerator<LocalModelChunk> {
  if (![...Object.values(OLLAMA_MODELS), ...Object.values(OLLAMA_CPU_MODELS), 'qwen3.5:0.8b', 'qwen3.5:0.8b-q8_0'].includes(options.model)) throw new Error('Choose one of Nalu’s local companion models.')
  await verifyModels([options.model], signal, request, options.cpuOnly)
  const response = await connection('/api/chat', { model: options.model, messages: options.messages, stream: true, keep_alive: 0,
    ...(options.schema ? { format: options.schema } : {}), ...(options.model.startsWith('qwen3.5:') ? { think: options.deliberate } : {}),
    options: { num_ctx: 8192, num_predict: options.maxTokens, temperature: options.temperature, ...(options.cpuOnly ? { num_gpu: 0 } : {}) },
  }, signal, request)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Ollama returned no answer stream.')
  const decoder = new TextDecoder()
  let pending = '', bytes = 0, done = false
  const parse = (line: string): LocalModelChunk => {
    const value: unknown = JSON.parse(line)
    if (!object(value) || !local(value) || value.model !== options.model) throw new Error('Ollama returned an unexpected or remote model response.')
    if (value.error || !object(value.message) || value.message.role !== 'assistant' || typeof value.message.content !== 'string' || typeof value.done !== 'boolean') throw new Error('The local companion returned an incomplete answer. Please retry.')
    if (value.message.tool_calls !== undefined && (!Array.isArray(value.message.tool_calls) || value.message.tool_calls.length)) throw new Error('The local companion returned an unexpected action. No action was run.')
    if (value.done) {
      if (value.done_reason !== undefined && !['stop', 'length'].includes(String(value.done_reason))) throw new Error('The local companion did not complete its answer.')
      done = true
    }
    // Ollama keeps private thinking in a separate field. Never publish it.
    return { choices: [{ delta: { content: value.message.content }, ...(value.done ? { finish_reason: value.done_reason === 'length' ? 'length' : 'stop' } : {}) }] }
  }
  try {
    while (!done) {
      const next = await reader.read(); signal.throwIfAborted()
      if (next.done) {
        pending += decoder.decode()
        if (pending.trim()) yield parse(pending)
        if (!done) throw new Error('The local companion disconnected before finishing. Your request is saved; retry it.')
        break
      }
      bytes += next.value.byteLength
      if (bytes > 8_000_000) throw new Error('The local companion’s answer exceeded its supported size.')
      pending += decoder.decode(next.value, { stream: true })
      if (pending.length > MAX_BYTES) throw new Error('The local companion returned an oversized stream record.')
      let newline
      while (!done && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1)
        if (line) yield parse(line)
      }
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}
