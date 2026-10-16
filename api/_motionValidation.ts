import { parse, type Rule, type AtRule, type ChildNode, type Node } from 'postcss'

const declarations = (rule: Rule): Map<string, string> => new Map(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop.toLowerCase(), node.value]))
function within(node: ChildNode, test: (parent: AtRule) => boolean): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) if (parent.type === 'atrule' && test(parent as AtRule)) return true
  return false
}
const parts = (selector: string): string[] => selector.split(',').map(value => value.trim())
const reduced = (node: Rule) => within(node, parent => parent.name === 'media' && /prefers-reduced-motion\s*:\s*reduce\b/i.test(parent.params))

/** Evidence of broken contracts, not a score for aesthetics or code length.
 * Unknown dynamic CSS/controllers are left for browser review, not guessed at. */
export function motionContractIssues(html: string, spec: { loop: boolean; width: number; height: number }): string[] {
  const issues: string[] = []
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(match => match[1]).join('\n')
  const spaceOrComment = '(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*)*'
  const emptyHook = new RegExp(`\\bnaluMotion\\s*=\\s*\\{\\s*render\\s*(?::\\s*(?:function\\s*\\([^)]*\\)|\\([^)]*\\)\\s*=>)|\\([^)]*\\))\\s*\\{${spaceOrComment}\\}`, 'm')
  if (emptyHook.test(scripts)) issues.push('The declared naluMotion.render hook is empty. Remove the hook for pure CSS animation, or implement a real absolute-time frame renderer; a placeholder hook cannot control playback.')

  const roots = []
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    try { roots.push(parse(match[1])) } catch { issues.push('An inline stylesheet has invalid CSS syntax. Return a complete, parseable stylesheet.'); return issues }
  }
  const rules: Rule[] = []
  const names = new Set<string>()
  for (const root of roots) {
    root.walkAtRules(/^(?:-webkit-)?keyframes$/, at => { names.add(at.params.trim()) })
    root.walkRules(rule => { if (!within(rule, at => /keyframes$/.test(at.name))) rules.push(rule) })
  }
  const normalRules = rules.filter(rule => !reduced(rule))
  const properties = new Map<string, Map<string, string>>()
  for (const rule of normalRules) for (const selector of parts(rule.selector)) {
    const merged = properties.get(selector) || new Map<string, string>()
    for (const [name, value] of declarations(rule)) merged.set(name, value)
    properties.set(selector, merged)
  }
  // Only unambiguous text targets are checked. A finite decorative accent is
  // allowed when the focal timeline repeats, and JS can control finite effects.
  const textClasses = new Set<string>(), textIds = new Set<string>()
  for (const match of html.matchAll(/<(?:h[1-6]|p|span|text)\b([^>]*)>/gi)) {
    for (const name of (match[1].match(/\bclass=["']([^"']*)["']/i)?.[1] || '').split(/\s+/)) if (name) textClasses.add(name)
    const id = match[1].match(/\bid=["']([^"']*)["']/i)?.[1]; if (id) textIds.add(id)
  }
  const textTarget = (selector: string) => /(?:^|[\s>+~])(?:h[1-6]|p|span|text)(?:$|[\s.#:[>+~])/i.test(selector)
    || [...selector.matchAll(/\.([\w-]+)|#([\w-]+)/g)].some(match => match[1] ? textClasses.has(match[1]) : textIds.has(match[2]))
  const controller = /\brequestAnimationFrame\s*\(|\bsetInterval\s*\(|\.animate\s*\(|\bnaluMotion\s*=/.test(scripts)
  if (spec.loop && !controller) for (const [selector, props] of properties) {
    if (!textTarget(selector)) continue
    const animation = props.get('animation') || props.get('-webkit-animation') || ''
    const animationNames = props.get('animation-name') || ''
    if (!animation && !animationNames || /\bvar\s*\(/.test(animation + animationNames)) continue
    const declared = (animation || animationNames).split(/,(?![^()]*\))/).map(value => value.trim())
    const iteration = props.get('animation-iteration-count') || props.get('-webkit-animation-iteration-count') || ''
    if (/\binfinite\b/.test(iteration)) continue
    const finite = declared.filter(value => !/\binfinite\b/.test(value) && [...names].some(name => value.split(/\s+/).includes(name)))
    if (finite.length) issues.push(`The repeating film gives text selector ${selector.slice(0, 100)} finite CSS animations (${finite.join('; ').slice(0, 180)}) without a repeating JavaScript controller. Its reveal/exit will run only once. Encode those phases in the full repeating timeline so the text returns on later cycles.`)
  }
  for (const [selector, props] of properties) {
    const fixed = props.get('width') === `${spec.width}px` && props.get('height') === `${spec.height}px`
    const responsive = /(?:scale|zoom)\s*\([^)]*(?:var|calc|clamp)|(?:100|\d+(?:\.\d+)?)vw|100%/.test([props.get('max-width'), props.get('transform'), props.get('zoom')].join(' '))
      || /(?:innerWidth|clientWidth|ResizeObserver)/.test(scripts)
    if (fixed && !responsive) issues.push(`Selector ${selector.slice(0, 100)} fixes the entire stage at ${spec.width}x${spec.height}px without responsive fitting. The standalone HTML will clip at phone sizes. Fit the full composition to the viewport while preserving its intended aspect and hierarchy.`)
    const transform = props.get('transform') || ''
    if (!/translate(?:X|Y|3d)?\s*\([^)]*%/i.test(transform)) continue
    for (const rule of rules.filter(reduced)) {
      if (declarations(rule).get('transform') !== 'none') continue
      if (parts(rule.selector).some(value => value === '*' || value === selector)) issues.push(`Reduced-motion CSS removes the percentage-based positioning transform on ${selector.slice(0, 100)}. Preserve its centering/layout transform and freeze only animated children so the static composition stays in place.`)
    }
  }
  return [...new Set(issues)]
}
