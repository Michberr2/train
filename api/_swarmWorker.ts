import { connectionBackend } from './_connectionBackend'
import { SwarmStore, type SwarmJob, type SwarmSnapshot } from './_swarmStore'
import { appendSwarmResult, swarmContext } from './_swarm'
import { executeSwarmWork, type SwarmExecutionResult } from './_swarmExecution'

type WorkerStore = Pick<SwarmStore, 'read' | 'renew' | 'mutateLeased'>
type Execute = typeof executeSwarmWork

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
  options: { execute?: Execute; timeoutMs?: number; heartbeatMs?: number; now?: () => number } = {}) {
  const execute = options.execute || executeSwarmWork, now = options.now || Date.now
  if (!job.leaseToken) throw new Error('Swarm execution requires a durable claim.')
  const token = job.leaseToken, controller = new AbortController()
  let heartbeatPending: Promise<void> | undefined
  const deadline = setTimeout(() => controller.abort(new Error('This work exceeded its execution window. Retry to continue.')), options.timeoutMs || 110_000)
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
    const scope = swarmContext(snapshot, job)
    const result = await execute({ speaker: job.speaker, kind: job.kind, input: job.input, ...scope, signal: controller.signal,
      onProgress: async progress => {
        if (controller.signal.aborted) throw controller.signal.reason
        const updated = await store.mutateLeased(owner, job.id, token, draft => {
          const active = draft.jobs.find(item => item.id === job.id)!
          active.summary = progress.message; active.updatedAt = now()
          const task = draft.state.tasks.find(item => item.id === active.taskId && item.executionId === active.id)
          if (task) { task.status = 'running'; task.summary = progress.message; task.updatedAt = now(); delete task.progress }
        })
        if (!updated) { controller.abort(new Error('This work was stopped.')); throw controller.signal.reason }
      } })
    if (controller.signal.aborted) throw controller.signal.reason
    await store.mutateLeased(owner, job.id, token, draft => finishSwarmJob(draft, job.id, result, now()))
  } catch {
    // Only the current worker can mark failure. A cancellation/expired lease
    // cannot be overwritten by a late provider response or a stopped worker.
    await store.mutateLeased(owner, job.id, token, draft => {
      const active = draft.jobs.find(item => item.id === job.id)!
      active.status = 'failed'; active.updatedAt = now(); active.summary = 'This attempt could not finish. Retry when you are ready.'
      active.error = active.summary; delete active.leaseToken; delete active.leaseUntil
      const task = draft.state.tasks.find(item => item.id === active.taskId && item.executionId === active.id)
      if (task) { task.status = 'failed'; task.summary = active.summary; task.updatedAt = now(); delete task.progress }
      const turn = draft.state.turns.find(item => item.id === active.turnId)
      if (turn) { turn.status = 'failed'; turn.updatedAt = now() }
      if (active.kind === 'reply') appendSwarmResult(draft, active, 'I couldn’t finish that reply. Please try again.', now())
    }).catch(() => { /* The durable expired-lease sweep will mark interruption. */ })
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); controller.abort()
    await heartbeatPending
  }
}

/** Immediate wake-up is best-effort; durable records are also swept by cron. */
export async function runSwarmOwner(owner: string, durationMs = 230_000) {
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
              await executeLeasedSwarmJob(new SwarmStore(backend.client), owner, job, { timeoutMs: Math.max(1000, Math.min(110_000, durationMs - (Date.now() - start) - 5000)) })
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
  await Promise.allSettled(owners.map(owner => runSwarmOwner(owner, 220_000)))
  return { accountsChecked: owners.length }
}
