import { useState } from 'react'
import type { PublicUser } from '../lib/localAuth'
export default function LocalWorkspaceEntry({ onAuthed }: { onAuthed: (user: PublicUser) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const enter = async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch('/__nalu_local_entry', { method: 'POST', headers: { 'x-nalu-local-entry': '1' } })
      const data = await response.json()
      if (!response.ok || !data.ok || !data.token || !data.user?.id) throw new Error(data.error || 'Local entry is unavailable.')
      localStorage.setItem('nalu-token', data.token)
      await onAuthed(data.user)
    } catch (e) { setError(e instanceof Error ? e.message : 'Try again.') }
    finally { setBusy(false) }
  }
  return <aside style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200, maxWidth: 320, padding: 16, background: '#fff', color: '#152c2b', boxShadow: '0 8px 40px #0002', borderRadius: 12, font: '13px Inter,sans-serif' }}>
    <span style={{ display: 'block', marginBottom: 10, fontSize: 10, letterSpacing: '.12em' }}>LOCAL DEVELOPMENT</span>
    <button onClick={() => void enter()} disabled={busy} style={{ padding: '12px 18px', background: '#183c36', color: '#fff', border: 0, borderRadius: 5, cursor: 'pointer' }}>{busy ? 'Opening your workspace…' : 'Enter local workspace →'}</button>
    {error && <p role="alert">{error}</p>}
  </aside>
}
