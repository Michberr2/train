import { GrammarCompiler, GrammarMatcher, TokenizerInfo } from '@mlc-ai/web-xgrammar'

/** The same JSON grammar as the GPU engine, applied to WASM's token scores.
 * A new matcher belongs to one response, never a chat or account cache. */
export async function browserCPUGrammar(vocabulary: Map<string, number>, size: number, stopTokens: number[], schema: string) {
  const tokens = Array.from({ length: size }, () => '')
  for (const [token, id] of vocabulary) if (id >= 0 && id < size) tokens[id] = token
  const tokenizer = await TokenizerInfo.createTokenizerInfo(tokens, 'byte_level', false, size, stopTokens)
  let compiler: GrammarCompiler | undefined, compiled: Awaited<ReturnType<GrammarCompiler['compileJSONSchema']>> | undefined, matcher: GrammarMatcher | undefined
  try {
    compiler = await GrammarCompiler.createGrammarCompiler(tokenizer)
    compiled = await compiler.compileJSONSchema(schema, true, undefined, undefined, true, 16)
    matcher = await GrammarMatcher.createGrammarMatcher(compiled)
    const current = matcher
    let mask = await current.getNextTokenBitmask(), pending = Promise.resolve()
    return {
      ready: () => pending,
      accept(ids: bigint[]) {
        for (const id of ids) if (!current.acceptToken(Number(id))) throw new Error('The CPU model emitted a token outside its response grammar. No action was run.')
        // Transformers calls the streamer synchronously. The worker explicitly
        // awaits this mask before its next forward pass and before disposal.
        pending = current.isTerminated() ? Promise.resolve() : current.getNextTokenBitmask().then(value => { mask = value })
        pending.catch(() => {})
      },
      mask(logits: Float32Array) {
        if (logits.length !== size) throw new Error('The CPU model vocabulary does not match its response grammar.')
        for (let id = 0; id < size; id++) if (!(mask[id >>> 5] & 1 << (id & 31))) logits[id] = -Infinity
      },
      async dispose() { try { await pending } finally { current.dispose(); compiled!.dispose(); compiler!.dispose(); tokenizer.dispose() } },
    }
  } catch (error) { matcher?.dispose(); compiled?.dispose(); compiler?.dispose(); tokenizer.dispose(); throw error }
}
