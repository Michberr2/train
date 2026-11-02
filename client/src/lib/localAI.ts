import type { MLCEngineInterface } from '@mlc-ai/web-llm'
import { LOCAL_CREW, LocalTextFilter, localModelId, parseLocalActions, prepareLocalMessages, routeLocalTask, type LocalProfile, type LocalRequest, type LocalRole } from './localAIProtocol'

// Device preferences must never follow the account onto a different computer.
const KEY = 'device-local-ai-v1'
export interface LocalPreferences { enabled: boolean; profile: LocalProfile }
export function getLocalPreferences(): LocalPreferences {
  try { const value = JSON.parse(localStorage.getItem(KEY) || '{}'); return { enabled: value.enabled === true, profile: value.profile === 'compact' ? 'compact' : 'balanced' } }
  catch { return { enabled: false, profile: 'balanced' } }
}
export function setLocalPreferences(value: LocalPreferences) {
  localStorage.setItem(KEY, JSON.stringify(value))
  window.dispatchEvent(new Event('nalu-local-ai'))
}
export interface LocalAIState { phase: 'idle' | 'checking' | 'loading' | 'ready' | 'generating' | 'error'; progress: number; message: string; model?: string; role?: LocalRole }
let state: LocalAIState = { phase: 'idle', progress: 0, message: 'AI runs on this computer' }
export function getLocalAIState() { return state }
function report(patch: Partial<LocalAIState>) { state = { ...state, ...patch }; window.dispatchEvent(new Event('nalu-local-ai')) }

let engine: MLCEngineInterface | undefined, worker: Worker | undefined, loadedModel = '', modelGeneration = 0
let epoch = 0, queue: Promise<unknown> = Promise.resolve(), lifetime = new AbortController()
let activeRequest: AbortController | undefined
function abortError() { return new DOMException('Cancelled', 'AbortError') }
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? new Error('The local model took too long to respond. Your previous work is preserved. Try a shorter request or the compact crew.') : abortError()) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
function discardLocalModel() {
  modelGeneration++
  engine?.interruptGenerate(); worker?.terminate()
  engine = undefined; worker = undefined; loadedModel = ''
  report({ phase: 'idle', progress: 0, model: undefined, role: undefined, message: 'AI runs on this computer' })
}
export function resetLocalAI() {
  epoch++; lifetime.abort(); lifetime = new AbortController()
  discardLocalModel()
  // Terminating a worker can leave its pending RPC unresolved. A new session
  // gets a fresh queue; the old epoch can never emit or execute an action.
  queue = Promise.resolve()
}
export async function checkLocalDevice(): Promise<{ halfPrecision: boolean; maxBuffer: number }> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string>; limits: { maxStorageBufferBindingSize: number } } | null> } }).gpu
  if (!window.isSecureContext || !gpu) throw new Error('On-device AI needs a browser with WebGPU. Try an up-to-date Chrome or Edge on a supported computer. No cloud request was made.')
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('Nalu could not access this computer’s GPU. Check browser hardware acceleration. No cloud request was made.')
  return { halfPrecision: adapter.features.has('shader-f16'), maxBuffer: adapter.limits.maxStorageBufferBindingSize }
}
async function loadModel(role: LocalRole, signal?: AbortSignal) {
  const currentEpoch = epoch
  const taskSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(600000), ...(signal ? [signal] : [])])
  report({ phase: 'checking', role, message: 'Checking this computer…', progress: 0 })
  const device = await cancellable(checkLocalDevice(), taskSignal)
  if (signal?.aborted || epoch !== currentEpoch) throw abortError()
  const model = localModelId(role, getLocalPreferences().profile, device.halfPrecision)
  if (loadedModel === model && engine) { report({ phase: 'ready', progress: 1, message: `${LOCAL_CREW[role].name} is ready on this computer` }); return engine }
  report({ phase: 'loading', role, model, progress: 0, message: `Preparing ${LOCAL_CREW[role].name}…` })
  const webllm = await import('@mlc-ai/web-llm')
  if (signal?.aborted || epoch !== currentEpoch) throw abortError()
  const record = webllm.prebuiltAppConfig.model_list.find(item => item.model_id === model)
  if (!record || (record.buffer_size_required_bytes || 0) > device.maxBuffer) throw new Error('This model exceeds the browser’s GPU limits. Choose the compact crew in Settings → On-device AI.')
  if (engine) await cancellable(engine.unload(), taskSignal)
  if (signal?.aborted || epoch !== currentEpoch) throw abortError()
  if (!worker) worker = new Worker(new URL('./localAI.worker.ts', import.meta.url), { type: 'module' })
  const generation = ++modelGeneration
  engine = new webllm.WebWorkerMLCEngine(worker, { initProgressCallback: progress => {
    if (epoch === currentEpoch && generation === modelGeneration) report({ phase: 'loading', progress: Math.max(0, Math.min(1, progress.progress)), message: progress.text })
  } })
  const loadingEngine = engine
  await cancellable(loadingEngine.reload(model, { context_window_size: 8192, ...(model.startsWith('Qwen3.5-') ? { conv_config: { ...record.overrides?.conv_config, role_empty_sep: '\n<think>\n' } } : {}) }), taskSignal)
  if (signal?.aborted || epoch !== currentEpoch) throw abortError()
  loadedModel = model
  report({ phase: 'ready', progress: 1, message: `${LOCAL_CREW[role].name} is ready on this computer` })
  return loadingEngine
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work); queue = result.catch(() => {})
  return result
}
export function prepareLocalCrew(signal?: AbortSignal) {
  const currentEpoch = epoch
  return serial(async () => {
    if (currentEpoch !== epoch || signal?.aborted) throw abortError()
    try { await loadModel('conversation', signal) }
    catch (error) { if (currentEpoch === epoch && !signal?.aborted) { resetLocalAI(); report({ phase: 'error', message: error instanceof Error ? error.message : 'Could not prepare the local model.' }) }; throw error }
  })
}

/** Adapt real local inference to the existing Nalu SSE contract. No fetch fallback. */
export function requestLocalChat(request: LocalRequest, signal?: AbortSignal): Response {
  if (request.webSearch === false && request.tools?.length) request = { ...request, tools: request.tools.filter(tool => !['web_search', 'fetch_url', 'deep_research'].includes(tool.function.name)) }
  if (!getLocalPreferences().enabled) {
    window.dispatchEvent(new Event('nalu-local-ai-setup'))
    throw new Error('Set up your on-device AI crew to start chatting. Open Settings → On-device AI. No cloud request was made.')
  }
  const owner = localStorage.getItem('nalu-token'), currentEpoch = epoch
  const sessionSignal = lifetime.signal
  const encoder = new TextEncoder()
  const controller = new AbortController()
  let closed = false
  const abort = () => { controller.abort(); if (currentEpoch === epoch && activeRequest === controller) discardLocalModel() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      const current = () => !closed && !controller.signal.aborted && epoch === currentEpoch && owner === localStorage.getItem('nalu-token')
      const emit = (event: string, data: unknown) => { if (current()) stream.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) }
      void serial(async () => {
        try {
          if (!current()) throw abortError()
          activeRequest = controller
          const taskSignal = AbortSignal.any([sessionSignal, controller.signal])
          const messages = prepareLocalMessages(request)
          // Refuse oversized contexts rather than silently discarding user work.
          if (JSON.stringify(messages).length > 24000) throw new Error('This conversation or tool context is too large for the local crew. Start a new chat or use a shorter excerpt; nothing was sent to a cloud model.')
          const role = request.localRole || routeLocalTask(request)
          emit('route', { name: `${LOCAL_CREW[role].name} · on this device`, kind: 'local', autoResearch: false })
          const model = await loadModel(role, controller.signal)
          if (!current()) throw abortError()
          // Clear KV state between requests, accounts, chats, and pipeline steps.
          await cancellable(model.resetChat(), taskSignal)
          if (!current()) throw abortError()
          const generationSignal = AbortSignal.any([taskSignal, AbortSignal.timeout(180000)])
          report({ phase: 'generating', role, message: `${LOCAL_CREW[role].name} is thinking on this computer` })
          const hasTools = !!request.tools?.length
          const jsonSchema = hasTools ? { type: 'object', properties: { message: { type: 'string' }, actions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: request.tools!.map(tool => tool.function.name) }, arguments: { type: 'object' } }, required: ['name', 'arguments'] } } }, required: ['message', 'actions'] } : request.jsonSchema
          // WebLLM applies JSON grammar to every generated token, including
          // thinking tags. Internal reviews instead deliberate unconstrained;
          // their final JSON is still validated by the artifact adapter.
          const deliberate = !hasTools && (request.deliberate === true || !jsonSchema && role === 'reasoning')
          const chunks = await cancellable(model.chat.completions.create({
            messages, stream: true, max_tokens: Math.max(128, Math.min(4096, request.maxTokens || 2048)), temperature: deliberate ? .6 : .4,
            ...(jsonSchema && !deliberate ? { response_format: { type: 'json_object' as const, schema: JSON.stringify(jsonSchema) } } : {}),
            ...(loadedModel.startsWith('Qwen3.5-') ? { extra_body: { enable_thinking: deliberate } } : {}),
          }), generationSignal)
          let output = '', finishReason = ''
          const textFilter = new LocalTextFilter(deliberate && loadedModel.startsWith('Qwen3.5-'))
          const iterator = chunks[Symbol.asyncIterator]()
          while (true) {
            const next = await cancellable(iterator.next(), generationSignal)
            if (next.done) break
            const chunk = next.value
            if (!current()) { model.interruptGenerate(); throw abortError() }
            const choice = chunk.choices[0]
            const text = textFilter.push(choice?.delta.content || '')
            output += text
            if (!hasTools && text) emit('delta', { text })
            if (choice?.finish_reason) finishReason = choice.finish_reason
          }
          const tail = textFilter.push('', true)
          output += tail
          if (!hasTools && tail) emit('delta', { text: tail })
          if (!current()) throw abortError()
          if (hasTools) {
            if (finishReason === 'length') throw new Error('The local model ran out of room before completing its action. No action was run. Try a smaller request.')
            const result = parseLocalActions(output, request.tools!)
            if (result.message) emit('delta', { text: result.message })
            result.calls.forEach(call => emit('tool_call_delta', call))
            finishReason = result.calls.length ? 'tool_calls' : 'stop'
          }
          emit('finish', { reason: finishReason || 'stop' }); emit('done', { ok: true })
          report({ phase: 'ready', message: `${LOCAL_CREW[role].name} is ready on this computer` })
        } catch (error) {
          if (current()) {
            const message = error instanceof Error ? error.message : 'The local model could not finish. Try the compact crew.'
            emit('error', { message }); emit('done', { ok: false, message })
            discardLocalModel(); report({ phase: 'error', message })
          }
        } finally {
          if (activeRequest === controller) activeRequest = undefined
          signal?.removeEventListener('abort', abort)
          if (!closed) { closed = true; stream.close() }
        }
      })
    },
    cancel() { if (!closed) { closed = true; signal?.removeEventListener('abort', abort); abort() } },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

if (import.meta.hot) import.meta.hot.dispose(resetLocalAI)
