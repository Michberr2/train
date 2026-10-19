type ToolDelta = { index?: number; id?: string; name?: string; arguments?: string }
type ToolCall = { id: string; name: string; arguments: string }

// Validate the schema features used by the web, native, and CLI function tools.
// No coercion/defaults: the caller receives exactly the model's complete JSON.
function matchesSchema(value: unknown, schema: any, depth = 0): boolean {
  if (depth > 30 || schema === false) return false
  if (!schema || schema === true || typeof schema !== 'object') return true
  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) return false
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false
  if (Array.isArray(schema.allOf) && !schema.allOf.every((part: unknown) => matchesSchema(value, part, depth + 1))) return false
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part: unknown) => matchesSchema(value, part, depth + 1))) return false
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part: unknown) => matchesSchema(value, part, depth + 1)).length !== 1) return false
  const typeMatches = (type: string) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeMatches)) return false
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum || Number.isFinite(schema.maximum) && value > schema.maximum) return false
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength || Number.isFinite(schema.maxLength) && value.length > schema.maxLength) return false
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems || Number.isFinite(schema.maxItems) && value.length > schema.maxItems) return false
    if (schema.items && !value.every(item => matchesSchema(item, schema.items, depth + 1))) return false
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (Array.isArray(schema.required) && !schema.required.every((key: string) => Object.hasOwn(record, key))) return false
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(schema.properties || {}, key)) { if (!matchesSchema(item, schema.properties[key], depth + 1)) return false }
      else if (schema.additionalProperties === false || typeof schema.additionalProperties === 'object' && !matchesSchema(item, schema.additionalProperties, depth + 1)) return false
    }
  }
  return true
}

/** Buffer until ALL parallel calls are complete and valid. Invalid/partial calls
 * never leave the server as executable tool deltas. */
export function createToolCallBuffer(tools: unknown, choice: unknown) {
  const calls = new Map<number, ToolCall>()
  let invalid = false, bytes = 0
  const add = (delta: ToolDelta) => {
    if (invalid) return
    const index = delta.index
    if (!Number.isInteger(index) || index! < 0 || index! > 127) { invalid = true; return }
    const call = calls.get(index!) || { id: '', name: '', arguments: '' }
    for (const key of ['id', 'name', 'arguments'] as const) {
      const part = delta[key]
      if (part == null) continue
      if (typeof part !== 'string') { invalid = true; continue }
      if (key === 'id') {
        if (call.id && call.id !== part) invalid = true
        else call.id = part
      } else call[key] += part
      bytes += part.length
    }
    if (bytes > 1_000_000) { invalid = true; return }
    calls.set(index!, call)
  }
  const valid = (finishReason: string) => {
    if (invalid || !calls.size || finishReason !== 'tool_calls' || choice === 'none' || !Array.isArray(tools)) return false
    const specs = new Map(tools.map((tool: any) => [tool?.function?.name, tool?.function]))
    const ids = new Set<string>()
    const forcedName = choice && typeof choice === 'object' ? (choice as any).function?.name : undefined
    return [...calls.values()].every(call => {
      if (!call.id.trim() || ids.has(call.id) || !specs.has(call.name) || forcedName && call.name !== forcedName || !call.arguments.trim()) return false
      ids.add(call.id)
      try {
        const args = JSON.parse(call.arguments)
        return args !== null && typeof args === 'object' && !Array.isArray(args) && matchesSchema(args, specs.get(call.name)?.parameters)
      } catch { return false }
    })
  }
  const deltas = () => [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({ index, ...call }))
  return { add, valid, deltas }
}
