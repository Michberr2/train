// Bundled, embeddable fonts and their licenses are in /fonts. Files are loaded
// only for the families used by a deck; exports never fetch third-party fonts.
export const SLIDE_FONT_FACE = 'Liberation Sans'
export type SlideFontStyle = 'normal' | 'bold' | 'italic' | 'bolditalic'
export type SlideFontCategory = 'sans' | 'serif' | 'mono'
type FontFiles = Record<SlideFontStyle, string>
type CatalogFont = { category: SlideFontCategory; files: FontFiles }
const files = (prefix: string): FontFiles => ({ normal: `${prefix}-Regular.ttf`, bold: `${prefix}-Bold.ttf`, italic: `${prefix}-Italic.ttf`, bolditalic: `${prefix}-BoldItalic.ttf` })
export const SLIDE_FONT_CATALOG: Readonly<Record<string, CatalogFont>> = {
  'Liberation Sans': { category: 'sans', files: files('LiberationSans') },
  'Liberation Serif': { category: 'serif', files: files('LiberationSerif') },
  'Liberation Mono': { category: 'mono', files: files('LiberationMono') },
  Inter: { category: 'sans', files: files('Inter') },
  Poppins: { category: 'sans', files: files('Poppins') },
  'Source Serif 4': { category: 'serif', files: { normal: 'SourceSerif4-Regular.ttf', bold: 'SourceSerif4-Bold.ttf', italic: 'SourceSerif4-It.ttf', bolditalic: 'SourceSerif4-BoldIt.ttf' } },
  'JetBrains Mono': { category: 'mono', files: files('JetBrainsMono') },
}
export type SlideFontResolution = { requested: string; effective: string; pdfFamily: string; exact: boolean; category: SlideFontCategory; reason?: 'metric' | 'stack' | 'category' }
const STYLES: SlideFontStyle[] = ['normal', 'bold', 'italic', 'bolditalic']
export const slideFontStyle = (bold?: boolean, italic?: boolean): SlideFontStyle => bold ? italic ? 'bolditalic' : 'bold' : italic ? 'italic' : 'normal'

export function slideFontFamilies(value?: string): string[] {
  const names = (String(value || '').match(/"[^"]*"|'[^']*'|[^,]+/g) || []).map(face => face.trim().replace(/^['"]|['"]$/g, '').trim()).filter(Boolean)
  return names.length ? names : [SLIDE_FONT_FACE]
}
export const primarySlideFontFace = (value?: string): string => slideFontFamilies(value)[0]
const catalogName = (face: string) => Object.keys(SLIDE_FONT_CATALOG).find(name => name.toLowerCase() === face.toLowerCase())
const metricAliases: Record<string, string> = { arial: 'Liberation Sans', helvetica: 'Liberation Sans', 'helvetica neue': 'Liberation Sans', 'times new roman': 'Liberation Serif', times: 'Liberation Serif', 'courier new': 'Liberation Mono', courier: 'Liberation Mono' }
function categoryFor(families: string[]): SlideFontCategory {
  const first = families[0].toLowerCase(), known = catalogName(families[0])
  if (known) return SLIDE_FONT_CATALOG[known].category
  if (/mono|courier|consolas|menlo|monaco|source code/.test(first)) return 'mono'
  if (/serif|georgia|times|garamond|fraunces|playfair|lora|merriweather|baskerville|charter|palatino|cambria|didot|bodoni/.test(first) && !/sans/.test(first)) return 'serif'
  if (families.some(face => /^(ui-)?monospace$/i.test(face))) return 'mono'
  if (families.some(face => /^(ui-)?serif$/i.test(face))) return 'serif'
  return 'sans'
}
export function resolveSlideFont(value?: string): SlideFontResolution {
  const families = slideFontFamilies(value), requested = families[0], exact = catalogName(requested)
  if (exact) return { requested, effective: exact, pdfFamily: exact, exact: true, category: SLIDE_FONT_CATALOG[exact].category }
  const metric = metricAliases[requested.toLowerCase()]
  if (metric) return { requested, effective: metric, pdfFamily: metric, exact: false, category: SLIDE_FONT_CATALOG[metric].category, reason: 'metric' }
  const category = categoryFor(families)
  const stack = families.slice(1).map(catalogName).find(name => name && SLIDE_FONT_CATALOG[name].category === category)
  const effective = stack || (category === 'mono' ? 'Liberation Mono' : category === 'serif' ? 'Liberation Serif' : SLIDE_FONT_FACE)
  return { requested, effective, pdfFamily: effective, exact: false, category, reason: stack ? 'stack' : 'category' }
}
export function readableFontFallbacks(faces: string[]): string[] {
  return [...new Set(faces.map(resolveSlideFont).filter(face => !face.exact).map(face => `${face.requested} → ${face.effective}`))]
}
export const slideFontSubstitutions = readableFontFallbacks
/** Preview and measurement use the exact family embedded in PDF on every
 * device. The scene separately retains the requested primary face for PPTX;
 * callers disclose substitutions with readableFontFallbacks. */
export function slideFontCss(value?: string): string {
  const resolution = resolveSlideFont(value)
  const families = [...new Set([resolution.effective, ...slideFontFamilies(value)])]
  const generic = resolution.category === 'serif' ? 'serif' : resolution.category === 'mono' ? 'monospace' : 'sans-serif'
  return [...families.filter(face => !/^(sans-serif|serif|monospace|system-ui|ui-serif|ui-sans-serif|ui-monospace|-apple-system)$/i.test(face)).map(face => `"${face.replace(/["\\;{}<>]/g, '')}"`), generic].join(', ')
}

const fontBytes = new Map<string, Promise<Uint8Array>>()
export function loadSlideFont(style: SlideFontStyle): Promise<Uint8Array>
export function loadSlideFont(face: string, style: SlideFontStyle): Promise<Uint8Array>
export function loadSlideFont(faceOrStyle: string, requestedStyle?: SlideFontStyle): Promise<Uint8Array> {
  const family = resolveSlideFont(requestedStyle ? faceOrStyle : SLIDE_FONT_FACE).effective
  const style = requestedStyle || faceOrStyle as SlideFontStyle
  const filename = SLIDE_FONT_CATALOG[family].files[style]
  const cached = fontBytes.get(filename)
  if (cached) return cached
  const request = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`/fonts/${filename}`, { signal: controller.signal })
      if (!response.ok) throw new Error('Font unavailable')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length < 1000 || new DataView(bytes.buffer).getUint32(0) !== 0x00010000) throw new Error('Invalid font')
      return bytes
    } catch {
      fontBytes.delete(filename)
      throw new Error(`The ${family} presentation font could not load. Please try again.`)
    } finally { clearTimeout(timer) }
  })()
  fontBytes.set(filename, request)
  return request
}

const browserFonts = new Map<string, Promise<void>>()
/** Call before measuring or rendering scenes. Concurrent decks share requests;
 * a later deck can add families, and failed loads remain retryable. */
export async function ensureSlideFonts(faces: string[] = [SLIDE_FONT_FACE]): Promise<SlideFontResolution[]> {
  const resolutions = faces.map(resolveSlideFont)
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return resolutions
  await Promise.all([...new Set(resolutions.map(face => face.effective))].flatMap(family => STYLES.map(style => {
    const key = `${family}/${style}`
    let pending = browserFonts.get(key)
    if (!pending) {
      pending = (async () => {
        const bytes = await loadSlideFont(family, style)
        const face = new FontFace(family, bytes.slice().buffer, { weight: style.includes('bold') ? '700' : '400', style: style.includes('italic') ? 'italic' : 'normal' })
        await face.load()
        document.fonts.add(face)
      })().catch(error => { browserFonts.delete(key); throw error })
      browserFonts.set(key, pending)
    }
    return pending
  })))
  return resolutions
}
