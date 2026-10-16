import { profileText } from './_profileText'

export function shouldLearnProfile(message: string): boolean {
  if (!message.trim() || message.length > 6000) return false
  // Writing in the first person for a character/client is not autobiography.
  if (/\b(?:write|draft|compose|translate|rewrite|roleplay|pretend|fictional|character|example|sample)\b/i.test(message) && !/\bremember (?:that )?(?:I |my )/i.test(message)) return false
  return /\b(?:my name|I am|I'm|I live|I work|I prefer|I like|I hate|my (?:company|business|wife|husband|partner|son|daughter|dog|cat)|call me|remember|no longer|forget|stop remembering)\b/i.test(message)
}

export const PROFILE_LEARNING = `Maintain durable memory about the user, not task instructions or facts about other people. Return ONLY JSON {"changes":[{"quote":"exact contiguous text from the NEW USER MESSAGE","replaces":["exact old profile line, if explicitly corrected or forgotten"],"forget":false}]} or {"changes":[]}.
Use at most four short, self-contained quotes stating enduring personal facts or preferences. Never infer facts, complete names, or combine separate statements. Do not save creative-writing dialogue, a quoted email, examples, hypothetical details, third-party biographies, transient deadlines, secrets, passwords, or an assistant's claim. Preserve all unrelated existing facts. A correction replaces ONLY the contradicted old lines. An explicit forgetting request uses forget:true and replaces exactly the corresponding old lines; save no new quote for that request. Do not use forgetting to summarize away old facts.`

/** Memory stores actual user words, not an unconstrained model-written biography. */
export function applyProfileLearning(previous: string, message: string, output: string): string | null {
  if (!shouldLearnProfile(message)) return null
  let value: any
  try { value = JSON.parse(output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()) } catch { return null }
  if (!Array.isArray(value?.changes)) return null
  const original = profileText(previous)
  let lines = original.split('\n').filter(Boolean)
  for (const change of value.changes.slice(0, 4)) {
    const quote = typeof change?.quote === 'string' ? change.quote.trim() : ''
    if (quote.length < 5 || quote.length > 350 || !message.includes(quote) || /[\r\n]/.test(quote)) continue
    if (/\b(?:password|passcode|api.?key|secret|access token|private key)\b/i.test(quote)) continue
    const canonical = (line: string) => line.trim().replace(/^[-*•]\s*/, '').replace(/^User said:\s*/, '')
    const replacements = Array.isArray(change.replaces) ? change.replaces.filter((line: unknown): line is string => typeof line === 'string') : []
    const replaces = lines.filter(line => replacements.some((candidate: string) => canonical(line) === canonical(candidate)))
    if (change.forget === true && !/\b(?:forget|delete|remove|stop remembering|do not remember|don't remember)\b/i.test(quote)) continue
    const next = lines.filter(line => !replaces.includes(line))
    if (change.forget !== true) {
      const addition = `- User said: ${quote}`
      if (!next.some(line => line.includes(quote))) next.push(addition)
    }
    // Full memory does not silently evict older facts to fit a new one.
    if (next.join('\n').length <= 2000 && next.length <= 25) lines = next
  }
  const result = lines.join('\n')
  return result !== original ? result : null
}
