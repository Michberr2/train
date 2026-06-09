import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckSquare, X, Loader2, AlertCircle, RefreshCw, Trash2, Pause, CircleDot } from 'lucide-react'
import {
  listTasks, pauseTask, deleteTask,
  type NaluTask, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

function statusColor(s: string) {
  if (s === 'active' || s === 'running') return 'text-emerald-400'
  if (s === 'paused') return 'text-amber-400'
  if (s === 'error' || s === 'failed') return 'text-red-400'
  return 'text-foreground/40'
}

export default function NaluTasksPanel({ pairing, open, onClose }: Props) {
  const [tasks, setTasks] = useState<NaluTask[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setTasks(await listTasks(pairing)) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [pairing])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  async function handlePause(t: NaluTask) {
    setBusyId(t.id); setError(null)
    try { await pauseTask(pairing, t.id); await refresh() }
    catch (e) { setError((e as Error).message) }
    finally { setBusyId(null) }
  }

  async function handleDelete(t: NaluTask) {
    if (!confirm(`Delete task "${t.name}"?`)) return
    setBusyId(t.id); setError(null)
    try {
      await deleteTask(pairing, t.id)
      setTasks((cur) => (cur ? cur.filter((x) => x.id !== t.id) : cur))
    } catch (e) { setError((e as Error).message) }
    finally { setBusyId(null) }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close tasks" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <CheckSquare size={16} />
                <h2 className="text-sm font-semibold">Scheduled tasks</h2>
                {tasks && <span className="text-xs text-foreground/50">({tasks.length})</span>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={refresh} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Refresh" title="Refresh"><RefreshCw size={14} /></button>
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close"><X size={16} /></button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !tasks && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && tasks && tasks.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No scheduled tasks yet. Ask Nalu to "remind me…" or "every weekday at 9am, summarize my inbox" in chat to create one.
                </div>
              )}
              {tasks && tasks.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {tasks.map((t) => (
                    <li key={t.id} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <CircleDot size={12} className={`${statusColor(t.status)} mt-1 flex-shrink-0`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground truncate">{t.name}</span>
                            <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground/60">{t.taskType}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-foreground/50">
                            {t.status}
                            {t.schedule && ` · ${t.schedule}`}
                            {t.nextRun && ` · next ${t.nextRun.slice(0, 16).replace('T', ' ')}`}
                          </div>
                          {t.prompt && (
                            <p className="mt-1 text-[11px] text-foreground/60 line-clamp-2">{t.prompt}</p>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <button onClick={() => handlePause(t)} disabled={busyId === t.id}
                            className="rounded p-1.5 text-foreground/40 hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                            title="Pause" aria-label="Pause">
                            {busyId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                          </button>
                          <button onClick={() => handleDelete(t)} disabled={busyId === t.id}
                            className="rounded p-1.5 text-foreground/40 hover:text-red-400 disabled:opacity-50"
                            title="Delete" aria-label="Delete">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
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
