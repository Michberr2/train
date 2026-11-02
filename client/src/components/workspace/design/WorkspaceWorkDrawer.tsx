import { useEffect, useRef, useState } from 'react'
import { ChevronRight, RefreshCw, X } from 'lucide-react'
import type { ActivityItem, WorkspaceActivityController } from './workspaceActivity'

const labels = { queued: 'Queued', running: 'Working', waiting: 'Needs you', failed: 'Needs attention', done: 'Done', saved: 'Saved', cancelled: 'Stopped', paused: 'Paused' }
const active = (item: ActivityItem) => ['queued', 'running', 'waiting', 'failed', 'paused'].includes(item.status)

/** A live view of owner-scoped saved work, never a second task controller. */
export default function WorkspaceWorkDrawer({ activity, onClose, onOpen, onStop, canStop }: { activity: WorkspaceActivityController; onClose: () => void; onOpen: (item: ActivityItem) => void; onStop: (item: ActivityItem) => Promise<void> | void; canStop: (item: ActivityItem) => boolean }) {
  const [filter, setFilter] = useState('active'), [query, setQuery] = useState(''), [error, setError] = useState(''), [stopping, setStopping] = useState<string[]>([])
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  const items = activity.items.filter(item => (filter === 'all' || filter === 'active' && active(item) || filter === 'done' && !active(item)) && `${item.title} ${item.detail} ${item.swarm?.agent || ''}`.toLowerCase().includes(query.toLowerCase()))
  const groups = new Map<string, { title: string; items: ActivityItem[] }>()
  for (const item of items) {
    const key = item.swarm?.projectId || (item.source === 'chat' || item.source === 'studio' ? 'conversations' : 'other-work')
    if (!groups.has(key)) groups.set(key, { title: item.swarm?.projectTitle || (key === 'conversations' ? 'Your conversations' : 'Background work'), items: [] })
    groups.get(key)!.items.push(item)
  }
  const stop = async (item: ActivityItem) => {
    setStopping(ids => [...ids, item.id]); setError('')
    try { await onStop(item) } catch (reason) { setError(reason instanceof Error ? reason.message : 'This work could not be stopped. Please retry.') }
    finally { setStopping(ids => ids.filter(id => id !== item.id)) }
  }
  return <aside className="workspace-work-drawer" role="dialog" aria-modal="false" aria-label="All agent work" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><div><span>YOUR NALU SWARM</span><h2>Everything in motion.</h2><p>{activity.items.filter(item => item.status === 'running').length} working · {activity.items.filter(item => item.status === 'queued').length} queued · {activity.items.filter(item => ['waiting', 'failed'].includes(item.status)).length} need you</p></div><button ref={close} type="button" aria-label="Close work drawer" onClick={onClose}><X size={18}/></button></header>
    <div className="workspace-work-drawer-tools"><input aria-label="Find agent work" placeholder="Find a project, agent, or task" value={query} onChange={event => setQuery(event.target.value)}/><button type="button" aria-label="Refresh agent work" onClick={activity.refresh}><RefreshCw size={16}/></button></div>
    <nav aria-label="Work filters">{[['active', 'Active'], ['all', 'Everything'], ['done', 'Finished']].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</nav>
    {(error || activity.error) && <p className="workspace-work-error" role="alert">{error || activity.error}</p>}
    <div className="workspace-work-drawer-list">{Array.from(groups, ([id, group]) => <section key={id} aria-label={group.title}><h3>{group.title}<span>{group.items.length}</span></h3>{group.items.map(item => <article key={item.id} data-work-status={item.status}>
      <div className="workspace-work-row"><span className="workspace-work-state">{labels[item.status]}</span><span>{item.swarm?.agent || 'Nalu'}</span></div>
      <h4>{item.swarm ? item.title.replace(`${item.swarm.projectTitle} · `, '') : item.title}</h4><p>{item.pendingQuestion?.text || item.detail || 'Updates will appear here as the work progresses.'}</p>
      {item.events.length > 0 && <details><summary>Latest actions</summary><ol>{item.events.slice(-8).map((event, index) => <li key={`${event.t}-${index}`}><time>{new Date(event.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><span>{event.m}</span></li>)}</ol></details>}
      <footer><button type="button" onClick={() => onOpen(item)}>{item.swarm ? 'Talk to this swarm' : item.chatId ? 'Open conversation' : 'View work'}<ChevronRight size={14}/></button>{canStop(item) && <button type="button" disabled={stopping.includes(item.id)} onClick={() => void stop(item)}>{stopping.includes(item.id) ? 'Stopping…' : 'Stop'}</button>}</footer>
    </article>)}</section>)}{items.length === 0 && <div className="workspace-work-empty"><h3>{filter === 'active' ? 'Nothing running right now.' : 'No matching work.'}</h3><p>Ask Nalu for something in chat. Work from every project will appear here, including jobs running in the background.</p></div>}</div>
  </aside>
}
