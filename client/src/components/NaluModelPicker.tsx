import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, ChevronDown, Loader2, AlertCircle, Check, Plus } from 'lucide-react'
import {
  addEndpoint,
  getModels,
  getSelectedModel,
  setSelectedModel,
  type NaluModel,
  type NaluPairing,
  type SelectedModel,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing | null
  onChange?: (selected: SelectedModel | null) => void
}

export default function NaluModelPicker({ pairing, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<NaluModel[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SelectedModel | null>(() => getSelectedModel())
  const [addOpen, setAddOpen] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [epName, setEpName] = useState('')
  const [epUrl, setEpUrl] = useState('http://localhost:11434/v1')
  const [epKey, setEpKey] = useState('')

  async function refresh() {
    if (!pairing) return
    setLoading(true)
    setError(null)
    try {
      const m = await getModels(pairing)
      setModels(m)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handleAddEndpoint() {
    if (!pairing) return
    if (!epUrl.trim()) {
      setAddError('Base URL is required')
      return
    }
    setAddBusy(true)
    setAddError(null)
    try {
      await addEndpoint(pairing, {
        baseUrl: epUrl.trim(),
        name: epName.trim() || undefined,
        apiKey: epKey.trim() || undefined,
      })
      setAddOpen(false)
      setEpName('')
      setEpKey('')
      await refresh()
    } catch (e) {
      setAddError((e as Error).message)
    } finally {
      setAddBusy(false)
    }
  }

  // Refresh model list when the picker opens or pairing changes.
  useEffect(() => {
    if (!open || !pairing) return
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pairing])

  function choose(m: NaluModel) {
    const next: SelectedModel = { endpointId: m.endpointId, model: m.model }
    setSelectedModel(next)
    setSelected(next)
    setOpen(false)
    onChange?.(next)
  }

  if (!pairing) return null

  const buttonLabel = selected?.model || 'Pick a model'

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-card/80 px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-card/95 hover:text-foreground"
        title="Pick the Nalu model used for this chat"
      >
        <Cpu size={13} />
        <span className="max-w-[180px] truncate">{buttonLabel}</span>
        <ChevronDown size={12} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <button
              aria-label="Close model picker"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-30 cursor-default"
            />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.12 }}
              className="absolute right-0 z-40 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-white/10 bg-card/95 backdrop-blur-xl p-1 shadow-2xl"
            >
              {loading && (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-foreground/60">
                  <Loader2 size={13} className="animate-spin" /> Loading models…
                </div>
              )}
              {error && (
                <div className="flex items-start gap-2 px-3 py-3 text-xs text-red-300">
                  <AlertCircle size={13} className="mt-0.5" /> {error}
                </div>
              )}
              {!loading && !error && models && models.length === 0 && !addOpen && (
                <div className="px-3 py-3 text-xs text-foreground/60">
                  No models found yet. Add an endpoint below to get started.
                </div>
              )}
              {!addOpen && (
                <div className="border-t border-white/5 mt-1 pt-1">
                  <button
                    onClick={() => setAddOpen(true)}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-foreground/80 hover:bg-white/5"
                  >
                    <Plus size={13} />
                    Add endpoint…
                  </button>
                </div>
              )}
              {addOpen && (
                <div className="border-t border-white/5 p-3 text-xs">
                  <div className="mb-2 text-foreground/80 font-medium">New endpoint</div>
                  <input
                    value={epName}
                    onChange={(e) => setEpName(e.target.value)}
                    placeholder="Name (optional)"
                    className="mb-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-foreground placeholder:text-foreground/40 focus:border-accent focus:outline-none"
                  />
                  <input
                    value={epUrl}
                    onChange={(e) => setEpUrl(e.target.value)}
                    placeholder="Base URL (e.g. http://localhost:11434/v1)"
                    className="mb-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-foreground placeholder:text-foreground/40 focus:border-accent focus:outline-none"
                  />
                  <input
                    type="password"
                    value={epKey}
                    onChange={(e) => setEpKey(e.target.value)}
                    placeholder="API key (optional)"
                    className="mb-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-foreground placeholder:text-foreground/40 focus:border-accent focus:outline-none"
                  />
                  {addError && (
                    <div className="mt-1 flex items-start gap-1 text-[11px] text-red-300">
                      <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
                      {addError}
                    </div>
                  )}
                  <div className="mt-2 flex justify-end gap-1">
                    <button
                      onClick={() => {
                        setAddOpen(false)
                        setAddError(null)
                      }}
                      className="rounded px-2 py-1 text-foreground/60 hover:bg-white/5 hover:text-foreground"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddEndpoint}
                      disabled={addBusy}
                      className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-background hover:opacity-90 disabled:opacity-50"
                    >
                      {addBusy && <Loader2 size={11} className="animate-spin" />}
                      Save
                    </button>
                  </div>
                </div>
              )}
              {!loading && !error && models && models.length > 0 && (
                <ul className="text-sm">
                  {models.map((m) => {
                    const isSelected =
                      selected?.endpointId === m.endpointId && selected?.model === m.model
                    return (
                      <li key={`${m.endpointId}:${m.model}`}>
                        <button
                          onClick={() => choose(m)}
                          className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-white/5"
                        >
                          <Check
                            size={13}
                            className={
                              isSelected
                                ? 'mt-0.5 flex-shrink-0 text-emerald-400'
                                : 'mt-0.5 flex-shrink-0 text-transparent'
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-foreground">
                              {m.model}
                            </span>
                            <span className="block truncate text-[11px] text-foreground/50">
                              {m.endpointName}
                              {m.supportsTools ? ' · tools' : ''}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
