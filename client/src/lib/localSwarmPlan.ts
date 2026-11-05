import { parseSwarmWorkPlan, SWARM_WORK_KINDS, type SwarmWorkPlan } from '../../../shared/swarmWorkPlan'
import { requestLocalChat } from './localAI'
import { readChatStream } from '../components/workspace/chatStream'

const string = { type: 'string' }
export const LOCAL_SWARM_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'projects', 'unhandledRequests'],
  // Plan supported outputs before listing any remaining unsupported requests.
  properties: { version: { type: 'integer', enum: [1] }, projects: {
    type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['key', 'title', 'brief', 'tasks'], properties: {
      key: string, title: string, brief: string, tasks: { type: 'array', maxItems: 24, items: { type: 'object', additionalProperties: false, required: ['key', 'instructions', 'kind'], properties: {
        key: string, instructions: string, kind: { type: 'string', enum: [...SWARM_WORK_KINDS] },
      } } },
    } },
  }, unhandledRequests: { type: 'array', description: 'Only actions the user actually asks us to do that are unavailable. Empty [] when all requested actions are supported. Never insert a prohibition or a placeholder such as no unsupported requests.', items: string } },
}

export function isLocalSwarmRequest(text: string): boolean {
  if (/^\s*(?:explain|what|why|how|define|cancel|never mind)\b/i.test(text)) return false
  const verbs = text.match(/\b(?:build|create|make|write|draft|generate|research|analy[sz]e)\b/gi) || []
  return verbs.length > 0 && (/\b(?:swarm|agents|parallel|background|simultaneously|at the same time)\b/i.test(text)
    || verbs.length > 1 && /\b(?:and|while|also|separately)\b/i.test(text)
    || /\band\s+(?:(?:a|an|the|my|our)\s+)?(?:document|report|website|logo|spreadsheet|deck|presentation)\b/i.test(text))
}

/** Stable across a retry, different for a changed request or its source files. */
export async function localDelegationKey(messageId: string, prompt: string, material = ''): Promise<string> {
  if (!/^[\w-]{1,60}$/.test(messageId)) throw Error('This conversation needs a valid saved request before delegating work.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([prompt, material])))
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)
  return `chat:${messageId}:${hash}`
}

/** Planning is local inference only. Persisting a validated plan is a separate,
 * idempotent account action; this function never starts work or calls tools. */
export async function planLocalSwarmWork(prompt: string, context: { role: string; content: string }[] = [], material = '', signal?: AbortSignal, onStage?: (message: string) => void): Promise<SwarmWorkPlan> {
  const owner = localStorage.getItem('nalu-token')
  onStage?.('Nalu is organizing the work for your agents.')
  const response = requestLocalChat({ localRole: 'reasoning', maxTokens: 4096, jsonSchema: LOCAL_SWARM_PLAN_SCHEMA,
    systemPrompt: `Organize the user's request into independent agent jobs. Return the complete delegation manifest, never a claim that any work has happened. Include EVERY requested final deliverable exactly once. Each task must independently produce one complete final output. Do not turn internal build steps into separate tasks: a website request is ONE website task, not separate structure, logo/assets, and compilation jobs. A document request is ONE document task, not separate outline, code example, and assembly documents. The executor handles internal steps. Tasks in this manifest cannot aggregate or depend on other task outputs. For an unrelated website and document, create two projects with one task each. Do not invent extra deliverables, packages, logos or downloads the user did not request. Group related work into a project; keep explicitly unrelated projects separate and never copy one project's private facts into another project's brief. Keep each brief concise while preserving all supplied facts. Preserve the project names exactly in title. Keys must use letters, numbers, underscores or hyphens. Each task needs full, actionable instructions preserving the user's facts and constraints. Choose text for a complete written answer, code example or research report. Choose the matching Studio kind for an actual website, logo, document, spreadsheet, slides, CAD or email draft. No outbound message, payment, publishing, repository modification, image/video generation, browser control or delegated map action is available through this manifest yet. Negative constraints such as do not publish or do not send messages forbid those actions; they are not unsupported requests. Put every actually requested unsupported action in unhandledRequests; never silently drop it or replace it with a pretend result. Use [] when all requested work is supported. Limit this plan to twenty-four tasks and twelve project groups; list excess work in unhandledRequests rather than omitting it. Before answering, separate requested outputs from restrictions on those outputs. Keep prohibitions in task instructions; they never belong in unhandledRequests. For example, "create a website; do not publish" means one website task and unhandledRequests []. "Create and publish a website" includes an actual publishing request in unhandledRequests. "Do not forget to publish" also requests publishing and must remain unhandled. Do not classify by the word publish alone. This is a plan, not completed work.`,
    messages: [{ role: 'user', content: JSON.stringify({ request: prompt, conversation: context, suppliedMaterial: material }) }],
  }, signal)
  const result = await readChatStream(response.body!, { signal })
  if (signal?.aborted || owner !== localStorage.getItem('nalu-token')) throw new DOMException('Cancelled', 'AbortError')
  if (result.error || result.finishReason === 'length') throw Error(result.error || 'The local agent plan was incomplete. No jobs were started. Split the request into project batches.')
  return parseSwarmWorkPlan(result.text)
}
