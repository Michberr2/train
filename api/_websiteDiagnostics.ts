const stages = new Set(['plan', 'plan-runtime', 'edit', 'build', 'continue', 'review', 'script-repair', 'repair'])
const categories = new Set(['timeout', 'rate_limit', 'quota', 'input_limit', 'provider_http', 'empty_response', 'unavailable'])
const results = new Set(['valid', 'invalid-json', 'invalid-design', 'invalid-journeys', 'provider-error'])
const providers = new Set(['primary', 'fallback', 'emergency', 'other'])
const finishes = new Set(['stop', 'length', 'other'])

/** Operational facts only. Never serialize an error, prompt, plan, generated
 * issue text, provider body, headers, stack or nested cause into runtime logs. */
export function websiteDiagnostic(stage: string, value: unknown): Record<string, string | number> {
  const record: Record<string, string | number> = { stage: stages.has(stage) ? stage : 'other' }
  const event = value && typeof value === 'object' ? value as Record<string, any> : {}
  if (stage === 'plan-runtime') {
    for (const [key, allowed] of [['result', results], ['provider', providers], ['finishReason', finishes], ['failureCategory', categories]] as const) {
      if (allowed.has(event[key])) record[key] = event[key]
    }
    for (const [key, max] of [['attempt', 2], ['elapsedMs', 300000], ['contentChars', 1000000]] as const) {
      if (Number.isInteger(event[key]) && event[key] >= 0 && event[key] <= max) record[key] = event[key]
    }
    if (Array.isArray(event.issues)) record.issueCount = Math.min(event.issues.length, 12)
  } else {
    const failure = event.completionFailure
    record.category = categories.has(failure?.category) ? failure.category : ['review', 'script-repair'].includes(stage) ? 'validation' : 'unknown'
    if (Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599) record.status = failure.status
    if (finishes.has(failure?.finishReason)) record.finishReason = failure.finishReason
  }
  return record
}

export function logWebsiteDiagnostic(stage: string, value: unknown): void {
  try { console.info('nalu-studio ' + JSON.stringify(websiteDiagnostic(stage, value))) } catch { /* observability must not interrupt generation */ }
}
