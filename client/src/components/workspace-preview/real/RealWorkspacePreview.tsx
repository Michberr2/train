import { lazy, Suspense, useEffect, useState } from 'react'
import ThemeProvider from '../../ThemeProvider'
import AuthProvider, { useAuth } from '../../AuthProvider'
import { PREVIEW_OWNER, PREVIEW_TOKEN, PREVIEW_VERSION, previewChats, previewFlow, previewDocumentDesign } from './fixtures'
import WorkspaceDesignSurface from '../../workspace/design/WorkspaceDesignSurface'

const Workspace = lazy(() => import('../../workspace/Workspace'))
let initialization: Promise<void> | undefined

// Upgrade only our original sample's missing palette. Keep every edited title,
// block, message, workflow, and existing custom design unchanged.
function migrateSampleDocument(json: string | null): string | null {
  if (!json) return null
  try {
    const chats = JSON.parse(json)
    if (!Array.isArray(chats)) return null
    let changed = false
    for (const chat of chats) {
      if (chat?.id !== 'preview-brief' || !Array.isArray(chat.messages)) continue
      for (const message of chat.messages) {
        if (message?.id !== 'preview-brief-result' || !message.doc || typeof message.doc !== 'object' || Array.isArray(message.doc) || message.doc.design != null) continue
        message.doc.design = previewDocumentDesign
        changed = true
      }
    }
    return changed ? JSON.stringify(chats) : null
  } catch { return null }
}

function installPreviewNetworkBoundary() {
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href)
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    // Maps tiles and public GIS layers remain real. Account/generation traffic
    // must stay on the fixture server, and no external write is permitted.
    if (url.origin !== window.location.origin &&
      (!['GET', 'HEAD'].includes(method) || /(^|\.)n4lu\.(ai|com)$/i.test(url.hostname))) {
      return Promise.reject(new Error('This local preview cannot contact accounts or send external actions.'))
    }
    return originalFetch(input, init)
  }
}

async function initializePreview() {
  if (!import.meta.env.DEV || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
    throw new Error('This design preview is available only on the dedicated local server.')
  }
  const response = await fetch('/__workspace-design-preview', { cache: 'no-store' })
  const meta = await response.json().catch(() => null)
  if (!response.ok || meta?.preview !== PREVIEW_VERSION) throw new Error('Open the isolated preview at http://127.0.0.1:5193/workspace-preview.')

  const token = localStorage.getItem('nalu-token')
  const owner = localStorage.getItem('nalu-data-owner')
  const marker = localStorage.getItem('nalu-workspace-preview-version')
  if ((token && token !== PREVIEW_TOKEN) || (owner && owner !== PREVIEW_OWNER) || (!marker && (localStorage.getItem('nalu-chats') || localStorage.getItem('nalu-agent-flows')))) {
    throw new Error('Existing account data was found on this local origin and has been preserved. Open this preview in a private browser window.')
  }

  installPreviewNetworkBoundary()
  if (!marker) {
    localStorage.setItem('nalu-chats', JSON.stringify(previewChats))
    localStorage.setItem('nalu-agent-flows', JSON.stringify([previewFlow]))
    if (!localStorage.getItem('nalu-theme')) localStorage.setItem('nalu-theme', 'light')
    localStorage.setItem('nalu-view', 'chat')
    localStorage.setItem('nalu-map-display', JSON.stringify({ base: 'streets', opacity: {}, view: { lat: 32.0809, lng: -81.0912, zoom: 13 } }))
    localStorage.setItem('nalu-workspace-preview-version', PREVIEW_VERSION)
  }
  localStorage.setItem('nalu-token', PREVIEW_TOKEN)
  localStorage.setItem('nalu-data-owner', PREVIEW_OWNER)
  const upgraded = migrateSampleDocument(localStorage.getItem('nalu-chats'))
  if (upgraded) localStorage.setItem('nalu-chats', upgraded)
  // The real Workspace restores the full artifact from IndexedDB on mount.
  // Apply the same narrow patch there so an older cached sample cannot replace it.
  const { idbGetChats, idbSetChats } = await import('../../../lib/chatStore')
  const fullUpgrade = migrateSampleDocument(await idbGetChats())
  if (fullUpgrade) await idbSetChats(fullUpgrade)
  const requested = new URLSearchParams(location.search).get('view')
  const view = requested === 'autopilot' ? 'agents' : requested
  if (view && ['chat', 'studio', 'map', 'agents', 'memory', 'skills', 'automations'].includes(view)) localStorage.setItem('nalu-view', view)
}

function PreviewWorkspace() {
  const { user } = useAuth()
  const productionShell = new URLSearchParams(location.search).get('shell') === 'production'
  if (!user) return <div style={{ padding: 40 }}>Opening the sample workspace…</div>
  return <Suspense fallback={<div style={{ padding: 40 }}>Opening the workspace…</div>}>
    <Workspace user={user} onLogout={() => location.reload()} designPreview={!productionShell} designEnabled={productionShell} />
  </Suspense>
}

export default function RealWorkspacePreview() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    initialization ||= initializePreview()
    initialization.then(() => { if (active) setReady(true) }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)) })
    return () => { active = false }
  }, [])
  if (error) return <main style={{ padding: 40, color: '#f8fbff', background: '#233950', minHeight: '100vh' }}><h1>Local workspace preview</h1><p role="alert">{error}</p></main>
  if (!ready) return <div style={{ padding: 40, color: '#f8fbff', background: '#233950', minHeight: '100vh' }}>Opening the workspace…</div>
  return <ThemeProvider><AuthProvider><WorkspaceDesignSurface preview>
    <div className="nalu-design-review-banner" role="note"><strong>Local preview</strong><span>Real workspace · sample work · no account changes</span></div>
    <PreviewWorkspace />
  </WorkspaceDesignSurface></AuthProvider></ThemeProvider>
}
