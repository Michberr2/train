import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Puzzle,
  X,
  RefreshCw,
  Loader2,
  AlertCircle,
  Trash2,
  ExternalLink,
  CircleDot,
} from 'lucide-react'
import {
  listMcpServers,
  setMcpServerEnabled,
  reconnectMcpServer,
  deleteMcpServer,
  type NaluMcpServer,
  type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

function statusColor(s: string): string {
  if (s === 'connected') return 'text-emerald-400'
  if (s === 'connecting') return 'text-amber-400'
  if (s === 'error') return 'text-red-400'
  return 'text-foreground/40'
}

export default function NaluMcpPanel({ pairing, open, onClose }: Props) {
  const [servers, setServers] = useState<NaluMcpServer[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setServers(await listMcpServers(pairing))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [pairing])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  async function handleToggle(s: NaluMcpServer) {
    setBusyId(s.id)
    setError(null)
    try {
      await setMcpServerEnabled(pairing, s.id, !s.isEnabled)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleReconnect(s: NaluMcpServer) {
    setBusyId(s.id)
    setError(null)
    try {
      await reconnectMcpServer(pairing, s.id)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(s: NaluMcpServer) {
    if (!confirm(`Remove MCP server "${s.name}"? Its tools won't be available to the agent.`)) return
    setBusyId(s.id)
    setError(null)
    try {
      await deleteMcpServer(pairing, s.id)
      setServers((cur) => (cur ? cur.filter((x) => x.id !== s.id) : cur))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            aria-label="Close MCP panel"
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
                <Puzzle size={16} />
                <h2 className="text-sm font-semibold">MCP servers</h2>
                {servers && (
                  <span className="text-xs text-foreground/50">({servers.length})</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={refresh}
                  className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground"
                  title="Refresh"
                  aria-label="Refresh"
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

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !servers && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && servers && servers.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No MCP servers configured. Add one in your local Nalu under{' '}
                  <strong>Settings → MCP servers</strong>.
                </div>
              )}
              {servers && servers.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {servers.map((s) => (
                    <li key={s.id} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <CircleDot
                          size={12}
                          className={`${statusColor(s.status)} mt-1 flex-shrink-0`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground truncate">
                              {s.name}
                            </span>
                            <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground/60">
                              {s.transport}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-foreground/50">
                            {s.status}
                            {s.toolCount > 0 && (
                              <>
                                {' · '}
                                {s.enabledToolCount}/{s.toolCount} tools
                              </>
                            )}
                          </div>
                          {s.error && (
                            <div className="mt-1 text-[11px] text-red-300">{s.error}</div>
                          )}
                          {s.needsOauth && s.authUrl && (
                            <a
                              href={s.authUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-300 hover:underline"
                            >
                              <ExternalLink size={11} /> Authorize
                            </a>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <button
                            onClick={() => handleToggle(s)}
                            disabled={busyId === s.id}
                            className={`rounded px-2 py-1 text-[11px] font-medium ${s.isEnabled ? 'bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20' : 'bg-white/5 text-foreground/60 hover:bg-white/10'} disabled:opacity-50`}
                            title={s.isEnabled ? 'Disable' : 'Enable'}
                          >
                            {s.isEnabled ? 'On' : 'Off'}
                          </button>
                          <button
                            onClick={() => handleReconnect(s)}
                            disabled={busyId === s.id}
                            className="rounded p-1.5 text-foreground/50 hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                            title="Reconnect"
                            aria-label="Reconnect"
                          >
                            {busyId === s.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <RefreshCw size={12} />
                            )}
                          </button>
                          <button
                            onClick={() => handleDelete(s)}
                            disabled={busyId === s.id}
                            className="rounded p-1.5 text-foreground/40 hover:text-red-400 disabled:opacity-50"
                            title="Remove"
                            aria-label="Remove"
                          >
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
