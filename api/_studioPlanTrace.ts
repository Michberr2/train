import { createHash, randomUUID } from 'node:crypto'
import type { WebsitePlanningAttempt } from './_websiteRuntime'

export type WebsitePlanTrace = (raw: string, metadata: Pick<WebsitePlanningAttempt, 'attempt' | 'provider' | 'finishReason'>) => void

/** Private diagnostic for one operator-approved synthetic prompt. It cannot
 * be enabled by request data, and refuses any account or extra design context.
 * Raw text is never attached to a response, artifact, database or public URL. */
export function createStudioPlanTrace(req: any, body: Record<string, unknown>, context: { prompt: string; identity: unknown; hasResearch: boolean }): WebsitePlanTrace | undefined {
  const expectedHash = process.env.NALU_STUDIO_PLAN_TRACE_SHA256 || ''
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || context.identity || context.hasResearch || req.user || req.auth) return
  if (Object.keys(req.headers || {}).some(key => ['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase()))) return
  if (body.kind !== 'webpage' || body.prompt !== context.prompt || Object.keys(body).length !== 2 || !Object.keys(body).every(key => key === 'kind' || key === 'prompt')) return
  if (createHash('sha256').update(context.prompt).digest('hex') !== expectedHash) return
  const traceId = randomUUID()
  return (raw, metadata) => {
    // Keep individual Vercel log events small and bounded. JSON encoding makes
    // quotes, newlines and control characters data, not log framing/instructions.
    const captured = raw.slice(0, 64000)
    const parts = Math.max(1, Math.ceil(captured.length / 1600))
    for (let part = 0; part < parts; part++) console.info('nalu-studio-plan-trace ' + JSON.stringify({ traceId, ...metadata, part: part + 1, parts, contentChars: raw.length, truncated: captured.length !== raw.length, raw: captured.slice(part * 1600, (part + 1) * 1600) }))
  }
}
