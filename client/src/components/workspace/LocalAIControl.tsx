import { useEffect, useRef, useState } from 'react'
import { Cpu, Download, X } from 'lucide-react'
import { checkLocalDevice, getLocalAIState, getLocalPreferences, prepareLocalCrew, resetLocalAI, setLocalPreferences, type LocalPreferences } from '../../lib/localAI'
import { LOCAL_CREW } from '../../lib/localAIProtocol'

/** Always reachable from chat; preferences are specific to this browser. */
export default function LocalAIControl({ panel = false }: { panel?: boolean }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(getLocalAIState)
  const [preferences, setPreferences] = useState(getLocalPreferences)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [device, setDevice] = useState('')
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
    let current = true
    void checkLocalDevice().then(result => { if (current) setDevice(`GPU available · ${result.halfPrecision ? 'efficient 16-bit' : '32-bit'} models`) }).catch(error => { if (current) setDevice(error.message) })
    return () => { current = false }
  }, [open, panel])
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
      await checkLocalDevice()
      setLocalPreferences({ ...preferences, enabled: true })
      await prepareLocalCrew(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not prepare this computer.')
    } finally { if (loading.current === controller) { setBusy(false); loading.current = undefined } }
  }
  const change = (profile: LocalPreferences['profile']) => {
    loading.current?.abort(); loading.current = undefined; setBusy(false)
    resetLocalAI(); setLocalPreferences({ enabled: preferences.enabled, profile }); setError('')
  }
  const content = <div className="space-y-4 text-sm">
    <div><h2 id={panel ? 'local-ai-panel-title' : 'local-ai-dialog-title'} className="text-xl font-semibold">Your computer. Your Nalu.</h2><p className="mt-2 text-dim">Run your AI crew on this device. Model downloads use the internet; replies are generated here without cloud inference charges. Saved chats still sync with your Nalu account.</p></div>
    <p className="rounded-lg bg-glass/10 p-3 text-xs" role="status">{device || 'Checking GPU support…'}</p>
    <label className="block font-medium">Crew size<select className="mt-2 block w-full rounded-lg border border-glass/20 bg-panel p-3 text-ink" value={preferences.profile} onChange={event => change(event.target.value as LocalPreferences['profile'])}>
      <option value="balanced">Specialist crew — three small models, four roles</option><option value="compact">Compact — one shared lightweight model</option>
    </select></label>
    {preferences.profile === 'balanced' ? <ul className="space-y-2">{Object.values(LOCAL_CREW).map(member => <li key={member.name} className="flex items-start gap-3 rounded-lg border border-glass/15 p-3"><Cpu size={16} className="mt-1 shrink-0" /><div><strong>{member.name}</strong><p className="text-xs text-dim">{member.purpose} · {member.model}</p></div></li>)}</ul> : <p className="text-dim">Qwen3.5 0.8B handles all roles with less memory use. It is faster to download but less capable on difficult tasks.</p>}
    <p className="text-xs text-dim">{preferences.profile === 'balanced' ? 'The crew shares three models across four roles. Allow several GB of browser storage and about 4–6 GB of available GPU memory. Models download as needed; only one occupies GPU memory at a time. Writing gets a separate local review pass.' : 'Allow approximately 1 GB of storage and 2–3 GB of available GPU memory.'} Speed and answer quality depend on your computer. Keep this tab open while Nalu works. This crew currently reads text; local vision, media generation, and unattended automation need separate support.</p>
    <div aria-live="polite"><p>{state.message}</p>{state.phase === 'loading' && <progress aria-label="Model preparation" value={state.progress} max={1} className="mt-2 w-full accent-emerald-500" />}</div>
    {error && <p role="alert" className="rounded-lg border border-red-400/40 p-3 text-red-500">{error}</p>}
    <div className="flex flex-wrap gap-3"><button className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-3 text-white disabled:opacity-50" onClick={() => void enable()} disabled={busy || ['checking', 'loading', 'generating'].includes(state.phase)}><Download size={16} />{busy ? 'Preparing on this device…' : preferences.enabled ? 'Prepare crew' : 'Download and enable crew'}</button>
    {(busy || state.phase === 'loading' || state.phase === 'ready' || state.phase === 'error') && <button className="rounded-lg border border-glass/20 px-4 py-3" onClick={() => { loading.current?.abort(); loading.current = undefined; setBusy(false); resetLocalAI() }}>{busy || state.phase === 'loading' ? 'Cancel download' : 'Release GPU memory'}</button>}</div>
  </div>
  if (panel) return content
  return <>
    <button ref={button} className="inline-flex items-center gap-1.5 rounded-lg border border-glass/20 px-2.5 py-1.5 text-xs" onClick={() => setOpen(true)} aria-label="On-device AI setup"><Cpu size={14} /><span>{state.phase === 'loading' ? `Loading ${Math.round(state.progress * 100)}%` : state.phase === 'generating' ? 'Thinking locally' : preferences.enabled ? 'On this device' : 'Set up local AI'}</span></button>
    {open && <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="local-ai-dialog-title" tabIndex={-1} className="relative max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-glass/20 bg-panel p-6 text-ink shadow-2xl" onClick={event => event.stopPropagation()}><button aria-label="Close on-device AI setup" className="absolute right-3 top-3 p-2" onClick={() => setOpen(false)}><X size={18} /></button>{content}</div></div>}
  </>
}
