import { useEffect, useRef, useState } from 'react'
import { Globe, ArrowRight, Square, Maximize2, RefreshCw, Download, Hand, ExternalLink } from 'lucide-react'
import { browserRequest, type BrowserWorkspace } from './browserWorkspace'
import { getToken } from '../../lib/localAuth'
import './browser-workspace.css'

export default function BrowserWorkspacePanel({ token }: { token: string | null }) {
  const [state, setState] = useState<BrowserWorkspace | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('https://www.microsoft365.com/'), [task, setTask] = useState('')
  const panel = useRef<HTMLDivElement>(null), mutation = useRef(false), mounted = useRef(true), version = useRef(0)
  const running = !!state && ['queued', 'running', 'waiting'].includes(state.status)
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const v = version.current
      if (!mutation.current) try {
        const next = await browserRequest('workspace_status', {}, controller.signal, token)
        if (mounted.current && !mutation.current && version.current === v) { setState(next); setError('') }
      } catch (e) { if (!controller.signal.aborted && mounted.current) setError((e as Error).message) }
      if (mounted.current && !controller.signal.aborted) timer = setTimeout(poll, 6000)
    }
    void poll()
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer) }
  }, [token])
  const act = async (action: string, data: Record<string, unknown> = {}) => {
    if (mutation.current) return
    mutation.current = true; version.current++; setBusy(true); setError('')
    try {
      const next = await browserRequest(action, data, undefined, token)
      if (!mounted.current || token !== getToken()) return
      if (action === 'workspace_download') {
        const a = document.createElement('a'); a.href = next.url; a.rel = 'noopener noreferrer'; a.target = '_blank'; a.click()
      } else setState(next)
    } catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { mutation.current = false; if (mounted.current) setBusy(false) }
  }
  const live = (() => { try { const u = new URL(state?.live_url || ''); return u.protocol === 'https:' && u.hostname.endsWith('.browser-use.com') ? u.href : '' } catch { return '' } })()
  return <div className="nalu-browser" ref={panel}>
    <header className="nalu-browser-header"><div><Globe size={22}/><div><h2>Your browser</h2><p>One private workspace for you and Nalu.</p></div></div>
      <div className="nalu-browser-controls">
        <button disabled={busy} onClick={() => void act('workspace_status')} aria-label="Refresh browser status"><RefreshCw size={16}/></button>
        <button onClick={() => void panel.current?.requestFullscreen().catch(() => setError('Full screen is unavailable in this browser.'))} aria-label="Full screen"><Maximize2 size={16}/></button>
        {state?.active && <button disabled={busy} onClick={() => void act('workspace_close')}><Square size={14}/>Close browser</button>}
      </div>
    </header>
    <form className="nalu-browser-address" onSubmit={e => { e.preventDefault(); void act(state?.active ? 'workspace_run' : 'workspace_open', { url, ...(state?.active ? { task: `Navigate to ${url}. Do not make any other changes. Stop when the page is ready for me.` } : {}) }) }}>
      <Globe size={16}/><input aria-label="Website address" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com" type="url" required/>
      <button disabled={busy || running || state?.configured === false} type="submit">{state?.active ? 'Go' : 'Open browser'}<ArrowRight size={15}/></button>
    </form>
    <div className="nalu-browser-shortcuts">{[['Word', 'https://word.cloud.microsoft/'], ['Excel', 'https://excel.cloud.microsoft/'], ['Microsoft 365', 'https://www.microsoft365.com/'], ['Google Docs', 'https://docs.google.com/'], ['Google Sheets', 'https://sheets.google.com/']].map(([name, address]) => <button key={name} disabled={busy || running || state?.configured === false} onClick={() => { setUrl(address); void act(state?.active ? 'workspace_run' : 'workspace_open', { url: address, ...(state?.active ? { task: `Open ${name} at ${address} and stop so I can sign in or choose a file.` } : {}) }) }}>{name}</button>)}</div>
    {error && <p className="nalu-browser-error" role="alert">{error}</p>}
    {state?.configured === false && <p className="nalu-browser-error" role="status">{state.error}</p>}
    <div className="nalu-browser-screen">
      {live ? <>
        <iframe ref={element => { if (element) element.inert = running }} tabIndex={running ? -1 : 0} key={live} src={live} title="Your private Nalu browser" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="clipboard-read; clipboard-write" style={{ pointerEvents: running ? 'none' : 'auto' }}/>
        {running && <div className="nalu-browser-working" role="status"><span>Nalu is working. Take control to interact.</span><button disabled={busy} onClick={() => void act('workspace_takeover')}><Hand size={16}/>Take control</button></div>}
      </> : <div className="nalu-browser-empty"><Globe size={42}/><h3>{!state ? 'Connecting to your workspace…' : state.active ? 'Your browser is starting…' : 'Your apps, ready for work.'}</h3><p>Open a website and sign in directly. Then ask Nalu to research, update a document, or work in a spreadsheet.</p><small>Website logins stay in your private browser profile. Microsoft and other apps may ask you to sign in again.</small></div>}
    </div>
    <form className="nalu-browser-task" onSubmit={e => { e.preventDefault(); void act('workspace_run', { task }) }}>
      <label htmlFor="browser-task">What should Nalu do?</label><div><textarea id="browser-task" value={task} onChange={e => setTask(e.target.value)} maxLength={6000} required placeholder="Open my Excel budget, add a summary of expenses, and verify it saved."/><button disabled={busy || running || !task.trim() || state?.configured === false} type="submit">{busy ? 'Connecting…' : 'Run task'}<ArrowRight size={16}/></button></div>
      <small>Tasks can continue after you leave this page. Use Take control to stop the AI; Close browser ends the session and saves its login profile.</small>
    </form>
    {state?.task && <section className="nalu-browser-result" aria-live="polite"><div><strong>{state.status === 'done' ? 'Agent reported completion' : state.status === 'finished' ? 'Finished — outcome unconfirmed' : state.status}</strong>{running && <button disabled={busy} onClick={() => void act('workspace_takeover')}><Hand size={14}/>Take control</button>}</div><p>{state.task}</p>{state.detail && <p>{state.detail}</p>}{state.result && <pre>{state.result}</pre>}
      {!!state.steps?.length && <details><summary>Activity · {state.steps.length} steps</summary><ol>{state.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></details>}
      {!!state.files?.length && <div className="nalu-browser-files">{state.files.map(file => <button key={file.id} disabled={busy} onClick={() => void act('workspace_download', { file_id: file.id })}><Download size={15}/>{file.fileName}<ExternalLink size={12}/></button>)}</div>}
    </section>}
  </div>
}
