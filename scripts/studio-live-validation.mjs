// Offline diagnostics for a generic memo that supplies no organizational
// commitments. These are focused smoke checks, not a factual-grounding oracle.
// A planning horizon ("priorities for the coming week") is not a deadline.
import { memoCommitments } from '../api/_memoCommitments.ts'

export function memoCommitmentFindings(text) {
  const promisedActions = [...new Set(memoCommitments(String(text)).map((finding) => finding.text))]
  const relativeDeadlines = []
  const relative = /\b(?:by|within|due|no later than)\s+(?:next\s+\w+|(?:\d+|one|two|three|four|five|six|seven)\s+(?:hours?|days?|weeks?|months?))\b|\b(?:next|coming|following)\s+(?:week|month|quarter|year|reporting cycle|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi
  for (const sentence of promisedActions) {
    relativeDeadlines.push(...(sentence.match(relative) || []))
  }
  return { promisedActions, relativeDeadlines }
}
