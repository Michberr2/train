import { motionBrandHint } from './_motionGeneration'

/** Scene v1 has no asset layer. Select the existing embedded-asset HTML path
 * only when this request actually refers to an asset, not just a saved kit. */
export function motionAssetRoute(prompt: string, rawBrand: unknown): { html: boolean; hint: string; error?: string } {
  const brand = rawBrand && typeof rawBrand === 'object' ? rawBrand as Record<string, unknown> : {}
  const logoNoun = '(?:logo\\s*marks?|brand\\s*marks?|logos?)'
  const imageNoun = '(?:images?|photos?|photographs?|pictures?|svgs?|icons?|assets?)'
  const noun = `(?:${logoNoun}|${imageNoun})`
  const ignored = new RegExp(`\\b(?:no|without|omit|exclude|ignore|(?:do not|don't)\\s+(?:use|include|show|animate))\\s+(?:(?:any|an?|the|my|our|saved|supplied|attached|uploaded|existing)\\s+){0,3}${noun}\\b(?:\\s+(?:from|in)\\s+(?:my|our|the)\\s+brand\\s+kit)?`, 'gi')
  const intent = prompt.replace(ignored, '')
  const original = new RegExp(`\\b(?:create|design|invent|generate|make)\\b[^.;\\n]{0,60}\\b(?:original|new|custom)\\s+${noun}\\b`, 'i').test(intent)
  const requested = (type: string) => new RegExp(`\\b(?:my|our|saved|supplied|attached|uploaded|provided|existing|this|that${original ? '' : '|the'})\\s+(?:brand\\s+)?${type}\\b|\\b${type}\\s+(?:I|we)\\s+(?:supplied|attached|uploaded|provided)\\b|\\b${type}\\s+(?:from|in)\\s+(?:my|our|the)\\s+brand\\s+kit\\b`, 'i').test(intent)
  const logoReference = requested(logoNoun)
  const imageReference = requested(imageNoun)
  const reference = logoReference || imageReference
  const markRequested = /\b(?:logo\s*mark|brand\s+mark|compact\s+mark)\b/i.test(intent)
  const assets: string[] = []
  let problem = ''
  const accept = (value: string) => {
    let source = value.trim()
    if (/^data:image\/svg\+xml[;,]/i.test(source)) {
      try {
        const comma = source.indexOf(',')
        source = /;base64/i.test(source.slice(0, comma)) ? Buffer.from(source.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(source.slice(comma + 1))
      } catch { problem = 'The supplied SVG could not be read. Include a complete embedded SVG.'; return }
    }
    if (/^<svg\b/i.test(source)) {
      if (source.length > 12000 || !/<\/svg>\s*$/i.test(source)) { problem = 'The supplied SVG is incomplete or too large for this motion format. Use a complete, smaller SVG.'; return }
      assets.push(source); return
    }
    if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source)) {
      if (source.length > 24000) { problem = 'The embedded image is too large for this motion format. Use a smaller image or an SVG.'; return }
      assets.push(source); return
    }
    problem = 'This motion format needs the actual embedded SVG or image data. A link or asset description cannot preserve the supplied artwork.'
  }
  const inlineSvg = [...prompt.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi)].map(match => match[0])
  const outsideSvg = prompt.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '')
  const dataImages = [...outsideSvg.matchAll(/data:image\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=+-]+)*,[^\s"'<>)}]+/gi)].map(match => match[0])
  // The existing HTML format is self-contained. A referenced remote image is
  // not interchangeable with an unrelated saved logo and must not be fetched.
  const assetUrl = /https?:\/\/[^\s<>"']+\.(?:svg|png|jpe?g|webp|gif|avif)(?:[?#][^\s<>"']*)?/i.test(outsideSvg)
    || new RegExp(`\\b${noun}\\s*(?:(?:at|from|url|is)\\s*[:=]?\\s*)?[:=]?\\s*https?:\\/\\/`, 'i').test(outsideSvg)
    || /\b(?:animate|reveal|spin|move|use)\s+(?:(?:this|the|supplied|attached)\s+)?https?:\/\//i.test(outsideSvg)
  if (assetUrl) return { html: false, hint: '', error: 'This motion format cannot use a linked image or SVG. Include the actual embedded SVG or image data so the requested artwork can be preserved.' }
  const sourcePresent = inlineSvg.length > 0 || dataImages.length > 0 || /<svg\b|data:image\//i.test(prompt)
  // Merely naming an original logo or prohibiting stock images is still a
  // geometry/type brief. Do not invent an unavailable saved-asset dependency.
  if (!reference && !sourcePresent) return { html: false, hint: '' }
  if (inlineSvg.length + dataImages.length > 4) return { html: false, hint: '', error: 'Use at most four embedded assets in this motion request.' }
  for (const asset of [...inlineSvg, ...dataImages]) accept(asset)
  if (sourcePresent && !assets.length && !problem) problem = 'The supplied asset is incomplete. Include a complete embedded SVG or image data.'
  if (!sourcePresent) {
    const candidate = !imageReference && logoReference
      ? markRequested && typeof brand.logoMark === 'string' && brand.logoMark ? brand.logoMark : typeof brand.logo === 'string' && brand.logo ? brand.logo : typeof brand.logoMark === 'string' ? brand.logoMark : ''
      : ''
    if (candidate) accept(candidate)
    else problem = 'The artwork requested for this animation is not included. Supply its embedded SVG or image data so it can be preserved.'
  }
  if (problem) return { html: false, hint: '', error: problem }
  const unique = [...new Set(assets)]
  const kit = motionBrandHint({ ...brand, logo: '', logoMark: '' })
  const hint = kit + '\n\nSUPPLIED MOTION ASSETS — preserve this exact artwork and its aspect ratio. Do not replace it with generated text, geometry or a substitute logo. Embed SVG artwork directly; embed image data as the exact img src or SVG image href. Animate its existing groups or surrounding container. These are supplied embedded assets, not external dependencies:\n' + unique.map((asset, index) => `Asset ${index + 1}:\n${asset}`).join('\n\n')
  return { html: true, hint }
}
