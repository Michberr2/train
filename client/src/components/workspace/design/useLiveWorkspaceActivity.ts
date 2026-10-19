import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getToken } from '../../../lib/localAuth'
import { sessionWasCleared } from '../../../lib/sync'
import { mergeWorkspaceActivity, remoteActivity, type ActivityChat, type WorkspaceActivityController } from './workspaceActivity'
import { ActivitySessionChanged, requestWorkspaceActivity, sameActivityAccount, type ActivityAccount } from './workspaceActivityFeed'

function currentAccount(expectedOwner?: string): ActivityAccount | null {
  try {
    if (sessionWasCleared()) return null
    const token = getToken(), owner = localStorage.getItem('nalu-data-owner')
    return token && owner && (!expectedOwner || owner === expectedOwner) ? { token, owner } : null
  } catch { return null }
}

/** One instance per signed-in Workspace, shared by the hub, tray and screens.
 * It only reads the task ledger. Local running state comes from actual request
 * owners supplied by Workspace, never persisted loading markers or a timer. */
export default function useLiveWorkspaceActivity({ chats, activeChatIds, accountId, enabled = true }: {
  chats: ActivityChat[]
  activeChatIds: readonly string[]
  accountId?: string
  enabled?: boolean
}): WorkspaceActivityController {
  const initialOwner = useRef(currentAccount()?.owner || '')
  const expectedOwner = accountId ?? initialOwner.current
  const account = enabled && expectedOwner ? currentAccount(expectedOwner) : null
  const [reload, setReload] = useState(0)
  const [feed, setFeed] = useState<{ account: ActivityAccount | null; tasks: unknown[]; error: string }>({ account: null, tasks: [], error: '' })
  const refresh = useCallback(() => setReload(value => value + 1), [])

  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof StorageEvent && event.key && !['nalu-token', 'nalu-data-owner'].includes(event.key)) return
      setFeed(current => sameActivityAccount(current.account, currentAccount(expectedOwner)) ? current : { account: null, tasks: [], error: '' })
      refresh()
    }
    const visible = () => { if (document.visibilityState !== 'hidden') refresh() }
    window.addEventListener('storage', changed)
    window.addEventListener('nalu-session-cleared', changed)
    window.addEventListener('nalu-hydrated', changed)
    window.addEventListener('online', refresh)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('storage', changed)
      window.removeEventListener('nalu-session-cleared', changed)
      window.removeEventListener('nalu-hydrated', changed)
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [expectedOwner, refresh])

  useEffect(() => {
    if (!account) { setFeed({ account: null, tasks: [], error: '' }); return }
    const captured = account
    let mounted = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const readAccount = () => currentAccount(expectedOwner)
    const load = async () => {
      if (!sameActivityAccount(captured, readAccount())) { if (mounted) refresh(); return }
      const request = new AbortController()
      controller = request
      const timeout = window.setTimeout(() => request.abort(), 15_000)
      try {
        const tasks = await requestWorkspaceActivity(captured, request.signal, readAccount)
        if (mounted && sameActivityAccount(captured, readAccount())) setFeed({ account: captured, tasks, error: '' })
      } catch (error) {
        if (mounted && (error instanceof ActivitySessionChanged || !sameActivityAccount(captured, readAccount()))) {
          setFeed({ account: null, tasks: [], error: '' })
          refresh()
        } else if (mounted) {
          setFeed(previous => ({ account: captured, tasks: sameActivityAccount(previous.account, captured) ? previous.tasks : [], error: 'Task updates are unavailable. Saved work is still here.' }))
        }
      } finally {
        window.clearTimeout(timeout)
        if (mounted) timer = setTimeout(load, document.visibilityState === 'hidden' ? 15_000 : 4000)
      }
    }
    void load()
    return () => { mounted = false; clearTimeout(timer); controller?.abort() }
  }, [account?.owner, account?.token, expectedOwner, reload, refresh])

  const belongsToAccount = sameActivityAccount(feed.account, account)
  const items = useMemo(() => account
    ? mergeWorkspaceActivity(chats, activeChatIds, belongsToAccount ? remoteActivity(feed.tasks, chats) : [], [])
    : [], [chats, activeChatIds, feed.tasks, belongsToAccount, account?.owner, account?.token])
  return { items, isSample: false, error: belongsToAccount ? feed.error : '', refresh }
}
