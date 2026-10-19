import { useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import { getToken } from '../../../lib/localAuth'
import { sessionWasCleared } from '../../../lib/sync'
import { SwarmClient, emptySwarmSnapshot } from './swarmClient'
import { sameSwarmAccount, type SwarmAccount } from './swarmTransport'
import { selectSwarmMessages, selectSwarmPending, selectSwarmTasks, swarmRoomId, type SwarmController } from './swarmTypes'

const subscribeEmpty = () => () => {}
const getEmpty = () => emptySwarmSnapshot
function currentAccount(expectedOwner?: string): SwarmAccount | null {
  try {
    if (!expectedOwner || sessionWasCleared()) return null
    const token = getToken(), owner = localStorage.getItem('nalu-data-owner')
    return token && owner === expectedOwner ? { owner, token } : null
  } catch { return null }
}

/** A separate authenticated Swarm service. Ordinary chat and Studio generation
 * stay owned by Workspace; this controller never writes their stores. */
export default function useSwarm({ accountId, enabled = true, active = false }: { accountId?: string; enabled?: boolean; active?: boolean }): SwarmController {
  const latest = useRef({ accountId, enabled, active }); latest.current = { accountId, enabled, active }
  const [, refreshAccount] = useReducer(value => value + 1, 0)
  const account = enabled ? currentAccount(accountId) : null
  const client = useMemo(() => account ? new SwarmClient({ account, readAccount: () => latest.current.enabled ? currentAccount(latest.current.accountId) : null, storage: localStorage }) : null, [account?.owner, account?.token])
  const snapshot = useSyncExternalStore(client?.subscribe || subscribeEmpty, client?.getSnapshot || getEmpty, getEmpty)
  const wake = useRef<() => void>(() => {})

  useEffect(() => {
    if (!client) return
    client.start()
    let stopped = false, loading = false, reloadRequested = false, timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      clearTimeout(timer)
      if (stopped || !client.isCurrent()) return
      if (loading) { reloadRequested = true; return }
      loading = true
      await client.refresh()
      loading = false
      if (stopped || !client.isCurrent()) return
      const state = client.getSnapshot().state
      const pending = client.hasPendingRequests() || state.turns.some(turn => turn.status === 'pending') || state.tasks.some(task => task.status === 'running' || task.status === 'queued' && !!task.executionId)
      const requested = reloadRequested; reloadRequested = false
      if (requested || latest.current.active || pending) timer = setTimeout(load, requested ? 0 : document.visibilityState === 'hidden' ? 12000 : pending ? 2000 : 6000)
    }
    const refresh = () => { if (!stopped) { clearTimeout(timer); if (loading) reloadRequested = true; else timer = setTimeout(load, 0) } }
    wake.current = refresh
    const changed = (event: Event) => {
      if (event instanceof StorageEvent && event.key && !['nalu-token', 'nalu-data-owner'].includes(event.key)) return
      if (!sameSwarmAccount(client.account, latest.current.enabled ? currentAccount(latest.current.accountId) : null)) { client.dispose(); refreshAccount() }
      else refresh()
    }
    const visible = () => { if (document.visibilityState !== 'hidden') changed(new Event('focus')) }
    window.addEventListener('storage', changed)
    window.addEventListener('nalu-session-cleared', changed)
    window.addEventListener('nalu-hydrated', changed)
    window.addEventListener('online', refresh)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    // Same-document auth writes do not emit a storage event. Abort an obsolete
    // request promptly even before React receives the new authenticated user.
    const watch = setInterval(() => { if (!client.isCurrent()) changed(new Event('account')) }, 1000)
    void load()
    return () => {
      stopped = true; clearTimeout(timer); clearInterval(watch); client.dispose()
      wake.current = () => {}
      window.removeEventListener('storage', changed)
      window.removeEventListener('nalu-session-cleared', changed)
      window.removeEventListener('nalu-hydrated', changed)
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [client])
  useEffect(() => { if (active) wake.current() }, [active])
  // An account may hydrate after this component mounted without an owner key.
  useEffect(() => {
    if (!enabled || client) return
    const changed = () => refreshAccount()
    window.addEventListener('nalu-hydrated', changed)
    window.addEventListener('storage', changed)
    return () => { window.removeEventListener('nalu-hydrated', changed); window.removeEventListener('storage', changed) }
  }, [enabled, client])
  const { state, preferences: prefs } = snapshot
  const room = swarmRoomId(prefs.activeProjectId, prefs.recipient)
  const mutate = <T,>(action: () => Promise<T>) => { const pending = action(); void pending.finally(() => wake.current()).catch(() => {}); return pending }
  return {
    state, activeProjectId: prefs.activeProjectId, recipient: prefs.recipient,
    messages: selectSwarmMessages(state, prefs.activeProjectId, prefs.recipient), tasks: selectSwarmTasks(state, prefs.activeProjectId),
    draft: prefs.drafts[room] || '', setDraft: text => client?.setDraft(text),
    pending: selectSwarmPending(state, prefs.activeProjectId, prefs.recipient).length > 0,
    sending: snapshot.sendingRooms.includes(room), pendingCount: state.turns.filter(turn => turn.status === 'pending').length,
    creating: snapshot.creating, setCreating: value => client?.setCreating(value), loading: !client || snapshot.loading, error: snapshot.error,
    refresh: () => wake.current(),
    selectProject: id => client?.selectProject(id), selectRecipient: thread => client?.selectRecipient(thread), navigate: (id, thread) => client?.navigate(id, thread),
    send: text => client ? mutate(() => client.send(text)) : false,
    stop: () => { client?.stop(); wake.current() },
    createProject: (title, brief) => client ? mutate(() => client.createProject(title, brief)) : null,
    addTask: (title, assignee) => client ? mutate(() => client.addTask(title, assignee)) : undefined,
    updateTask: () => { /* Server execution alone owns live task status. */ },
    assignTask: (id, assignee) => { client?.assignTask(id, assignee); wake.current() },
    recentRooms: prefs.recentRooms, busyTaskIds: snapshot.busyTaskIds,
    startTask: id => client ? mutate(() => client.startTask(id)) : undefined,
    stopTask: id => client ? mutate(() => client.stopTask(id)) : undefined,
    shareTask: id => client ? mutate(() => client.shareTask(id)) : undefined,
  }
}
