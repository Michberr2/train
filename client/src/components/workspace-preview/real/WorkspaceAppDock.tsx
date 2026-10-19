import { useState } from 'react'
import './workspace-app-dock.css'

export type WorkspaceAppView = 'chat' | 'studio' | 'agents' | 'map' | 'memory' | 'skills'

const APPS: { view: WorkspaceAppView; label: string }[] = [
  { view: 'studio', label: 'Studio' },
  { view: 'agents', label: 'Autopilot' },
  { view: 'map', label: 'Map' },
  { view: 'memory', label: 'Memory' },
  { view: 'skills', label: 'Skills' },
]

/** Compact, matte app marks: precise shapes and restrained color, without gloss. */
function AppVectorIcon({ view }: { view: WorkspaceAppView }) {
  return <svg className="workspace-app-dock-vector" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true" focusable="false">
    {view === 'chat' && <>
      <path d="M24 8h33v29H46l-8 7v-7H24Z" fill="#91bdb3"/>
      <path d="M6 19h37v30H23l-9 7v-7H6Z" fill="#35699a"/>
      <path d="M14 29h21M14 37h15" fill="none" stroke="#edf3f5" strokeWidth="2.4"/>
      <path d="M43 19h6v18h-6Z" fill="#254f7d"/>
    </>}
    {view === 'studio' && <>
      <rect x="16" y="7" width="41" height="44" rx="2" fill="#37658f"/>
      <rect x="7" y="15" width="44" height="42" rx="2" fill="#c87b68"/>
      <path d="M18 23h26v26H18Z" fill="#f0e8dc"/>
      <path d="M18 23h26v8H18Z" fill="#dfc6ad"/>
      <path d="M18 33h10v16H18Z" fill="#315a83"/>
      <path d="M31 34h10M31 39h10M31 44h7" fill="none" stroke="#8faaa9" strokeWidth="2"/>
      <path d="M7 22h6v28H7Z" fill="#ab5e51"/>
    </>}
    {view === 'agents' && <>
      <path d="M23 18h20v24H23M18 23v20" fill="none" stroke="#8e9fab" strokeWidth="2.5"/>
      <rect x="6" y="6" width="24" height="24" rx="2" fill="#416c98"/>
      <rect x="35" y="29" width="23" height="24" rx="2" fill="#66968f"/>
      <rect x="6" y="40" width="23" height="18" rx="2" fill="#b57b62"/>
      <path d="M12 14h12M12 21h8" fill="none" stroke="#e7edf3" strokeWidth="2"/>
      <path d="M41 37h11v8H41Z" fill="none" stroke="#edf3ef" strokeWidth="1.7"/>
      <path d="M12 47h11M12 52h7" fill="none" stroke="#f5e9df" strokeWidth="1.8"/>
    </>}
    {view === 'map' && <>
      <path d="m6 16 17-6 18 6 17-6v42l-17 6-18-6-17 6Z" fill="#dde6e9"/>
      <path d="m6 16 17-6v42L6 58Z" fill="#7797b0"/>
      <path d="m41 16 17-6v42l-17 6Z" fill="#80a9a2"/>
      <path d="m6 36 17-6 18 7 17-6M15 13l-2 42M49 13l-1 41" fill="none" stroke="#eef2ed" strokeWidth="2"/>
      <path d="M23 10v42M41 16v42" fill="none" stroke="#466b8c" strokeOpacity=".25" strokeWidth="1"/>
      <path d="M33 6a9 9 0 0 0-9 9c0 6 9 16 9 16s9-10 9-16a9 9 0 0 0-9-9Z" fill="#b8675c"/>
      <circle cx="33" cy="15" r="3.3" fill="#f2e8de"/>
    </>}
    {view === 'memory' && <>
      <path d="M18 6h14l4 4h22v39H18Z" fill="#bf8d94"/>
      <path d="M12 12h13l4 4h23v38H12Z" fill="#85b5c1"/>
      <path d="M6 18h13l4 4h23v36H6Z" fill="#3e5879"/>
      <path d="M14 32h24M14 39h24M14 46h16" fill="none" stroke="#e7eef2" strokeWidth="2"/>
      <path d="M46 22h6v32h-6Z" fill="#5c93a5"/>
    </>}
    {view === 'skills' && <>
      <rect x="7" y="7" width="23" height="23" rx="2" fill="#3f5878"/>
      <rect x="34" y="7" width="23" height="23" rx="2" fill="#b59a65"/>
      <rect x="7" y="34" width="23" height="23" rx="2" fill="#7a9c97"/>
      <rect x="34" y="34" width="23" height="23" rx="2" fill="#d5dfe5"/>
      <path d="m17 14-5 5 5 5m6-10 5 5-5 5" fill="none" stroke="#e7edf2" strokeWidth="1.8"/>
      <path d="M40 14h11v10H40Z" fill="none" stroke="#f4eee2" strokeWidth="1.7"/>
      <path d="M13 42h11M13 49h11M18 39v13" fill="none" stroke="#edf2ed" strokeWidth="1.7"/>
      <path d="M40 42h11M40 49h7" fill="none" stroke="#5d758e" strokeWidth="2"/>
    </>}
  </svg>
}

const ICON_ASSETS: Record<WorkspaceAppView, string> = {
  chat: '/workspace-icons/chat-v1.png',
  studio: '/workspace-icons/studio-glossy-paintbrush.png',
  agents: '/workspace-icons/autopilot-neon-molecule.png',
  map: '/workspace-icons/map-v1.png',
  memory: '/workspace-icons/memory-glossy-brain.png',
  skills: '/workspace-icons/skills-plug-socket.png',
}

function AppIcon({ view }: { view: WorkspaceAppView }) {
  const [loaded, setLoaded] = useState(false)
  return <span className="workspace-app-dock-icon" data-app={view} aria-hidden="true">
    {!loaded && <AppVectorIcon view={view}/>}
    <img className="workspace-app-dock-image" src={ICON_ASSETS[view]} alt="" draggable={false} data-loaded={loaded}
      onLoad={() => setLoaded(true)} onError={() => setLoaded(false)}/>
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
