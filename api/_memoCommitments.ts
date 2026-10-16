// A narrow operational-commitment check for correspondence. This does not try
// to prove arbitrary facts or turn every future-tense benefit into a promise.
const ACTIONS: Record<string, string> = {
  schedule: 'schedul(?:e|es|ed|ing)|arrang(?:e|es|ed|ing)|hold|holds|held|holding',
  deliver: 'deliver(?:s|ed|ing)?',
  implement: 'implement(?:s|ed|ing)?',
  launch: 'launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)',
  complete: 'complet(?:e|es|ed|ing)',
  adopt: 'adopt(?:s|ed|ing)?',
  meet: 'meet|meets|met|meeting',
  start: 'begin|begins|beginning|start(?:s|ed|ing)?|take\\s+place',
  require: 'requir(?:e|es|ed|ing)',
  share: 'shar(?:e|es|ed|ing)|circulat(?:e|es|ed|ing)|distribut(?:e|es|ed|ing)',
  provide: 'provid(?:e|es|ed|ing)|suppl(?:y|ies|ied|ying)|offer(?:s|ed|ing)?|made?\\s+available|mak(?:e|es|ing)\\s+available|available',
  send: 'send|sends|sending|sent',
  publish: 'publish(?:es|ed|ing)?|issu(?:e|es|ed|ing)',
  announce: 'announc(?:e|es|ed|ing)|communicat(?:e|es|ed|ing)',
  prepare: 'prepar(?:e|es|ed|ing)',
  assign: 'assign(?:s|ed|ing)?',
  contact: 'contact(?:s|ed|ing)?|follow(?:s|ed|ing)?\\s+up',
}
const actionPattern = Object.values(ACTIONS).join('|')
const adverbs = '(?:(?:[a-z]+ly|also|then|soon|still|already|now)\\s+)*'
const future = new RegExp(`\\b(?:will|shall)\\s+${adverbs}(?:(?:be|have been)\\s+${adverbs})?(${actionPattern})\\b`, 'gi')
const declared = /\b(?:is|are|has been|have been)\s+(?:already\s+)?(scheduled|due|planned|set to|required|effective)\b|\b(takes? effect|the deadline is)\b/gi
const canonical = (text: string): string => text.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\b([a-z]+)'ll\b/gi, '$1 will').replace(/\s+/g, ' ').trim().toLowerCase()
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+|;\s*/).map((s) => s.trim()).filter(Boolean)

export type MemoCommitment = { text: string; action: string }

function isHypothetical(text: string, predicateIndex: number): boolean {
  const before = text.slice(0, predicateIndex)
  if (/^(?:consider\b|you could\b|you may\b|for example\b|suppose\b|imagine\b|proposal:|proposed:)/i.test(text)) return true
  if (/\b(?:do not|don't|never|avoid)\s+(?:say(?:ing)?|claim(?:ing)?|writ(?:e|ing)|assert(?:ing)?|promis(?:e|ing)|stat(?:e|ing))\b/i.test(before)) return true
  if (/^no\b(?! later than\b)/i.test(text)) return true
  // An event in an IF clause is not asserted. A promise in its consequence is:
  // "If a meeting will be held, prepare" vs "If needed, a meeting will be held".
  return /^(?:if|unless|whether)\b/i.test(text) && !before.includes(',')
}

export function memoCommitments(text: string): MemoCommitment[] {
  const findings: MemoCommitment[] = []
  for (const original of sentences(text)) {
    const sentence = canonical(original).replace(/^[-*]\s+/, '')
    for (const match of sentence.matchAll(future)) {
      if (isHypothetical(sentence, match.index!)) continue
      const action = Object.entries(ACTIONS).find(([, forms]) => new RegExp(`^(?:${forms})$`, 'i').test(match[1]))?.[0]
      if (action) findings.push({ text: original, action })
    }
    for (const match of sentence.matchAll(declared)) {
      if (isHypothetical(sentence, match.index!)) continue
      findings.push({ text: original, action: /due|effective|effect|deadline/.test(match[0]) ? 'deadline' : 'schedule' })
    }
  }
  return findings
}

const STOP_WORDS = new Set('a an the to of for from by with on in at as and or that this these those is are be been will shall has have it its we our us they their them you your please memo memorandum letter email write draft state announce include preserve use said says says otherwise'.split(' '))
function anchors(text: string, action: string): Set<string> {
  const forms = ACTIONS[action]
  let normalized = canonical(text)
  if (forms) normalized = normalized.replace(new RegExp(`\\b(?:${forms})\\b`, 'gi'), ' ')
  return new Set((normalized.match(/[\p{L}\p{N}]+/gu) || []).filter((word) => !STOP_WORDS.has(word) && !/ly$/.test(word)).map((word) => word.length > 4 ? word.replace(/s$/, '') : word))
}

export function unsupportedMemoCommitments(text: string, prompt: string, sources: string[] = []): MemoCommitment[] {
  if (!/\b(?:memos?|memorand(?:um|a)|letters?|emails?)\b/i.test(prompt)) return []
  const fiction = [...prompt.matchAll(/\b(?:fictional|fictitious|imaginary|made-up|role-play)\b/gi)].some((match) => {
    const before = prompt.slice(Math.max(0, match.index! - 30), match.index).split(/[.!?\n]/).pop() || ''
    return !/\b(?:not|never|no|avoid|without)\b/i.test(before)
  })
  if (fiction) return []
  const supplied = [prompt, ...sources]
  const commitments = supplied.flatMap(memoCommitments)
  for (const source of supplied) {
    // Explicit supplied plans can be written as a schedule/list rather than a
    // future-tense sentence. Preserve those facts without treating an ordinary
    // request for advice about planning as an existing organizational plan.
    if (!/\b(?:approved|agreed|confirmed)\s+(?:plan|schedule|deadline|action)s?\b|\b(?:plan|schedule|deadline)\s*:/i.test(source)) continue
    if (/\b(?:no|not|without)\s+(?:an?\s+)?(?:approved|agreed|confirmed)?\s*(?:plan|schedule|deadline)\b/i.test(source)) continue
    for (const [action, forms] of Object.entries(ACTIONS)) if (new RegExp(`\\b(?:${forms})\\b`, 'i').test(source)) commitments.push({ text: source, action })
    if (/\b(?:deadline|due|effective date)\b/i.test(source)) commitments.push({ text: source, action: 'deadline' })
  }
  return memoCommitments(text).filter((finding) => {
    const required = anchors(finding.text, finding.action)
    return !commitments.some((source) => {
      if (source.action !== finding.action) return false
      const available = anchors(source.text, source.action)
      // Allows voice changes with the same supplied actor/object/timing; adding
      // facts requires another attempt. When uncertain, retries request the
      // supplied wording rather than silently deleting or rewriting the prose.
      return [...required].every((word) => available.has(word))
    })
  })
}

/** Read prose/list/table/outline-brief content, leaving literal titles and
 * heading labels alone: a heading is not itself an asserted commitment. */
export function memoContentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(memoContentText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  const object = value as Record<string, unknown>
  if (object.type === 'heading') return ''
  return ['blocks', 'chapters', 'text', 'items', 'columns', 'rows', 'brief'].map((key) => memoContentText(object[key])).filter(Boolean).join('\n')
}

export const MEMO_COMMITMENT_RETRY = `

CONTENT CORRECTION: Your previous response introduced an operational commitment that was not supplied. In a memo or letter, saying materials, guidance, support or follow-up "will be" shared, provided, sent, published or arranged promises an organizational action, even without a named owner/date or when qualified by "as needed". Retain supplied commitments using their source wording. Write all other next steps as recommendations or imperatives; do not announce future services or actions. Return the entire valid JSON deliverable with its requested structure, without adding a disclaimer or deleting requested content.`
