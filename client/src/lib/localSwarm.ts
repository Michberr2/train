import { executeSwarmWork } from '../../../shared/swarmExecution'
import type { SwarmDeviceJob } from '../../../shared/swarmDevice'
import { DEVICE_SWARM_PARALLELISM } from '../../../shared/swarmDevice'
import { STUDIO_KINDS } from '../../../shared/studioIntent'
import { getLocalPreferences, requestLocalChat } from './localAI'
import { handleLocalAIRequest } from './localAIRequests'
import { readChatStream } from '../components/workspace/chatStream'
import { isLiveSwarmState, requestSwarmValue, sameSwarmAccount, SwarmRequestError, type SwarmAccount, type SwarmResponse } from '../components/workspace/design/swarmTransport'
import type { SwarmState } from '../components/workspace/design/swarmTypes'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 300 && !/[\u0000-\u001f]/.test(value)
function validJob(value: unknown, state: SwarmState): value is SwarmDeviceJob {
  if (!record(value) || value.executionMode !== 'device' || !identifier(value.id) || !identifier(value.leaseToken) || !Number.isSafeInteger(value.leaseUntil) || Number(value.leaseUntil) <= Date.now()
    || !['reply', 'task'].includes(String(value.kind)) || typeof value.input !== 'string' || value.input.length > 12000 || !value.input.trim() || typeof value.brief !== 'string' || value.brief.length > 12000
    || !Array.isArray(value.context) || value.context.length > 40 || value.context.some(message => !record(message) || !['user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string' || message.content.length > 12000)) return false
  const project = state.projects.find(project => project.id === value.projectId)
  if (!project || !project.members.includes(value.speaker as never) || value.thread !== 'group' && !project.members.includes(value.thread as never)) return false
  const profile = project.agentProfiles?.[String(value.speaker)]
  if (value.allowCustomSpeaker !== undefined && value.allowCustomSpeaker !== true || value.personality !== undefined && (typeof value.personality !== 'string' || value.personality.length > 800)) return false
  if (value.allowCustomSpeaker && (!profile || profile.personality !== value.personality)) return false
  if (value.studio && (!record(value.studio) || !identifier(value.studio.taskId) || !identifier(value.studio.sourceJobId) || value.studio.kind === 'chat' || !(STUDIO_KINDS as readonly unknown[]).includes(value.studio.kind))) return false
  return true
}

type Options = {
  account: SwarmAccount; readAccount: () => SwarmAccount | null
  update: (response: SwarmResponse) => void; error: (message: string) => void
  request?: typeof fetch
}
/** One durable job slot. Cancellation is scoped to this slot's saved lease. */
class LocalSwarmSlot {
  private controller?: AbortController
  private job?: SwarmDeviceJob
  private disposed = false
  constructor(private options: Options) {}
  stop() { this.disposed = true; this.controller?.abort() }
  observe(state: SwarmState) {
    if (!this.job) return
    const task = this.job.studio ? state.tasks.find(task => task.id === this.job!.studio!.taskId) : state.tasks.find(task => task.executionId === this.job!.id)
    const turn = state.turns.find(turn => turn.replyId === `${this.job!.id}:reply`)
    if (!getLocalPreferences().enabled || this.job.kind === 'reply' && turn?.status !== 'pending' || this.job.kind === 'task' && (!task || task.executionId !== this.job.id || task.status !== 'running')) this.controller?.abort()
  }
  async pump(): Promise<void> {
    if (this.disposed || this.controller || !getLocalPreferences().enabled || !sameSwarmAccount(this.options.account, this.options.readAccount())) return
    const controller = new AbortController(); this.controller = controller
    const signal = controller.signal
    const current = () => {
      if (!sameSwarmAccount(this.options.account, this.options.readAccount())) controller.abort()
      signal.throwIfAborted()
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined, renewal: Promise<unknown> | undefined
    const call = async (body: Record<string, unknown>, timeout = 25000) => {
      const value = await requestSwarmValue(this.options.account, body, AbortSignal.any([signal, AbortSignal.timeout(timeout)]), this.options.readAccount, this.options.request)
      if (!record(value) || !isLiveSwarmState(value.state) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('The local Swarm update was incomplete. Your saved work is unchanged.')
      this.options.update(value as unknown as SwarmResponse)
      return value
    }
    try {
      const claim = await call({ action: 'device-claim' })
      if (claim.deviceJob == null) return
      if (!validJob(claim.deviceJob, claim.state as unknown as SwarmState)) throw new Error('The local Swarm job was incomplete. No model ran.')
      const job = claim.deviceJob; this.job = job
      const renew = () => {
        if (renewal || signal.aborted) return
        renewal = call({ action: 'device-renew', jobId: job.id, leaseToken: job.leaseToken }).catch(() => controller.abort()).finally(() => { renewal = undefined })
      }
      heartbeat = setInterval(renew, 15000)
      const result = await executeLocalSwarmJob(job, { signal, current, request: this.options.request, token: this.options.account.token, onProgress: async progress => { await call({ action: 'device-renew', jobId: job.id, leaseToken: job.leaseToken, stage: progress.stage }) } })
      // Recover a lost acknowledgement with the exact result and lease token.
      // The API retains an idempotent receipt after terminal completion.
      for (let attempt = 0; ; attempt++) {
        try { await call({ action: 'device-result', jobId: job.id, leaseToken: job.leaseToken, result }); break }
        catch (error) { if (attempt >= 2 || signal.aborted || !(error instanceof SwarmRequestError && error.uncertain)) throw error }
      }
    } catch (error) {
      if (!signal.aborted && sameSwarmAccount(this.options.account, this.options.readAccount())) {
        this.options.error(error instanceof Error ? error.message : 'The local Swarm attempt could not finish.')
        if (this.job) await call({ action: 'device-fail', jobId: this.job.id, leaseToken: this.job.leaseToken }).catch(() => {})
      }
    } finally {
      clearInterval(heartbeat); await renewal
      controller.abort(); this.job = undefined
      if (this.controller === controller) this.controller = undefined
    }
  }
}

/** Independent jobs stay active together while the model scheduler shares GPU
 * memory. The account-wide API cap also applies across separate browser tabs. */
export class LocalSwarmRunner {
  private slots: LocalSwarmSlot[]
  constructor(options: Options) { this.slots = Array.from({ length: DEVICE_SWARM_PARALLELISM }, () => new LocalSwarmSlot(options)) }
  stop() { this.slots.forEach(slot => slot.stop()) }
  observe(state: SwarmState) { this.slots.forEach(slot => slot.observe(state)) }
  async pump(): Promise<void> { await Promise.all(this.slots.map(slot => slot.pump())) }
}

export async function executeLocalSwarmJob(job: SwarmDeviceJob, options: { signal: AbortSignal; current: () => void; token?: string; request?: typeof fetch; onProgress?: (progress: import('../../../shared/swarmExecution').SwarmExecutionProgress) => Promise<void> }): Promise<unknown> {
  const { signal, current } = options
  if (job.studio) {
    current()
    const { endpoint, kind } = studioRoute(job.studio.kind)
    const response = await handleLocalAIRequest(`/api/${endpoint}`, JSON.stringify({ prompt: job.input, messages: job.context, material: `PROJECT BRIEF:\n${job.brief}`, memory: '', images: [], ...(kind ? { kind } : {}) }), signal)
    const payload: unknown = await response.json()
    if (!response.ok || !record(payload)) throw new Error(record(payload) && typeof payload.error === 'string' ? payload.error : 'The local creation was incomplete.')
    return { payload }
  }
  return executeSwarmWork({ ...job, timeoutMs: 900000, signal, onProgress: options.onProgress }, {
    complete: async (messages, settings) => {
      current()
      const response = requestLocalChat({ messages, assistantName: job.speaker, localRole: settings.json ? 'reasoning' : job.kind === 'reply' ? undefined : 'writing', maxTokens: settings.maxTokens,
        ...(settings.json ? { jsonSchema: settings.jsonSchema || { type: 'object' } } : {}) }, settings.signal)
      const answer = await readChatStream(response.body!, { signal: settings.signal })
      current()
      if (answer.error) throw new Error(answer.error)
      if (answer.finishReason === 'length') throw new Error('The local Swarm result exceeded this model’s capacity. Split the task into smaller work items.')
      return answer.text
    },
    research: async (query, depth, _domain, requestSignal) => {
      current()
      const response = await (options.request || fetch)('/api/web', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) }, body: JSON.stringify({ action: 'research', query, depth }), signal: requestSignal })
      const evidence = await response.json()
      current()
      if (!response.ok || !record(evidence) || typeof evidence.text !== 'string' || !Array.isArray(evidence.sources)) throw new Error('Public research was unavailable; no sources were invented.')
      return evidence as unknown as { weak?: boolean; text: string; sources: { url: string }[] }
    },
  })
}

function studioRoute(kind: string): { endpoint: string; kind?: string } {
  if (kind === 'document') return { endpoint: 'doc' }
  if (kind === 'spreadsheet') return { endpoint: 'sheet' }
  if (['slides', 'cad', 'email', 'image', 'video'].includes(kind)) return { endpoint: kind }
  return { endpoint: 'design', kind: kind === 'website' ? 'webpage' : kind }
}
