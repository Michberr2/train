import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Brain,
  X,
  Plus,
  Trash2,
  Loader2,
  AlertCircle,
  RefreshCw,
  Pin,
} from 'lucide-react'
import {
  addMemory,
  deleteMemory,
  getMemory,
  type NaluMemoryEntry,
  type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

export default function NaluMemoryPanel({ pairing, open, onClose }: Props) {
  const [entries, setEntries] = useState<NaluMemoryEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await getMemory(pairing)
      setEntries(list)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [pairing])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  async function handleAdd() {
    const text = draft.trim()
    if (!text) return
    setAdding(true)
    setError(null)
    try {
      await addMemory(pairing, text)
      setDraft('')
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMemory(pairing, id)
      setEntries((cur) => (cur ? cur.filter((m) => m.id !== id) : cur))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            aria-label="Close memory panel"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <Brain size={16} />
                <h2 className="text-sm font-semibold">Memory</h2>
                {entries && (
                  <span className="text-xs text-foreground/50">({entries.length})</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={refresh}
                  className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground"
                  title="Refresh"
                  aria-label="Refresh memory"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={onClose}
                  className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="border-b border-white/5 p-3">
              <div className="flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleAdd()
                    }
                  }}
                  placeholder="Teach Nalu something to remember…"
                  className="flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-accent focus:outline-none"
                />
                <button
                  onClick={handleAdd}
                  disabled={adding || !draft.trim()}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Add
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !entries && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && entries && entries.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No memories yet. Add one above, or just say
                  &ldquo;remember this&rdquo; in chat and Nalu will save it.
                </div>
              )}
              {entries && entries.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {entries.map((m) => (
                    <li key={m.id} className="group flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 flex-shrink-0">
                        {m.pinned ? (
                          <Pin size={13} className="text-amber-400" />
                        ) : (
                          <span className="block h-3 w-3" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
                          {m.text}
                        </p>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-foreground/40">
                          {m.category && <span>{m.category}</span>}
                          {m.source && <span>· {m.source}</span>}
                          {m.timestamp && (
                            <span className="truncate">· {m.timestamp.slice(0, 10)}</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDelete(m.id)}
                        className="opacity-0 transition-opacity group-hover:opacity-100 text-foreground/40 hover:text-red-400"
                        aria-label="Delete memory"
                        title="Delete"
                      >
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
