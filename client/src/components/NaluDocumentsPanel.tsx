import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FileText, X, Loader2, AlertCircle, RefreshCw, ArrowLeft, Save, Trash2, CheckCircle2 } from 'lucide-react'
import {
  listDocuments, getDocument, updateDocument, deleteDocument,
  type NaluDocument, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

interface DocItem { id: string; title: string; language?: string | null; updatedAt?: string | null }

export default function NaluDocumentsPanel({ pairing, open, onClose }: Props) {
  const [docs, setDocs] = useState<DocItem[] | null>(null)
  const [active, setActive] = useState<NaluDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setDocs(await listDocuments(pairing)) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [pairing])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  // Autosave 1.5s after the last keystroke. The PUT route coalesces successive
  // user-source updates within a short window into one version, so this is safe.
  useEffect(() => {
    if (!active || !dirty) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      setSaving(true)
      try {
        const updated = await updateDocument(pairing, active.id, draft)
        setActive(updated)
        setDirty(false)
        setSavedAt(Date.now())
      } catch (e) { setError((e as Error).message) }
      finally { setSaving(false) }
    }, 1500)
    return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current) }
  }, [draft, dirty, active, pairing])

  async function handleOpen(id: string) {
    setLoading(true); setError(null)
    try {
      const d = await getDocument(pairing, id)
      setActive(d); setDraft(d.content); setDirty(false); setSavedAt(null)
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }

  async function handleSaveNow() {
    if (!active || !dirty) return
    setSaving(true)
    try {
      const updated = await updateDocument(pairing, active.id, draft)
      setActive(updated); setDirty(false); setSavedAt(Date.now())
    } catch (e) { setError((e as Error).message) }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this document? Versions are kept but the doc is removed from the library.')) return
    try {
      await deleteDocument(pairing, id)
      setDocs((cur) => (cur ? cur.filter((d) => d.id !== id) : cur))
      if (active?.id === id) setActive(null)
    } catch (e) { setError((e as Error).message) }
  }

  function closeActive() {
    if (dirty && !confirm('You have unsaved changes. Close anyway?')) return
    setActive(null); setDraft(''); setDirty(false)
  }

  const savedAgo = savedAt ? Math.max(0, Math.floor((Date.now() - savedAt) / 1000)) : null

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close documents" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">

            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground min-w-0">
                {active ? (
                  <button onClick={closeActive} className="rounded p-1 hover:bg-white/5 flex-shrink-0"><ArrowLeft size={14} /></button>
                ) : (
                  <FileText size={16} className="flex-shrink-0" />
                )}
                <h2 className="text-sm font-semibold truncate">
                  {active ? (active.title || 'Untitled') : 'Documents'}
                </h2>
                {!active && docs && <span className="text-xs text-foreground/50 flex-shrink-0">({docs.length})</span>}
                {active && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-foreground/50 flex-shrink-0">
                    {saving ? (<><Loader2 size={11} className="animate-spin" /> saving…</>)
                      : dirty ? <span className="text-amber-400">● unsaved</span>
                      : savedAgo !== null ? <><CheckCircle2 size={11} className="text-emerald-400" /> saved{savedAgo > 1 ? ` ${savedAgo}s ago` : ''}</>
                      : null}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {active && (
                  <button onClick={handleSaveNow} disabled={!dirty || saving}
                    className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground disabled:opacity-30" aria-label="Save now" title="Save now (Cmd+S)">
                    <Save size={14} />
                  </button>
                )}
                {!active && (
                  <button onClick={refresh} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Refresh"><RefreshCw size={14} /></button>
                )}
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close"><X size={16} /></button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-hidden flex flex-col">
              {!active && loading && !docs && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!active && !loading && docs && docs.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No documents yet. Ask Nalu in chat to <span className="italic">&ldquo;create a doc&hellip;&rdquo;</span> or
                  use Notes for quick text.
                </div>
              )}
              {!active && docs && docs.length > 0 && (
                <ul className="flex-1 overflow-y-auto divide-y divide-white/5">
                  {docs.map((d) => (
                    <li key={d.id} className="group flex items-start gap-2 px-4 py-3 hover:bg-white/5 cursor-pointer"
                        onClick={() => handleOpen(d.id)}>
                      <FileText size={13} className="mt-0.5 text-foreground/50 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-foreground text-sm truncate">{d.title || '(untitled)'}</p>
                        <p className="mt-0.5 text-[11px] text-foreground/40">
                          {d.language || 'text'}
                          {d.updatedAt && ` · ${d.updatedAt.slice(0, 10)}`}
                        </p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(d.id) }}
                        className="opacity-0 transition-opacity group-hover:opacity-100 text-foreground/40 hover:text-red-400 flex-shrink-0"
                        aria-label="Delete document" title="Delete">
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Editor view */}
              {active && (
                <textarea
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                      e.preventDefault(); handleSaveNow()
                    }
                  }}
                  spellCheck={false}
                  className="flex-1 w-full resize-none bg-black/20 border-0 px-5 py-4 font-mono text-sm text-foreground placeholder:text-foreground/40 focus:outline-none"
                  placeholder="(empty document)"
                />
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
