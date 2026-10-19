import { useEffect, useId, useRef, useState } from 'react'
import { LayoutGrid, X } from 'lucide-react'
import type { ActivityChat, ActivityItem, WorkspaceActivityController } from '../../workspace/design/workspaceActivity'
import { AgentHead, agentForItem, type AgentName } from './WorkspaceAgentIdentity'
import './workspace-agent-tray.css'

export interface WorkspaceAgentTrayProps {
  chats: ActivityChat[]
  activity: WorkspaceActivityController
  onOpenChat: (id: string) => void
  onOpenMemory: () => void
  onSelectItem?: (id: string) => void
  onOpenScreens?: () => void
  onOpenPicker?: () => void
  selectedItemId?: string
}

const AGENTS: AgentName[] = ['Nalu', 'Rocky', 'Milo']
const isCurrent = (item: ActivityItem) => ['running', 'queued', 'waiting', 'failed'].includes(item.status)
const statusLabel = (item: ActivityItem) => ({ queued: 'Queued', running: 'Working', waiting: 'Needs you', done: 'Ready', saved: 'Saved', failed: 'Attention', cancelled: 'Cancelled', paused: 'Paused' })[item.status]

/** Navigation to existing work; the caller owns its account-scoped activity. */
export default function WorkspaceAgentTray({ chats, activity, onOpenChat, onOpenMemory, onSelectItem, onOpenScreens, onOpenPicker, selectedItemId }: WorkspaceAgentTrayProps) {
  const chatIds = new Set(chats.map(chat => chat.id))
  const [chosenAgent, setChosenAgent] = useState<AgentName>('Nalu')
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const panel = useRef<HTMLElement>(null)
  const cards = useRef<Partial<Record<AgentName, HTMLButtonElement | null>>>({})
  const panelId = useId()
  const selectedItem = activity.items.find(item => item.id === selectedItemId)
  const selectedAgent = selectedItem ? agentForItem(selectedItem).name : undefined
  const primaryAgent = selectedAgent || chosenAgent
  useEffect(() => { if (selectedAgent) setChosenAgent(selectedAgent) }, [selectedAgent])
  const groups = AGENTS.map((name, index) => {
    const assigned = activity.items.filter(item => agentForItem(item).name === name)
    const current = assigned.filter(isCurrent)
    const latest = [...assigned].sort((a, b) => b.updatedAt - a.updatedAt)
    const item = current.find(item => item.id === selectedItemId) || current[0]
      || latest.find(item => item.preview) || latest[0]
    return { name, index, item, current, rows: current.length ? current : item ? [item] : [] }
  })
  const hasSamples = groups.some(group => group.rows.some(item => item.preview))
  const close = () => { setOpen(false); cards.current[primaryAgent]?.focus({ preventScroll: true }) }
  const togglePicker = () => {
    if (open) { close(); return }
    onOpenPicker?.()
    setOpen(true)
  }
  const selectItem = (item: ActivityItem) => {
    const name = agentForItem(item).name
    setChosenAgent(name)
    setOpen(false)
    // Keep the parent screen's return-focus target mounted after this picker
    // closes, rather than letting it remember a disappearing picker row.
    cards.current[name]?.focus({ preventScroll: true })
    if (onSelectItem) onSelectItem(item.id)
    else if (item.chatId && chatIds.has(item.chatId)) onOpenChat(item.chatId)
    else onOpenMemory()
  }
  const openAll = () => { close(); (onOpenScreens || onOpenMemory)() }

  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      setOpen(false); cards.current[primaryAgent]?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, primaryAgent])

  return <aside ref={root} className="workspace-agent-tray" aria-label="Agent workspaces">
    <div className="agent-tray-cards" role="group" aria-label="Choose an agent workspace">
      {groups.map(({ name, index, item, current }) => {
        const primary = name === primaryAgent
        const status = item ? statusLabel(item) : 'No activity'
        const summary = item ? `${name}: ${item.title} — ${item.preview ? 'Sample · ' : ''}${status}` : `${name}: no activity`
        const detail = item?.pendingQuestion?.text || item?.detail || item?.events[item.events.length - 1]?.m || ''
        const others = current.length > 1 ? `\n${current.length - 1} more active workspace${current.length > 2 ? 's' : ''} in All workspaces.` : ''
        return <button ref={element => { cards.current[name] = element }} type="button" key={name} className="agent-tray-card" data-agent={name.toLowerCase()} data-status={item?.status || 'idle'} data-primary={primary}
          data-stack-layer={3 - Math.abs(index - AGENTS.indexOf(primaryAgent))}
          aria-label={primary ? `${name}: ${open ? 'close' : 'open'} agent activity` : summary}
          aria-haspopup={primary ? 'dialog' : undefined} aria-expanded={primary ? open : undefined}
          aria-controls={primary && open ? panelId : undefined}
          aria-pressed={!primary ? !!item && selectedItemId === item.id : undefined} disabled={!primary && !item}
          title={summary + (detail ? '\n' + detail : '') + others} onClick={() => primary ? togglePicker() : item && selectItem(item)}>
          <AgentHead name={name} className="agent-card-head"/>
          <span className="agent-card-copy"><strong>{name}</strong><span className="agent-card-status">{status}</span>
            {item?.preview && <small>Sample</small>}
          </span>
        </button>
      })}
    </div>
    <button type="button" className="agent-tray-overview" aria-label="All agent workspaces" title="All workspaces" onClick={openAll}>
      <LayoutGrid size={14} strokeWidth={1.7} aria-hidden="true"/>
    </button>
    {open && <section ref={panel} id={panelId} className="agent-tray-picker" role="dialog" aria-labelledby={`${panelId}-title`} tabIndex={-1}>
      <header className="agent-tray-picker-header">
        <div><h2 id={`${panelId}-title`}>Agent activity</h2><p>{hasSamples ? 'Includes sample activity' : 'Your current work'}</p></div>
        <button type="button" className="agent-tray-close" aria-label="Close agent activity" onClick={close}><X size={16} aria-hidden="true"/></button>
      </header>
      <div className="agent-tray-picker-list">
        {groups.flatMap(({ name, rows }) => (rows.length ? rows : [undefined]).map((item, index) => {
          const status = item ? `${item.preview ? 'Sample · ' : ''}${statusLabel(item)}` : 'No activity'
          const detail = item?.pendingQuestion?.text || item?.detail || item?.events[item.events.length - 1]?.m || ''
          const title = item?.title || 'No current workspace'
          return <button type="button" key={item?.id || `${name}-${index}`} className="agent-tray-picker-task" data-agent={name.toLowerCase()} data-status={item?.status || 'idle'}
            aria-label={`${name}: ${title} — ${status}`} aria-pressed={!!item && selectedItemId === item.id}
            title={`${title}${detail ? '\n' + detail : ''}`} disabled={!item} onClick={() => item && selectItem(item)}>
            <span className="agent-picker-face"><AgentHead name={name} className="agent-picker-head"/></span>
            <span className="agent-tray-picker-copy"><strong>{name}</strong><span className="agent-tray-picker-task-title">{title}</span><span className="agent-tray-picker-task-status">{status}</span></span>
          </button>
        }))}
      </div>
      <footer className="agent-tray-picker-footer"><button type="button" className="agent-tray-all-workspaces" onClick={openAll}><LayoutGrid size={15} aria-hidden="true"/>All workspaces</button></footer>
    </section>}
  </aside>
}
