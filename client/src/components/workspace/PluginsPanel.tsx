import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { CONNECT_APPS, listConnections, type Connection } from '../../lib/connections'
import { ConnLogo } from '../../lib/connLogos'
import ConnectionManager from './ConnectionManager'

// This catalogue uses the same supported adapters and account inventory as the
// actual setup flow. Legacy nalu-plugins preferences are deliberately untouched.
export default function PluginsPanel() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [editorApp, setEditorApp] = useState<string | null>(null)
  const loadVersion = useRef(0)
  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true); setError('')
    try { const items = await listConnections(); if (loadVersion.current === version) setConnections(items) }
    catch (e) { if (loadVersion.current === version) { setConnections([]); setError(e instanceof Error ? e.message : 'Could not load connections.') } }
    finally { if (loadVersion.current === version) setLoading(false) }
  }, [])
  useEffect(() => { void load(); return () => { loadVersion.current++ } }, [load])
  return <div className="ws-plugins flex min-h-0 flex-1 flex-col font-sans text-ink">
    <header className="ws-plugins-header flex flex-wrap items-center gap-3 px-6 py-4">
      <div className="min-w-0 flex-1"><h1 className="text-base font-medium">Connections & Chrome</h1><p className="mt-1 text-sm text-dim">Connect an account through verified setup, or add Nalu to Chrome.</p></div>
      {!loading && !error && <span className="text-xs text-dim">{connections.length} saved {connections.length === 1 ? 'account' : 'accounts'}</span>}
      <button aria-label="Refresh connection status" disabled={loading} onClick={() => void load()} className="rounded-xl p-2 hover:bg-glass/10 disabled:opacity-50"><RefreshCw size={17} /></button>
    </header>
    <div className="ws-plugins-content min-h-0 flex-1 overflow-y-auto px-6 pb-5">
      <section aria-label="Nalu for Chrome" className="ws-plugins-chrome mb-5 rounded-2xl border border-accent/30 bg-accent/[0.08] p-5">
        <div className="ws-plugins-chrome-heading">
        <h2 className="text-[15px] font-medium">Nalu for Chrome</h2>
        <a href="/nalu-for-chrome.zip" download className="inline-flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-sm text-[#0a1018]"><Download size={15} />Download extension</a>
        </div>
        <p className="mt-1 text-sm text-dim">Work with the page you are viewing. Nalu can read pages, click, type and navigate, with review before consequential actions. Scheduled runs stop when review is needed.</p>
        <details className="ws-plugins-install">
        <summary>Installation instructions</summary>
        <ol className="mt-3 list-inside list-decimal space-y-1 text-sm text-dim">
          <li>Download and unzip the extension.</li>
          <li>Open <span className="font-mono text-ink">chrome://extensions</span> and turn on Developer mode.</li>
          <li>Choose Load unpacked, then select the unzipped nalu-for-chrome folder.</li>
          <li>Pin Nalu and open its side panel. Reload open tabs after updating the extension.</li>
        </ol>
        <p className="mt-2 text-xs text-dim">Check installation in Chrome. This page cannot verify whether the extension is installed.</p>
        </details>
      </section>
      {loading && <p role="status" className="mb-4 text-sm text-dim">Loading your saved connections…</p>}
      {error && <p role="alert" className="mb-4 rounded-xl border border-red-400/30 p-3 text-sm">{error}</p>}
      <div className="ws-plugins-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {CONNECT_APPS.map(app => {
          const accounts = connections.filter(c => c.app === app.app)
          const connected = accounts.filter(c => c.status === 'connected').length
          const status = loading ? 'Checking status' : error ? 'Status unavailable' : connected ? `${connected} connected` : accounts.some(c => c.status === 'error') ? 'Needs attention' : accounts.length ? 'Finish setup' : 'Not connected'
          return <section key={app.app} aria-label={`${app.name} connection`} className="flex flex-col rounded-2xl border border-glass/[0.18] bg-glass/[0.11] p-4 backdrop-blur-2xl">
            <div className="flex items-start gap-3"><ConnLogo app={app.app} size={25} /><div className="min-w-0 flex-1"><h2 className="text-sm font-medium">{app.name}</h2><p className="mt-1 text-xs leading-relaxed text-dim">{app.blurb}</p></div></div>
            <p className="mt-3 text-xs text-dim">{status}</p>
            {app.requirement && <p className="mt-2 text-xs text-dim">{app.requirement}</p>}
            <button onClick={() => setEditorApp(app.app)} className="mt-4 rounded-xl border border-glass/20 px-3 py-2 text-xs hover:bg-glass/10">{accounts.length ? 'Manage connection' : 'Set up connection'}</button>
          </section>
        })}
      </div>
    </div>
    {editorApp && <ConnectionManager initialApp={editorApp} onClose={() => setEditorApp(null)} onChange={() => void load()} />}
  </div>
}
