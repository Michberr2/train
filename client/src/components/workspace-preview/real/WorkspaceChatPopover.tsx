import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import NaluMark from '../../landing/NaluMark'
import WorkspaceSwarm from './WorkspaceSwarm'
import { isSwarmRoom, type SwarmController, type SwarmThread, type SwarmRoomReference } from '../../workspace/design/swarmTypes'
import { AgentHead, type AgentName } from './WorkspaceAgentIdentity'
import './workspace-chat-popover.css'

export type WorkspaceChatPopoverProps = {
  swarm?: SwarmController
  swarmNavigationRequest?: SwarmRoomReference & { key: number }
  agentConversationRequest?: { agent: AgentName; key: number }
  persistenceKey?: string
  fullPageAnchor?: HTMLElement | null
  fullPageVisible?: boolean
  onChatVisibilityChange?: (visible: boolean) => void
  open: boolean
  onOpen: () => void
  onClose: () => void
  onNewChat: () => void
  title: string
  history: ReactNode | ((showChatDetails: boolean) => ReactNode)
  chatTools?: ReactNode
  chatItems: { id: string; title: string }[]
  activeChatId: string | null
  onSelectChat: (id: string) => void
  children: ReactNode
}

const HIDDEN_TABS_KEY = 'workspace-preview-hidden-chat-tabs-v1'
const chatTabId = (id: string) => `chat:${encodeURIComponent(id)}`
const swarmTabId = (projectId: string, thread: SwarmThread) => `swarm:${encodeURIComponent(projectId)}:${thread}`
function loadHiddenTabs(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && /^(chat|swarm):/.test(id) && id.length <= 1000))].slice(-1000) : []
  } catch { return [] }
}
function QuickTab({ label, active, onOpen, onHide, children }: { label: string; active: boolean; onOpen: () => void; onHide: () => void; children: ReactNode }) {
  return <div className="workspace-chat-quick-tab" data-active={active}>
    <button type="button" className="workspace-chat-quick-tab-open" title={label} aria-label={label} aria-pressed={active} onClick={onOpen}>{children}</button>
    <button type="button" className="workspace-chat-quick-tab-close" title={`Hide ${label} from quick tabs`} aria-label={`Hide ${label} from quick tabs`} onClick={onHide}><span aria-hidden="true">×</span></button>
  </div>
}

/** Window presentation: callers supply the real chat renderer and optional Swarm controller. */
export default function WorkspaceChatPopover({ swarm, swarmNavigationRequest, agentConversationRequest, persistenceKey = HIDDEN_TABS_KEY, fullPageAnchor, fullPageVisible = false, onChatVisibilityChange, open, onOpen, onClose, onNewChat, title, history, chatTools, chatItems, activeChatId, onSelectChat, children }: WorkspaceChatPopoverProps) {
  const launcher = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const expand = useRef<HTMLButtonElement>(null)
  const historyToggle = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const startsInSwarm = !!swarm && new URLSearchParams(location.search).get('swarm') === '1'
  const [maximized, setMaximized] = useState(startsInSwarm)
  const [historyOpen, setHistoryOpen] = useState(() => startsInSwarm && !window.matchMedia('(max-width: 767px)').matches)
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches)
  const [selectedConversation, setConversation] = useState<'chat' | 'swarm'>(startsInSwarm ? 'swarm' : 'chat')
  const conversation = swarm ? selectedConversation : 'chat'
  const [hasShownChat, setHasShownChat] = useState(open || fullPageVisible)
  const [inlineBounds, setInlineBounds] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const surfaceVisible = open || fullPageVisible && !!inlineBounds
  const ordinaryVisible = surfaceVisible && (!open || conversation === 'chat')
  const [swarmNavigation, setSwarmNavigation] = useState(0)
  const [startingAgent, setStartingAgent] = useState<AgentName>()
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpQuery, setJumpQuery] = useState('')
  const jumpTrigger = useRef<HTMLButtonElement>(null)
  const jumpInput = useRef<HTMLInputElement>(null)
  const quickHome = useRef<HTMLButtonElement>(null)
  const quickTabs = useRef<HTMLElement>(null)
  const [recentChats, setRecentChats] = useState<string[]>([])
  const [hiddenTabState, setHiddenTabState] = useState(() => ({ key: persistenceKey, ids: loadHiddenTabs(persistenceKey) }))
  const hiddenTabs = hiddenTabState.key === persistenceKey ? hiddenTabState.ids : loadHiddenTabs(persistenceKey)
  const activeProject = swarm?.state.projects.find(project => project.id === swarm.activeProjectId)
  const restoreQuickTab = useCallback((id: string) => setHiddenTabState(current => {
    const ids = current.key === persistenceKey ? current.ids : loadHiddenTabs(persistenceKey)
    return ids.includes(id) ? { key: persistenceKey, ids: ids.filter(hidden => hidden !== id) } : current.key === persistenceKey ? current : { key: persistenceKey, ids }
  }), [persistenceKey])
  const hideQuickTab = (id: string) => {
    setHiddenTabState(current => {
      const ids = current.key === persistenceKey ? current.ids : loadHiddenTabs(persistenceKey)
      return { key: persistenceKey, ids: ids.includes(id) ? ids : [...ids, id].slice(-1000) }
    })
    requestAnimationFrame(() => quickHome.current?.focus())
  }
  const showChat = (id: string) => { restoreQuickTab(chatTabId(id)); setConversation('chat'); onSelectChat(id); setJumpOpen(false); setNewMenuOpen(false); if (mobile) setHistoryOpen(false); focusComposer() }
  const showSwarm = (projectId: string, thread: SwarmThread = 'group') => {
    if (!swarm) return
    setStartingAgent(undefined)
    restoreQuickTab(swarmTabId(projectId, thread))
    swarm.navigate(projectId, thread); setConversation('swarm'); setJumpOpen(false); setNewMenuOpen(false)
    setSwarmNavigation(value => value + 1)
    if (mobile) setHistoryOpen(false)
    focusComposer()
  }
  const createChat = () => { setNewMenuOpen(false); setConversation('chat'); if (mobile) setHistoryOpen(false); onNewChat(); focusComposer() }
  const createSwarm = () => { if (!swarm) return; setStartingAgent(undefined); setConversation('swarm'); swarm.setCreating(true); setNewMenuOpen(false); setJumpOpen(false); if (mobile) setHistoryOpen(false) }
  const quickChoices = [
    ...(swarm?.state.projects.flatMap(project => (['group', ...project.members] as SwarmThread[]).map(thread => ({
      id: `${project.id}:${thread}`, label: thread === 'group' ? project.title : `${thread} · ${project.title}`,
      detail: thread === 'group' ? 'Swarm group' : 'Private branch · Shared group context', action: () => showSwarm(project.id, thread),
    }))) ?? []),
    ...chatItems.map(chat => ({ id: chat.id, label: chat.title, detail: 'Conversation', action: () => showChat(chat.id) })),
  ].filter(choice => jumpQuery.trim().toLowerCase().split(/\s+/).every(term => `${choice.label} ${choice.detail}`.toLowerCase().includes(term)))
  const maximizedRef = useRef(maximized)
  maximizedRef.current = maximized
  const callbacks = useRef({ onClose })
  callbacks.current = { onClose }
  const focusComposer = () => {
    requestAnimationFrame(() => {
      const input = Array.from(panel.current?.querySelectorAll<HTMLTextAreaElement>('textarea:not(:disabled)') || []).find(element => element.getClientRects().length && !element.closest('[inert]'))
      if (input) input.focus({ preventScroll: true })
      else panel.current?.focus({ preventScroll: true })
    })
  }

  const consumedSwarmNavigation = useRef<number | undefined>(undefined)
  useEffect(() => {
    const target = swarmNavigationRequest
    if (!open || !swarm || !target || consumedSwarmNavigation.current === target.key || !isSwarmRoom(swarm.state, target.projectId, target.thread)) return
    consumedSwarmNavigation.current = target.key
    showSwarm(target.projectId, target.thread)
  }, [open, swarmNavigationRequest, swarm?.state])

  const consumedAgentRequest = useRef<number | undefined>(undefined)
  useEffect(() => {
    const target = agentConversationRequest
    if (!open || !swarm || swarm.loading || !target || consumedAgentRequest.current === target.key) return
    consumedAgentRequest.current = target.key
    const project = swarm.state.projects.find(project => project.id === swarm.activeProjectId && project.members.includes(target.agent))
      || [...swarm.state.projects].sort((a, b) => b.updatedAt - a.updatedAt).find(project => project.members.includes(target.agent))
    if (project) showSwarm(project.id, target.agent)
    else {
      setStartingAgent(target.agent)
      setConversation('swarm'); swarm.setCreating(true); setNewMenuOpen(false); setJumpOpen(false)
      if (mobile) setHistoryOpen(false)
    }
  }, [open, agentConversationRequest, swarm?.loading, swarm?.state])

  useLayoutEffect(() => {
    if (open || fullPageVisible) setHasShownChat(true)
  }, [open, fullPageVisible])
  useLayoutEffect(() => {
    onChatVisibilityChange?.(ordinaryVisible)
  }, [ordinaryVisible, onChatVisibilityChange])
  useLayoutEffect(() => {
    if (open || !fullPageVisible || !fullPageAnchor) return
    let frame = 0
    const measure = () => {
      const origin = launcher.current?.getBoundingClientRect()
      if (!origin) return
      const rect = fullPageAnchor.getBoundingClientRect()
      const next = { top: rect.top - origin.top, left: rect.left - origin.left, width: rect.width, height: rect.height }
      setInlineBounds(current => current && Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(fullPageAnchor)
    if (fullPageAnchor.parentElement) observer.observe(fullPageAnchor.parentElement)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame); observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, fullPageVisible, fullPageAnchor])
  const close = () => {
    setMaximized(false)
    setJumpOpen(false); setNewMenuOpen(false)
    onClose()
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const restore = () => {
    setMaximized(false)
    requestAnimationFrame(() => expand.current?.focus({ preventScroll: true }))
  }
  const maximize = () => {
    setHistoryOpen(!mobile)
    setMaximized(true)
  }
  const hideHistory = () => {
    setHistoryOpen(false)
    requestAnimationFrame(() => historyToggle.current?.focus({ preventScroll: true }))
  }
  const isOtherDialog = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    const dialog = element?.closest('[role="dialog"],dialog')
    return !!dialog && dialog !== panel.current && !dialog.classList.contains('workspace-agent-screens')
  }
  const escape = (event: { key: string; defaultPrevented: boolean; target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void }) => {
    if (event.key !== 'Escape' || event.defaultPrevented || isOtherDialog(event.target)) return
    const otherDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"],dialog[open]')).some(dialog => dialog !== panel.current && !dialog.classList.contains('workspace-agent-screens') && dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden')
    if (otherDialog || document.fullscreenElement) return
    event.preventDefault(); event.stopPropagation()
    if (maximizedRef.current) { restore(); return }
    callbacks.current.onClose()
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }))
  }
  const onWindowKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); setJumpOpen(value => !value); setNewMenuOpen(false); return }
    if (event.key === 'Escape' && (jumpOpen || newMenuOpen)) { event.preventDefault(); event.stopPropagation(); setJumpOpen(false); setNewMenuOpen(false); jumpTrigger.current?.focus(); return }
    escape(event)
    if (event.key !== 'Tab' || !maximizedRef.current || event.defaultPrevented || isOtherDialog(event.target)) return
    const window = panel.current
    if (!window) return
    const stops = Array.from(window.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (!first || !last) { event.preventDefault(); window.focus({ preventScroll: true }); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === window)) {
      event.preventDefault(); last.focus({ preventScroll: true })
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === window)) {
      event.preventDefault(); first.focus({ preventScroll: true })
    }
  }

  useEffect(() => {
    setHiddenTabState(current => current.key === persistenceKey ? current : { key: persistenceKey, ids: loadHiddenTabs(persistenceKey) })
    setRecentChats([])
  }, [persistenceKey])
  useEffect(() => {
    if (conversation !== 'chat' || !activeChatId) return
    setRecentChats(current => [activeChatId, ...current.filter(id => id !== activeChatId)].slice(0, 4))
  }, [activeChatId, conversation, persistenceKey])
  useEffect(() => {
    // A key change must never copy the previous account's preferences into the next account.
    if (hiddenTabState.key !== persistenceKey) return
    try { localStorage.setItem(persistenceKey, JSON.stringify(hiddenTabState.ids)) } catch { /* Hiding still works for this window when local storage is unavailable. */ }
  }, [hiddenTabState, persistenceKey])
  const currentTabId = conversation === 'swarm' && swarm ? swarmTabId(swarm.activeProjectId, swarm.recipient) : activeChatId ? chatTabId(activeChatId) : null
  const previousTab = useRef({ key: persistenceKey, id: currentTabId })
  useEffect(() => {
    // Navigation from the workspace itself also restores a room. Mounting or
    // hiding the current chip must not immediately undo the saved preference.
    if (currentTabId && previousTab.current.key === persistenceKey && previousTab.current.id !== currentTabId) restoreQuickTab(currentTabId)
    previousTab.current = { key: persistenceKey, id: currentTabId }
  }, [currentTabId, persistenceKey, restoreQuickTab])
  useEffect(() => {
    const tabs = quickTabs.current
    if (!open || !tabs) return
    let frame = 0
    const revealSelected = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const selected = tabs.querySelector<HTMLElement>('.workspace-chat-quick-tab[data-active="true"]')
        const target = selected || (conversation === 'chat' ? quickHome.current : null)
        // Instant alignment also respects reduced-motion preferences.
        target?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' })
      })
    }
    revealSelected()
    const observer = new ResizeObserver(revealSelected)
    observer.observe(tabs)
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [open, currentTabId, conversation, hiddenTabs, recentChats, swarm?.recentRooms, mobile, maximized])
  useEffect(() => {
    if (!jumpOpen) return
    setJumpQuery('')
    const frame = requestAnimationFrame(() => jumpInput.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [jumpOpen])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const content = body.current
    if (!content || !open || !maximized || !historyOpen || !mobile) return
    const previous = content.inert
    content.inert = true
    return () => { content.inert = previous }
  }, [open, maximized, historyOpen, mobile])

  useEffect(() => {
    if (!open || !maximized) return
    const launcher = trigger.current?.parentElement
    const workspace = launcher?.parentElement
    if (!workspace) return
    const previous = new Map<HTMLElement, boolean>()
    const blockWorkspace = () => {
      for (const element of workspace.children) {
        if (!(element instanceof HTMLElement) || element === launcher) continue
        if (!previous.has(element)) {
          previous.set(element, element.inert)
          observer.observe(element, { attributes: true, attributeFilter: ['inert'] })
        } else if (!element.inert) {
          // Workspace refs can reapply their own inert state during streaming.
          // Remember that requested state while retaining the modal's block.
          previous.set(element, false)
        }
        if (!element.inert) element.inert = true
      }
    }
    // Only siblings are blocked; child artifact dialogs and body portals stay usable.
    const observer = new MutationObserver(blockWorkspace)
    observer.observe(workspace, { childList: true })
    blockWorkspace()
    return () => {
      observer.disconnect()
      for (const [element, inert] of previous) element.inert = inert
    }
  }, [open, maximized])

  useEffect(() => {
    if (!open) { setMaximized(false); return }
    const frame = requestAnimationFrame(() => {
      const input = Array.from(panel.current?.querySelectorAll<HTMLTextAreaElement>('textarea:not(:disabled)') || []).find(element => element.getClientRects().length && !element.closest('[inert]'))
      if (input) input.focus({ preventScroll: true })
      else panel.current?.focus({ preventScroll: true })
    })
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || panel.current?.contains(target) || trigger.current?.contains(target) || isOtherDialog(target)) return
      // Click-away preserves the focus target the user is moving to.
      callbacks.current.onClose()
    }
    const outsideEscape = (event: KeyboardEvent) => {
      // Inside the window, React bubbling lets child editors consume Escape
      // before this window. Outside, capture runs before the underlying Map.
      if (event.target instanceof Node && panel.current?.contains(event.target)) return
      escape(event)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', outsideEscape, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', outsideEscape, true)
    }
  }, [open])

  return <div ref={launcher} className="workspace-chat-launcher" data-floating={open}>
    <button ref={trigger} type="button" className="workspace-chat-trigger" onClick={open ? close : onOpen}
      aria-label={open ? 'Close Nalu chat' : 'Open Nalu chat'} aria-expanded={open} aria-controls={panelId} aria-haspopup="dialog" tabIndex={maximized ? -1 : undefined}>
      <NaluMark className="workspace-chat-trigger-mark"/>
    </button>
    {(hasShownChat || open || fullPageVisible) && <section ref={panel} id={panelId} role={open ? 'dialog' : 'region'} aria-modal={open && maximized ? true : undefined} aria-labelledby={`${panelId}-label`} aria-hidden={!surfaceVisible || undefined} tabIndex={open ? -1 : undefined} className={open ? 'workspace-chat-popover' : 'workspace-chat-inline'} style={open ? undefined : fullPageVisible && inlineBounds ? inlineBounds : { display: 'none' }} data-maximized={open && maximized} data-conversation={open ? conversation : 'chat'} onKeyDown={open ? onWindowKeyDown : undefined}>
      <header className="workspace-chat-window-bar" style={!open ? { display: 'none' } : undefined}>
        <div className="workspace-chat-window-leading">
        <div className="workspace-chat-window-controls">
          <button type="button" className="chat-window-close" onClick={close} aria-label="Close Nalu chat" title="Close Nalu chat"><svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" aria-hidden="true"><path d="m1.7 1.7 4.6 4.6m0-4.6L1.7 6.3"/></svg></button>
          <button type="button" className="chat-window-minimize" onClick={close} aria-label="Minimize Nalu chat" title="Minimize Nalu chat"><svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" aria-hidden="true"><path d="M1.3 4h5.4"/></svg></button>
          <button ref={expand} type="button" className="chat-window-expand" onClick={() => maximized ? restore() : maximize()} aria-label={maximized ? 'Restore Nalu chat window' : 'Expand Nalu chat'} aria-pressed={maximized} title={maximized ? 'Restore Nalu chat window' : 'Expand Nalu chat'}><svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={maximized ? 'm1.3 1.3 2 2m0-2v2h-2m5.4 3.4-2-2m0 2v-2h2' : 'M1.3 3.1V1.3h1.8m1.8 5.4h1.8V4.9M1.5 1.5l1.8 1.8m3.2 3.2L4.7 4.7'}/></svg></button>
        </div>
        {maximized && <button ref={historyToggle} type="button" className="workspace-chat-history-toggle" onClick={() => setHistoryOpen(value => !value)} aria-label={historyOpen ? 'Hide chat history' : 'Show chat history'} title={historyOpen ? 'Hide chat history' : 'Show chat history'} aria-expanded={historyOpen} aria-controls={`${panelId}-history`}><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2" y="3" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.3"/><path d="M7 3v12M4 6h1M4 9h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg></button>}
        </div>
        <div className="workspace-chat-window-title"><h2 id={`${panelId}-label`}>Nalu chat</h2><span title={conversation === 'swarm' ? activeProject?.title : title}>{conversation === 'swarm' ? 'Your team, in one conversation' : title || 'A new conversation'}</span></div>
        <div className="workspace-chat-toolbar-actions">
          <button ref={jumpTrigger} type="button" className="workspace-chat-jump-button" aria-label="Switch conversation" title="Switch conversation (⌘/Ctrl K)" onClick={() => { setJumpOpen(value => !value); setNewMenuOpen(false) }}><svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></button>
          <button type="button" className="workspace-chat-new" onClick={() => { if (!swarm) { createChat(); setJumpOpen(false); return }; setNewMenuOpen(value => !value); setJumpOpen(false) }} aria-label={swarm ? 'New conversation or swarm' : 'New conversation'} aria-expanded={swarm ? newMenuOpen : undefined} aria-controls={swarm ? `${panelId}-new` : undefined}><span aria-hidden="true">＋</span><span>New</span></button>
          {swarm && newMenuOpen && <div id={`${panelId}-new`} className="workspace-chat-new-menu">
            <button type="button" onClick={createChat}><strong>New conversation</strong><span>Just you and Nalu</span></button>
            <button type="button" onClick={createSwarm}><strong>New swarm workspace</strong><span>A shared project with your agents</span></button>
          </div>}
        </div>
      </header>
      {open && conversation === 'chat' && chatTools && <div className="workspace-chat-tools" role="group" aria-label="Chat tools">{chatTools}</div>}
      <nav ref={quickTabs} className="workspace-chat-quick-tabs" aria-label="Quick conversations" style={!open ? { display: 'none' } : undefined} onFocusCapture={event => {
        if (!(event.target instanceof Element)) return
        const target = event.target.closest('.workspace-chat-quick-tab') || event.target
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }}>
        <button ref={quickHome} type="button" aria-pressed={conversation === 'chat'} onClick={() => { if (activeChatId) restoreQuickTab(chatTabId(activeChatId)); setConversation('chat'); setJumpOpen(false); setNewMenuOpen(false); if (mobile) setHistoryOpen(false); focusComposer() }}>Nalu</button>
        {swarm && activeProject && !hiddenTabs.includes(swarmTabId(activeProject.id, 'group')) && <QuickTab label={`Swarm · ${activeProject.title}`} active={conversation === 'swarm' && swarm.recipient === 'group'} onOpen={() => showSwarm(activeProject.id)} onHide={() => hideQuickTab(swarmTabId(activeProject.id, 'group'))}>
          <span className="workspace-chat-quick-participants" aria-hidden="true">{activeProject.members.map(member => <span key={member} className="workspace-chat-quick-participant"><AgentHead name={member}/></span>)}</span>
          <span className="workspace-chat-quick-tab-copy"><span className="workspace-chat-quick-tab-name">Swarm</span><span className="workspace-chat-quick-tab-detail">{activeProject.title}</span></span>
        </QuickTab>}
        {swarm && swarm.recentRooms.filter(room => room.thread !== 'group' && !hiddenTabs.includes(swarmTabId(room.projectId, room.thread))).slice(0, 4).map(room => {
          const projectTitle = swarm.state.projects.find(project => project.id === room.projectId)?.title || 'Swarm'
          return <QuickTab key={swarmTabId(room.projectId, room.thread)} label={`${room.thread} · ${projectTitle}`} active={conversation === 'swarm' && room.projectId === swarm.activeProjectId && room.thread === swarm.recipient} onOpen={() => showSwarm(room.projectId, room.thread)} onHide={() => hideQuickTab(swarmTabId(room.projectId, room.thread))}>
            <AgentHead name={room.thread as 'Nalu' | 'Rocky' | 'Milo'}/><span className="workspace-chat-quick-tab-copy"><span className="workspace-chat-quick-tab-name">{room.thread}</span><span className="workspace-chat-quick-tab-detail">{projectTitle}</span></span>
          </QuickTab>
        })}
        {recentChats.filter(id => chatItems.some(chat => chat.id === id) && !hiddenTabs.includes(chatTabId(id))).slice(0, 2).map(id => <QuickTab key={chatTabId(id)} label={chatItems.find(chat => chat.id === id)!.title} active={conversation === 'chat' && activeChatId === id} onOpen={() => showChat(id)} onHide={() => hideQuickTab(chatTabId(id))}><span className="workspace-chat-quick-tab-copy"><span className="workspace-chat-quick-tab-name">{chatItems.find(chat => chat.id === id)!.title}</span></span></QuickTab>)}
      </nav>
      {open && jumpOpen && <section className="workspace-chat-jump" role="dialog" aria-label="Switch conversation" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setJumpOpen(false); jumpTrigger.current?.focus() }
      }}>
        <header><input ref={jumpInput} type="search" aria-label={swarm ? 'Find a chat, swarm, or agent' : 'Find a conversation'} placeholder={swarm ? 'Find a chat, swarm, or agent…' : 'Find a conversation…'} value={jumpQuery} onChange={event => setJumpQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && quickChoices.length) { event.preventDefault(); quickChoices[0].action() } }}/><button type="button" aria-label="Close conversation switcher" onClick={() => { setJumpOpen(false); jumpTrigger.current?.focus() }}>×</button></header>
        <div>{quickChoices.map(choice => <button key={choice.id} type="button" onClick={choice.action}><strong>{choice.label}</strong><span>{choice.detail}</span></button>)}{!quickChoices.length && <p>No conversations found.</p>}</div>
        <footer>Jump straight into a conversation <kbd>⌘ / Ctrl K</kbd></footer>
      </section>}
      <div className="workspace-chat-window-content">
        {open && maximized && historyOpen && <>
          {mobile && <button type="button" className="workspace-chat-history-scrim" aria-label="Hide chat history" tabIndex={-1} onClick={hideHistory}/>}
          <aside id={`${panelId}-history`} className="workspace-chat-history" aria-label="Chat history" onClick={event => {
            if (mobile && event.target instanceof Element && event.target.closest('[data-chat-history-select]')) { setHistoryOpen(false); focusComposer() }
          }}>
            {swarm && <div className="workspace-chat-swarm-history"><header><h3>Swarm workspaces</h3><button type="button" onClick={createSwarm} aria-label="Create a swarm workspace">＋</button></header>
              {swarm.state.projects.map(project => <div key={project.id}><button type="button" data-chat-history-select aria-current={conversation === 'swarm' && project.id === swarm.activeProjectId && swarm.recipient === 'group' ? 'page' : undefined} onClick={() => showSwarm(project.id)}><strong>{project.title}</strong><span>{project.members.length} agents</span></button>
                {conversation === 'swarm' && project.id === swarm.activeProjectId && <div className="workspace-chat-agent-threads"><small>Private chats</small>{project.members.map(member => <button key={member} type="button" data-chat-history-select aria-current={swarm.recipient === member ? 'page' : undefined} onClick={() => showSwarm(project.id, member)}><AgentHead name={member}/>{member}</button>)}</div>}
              </div>)}
            </div>}
            <div onClick={event => {
              if (!(event.target instanceof Element) || !event.target.closest('[data-chat-history-select]')) return
              const id = event.target.closest<HTMLElement>('[data-chat-id]')?.dataset.chatId
              if (id) restoreQuickTab(chatTabId(id))
              setConversation('chat')
            }}>{typeof history === 'function' ? history(conversation === 'chat') : history}</div>
          </aside>
        </>}
        <div ref={body} className={open ? 'workspace-chat-popover-body' : 'workspace-chat-inline-body'}>
          {open && conversation === 'swarm' && swarm && <WorkspaceSwarm swarm={swarm} startingAgent={startingAgent} navigationKey={swarmNavigation} availableChatIds={chatItems.map(chat => chat.id)} onOpenChat={showChat}/>}
          {/* Keep one ordinary-chat subtree in one DOM location. Changing its
              presentation must not reset editors, iframe state, or dictation. */}
          <div key="ordinary-chat" className="workspace-chat-ordinary" style={{ display: ordinaryVisible ? 'contents' : 'none' }}>{children}</div>
        </div>
      </div>
    </section>}
  </div>
}
