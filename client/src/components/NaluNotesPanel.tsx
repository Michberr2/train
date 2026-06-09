import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { StickyNote, X, Plus, Trash2, Loader2, AlertCircle, RefreshCw, Pin } from 'lucide-react'
import {
  listNotes, createNote, deleteNote,
  type NaluNote, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

export default function NaluNotesPanel({ pairing, open, onClose }: Props) {
  const [notes, setNotes] = useState<NaluNote[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try { setNotes(await listNotes(pairing)) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [pairing])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  async function handleAdd() {
    if (!title.trim() && !content.trim()) return
    setAdding(true); setError(null)
    try {
      await createNote(pairing, { title: title.trim() || 'Untitled', content: content.trim() })
      setTitle(''); setContent('')
      await refresh()
    } catch (e) { setError((e as Error).message) }
    finally { setAdding(false) }
  }

  async function handleDelete(id: string) {
    try {
      await deleteNote(pairing, id)
      setNotes((cur) => (cur ? cur.filter((n) => n.id !== id) : cur))
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close notes" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <StickyNote size={16} />
                <h2 className="text-sm font-semibold">Notes</h2>
                {notes && <span className="text-xs text-foreground/50">({notes.length})</span>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={refresh} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Refresh" title="Refresh"><RefreshCw size={14} /></button>
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close"><X size={16} /></button>
              </div>
            </div>

            <div className="border-b border-white/5 p-3 space-y-2">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title"
                className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:border-accent focus:outline-none" />
              <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Note body…" rows={2}
                className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:border-accent focus:outline-none" />
              <div className="flex justify-end">
                <button onClick={handleAdd} disabled={adding || (!title.trim() && !content.trim())}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50">
                  {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  Add note
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !notes && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && notes && notes.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No notes yet. Add one above, or ask Nalu to "make a note that…" in chat.
                </div>
              )}
              {notes && notes.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {notes.map((n) => (
                    <li key={n.id} className="group flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 flex-shrink-0">
                        {n.pinned ? <Pin size={13} className="text-amber-400" /> : <span className="block h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        {n.title && <p className="font-medium text-foreground text-sm truncate">{n.title}</p>}
                        {n.content && <p className="mt-0.5 text-sm text-foreground/80 whitespace-pre-wrap break-words">{n.content}</p>}
                        {n.updatedAt && (
                          <p className="mt-1 text-[11px] text-foreground/40">{n.updatedAt.slice(0, 10)}{n.label ? ` · ${n.label}` : ''}</p>
                        )}
                      </div>
                      <button onClick={() => handleDelete(n.id)} className="opacity-0 transition-opacity group-hover:opacity-100 text-foreground/40 hover:text-red-400" aria-label="Delete note" title="Delete">
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
