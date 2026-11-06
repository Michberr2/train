import { useEffect, useRef, useState } from 'react'
import { Globe, Hand, ArrowRight, Plus, Square } from 'lucide-react'
import { hostedBrowserRequest as deviceRequest, ensureHostedBrowser } from './hostedBrowser'
import { getToken } from '../../lib/localAuth'
import './browser-workspace.css'

type TaskTracking = { current: {id:string;task:string;agent:string;last?:string}|null }
type State = { tabs?: { index: number; title: string; active: boolean }[]; cursor?: { x: number; y: number }; active?: boolean; status: string; image?: string | null; url?: string; detail?: string; result?: string; task?: string; steps?: string[]; agents?: { id: string; status: string; active: boolean }[] }
export default function HostedBrowserPanel({ token, requests = [], onRequestConsumed, onTaskUpdate, taskTracking }: { token: string | null; requests?: {id:string;task:string;token:string}[]; onRequestConsumed?: (id:string) => void; onTaskUpdate?: (id:string, content:string) => void; taskTracking?: TaskTracking }) {
  const pending = requests.find(request => request.token === token)
  const submitted = useRef(new Set<string>())
  const localTracking = useRef<TaskTracking["current"]>(null)
  const activeRequest = taskTracking || localTracking
  const [connected, setConnected] = useState(true), [starting, setStarting] = useState(true)
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [agent, setAgent] = useState('main'), [url, setUrl] = useState('https://www.microsoft365.com/'), [task, setTask] = useState(''), [reply, setReply] = useState('')
  const addressEditing = useRef(false)
  useEffect(()=>{if(state?.url && state.url!=='about:blank' && !addressEditing.current)setUrl(state.url)},[state?.url])
  const actionError = useRef(false)
  const generation = useRef(0), mutation = useRef(false), sequence = useRef(0), inputQueue = useRef(Promise.resolve())
  const running = ['running', 'queued'].includes(state?.status || '')
  useEffect(() => { setConnected(!!token); setState(null); generation.current++ }, [token])
  useEffect(() => { setState(null) }, [agent])
  useEffect(() => {
    const revision = ++generation.current, controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const snapshot = sequence.current
      if (!mutation.current) try {
        const value = await deviceRequest('workspace_screen', { agent_id: agent }, controller.signal, token)
        if (generation.current === revision && !controller.signal.aborted && !mutation.current && sequence.current === snapshot) { setState(value); if(value.active && !actionError.current) setError('') }
      } catch (e) { if (!controller.signal.aborted && generation.current === revision) setError((e as Error).message) }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1200)
    }
    if (connected && !starting) void poll()
    return () => { controller.abort(); clearTimeout(timer); generation.current++ }
  }, [connected, agent, token, starting])
  async function act(action: string, data: Record<string, unknown> = {}) {
    if (mutation.current) return
    mutation.current = true; actionError.current = false; sequence.current++; setBusy(true); setError(''); const revision = generation.current
    try {
      if (action !== 'workspace_takeover') await inputQueue.current.catch(() => {})
      const value = await deviceRequest(action, { ...data, agent_id: agent }, undefined, token)
      if (token !== getToken() || revision !== generation.current) return
      if(action==='workspace_resume' && activeRequest.current && value.task)activeRequest.current.task=value.task
      if (action === 'disconnect') { setConnected(false); setState(null) }
      else { setConnected(true); setState(old => ({ ...old, ...value, ...(!value.active ? { image: null } : {}) })) }
    } catch (e) { if (revision === generation.current) { actionError.current = true; setError((e as Error).message); if(activeRequest.current){onTaskUpdate?.(activeRequest.current.id, 'Browser task could not start or continue: '+(e as Error).message+'. Check Browser before retrying.'); activeRequest.current=null} } }
    finally { mutation.current = false; setBusy(false) }
  }
  useEffect(() => {
    if (!token) { setStarting(false); return }
    let current = true; setStarting(true); setError('')
    void ensureHostedBrowser(token).then(value => { if(current && token === getToken()) setState(value) }).catch(e => { if(current) setError(e.message) }).finally(() => { if(current) setStarting(false) })
    return () => { current = false }
  }, [token])
  // Carry the real browser outcome back to the originating chat message.
  useEffect(() => {
    const request=activeRequest.current
    if(!request || request.agent!==agent || !state || state.task!==request.task)return
    const content=state.status==='done' ? state.result || 'The browser agent finished without returning an answer. Check Browser before retrying.'
      : ['needs_help','paused'].includes(state.status) ? 'Browser needs your help: '+(state.detail || 'Open Browser to sign in or continue.')
      : state.status==='error' ? 'Browser task failed: '+(state.detail || 'Open Browser for details.')
      : ['running','queued'].includes(state.status) ? 'Nalu is '+(state.status==='queued'?'waiting for a browser slot':'working in your browser')+'.'+(state.detail?' '+state.detail:'') : ''
    if(content && request.last!==content){request.last=content;onTaskUpdate?.(request.id,content)}
    if(['done','error'].includes(state.status))activeRequest.current=null
  }, [state, agent, onTaskUpdate])
  useEffect(() => { if (pending) setTask(pending.task) }, [pending?.id])
  useEffect(() => {
    if (!pending || starting || busy || running || !connected || !state?.active || submitted.current.has(pending.id)) return
    submitted.current.add(pending.id)
    activeRequest.current={id:pending.id,task:pending.task,agent}
    onRequestConsumed?.(pending.id)
    void act('workspace_run', { task: pending.task })
  }, [pending?.id, starting, busy, running, connected, state?.active])
  const input = (data: Record<string, unknown>) => {
    if (running) return
    const revision = generation.current; sequence.current++
    inputQueue.current = inputQueue.current.catch(() => {}).then(async () => {
      if (revision !== generation.current || token !== getToken()) return
      try { await deviceRequest('workspace_input', { ...data, agent_id: agent }, undefined, token) }
      catch (e) { if (revision === generation.current) setError((e as Error).message) }
    })
  }
  return <div className="nalu-browser" data-cursor-exempt>
    <header className="nalu-browser-header"><div><Globe size={22}/><div><h2>Your browser</h2><p>Starts automatically in Nalu. Your account and each agent have separate browser profiles.</p></div></div>
      {connected && <div className="nalu-browser-controls"><button disabled={busy} onClick={() => void act('disconnect')}>Pause browsers</button></div>}
    </header>
    {error && <p className="nalu-browser-error" role="alert">{error}</p>}
    {starting && <p role="status">Starting your private browser…</p>}
    {!connected ? <section className="nalu-browser-task"><h3>Your browsers are paused</h3><p>Your saved browser profiles stay private to your account.</p><button disabled={busy} onClick={() => void act('workspace_open')}>Open browser</button></section> : <>
      {pending && <p role="status">Your request will start automatically when this browser is ready.</p>}
      {state?.detail && <p role="status">{state.detail}</p>}
      {['paused', 'needs_help'].includes(state?.status || '') && <div className="nalu-browser-address"><input aria-label="Reply to Nalu" value={reply} onChange={e => setReply(e.target.value)} maxLength={2000} placeholder="Optional reply or clarification"/><button disabled={busy} onClick={() => { void act('workspace_resume', { reply }); setReply('') }}>Continue task</button></div>}
      {state?.result && <section className="nalu-browser-result"><strong>Agent reported completion</strong><pre>{state.result}</pre></section>}
      <div className="nalu-browser-shortcuts" role="group" aria-label="Agent browsers">
        {(state?.agents || [{ id: agent, status: 'idle' }]).map(a => <button key={a.id} aria-pressed={agent === a.id} disabled={busy} onClick={() => setAgent(a.id)}>{a.id === 'main' ? 'Nalu' : a.id} · {a.status}</button>)}
        <button disabled={busy} onClick={() => { setAgent('agent-' + crypto.randomUUID().slice(0, 8)); setTask('') }}><Plus size={14}/>New agent browser</button>
      </div>
      <form className="nalu-browser-address" onSubmit={e => { e.preventDefault(); void act('workspace_open', { url }) }}>
        <Globe size={16}/><input aria-label="Website address" type="url" onFocus={()=>{addressEditing.current=true}} onBlur={()=>{addressEditing.current=false}} value={url} onChange={e => setUrl(e.target.value)} required/>
        <button disabled={busy || running || starting}>{state?.active ? 'Go' : 'Open browser'}<ArrowRight size={15}/></button>
        {state?.active && <button type="button" disabled={busy} onClick={() => void act('workspace_close')} aria-label="Close browser"><Square size={16}/></button>}
      </form>
      {state?.active && <div className="nalu-browser-shortcuts" aria-label="Browser tabs">
        {state.tabs?.map(t => <button key={t.index} aria-pressed={t.active} disabled={busy || running || starting} onClick={() => void act('workspace_tab', { operation: 'switch', index: t.index })}>{t.title.slice(0, 35) || `Tab ${t.index + 1}`}</button>)}
        <button disabled={busy || running || starting} onClick={() => void act('workspace_tab', { operation: 'new', url })}>New tab</button>
        {(state.tabs?.length || 0) > 1 && <button disabled={busy || running || starting} onClick={() => void act('workspace_tab', { operation: 'close' })}>Close tab</button>}
      </div>}
      <div className="nalu-browser-screen" style={{ position: 'relative' }}>
        {state?.image ? <div style={{ position: 'relative' }} tabIndex={running ? -1 : 0} role="application" aria-label="Browser controls. Take control to click and type."
          onKeyDown={e => { if (running || ['Control', 'Meta', 'Shift', 'Alt'].includes(e.key) || (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; e.preventDefault(); const modifiers = [e.ctrlKey && 'Control', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean); input(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? { kind: 'text', text: e.key } : { kind: 'key', key: [...modifiers, e.key].join('+') }) }}
          onPaste={e => { if (!running) { e.preventDefault(); input({ kind: 'text', text: e.clipboardData.getData('text/plain') }) } }}
          onWheel={e => { if (!running) input({ kind: 'scroll', delta: e.deltaY }) }}>
          <img src={state.image} alt="Your private Nalu browser" draggable={false} style={{ display: 'block', width: '100%', cursor: running ? 'default' : 'crosshair' }} onClick={e => {
            if (running) return; e.currentTarget.parentElement?.focus(); const r = e.currentTarget.getBoundingClientRect()
            input({ kind: 'click', x: Math.floor((e.clientX - r.left) / r.width * 1440), y: Math.floor((e.clientY - r.top) / r.height * 900) })
          }}/>
          {state.cursor && <span aria-label={`${agent} cursor`} style={{ position: 'absolute', pointerEvents: 'none', left: `${state.cursor.x / 1440 * 100}%`, top: `${state.cursor.y / 900 * 100}%`, color: '#2f7664', fontSize: 23, textShadow: '0 0 2px white' }}>➤</span>}
        </div> : <div className="nalu-browser-empty"><Globe size={42}/><h3>Open a website to begin.</h3><p>Each agent has its own browser and virtual mouse. Website logins are separate between accounts and agents.</p></div>}
        {running && <div className="nalu-browser-working"><span>Nalu is working in your private browser.</span><button disabled={busy} onClick={() => void act('workspace_takeover')}><Hand size={16}/>Take control</button></div>}
      </div>
      <form className="nalu-browser-task" onSubmit={e => { e.preventDefault(); if(pending){submitted.current.add(pending.id);activeRequest.current={id:pending.id,task,agent};onRequestConsumed?.(pending.id)} void act('workspace_run', { task }) }}>
        <label htmlFor="device-browser-task">What should this agent do?</label><div><textarea id="device-browser-task" value={task} onChange={e => setTask(e.target.value)} maxLength={6000} required placeholder="Find the document, make the requested changes, and verify it saved."/><button disabled={busy || running || starting || !task.trim()}>Run task<ArrowRight size={16}/></button></div>
        <small>Nalu hosts this browser for your account. Its online AI uses page content and screenshots to do your task. Take control to sign in or help. Sessions pause after 15 minutes; open the browser again to continue.</small>
      </form>
      {!!state?.steps?.length && <details><summary>Activity · {state.steps.length} steps</summary><ol>{state.steps.map((step, i) => <li key={i}>{step}</li>)}</ol></details>}
    </>}
  </div>
}
