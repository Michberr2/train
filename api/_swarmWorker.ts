import { connectionBackend } from './_connectionBackend'
import { SwarmStore, type SwarmJob, type SwarmSnapshot } from './_swarmStore'
import { appendSwarmResult, swarmContext } from './_swarm'
import { executeSwarmWork, type SwarmExecutionResult } from './_swarmExecution'

type WorkerStore = Pick<SwarmStore, 'read' | 'renew' | 'mutateLeased'> & Partial<Pick<SwarmStore, 'mutate'>>
type Execute = typeof executeSwarmWork
type ExecuteStudio = typeof import('./_swarmStudioRunner')['runSwarmStudioJob']

// Only exact, application-authored validation messages can reach the UI.
// Provider errors may contain private prompt material, URLs or credentials.
const STUDIO_FAILURES = new Map<string, string>([
  ['This image request and its approved context exceed the image generator limit. Narrow the brief explicitly; no context was silently discarded.', 'The image request and selected conversation exceed the image limit. Use a shorter brief or conversation and start a new work item.'],
  ['Provide an image prompt of up to 6000 characters.', 'The image request is too long. Shorten the brief and start a new work item.'],
  ['The CAD request is too large. Use a smaller model or shorter instructions.', 'The model request and selected conversation are too large. Use a shorter brief or conversation and start a new work item.'],
  ['This creation exceeds the saved-work limit. Split it into smaller creations.', 'This creation exceeds the saved-work limit. Split it into smaller creations.'],
  ['The website has not passed its runtime checks.', 'The website did not pass its runtime checks. Revise the requested behavior before trying a new work item.'],
  ['The website did not pass its build checks. Please retry; your existing design is preserved.', 'The website did not pass its build checks. Revise the requested behavior before trying a new work item.'],
  ['The Studio generator returned no usable artifact. This work was not marked complete.', 'Studio returned no usable creation. Clarify the brief and start a new work item.'],
  ['The generated media exceeds the supported save size.', 'The generated media exceeds the save limit. Request a smaller image or shorter clip.'],
  ['The video download was incomplete or exceeds the supported size.', 'The video could not be saved completely within the size limit. Request a smaller clip.'],
  ['This video provider cannot verify a stable multi-part download. Retry with a smaller clip.', 'The video download could not be verified. Request a smaller clip.'],
  ['The video changed during download. No partial clip was saved.', 'The video changed during download. No partial clip was saved.'],
  ['Usage checks are temporarily unavailable. Please retry in a moment; generation has not started.', 'Usage checks are temporarily unavailable. No Studio generation started; try again later.'],
  ['Usage checks are temporarily unavailable. Please retry in a moment.', 'Usage checks are temporarily unavailable. No Studio generation started; try again later.'],
])
const REFUND_UNCONFIRMED = 'The usage refund could not be confirmed. Review this attempt before starting more work.'
function failureSummary(error: unknown, studio: boolean, refundPending: boolean): string {
  const known = studio && error instanceof Error ? STUDIO_FAILURES.get(error.message) : undefined
  if (refundPending) return `${known || 'This attempt could not finish.'} ${REFUND_UNCONFIRMED}`
  return known || 'This attempt could not finish. Retry when you are ready.'
}

// Stop removes the lease before provider cleanup completes. Add only recovery
// metadata to that immutable stopped/failed attempt; never change its status,
// revive work, overwrite a successful result, or touch a newer task execution.
function noteUnconfirmedRefund(snapshot: SwarmSnapshot, failed: SwarmJob, now: number): void {
  const job = snapshot.jobs.find(item => item.id === failed.id && item.requestId === failed.requestId)
  if (!job || !['failed', 'cancelled'].includes(job.status) || job.quotaCleanupPending) return
  job.quotaCleanupPending = true; job.updatedAt = now
  job.summary = `${job.status === 'cancelled' ? 'Stopped by you.' : 'This attempt could not finish.'} ${REFUND_UNCONFIRMED}`
  job.error = job.summary
  const task = snapshot.state.tasks.find(item => item.id === job.taskId && item.executionId === job.id)
  if (task && ['failed', 'cancelled'].includes(task.status)) { task.summary = job.summary; task.updatedAt = now }
}

/** The lease predicate is checked in the same atomic write as every result. */
export function finishSwarmJob(snapshot: SwarmSnapshot, id: string, result: SwarmExecutionResult, now: number) {
  const job = snapshot.jobs.find(item => item.id === id)
  if (!job) throw new Error('Swarm work no longer exists.')
  job.status = result.status; job.result = result.content; job.summary = result.summary; job.updatedAt = now
  job.artifact = result.artifact; job.progress = result.status === 'done' ? 1 : undefined
  delete job.leaseToken; delete job.leaseUntil
  const turn = snapshot.state.turns.find(item => item.id === job.turnId)
  if (turn) { turn.status = 'completed'; turn.updatedAt = now }
  const task = snapshot.state.tasks.find(item => item.id === job.taskId && item.executionId === job.id)
  if (task) {
    task.status = result.status; task.summary = result.summary; task.updatedAt = now; task.progress = job.progress
    if (result.artifact?.type === 'needs-workspace') task.handoff = { studioKind: result.artifact.studioKind, prompt: result.artifact.prompt, reason: result.artifact.reason }
    else delete task.handoff
  }
  appendSwarmResult(snapshot, job, result.content, now)
}

export async function executeLeasedSwarmJob(store: WorkerStore, owner: string, job: SwarmJob,
  options: { execute?: Execute; executeStudio?: ExecuteStudio; timeoutMs?: number; heartbeatMs?: number; now?: () => number } = {}) {
  const execute = options.execute || executeSwarmWork, now = options.now || Date.now
  if (!job.leaseToken) throw new Error('Swarm execution requires a durable claim.')
  const token = job.leaseToken, controller = new AbortController()
  let heartbeatPending: Promise<void> | undefined
  const studio = job.artifact?.type === 'studio-generation'
  const timeoutMs = options.timeoutMs || (studio ? 270_000 : 110_000)
  const deadline = setTimeout(() => controller.abort(new Error('This work exceeded its execution window. Retry to continue.')), timeoutMs)
  const pulse = () => {
    if (heartbeatPending || controller.signal.aborted) return
    heartbeatPending = store.renew(owner, job.id, token).then(valid => {
      if (!valid) controller.abort(new Error('This work was stopped or its lease ended.'))
    }, () => controller.abort(new Error('The work lease could not be confirmed.'))).finally(() => { heartbeatPending = undefined })
  }
  const heartbeat = setInterval(pulse, options.heartbeatMs || 20_000)
  try {
    const snapshot = await store.read(owner)
    const current = snapshot.jobs.find(item => item.id === job.id)
    if (current?.status !== 'running' || current.leaseToken !== token || (current.leaseUntil || 0) <= now()) return
    if (!await store.renew(owner, job.id, token)) return
    const onProgress = async (message: string) => {
        if (controller.signal.aborted) throw controller.signal.reason
        const updated = await store.mutateLeased(owner, job.id, token, draft => {
          const active = draft.jobs.find(item => item.id === job.id)!
          active.summary = message; active.updatedAt = now()
          const task = draft.state.tasks.find(item => item.id === active.taskId && item.executionId === active.id)
          if (task) { task.status = 'running'; task.summary = message; task.updatedAt = now(); delete task.progress }
        })
        if (!updated) { controller.abort(new Error('This work was stopped.')); throw controller.signal.reason }
    }
    if (studio) {
      const executeStudio = options.executeStudio || (await import('./_swarmStudioRunner')).runSwarmStudioJob
      await executeStudio({ store, owner, job, signal: controller.signal, timeoutMs, onProgress })
      return // The Studio adapter saved its artifact under the same lease fence.
    }
    const scope = swarmContext(snapshot, job)
    const result = await execute({ speaker: job.speaker, kind: job.kind, input: job.input, ...scope, signal: controller.signal,
      onProgress: progress => onProgress(progress.message) })
    if (controller.signal.aborted) throw controller.signal.reason
    await store.mutateLeased(owner, job.id, token, draft => finishSwarmJob(draft, job.id, result, now()))
  } catch (error) {
    const refundPending = !!error && typeof error === 'object' && 'quotaCleanupPending' in error && error.quotaCleanupPending === true
    const summary = failureSummary(error, studio, refundPending)
    // Only the current worker can mark failure. A cancellation/expired lease
    // cannot be overwritten by a late provider response or a stopped worker.
    const recorded = await store.mutateLeased(owner, job.id, token, draft => {
      const active = draft.jobs.find(item => item.id === job.id)!
      active.status = 'failed'; active.updatedAt = now(); active.summary = summary
      if (refundPending) active.quotaCleanupPending = true
      active.error = active.summary; delete active.leaseToken; delete active.leaseUntil
      const task = draft.state.tasks.find(item => item.id === active.taskId && item.executionId === active.id)
      if (task) { task.status = 'failed'; task.summary = active.summary; task.updatedAt = now(); delete task.progress }
      const turn = draft.state.turns.find(item => item.id === active.turnId)
      if (turn) { turn.status = 'failed'; turn.updatedAt = now() }
      if (active.kind === 'reply') appendSwarmResult(draft, active, 'I couldn’t finish that reply. Please try again.', now())
    }).catch(() => null) // The durable expired-lease sweep still marks interruption.
    if (refundPending && !recorded && store.mutate) {
      await store.mutate(owner, draft => noteUnconfirmedRefund(draft, job, now())).catch(() => {
        console.error('Swarm usage refund remains unconfirmed; recovery metadata could not be saved.')
      })
    }
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); controller.abort()
    await heartbeatPending
  }
}

/** Immediate wake-up is best-effort; durable records are also swept by cron. */
export async function runSwarmOwner(owner: string, durationMs = 280_000) {
  const start = Date.now(), dispatcher = connectionBackend()
  try {
    await dispatcher.connect()
    const store = new SwarmStore(dispatcher.client)
    while (Date.now() - start < durationMs - 10_000) {
      const running: Promise<unknown>[] = []
      try {
        for (let count = 0; count < 3; count++) {
          if (Date.now() - start >= durationMs - 10_000) break
          const job = await store.claim(owner)
          if (!job) break
          // Start renewing/executing each claim immediately. Waiting for a full
          // batch of storage claims can consume the first worker's lease.
          const execution = (async () => {
            const backend = connectionBackend()
            try {
              await backend.connect()
              await executeLeasedSwarmJob(new SwarmStore(backend.client), owner, job, { timeoutMs: Math.max(1000, Math.min(job.artifact?.type === 'studio-generation' ? 270_000 : 110_000, durationMs - (Date.now() - start) - 5000)) })
            } finally { await backend.close().catch(() => {}) }
          })()
          // Attach a rejection handler immediately while subsequent claims are
          // pending. Failed connections retain their durable lease for cleanup.
          running.push(execution.catch(() => {}))
        }
      } finally {
        // A later failed claim must not abandon workers already in flight.
        await Promise.allSettled(running)
      }
      if (!running.length) break
    }
  } finally { await dispatcher.close().catch(() => {}) }
}

export async function runDueSwarmJobs() {
  const backend = connectionBackend()
  let owners: string[]
  try {
    await backend.connect()
    owners = await new SwarmStore(backend.client).dueOwners(6)
  } finally { await backend.close().catch(() => {}) }
  // Limit each cron invocation. Oldest pending accounts are selected first;
  // unopened accounts still resume without relying on a browser poll.
  await Promise.allSettled(owners.map(owner => runSwarmOwner(owner, 280_000)))
  return { accountsChecked: owners.length }
}
