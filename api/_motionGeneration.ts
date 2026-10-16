import { Script } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { chatCompleteEx, completionFailure, primaryProvider, fallbackProvider } from './_llm'
import { motionContractIssues } from './_motionValidation'

export type MotionSpec = { durationMs: number; width: number; height: number; loop: boolean }

function savedNumber(html: string, name: string, fallback: number, max: number): number {
  const tag = html.match(/<html\b[^>]*>/i)?.[0] || ''
  const value = Number(tag.match(new RegExp(`\\bdata-nalu-motion-${name}=["'](\\d+)["']`, 'i'))?.[1])
  return Number.isFinite(value) && value > 0 && value <= max ? value : fallback
}

/** Revisions retain a saved timeline. Only explicit format/timing asks replace it. */
export function motionSpec(prompt: string, previousHtml = ''): MotionSpec {
  const spec: MotionSpec = {
    durationMs: savedNumber(previousHtml, 'duration-ms', 8000, 3600000),
    width: savedNumber(previousHtml, 'width', 1920, 8192),
    height: savedNumber(previousHtml, 'height', 1080, 8192),
    loop: !/<html\b[^>]*\bdata-nalu-motion-loop=["']false["']/i.test(previousHtml),
  }
  const timings = [...prompt.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:-\s*)?(milliseconds?|msecs?|ms|seconds?|secs?|s)\b/gi)]
  const overall = timings.find((match) => /(?:total(?:\s+duration)?|duration|runtime|length)\s*(?:is|of|:|=|to)?\s*$/i.test(prompt.slice(Math.max(0, match.index! - 45), match.index)))
  const duration = overall || timings.find((match) => !/\b(?:hold|delay|pause|fade|reveal|intro|outro|transition|wait)\b[^.!?;:]{0,25}$/i.test(prompt.slice(Math.max(0, match.index! - 35), match.index)))
  if (duration) {
    const ms = Number(duration[1]) * (/^(?:milli|msec|ms$)/i.test(duration[2]) ? 1 : 1000)
    if (ms >= 100 && ms <= 3600000) spec.durationMs = Math.round(ms)
  }
  // Aspect ratios are independent of output pixels. Canonical dimensions keep
  // the requested proportion; dimensions are metadata, not a CSS pixel mandate.
  const formats = [...prompt.matchAll(/\b(\d{1,4})\s*([:x×])\s*(\d{1,4})\b/gi)]
  const orientations = [...prompt.matchAll(/\b(portrait|vertical|landscape|horizontal|square)\b(?!\s+(?:line|stroke|bar|rule|text|title|shape|element|edge|divider)s?\b)/gi)]
  const format = formats[formats.length - 1] || orientations[orientations.length - 1]
  if (format) {
    if (!format[2]) {
      const portrait = /portrait|vertical/i.test(format[1])
      const square = /square/i.test(format[1])
      spec.width = portrait ? 1080 : square ? 1080 : 1920
      spec.height = portrait ? 1920 : 1080
    } else {
      const w = Number(format[1]), h = Number(format[3])
      if (w > 0 && h > 0 && w <= 8192 && h <= 8192) {
        if (w >= 128 && h >= 128 && format[2] !== ':') { spec.width = w; spec.height = h }
        else { const scale = 1920 / Math.max(w, h); spec.width = Math.round(w * scale); spec.height = Math.round(h * scale) }
      }
    }
  }
  const loopMatches = [...prompt.matchAll(/\b(?:do not loop|don't loop|no loop(?:ing)?|non[- ]looping|one[- ]shot|play once|loop(?:ing)?(?:\s+(?:forever|seamlessly|continuously))?)\b/gi)]
  const loops = loopMatches[loopMatches.length - 1]
  if (loops) spec.loop = /^loop/i.test(loops[0])
  return spec
}

export function motionSystem(spec: MotionSpec, editing: boolean): string {
  return `You are a motion designer and creative coder. Deliver one complete, self-contained animated HTML film that implements the user's specific request.
${editing ? 'REVISION: edit the supplied motion document. Preserve its copy, composition, assets, colors, timing and behavior except for the requested changes. Complete unfinished code without replacing the concept. This is a motion graphic, not a website.' : 'Design a deliberate composition and a visible sequence of actions; do not substitute a generic animated background for the requested film.'}

FORMAT AND TIMELINE: ${spec.width} by ${spec.height}, ${spec.durationMs} milliseconds. ${spec.loop ? 'Loop seamlessly; the final transition must meet the opening state without an accidental jump.' : 'Play once, then hold the final composed frame. Do not loop.'} The entire viewport is the stage, without scrolling, browser chrome, buttons or player controls. Keep all meaningful content inside the stage with safe margins; use responsive coordinates/type appropriate to this aspect ratio.

AUTHOR THE IDEA BEFORE CODING: choose one specific visual concept that expresses this subject, then turn it into a deliberate sequence. Establish the focal form, typography hierarchy, supporting geometry, and how they interact through the requested phases. Make the craft visible in custom geometry, masks, spatial relationships and precise choreography suited to the brief. Match the requested restraint or intensity. A few generic rings/blobs plus text fading are insufficient when the request calls for assembly, kinetic type or a designed reveal. Record a concise concept and phase times in a non-visible HTML comment, then implement that actual plan. On revisions preserve the existing authored concept and change only what was requested.

RELIABLE STAGE / TIMELINE SCAFFOLD (technical structure, not a visual template):
- For vector/typographic work, prefer one outer SVG with viewBox="0 0 ${spec.width} ${spec.height}", preserveAspectRatio="xMidYMid meet", and CSS width:100%;height:100%;display:block inside a 100vw by100vh stage. Author geometry, masks, type and safe margins in these logical coordinates. This scales the complete composition together on phones; no large minimum viewport-font sizes or unscaled pixel containers. Keep the requested canvas/DOM approach when editing or when explicitly requested.
- For an authored JavaScript timeline, these complete helpers can be reused: const D=${spec.durationMs}; const clamp01=x=>Math.max(0,Math.min(1,x)); const phase=(t,a,b)=>{const x=clamp01((t-a)/(b-a));return x*x*(3-2*x)}; const frameTime=ms=>${spec.loop ? '((ms%D)+D)%D' : 'Math.max(0,Math.min(D,ms))'};
- Implement a real named render(timeMs) that applies frameTime and phase to every authored group and text layer; select a composed hold time for reduced motion. Your render must update the actual DOM/SVG/canvas geometry and opacity. Check that all CSS selectors and element references match elements that exist. Register window.naluMotion={render}; then standalone playback is: let origin; function tick(t){if(origin===undefined)origin=t;render(t-origin);requestAnimationFrame(tick)} requestAnimationFrame(tick). Never output an empty render, TODO, or example-only stub. Pure CSS timelines may omit JavaScript entirely.

MOTION DIRECTION:
- Honor every requested action: if the user asks for assembly, a reveal, then a readable hold, implement those as distinct phases on the actual focal geometry and typography. Choose phase times before coding and record a concise timeline in an HTML comment. For a reveal/promo, leave enough of the full duration for the final message to be read; transitions must connect the phases. An explicitly ambient or continuous request can remain continuous.
- Make the motion perceptible: changing position, scale, masked extent or shape should create meaningfully different visible frames. Merely rotating a perfectly circular ring, leaving all copy static, or adding a background spinner does not fulfill an assembly or typography reveal. Favor coordinated easing/stagger and clear visual hierarchy; no gratuitous flashing or decoration that competes with the subject.
- CSS keyframes and Web Animations are preferred for planned timelines. Coordinate durations and delays against the full ${spec.durationMs}ms timeline, including holds and the reset/finish. Use transform and opacity for DOM animation; do not animate layout. Canvas/SVG animation is welcome when requested or useful.
- Keep headline, supporting copy and geometry on the same total timeline, including its loop reset. Encode staggered entrances and exits as phases within that shared duration; independently delayed full-duration infinite loops can leave ghost copy after the main composition exits and do not match the first frame. Check all layers together at the opening, readable hold and return.
- For JavaScript animation use the requestAnimationFrame callback's timestamp, with a stable origin, to compute the entire frame from elapsed time. Do not use Date.now(), performance.now(), frame counters, setInterval or setTimeout as an animation clock. Frames must render correctly if elapsed time moves backward or jumps forward (pause/seek/replay). Do not stop requesting frames at the end; clamp visual progress for a one-shot. Use deterministic seeded geometry, not fresh randomness on every frame.
- JavaScript playback hook: expose window.naluMotion = { render: function(timeMs) { /* draw the complete frame at this absolute timeline time */ } }. render must synchronously compute all visual state from timeMs, without scheduling frames, advancing mutable simulation state, or requiring earlier frames. The standalone HTML still starts its own requestAnimationFrame loop calling this same render function with elapsed time. Nalu's player can cancel that loop and call render directly for precise pause, seek and replay. For looping films derive phase from timeMs modulo the duration; for one-shot films clamp to the duration. Pure CSS/WAAPI films do not need this hook.
- Honor prefers-reduced-motion with a meaningful, readable static composed frame; never leave the reduced-motion view blank or with overlapping phases. Canvas code must check the media query too. Animation starts on load without a click or hover, with no autoplay audio.
- Preserve structural layout and centering transforms in reduced-motion mode. Do not globally set every transform to none or every layer's opacity to one: that can displace centered geometry or superimpose different phases. Separate positioning wrappers from animated children and explicitly show one composed, readable frame.

ART DIRECTION AND FIDELITY:
- Explicit user instructions win: exact copy including capitalization/punctuation, background (light stays light), palette, logo geometry, aspect, duration and action order. Do not add unsupported claims, slogans, numbers or calls to action. Do not force a dark/neon look or any house style. The active brand kit applies where the request does not override it.
- Build a finished piece with intentional type scale, optical alignment, contrast and spacing suited to its content and format. Preserve supplied logo geometry; animate its groups or container, never redraw it as an unrelated symbol.
- One HTML document with inline CSS, inline SVG and optional classic inline JavaScript. No external libraries, scripts, imports, fetched imagery or network dependencies. Supplied embedded brand assets may be used directly. System font stacks must work offline; optional font links require a readable fallback. Do not rely on an unavailable brand asset or invent a replacement mark.

Return ONLY the complete HTML from <!doctype html> through </html>. No markdown fences, reasoning tags or prose. Check closing tags and JavaScript syntax before returning.`
}

/** Motion-specific placement avoids putting a nav/header into a film. */
export function motionBrandHint(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const b = raw as Record<string, unknown>
  const colors = ['primary', 'accent', 'dark', 'text'].flatMap((name) => {
    const value = typeof b[name] === 'string' ? b[name] as string : ''
    return /^#?[0-9a-f]{6}$/i.test(value) ? [`${name}: #${value.replace(/^#/, '').toUpperCase()}`] : []
  })
  const details = ['name', 'headingFont', 'bodyFont'].flatMap((name) => typeof b[name] === 'string' && b[name] ? [`${name}: ${String(b[name]).slice(0, 160)}`] : [])
  let logo = typeof b.logo === 'string' && b.logo ? b.logo : typeof b.logoMark === 'string' ? b.logoMark : ''
  if (/^data:image\/svg\+xml[;,]/i.test(logo)) {
    try {
      const comma = logo.indexOf(',')
      logo = /;base64/i.test(logo.slice(0, comma)) ? Buffer.from(logo.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(logo.slice(comma + 1))
    } catch { logo = '' }
  }
  const inlineLogo = /^\s*<svg\b/i.test(logo) && logo.length <= 12000 && /<\/svg>\s*$/i.test(logo)
    ? `\nSUPPLIED BRAND LOGO — embed this exact SVG in the composition, preserving its geometry and aspect ratio. Animate its existing groups or container:\n${logo}` : ''
  const unavailableLogo = logo && !inlineLogo ? '\nA saved logo exists but its embedded geometry is not available in this request. Do not invent or redraw a substitute mark; use the supplied brand name as text when appropriate.' : ''
  return colors.length || details.length || inlineLogo || unavailableLogo
    ? `\n\nACTIVE BRAND KIT (apply unless explicitly overridden by the request; "dark" is a palette option, not an instruction to use a dark background):\n${[...details, ...colors].join('; ')}${inlineLogo}${unavailableLogo}` : ''
}

export function cleanMotionHtml(text: string): string {
  let html = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fence = html.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) html = fence[1].trim()
  const start = html.search(/<!doctype\b|<html\b/i)
  if (start > 0) html = html.slice(start)
  const end = html.toLowerCase().lastIndexOf('</html>')
  return (end === -1 ? html : html.slice(0, end + 7)).trim()
}

/** Conservative source checks only. Visual composition still requires browser QA. */
export function motionIssues(html: string, spec?: MotionSpec): string[] {
  const issues: string[] = []
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html) || !/<\/body>/i.test(html) || !/<\/html>\s*$/i.test(html)) issues.push('The HTML document is incomplete; include html/body and their closing tags.')
  const source = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of ['style', 'script']) {
    if ((source.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length !== (source.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length) issues.push(`An inline ${tag} element is not closed.`)
  }
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1]
    const type = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase()
    if (type && !/^(?:text\/javascript|application\/javascript|module)$/.test(type)) continue // JSON/data scripts are not executable JS.
    if (/\bsrc\s*=/i.test(attrs)) { issues.push('An executable script depends on an external URL; this film must work offline.'); continue }
    if (type === 'module') continue // VM Script cannot parse modules; do not reject valid module syntax.
    try { new Script(match[2]) } catch (error) { issues.push(`Inline JavaScript cannot parse: ${(error as Error).message.slice(0, 180)}`) }
  }
  const cssMotion = /@(?:-webkit-)?keyframes\s+[\w-]+/i.test(source) && /(?:animation(?:-name)?\s*:)/i.test(source)
  const jsMotion = /\brequestAnimationFrame\s*\(|\.animate\s*\(/.test(source)
  const svgMotion = /<(?:animate|animateTransform|animateMotion)\b/i.test(source)
  if (!cssMotion && !jsMotion && !svgMotion) issues.push('No CSS keyframe, Web Animation, requestAnimationFrame or SVG animation is present; the requested motion is static.')
  if (spec) issues.push(...motionContractIssues(html, spec))
  return [...new Set(issues)]
}

export function stampMotionHtml(html: string, spec: MotionSpec): string {
  return html.replace(/<html\b([^>]*)>/i, (_all, attrs: string) => {
    const clean = attrs.replace(/\s+data-nalu-motion-(?:duration-ms|width|height|loop)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    return `<html${clean} data-nalu-motion-duration-ms="${spec.durationMs}" data-nalu-motion-width="${spec.width}" data-nalu-motion-height="${spec.height}" data-nalu-motion-loop="${spec.loop}">`
  })
}

export function motionIssueCodes(issues: string[]): string[] {
  const patterns: Array<[RegExp, string]> = [
    [/HTML document is incomplete/, 'incomplete_html'], [/element is not closed/, 'unclosed_element'],
    [/JavaScript cannot parse/, 'script_syntax'], [/external URL/, 'external_script'], [/requested motion is static/, 'no_animation'],
    [/hook is empty/, 'empty_render_hook'], [/invalid CSS syntax/, 'css_syntax'], [/finite CSS animations/, 'finite_text_timeline'],
    [/without responsive fitting/, 'fixed_stage'], [/positioning transform/, 'reduced_positioning'],
  ]
  return [...new Set(issues.map(issue => patterns.find(([pattern]) => pattern.test(issue))?.[1] || 'other_contract'))]
}

export async function generateMotion(options: {
  model: string; system: string; user: string; spec: MotionSpec; deadlineMs: number; reasoningEffort?: 'medium' | 'high'
}): Promise<{ html: string; motion: MotionSpec } | null> {
  const primary = primaryProvider(options.model)
  const fallback = fallbackProvider() || primary
  const requestId = randomUUID()
  const started = Date.now()
  const reasoningEffort = options.reasoningEffort || 'medium'
  const diagnostic = (details: Record<string, unknown>) => console.info(JSON.stringify({ event: 'nalu.motion.attempt', requestId, elapsedMs: Date.now() - started, remainingMs: Math.max(0, options.deadlineMs - Date.now()), ...details }))
  let previous = '', issues: string[] = []
  let replyProvider = primary || fallback
  // At most two actual provider calls: generation then one evidenced repair or
  // fallback. Account for grounding/auth time before this function was entered.
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutMs = Math.min(attempt === 0 ? 190000 : previous ? 110000 : 70000, options.deadlineMs - Date.now() - 10000)
    // A provider that produced repairable code is available and has the right
    // context. Switching a content repair to an unavailable fallback made every
    // validation defect a hard failure despite a healthy primary.
    const provider = attempt === 0 ? primary || fallback : previous ? replyProvider : fallback
    if (timeoutMs < 1000 || !provider) { diagnostic({ attempt: attempt + 1, outcome: 'not_started', category: provider ? 'deadline' : 'not_configured' }); break }
    const attemptStarted = Date.now()
    try {
      const messages = [{ role: 'system', content: options.system }, { role: 'user', content: options.user }]
      if (previous) messages.push({ role: 'assistant', content: previous }, { role: 'user', content: `Correct only these verified defects while preserving the request's copy, visual concept, format and timing:\n- ${issues.join('\n- ')}\nReturn the complete corrected HTML document, not a continuation fragment. Do not replace the concept or add new content.` })
      const result = await chatCompleteEx(messages, {
        model: options.model, maxTokens: 11000, timeoutMs, providers: [provider],
        maxAttempts: 1, retryPrimary: false, reasoningEffort, temperature: attempt === 0 ? 0.75 : 0.5,
      })
      previous = cleanMotionHtml(result.content)
      replyProvider = provider
      issues = motionIssues(previous, options.spec)
      diagnostic({ attempt: attempt + 1, provider: provider.label, reasoningEffort, timeoutMs, durationMs: Date.now() - attemptStarted, outcome: issues.length ? 'rejected' : 'accepted', finishReason: ['stop', 'length'].includes(result.finishReason) ? result.finishReason : 'other', outputChars: result.content.length, issueCodes: motionIssueCodes(issues) })
      if (!issues.length) return { html: stampMotionHtml(previous, options.spec), motion: options.spec }
    } catch (error) {
      const failure = completionFailure(error) || { category: 'unavailable' }
      diagnostic({ attempt: attempt + 1, provider: provider.label, reasoningEffort, timeoutMs, durationMs: Date.now() - attemptStarted, outcome: 'failed', ...failure })
      if (attempt === 0 && fallback?.base === provider.base && fallback.model === provider.model && fallback.key === provider.key && (failure.category === 'quota' || failure.status === 401 || failure.status === 403)) {
        diagnostic({ attempt: 2, outcome: 'not_started', category: 'provider_unavailable' })
        break
      }
      /* One bounded fallback; no partial script is reported as success. */
    }
  }
  return null
}
