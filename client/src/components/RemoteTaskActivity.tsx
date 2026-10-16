import { useEffect, useRef, useState } from 'react'

type Task = {
  id: string; title: string; source: string; status: string; detail?: string; updated_at: string
  events?: { m: string; t: string }[]; meta?: { kind?: string; repo?: string; result?: string; artifactUrl?: string; messageDelivery?: string; messageError?: string; pendingQuestion?: { id: string; text: string } }
}

// The same account-scoped ledger displayed by Nalu Mobile. No work is launched
// by opening this view; task controls act on an existing server ID.
export default function RemoteTaskActivity({ apiBase = '', readToken }: { apiBase?: string; readToken: () => string | null }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState('')
  const [signedIn, setSignedIn] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const pending = useRef(false)
  const accountToken = useRef<string | null>(null)
  const mounted = useRef(true)
  const cancelRequest = useRef<AbortController | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelRequest.current?.abort() } }, [])
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout>
    let controller: AbortController | null = null
    const load = async () => {
      const token = readToken()
      if (token !== accountToken.current) { setTasks([]); setError(''); accountToken.current = token }
      setSignedIn(!!token)
      if (!token) { if (current) timer = setTimeout(load, 4000); return }
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 15000)
      try {
        const response = await fetch(`${apiBase}/api/data`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'task-feed' }), signal: controller.signal,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || !Array.isArray(data?.tasks)) throw new Error(data?.error || 'Task updates are unavailable. Retrying…')
        if (current && readToken() === token) {
          setTasks(data.tasks.filter((task: Task) => task && typeof task.id === 'string').sort((a: Task, b: Task) => Date.parse(b.updated_at) - Date.parse(a.updated_at)))
          setError('')
        }
      } catch (err) { if (current && readToken() === token) setError(err instanceof Error ? err.message : 'Task updates are unavailable.') }
      finally {
        clearTimeout(timeout)
        if (current) timer = setTimeout(load, document.visibilityState === 'hidden' ? 15000 : 4000)
      }
    }
    void load()
    return () => { current = false; clearTimeout(timer); controller?.abort() }
  }, [apiBase, readToken, reload])

  const cancel = async (id: string) => {
    const token = readToken()
    if (!token || pending.current) return
    pending.current = true; setBusy(id)
    const controller = new AbortController()
    cancelRequest.current = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`${apiBase}/api/data`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'task-cancel', id }), signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'Could not cancel this task.')
      if (mounted.current && readToken() === token) setReload((value) => value + 1)
    } catch (err) { if (mounted.current && readToken() === token) setError(err instanceof Error ? err.message : 'Could not cancel this task.') }
    finally { clearTimeout(timeout); pending.current = false; if (mounted.current) setBusy(null) }
  }
  const active = tasks.filter((task) => task.status === 'running' || task.status === 'queued' || task.status === 'waiting')
  return (
    <details className="mx-2 my-2 shrink-0 rounded-xl border border-glass/10 bg-panel/80 text-ink" style={{ maxHeight: '45vh', overflow: 'auto' }}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Task activity{active.length ? ` · ${active.length} active` : ''}{error ? ' · updates unavailable' : ''}</summary>
      <div className="space-y-2 px-3 pb-3">
        <p className="text-xs text-dim">{signedIn ? 'Voice, CLI, desktop, and web work for your account.' : 'Sign in to see your tasks across devices.'}</p>
        {!!error && <p role="alert" className="text-xs" style={{ color: '#ef8883' }}>{error}</p>}
        {signedIn && !tasks.length && !error && <p className="text-xs text-dim">No recorded tasks yet.</p>}
        {[...active, ...tasks.filter((task) => !active.includes(task))].map((task) => (
          <details key={task.id} className="rounded-lg border border-glass/10 p-2 text-xs">
            <summary className="cursor-pointer"><span style={{ color: task.status === 'failed' ? '#ef8883' : task.status === 'done' ? '#55bb91' : '#83adff' }}>{task.status}</span>{' · '}{task.title || 'Untitled task'}{task.meta?.repo ? ` · ${task.meta.repo}` : ''}</summary>
            <p className="mt-2 text-dim">{task.source} · {new Date(task.updated_at).toLocaleString()}</p>
            {!!task.detail && <p className="mt-2 whitespace-pre-wrap">{task.detail}</p>}
            {task.status === 'waiting' && task.meta?.pendingQuestion && <p role="status" className="mt-2 whitespace-pre-wrap" style={{ color: '#dfbe85' }}>{task.meta.pendingQuestion.text} Answer in Nalu Voice or on the phone when Nalu calls.</p>}
            {!!task.events?.length && <ol className="mt-2 space-y-1 text-dim">{task.events.slice(-8).map((event, index) => <li key={index}>{event.m}</li>)}</ol>}
            {typeof task.meta?.result === 'string' && !!task.meta.result && <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{task.meta.result}</pre>}
            {typeof task.meta?.artifactUrl === 'string' && task.meta.artifactUrl.startsWith('https://n4lu.ai/api/message-media?') && <a href={task.meta.artifactUrl} target="_blank" rel="noopener noreferrer"><img src={task.meta.artifactUrl} alt={task.title || 'Generated image'} loading="lazy" className="mt-2 rounded-lg" style={{ maxWidth: '100%', maxHeight: 320, objectFit: 'contain' }} /></a>}
            {!!task.meta?.messageDelivery && <p className="mt-2 text-dim">Message delivery: {task.meta.messageDelivery.replace(/_/g, ' ')}{task.meta.messageError ? ` · ${task.meta.messageError}` : ''}</p>}
            {task.meta?.kind === 'remote' && (task.status === 'queued' || task.status === 'running' || task.status === 'waiting') && <button disabled={busy !== null} onClick={() => void cancel(task.id)} className="mt-2 rounded border border-glass/10 px-2 py-1">{busy === task.id ? 'Stopping…' : 'Cancel task'}</button>}
          </details>
        ))}
      </div>
    </details>
  )
}
