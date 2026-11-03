import type { LocalProfile, LocalRole } from './localAIProtocol'
import type { LocalModelChunk } from './localOllama'

const models: Record<LocalRole, string> = {
  conversation: 'onnx-community/Qwen3-1.7B-ONNX',
  writing: 'HuggingFaceTB/SmolLM3-3B-ONNX',
  reasoning: 'HuggingFaceTB/SmolLM3-3B-ONNX',
  code: 'onnx-community/Qwen2.5-Coder-3B-Instruct',
}
export const browserCPUModel = (role: LocalRole, profile: LocalProfile) => profile !== 'balanced' ? 'onnx-community/Qwen3-0.6B-ONNX' : models[role]
export const browserCPUModels = [...new Set([...Object.values(models), browserCPUModel('conversation', 'compact')])]
export const browserCPURevisions: Record<string, string> = {
  'onnx-community/Qwen3-0.6B-ONNX': '58ca03a5e7b354b480b1a82b34bde8dc7b854cc0',
  'onnx-community/Qwen3-1.7B-ONNX': '3231b522c6e703b2f9b3cd8ea27426a1289a02f2',
  'HuggingFaceTB/SmolLM3-3B-ONNX': '583cadea149c60c0a737786f61ace5775e165d99',
  'onnx-community/Qwen2.5-Coder-3B-Instruct': '0e076a9c5291f8c74b3ce1558f21336b18f94739',
}
export interface CPUCompletion {
  messages: { role: string; content: string }[]
  max_tokens: number
  temperature: number
  response_format?: { type: string; schema?: string }
  extra_body?: { enable_thinking: boolean }
}
type Stream = { chunks: LocalModelChunk[]; done: boolean; error?: Error; wake?: () => void }

/** Runs inference in a browser worker. Only model files are downloaded; user
 * messages travel to this worker, never an HTTP generation endpoint. */
export class BrowserCPUEngine {
  readonly chat = { completions: { create: async (request: CPUCompletion) => this.generate(request) } }
  private serial = 0
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  private streams = new Map<number, Stream>()
  private closed = false
  constructor(readonly worker: Worker, progress: (value: { progress: number; text: string }) => void) {
    worker.addEventListener('message', event => {
      if (this.closed) return
      const value = event.data
      if (value.type === 'progress') { progress({ progress: Math.max(0, Math.min(1, Number(value.progress) || 0)), text: String(value.text || 'Preparing Nalu on this computer…') }); return }
      const pending = this.pending.get(value.id), stream = this.streams.get(value.id)
      if (value.type === 'ready') { this.pending.delete(value.id); pending?.resolve() }
      if (value.type === 'error') {
        const error = new Error(String(value.message || 'Nalu could not finish on this computer.'))
        this.pending.delete(value.id); pending?.reject(error)
        if (stream) { stream.error = error; stream.done = true; stream.wake?.() }
      }
      if (stream && value.type === 'chunk') { stream.chunks.push({ choices: [{ delta: { content: String(value.text) } }] }); stream.wake?.() }
      if (stream && value.type === 'done') { stream.chunks.push({ choices: [{ delta: {}, finish_reason: value.finishReason === 'length' ? 'length' : 'stop' }] }); stream.done = true; stream.wake?.() }
    })
    worker.addEventListener('error', () => this.fail(new Error('The browser could not run Nalu with its available memory. Try a smaller crew in AI settings.')))
  }
  reload(model: string) {
    if (!browserCPUModels.includes(model)) return Promise.reject(new Error('Unknown browser model.'))
    const id = ++this.serial
    return new Promise<void>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ type: 'load', id, model }) })
  }
  private async *generate(request: CPUCompletion): AsyncGenerator<LocalModelChunk> {
    if (this.closed) throw new Error('Nalu’s browser worker has stopped.')
    const id = ++this.serial, stream: Stream = { chunks: [], done: false }
    this.streams.set(id, stream); this.worker.postMessage({ type: 'generate', id, request })
    try {
      while (true) {
        if (stream.error) throw stream.error
        while (stream.chunks.length) yield stream.chunks.shift()!
        if (stream.done) break
        await new Promise<void>(resolve => { stream.wake = resolve })
      }
    } finally { this.streams.delete(id) }
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const stream of this.streams.values()) { stream.error = error; stream.done = true; stream.wake?.() }
  }
  async resetChat() { /* Every generation starts with new inputs and KV state. */ }
  interruptGenerate() { this.fail(new DOMException('Cancelled', 'AbortError')) }
  async unload() { this.closed = true; this.interruptGenerate(); this.worker.terminate() }
}
