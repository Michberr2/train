import { createHash, randomUUID } from 'node:crypto'
import type { WebsitePlanningAttempt } from './_websiteRuntime'

export type WebsitePlanTrace = (raw: string, metadata: Pick<WebsitePlanningAttempt, 'attempt' | 'provider' | 'finishReason'>) => void
type TraceStatus = 'enabled' | 'env-missing' | 'env-invalid' | 'env-mismatch' | 'denied-auth-context' | 'denied-extra-input' | 'denied-research'
// Temporary candidate diagnostic: the exact public synthetic live-test prompt.
// This digest enables only a fixed status marker, never raw completion logging.
const SYNTHETIC_PROMPT_SHA256 = 'dd4d0d989a6cf360e3c53f1c5212c0e3e395f075278d4b824c0eb6c577a8e1ed'

/** Private diagnostic for one operator-approved synthetic prompt. It cannot
 * be enabled by request data, and refuses any account or extra design context.
 * Raw text is never attached to a response, artifact, database or public URL. */
export function createStudioPlanTrace(req: any, body: Record<string, unknown>, context: { prompt: string; identity: unknown; hasResearch: boolean; onStatus?: (status: TraceStatus) => void }): WebsitePlanTrace | undefined {
  const expectedHash = process.env.NALU_STUDIO_PLAN_TRACE_SHA256 || ''
  const promptHash = createHash('sha256').update(context.prompt).digest('hex')
  let status: TraceStatus = 'enabled'
  if (!expectedHash) status = 'env-missing'
  else if (!/^[a-f0-9]{64}$/.test(expectedHash)) status = 'env-invalid'
  else if (promptHash !== expectedHash) status = 'env-mismatch'
  else if (context.identity || req.user || req.auth || Object.keys(req.headers || {}).some(key => ['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase()))) status = 'denied-auth-context'
  else if (body.kind !== 'webpage' || body.prompt !== context.prompt || Object.keys(body).length !== 2 || !Object.keys(body).every(key => key === 'kind' || key === 'prompt')) status = 'denied-extra-input'
  else if (context.hasResearch) status = 'denied-research'
  if (promptHash === SYNTHETIC_PROMPT_SHA256 && body.prompt === context.prompt) {
    // A missing runtime env must itself be observable. Only this fixed enum is
    // emitted without the env opt-in; never headers, context or generated text.
    try { console.info('nalu-studio-plan-trace-gate ' + JSON.stringify({ status })) } catch { /* diagnostics cannot fail generation */ }
    // Response metadata still requires the exact synthetic env opt-in. It lets
    // the operator distinguish an enabled gate from a broken log subscription.
    if (expectedHash === SYNTHETIC_PROMPT_SHA256) { try { context.onStatus?.(status) } catch { /* diagnostics cannot fail generation */ } }
  }
  if (status !== 'enabled') return
  const traceId = randomUUID()
  return (raw, metadata) => {
    // Keep individual Vercel log events small and bounded. JSON encoding makes
    // quotes, newlines and control characters data, not log framing/instructions.
    const captured = raw.slice(0, 64000)
    const parts = Math.max(1, Math.ceil(captured.length / 1600))
    for (let part = 0; part < parts; part++) console.info('nalu-studio-plan-trace ' + JSON.stringify({ traceId, ...metadata, part: part + 1, parts, contentChars: raw.length, truncated: captured.length !== raw.length, raw: captured.slice(part * 1600, (part + 1) * 1600) }))
  }
}
