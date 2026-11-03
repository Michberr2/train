import { useEffect, useId, useRef, useState } from 'react'
import { Download, Grid2X2, LogOut, Moon, MoreHorizontal, Settings, Shield, Sun } from 'lucide-react'
import { useTheme } from '../../ThemeProvider'
import type { SyncState } from '../../../lib/sync'
import './workspace-account-menu.css'

export interface WorkspaceAccountMenuProps {
  displayName?: string
  saveState: SyncState
  onSettings: () => void
  onLogout: () => void
  onRetrySave: () => void
  onSpaces?: () => void
  onWork?: () => void
  className?: string
}

/** Account navigation only. The authenticated workspace owns every action. */
export default function WorkspaceAccountMenu({ displayName, saveState, onSettings, onLogout, onRetrySave, onSpaces, onWork, className = '' }: WorkspaceAccountMenuProps) {
  const { isDark, toggleTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const settings = useRef<HTMLButtonElement>(null)
  const id = useId()
  const name = displayName?.trim() || 'You'
  const needsAttention = saveState === 'pending' || saveState === 'error'
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  const select = (action: () => void) => { close(); action() }

  useEffect(() => {
    if (!open) return
    settings.current?.focus({ preventScroll: true })
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault(); event.stopPropagation()
      setOpen(false); trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])

  return <div ref={root} className={`workspace-account-menu ${className}`}>
    <button ref={trigger} type="button" className="workspace-account-trigger" aria-label="Account options" title={needsAttention ? 'Account options · chats need attention' : 'Account options'}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} data-needs-attention={needsAttention || undefined}
      onClick={() => open ? close() : setOpen(true)} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) }
      }}><MoreHorizontal size={19} strokeWidth={1.7} aria-hidden="true"/></button>
    {open && <section ref={panel} id={id} className="workspace-account-panel" role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1}>
      <header><h2 id={`${id}-title`} title={name}>{name}</h2><p>Nalu account</p></header>
      <div className="workspace-account-actions">
        <button type="button" aria-pressed={isDark} onClick={() => toggleTheme()}>{isDark ? <Sun size={16} aria-hidden="true"/> : <Moon size={16} aria-hidden="true"/>}<span>{isDark ? 'Light mode' : 'Dark mode'}</span></button>
        {onSpaces && <button type="button" onClick={() => select(onSpaces)}><Grid2X2 size={16} aria-hidden="true"/><span>All workspaces</span></button>}
        {onWork && <button type="button" aria-label="Track all agent work" onClick={() => select(onWork)}><Grid2X2 size={16} aria-hidden="true"/><span>Agent work</span></button>}
        <button ref={settings} type="button" onClick={() => select(onSettings)}><Settings size={16} aria-hidden="true"/><span>Settings</span></button>
        <a href="/download.html" target="_blank" rel="noreferrer" onClick={close}><Download size={16} aria-hidden="true"/><span>Download Nalu Desktop</span></a>
        <a href="/privacy.html" target="_blank" rel="noreferrer" onClick={close}><Shield size={16} aria-hidden="true"/><span>Privacy Policy</span></a>
      </div>
      <div className="workspace-account-save" role="status" aria-label="Chat save status">
        <p>{saveState === 'saved' ? 'Saved to your account' : saveState === 'saving' ? 'Saving chats…' : saveState === 'loading' ? 'Loading saved chats…' : saveState === 'error' ? 'Chats need attention — keep this tab open.' : 'Waiting to sync your chats'}</p>
        {needsAttention && <button type="button" onClick={() => { onRetrySave(); settings.current?.focus({ preventScroll: true }) }}>Retry save</button>}
      </div>
      <footer className="workspace-account-actions"><button type="button" onClick={() => select(onLogout)}><LogOut size={16} aria-hidden="true"/><span>Sign out</span></button></footer>
    </section>}
  </div>
}
