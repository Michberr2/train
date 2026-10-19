export interface WordContract {
  kind: 'range' | 'target' | 'maximum' | 'minimum'
  min: number
  max: number | null
  target: number
}

/** A prompt hint, not an output validator. Only recognize a single explicit
 * whole-response instruction in the latest user message. Quoted examples,
 * document contents, per-section budgets and ambiguous instructions stay with
 * the model; they must not become a new server-authored global word limit. */
export function explicitWordContract(userText: string): WordContract | null {
  if (userText.length > 50000) return null
  let fence: { mark: string; length: number } | null = null
  const unquotedLines = userText.split(/\r?\n/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) {
      if (!fence) fence = { mark: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.mark && marker[1].length >= fence.length) fence = null
      return ''
    }
    return fence ? '' : line
  })
  const text = unquotedLines.join('\n')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
    .replace(/(^|[\s(])'[^'\n]*'(?=$|[\s).,!?:;])/g, '$1 ')
  // Imported text may contain an imperative of its own. Do not infer a global
  // budget when the request is to inspect a document/prompt or multi-part data.
  if (/\b(?:attached|attachment|transcript|uploaded|quoted|sample prompt|following prompt|example prompt)\b|<\/?(?:document|attachment|source|data)\b|^\s*(?:source|document|example|data|record)\s*:/im.test(text)) return null
  if (/\b(?:analy[sz]e|review|evaluate|critique|debug|rewrite)\s+(?:(?:this|the|following)\s+)?(?:prompt|instruction|document|example)\b|\b(?:note|document|source|record|example|prompt)\s+(?:says|reads|contains)\s*:/i.test(text)) return null
  const count = '(?:\\d{1,3}(?:,\\d{3}){1,2}|\\d{1,5})'
  const wordCounts = [...text.matchAll(new RegExp(`\\b(${count})(?:\\s*(?:-to-|[-–—]|to)\\s*(${count}))?\\s*[-–—]?\\s*words?\\b`, 'gi'))]
  if (wordCounts.length !== 1) return null
  const match = wordCounts[0]
  const index = match.index || 0
  const before = text.slice(0, index)
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'), before.lastIndexOf(';'))
  const prefix = before.slice(boundary + 1).trim()
  const suffix = text.slice(index + match[0].length).split(/[.!?\n;]/, 1)[0]
  if (prefix.length > 140 || /\b(?:each|per|section|paragraph|introduction|conclusion|abstract|caption|title|heading|quote|example|prompt)\b/i.test(prefix + ' ' + suffix)) return null
  const imperative = /^(?:please\s+)?(?:write|draft|give|provide|produce|compose|return|answer|respond|explain|compare|describe|summari[sz]e|keep|use|limit)\b/i
  const globalLimit = /^(?:(?:total|overall)\s+)?(?:answer|response|output|word)\s+(?:length|count|limit|budget)\s*:?\s*$/i
  if (!imperative.test(prefix) && !globalLimit.test(prefix) && !/^(?:please\s+)?in(?:\s+exactly)?$/i.test(prefix)) return null
  const qualifier = '(?:(?:exactly|approximately|around|roughly|at most|no more than|up to|within|maximum(?: of)?|under|fewer than|less than|at least|no fewer than|minimum(?: of)?)\\s*)?'
  const artifact = '(?:answer|response|output|explanation|analysis|report|essay|memo|summary|email|letter|proposal|poem|speech|story|review|plan)'
  const direct = new RegExp(`^(?:please\\s+)?(?:(?:write|draft|give|provide|produce|compose|return)\\s+(?:(?:a|an|the)\\s+)?(?:(?:short|brief|detailed|thorough|practical|concise|complete|professional|technical|comprehensive|useful|polished|clear)\\s+)*|(?:answer|respond)\\s+(?:in|using)\\s+|use\\s+|in\\s+)${qualifier}$`, 'i')
  const wholeAnswer = new RegExp(`\\b${artifact}\\s+(?:(?:of|in|using|to|between)\\s+)?${qualifier}$`, 'i')
  const instructionPrefix = prefix + ' '
  if (!direct.test(instructionPrefix) && !wholeAnswer.test(instructionPrefix) && !globalLimit.test(prefix)) return null
  const first = Number(match[1].replace(/,/g, ''))
  const second = match[2] ? Number(match[2].replace(/,/g, '')) : null
  // Do not silently clamp an unrealistic user request into a different one.
  if (!Number.isSafeInteger(first) || first < 1 || first > 20000 || (second !== null && (second < first || second > 20000))) return null
  if (second !== null) return { kind: 'range', min: first, max: second, target: Math.floor((first + second) / 2) }
  if (/\b(?:under|fewer than|less than)\s*$/i.test(prefix)) {
    if (first < 2) return null
    return { kind: 'maximum', min: 0, max: first - 1, target: Math.max(1, Math.floor((first - 1) * 0.9)) }
  }
  if (/\b(?:at most|no more than|up to|within|maximum(?: of)?)\s*$/i.test(prefix)) return { kind: 'maximum', min: 0, max: first, target: Math.max(1, Math.floor(first * 0.9)) }
  if (/\b(?:at least|no fewer than|minimum(?: of)?)\s*$/i.test(prefix)) return { kind: 'minimum', min: first, max: null, target: Math.ceil(first * 1.1) }
  return { kind: 'target', min: first, max: first, target: first }
}

export function wordContractPrompt(contract: WordContract | null): string {
  if (!contract) return ''
  const requirement = contract.kind === 'range' ? `${contract.min}–${contract.max} words in total`
    : contract.kind === 'maximum' ? `at most ${contract.max} words in total`
      : contract.kind === 'minimum' ? `at least ${contract.min} words in total` : `${contract.target} words in total`
  return `\n\nEXPLICIT ANSWER LENGTH: The user requested ${requirement}. Plan the delivered answer around ${contract.target} words, then check it against the requested length before finishing. Count the whole delivered answer, including headings, lists, tables and code, unless the user specifies a different counting rule. Allocate that budget across all requested parts; use concrete explanation and evidence rather than repetition or filler. Do not stop at a short overview when the requested budget calls for a developed answer. Do not exceed a maximum to add optional context, sources or a closing summary. Reasoning effort does not change this length requirement; internal reasoning is not part of the delivered answer. This budget applies to the final answer to the original task, not internal review notes or tool calls. The user's explicit output format and any more specific counting instructions still apply.`
}
