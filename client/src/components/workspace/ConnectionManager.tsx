import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronLeft, ExternalLink, Loader2, Plug, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { ConnLogo } from '../../lib/connLogos'
import { CONNECT_APPS, ConnectionSetupError, appDef, availableConnectionProviders, beginConnectionSignIn, deleteConnection, getInbox, listConnectionDestinations, listConnections, saveConnection, testConnection, type Connection, type ConnMethod, type InboxItem } from '../../lib/connections'
import type { ConnectionDestination, ConnectionMetadata } from '../../../../shared/connectionCatalog'
import ConnectionPostReviews from './ConnectionPostReviews'

type Editor = { app: string; id?: string; method: ConnMethod; label: string; username: string; secret: string; endpoint: string; meta: ConnectionMetadata; hasSecret: boolean; hasEndpoint: boolean }
const inputClass = 'mt-1 w-full rounded-xl border border-glass/20 bg-glass/[0.06] px-3 py-2.5 text-sm text-ink outline-none placeholder:text-dim focus:border-gold/60'
const buttonClass = 'rounded-xl border border-glass/20 px-3 py-2 text-sm text-ink hover:bg-glass/10 disabled:opacity-50'

export default function ConnectionManager({ onClose, onChange, initialApp }: { onClose: () => void; onChange: () => void; initialApp?: string }) {
  const [connections, setConnections] = useState<Connection[]>([]), [providers, setProviders] = useState<string[]>([])
  const [editor, setEditor] = useState<Editor | null>(null), [query, setQuery] = useState('')
  const initialOpened = useRef('')
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [destinations, setDestinations] = useState<ConnectionDestination[]>([]), [nextCursor, setNextCursor] = useState<string | undefined>()
  const [destinationQuery, setDestinationQuery] = useState(''), [confirmDelete, setConfirmDelete] = useState('')
  const [inbox, setInbox] = useState<{ label: string; items: InboxItem[] } | null>(null)
  const popup = useRef<Window | null>(null), polling = useRef<ReturnType<typeof setInterval> | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const load = useCallback(async () => {
    const result = await Promise.allSettled([listConnections(), availableConnectionProviders()])
    if (result[0].status === 'fulfilled') {
      setConnections(result[0].value)
      if (initialApp && initialOpened.current !== initialApp && CONNECT_APPS.some(app => app.app === initialApp)) {
        initialOpened.current = initialApp
        openEditor(initialApp, result[0].value.find(item => item.app === initialApp))
      }
    }
    else setError(result[0].reason instanceof Error ? result[0].reason.message : 'Could not load connections. Try again.')
    if (result[1].status === 'fulfilled') setProviders(result[1].value)
    else setError(result[1].reason instanceof Error ? result[1].reason.message : 'Could not load sign-in options.')
  }, [initialApp]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); dialog.current?.focus(); return () => { if (polling.current) clearInterval(polling.current) } }, [load])
  useEffect(() => {
    const received = (event: MessageEvent) => {
      if (!['https://n4lu.ai', 'https://n4lu.com', 'https://www.n4lu.ai', 'https://www.n4lu.com'].includes(event.origin) || event.source !== popup.current || event.data?.type !== 'nalu:connection' || event.data.ok !== true) return
      if (polling.current) clearInterval(polling.current)
      setBusy(''); setNotice('Account connected. Choose its destination if needed.'); setEditor(null)
      void load(); onChange()
    }
    window.addEventListener('message', received)
    return () => window.removeEventListener('message', received)
  }, [load, onChange])
  function openEditor(app: string, existing?: Connection) {
    const method = existing?.method && existing.method !== 'managed' && existing.method !== 'resend' ? existing.method : app === 'webhook' || app === 'outlook' ? 'endpoint' : app === 'gmail' ? 'smtp' : 'apikey'
    setEditor({ app, id: existing?.id, method, label: existing?.label || appDef(app).name, username: existing?.username || '', secret: '', endpoint: '', meta: existing?.meta || {}, hasSecret: !!existing?.hasSecret, hasEndpoint: !!existing?.endpoint })
    setDestinations([]); setNextCursor(undefined); setDestinationQuery(''); setInbox(null); setError(''); setNotice('')
  }
  const beginSignIn = async (provider: string) => {
    setBusy('oauth'); setError(''); setNotice('Finish signing in in the window that opens.')
    // Open on the user's click, before the async authenticated launch request.
    const windowRef = window.open('about:blank', 'nalu-connect', 'width=560,height=720'); popup.current = windowRef
    try {
      const url = await beginConnectionSignIn(provider, editor?.id)
      if (!windowRef) { window.location.assign(url); return }
      windowRef.location.assign(url)
      const started = Date.now()
      if (polling.current) clearInterval(polling.current)
      polling.current = setInterval(() => {
        if (windowRef.closed || Date.now() - started > 600000) {
          if (polling.current) clearInterval(polling.current)
          setBusy(''); void load(); onChange()
        }
      }, 800)
    } catch (e) { windowRef?.close(); setError(e instanceof Error ? e.message : 'Could not start sign-in.'); setNotice(''); setBusy('') }
  }
  const save = async () => {
    if (!editor) return
    setBusy('save'); setError(''); setNotice('')
    try {
      const current = await saveConnection({ id: editor.id, app: editor.app, label: editor.label.trim(), method: editor.method, username: editor.username || undefined, secret: editor.secret.trim() || undefined, endpoint: editor.endpoint.trim() || undefined, meta: editor.meta })
      await load(); onChange()
      if (current.status === 'pending') { openEditor(current.app, current); setNotice(current.meta.detail || 'Choose a destination to finish setup.') }
      else { setEditor(null); setNotice(current.meta.detail || 'Connection verified and saved.') }
    } catch (e) {
      if (e instanceof ConnectionSetupError && e.connection) {
        const saved = e.connection
        setEditor(current => current ? { ...current, id: saved.id, secret: '', hasSecret: saved.hasSecret } : current)
        onChange()
      }
      setError(e instanceof Error ? e.message : 'Could not save the connection.'); await load()
    }
    finally { setBusy('') }
  }
  const loadDestinations = async (more = false) => {
    if (!editor?.id) return
    setBusy('destinations'); setError('')
    try {
      const result = await listConnectionDestinations(editor.id, more ? nextCursor : undefined)
      setDestinations(items => more ? [...items, ...result.items.filter(item => !items.some(old => old.id === item.id))] : result.items)
      setNextCursor(result.nextCursor)
      if (!result.items.length && !more) setNotice('No destinations were returned. Check the app permissions or enter a destination you can access.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load destinations.') }
    finally { setBusy('') }
  }
  const definition = editor ? appDef(editor.app) : null
  const webhook = editor?.method === 'endpoint' || editor?.method === 'webhook'
  const hasOAuth = !!definition?.provider && providers.includes(definition.provider)
  const canSave = !!editor?.label.trim() && !busy && (editor?.method === 'oauth' || (webhook ? !!(editor?.endpoint.trim() || editor?.hasEndpoint) : !!(editor?.secret.trim() || editor?.hasSecret)))

  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/20 p-3 backdrop-blur-sm sm:p-6" onClick={onClose}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="App connections" tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-glass/25 bg-panel/50 text-ink shadow-2xl backdrop-blur-2xl outline-none" onClick={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab') {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || [])].filter(el => el.getClientRects().length)
        const first = controls[0], last = controls[controls.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
      <header className="flex items-start justify-between gap-3 border-b border-glass/15 px-5 py-4">
        <div><h2 className="flex items-center gap-2 font-semibold"><Plug size={18} /> Connections</h2><p className="mt-1 text-xs text-dim">Your accounts, ready for your workflows.</p></div>
        <button aria-label="Close connections" onClick={onClose} className="rounded-lg p-2 hover:bg-glass/10"><X size={18} /></button>
      </header>
      <div className="overflow-y-auto overscroll-contain p-5">
        {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm"><span className="flex-1">{error}</span><button aria-label="Retry loading connections" onClick={() => { setError(''); void load() }}><RefreshCw size={16} /></button></div>}
        {notice && <p role="status" className="mb-4 rounded-xl border border-gold/30 bg-gold/10 p-3 text-sm">{notice}</p>}
        {!editor ? <>
          <ConnectionPostReviews />
          {connections.length > 0 && <div className="mb-6 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-dim">Your accounts</h3>
            {connections.map(connection => <div key={connection.id} className="rounded-2xl border border-glass/15 bg-glass/[0.05] p-3">
              <div className="flex items-center gap-3"><ConnLogo app={connection.app} size={23} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{connection.label}</p><p className="truncate text-xs text-dim">{connection.username || appDef(connection.app).name}{connection.meta.destinationName ? ` · ${connection.meta.destinationName}` : ''}</p></div><span className={`rounded-full px-2 py-1 text-xs ${connection.status === 'connected' ? 'bg-emerald-400/15' : connection.status === 'error' ? 'bg-red-400/15' : 'bg-gold/15'}`}>{connection.status === 'connected' ? 'Connected' : connection.status === 'error' ? 'Needs attention' : 'Finish setup'}</span></div>
              {connection.meta.detail && <p className="mt-2 text-xs text-dim">{connection.meta.detail}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={buttonClass} onClick={() => openEditor(connection.app, connection)}>Manage</button>
                <button className={buttonClass} disabled={!!busy} onClick={async () => { setBusy(connection.id); setError(''); const result = await testConnection(connection.id); result.ok ? setNotice(result.detail) : setError(result.detail); await load(); onChange(); setBusy('') }}>{busy === connection.id ? <Loader2 size={16} className="animate-spin" /> : 'Check connection'}</button>
                {connection.meta.capabilities?.includes('inbox') && <button className={buttonClass} disabled={!!busy} onClick={async () => { setBusy(`inbox-${connection.id}`); setError(''); try { setInbox({ label: connection.label, items: await getInbox(connection.id, 10) }) } catch (e) { setError(e instanceof Error ? e.message : 'Could not read recent items.') } finally { setBusy('') } }}>Recent items</button>}
                <button aria-label={`Disconnect ${connection.label}`} className="ml-auto rounded-xl p-2 text-dim hover:bg-red-400/10" onClick={() => setConfirmDelete(connection.id)}><Trash2 size={16} /></button>
              </div>
              {confirmDelete === connection.id && <div className="mt-3 rounded-xl border border-glass/15 p-3 text-sm"><p>Disconnect {connection.label}? Pipelines using it will need another connection.</p><div className="mt-2 flex gap-2"><button className={buttonClass} disabled={!!busy} onClick={async () => { setBusy('delete'); try { await deleteConnection(connection.id); setConfirmDelete(''); await load(); onChange() } catch (e) { setError(e instanceof Error ? e.message : 'Could not disconnect.') } finally { setBusy('') } }}>Disconnect</button><button className={buttonClass} onClick={() => setConfirmDelete('')}>Keep connected</button></div></div>}
            </div>)}
          </div>}
          {inbox && <section className="mb-5 rounded-2xl border border-glass/20 p-4"><div className="mb-3 flex justify-between gap-2"><h3 className="text-sm font-semibold">Recent items · {inbox.label}</h3><button aria-label="Close recent items" onClick={() => setInbox(null)}><X size={16} /></button></div>{inbox.items.length ? inbox.items.map(item => <article key={item.id} className="border-t border-glass/10 py-3"><p className="text-sm font-medium">{item.subject}</p><p className="text-xs text-dim">{item.from}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.body}</p></article>) : <p className="text-sm text-dim">No recent items.</p>}</section>}
          <label className="flex items-center gap-2 rounded-xl border border-glass/20 px-3"><Search size={16} /><input aria-label="Find an app" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find an app…" className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none" /></label>
          <div className="mt-3 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">{CONNECT_APPS.filter(app => `${app.name} ${app.blurb}`.toLowerCase().includes(query.toLowerCase())).map(app => <button key={app.app} onClick={() => openEditor(app.app)} className="flex items-start gap-3 rounded-2xl border border-glass/15 bg-glass/[0.04] p-3 text-left hover:border-gold/40 hover:bg-glass/[0.08]"><span className="mt-1 shrink-0"><ConnLogo app={app.app} size={22} /></span><span><span className="block text-sm font-medium">{app.name}</span><span className="mt-1 block text-xs leading-relaxed text-dim">{app.blurb}</span></span></button>)}</div>
        </> : <>
          <button className="mb-4 flex items-center gap-1 text-sm text-dim hover:text-ink" onClick={() => { setEditor(null); setError(''); setNotice('') }}><ChevronLeft size={16} /> All connections</button>
          <div className="flex items-center gap-3"><ConnLogo app={editor.app} size={28} /><div><h3 className="font-semibold">{editor.id ? 'Manage' : 'Connect'} {definition!.name}</h3><p className="text-xs text-dim">{definition!.blurb}</p></div></div>
          {hasOAuth && <button disabled={!!busy} onClick={() => void beginSignIn(definition!.provider!)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gold px-4 py-3 text-sm font-semibold text-[#15170f] disabled:opacity-50">{busy === 'oauth' ? <Loader2 size={17} className="animate-spin" /> : <ExternalLink size={16} />}{busy === 'oauth' ? 'Finish sign-in in the open window' : `${editor.id ? 'Reconnect' : 'Sign in'} with ${definition!.name}`}</button>}
          {definition!.provider && !hasOAuth && <p className="mt-3 rounded-xl border border-gold/25 bg-gold/[0.07] p-3 text-xs leading-relaxed">Nalu’s {definition!.name} sign-in needs provider setup. {definition!.tokenLabel ? 'You can also connect with a supported access token below.' : 'Use an existing webhook while sign-in is being configured.'}</p>}
          {definition!.requirement && <p className="mt-3 text-xs leading-relaxed text-dim">{definition!.requirement}</p>}
          <label className="mt-5 block text-xs font-medium">Connection name<input aria-label="Connection name" value={editor.label} onChange={e => setEditor({ ...editor, label: e.target.value })} className={inputClass} /></label>
          {editor.method !== 'oauth' && <>
            {editor.app !== 'webhook' && <label className="mt-4 block text-xs font-medium">Connection method<select aria-label="Connection method" className={inputClass} value={webhook ? 'endpoint' : editor.app === 'gmail' ? 'smtp' : 'apikey'} onChange={e => setEditor({ ...editor, method: e.target.value as ConnMethod, secret: '', hasSecret: false, hasEndpoint: false })}>{definition!.tokenLabel && <option value={editor.app === 'gmail' ? 'smtp' : 'apikey'}>{editor.app === 'gmail' ? 'Google App Password' : 'Access token'}</option>}<option value="endpoint">Webhook</option></select></label>}
            {webhook && <label className="mt-4 block text-xs font-medium">Webhook URL<input aria-label="Webhook URL" type="url" autoComplete="off" value={editor.endpoint} placeholder={editor.hasEndpoint ? 'Saved URL — leave blank to keep it' : 'https://…'} onChange={e => setEditor({ ...editor, endpoint: e.target.value })} className={inputClass} /></label>}
            {editor.app === 'gmail' && !webhook && <label className="mt-4 block text-xs font-medium">Gmail address<input aria-label="Gmail address" type="email" autoComplete="email" value={editor.username} onChange={e => setEditor({ ...editor, username: e.target.value })} className={inputClass} /></label>}
            <label className="mt-4 block text-xs font-medium">{webhook ? 'Authorization token (optional)' : definition!.tokenLabel}<input aria-label={webhook ? 'Authorization token' : definition!.tokenLabel} type="password" autoComplete="new-password" value={editor.secret} onChange={e => setEditor({ ...editor, secret: e.target.value })} placeholder={editor.hasSecret ? 'Saved securely — leave blank to keep it' : webhook ? 'Only if your webhook requires one' : 'Paste the app credential'} className={inputClass} /></label>
            {editor.app === 'gmail' && !webhook && <p className="mt-2 text-xs text-dim">Use a Google App Password with 2-Step Verification enabled. <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-gold underline">Create an App Password</a></p>}
          </>}
          {definition!.destination && !webhook && <section className="mt-5 rounded-2xl border border-glass/15 p-3"><label className="block text-xs font-medium">{definition!.destination === 'repository' ? 'Repository (owner/repository)' : definition!.destination === 'subreddit' ? 'Subreddit (without r/)' : `Selected ${definition!.destination}`}<input aria-label="Publishing destination" className={inputClass} value={editor.meta.destination || ''} onChange={e => setEditor({ ...editor, meta: { ...editor.meta, destination: e.target.value, destinationName: e.target.value } })} placeholder={definition!.destination === 'repository' ? 'owner/repository' : definition!.destination === 'subreddit' ? 'community' : `Choose a ${definition!.destination}`} /></label>
            {editor.id ? <><button className={`${buttonClass} mt-3`} disabled={!!busy} onClick={() => void loadDestinations()}>Browse {definition!.destination === 'repository' ? 'repositories' : `${definition!.destination}s`}</button>{destinations.length > 0 && <><input aria-label="Search destinations" className={inputClass} placeholder="Search destinations…" value={destinationQuery} onChange={e => setDestinationQuery(e.target.value)} /><div className="mt-2 max-h-48 overflow-y-auto">{destinations.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(destinationQuery.toLowerCase())).map(item => <button key={item.id} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-glass/10" onClick={() => setEditor({ ...editor, meta: { ...editor.meta, destination: item.id, destinationName: item.name } })}>{item.name}{editor.meta.destination === item.id && <CheckCircle2 size={16} />}</button>)}</div></>}{nextCursor && <button disabled={!!busy} className={`${buttonClass} mt-2`} onClick={() => void loadDestinations(true)}>Load more</button>}</> : <p className="mt-2 text-xs text-dim">After verifying this account, you can browse its available destinations.</p>}
          </section>}
          <div className="mt-5 flex justify-end gap-2"><button className={buttonClass} onClick={() => setEditor(null)}>Cancel</button><button disabled={!canSave} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-gold px-4 py-2 text-sm font-semibold text-[#15170f] disabled:opacity-40">{busy === 'save' && <Loader2 size={16} className="animate-spin" />}{busy === 'save' ? 'Verifying…' : editor.id ? 'Save connection' : 'Verify and connect'}</button></div>
        </>}
      </div>
    </div>
  </div>
}
