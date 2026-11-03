/** Read only the top-level display string from an unfinished action envelope.
 * Actions remain opaque until the complete envelope passes normal validation. */
export function streamingLocalMessage(source: string): string {
  let offset = 0
  const whitespace = () => { while (/\s/.test(source[offset] || '') && offset < source.length) offset++ }
  const string = (partial: boolean): { value: string; end: number } | null => {
    const start = offset
    if (source[offset++] !== '"') return null
    let safe = offset
    while (offset < source.length) {
      const char = source[offset++]
      if (char === '"') {
        try { return { value: JSON.parse(source.slice(start, offset)), end: offset } } catch { return null }
      }
      if (char === '\\') {
        const escape = source[offset++]
        if (!escape) break
        if (escape === 'u') {
          const digits = source.slice(offset, offset + 4)
          if (digits.length < 4 || !/^[0-9a-f]{4}$/i.test(digits)) break
          offset += 4
        } else if (!'"\\/bfnrt'.includes(escape)) return null
      } else if (char.charCodeAt(0) < 32) return null
      safe = offset
    }
    if (!partial) return null
    try {
      let value: string = JSON.parse(source.slice(start, safe) + '"')
      // Hold an unfinished surrogate pair rather than publishing replacement
      // characters when an escaped emoji spans two generated tokens.
      const last = value.charCodeAt(value.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1)
      return { value, end: safe }
    } catch { return null }
  }
  whitespace()
  if (source[offset++] !== '{') return ''
  while (offset < source.length) {
    whitespace(); const key = string(false)
    if (!key) return ''
    whitespace(); if (source[offset++] !== ':') return ''
    whitespace()
    if (key.value === 'message') return string(true)?.value || ''
    let depth = 0, quoted = false, escaped = false
    while (offset < source.length) {
      const char = source[offset]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false }
      else if (char === '"') quoted = true
      else if (char === '[' || char === '{') depth++
      else if (char === ']' || char === '}') { if (!depth) return ''; depth-- }
      else if (char === ',' && !depth) { offset++; break }
      offset++
    }
  }
  return ''
}
