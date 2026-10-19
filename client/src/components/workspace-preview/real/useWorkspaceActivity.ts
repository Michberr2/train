import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { PREVIEW_OWNER, PREVIEW_TOKEN, PREVIEW_VERSION } from './fixtures'
import {
  createActivityDemo, demoPlaying, mergeWorkspaceActivity, remoteActivity,
  sampleActivity, setActivityDemoPlaying, type ActivityChat,
} from './workspaceActivityModel'
export type { ActivityChat, ActivityItem, ActivityStatus, ActivityMessage } from './workspaceActivityModel'

// This clock belongs only to the local demonstration. It survives switching
// between Memory and a conversation without timers or work running off-screen.
let demo = createActivityDemo(Date.now())
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => demo
const notify = () => { for (const listener of listeners) listener() }

function isPreviewSession(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined' || !['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) return false
  try {
    return localStorage.getItem('nalu-data-owner') === PREVIEW_OWNER
      && localStorage.getItem('nalu-token') === PREVIEW_TOKEN
      && localStorage.getItem('nalu-workspace-preview-version') === PREVIEW_VERSION
  } catch { return false }
}
const identity = () => { try { return `${localStorage.getItem('nalu-data-owner') || ''}\n${localStorage.getItem('nalu-token') || ''}` } catch { return '' } }

export function useWorkspaceActivity({ chats, activeChatIds }: { chats: ActivityChat[]; activeChatIds: readonly string[] }) {
  const clock = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [now, setNow] = useState(Date.now)
  const [reload, setReload] = useState(0)
  const [feed, setFeed] = useState<{ account: string; tasks: unknown[] }>({ account: '', tasks: [] })
  const [error, setError] = useState('')
  const allowed = isPreviewSession()

  useEffect(() => {
    setNow(Date.now())
    if (!allowed || clock.startedAt === null) return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (!demoPlaying(demo, current)) {
        demo = setActivityDemoPlaying(demo, false, current)
        notify(); window.clearInterval(timer)
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [allowed, clock.startedAt])

  useEffect(() => {
    const refreshAccount = (event?: Event) => {
      if (event instanceof StorageEvent && event.key && !['nalu-token', 'nalu-data-owner', 'nalu-workspace-preview-version'].includes(event.key)) return
      setReload(value => value + 1)
    }
    window.addEventListener('storage', refreshAccount)
    window.addEventListener('nalu-session-cleared', refreshAccount)
    window.addEventListener('nalu-hydrated', refreshAccount)
    return () => {
      window.removeEventListener('storage', refreshAccount)
      window.removeEventListener('nalu-session-cleared', refreshAccount)
      window.removeEventListener('nalu-hydrated', refreshAccount)
    }
  }, [])

  useEffect(() => {
    if (!allowed) { setFeed({ account: '', tasks: [] }); setError(''); return }
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const load = async () => {
      if (!isPreviewSession()) { if (current) { setFeed({ account: '', tasks: [] }); setError(''); setNow(Date.now()) } return }
      const account = identity()
      controller = new AbortController()
      const request = controller
      const timeout = window.setTimeout(() => request.abort(), 15_000)
      try {
        const response = await fetch('/api/data', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PREVIEW_TOKEN}` },
          body: JSON.stringify({ action: 'task-feed' }), signal: request.signal,
        })
        const data: unknown = await response.json()
        const tasks = data && typeof data === 'object' && 'tasks' in data ? data.tasks : null
        if (!response.ok || !Array.isArray(tasks)) throw new Error('Task updates are unavailable. Saved work is still here.')
        if (current && isPreviewSession() && identity() === account) { setFeed({ account, tasks }); setError('') }
      } catch {
        if (current && isPreviewSession() && identity() === account) setError('Task updates are unavailable. Saved work is still here.')
      } finally {
        window.clearTimeout(timeout)
        if (current) timer = setTimeout(load, document.visibilityState === 'hidden' ? 15_000 : 4000)
      }
    }
    void load()
    return () => { current = false; clearTimeout(timer); controller?.abort() }
  }, [allowed, reload])

  const setPlaying = useCallback((value: boolean) => {
    if (!isPreviewSession()) return
    const current = Date.now()
    demo = setActivityDemoPlaying(demo, value, current)
    setNow(current); notify()
  }, [])
  const resetDemo = useCallback(() => {
    if (!isPreviewSession()) return
    const current = Date.now()
    demo = createActivityDemo(current)
    setNow(current); notify()
  }, [])
  const refresh = useCallback(() => setReload(value => value + 1), [])
  const remote = allowed && feed.account === identity() ? remoteActivity(feed.tasks, chats) : []
  const samples = allowed ? sampleActivity(chats, clock, now) : []
  const items = mergeWorkspaceActivity(chats, activeChatIds, remote, samples)
  const isSample = items.some(item => item.preview)
  return { items, isSample, playing: allowed && isSample && demoPlaying(clock, now), setPlaying, resetDemo, error: allowed ? error : '', refresh }
}

export default useWorkspaceActivity
