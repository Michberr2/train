/** Read-only transport, separated from React so session races can be tested. */
export type ActivityAccount = { owner: string; token: string }
export const sameActivityAccount = (a: ActivityAccount | null, b: ActivityAccount | null): boolean =>
  !!a && !!b && a.owner === b.owner && a.token === b.token

export class ActivitySessionChanged extends Error {
  constructor() { super('The activity account changed.'); this.name = 'ActivitySessionChanged' }
}

export async function requestWorkspaceActivity(
  account: ActivityAccount,
  signal: AbortSignal,
  readAccount: () => ActivityAccount | null,
  request: typeof fetch = fetch,
): Promise<unknown[]> {
  const assertCurrent = () => {
    if (signal.aborted) throw new DOMException('Activity request stopped.', 'AbortError')
    if (!account.owner || !account.token || !sameActivityAccount(account, readAccount())) throw new ActivitySessionChanged()
  }
  assertCurrent()
  const response = await request('/api/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}` },
    body: JSON.stringify({ action: 'task-feed', limit: 500 }), signal,
  })
  assertCurrent()
  const data: unknown = await response.json()
  assertCurrent()
  if (!response.ok || !data || typeof data !== 'object' || !('tasks' in data) || !Array.isArray(data.tasks)) {
    throw new Error('Task updates are unavailable. Saved work is still here.')
  }
  return data.tasks
}
