import { AsyncLocalStorage } from 'node:async_hooks'

/** Lightweight policy bridge for existing handlers. No DB, generators, account
 * records, bearer tokens, or client data are imported into this module. */
export interface SwarmStudioInvocation {
  ownerId: string; projectId: string; taskId: string; executionId: string
}
export interface SwarmStudioQuota {
  ok: boolean; signedIn: boolean; status?: number; reason?: string
  release: () => Promise<void>
}
type Invocation = {
  scope: Readonly<SwarmStudioInvocation>
  identityExcluded: boolean
  quotas: Array<{ kind: string; value: SwarmStudioQuota }>
  failed: boolean
}
const invocations = new AsyncLocalStorage<Invocation>()
const installed = new Set<'identity' | 'quota'>()

/** Called at module initialization by the integrated _db and _limits helpers.
 * Registration alone is insufficient: each invocation also checks observed
 * identity exclusion and confirmed owner-bound quota receipts. */
export function registerSwarmStudioHook(hook: 'identity' | 'quota'): void { installed.add(hook) }
export function assertSwarmStudioHooks(): void {
  if (!installed.has('identity') || !installed.has('quota')) throw new Error('Swarm Studio identity and quota integration is not installed.')
}
export function swarmStudioInvocation(): Readonly<SwarmStudioInvocation> | undefined { return invocations.getStore()?.scope }

/** _db.identityForRequest calls this BEFORE reading a token/profile. Ordinary
 * requests return false and keep their existing behavior. */
export function excludeSwarmStudioIdentity(): boolean {
  const invocation = invocations.getStore()
  if (!invocation) return false
  invocation.identityExcluded = true
  return true
}

/** _limits calls this with the owner actually used for its durable reservation.
 * A wrong/anonymous account is rejected, never silently treated as success.
 * Preserve the receipt's idempotent release implementation without replacing it.
 * Call for both denied and accepted reservations, before returning to a handler. */
export function recordSwarmStudioQuota<T extends SwarmStudioQuota>(ownerId: string | null, kind: string, quota: T): T {
  const invocation = invocations.getStore()
  if (!invocation) return quota
  if (quota.ok && (ownerId !== invocation.scope.ownerId || !quota.signedIn)) {
    void quota.release().catch(() => {})
    throw new Error('Swarm Studio quota was not reserved for this authenticated owner.')
  }
  if (quota.ok) {
    invocation.quotas.push({ kind, value: quota })
    if (invocation.failed) void quota.release().catch(() => {})
  }
  return quota
}

export function assertSwarmStudioPolicyApplied(quotaKind: string, needsIdentity: boolean): void {
  const invocation = invocations.getStore()
  if (!invocation || (needsIdentity && !invocation.identityExcluded)
    || !invocation.quotas.some(receipt => receipt.kind === quotaKind && receipt.value.ok)) {
    throw new Error('The Studio handler did not apply the required Swarm identity/quota policy.')
  }
}

/** Failed/cancelled work refunds the same durable receipts. Existing handlers
 * may also refund; the quota API's idempotent receipt prevents double refunds.
 * A late reservation in an already-cancelled invocation is refunded as well. */
export async function withSwarmStudioInvocation<T>(scope: SwarmStudioInvocation, task: () => Promise<T>): Promise<T> {
  const invocation: Invocation = { scope: Object.freeze({ ...scope }), identityExcluded: false, quotas: [], failed: false }
  return invocations.run(invocation, async () => {
    try { return await task() }
    catch (error) {
      invocation.failed = true
      // A lost commit acknowledgement can mean the artifact was saved. Never
      // compensate or rerun providers blindly; recover that durable job first.
      if (error && typeof error === 'object' && 'swarmCommitUncertain' in error && error.swarmCommitUncertain) throw error
      const releases = await Promise.allSettled(invocation.quotas.map(receipt => receipt.value.release()))
      if (releases.some(result => result.status === 'rejected')) {
        // Preserve the original failure, but expose cleanup failure to the
        // durable worker so it can schedule receipt cleanup rather than retry
        // provider generation automatically.
        if (error instanceof Error) Object.assign(error, { quotaCleanupPending: true })
      }
      throw error
    }
  })
}
