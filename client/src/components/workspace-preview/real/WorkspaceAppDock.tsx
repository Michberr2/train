import { useEffect, useRef, useState } from 'react'
import './workspace-app-dock.css'

export type WorkspaceAppView = 'chat' | 'studio' | 'agents' | 'map' | 'memory' | 'skills'

const APPS: { view: WorkspaceAppView; label: string }[] = [
  { view: 'studio', label: 'Studio' },
  { view: 'agents', label: 'Autopilot' },
  { view: 'map', label: 'Map' },
  { view: 'memory', label: 'Memory' },
  { view: 'skills', label: 'Skills' },
]

const ICON_ASSETS: Record<WorkspaceAppView, string> = {
  chat: '/workspace-icons/chat-v1.png',
  studio: '/workspace-icons/studio-glossy-paintbrush.png',
  agents: '/workspace-icons/autopilot-neon-molecule.png',
  map: '/workspace-icons/map-glossy-blue-pin.png',
  memory: '/workspace-icons/memory-glossy-brain.png',
  skills: '/workspace-icons/skills-plug-socket.png',
}

export function AppIcon({ view }: { view: WorkspaceAppView }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const automaticRetryUsed = useRef(false)
  useEffect(() => {
    if (state !== 'error') return
    let retried = false
    const retry = () => {
      if (retried) return
      retried = true
      automaticRetryUsed.current = true
      setState('loading')
      setAttempt(value => value + 1)
    }
    // One automatic retry handles transient asset errors. After that, only a
    // real reconnect retries; navigation never loops or restores old artwork.
    const timer = automaticRetryUsed.current ? undefined : window.setTimeout(retry, 1200)
    window.addEventListener('online', retry)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('online', retry)
    }
  }, [state])
  return <span className="workspace-app-dock-icon" data-app={view} data-icon-state={state} aria-hidden="true">
    {state === 'error' && <span className="workspace-app-dock-unavailable">{APPS.find(app => app.view === view)?.label || 'Chat'}</span>}
    <img key={attempt} className="workspace-app-dock-image" src={ICON_ASSETS[view]} alt="" draggable={false} loading="eager" decoding="async" data-loaded={state === 'ready'}
      onLoad={() => setState('ready')} onError={() => setState('error')}/>
  </span>
}

export default function WorkspaceAppDock({ currentView, launcherOpen, onOpen }: {
  currentView: string
  launcherOpen: boolean
  onOpen: (view: WorkspaceAppView) => void
}) {
  return <nav className="workspace-app-dock" aria-label="Workspace navigation">
    {APPS.map(app => <button key={app.view} type="button" className="workspace-app-dock-app" aria-label={app.label}
      aria-current={!launcherOpen && currentView === app.view ? 'page' : undefined}
      onClick={() => onOpen(app.view)}>
      <AppIcon view={app.view}/>
      <span className="workspace-app-dock-label" aria-hidden="true">{app.label}</span>
    </button>)}
  </nav>
}
