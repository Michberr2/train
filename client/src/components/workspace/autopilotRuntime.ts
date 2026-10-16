type Edge = { from: string; to: string }

/** Settle promptly on Stop/timeout, including helpers that ignore AbortSignal. */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Run stopped', 'AbortError'))
    if (signal.aborted) { void work.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Repeating sends or mutating HTTP requests can duplicate a real external action. */
export function nodeAttemptLimit(type: string, method = 'GET', max = 5): number {
  return type === 'email' || type === 'social' || (type === 'http' && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) ? 1 : max
}

/** Schedule the ready branches of a DAG, waiting for every live parent at joins. */
export async function runGraph(options: {
  order: string[]
  edges: Edge[]
  finished: Set<string>
  failed: Set<string>
  cut: Set<string>
  cutEdges: Set<string>
  concurrency: number
  shouldStop: () => boolean
  execute: (id: string) => Promise<void>
  skip: (id: string, failed: boolean) => void
}): Promise<void> {
  const { order, edges, finished, failed, cut, cutEdges, shouldStop, execute, skip } = options
  const pending = new Set(order.filter((id) => !finished.has(id)))
  const parents = new Map(order.map((id) => [id, edges.filter((edge) => edge.to === id).map((edge) => edge.from)]))
  const concurrency = Math.max(1, Math.floor(options.concurrency))
  let active = 0, executionError: unknown
  let hasExecutionError = false
  await new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (shouldStop() || hasExecutionError) {
        if (!active) { if (hasExecutionError) reject(executionError); else resolve() }
        return
      }
      let changed = true
      while (changed) {
        changed = false
        for (const id of pending) {
          const deps = parents.get(id) || []
          const live = deps.filter((parent) => !cutEdges.has(`${parent}>${id}`))
          if (!deps.length || live.some((parent) => !finished.has(parent))) continue
          if (live.some((parent) => !failed.has(parent) && !cut.has(parent))) continue
          const upstreamFailed = live.some((parent) => failed.has(parent))
          pending.delete(id); finished.add(id)
          if (upstreamFailed) failed.add(id); else cut.add(id)
          skip(id, upstreamFailed)
          changed = true
        }
      }
      for (const id of pending) {
        if (active >= concurrency) break
        const live = (parents.get(id) || []).filter((parent) => !cutEdges.has(`${parent}>${id}`))
        if (live.some((parent) => !finished.has(parent))) continue
        pending.delete(id); active++
        // Promise.resolve also converts an unexpected synchronous throw to rejection.
        void Promise.resolve().then(() => execute(id)).catch((error) => {
          hasExecutionError = true; executionError = error
        }).finally(() => { active--; pump() })
      }
      if (!active) {
        if (pending.size) reject(new Error('The pipeline cannot continue: an upstream step did not finish.'))
        else resolve()
      }
    }
    pump()
  })
}

export { isScheduleDue } from '../../../../shared/autopilotSchedule.ts'
