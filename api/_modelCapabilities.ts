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
