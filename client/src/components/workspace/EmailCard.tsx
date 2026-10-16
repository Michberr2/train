// Nalu Email card — renders a generated email as an "email doc": subject + to +
// body, with Copy (paste into any client) and Send (through a connected account
// via /api/connect). Falls back to a mailto: link when nothing is connected.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mail, Copy, Check, Send, Loader2 } from 'lucide-react'
import { listConnections, sendVia, appDef, type Connection } from '../../lib/connections'
import type { EmailDoc } from './Workspace'
import ConnectionManager from './ConnectionManager'

// A quiet length read-out — reinforces that a good email is usually SHORT.
function lengthLabel(body: string): { label: string; words: number } {
  const words = (body || '').trim().split(/\s+/).filter(Boolean).length
  const label = words <= 125 ? 'Short' : words <= 250 ? 'Medium' : 'Long'
  return { label, words }
}

export default function EmailCard({ data }: { data: EmailDoc }) {
  const [conns, setConns] = useState<Connection[]>([])
  const [to, setTo] = useState(data.to || '')
  const [copied, setCopied] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState('')
  const [connId, setConnId] = useState('')
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const sendingRef = useRef(false)

  const loadConnections = useCallback(() => {
    void listConnections().then((cs) => {
      const email = cs.filter((c) => appDef(c.app).kind === 'email' && c.status === 'connected')
      setConns(email)
      setConnId(current => email.some(c => c.id === current) ? current : email[0]?.id || '')
    }).catch(error => setSent(error instanceof Error ? error.message : 'Could not load connected mail accounts.'))
  }, [])
  useEffect(loadConnections, [loadConnections])

  const copy = () => {
    const text = `Subject: ${data.subject}\n\n${data.body}`
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) })
  }
  const send = async () => {
    if (sendingRef.current) return
    if (!to.trim()) { setSent('Add a recipient first'); return }
    if (!connId) { window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(data.subject)}&body=${encodeURIComponent(data.body)}`; return }
    sendingRef.current = true; setSending(true); setSent('')
    const r = await sendVia(connId, 'email', { to, subject: data.subject, body: data.body, text: data.body })
    sendingRef.current = false; setSending(false); setSent(r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`)
  }

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-glass/[0.12] bg-glass/[0.03]">
      <div className="flex items-center gap-2 border-b border-glass/[0.08] px-4 py-2.5">
        <Mail size={15} className="text-gold" />
        <span className="text-[12px] font-semibold text-ink">Nalu Email</span>
        {(() => { const { label, words } = lengthLabel(data.body); return (
          <span className="rounded-full border border-glass/[0.12] px-2 py-0.5 text-[10px] text-dim" title={`${words} words`}>{label} · {words}w</span>
        ) })()}
        <button onClick={copy} className="ml-auto flex items-center gap-1 rounded-lg border border-glass/[0.12] px-2 py-1 text-[11px] text-ink hover:bg-glass/10">
          {copied ? <Check size={12} className="text-emerald-300" /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="px-4 py-3 text-[13px] text-ink">
        <div className="flex items-center gap-2 border-b border-glass/[0.06] pb-2 text-[12px]">
          <span className="text-dim">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@email.com"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-dim" />
        </div>
        <div className="flex items-center gap-2 border-b border-glass/[0.06] py-2 text-[12px]">
          <span className="text-dim">Subject</span>
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{data.subject}</span>
        </div>
        {/* Contained + scrollable so a long email never runs off the screen. */}
        <div className="mt-3 max-h-[22rem] overflow-y-auto whitespace-pre-wrap pr-1 leading-relaxed text-ink/90">{data.body}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-glass/[0.08] bg-glass/[0.02] px-4 py-2.5">
        {conns.length > 0 ? (
          <select value={connId} onChange={(e) => setConnId(e.target.value)} className="rounded-lg border border-glass/[0.12] bg-transparent px-2 py-1 text-[11.5px] text-ink outline-none">
            {conns.map((c) => <option key={c.id} value={c.id} className="bg-panel2">Send with {c.label}</option>)}
          </select>
        ) : (
          <span className="text-[11px] text-dim">Connect your email account to send from Nalu.</span>
        )}
        <button onClick={() => setConnectionsOpen(true)} className="rounded-lg border border-glass/15 px-2 py-1 text-[11px]">Connections</button>
        <button onClick={send} disabled={sending}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#c9a86a] to-accent px-3 py-1.5 text-[12px] font-semibold text-[#15170f] hover:brightness-110 disabled:opacity-50">
          {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}{connId ? 'Send' : 'Open in mail app'}
        </button>
        {sent && <span className="w-full text-[11px] text-dim">{sent}</span>}
      </div>
      {connectionsOpen && <ConnectionManager onClose={() => setConnectionsOpen(false)} onChange={loadConnections} />}
    </div>
  )
}
