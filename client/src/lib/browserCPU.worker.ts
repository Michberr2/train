/// <reference lib="webworker" />
import { AutoModelForCausalLM, AutoTokenizer, TextStreamer, LogitsProcessor, LogitsProcessorList, env, type PreTrainedModel, type PreTrainedTokenizer } from '@huggingface/transformers'
import { browserCPUModels, browserCPURevisions, type CPUCompletion } from './browserCPU'
import { browserCPUGrammar } from './browserCPUGrammar'
import { downloadBrowserModel } from './browserModelDownload'

// Browser WASM inference, never the Node/native backend or a hosted API.
env.allowLocalModels = false
env.useBrowserCache = true
const download = self.fetch.bind(self)
env.fetch = (input, init) => {
  const url = new URL(String(input))
  const method = String(init?.method || 'GET').toUpperCase()
  if (url.protocol !== 'https:' || !['GET', 'HEAD'].includes(method) || !['huggingface.co', 'cdn.jsdelivr.net'].includes(url.hostname) && !url.hostname.endsWith('.hf.co') && !url.hostname.endsWith('.huggingface.co')) throw new Error('Nalu’s browser worker only downloads model resources. It cannot send a prompt to a hosted service.')
  const headers = new Headers(init?.headers); headers.delete('Authorization'); headers.delete('Cookie')
  return downloadBrowserModel(url.href, { ...init, headers, credentials: 'omit', referrerPolicy: 'no-referrer' }, download)
}
env.backends.onnx.wasm!.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1
let model: PreTrainedModel | undefined, tokenizer: PreTrainedTokenizer | undefined
let busy = false
const send = (message: Record<string, unknown>) => self.postMessage(message)
self.onmessage = async event => {
  const { id, type } = event.data
  if (busy) { send({ id, type: 'error', message: 'Nalu is already using this browser worker.' }); return }
  busy = true
  try {
    if (type === 'load') {
      const modelId = String(event.data.model)
      if (!browserCPUModels.includes(modelId)) throw new Error('Unknown browser model.')
      await model?.dispose(); model = undefined; tokenizer = undefined
      const progress_callback = (value: { progress?: number; status?: string; file?: string }) => {
        if (value.status === 'progress') send({ type: 'progress', progress: Number(value.progress || 0) / 100, text: 'Downloading Nalu’s model files to this browser…' })
      }
      const revision = browserCPURevisions[modelId]
      tokenizer = await AutoTokenizer.from_pretrained(modelId, { revision, progress_callback })
      model = await AutoModelForCausalLM.from_pretrained(modelId, { revision, device: 'wasm', dtype: modelId.includes('Qwen3.5') ? { embed_tokens: 'q4', decoder_model_merged: 'q4', vision_encoder: 'q4' } : 'q4', progress_callback })
      send({ id, type: 'ready' })
    } else if (type === 'generate') {
      if (!model || !tokenizer) throw new Error('Nalu’s browser model is not ready.')
      const request = event.data.request as CPUCompletion
      const template = { tokenize: true as const, return_dict: true as const, add_generation_prompt: true, enable_thinking: request.extra_body?.enable_thinking === true }
      const inputs = tokenizer.apply_chat_template(request.messages, template)
      const config = model.config as unknown as { vocab_size: number; eos_token_id: number | number[] }
      const stopTokens = Array.isArray(config.eos_token_id) ? config.eos_token_id : [config.eos_token_id ?? tokenizer.eos_token_id]
      const grammar = request.response_format?.schema ? await browserCPUGrammar(tokenizer.get_vocab(), config.vocab_size, stopTokens, request.response_format.schema) : undefined
      const processors = new LogitsProcessorList()
      if (grammar) processors.push(new class extends LogitsProcessor { _call(_ids: bigint[][], logits: import('@huggingface/transformers').Tensor) { grammar!.mask(logits.data as Float32Array); return logits } }())
      const forward = model.forward
      if (grammar) model.forward = async (...args: Parameters<typeof forward>) => { await grammar.ready(); return forward.apply(model, args) }
      let tokens = 0
      const streamer = new TextStreamer(tokenizer, { skip_prompt: true, skip_special_tokens: true, token_callback_function: values => { tokens += values.length; grammar?.accept(values) }, callback_function: text => send({ id, type: 'chunk', text }) })
      try { await model.generate({ ...inputs, max_new_tokens: request.max_tokens, do_sample: false, streamer, logits_processor: processors, return_dict_in_generate: false }) }
      finally { model.forward = forward; await grammar?.dispose() }
      send({ id, type: 'done', finishReason: tokens >= request.max_tokens ? 'length' : 'stop' })
    } else throw new Error('Unknown browser worker request.')
  } catch (error) { send({ id, type: 'error', message: error instanceof Error ? error.message : 'Nalu could not run in this browser.' }) }
  finally { busy = false }
}
