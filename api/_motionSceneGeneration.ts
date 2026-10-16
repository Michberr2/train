import { randomUUID } from 'node:crypto'
import { chatCompleteEx, completionFailure, primaryProvider, fallbackProvider } from './_llm'
import { validateMotionScene, type MotionSceneSpec } from '../shared/motionScene'
import { motionSceneHtml } from '../shared/motionSceneHtml'

/** The model authors composition and choreography; the renderer owns execution. */
export function motionSceneSystem(spec: MotionSceneSpec): string {
  return `You are an exceptional motion designer authoring an original vector film, not a website or a generic animated background. Return one complete JSON scene in the exact schema below. Nalu renders the scene with its own responsive SVG stage and absolute-time playback engine. You author the visual idea, geometry, typography, composition, layering and choreography; do not output HTML, CSS, JavaScript, timers or player controls.

STAGE: width ${spec.width}, height ${spec.height}, duration ${spec.durationMs} milliseconds. ${spec.loop ? 'Loop seamlessly: every layer must end in exactly the same effective pose as it starts.' : 'Play once: the final frame holds the finished composition.'} All coordinates, sizes and translation deltas are numbers in these logical stage units. The complete stage scales together on every screen. Never use viewport units, percentages or CSS strings in numeric fields.

AUTHOR THE CONCEPT: choose a distinctive visual idea that expresses this particular brief. Explain the idea and concrete opening, assembly/reveal, hero hold and return/finish times in the non-visible concept field, then actually implement those phases with keyframes. Match the requested restraint or intensity. When the brief asks for ambition, use confident type hierarchy, carefully layered custom geometry, interlocking forms, reveals and coordinated directional movement. Compose freely for the subject and aspect ratio; no prescribed centered layout, canned three-line template, ornamental spinner, or generic circles behind a fade. A circular ring rotating without a visible change is not assembly: use authored arcs with distinct extents, positions and reveals that actually form the focal geometry.

For an explicitly ambitious or high-energy kinetic brief, describe and build a geometric relationship between the typography and focal shapes. Give the focal type at least two distinct entrance actions coordinated with geometry: elements travel, rotate or scale into a deliberate shared arrangement, with anticipation or overshoot where appropriate, then settle. Opacity and reveal can support those actions; they must not be every headline's only changing values. Design a return with the same care. Compose the complete hero first, then derive the entrance and exit deltas. Use one main display voice and at most one supporting voice unless a typographic collage is requested. The authored relationships and changing frames should carry the energy, without relying on extra decoration or invented copy.

EXACT SCHEMA (only these keys; omit optional fields when unused):
{
  "version": 1,
  "name": "A short non-visible film name",
  "concept": "The authored visual idea and phase times; this is never visible copy",
  "background": "#F5F1E8",
  "posterTimeMs": ${Math.round(spec.durationMs / 2)},
  "layers": [
    {
      "id": "unique-layer-id",
      "type": "text",
      "box": { "x": ${Math.round(spec.width * .1)}, "y": ${Math.round(spec.height * .3)}, "width": ${Math.round(spec.width * .8)}, "height": ${Math.round(spec.height * .3)} },
      "fill": "#111111",
      "text": "Only copy requested by the user",
      "font": { "family": "Arial", "weight": 700, "size": 100, "tracking": 0, "lineHeight": 1.1 },
      "align": "center",
      "revealDirection": "left",
      "keyframes": [
        { "timeMs": 0, "x": 0, "y": 0, "scale": 1, "rotate": 0, "opacity": 0, "reveal": 0, "easing": "smooth" },
        { "timeMs": ${Math.round(spec.durationMs * .25)}, "opacity": 1, "reveal": 1 },
        { "timeMs": ${Math.round(spec.durationMs * .75)}, "opacity": 1, "reveal": 1 },
        { "timeMs": ${spec.durationMs}, "opacity": ${spec.loop ? 0 : 1}, "reveal": ${spec.loop ? 0 : 1} }
      ]
    }
  ]
}
The schema illustration explains a text layer and sparse keyframes; it is not an art-direction template. Invent the requested full composition and choreography. Other layer types are rect, circle, arc and path; their additional fields are specified below. Use only fields appropriate to each layer and supply the full timeline, including both endpoints, for every layer.

COMPOSITION / GEOMETRY:
- Array order is back to front. Use unique simple IDs, at most 40 layers and 32 keyframes per layer. There are no parent groups, asset references, images, filters, CSS, custom masks or external resources. Do not invent extra schema fields.
- box is the settled layout rectangle. x/y keyframe values are translation DELTAS from that box, not absolute positions; zero keeps the authored layout. Scale and rotation operate around the box center. Keep settled text inside the stage with safe margins and enough room for its actual glyphs.
- Text: use a separate literal text layer for each independently moving line or word. The renderer fits that exact copy into its box. Give the box sufficient height and width, including tracking; do not overlap distinct text boxes at the composed poster frame. Design supporting copy for phone readability: aim for at least3.3% of stage width (about64 at1920,36 at1080), with a roomy box that avoids shrinking it. Main typography should have a distinct display voice and deliberate scale. align is left, center or right. Supported font.family choices are Arial, Arial Black, Georgia, Courier New, Impact, Trebuchet MS; the runtime supplies an appropriate generic fallback. Custom font embedding is not supported in this scene version. Use a simple named face, not a CSS stack or URL. font.size is a maximum logical size, not a mandate to overflow the box. Do not split, paraphrase or add punctuation to exact user copy.
- Shapes: rect uses box and optional corner radius; circle uses box and optional radius. Optional stroke is a hex color and strokeWidth is a positive logical width. Arc requires distinct numeric startAngle/endAngle in degrees, a visible stroke, positive strokeWidth and fill:"none"; its optional radius must be positive. For rect/circle/arc, radius cannot exceed min(box.width,box.height)/2 minus strokeWidth/2; omitting radius uses a fitted shape. Prefer omitting radius for fitted circles and arcs unless a custom radius is intentional; then calculate the exact bound including the stroke. Author partial arc geometry, not a ring covered by a destructive mask. Path requires a path string such as "M 0 0 L 100 0 L 50 100 Z", with only valid SVG geometry commands and numeric coordinates in its local box coordinate system. Keep local points within the box, including room for stroke. Do not put text/font/align on shapes, path on other layer types, or startAngle/endAngle on non-arcs. No markup, selectors or executable values.
- Use hex colors for background/fill/stroke; fill or stroke may be "none". Respect the exact requested palette and background. Maintain strong text/background contrast: a light accent on a light background needs a contrasting authored backing shape or a darker text color from the requested palette. Meaningful geometry must be visible rather than hidden behind opaque later layers.

TIMELINE / KEYFRAMES:
- Every layer has an explicit frame at timeMs:0 and timeMs:${spec.durationMs}; additional times must increase strictly inside the duration. Pose keys are x, y, scale, rotate, opacity, reveal; all values are finite numbers. Defaults: x/y/rotate=0, scale/opacity/reveal=1. Omitted pose values carry forward from the previous frame. Never put CSS transform syntax or easing expressions into a pose.
- Staggering requires actual held keyframes: a hidden pose at0 followed by a hero pose at2000 starts moving immediately at0. To start an entrance at1200 and finish at2000, repeat the initial hidden pose at1200, then put the settled pose at2000. For example hold y:160/reveal:0 through1200, then y:0/reveal:1 at2000; another entrance could hold x:240 through1800 then settle x:0 at2700. These illustrate timing semantics, not required positions or choreography. Match every opening/assembly/hold/return time claimed in concept to the actual keyframes.
- Allowed easing names: linear, smooth, in, out, overshoot. opacity and reveal are 0..1. reveal is the extent of a safe engine-owned clip in revealDirection; animate it from0 to1 for a real masked reveal. Allowed revealDirection values are exactly left, right, up, down: up reveals bottom-to-top and down reveals top-to-bottom. Do not use top or bottom as values. Shape assembly should alter visible positions, extents or scales, not merely pulse the whole film's opacity.
- One total timeline coordinates all layers: include stagger times as keyframes within ${spec.durationMs}ms, not independent delayed loops. Plan enough time for the fully composed message to be read. If the user requests a hold of at least four seconds, explicitly keep every required text and focal layer in its fully readable hero pose for at least 4000ms. Decorative movement may continue if it preserves readability.
- posterTimeMs must be inside the readable hero hold. Every text layer is simultaneously fully visible there (opacity/reveal at least0.99, scale at least0.5), correctly positioned, with non-overlapping boxes. Reduced motion uses this exact composed frame. Do not make every phase visible at once.
- ${spec.loop ? 'The effective final values of x/y/scale/rotate/opacity/reveal must equal the initial values for every layer. Author a deliberate return to the opening pose; the engine will not hide a bad seam with a global fade.' : 'Make the last keyframe the intended held finish, with all requested ending copy readable.'} At least one layer must visibly change an effective pose value. You do not implement pause, seek, responsive sizing, reduced-motion handling or an animation clock: the engine does that.

FIDELITY: explicit user copy, spelling, case, punctuation, palette, timing, aspect and sequence win. Add no unsupported slogans, numbers, labels, claims or calls to action. Use the brand's supplied name/colors/type where relevant and not overridden. Preserve the requested palette during repairs: fix contrast using another requested color or a requested-color backing shape, not an unrequested black. Supporting copy needs a safe bottom margin and a box large enough to retain its phone-readable size after fitting. This schema cannot embed raster images or arbitrary supplied SVG assets; do not promise those capabilities or invent a substitute logo. Keep creative quality in the authored composition, shapes and choreography.

Return ONLY the complete JSON object. No markdown fences, HTML, reasoning tags or prose outside JSON. Check geometry, contrast, text boxes, readable hold and every timeline endpoint before returning.`
}

/** Scene v1 can use brand text/type/color, but has no embedded asset layer. */
export function motionSceneBrandHint(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const brand = raw as Record<string, unknown>
  const details = ['name', 'headingFont', 'bodyFont'].flatMap(key => typeof brand[key] === 'string' && brand[key] ? [`${key}: ${String(brand[key]).slice(0, 160)}`] : [])
  for (const key of ['primary', 'accent', 'dark', 'text']) {
    const color = typeof brand[key] === 'string' ? String(brand[key]) : ''
    if (/^#?[0-9a-f]{6}$/i.test(color)) details.push(`${key}: #${color.replace(/^#/, '').toUpperCase()}`)
  }
  if (brand.logo || brand.logoMark) details.push('A logo is saved, but scene v1 has no embedded asset layer. Do not invent or redraw a substitute logo.')
  return details.length ? `\n\nACTIVE BRAND KIT (apply where relevant unless the user overrides it; dark is a palette option, not a background requirement):\n${details.join('; ')}` : ''
}

export function parseMotionSceneJson(content: string): unknown {
  const clean = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = clean.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1] : clean)
}

/** Useful production diagnostics without logging authored copy or layer IDs. */
export function motionSceneIssueCodes(issues: string[]): string[] {
  return [...new Set(issues.map(issue => {
    const detail = issue.slice(issue.indexOf(':') + 1)
    if (/contrast/.test(detail)) return 'text_contrast'
    if (/boxes overlap/.test(detail)) return 'text_overlap'
    if (/leaves the stage/.test(detail)) return 'text_bounds'
    if (/fully readable/.test(detail)) return 'text_readability'
    if (/loop endpoint/.test(detail)) return 'loop_seam'
    if (/radius|strokeWidth|arc needs|arc fill/.test(detail)) return 'shape_geometry'
    if (/path/.test(detail)) return 'path_geometry'
    if (/font|lineHeight/.test(detail)) return 'font_contract'
    if (/keyframes|timeMs|easing|animated pose/.test(detail)) return 'timeline_contract'
    return 'scene_contract'
  }))]
}

export async function generateMotionScene(options: {
  model: string; system: string; user: string; spec: MotionSceneSpec; deadlineMs: number; reasoningEffort?: 'medium' | 'high'; maxProviderCalls?: 2 | 3
}): Promise<{ html: string; motion: MotionSceneSpec } | null> {
  const primary = primaryProvider(options.model)
  const fallback = fallbackProvider() || primary
  const started = Date.now(), requestId = randomUUID()
  const reasoningEffort = options.reasoningEffort || 'medium'
  const diagnostic = (details: Record<string, unknown>) => console.info(JSON.stringify({ event: 'nalu.motion.scene.attempt', requestId, elapsedMs: Date.now() - started, remainingMs: Math.max(0, options.deadlineMs - Date.now()), ...details }))
  let previous = '', issues: string[] = []
  const completeRejections: string[][] = []
  let replyProvider = primary || fallback
  const maxProviderCalls = options.maxProviderCalls === 2 ? 2 : 3
  for (let attempt = 0; attempt < maxProviderCalls; attempt++) {
    const availableMs = options.deadlineMs - Date.now() - 10000
    // A final repair is solely for two completed, invalid scene objects. Never
    // extend a transport fallback, truncation recovery or exhausted deadline.
    if (attempt === 2 && (completeRejections.length !== 2 || availableMs < 60000)) {
      diagnostic({ attempt: 3, outcome: 'not_started', category: completeRejections.length !== 2 ? 'repair_ineligible' : 'deadline' })
      break
    }
    const timeoutMs = Math.min(attempt === 0 ? 190000 : attempt === 2 ? 60000 : previous ? 110000 : 70000, availableMs)
    const provider = attempt === 0 ? primary || fallback : previous ? replyProvider : fallback
    if (timeoutMs < 1000 || !provider) { diagnostic({ attempt: attempt + 1, outcome: 'not_started', category: provider ? 'deadline' : 'not_configured' }); break }
    const attemptStarted = Date.now()
    try {
      const messages = [{ role: 'system', content: options.system }, { role: 'user', content: options.user }]
      if (previous) {
        const repeated = attempt === 2 ? issues.filter(issue => completeRejections[0].includes(issue)) : []
        const repeatedGuidance = repeated.length ? `\nThe previous repair did not resolve these same findings:\n- ${repeated.join('\n- ')}\nRecalculate their affected values against the schema and the reported bounds. Repeating the previous ineffective change will fail the same check.` : ''
        messages.push({ role: 'assistant', content: previous }, { role: 'user', content: `Correct only these verified scene defects while preserving the requested copy, visual concept, palette and choreography:\n- ${issues.join('\n- ')}${repeatedGuidance}\nFor a contrast finding, use another color from the requested palette or add an opaque requested-palette backplate covering the complete affected text box; do not introduce an unrequested color.\n${attempt === 2 ? 'This is the final bounded repair. Preserve every unaffected field and change only what is necessary to resolve the remaining findings. ' : ''}Return the complete corrected JSON scene in the exact schema, not a continuation fragment. Do not replace the concept or add content.` })
      }
      const result = await chatCompleteEx(messages, { model: options.model, maxTokens: 11000, timeoutMs, providers: [provider], maxAttempts: 1, retryPrimary: false, json: true, reasoningEffort, temperature: attempt === 0 ? 0.75 : 0.5 })
      previous = result.content
      replyProvider = provider
      let raw: unknown
      try { raw = parseMotionSceneJson(previous) } catch { issues = ['The response is not one complete valid JSON scene. Return the entire JSON object without prose or truncation.'] }
      const checked: ReturnType<typeof validateMotionScene> = raw === undefined ? { issues } : validateMotionScene(raw, options.spec)
      issues = checked.issues
      diagnostic({ attempt: attempt + 1, provider: provider.label, reasoningEffort, timeoutMs, durationMs: Date.now() - attemptStarted, outcome: checked.scene && !issues.length ? 'accepted' : 'rejected', finishReason: ['stop', 'length'].includes(result.finishReason) ? result.finishReason : 'other', outputChars: result.content.length, issueCodes: raw === undefined ? ['json_syntax'] : motionSceneIssueCodes(issues), issueCount: issues.length })
      if (checked.scene && !issues.length) {
        try { return { html: motionSceneHtml(checked.scene, options.spec), motion: options.spec } }
        catch { diagnostic({ attempt: attempt + 1, outcome: 'failed', category: 'render_failed' }); return null }
      }
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && result.finishReason === 'stop') completeRejections.push([...issues])
    } catch (error) {
      const failure = completionFailure(error) || { category: 'unavailable' }
      diagnostic({ attempt: attempt + 1, provider: provider.label, reasoningEffort, timeoutMs, durationMs: Date.now() - attemptStarted, outcome: 'failed', ...failure })
      if (attempt > 0) break
      if (attempt === 0 && fallback?.base === provider.base && fallback.model === provider.model && fallback.key === provider.key && (failure.category === 'quota' || failure.status === 401 || failure.status === 403)) {
        diagnostic({ attempt: 2, outcome: 'not_started', category: 'provider_unavailable' })
        break
      }
    }
  }
  return null
}
