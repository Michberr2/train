import { AsyncLocalStorage } from 'node:async_hooks'
import { waitUntil } from '@vercel/functions'

// Request-local, never a process-global controller: one cancelled browser tab
// must not cancel another user's generation in a reused serverless instance.
const requestSignal = new AsyncLocalStorage<AbortSignal>()

export function cancellationSignal(explicit?: AbortSignal | null): AbortSignal | undefined {
  const parent = requestSignal.getStore()
  return explicit && parent && explicit !== parent ? AbortSignal.any([explicit, parent]) : explicit || parent
}

export function throwIfCancelled(signal = cancellationSignal()): void {
  if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
}

export function waitWithCancellation(milliseconds: number, signal = cancellationSignal()): Promise<void> {
  throwIfCancelled(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('The request was cancelled.', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function withRequestCancellation<T>(req: any, res: any, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  // Vercel may reclaim a cancelled invocation immediately. Register cleanup
  // BEFORE work starts, so task.finally can refund quota after disconnect.
  let cleanupFinished!: () => void
  waitUntil(new Promise<void>(resolve => { cleanupFinished = resolve }))
  // IncomingMessage.close also fires after a normal complete POST body; only
  // aborted, or a response closing before end, identifies a disconnected caller.
  const responseClosed = () => { if (!res.writableEnded) abort() }
  req.on?.('aborted', abort)
  req.on?.('error', abort) // Vercel's Node handler emits Error('aborted').
  req.signal?.addEventListener?.('abort', abort, { once: true })
  res.on?.('close', responseClosed)
  if (req.aborted || req.signal?.aborted || res.destroyed) abort()
  try {
    return await requestSignal.run(controller.signal, async () => {
      throwIfCancelled()
      return await task(controller.signal)
    })
  } catch (error) {
    if (!controller.signal.aborted) throw error
    // A disconnected caller receives no response. The task's finally block is
    // still awaited so unsuccessful reservations are released exactly once.
  } finally {
    req.off?.('aborted', abort)
    req.off?.('error', abort)
    req.signal?.removeEventListener?.('abort', abort)
    res.off?.('close', responseClosed)
    cleanupFinished()
  }
}
