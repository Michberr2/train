// Document formatting has semantics that do not apply to decks: the client
// renders title metadata separately, and a correspondence byline asserts an
// identity. Keep this contract local to the document pipeline.
export const DOC_FIDELITY = `

DOCUMENT TITLE AND CORRESPONDENCE HEADERS:
- The app renders the document's title metadata above its body. Do not repeat it as an opening heading block or add a title-only outline chapter. Preserve a same-named section or repeated title when the user explicitly requests it, and preserve existing title/header content in an unrelated revision.
- In section mode, start with the supplied chapter heading; do not prepend the overall work's title. A supplied chapter heading remains valid even if it equals the work's title.
- Do not invent a sender, author, department, office, or signatory to complete a memo/letter template. If these identities are not supplied, omit the corresponding header/sign-off or use an explicit bracketed placeholder when a template needs that field. Do not refer to an invented sender elsewhere in the body. Preserve supplied sender/header wording; the signed-in profile alone is not permission to assign authorship unless the user asks to write from them.
- Memo/letter next steps should recommend actions, not announce unsupplied services or follow-up. Passive promises that guidance, resources, templates, training or support "will be" shared/provided/sent/arranged still assert an organizational commitment, including "as needed" or "if needed". Use recommendation/imperative wording for unsupplied actions; retain actual supplied commitments, dates and plans without inventing additions.`

type Block = { type?: unknown; text?: unknown; [key: string]: unknown }
type Options = {
  title?: string
  prompt: string
  sources?: string[]
  previousBlocks?: unknown[]
  sectionHeading?: string
}

const canonical = (value: unknown): string => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US') : ''
const headingText = (block: unknown): string => {
  const b = block as Block | null
  return b?.type === 'heading' && typeof b.text === 'string' ? canonical(b.text) : ''
}

const negatedBefore = (prompt: string, index: number): boolean =>
  /\b(?:not|never|no|avoid|without)\b/i.test(prompt.slice(Math.max(0, index - 30), index).split(/[.!?\n]/).pop() || '')
const positiveRequest = (prompt: string, pattern: RegExp): boolean =>
  [...prompt.matchAll(pattern)].some((match) => !negatedBefore(prompt, match.index!))

function requestedTitleHeading(prompt: string, title: string): boolean {
  // Only explicit repetition or section instructions grant an exception. The
  // ordinary `title "X" and sections "A", "B"` pattern does not.
  if (positiveRequest(prompt, /\b(?:repeat|retain|keep|include|show|print)\b[^.!?\n]{0,65}\btitle\b[^.!?\n]{0,45}\b(?:again|body|heading|twice)\b/gi)) return true
  if (positiveRequest(prompt, /\b(?:repeat|duplicate)\b[^.!?\n]{0,30}\btitle\b/gi)) return true
  if (positiveRequest(prompt, /\b(?:section|chapter|heading)\b[^.!?\n]{0,40}\b(?:same as|equal to|matching|matches)\b[^.!?\n]{0,25}\btitle\b/gi)) return true
  return [...prompt.matchAll(/\b(?:sections?|chapters?|headings?)\b([^.!?\n]*)/gi)]
    .some((match) => canonical(match[1]).includes(title) && !negatedBefore(prompt, match.index!))
}

const identityHeader = /^(?:from|sender|author|prepared by|written by)\s*:\s*(.*)$/i
const anyHeader = /^(?:to|from|sender|author|prepared by|written by|date|subject|re|cc|bcc)\s*:/i

function supportedIdentity(value: string, sources: string[]): boolean {
  const normalized = canonical(value)
  if (!normalized || /^\[[^\]]+\]$/.test(normalized)) return true
  // Preserve names with supplied role/email components, e.g. "Alex Chen,
  // Operations" when the request says "Alex Chen from Operations". Avoid
  // treating a partial first-name match as evidence for an invented full name.
  const parts = value.split(/[,;<>\n]+/).map(canonical).filter(Boolean)
  return parts.length > 0 && parts.every((part) => /^\[[^\]]+\]$/.test(part) || sources.some((source) => {
    let offset = source.indexOf(part)
    while (offset >= 0) {
      const before = source[offset - 1] || ''
      const after = source[offset + part.length] || ''
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true
      offset = source.indexOf(part, offset + 1)
    }
    return false
  }))
}

/** Normalize only a redundant opening title and an actual header preamble.
 * Never delete arbitrary prose, subsequent headings, or outline chapters. */
export function normalizeDocumentBlocks(input: unknown[], options: Options): unknown[] {
  let blocks = input.slice()
  const title = canonical(options.title || '')
  const intentionalTitle = options.sectionHeading !== undefined && canonical(options.sectionHeading) === title
    || (options.previousBlocks || []).some((block) => headingText(block) === title)
    || requestedTitleHeading(options.prompt, title)
  if (title && !intentionalTitle && blocks.length > 1 && headingText(blocks[0]) === title) blocks = blocks.slice(1)

  const sources = [options.prompt, ...(options.sources || [])].map(canonical)
  const inventedIdentityRequested = positiveRequest(options.prompt, /\b(?:invent|make up|made-up|fictional)\b[^.!?\n]{0,55}\b(?:sender|author|signatory|identity|name)\b/gi)
  let preamble = true
  return blocks.flatMap((block) => {
    if (!preamble || !block || typeof block !== 'object') return [block]
    const b = block as Block
    // In section mode a chapter heading precedes any legitimate memo header.
    // An intentionally retained document-title heading may precede it too.
    if (b.type === 'heading' && (headingText(b) === title || headingText(b) === canonical(options.sectionHeading || ''))) return [block]
    if (b.type !== 'paragraph' || typeof b.text !== 'string') { preamble = false; return [block] }
    const lines = b.text.split(/\r?\n/)
    const nonempty = lines.filter((line) => line.trim())
    // A prose paragraph that happens to contain "From:" is not a header.
    if (!nonempty.length || !nonempty.every((line) => anyHeader.test(line.trim()))) { preamble = false; return [block] }
    const correspondence = /\b(?:memo|memorandum|letter|email|correspondence)\b/i.test(options.prompt)
      || nonempty.some((line) => /^(?:to|date|subject|re|cc|bcc)\s*:/i.test(line.trim()))
    if (!correspondence && nonempty.some((line) => /^from\s*:/i.test(line.trim()))) { preamble = false; return [block] }
    const retained = lines.filter((line) => {
      const identity = line.trim().match(identityHeader)
      return !identity || inventedIdentityRequested || supportedIdentity(identity[1], sources)
    })
    return retained.some((line) => line.trim()) ? [{ ...b, text: retained.join('\n') }] : []
  })
}
