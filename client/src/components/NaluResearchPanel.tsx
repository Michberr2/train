import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BookOpen, X, Loader2, AlertCircle, RefreshCw, ExternalLink, FileText } from 'lucide-react'
import {
  listResearch, researchReportUrl,
  type NaluResearchEntry, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

function fmtDate(ts: number): string {
  if (!ts) return ''
  try { return new Date(ts * 1000).toLocaleDateString() } catch { return '' }
}

export default function NaluResearchPanel({ pairing, open, onClose }: Props) {
  const [items, setItems] = useState<NaluResearchEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setItems(await listResearch(pairing)) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [pairing])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close research" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <BookOpen size={16} />
                <h2 className="text-sm font-semibold">Deep Research</h2>
                {items && <span className="text-xs text-foreground/50">({items.length})</span>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={refresh} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Refresh" title="Refresh"><RefreshCw size={14} /></button>
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close"><X size={16} /></button>
              </div>
            </div>

            <div className="border-b border-white/5 px-4 py-2 text-[11px] text-foreground/50">
              To start a new deep-research run, ask Nalu in chat:
              <span className="ml-1 italic text-foreground/70">&ldquo;do deep research on X&rdquo;</span>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !items && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && items && items.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No research reports yet.
                </div>
              )}
              {items && items.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {items.map((r) => (
                    <li key={r.id} className="px-4 py-3">
                      <a
                        href={researchReportUrl(pairing, r.id)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-start gap-3 hover:opacity-90"
                      >
                        <FileText size={14} className="mt-0.5 flex-shrink-0 text-foreground/50" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-foreground text-sm break-words">{r.query || '(no query)'}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-foreground/50">
                            {r.category && <span>{r.category}</span>}
                            <span>· {r.sourceCount} source{r.sourceCount === 1 ? '' : 's'}</span>
                            {r.duration && <span>· {r.duration}</span>}
                            {r.completedAt > 0 && <span>· {fmtDate(r.completedAt)}</span>}
                            <span className="ml-auto inline-flex items-center gap-1 text-foreground/40 hover:text-foreground">
                              open <ExternalLink size={11} />
                            </span>
                          </div>
                        </div>
                      </a>
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
