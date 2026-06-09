import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings, X, Loader2, AlertCircle, Save } from 'lucide-react'
import { getSettings, setSettings, getModels, type NaluPairing, type NaluModel } from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

// Curated, web-relevant subset of Odysseus settings. The full set is huge;
// surfacing everything here would be noise. Keep this small and intentional.
type FieldType = 'boolean' | 'string' | 'integer'
const FIELDS: Array<{ key: string; label: string; type: FieldType; help?: string }> = [
  { key: 'vision_enabled', label: 'Vision enabled', type: 'boolean',
    help: 'Allow image attachments to flow to vision-capable models.' },
  { key: 'vision_model', label: 'Vision model', type: 'string',
    help: 'Optional dedicated VLM for describing images when the chat model is text-only.' },
  { key: 'agent_max_rounds', label: 'Agent max rounds', type: 'integer',
    help: '1–200. Hard ceiling on tool-calling rounds per turn.' },
  { key: 'agent_max_tool_calls', label: 'Agent max tool calls', type: 'integer',
    help: '0 = unlimited. Budget across all rounds in a turn.' },
]

export default function NaluSettingsPanel({ pairing, open, onClose }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [models, setModels] = useState<NaluModel[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch in parallel; models is best-effort (don't fail the whole load).
      const [s, m] = await Promise.all([
        getSettings(pairing),
        getModels(pairing).catch(() => [] as NaluModel[]),
      ])
      setValues(s)
      setModels(m)
      setDirty(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [pairing])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  function update(key: string, val: unknown) {
    setValues((cur) => ({ ...cur, [key]: val }))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const patch: Record<string, unknown> = {}
      for (const f of FIELDS) patch[f.key] = values[f.key]
      await setSettings(pairing, patch)
      setDirty(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            aria-label="Close settings"
            onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm"
          />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <Settings size={16} />
                <h2 className="text-sm font-semibold">Nalu settings</h2>
              </div>
              <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close">
                <X size={16} />
              </button>
            </div>

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
              {loading && !Object.keys(values).length && (
                <div className="flex items-center gap-2 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="block text-xs font-medium uppercase tracking-wide text-foreground/60">
                    {f.label}
                  </label>
                  {f.type === 'boolean' ? (
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!values[f.key]}
                        onChange={(e) => update(f.key, e.target.checked)}
                        className="h-4 w-4 accent-accent"
                      />
                      <span className="text-foreground/80">{!!values[f.key] ? 'On' : 'Off'}</span>
                    </div>
                  ) : f.type === 'integer' ? (
                    <input
                      type="number"
                      value={Number(values[f.key] ?? 0)}
                      onChange={(e) => update(f.key, parseInt(e.target.value, 10) || 0)}
                      className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-foreground focus:border-accent focus:outline-none"
                    />
                  ) : f.key === 'vision_model' && models.length > 0 ? (
                    // Pick from real models discovered on the local Nalu — far
                    // safer than free-text typing, which would silently fail
                    // VL routing for typo'd or non-existent model names.
                    <select
                      value={String(values[f.key] ?? '')}
                      onChange={(e) => update(f.key, e.target.value)}
                      className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-foreground focus:border-accent focus:outline-none"
                    >
                      <option value="">(auto — main chat model handles vision)</option>
                      {models.map((m) => (
                        <option key={`${m.endpointId}:${m.model}`} value={m.model}>
                          {m.model} — {m.endpointName}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={String(values[f.key] ?? '')}
                      onChange={(e) => update(f.key, e.target.value)}
                      className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-foreground focus:border-accent focus:outline-none"
                    />
                  )}
                  {f.help && (
                    <p className="mt-1 text-[11px] text-foreground/50">{f.help}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-white/5 p-3 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-foreground/60 hover:bg-white/5 hover:text-foreground">Close</button>
              <button
                onClick={handleSave}
                disabled={!dirty || saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </button>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
