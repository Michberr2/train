import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Cpu, Download, X } from 'lucide-react'
import { checkLocalDevice, getLocalAIState, getLocalPreferences, prepareLocalCrew, resetLocalAI, setLocalPreferences, type LocalPreferences } from '../../lib/localAI'
import { LOCAL_CREW } from '../../lib/localAIProtocol'
import { browserCPUModel } from '../../lib/browserCPU'
import { ollamaModelId } from '../../lib/localOllama'
import { ollamaSetup } from '../../lib/localOllamaSetup'

/** Always reachable from chat; preferences are specific to this browser. */
export default function LocalAIControl({ panel = false, trigger = true }: { panel?: boolean; trigger?: boolean }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(getLocalAIState)
  const [preferences, setPreferences] = useState(getLocalPreferences)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [device, setDevice] = useState('')
  const [platform, setPlatform] = useState<'windows' | 'unix'>(() => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix')
  const companion = preferences.provider === 'ollama'
  const setup = ollamaSetup(preferences.profile, platform, location.origin, preferences.cpuOnly)
  const button = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const loading = useRef<AbortController>()
  useEffect(() => {
    const update = () => { setState(getLocalAIState()); setPreferences(getLocalPreferences()) }
    const setup = () => setOpen(true)
    window.addEventListener('nalu-local-ai', update)
    window.addEventListener('nalu-local-ai-setup', setup)
    return () => { window.removeEventListener('nalu-local-ai', update); window.removeEventListener('nalu-local-ai-setup', setup); loading.current?.abort() }
  }, [])
  useEffect(() => {
    if (!open && !panel) return
    if (companion) { setDevice(`${preferences.cpuOnly ? 'CPU-only mode is selected.' : 'Ollama can use this computer’s CPU and GPU.'} Connect below to verify the installed crew and local-only mode.`); return }
    let current = true
    void checkLocalDevice().then(result => { if (current) setDevice(`GPU available · ${result.halfPrecision ? 'efficient 16-bit' : '32-bit'} models`) }).catch(() => { if (current) setDevice('Nalu will use this browser’s CPU when the GPU is unavailable.') })
    return () => { current = false }
  }, [open, panel, companion, preferences.cpuOnly])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); return }
      if (event.key !== 'Tab') return
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,[href]') || [])
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); previous?.focus() }
  }, [open])
  const enable = async () => {
    setBusy(true); setError('')
    const controller = new AbortController(); loading.current = controller
    try {
      setLocalPreferences({ ...preferences, enabled: true })
      await prepareLocalCrew(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not prepare this computer.')
    } finally { if (loading.current === controller) { setBusy(false); loading.current = undefined } }
  }
  const change = (patch: Partial<LocalPreferences>) => {
    loading.current?.abort(); loading.current = undefined; setBusy(false)
    resetLocalAI(); setLocalPreferences({ ...preferences, ...patch }); setError('')
  }
  const content = <div className="space-y-4 text-sm">
    <div><h2 id={panel ? 'local-ai-panel-title' : 'local-ai-dialog-title'} className="text-xl font-semibold">Your computer. Your Nalu.</h2><p className="mt-2 text-dim">Just ask Nalu. It automatically runs your AI in this browser using this computer’s available hardware. Model files download when first needed and stay cached here. Replies are generated on this computer; saved chats still sync with your account.</p></div>
    <p className="rounded-lg bg-glass/10 p-3 text-xs" role="status">{device || 'Checking GPU support…'}</p>
    <div aria-live="polite"><p>{state.message}</p>{state.phase === 'loading' && <progress aria-label="Model preparation" value={state.progress} max={1} className="mt-2 w-full accent-emerald-500" />}</div>
    <details className="rounded-lg border border-glass/20 p-3"><summary>Advanced AI settings</summary><div className="mt-3 space-y-4">
    <label className="block font-medium">Run AI with<select aria-label="Local AI engine" className="mt-2 block w-full rounded-lg border border-glass/20 bg-panel p-3 text-ink" value={companion ? 'ollama' : 'browser'} onChange={event => change({ provider: event.target.value as LocalPreferences['provider'] })}><option value="browser">Nalu in this browser · automatic CPU/GPU</option><option value="ollama">Optional Ollama companion</option></select></label>
    {companion && <label className="block font-medium">Compute<select aria-label="Companion compute" className="mt-2 block w-full rounded-lg border border-glass/20 bg-panel p-3 text-ink" value={preferences.cpuOnly ? 'cpu' : 'auto'} onChange={event => change({ cpuOnly: event.target.value === 'cpu' })}><option value="auto">Use available CPU and GPU</option><option value="cpu">CPU only</option></select>{preferences.cpuOnly && <p className="mt-2 text-xs font-normal text-dim">CPU mode uses compatible model variants. Follow the updated downloads below if you previously set up GPU mode.</p>}</label>}
    <label className="block font-medium">Crew size<select className="mt-2 block w-full rounded-lg border border-glass/20 bg-panel p-3 text-ink" value={preferences.profile} onChange={event => change({ profile: event.target.value as LocalPreferences['profile'] })}>
      <option value="automatic">Automatic: fit this computer’s hardware</option><option value="balanced">Specialist crew: three small models, four roles</option><option value="compact">Compact: one shared lightweight model</option>
    </select></label>
    {preferences.profile !== 'compact' ? <ul className="space-y-2">{Object.entries(LOCAL_CREW).map(([role, member]) => <li key={member.name} className="flex items-start gap-3 rounded-lg border border-glass/15 p-3"><Cpu size={16} className="mt-1 shrink-0" /><div><strong>{member.name}</strong><p className="text-xs text-dim">{member.purpose} · {companion ? ollamaModelId(role as keyof typeof LOCAL_CREW, preferences.profile, preferences.cpuOnly) : state.backend === 'cpu' ? browserCPUModel(role as keyof typeof LOCAL_CREW, preferences.profile).split('/').pop() : member.model}</p></div></li>)}</ul> : <p className="text-dim">One lightweight model handles all roles with less memory use. Nalu selects a compatible CPU or GPU variant. It downloads faster but is less capable on difficult tasks.</p>}
    {companion && <details className="rounded-lg border border-glass/20 p-3"><summary>Set up Ollama on this computer</summary><p className="mt-3">1. <a className="underline" href="https://ollama.com/download" target="_blank" rel="noreferrer">Install Ollama</a>. Quit its background app if it is already running.</p><p className="mt-2">2. Start a local-only server in a terminal and leave it open.</p><label className="mt-2 block">Terminal<select aria-label="Companion setup platform" value={platform} onChange={event => setPlatform(event.target.value as typeof platform)} className="m-2 rounded border border-glass/20 bg-panel p-2"><option value="unix">macOS / Linux</option><option value="windows">Windows PowerShell</option></select></label><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-glass/10 p-3 text-xs">{setup.start}</pre><p className="mt-3">3. In another terminal, download your crew. Then connect below.</p><pre className="mt-2 rounded bg-glass/10 p-3 text-xs">{setup.pull}</pre><p className="mt-3 text-xs text-dim">Your browser may ask to reach your local network. Nalu connects to this computer at 127.0.0.1:11434. Cloud features must be disabled before a prompt can be sent. <a href="https://docs.ollama.com/faq" target="_blank" rel="noreferrer" className="underline">Ollama setup help</a></p></details>}
    <p className="text-xs text-dim">{companion ? 'Ollama stores the models on this computer and manages CPU/GPU inference. Nalu schedules one model request at a time and releases it after each response. Writing gets a separate local review pass.' : preferences.profile !== 'compact' ? 'Automatic uses the specialist crew on a supported GPU and a lighter shared model on CPU. Choose the specialist crew explicitly to use larger CPU models. Allow several GB of browser storage and working memory. Nalu uses compatible models for the available GPU or CPU, one at a time. Writing gets a separate review pass.' : 'Allow approximately 1 GB of browser storage plus working memory. Nalu uses the available GPU or CPU.'} Speed and answer quality depend on your computer. Keep this tab open while Nalu works. This crew currently reads text; local vision, media generation, and unattended automation need separate support.</p>
    {error && <p role="alert" className="rounded-lg border border-red-400/40 p-3 text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-3"><button className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-3 text-white disabled:opacity-50" onClick={() => void enable()} disabled={busy || ['checking', 'loading', 'generating'].includes(state.phase)}><Download size={16} />{busy ? 'Preparing on this device…' : companion ? 'Connect local crew' : 'Prepare models now'}</button>
    {(busy || ['loading', 'generating', 'ready', 'error'].includes(state.phase)) && <button className="rounded-lg border border-glass/20 px-4 py-3" onClick={() => { loading.current?.abort(); loading.current = undefined; setBusy(false); resetLocalAI() }}>{companion ? 'Stop local work' : busy || state.phase === 'loading' ? 'Cancel download' : 'Release model memory'}</button>}</div>
    </div></details>
  </div>
  if (panel) return content
  return <>
    {trigger && <button ref={button} className="inline-flex items-center gap-1.5 rounded-lg border border-glass/20 px-2.5 py-1.5 text-xs" onClick={() => setOpen(true)} aria-label="AI settings"><Cpu size={14} /><span>{state.phase === 'loading' ? `Loading ${Math.round(state.progress * 100)}%` : state.phase === 'generating' ? 'Thinking locally' : 'AI'}</span></button>}
    {open && createPortal(<div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="local-ai-dialog-title" tabIndex={-1} className="relative max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-glass/20 bg-panel p-6 text-ink shadow-2xl" onClick={event => event.stopPropagation()}><button aria-label="Close on-device AI setup" className="absolute right-3 top-3 p-2" onClick={() => setOpen(false)}><X size={18} /></button>{content}</div></div>, document.body)}
  </>
}
