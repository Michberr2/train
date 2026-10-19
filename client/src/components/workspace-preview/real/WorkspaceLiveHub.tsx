import { useId, useMemo, useState, type ReactNode } from 'react'
import type { ActivityChat, ActivityItem, WorkspaceActivityController } from '../../workspace/design/workspaceActivity'
import ArtifactPreview from './ArtifactPreview'
import './workspace-live-hub.css'

export type HubProps = {
  chats: ActivityChat[]
  activity: WorkspaceActivityController
  onOpenChat: (id: string) => void
  onNewChat: () => void
  onOpenSpace?: (view: 'agents' | 'studio' | 'map') => void
  savedMemory: ReactNode
}
type WorkFilter = 'all' | 'working' | 'attention' | 'finished'
const isWorking = (item: ActivityItem) => item.status === 'running' || item.status === 'queued'
const needsAttention = (item: ActivityItem) => item.status === 'waiting' || item.status === 'failed'
const isRecent = (item: ActivityItem) => item.status === 'done' || item.status === 'saved' || item.status === 'cancelled'
const statusLabel = (item: ActivityItem) => ({ queued: 'Queued', running: 'In progress', waiting: 'Needs you', done: 'Completed', saved: 'Saved', failed: 'Needs attention', cancelled: 'Stopped' })[item.status]
const timestamp = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''

function ArtifactThumbnail({ chat, compact = false }: { chat?: ActivityChat; compact?: boolean }) {
  const messages = chat?.messages || []
  const source = [...messages].reverse().find(message => message.design || message.doc || message.sheet || message.deck || message.video || message.cad || message.image || (message.role === 'assistant' && /^!\[[^\]]*\]\(/.test(message.content || '')))
  const user = [...messages].reverse().find(message => message.role === 'user')
  const reply = [...messages].reverse().find(message => message.role === 'assistant' && message.content)
  return <div className="live-hub-thumbnail" data-compact={compact}>
    <ArtifactPreview source={source} title={chat?.title || 'Saved work'} compact={compact} conversation={{ user: user?.content, reply: reply?.content }}/>
  </div>
}

function ActivityTimeline({ item }: { item: ActivityItem }) {
  return <details className="live-hub-activity">
    <summary><span>Activity</span><span aria-hidden="true">+</span></summary>
    <div className="live-hub-activity-body">
      {item.pendingQuestion && <div className="live-hub-question"><span>Waiting for your input</span><p>{item.pendingQuestion.text}</p></div>}
      {item.events.length ? <ol>{item.events.slice(-6).map((event, index) => <li key={`${event.t}-${index}`}><span aria-hidden="true"/><div><p>{event.m}</p><time dateTime={event.t}>{timestamp(Date.parse(event.t))}</time></div></li>)}</ol> : <p className="live-hub-no-events">{item.detail || 'No additional updates yet.'}</p>}
      {item.preview && <p className="live-hub-sample-note">Sample timeline. No background task is executing.</p>}
    </div>
  </details>
}

function WorkCard({ item, chat, onOpenChat, onOpenSpace }: { item: ActivityItem; chat?: ActivityChat; onOpenChat: HubProps['onOpenChat']; onOpenSpace?: HubProps['onOpenSpace'] }) {
  const sourceSpace = item.source === 'pipeline' || item.source === 'autopilot' ? 'agents' : item.source === 'studio' ? 'studio' : item.source === 'map' ? 'map' : !item.preview ? 'agents' : undefined
  const progress = typeof item.progress === 'number' && Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : undefined
  return <article className="live-hub-card" data-status={item.status}>
    <div className="live-hub-card-heading"><span className="live-hub-status"><i aria-hidden="true"/>{statusLabel(item)}</span><span>{item.preview ? 'SAMPLE WORK' : item.source}</span></div>
    <ArtifactThumbnail chat={chat}/>
    <div className="live-hub-card-copy"><h3>{item.title}</h3><p>{item.pendingQuestion?.text || item.detail || 'Open the conversation to pick up the details.'}</p>
      {isWorking(item) && progress !== undefined && <div className="live-hub-progress" role="progressbar" aria-label={`${item.preview ? 'Sample progress' : 'Progress'}: ${item.title}`} aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress * 100}%` }}/></div>}
      <div className="live-hub-update"><span>{item.preview ? 'Sample update' : 'Updated'} {timestamp(item.updatedAt)}</span>{isWorking(item) && progress !== undefined && <span>{Math.round(progress * 100)}%</span>}</div>
    </div>
    <div className="live-hub-card-actions">
      {chat ? <button className="live-hub-open" onClick={() => onOpenChat(chat.id)}>{item.status === 'waiting' ? 'Review in chat' : 'Open chat'}<span aria-hidden="true">↗</span></button>
        : sourceSpace && onOpenSpace ? <button className="live-hub-open" onClick={() => onOpenSpace(sourceSpace)}>Open {sourceSpace === 'agents' ? 'Autopilot' : sourceSpace === 'studio' ? 'Studio' : 'Map'}<span aria-hidden="true">↗</span></button>
        : <span className="live-hub-no-source">Updates from {item.source || 'your task'}</span>}
    </div>
    <ActivityTimeline item={item}/>
  </article>
}

export default function WorkspaceLiveHub({ chats, activity, onOpenChat, onNewChat, onOpenSpace, savedMemory }: HubProps) {
  const demo = activity.demo
  const [tab, setTab] = useState<'live' | 'saved'>('live')
  const [filter, setFilter] = useState<WorkFilter>('all')
  const tabId = useId()
  const byChat = useMemo(() => new Map(chats.map(chat => [chat.id, chat])), [chats])
  const working = activity.items.filter(isWorking)
  const attention = activity.items.filter(needsAttention)
  const finished = activity.items.filter(isRecent)
  const currentWork = activity.items.filter(item => isWorking(item) || needsAttention(item))
  const visibleWork = filter === 'working' ? working : filter === 'attention' ? attention : filter === 'finished' ? finished : currentWork
  const savedWork = finished.filter(item => item.chatId && byChat.has(item.chatId)).slice(0, 6)
  const filters: { key: WorkFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All work', count: activity.items.length },
    { key: 'working', label: 'In progress', count: working.length },
    { key: 'attention', label: 'Needs you', count: attention.length },
    { key: 'finished', label: 'Recent', count: finished.length },
  ]
  return <section className="workspace-live-hub" aria-label="Your work">
    <header className="live-hub-header"><div><h1>Memory</h1><p>Your work, in motion. See what’s taking shape, what needs you, and where to pick things up.</p></div><button onClick={onNewChat}>Start something new<span aria-hidden="true">+</span></button></header>
    <div className="live-hub-tabs" role="tablist" aria-label="Memory views" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const next = event.key === 'Home' ? 'live' : event.key === 'End' ? 'saved' : tab === 'live' ? 'saved' : 'live'
      setTab(next)
      document.getElementById(`${tabId}-${next}-tab`)?.focus()
    }}>
      <button id={`${tabId}-live-tab`} role="tab" tabIndex={tab === 'live' ? 0 : -1} aria-selected={tab === 'live'} aria-controls={`${tabId}-live`} onClick={() => setTab('live')}>Live work<span>{working.length + attention.length}</span></button>
      <button id={`${tabId}-saved-tab`} role="tab" tabIndex={tab === 'saved' ? 0 : -1} aria-selected={tab === 'saved'} aria-controls={`${tabId}-saved`} onClick={() => setTab('saved')}>Saved context</button>
    </div>
    <div id={`${tabId}-live`} role="tabpanel" aria-labelledby={`${tabId}-live-tab`} hidden={tab !== 'live'} className="live-hub-live">
      {activity.isSample && demo && <div className="live-hub-demo"><div><span className="live-hub-demo-dot" aria-hidden="true"/><p><strong>Sample activity</strong><span> · simulated updates</span></p></div><div><button aria-pressed={demo.playing} onClick={() => demo.setPlaying(!demo.playing)}>{demo.playing ? 'Pause updates' : 'Play updates'}</button><button onClick={demo.reset}>Reset</button></div></div>}
      {activity.error && <div className="live-hub-error" role="status"><p>{activity.error}</p><button onClick={activity.refresh}>Refresh</button></div>}
      <div className="live-hub-filters" aria-label="Filter work">{filters.map(option => <button key={option.key} aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>{option.label}<span>{option.count}</span></button>)}</div>
      <div className="live-hub-section-heading"><h2>{filter === 'all' ? 'Happening now' : filters.find(option => option.key === filter)?.label}</h2><span>{visibleWork.length} {visibleWork.length === 1 ? 'thread' : 'threads'}</span></div>
      {visibleWork.length ? <div className="live-hub-work-grid">{visibleWork.map(item => <WorkCard key={item.id} item={item} chat={item.chatId ? byChat.get(item.chatId) : undefined} onOpenChat={onOpenChat} onOpenSpace={onOpenSpace}/>)}</div>
        : <div className="live-hub-empty"><h3>{filter === 'attention' ? 'Nothing waiting on you.' : filter === 'finished' ? 'Room for what comes next.' : 'A quiet moment.'}</h3><p>{filter === 'attention' ? 'When a task needs your input, you’ll find it here.' : 'Start a conversation. Your work will have a place here as it takes shape.'}</p><button onClick={onNewChat}>Start a conversation<span aria-hidden="true">↗</span></button></div>}
      {filter === 'all' && savedWork.length > 0 && <section className="live-hub-saved-work" aria-label="Recent saved work"><div className="live-hub-section-heading"><h2>Ready to return to</h2><button onClick={() => setFilter('finished')}>See recent work <span aria-hidden="true">↗</span></button></div><div className="live-hub-saved-grid">{savedWork.map(item => { const chat = byChat.get(item.chatId!)!; return <button key={item.id} className="live-hub-saved-card" onClick={() => onOpenChat(chat.id)}><ArtifactThumbnail chat={chat} compact/><div><span>{item.status === 'saved' ? 'Saved conversation' : statusLabel(item)}</span><strong>{item.title}</strong><span className="live-hub-saved-open">Open chat <span aria-hidden="true">↗</span></span></div></button> })}</div></section>}
    </div>
    <div id={`${tabId}-saved`} role="tabpanel" aria-labelledby={`${tabId}-saved-tab`} hidden={tab !== 'saved'} className="live-hub-saved-context">{savedMemory}</div>
  </section>
}
