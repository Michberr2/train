export const CHAT_ARTIFACT_FIELDS = ['doc', 'sheet', 'deck', 'design', 'cad', 'video', 'image', 'email', 'attachments', 'clarify']
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

export function mergeChatMessages(incoming: unknown, stored: unknown): RecordValue[] {
  const before = Array.isArray(stored) ? stored : []
  const after = Array.isArray(incoming) ? incoming : []
  const messages: RecordValue[] = []
  const compatible = (old: unknown, next: RecordValue): old is RecordValue =>
    record(old) && old.role === next.role && !(old.id != null && next.id != null && old.id !== next.id)
  const combine = (next: RecordValue, old?: unknown): RecordValue => {
    const oldRecord = record(old) ? old : {}
    const savedNewer = Number(oldRecord.updatedAt || 0) > Number(next.updatedAt || 0)
    const out = savedNewer && compatible(old, next) ? { ...next, ...oldRecord } : { ...next }
    if (!out.id && compatible(old, next) && old.id) out.id = old.id
    // Legacy clients have no edit clock. Never replace a full response with its
    // earlier streamed prefix merely because a stale tab saved later.
    if (!next.updatedAt && !oldRecord.updatedAt && compatible(old, next) && typeof next.content === 'string' && typeof old.content === 'string' && old.content.startsWith(next.content)) out.content = old.content
    if (compatible(old, next)) {
      for (const field of CHAT_ARTIFACT_FIELDS) if (out[field] == null && old[field] != null) out[field] = old[field]
      if ((out.content == null || out.content === '') && old.content) out.content = old.content
      if ((out.reasoning == null || out.reasoning === '') && old.reasoning != null) out.reasoning = old.reasoning
    }
    return out
  }
  // New clients identify turns. Concurrent devices may append different turns
  // at the same index; retain both instead of silently overwriting one.
  const identifiedStart = Math.min(...[before, after].map(list => {
    const index = list.findIndex(value => record(value) && typeof value.id === 'string')
    return index < 0 ? list.length : index
  }))
  const oldTail = before.slice(identifiedStart), newTail = after.slice(identifiedStart)
  if ((oldTail.length || newTail.length) && [...oldTail, ...newTail].every(value => record(value) && typeof value.id === 'string')) {
    for (let i = 0; i < identifiedStart; i++) {
      if (record(after[i])) messages.push(combine(after[i] as RecordValue, before[i]))
      else if (record(before[i])) messages.push({ ...before[i] as RecordValue })
    }
    const incomingById = new Map(newTail.map(value => [(value as RecordValue).id, value as RecordValue]))
    const seen = new Set<unknown>()
    for (const value of oldTail as RecordValue[]) {
      messages.push(combine(incomingById.get(value.id) || value, value)); seen.add(value.id)
    }
    for (const value of newTail as RecordValue[]) if (!seen.has(value.id)) { messages.push(combine(value)); seen.add(value.id) }
    return messages
  }
  if (before.some(value => !record(value)) || after.some(value => !record(value))) {
    // Malformed slots are not real messages. Align the surviving sequence before
    // compacting, keeping unmatched saved turns. Replaying the same malformed
    // snapshot then has the same result even after the stored copy is compact.
    const old = before.filter(record)
    let cursor = 0
    for (let slot = 0; slot < after.length; slot++) {
      const next = after[slot]
      if (!record(next)) continue
      const original = slot >= cursor && compatible(old[slot], next) ? slot : -1
      const exact = (value: RecordValue) => compatible(value, next) &&
        (next.id != null ? value.id === next.id : typeof next.content === 'string' && next.content.length > 0 && value.content === next.content)
      // Identity/content beats role alone: if an earlier whole turn is absent,
      // don't copy its generated artifact onto a later answer with the same role.
      let index = original >= 0 && exact(old[original]) ? original : -1
      if (index < 0) for (let i = cursor; i < old.length; i++) { if (exact(old[i])) { index = i; break } }
      if (index < 0) index = original
      if (index < 0) for (let i = cursor; i < old.length; i++) { if (compatible(old[i], next)) { index = i; break } }
      if (index < 0) { messages.push(combine(next)); continue }
      while (cursor < index) messages.push({ ...old[cursor++] })
      messages.push(combine(next, old[cursor++]))
    }
    while (cursor < old.length) messages.push({ ...old[cursor++] })
  } else {
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const old = before[i], next = after[i]
      if (!record(next)) { if (record(old)) messages.push({ ...old }); continue }
      messages.push(combine(next, old))
    }
  }
  return messages
}
