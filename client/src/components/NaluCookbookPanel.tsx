import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChefHat, X, Loader2, AlertCircle, RefreshCw, Cpu, HardDrive, Zap, Star, CheckCircle2, Database,
} from 'lucide-react'
import {
  getHardware, getRecommendedModels, getCachedModels,
  type NaluHardware, type NaluRecommendedModel, type NaluCachedModel, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

function fmtBytes(n?: number): string {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

export default function NaluCookbookPanel({ pairing, open, onClose }: Props) {
  const [hw, setHw] = useState<NaluHardware | null>(null)
  const [recs, setRecs] = useState<NaluRecommendedModel[] | null>(null)
  const [cached, setCached] = useState<NaluCachedModel[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // Fire in parallel — hwfit/system is the slowest (GPU probe), don't make
      // the others wait on it.
      const [h, r, c] = await Promise.all([
        getHardware(pairing).catch((e) => { throw e }),
        getRecommendedModels(pairing, { limit: 12 }).catch(() => null),
        getCachedModels(pairing).catch(() => null),
      ])
      setHw(h)
      setRecs(r)
      setCached(c)
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [pairing])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close cookbook" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">

            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <ChefHat size={16} />
                <h2 className="text-sm font-semibold">Cookbook</h2>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={refresh} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Refresh"><RefreshCw size={14} /></button>
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close"><X size={16} /></button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !hw && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Scanning hardware…
                </div>
              )}

              {/* Hardware section */}
              {hw && (
                <section className="border-b border-white/5 p-4 space-y-2">
                  <h3 className="text-xs uppercase tracking-wide text-foreground/50">Hardware</h3>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-lg border border-white/10 bg-black/20 p-2">
                      <div className="flex items-center gap-1 text-foreground/60"><Cpu size={11} /> CPU</div>
                      <div className="mt-1 text-foreground truncate">{hw.cpu || 'unknown'}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-black/20 p-2">
                      <div className="flex items-center gap-1 text-foreground/60"><HardDrive size={11} /> RAM</div>
                      <div className="mt-1 text-foreground">
                        {hw.availableRamGb?.toFixed(1) ?? '?'} / {hw.totalRamGb?.toFixed(1) ?? '?'} GB
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-black/20 p-2">
                      <div className="flex items-center gap-1 text-foreground/60"><Zap size={11} /> GPU</div>
                      <div className="mt-1 text-foreground truncate">
                        {hw.hasGpu ? `${hw.gpuName ?? 'GPU'}${hw.gpuCount && hw.gpuCount > 1 ? ` ×${hw.gpuCount}` : ''}` : 'none'}
                      </div>
                      {hw.hasGpu && hw.gpuVramGb !== undefined && (
                        <div className="mt-0.5 text-[10px] text-foreground/50">{hw.gpuVramGb} GB VRAM</div>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* Recommended models */}
              <section className="border-b border-white/5 p-4">
                <h3 className="text-xs uppercase tracking-wide text-foreground/50 mb-2">Recommended for your hardware</h3>
                {!recs && loading && (
                  <div className="text-xs text-foreground/50">Loading…</div>
                )}
                {recs && recs.length === 0 && (
                  <div className="text-xs text-foreground/50">No recommendations.</div>
                )}
                {recs && recs.length > 0 && (
                  <ul className="space-y-1.5">
                    {recs.slice(0, 8).map((m, i) => (
                      <li key={`${m.name}-${i}`}
                          className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-xs">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1 truncate">
                              {m.fits && <CheckCircle2 size={11} className="text-emerald-400 flex-shrink-0" />}
                              <span className="font-medium text-foreground truncate">{m.name}</span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-foreground/50">
                              {m.size && <span>{m.size}</span>}
                              {m.quant && <span>· {m.quant}</span>}
                              {m.contextLength && <span>· {m.contextLength.toLocaleString()} ctx</span>}
                              {m.vramRequiredGb !== undefined && <span>· {m.vramRequiredGb} GB VRAM</span>}
                            </div>
                          </div>
                          {m.score !== undefined && (
                            <div className="flex items-center gap-0.5 text-[11px] text-amber-400 flex-shrink-0">
                              <Star size={10} /> {Math.round(m.score)}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Cached models */}
              <section className="border-b border-white/5 p-4">
                <h3 className="text-xs uppercase tracking-wide text-foreground/50 mb-2 flex items-center gap-1">
                  <Database size={11} /> Downloaded ({cached?.length ?? 0})
                </h3>
                {!cached && loading && (
                  <div className="text-xs text-foreground/50">Loading…</div>
                )}
                {cached && cached.length === 0 && (
                  <div className="text-xs text-foreground/50">No models cached yet.</div>
                )}
                {cached && cached.length > 0 && (
                  <ul className="space-y-1">
                    {cached.map((m, i) => (
                      <li key={`${m.path}-${i}`} className="flex items-center gap-2 text-xs px-2 py-1 hover:bg-white/5 rounded">
                        <span className="font-mono text-[11px] truncate flex-1 text-foreground/80" title={m.path}>
                          {m.name || m.path.split('/').pop() || m.path}
                        </span>
                        {m.sizeBytes && <span className="text-[10px] text-foreground/40">{fmtBytes(m.sizeBytes)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Action hint */}
              <section className="p-4">
                <div className="rounded-lg border border-white/10 bg-accent/5 px-3 py-2.5 text-xs text-foreground/80">
                  <strong>To download or serve a model:</strong> ask Nalu in chat &mdash;
                  <span className="italic"> &ldquo;download Qwen 2.5 7B&rdquo;</span> or
                  <span className="italic"> &ldquo;serve llama 3.2&rdquo;</span>. The agent
                  uses Cookbook tools to do it and reports progress in the chat.
                </div>
              </section>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
