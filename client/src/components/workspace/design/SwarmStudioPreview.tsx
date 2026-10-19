import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import CardErrorBoundary from '../CardErrorBoundary'
import { ScopedArtifactContext } from '../ScopedArtifactContext'
import { isSwarmMedia } from './swarmTransport'
import type { SwarmArtifactResponse, SwarmController, SwarmMedia, SwarmStudioArtifact, SwarmTask } from './swarmTypes'
import type { DocDoc } from '../DocCard'
import type { Deck } from '../SlidesCard'
import type { SheetDoc } from '../SheetCard'
import type { DesignArtifact } from '../types'
import './swarm-studio-preview.css'

const DocCard = lazy(() => import('../DocCard'))
const SlidesCard = lazy(() => import('../SlidesCard'))
const SheetCard = lazy(() => import('../SheetCard'))
const DesignArtifactCard = lazy(() => import('../DesignArtifactCard'))
const CADCard = lazy(() => import('../CADCard'))
const DESIGN_KINDS = new Set(['website', 'webpage', 'poster', 'motion', 'game', 'board', 'canvas', 'palette', 'brand', 'blueprint', 'logo', 'shopping', 'carousel'])
const errorText = (error: unknown) => error instanceof Error ? error.message : 'This creation could not be loaded. Please retry.'

function SavedMedia({ task, artifact, swarm }: { task: SwarmTask; artifact: SwarmStudioArtifact; swarm: SwarmController }) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const media = artifact.payload.media
  const loader = useRef(swarm.loadArtifactMedia); loader.current = swarm.loadArtifactMedia
  const mediaKey = JSON.stringify(media)
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = ''
    setUrl(''); setError('')
    if (!isSwarmMedia(media) || !loader.current || !task.artifact || !media.mime.startsWith(`${artifact.studioKind}/`)) { setError('This creation has no valid saved media file.'); return }
    void loader.current(task.id, task.artifact.executionId, media, controller.signal).then(blob => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl)
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [task.id, task.artifact?.executionId, mediaKey, retry]) // Payload identity is represented by mediaKey.
  if (error) return <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry media</button></p>
  if (!url) return <p role="status">Loading saved media…</p>
  return <div className="swarm-studio-media">
    {artifact.studioKind === 'video' ? <video src={url} controls preload="metadata"/> : <img src={url} alt={task.title}/>}
    <a href={url} download={(media as SwarmMedia).filename}>Download {artifact.studioKind}</a>
  </div>
}

/** Existing Studio renderers, with ordinary generation/publication/brand writes
 * disabled only within this provider. Changes remain local until the explicit save. */
export function SwarmStudioCard({ task, artifact, swarm, onChange }: { task: SwarmTask; artifact: SwarmStudioArtifact; swarm: SwarmController; onChange: (payload: Record<string, unknown>) => void }) {
  const { studioKind, payload } = artifact
  if (studioKind === 'document') return <DocCard data={payload as DocDoc}/>
  if (studioKind === 'slides') return <SlidesCard data={payload as Deck} onUpdate={deck => onChange({ ...payload, ...deck })}/>
  if (studioKind === 'spreadsheet') return <SheetCard data={payload as SheetDoc}/>
  if (studioKind === 'cad') return <><p className="swarm-studio-note">Model source is saved. This preview compiles it locally; the task remains awaiting geometry verification.</p><CADCard code={String(payload.code || '')}/></>
  if (studioKind === 'image' || studioKind === 'video') return <SavedMedia task={task} artifact={artifact} swarm={swarm}/>
  if (studioKind === 'email') return <article className="swarm-studio-email"><h3>{String(payload.subject || '')}</h3><p>{String(payload.body || '')}</p><button type="button" onClick={() => void navigator.clipboard?.writeText(`Subject: ${String(payload.subject || '')}\n\n${String(payload.body || '')}`)}>Copy email</button></article>
  if (DESIGN_KINDS.has(studioKind)) {
    const art = { ...payload, kind: studioKind === 'website' ? 'webpage' : studioKind } as DesignArtifact
    return <DesignArtifactCard art={art} onUpdate={next => { const { kind: _kind, ...data } = next; onChange({ ...payload, ...data }) }}/>
  }
  return <p role="alert">This creation type cannot be previewed here yet. Its saved work remains on the task.</p>
}

export default function SwarmStudioPreview({ task, swarm, onClose }: { task: SwarmTask; swarm: SwarmController; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const latest = useRef(swarm); latest.current = swarm
  const [saved, setSaved] = useState<SwarmArtifactResponse | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [savedNote, setSavedNote] = useState('')
  const [retry, setRetry] = useState(0), [discard, setDiscard] = useState(false), [editSource, setEditSource] = useState(false)
  const mounted = useRef(true), savePending = useRef(false), editVersion = useRef(0)
  const dirty = !!saved && !!draft && JSON.stringify(draft) !== JSON.stringify(saved.artifact.payload)
  const executionId = task.artifact!.executionId
  useEffect(() => {
    mounted.current = true
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal(); closeButton.current?.focus({ preventScroll: true })
    return () => { mounted.current = false; if (prior?.isConnected) prior.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setSaved(null); setDraft(null); setError(''); setSavedNote(''); setEditSource(false)
    const load = latest.current.getArtifact
    if (!load) { setError('Saved creations are unavailable. Reopen Swarm and try again.'); return }
    void load(task.id, executionId, controller.signal).then(result => { if (!controller.signal.aborted) { setSaved(result); setDraft(result.artifact.payload) } }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)) })
    return () => controller.abort()
  }, [task.id, executionId, retry])
  const close = () => { if (dirty || saving) setDiscard(true); else onClose() }
  const change = (payload: Record<string, unknown>) => { editVersion.current++; setDraft(payload); setSavedNote('') }
  const save = async () => {
    if (!saved || !draft || !dirty || savePending.current || !latest.current.updateArtifact) return
    const captured = draft, version = editVersion.current
    savePending.current = true; setSaving(true); setError(''); setSavedNote('')
    try {
      const revision = await latest.current.updateArtifact(task.id, executionId, saved.revision, captured)
      if (!mounted.current) return
      setSaved({ artifact: { ...saved.artifact, payload: captured }, revision })
      setSavedNote(version === editVersion.current ? 'Changes saved to this task.' : 'Earlier changes saved. Your newer edits still need saving.')
    } catch (error) { if (mounted.current) setError(errorText(error)) }
    finally { savePending.current = false; if (mounted.current) setSaving(false) }
  }
  const newer = !!saved && task.artifact!.revision > saved.revision
  return <dialog ref={dialog} className="swarm-studio-preview" aria-labelledby="swarm-studio-title" onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation() } }}>
    <header><div><small>Studio · {task.artifact!.studioKind}</small><h2 id="swarm-studio-title" title={task.title}>{task.title}</h2></div><button ref={closeButton} type="button" aria-label="Close creation" onClick={close}><X size={18}/></button></header>
    <div className="swarm-studio-toolbar">
      <span role="status">{saving ? 'Saving changes…' : dirty ? 'Unsaved changes' : savedNote || 'Saved with this task'}</span>
      {saved && typeof draft?.html === 'string' && <button type="button" aria-pressed={editSource} onClick={() => setEditSource(value => !value)}>{editSource ? 'Show preview' : 'Edit HTML'}</button>}
      {dirty && swarm.updateArtifact && <button type="button" disabled={saving || newer} onClick={() => void save()}>Save changes</button>}
      {newer && <span role="status">A newer version was saved. Your local edits are kept until you reload.</span>}
      {newer && <button type="button" onClick={() => dirty ? setDiscard(true) : setRetry(value => value + 1)}>Reload saved version</button>}
    </div>
    {discard && <div className="swarm-studio-confirm" role="alert"><p>{saving ? 'A save is still being confirmed. Keep this window open until it finishes.' : 'Keep editing, or discard your unsaved changes.'}</p><button type="button" onClick={() => setDiscard(false)}>Keep editing</button>{!saving && <><button type="button" onClick={onClose}>Discard and close</button>{newer && <button type="button" onClick={() => { setDiscard(false); setRetry(value => value + 1) }}>Discard and reload</button>}</>}</div>}
    <div className="swarm-studio-body">
      {error && <p className="swarm-studio-error" role="alert">{error} {!saved && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>}</p>}
      {!saved && !error && <p role="status">Loading saved creation…</p>}
      {saved && draft && <ScopedArtifactContext.Provider value={true}><CardErrorBoundary label="This Studio creation" resetKey={`${task.id}:${executionId}:${retry}`}><Suspense fallback={<p role="status">Opening Studio preview…</p>}>
        {editSource && typeof draft.html === 'string' ? <label className="swarm-studio-source">HTML source<textarea value={draft.html} onChange={event => change({ ...draft, html: event.target.value, ...(saved.artifact.studioKind === 'website' ? { quality: { runtime: { status: 'partial', widths: [], checks: [], limitations: ['Edited HTML has not been runtime-tested.'] } } } : {}) })} spellCheck={false}/></label>
          : <SwarmStudioCard task={task} artifact={{ ...saved.artifact, payload: draft }} swarm={swarm} onChange={change}/>}
      </Suspense></CardErrorBoundary></ScopedArtifactContext.Provider>}
    </div>
  </dialog>
}
