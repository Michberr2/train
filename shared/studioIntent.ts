/** One vocabulary for Studio's picker, prompt router, and generation branches. */
export const STUDIO_KINDS = ['chat', 'document', 'book', 'spreadsheet', 'slides', 'cad', 'video', 'image', 'carousel', 'website', 'logo', 'palette', 'brand', 'blueprint', 'poster', 'canvas', 'shopping', 'motion', 'game', 'board', 'email'] as const
export type StudioKind = typeof STUDIO_KINDS[number]
export type StudioIntent = { kind: StudioKind; mode: 'create' | 'edit' | 'chat'; additionalKinds: StudioKind[]; reason?: string; source?: 'model' | 'fallback' | 'selection' }
const ALIASES: Record<string, StudioKind> = { webpage: 'website', web: 'website', deck: 'slides', presentation: 'slides', powerpoint: 'slides', ppt: 'slides', sheet: 'spreadsheet', excel: 'spreadsheet', xls: 'spreadsheet', doc: 'document', word: 'document', img: 'image', draw: 'image', walkthrough: 'blueprint', house: 'blueprint', home: 'blueprint', tour: 'blueprint', animate: 'motion', shop: 'shopping', design: 'website' }
export function studioKind(value: unknown): StudioKind | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return STUDIO_KINDS.includes(key as StudioKind) ? key as StudioKind : Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : null
}

// Signals only decide WHEN to ask the semantic router. Their order never picks
// the output. Keep every match, including features/references the model rejects.
const SIGNALS: [StudioKind, RegExp][] = [
  ['website', /\b(web\s?sites?|web\s?pages?|landing pages?|web apps?|home\s?pages?|html|dashboard|user interface|web design|pricing page|hero section)\b/i],
  ['logo', /\b(logos?|logotypes?|word\s?marks?|monograms?|favicons?|app icons?|brand marks?|emblems?|lockups?)\b/i],
  ['palette', /\b(palettes?|colou?r (?:schemes?|themes?|combinations?)|swatches|hex codes?)\b/i],
  ['brand', /\b(brand(?:ing)? (?:books?|guides?|guidelines?|kits?|identity)|style guides?|visual identity)\b/i],
  ['blueprint', /\b(blue\s?prints?|floor\s?plans?|house plans?|site plans?|building plans?|schematics?|technical drawings?|elevations?|walk[ -]?throughs?|3d (?:house|home|tour)|house tour|home tour)\b/i],
  ['motion', /\b(motion(?: graphics?)?|animated|animation|kinetic typography|logo reveal|title card|lower third|hyperframe|looping background)\b/i],
  ['video', /\b(videos?|clips?|movies?|reels?|films?|cinematic|gifs?)\b/i],
  ['image', /\b(images?|photos?|pictures?|illustrations?|portraits?|paintings?|wallpapers?|headshots?|artwork|drawings?|avatars?)\b/i],
  ['poster', /\b(posters?|flyers?|infographics?|album covers?)\b/i],
  ['carousel', /\b(carousels?|swipe posts?|multi[ -]?slide|instagram (?:post|story)|linkedin post|social (?:media )?post|tiktok slides?|photo dump)\b/i],
  ['canvas', /\b(canvas|figma|editable (?:vector|graphic|design)|vector graphic|social graphic)\b/i],
  ['shopping', /\b(shopping|shop(?:ping)? list|buy|purchase|furnish|furniture|outfit my)\b/i],
  ['document', /\b(documents?|docs?|docx|reports?|proposals?|memos?|essays?|letters?|business plans?|marketing plans?|whitepapers?|white papers?|resumes?|résumés?|contracts?|pdfs?|articles?)\b/i],
  ['book', /\b(books?|novels?|manuscripts?|thes[ie]s|dissertations?|chapters?|long[ -]form|scientific (?:paper|article))\b/i],
  ['slides', /\b(decks?|slides?|presentations?|power\s?points?|pptx?|keynotes?|slideshows?)\b/i],
  ['spreadsheet', /\b(spread\s?sheets?|excel|xlsx?|workbooks?|budgets?|trackers?|tables?|ledgers?|inventory|financial models?|calculators?|schedules?|rosters?|gantt)\b/i],
  ['cad', /\b(cad|autocad|openscad|3d models?|stl|3d[ -]?print\w*|parametric|brackets?|gears?|enclosures?)\b/i],
  ['game', /\b(games?|platformers?|endless runner|playable|arcade|rpg|tower defense|tetris|pong)\b/i],
  ['board', /\b(breakdown board|presentation board|break down this|analyze this photo)\b/i],
  ['email', /\b(e-?mails?|cold outreach)\b/i],
]
export function studioSignals(text: string): StudioKind[] { return SIGNALS.filter(([, re]) => re.test(text)).map(([kind]) => kind) }
export function explicitStudioKind(text: string): StudioKind | null { return studioKind(text.match(/^\s*\/([a-z]+)\b/i)?.[1]) }
export function parseStudioIntent(value: unknown): StudioIntent | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>, kind = studioKind(input.kind)
  if (!kind) return null
  const mode = kind === 'chat' ? 'chat' : input.mode === 'edit' ? 'edit' : 'create'
  const additionalKinds = kind === 'chat' ? [] : [...new Set((Array.isArray(input.additionalKinds) ? input.additionalKinds : []).map(studioKind).filter((k): k is StudioKind => !!k && k !== 'chat' && k !== kind))].slice(0, 3)
  return { kind, mode, additionalKinds, ...(typeof input.reason === 'string' ? { reason: input.reason.slice(0, 200) } : {}) }
}

const BUILD = /\b(make|build|create|design|generate|produce|write|draft|prepare|develop|render|paint|draw|need|want|put together|turn|convert|animate)\b/i
const EDIT = /\b(change|update|edit|revise|fix|add|remove|replace|adjust|tweak|resize|recolou?r|center|align|make it|make this|make the|bigger|smaller|darker|lighter)\b/i
export function shouldClassifyStudio(text: string, recentKind?: unknown): boolean {
  return !explicitStudioKind(text) && (studioSignals(text).length > 0 || BUILD.test(text) || (!!studioKind(recentKind) && EDIT.test(text)))
}

/** An outage must not re-enable a collection of conflicting generation branches. */
export function fallbackStudioIntent(text: string, recentKind?: unknown): StudioIntent {
  const result = (kind: StudioKind, mode: StudioIntent['mode'] = 'create'): StudioIntent => ({ kind, mode: kind === 'chat' ? 'chat' : mode, additionalKinds: [], source: 'fallback' })
  const explicit = explicitStudioKind(text)
  if (explicit) return result(explicit, EDIT.test(text) ? 'edit' : 'create')
  if (/^\s*(what|why|how|explain|compare|tell me|which|should|can you (?:explain|compare|review))\b/i.test(text)) return result('chat')
  if (/\b(?:do not|don't|dont|never)\s+(?:make|build|create|generate|design)\b/i.test(text)) return result('chat')
  const recent = studioKind(recentKind)
  if (recent && recent !== 'chat' && EDIT.test(text) && /\b(it|this|the same|that)\b/i.test(text) && !/\b(into|new|another|separate)\b/i.test(text)) return result(recent, 'edit')
  // A direct requested object is useful even if secondary nouns occur later.
  // More complicated syntax goes to chat on outage rather than guessing.
  const head = text.match(/\b(?:make|build|create|design|generate|produce|write|draft|prepare|need|want|render|draw|paint)\s+(?:(?:me|us|a|an|the|my|our|some|polished|beautiful|modern|new|simple|complete|editable|animated|aesthetic|professional)\s+){0,8}(website|web app|landing page|brand book|brand guidelines|floor plan|blueprint|logo reveal|motion graphic|logo|palette|poster|carousel|canvas|shopping list|document|report|book|spreadsheet|workbook|presentation|pitch deck|deck|image|photo|video|game|email|3d model)\b/i)?.[1]
  if (head) {
    const kinds = studioSignals(head)
    const picked = head === 'brand book' ? 'brand' : head === 'logo reveal' ? 'motion' : head === 'pitch deck' ? 'slides' : kinds[0]
    if (picked) return result(picked)
  }
  const signals = studioSignals(text)
  return result(signals.length === 1 && BUILD.test(text) ? signals[0] : 'chat')
}
