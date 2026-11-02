/** Canonical owner: train/api/_agentActionContract.ts. The desktop mirror is
 * byte-checked by the cross-repository regression; update both together.
 * Versioned transport shape for the existing desktop v1 tools. Keep this in
 * conformance with agentTaskBroker.parseAgentReadOperation,
 * agentTaskTools.parseAgentMutationOperation and ComputerAction. This validates
 * structure only: the main-process broker remains the authority for paths,
 * ownership, approval, target freshness and execution. No defaults are inferred. */
type Field = {
  type?: 'string' | 'number' | 'integer' | 'object'
  properties?: Record<string, Field>; required?: string[]
  enum?: Array<string | number>; anyOf?: Field[]
  maxLength?: number; maxBytes?: number; nonempty?: boolean
  minimum?: number; maximum?: number; httpUrl?: boolean
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (maxBytes: number, empty = false): Field => ({ type: 'string', maxBytes, nonempty: !empty })
const chars = (maxLength: number): Field => ({ type: 'string', maxLength, nonempty: true })
const number = (minimum?: number, maximum?: number): Field => ({ type: 'number', ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) })
const object = (properties: Record<string, Field>, optional: string[] = []): Field => ({ type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)) })
const literal = (value: string): Field => ({ type: 'string', enum: [value] })
const observed = text(256), point = number(0), scroll = number(-2000, 2000)
const native = (kind: string, properties: Record<string, Field>, optional: string[] = []) => object({ kind: literal(kind), observationId: observed, ...properties }, optional)
const nativeAction: Field = { anyOf: [
  native('press_element', { elementId: text(256), axAction: { ...text(256), enum: ['AXPress','AXShowMenu','AXConfirm','AXIncrement','AXDecrement','AXRaise'] } }, ['axAction']),
  native('set_value', { elementId: text(256), text: text(32000, true) }),
  native('click', { x: point, y: point, button: { type: 'string', enum: ['left','right'] }, count: { type: 'integer', enum: [1,2] } }, ['button','count']),
  native('drag', { x: point, y: point, toX: point, toY: point }),
  native('scroll', { x: point, y: point, deltaX: scroll, deltaY: scroll }),
  native('type', { text: text(32000, true) }),
  native('key', { combo: { ...text(256), maxLength: 80 } }),
] }
const argumentFields: Record<string, Field> = {
  read_file: object({ path: chars(4096) }),
  list_dir: object({ path: chars(4096) }),
  search: object({ root: chars(4096), query: chars(2000) }),
  write_file: object({ path: text(4096), content: text(128 * 1024, true) }),
  edit_file: object({ path: text(4096), find: text(128 * 1024), replace: text(128 * 1024, true) }),
  shell: object({ command: text(32000), cwd: text(4096), timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 } }, ['cwd','timeoutMs']),
  native_apps: object({}),
  native_observe: object({ displayId: chars(128) }, ['displayId']),
  native_focus: object({ bundleId: text(300) }),
  native_act: object({ action: nativeAction }),
  browser_snapshot: object({}),
  browser_open: object({ url: { ...text(8192), httpUrl: true } }),
  browser_click: object({ selector: text(4096), observationId: observed }),
  browser_fill: object({ selector: text(4096), text: text(32000, true), observationId: observed }),
  browser_scroll: object({ x: scroll, y: scroll, observationId: observed }),
  browser_key: object({ key: text(80), observationId: observed }),
  browser_type: object({ text: text(32000, true), observationId: observed }),
}
export const AGENT_PROTOCOL_TOOLS = Object.freeze(Object.keys(argumentFields))
function valid(field: Field, value: unknown): boolean {
  if (field.anyOf) return field.anyOf.some(variant => valid(variant, value))
  if (field.enum && !field.enum.includes(value as string | number)) return false
  if (field.type === 'object') {
    if (!record(value) || !field.properties || !field.required?.every(key => Object.hasOwn(value, key))) return false
    return Object.entries(value).every(([key, item]) => Object.hasOwn(field.properties!, key) && valid(field.properties![key], item))
  }
  if (field.type === 'number' || field.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (field.type !== 'integer' || Number.isSafeInteger(value))
    && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum)
  if (typeof value !== 'string' || value.includes('\0') || field.nonempty && !value.trim()
    || field.maxLength !== undefined && value.length > field.maxLength
    || field.maxBytes !== undefined && new TextEncoder().encode(value).byteLength > field.maxBytes) return false
  if (field.httpUrl) {
    // Match the existing browser adapter's accepted explicit/bare HTTP(S) URL
    // shape, without rewriting the planner's value or navigating anywhere.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return false
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return false
    } catch { return false }
  }
  return true
}
export function validAgentProtocolArguments(tool: string, args: unknown): boolean {
  return Object.hasOwn(argumentFields, tool) && valid(argumentFields[tool], args)
}
/** Gemini documents nested anyOf + object properties/required/enum. Avoid open
 * args objects: each action carries its real fields. Numeric/string byte bounds
 * stay in application validation, avoiding unsupported string constraints and
 * excessive decoder branching. A backend may still reject this schema; the
 * bounded compatibility fallback retains the same application validation.
 * https://ai.google.dev/gemini-api/docs/structured-output
 */
function generationSchema(field: Field): Record<string, unknown> {
  if (field.anyOf) return { anyOf: field.anyOf.map(generationSchema) }
  if (field.type === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(field.properties!).map(([key, value]) => [key, generationSchema(value)])), required: field.required, additionalProperties: false }
  return { type: field.type, ...(field.enum ? { enum: field.enum } : {}) }
}
export function agentProtocolActionSchema(): Record<string, unknown> {
  return { anyOf: Object.entries(argumentFields).map(([tool, args]) => generationSchema(object({ tool: literal(tool), args }))) }
}
