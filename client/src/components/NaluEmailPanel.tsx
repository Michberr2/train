import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Mail, X, Loader2, AlertCircle, RefreshCw, ArrowLeft, Mailbox, CircleDot,
} from 'lucide-react'
import {
  listEmailAccounts, listEmails, readEmail,
  type NaluEmailAccount, type NaluEmailListItem, type NaluEmailFull, type NaluPairing,
} from '../lib/nalu-client'

interface Props {
  pairing: NaluPairing
  open: boolean
  onClose: () => void
}

function fmtDate(s?: string, epoch?: number): string {
  if (epoch) {
    try { return new Date(epoch * 1000).toLocaleString() } catch {/* */}
  }
  if (!s) return ''
  try { return new Date(s).toLocaleString() } catch { return s }
}

export default function NaluEmailPanel({ pairing, open, onClose }: Props) {
  const [accounts, setAccounts] = useState<NaluEmailAccount[] | null>(null)
  const [activeAccount, setActiveAccount] = useState<string>('')
  const [emails, setEmails] = useState<NaluEmailListItem[] | null>(null)
  const [open_, setOpen_] = useState<NaluEmailFull | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadAccounts = useCallback(async () => {
    try {
      const accs = await listEmailAccounts(pairing)
      setAccounts(accs)
      if (accs.length > 0 && !activeAccount) {
        const def = accs.find((a) => a.isDefault) ?? accs[0]
        setActiveAccount(def.id)
      }
    } catch (e) { setError((e as Error).message) }
  }, [pairing, activeAccount])

  const loadInbox = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const list = await listEmails(pairing, {
        folder: 'INBOX', limit: 30,
        accountId: activeAccount || undefined,
      })
      setEmails(list)
    } catch (e) {
      setError((e as Error).message)
    } finally { setLoading(false) }
  }, [pairing, activeAccount])

  useEffect(() => { if (open) loadAccounts() }, [open, loadAccounts])
  useEffect(() => { if (open && activeAccount) loadInbox() }, [open, activeAccount, loadInbox])

  async function handleOpen(uid: string | number) {
    setLoading(true); setError(null)
    try {
      setOpen_(await readEmail(pairing, uid, { accountId: activeAccount }))
    } catch (e) {
      setError((e as Error).message)
    } finally { setLoading(false) }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button aria-label="Close email" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 cursor-default bg-black/40 backdrop-blur-sm" />
          <motion.aside
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.22, ease: [0.22, 0.61, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-lg flex-col border-l border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
              <div className="flex items-center gap-2 text-foreground">
                {open_ ? (
                  <button onClick={() => setOpen_(null)} className="rounded p-1 hover:bg-white/5"><ArrowLeft size={14} /></button>
                ) : (
                  <Mail size={16} />
                )}
                <h2 className="text-sm font-semibold">
                  {open_ ? 'Email' : 'Inbox'}
                </h2>
                {!open_ && emails && <span className="text-xs text-foreground/50">({emails.length})</span>}
              </div>
              <div className="flex items-center gap-1">
                {!open_ && (
                  <button onClick={loadInbox} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Refresh"><RefreshCw size={14} /></button>
                )}
                <button onClick={onClose} className="rounded p-1.5 text-foreground/60 hover:bg-white/5 hover:text-foreground" aria-label="Close"><X size={16} /></button>
              </div>
            </div>

            {!open_ && accounts && accounts.length > 1 && (
              <div className="border-b border-white/5 px-4 py-2 flex items-center gap-2 text-xs">
                <Mailbox size={13} className="text-foreground/50" />
                <select
                  value={activeAccount}
                  onChange={(e) => setActiveAccount(e.target.value)}
                  className="bg-black/30 border border-white/10 rounded px-2 py-1 text-foreground"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name || a.imapUser}</option>
                  ))}
                </select>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0" /> {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {loading && !emails && !open_ && (
                <div className="flex items-center gap-2 px-4 py-6 text-xs text-foreground/60">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {!loading && accounts && accounts.length === 0 && !open_ && (
                <div className="px-4 py-10 text-center text-xs text-foreground/50">
                  No email accounts configured. Add one in your local Nalu under{' '}
                  <strong>Settings → Email</strong> (IMAP/SMTP credentials).
                </div>
              )}

              {/* Inbox list */}
              {!open_ && emails && emails.length > 0 && (
                <ul className="divide-y divide-white/5">
                  {emails.map((m) => (
                    <li key={String(m.uid)} className="px-4 py-3 hover:bg-white/5 cursor-pointer"
                        onClick={() => handleOpen(m.uid)}>
                      <div className="flex items-start gap-2">
                        {!m.seen && <CircleDot size={10} className="text-accent mt-1.5 flex-shrink-0" />}
                        {m.seen && <span className="block h-2.5 w-2.5 mt-1.5 flex-shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className={`text-sm ${m.seen ? 'text-foreground/70' : 'font-medium text-foreground'} truncate`}>
                              {m.fromName || m.from || '(unknown sender)'}
                            </p>
                            <span className="text-[10px] text-foreground/40 flex-shrink-0">{fmtDate(m.date, m.dateEpoch).split(',')[0]}</span>
                          </div>
                          <p className={`text-xs ${m.seen ? 'text-foreground/50' : 'text-foreground/80'} truncate mt-0.5`}>
                            {m.subject}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Read view */}
              {open_ && (
                <article className="p-5 text-sm">
                  <h3 className="text-base font-semibold text-foreground">{open_.subject}</h3>
                  <div className="mt-1 text-xs text-foreground/60">
                    <div><strong>From:</strong> {open_.fromName ?? ''} {open_.fromAddress ? `<${open_.fromAddress}>` : ''}</div>
                    {open_.to && <div className="truncate"><strong>To:</strong> {open_.to}</div>}
                    {open_.date && <div><strong>Date:</strong> {fmtDate(open_.date)}</div>}
                  </div>
                  <hr className="my-3 border-white/10" />
                  {open_.bodyHtml ? (
                    <div
                      className="prose prose-invert prose-sm max-w-none text-foreground/90"
                      // Body comes from the user's own IMAP server via local Nalu,
                      // not from an arbitrary external API. Still — review before
                      // exposing to multi-user deployments.
                      dangerouslySetInnerHTML={{ __html: open_.bodyHtml }}
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-sm text-foreground/85">{open_.body ?? '(empty body)'}</pre>
                  )}
                </article>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
