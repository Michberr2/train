/** Defaults for known multimodal families. Custom serving endpoints can declare
 * capabilities explicitly; an unknown text model is never given a fake image
 * description as a substitute for the original attachment. */
export const VISION_CAPABLE = /\bvl\b|-vl-|vision|gemma-3|gemini|llama-?4|pixtral|internvl|phi-4-multimodal|inkling/i

export function supportsImageInput(provider: { model: string; supportsImages?: boolean }): boolean {
  return provider.supportsImages ?? VISION_CAPABLE.test(provider.model)
}

export function configuredImageSupport(value: string | undefined): boolean | undefined {
  return value === '1' || value === 'true' ? true : value === '0' || value === 'false' ? false : undefined
}

export type ProtocolOutputMode = 'none' | 'json_object' | 'json_schema'
/** Endpoint compatibility does not imply structured generation support. Unknown
 * hosts (including Tinker's documented chat API and hosted model routers) use
 * prompt + application validation until the deployment explicitly opts in.
 * Gemini documents JSON schemas on its OpenAI-compatible chat endpoint:
 * https://ai.google.dev/gemini-api/docs/openai#structured-output
 */
export function protocolOutputMode(provider: { base: string; model: string }, configured?: string): ProtocolOutputMode {
  if (configured === 'none' || configured === 'json_object' || configured === 'json_schema') return configured
  if (configured) return 'none'
  try {
    const url = new URL(provider.base)
    if (url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com' && /^\/v1(?:beta)?\/openai\/?$/.test(url.pathname)
      && /^gemini-(?:2\.5|3(?:\.|-))/.test(provider.model) && !/image|audio|live|tts/.test(provider.model)) return 'json_schema'
  } catch { /* unrecognized endpoint: do not guess its supported parameters */ }
  return 'none'
}
