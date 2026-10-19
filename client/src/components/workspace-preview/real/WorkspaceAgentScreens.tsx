import { useEffect, useId, useMemo, useRef, useState } from 'react'
import ArtifactPreview from './ArtifactPreview'
import { AgentHead, agentForItem } from './WorkspaceAgentIdentity'
import type { ActivityChat, ActivityItem, WorkspaceActivityController } from '../../workspace/design/workspaceActivity'
import './workspace-agent-screens.css'

export type WorkspaceAgentScreensProps = {
  chats: ActivityChat[]
  activity: WorkspaceActivityController
  selectedItemId: string | null
  onSelectItem: (id: string | null) => void
  onOpenChat: (id: string) => void
  onOpenSwarm?: (room: NonNullable<ActivityItem['swarm']>) => void
  onOpenSpace?: (view: 'agents' | 'studio' | 'map') => void
  onClose: () => void
}
const statusText = (item: ActivityItem) => ({ queued: 'Queued', running: 'Working', waiting: 'Needs you', failed: 'Needs attention', done: 'Completed', saved: 'Saved', cancelled: 'Stopped', paused: 'Paused' })[item.status]
const priority = (item: ActivityItem) => ({ running: 0, waiting: 1, queued: 2, failed: 3, paused: 4, done: 5, saved: 6, cancelled: 7 })[item.status]
const progressValue = (item: ActivityItem) => typeof item.progress === 'number' && Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : undefined
const readableTime = (value: string | number) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
}

function SavedWork({ chat, item }: { chat?: ActivityChat; item: ActivityItem }) {
  const messages = chat?.messages || []
  const source = [...messages].reverse().find(message => message.design || message.doc || message.sheet || message.deck || message.video || message.cad || message.image || (message.role === 'assistant' && /^!\[[^\]]*\]\(/.test(message.content || '')))
  const user = [...messages].reverse().find(message => message.role === 'user')
  const reply = [...messages].reverse().find(message => message.role === 'assistant' && message.content)
  return chat ? <ArtifactPreview source={source} title={item.title} conversation={{ user: user?.content, reply: reply?.content }}/>
    : <div className="agent-screen-no-artifact"><strong>{item.title}</strong><p>{item.detail || 'This task has no saved preview yet.'}</p><span>Task updates appear alongside this screen.</span></div>
}

function Status({ item }: { item: ActivityItem }) {
  return <span className="agent-screen-status" data-status={item.status}><i aria-hidden="true"/>{statusText(item)}</span>
}

function WindowTitlebar({ item }: { item: ActivityItem }) {
  return <div className="agent-window-titlebar"><span className="agent-window-traffic" aria-hidden="true"><i/><i/><i/></span><span className="agent-window-document-title">{item.title}</span><Status item={item}/></div>
}

function DesktopWindow({ item, chat, onSelect }: { item: ActivityItem; chat?: ActivityChat; onSelect: () => void }) {
  const agent = agentForItem(item)
  const progress = progressValue(item)
  return <button className="agent-desktop-window" onClick={onSelect} aria-label={`Open ${agent.name}’s workspace: ${item.title}. ${statusText(item)}.`}>
    <WindowTitlebar item={item}/>
    <div className="agent-window-preview"><SavedWork chat={chat} item={item}/></div>
    <span className="agent-window-caption"><strong>{agent.name} · {item.title}</strong><span>{item.pendingQuestion?.text || item.detail}</span></span>
    {progress !== undefined && (item.status === 'running' || item.status === 'queued') && <span className="agent-window-progress" aria-hidden="true"><i style={{ width: `${progress * 100}%` }}/></span>}
  </button>
}

export default function WorkspaceAgentScreens({ chats, activity, selectedItemId, onSelectItem, onOpenChat, onOpenSwarm, onOpenSpace, onClose }: WorkspaceAgentScreensProps) {
  const demo = activity.demo
  const root = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [page, setPage] = useState(0)
  const byChat = useMemo(() => new Map(chats.map(chat => [chat.id, chat])), [chats])
  const allItems = useMemo(() => {
    const seen = new Set<string>()
    return [...activity.items].sort((a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt).filter(item => {
      const key = item.chatId || item.id
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  }, [activity.items])
  const activeItems = allItems.filter(item => ['running', 'queued', 'waiting', 'failed'].includes(item.status))
  const items = activeItems.length ? activeItems : allItems
  const selected = allItems.find(item => item.id === selectedItemId)
  const totalPages = Math.max(1, Math.ceil(items.length / 4))
  const currentPage = Math.min(page, totalPages - 1)
  const visible = items.slice(currentPage * 4, currentPage * 4 + 4)
  const selectedChat = selected?.chatId ? byChat.get(selected.chatId) : undefined
  const selectedAgent = selected ? agentForItem(selected) : null
  const progress = selected ? progressValue(selected) : undefined

  useEffect(() => { root.current?.focus({ preventScroll: true }) }, [selectedItemId])
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.agent-tray-picker, .workspace-chat-popover')) return
      event.preventDefault(); event.stopPropagation(); onClose()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onClose])
  return <div ref={root} className="workspace-agent-screens" role="dialog" aria-labelledby={titleId} tabIndex={-1} data-focused={!!selected}>
    <header className="agent-screens-header"><div>{selected && <button className="agent-screens-back" onClick={() => onSelectItem(null)}><span aria-hidden="true">←</span> All workspaces</button>}<h1 id={titleId}>{selected ? `${selectedAgent?.name}’s workspace` : 'Agent workspaces'}</h1><p>{selected ? selected.title : 'Separate spaces for everything taking shape.'}</p></div><button className="agent-screens-close" onClick={onClose} aria-label="Close agent workspaces">Close <span aria-hidden="true">×</span></button></header>
    {activity.isSample && demo && <div className="agent-screens-sample"><span><i aria-hidden="true"/>Sample screens <span>· simulated activity</span></span><button aria-pressed={demo.playing} onClick={() => demo.setPlaying(!demo.playing)}>{demo.playing ? 'Pause updates' : 'Play updates'}</button></div>}
    {activity.error && <div className="agent-screens-error" role="status"><span>{activity.error}</span><button onClick={activity.refresh}>Refresh</button></div>}
    <div className="agent-screens-scroll">
      {selected && selectedAgent ? <div className="agent-screen-focus">
        <section className="agent-screen-focus-window" aria-label={`${selectedAgent.name} saved work preview`}><WindowTitlebar item={selected}/><div className="agent-screen-focus-artifact"><SavedWork chat={selectedChat} item={selected}/></div><div className="agent-screen-preview-note">{selected.preview ? 'Saved sample work' : 'Latest saved work'}<span>Open chat to continue or interact</span></div></section>
        <aside className="agent-screen-detail" aria-label="Workspace details"><div className="agent-screen-detail-heading"><AgentHead name={selectedAgent.name} className="agent-detail-head"/><div><strong>{selectedAgent.name}</strong><Status item={selected}/></div></div><h2>{selected.title}</h2><p className="agent-screen-detail-copy">{selected.pendingQuestion?.text || selected.detail || 'Your saved work is ready to return to.'}</p>
          {progress !== undefined && (selected.status === 'running' || selected.status === 'queued') && <div className="agent-screen-detail-progress"><div><span>{selected.preview ? 'Sample progress' : 'Progress'}</span><strong>{Math.round(progress * 100)}%</strong></div><progress value={progress} max={1} aria-label={`${selected.preview ? 'Sample progress' : 'Progress'}: ${selected.title}`}/></div>}
          {selected.swarm && onOpenSwarm ? <button className="agent-screen-open-chat" onClick={() => onOpenSwarm(selected.swarm!)}>Open {selected.swarm.thread === 'group' ? 'group conversation' : `${selected.swarm.thread} chat`}<span aria-hidden="true">↗</span></button> : selectedChat ? <button className="agent-screen-open-chat" onClick={() => onOpenChat(selectedChat.id)}>{selected.status === 'waiting' ? 'Review in chat' : 'Open chat'}<span aria-hidden="true">↗</span></button> : !selected.preview && onOpenSpace ? <button className="agent-screen-open-chat" onClick={() => onOpenSpace('agents')}>Open Autopilot<span aria-hidden="true">↗</span></button> : <p className="agent-screen-unlinked">This task has no linked conversation.</p>}
          {selected.events.length > 0 && <div className="agent-screen-updates"><h3>Latest updates</h3><ol>{selected.events.slice(-3).reverse().map((event, index) => <li key={`${event.t}-${index}`}><p>{event.m}</p><time dateTime={event.t}>{readableTime(event.t)}</time></li>)}</ol></div>}
          <div className="agent-screen-other-workers"><h3>Other workspaces</h3><div>{items.filter(item => item.id !== selected.id).map(item => { const agent = agentForItem(item); return <button key={item.id} onClick={() => onSelectItem(item.id)}><AgentHead name={agent.name} className="agent-other-head"/><span><strong>{agent.name}</strong><span>{item.title}</span></span><i data-status={item.status} aria-label={statusText(item)}/></button> })}{items.every(item => item.id === selected.id) && <p>No other workspaces right now.</p>}</div></div>
        </aside>
      </div> : items.length > 0 ? <><div className="agent-screen-grid" data-count={visible.length}>{visible.map(item => <DesktopWindow key={item.id} item={item} chat={item.chatId ? byChat.get(item.chatId) : undefined} onSelect={() => onSelectItem(item.id)}/>)}</div>{totalPages > 1 && <nav className="agent-screen-pages" aria-label="Workspace pages"><button disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>Previous</button><span>{currentPage + 1} of {totalPages}</span><button disabled={currentPage === totalPages - 1} onClick={() => setPage(currentPage + 1)}>Next workspaces</button></nav>}</> : <div className="agent-screens-empty"><h2>A space for your next idea.</h2><p>Your workspaces appear here as you start conversations and create things with Nalu.</p><button onClick={onClose}>Back to Nalu</button></div>}
    </div>
  </div>
}
