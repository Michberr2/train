import { AsyncLocalStorage } from 'node:async_hooks'
import { cancellationSignal, throwIfCancelled } from './_requestCancellation'

// Opt in for scheduler storage only. Request cancellation elsewhere must not
// silently prevent quota refunds or other existing critical cleanup paths.
const storageScope = new AsyncLocalStorage<AbortSignal>()

export async function withStorageDeadline<T>(deadlineMs: number, task: () => Promise<T>): Promise<T> {
  const controller = new AbortController(), parent = storageScope.getStore()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new Error('The scheduler storage deadline was reached. Saved work is preserved.')), Math.max(0, deadlineMs - Date.now()))
  try { throwIfCancelled(signal); return await storageScope.run(signal, task) }
  finally { clearTimeout(timer); controller.abort() }
}

export function storageCancellationSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const parent = storageScope.getStore()
  if (!parent) return explicit
  const combined = explicit ? AbortSignal.any([parent, explicit]) : parent
  return cancellationSignal(combined)
}

export function checkStorageDeadline(cleanup = false): void {
  const signal = cleanup ? storageScope.getStore() : storageCancellationSignal()
  if (signal) throwIfCancelled(signal)
}

/** Bound both response headers and body parsing, even if a transport ignores
 * AbortSignal. A timed-out mutation is never retried here: its outcome may be
 * unknown, so higher-level revision/lease guards own recovery. */
export async function boundedStorageCall<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), signal = storageCancellationSignal(controller.signal)!
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason || new DOMException('Storage request cancelled.', 'AbortError')); signal.addEventListener('abort', abort, { once: true }) })
  const timer = setTimeout(() => controller.abort(new Error('The database operation timed out; its outcome could not be confirmed.')), 20000)
  try { throwIfCancelled(signal); return await Promise.race([operation(signal), cancelled]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort() }
}
