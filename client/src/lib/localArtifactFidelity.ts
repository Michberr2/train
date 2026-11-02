import { unsupportedMemoCommitments } from '../../../shared/memoCommitments'

export type ArtifactIssue = { quote: string; reason: string }
export const ARTIFACT_AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['assessment', 'issues', 'passed'],
  // A bounded assessment precedes the verdict so constrained decoding does
  // not force the reviewer to choose a boolean before checking the draft.
  properties: { assessment: { type: 'string' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote', 'reason'], properties: { quote: { type: 'string' }, reason: { type: 'string' } } } }, passed: { type: 'boolean' } },
}
export function artifactText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(artifactText).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(artifactText).join('\n')
  return ''
}
export function artifactFidelityIssues(input: Record<string, unknown>, artifact: Record<string, unknown>): ArtifactIssue[] {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '', content = artifactText(artifact)
  const sources = ['material', 'context', 'prevDoc', 'prevEmail', 'prevSlides'].map(key => artifactText(input[key])).filter(Boolean)
  const issues: ArtifactIssue[] = unsupportedMemoCommitments(content, prompt, sources).map(finding => ({ quote: finding.text, reason: 'This commitment was not supplied in the brief or source material.' }))
  if (typeof artifact.to === 'string' && typeof artifact.subject === 'string' && typeof artifact.body === 'string' && artifact.to) {
    const supplied = new Set((artifactText(input).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(address => address.toLowerCase()))
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(artifact.to) || !supplied.has(artifact.to.toLowerCase())) issues.push({ quote: artifact.to, reason: 'The recipient must be an exact supplied email address, or empty when none was supplied. Never invent a destination.' })
  }
  if (/\bNalu\b/i.test(content) && !/\bNalu\b/i.test([prompt, ...sources].join('\n'))) issues.push({ quote: content.match(/[^\n]*\bNalu\b[^\n]*/i)![0], reason: 'Assistant branding or a signature was added without being supplied or requested. Use the supplied sender, [Your name], or omit the signature.' })
  const forbidsNextSteps = /\b(?:do not|don['’]?t|no|without|avoid|exclude|never)\b[^.!?]{0,80}\b(?:next steps?|follow[- ]?up|calls? to action|future commitments?)\b/i.test(prompt)
  if (forbidsNextSteps) for (const sentence of content.match(/[^.!?\n]+[.!?]?/g) || []) {
    if (/\b(?:look(?:ing)? forward|please let (?:me|us) know|let['’]?s|next steps?|next meeting|future projects?|continu(?:e|ing) our|in the future|moving forward|going forward)\b/i.test(sentence)) issues.push({ quote: sentence.trim(), reason: 'The user explicitly ruled out invented next steps, follow-up, or calls to action.' })
  }
  if (!/\b(?:title|subtitle)\b/i.test(prompt)) for (const key of ['title', 'subtitle']) {
    const value = artifact[key]
    if (typeof value === 'string' && /^(?:do not|don['’]?t|please|ensure|make sure|only return|avoid)\b/i.test(value) && prompt.toLowerCase().includes(value.toLowerCase().replace(/[.!?]$/, ''))) issues.push({ quote: value, reason: 'This is a user instruction copied into the artifact, rather than artifact content.' })
  }
  return issues
}
export function checkedAudit(value: Record<string, unknown>, artifact: Record<string, unknown>): ArtifactIssue[] {
  const issues = value.issues as ArtifactIssue[], content = artifactText(artifact)
  if (value.passed !== (issues.length === 0) || issues.some(issue => !content.includes(issue.quote))) throw new Error('The local review was inconsistent. Your previous work has been kept; please retry.')
  return issues
}
