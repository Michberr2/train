import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Calendar, X, Loader2, AlertCircle, RefreshCw, MapPin } from 'lucide-react'
import {
  listCalendarEvents,
  type NaluCalendarEvent, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

function fmt(d: string): string {
  if (!d) return ''
  try { return new Date(d).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return d }
}
function fmtDateKey(d: string): string {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) } catch { return d }
}

export default function NaluCalendarPanel({ pairing, open, onClose }: Props) {
  const [events, setEvents] = useState<NaluCalendarEvent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const range = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 30)
    return { start, end }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      setEvents(await listCalendarEvents(pairing, range))
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [pairing, range])

  useEffect(() => { if (open) refresh() }, [open, refresh])

  // Bucket events by local date key.
  const grouped = useMemo(() => {
    if (!events) return null
    const buckets: Map<string, NaluCalendarEvent[]> = new Map()
    for (const e of events) {
      const key = fmtDateKey(e.start)
      const arr = buckets.get(key) ?? []
      arr.push(e)
      buckets.set(key, arr)
    }
    return Array.from(buckets.entries())
  }, [events])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close calendar" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                <Calendar size={16} />
                <h2 className="text-sm font-semibold">Upcoming (30 days)</h2>
                {events && <span className="text-xs text-foreground/50">({events.length})</span>}
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
              {loading && !events && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && events && events.length === 0 && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No events in the next 30 days. Set up CalDAV in your local Nalu under{' '}
                  <strong>Settings → Calendar</strong>.
                </div>
              )}
              {grouped && grouped.length > 0 && (
                <div className="divide-y divide-white/5">
                  {grouped.map(([dateKey, list]) => (
                    <div key={dateKey} className="px-4 py-3">
                      <div className="text-[11px] uppercase tracking-wide text-foreground/50 mb-2">{dateKey}</div>
                      <ul className="space-y-2">
                        {list.map((e) => (
                          <li key={e.uid} className="rounded-lg border border-white/5 bg-black/20 px-3 py-2">
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-medium text-foreground">{e.summary}</p>
                              {e.calendarName && (
                                <span className="text-[10px] uppercase tracking-wide text-foreground/40 flex-shrink-0">{e.calendarName}</span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[11px] text-foreground/60">
                              {e.allDay ? 'All day' : `${fmt(e.start).split(', ').slice(-1)[0]}${e.end ? ` – ${fmt(e.end).split(', ').slice(-1)[0]}` : ''}`}
                            </div>
                            {e.location && (
                              <div className="mt-1 flex items-center gap-1 text-[11px] text-foreground/50">
                                <MapPin size={10} /> {e.location}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
