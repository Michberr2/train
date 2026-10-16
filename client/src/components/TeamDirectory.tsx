import { useCallback, useEffect, useRef, useState } from 'react'

type Member = { id: string; name: string; role: string; responsibilities: string; extension: number; voice: string; active: boolean }
type Props = { apiBase?: string; readToken: () => string | null }

// Identical component in train and desktop; all assignments come from the API.
export default function TeamDirectory({ apiBase = '', readToken }: Props) {
  const trigger = useRef<HTMLButtonElement>(null)
  const close = () => { setOpen(false); trigger.current?.focus() }
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState(() => readToken() || '')
  useEffect(() => {
    const check = () => setToken(readToken() || '')
    const timer = setInterval(check, 1000)
    window.addEventListener('storage', check)
    window.addEventListener('focus', check)
    return () => { clearInterval(timer); window.removeEventListener('storage', check); window.removeEventListener('focus', check) }
  }, [readToken])
  return <div className="relative shrink-0 px-3 py-2">
    <button ref={trigger} type="button" onClick={() => setOpen(true)} className="rounded-lg border border-glass/15 bg-glass/5 px-3 py-2 text-xs text-ink hover:bg-glass/10">Your team</button>
    {open && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <section role="dialog" aria-modal="true" aria-label="Your team" className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-white/15 bg-[#11151d] text-[#f5f2e9] shadow-2xl" onKeyDown={e => {
        if (e.key === 'Escape') close()
        if (e.key === 'Tab') {
          const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]'))
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <h2 className="text-xl font-semibold">Your team</h2>
          <button type="button" autoFocus onClick={close} aria-label="Close team" className="rounded-lg px-3 py-2 hover:bg-white/10">Close</button>
        </div>
        <div className="overflow-y-auto p-6">
          {token ? <TeamContent key={token} token={token} apiBase={apiBase} readToken={readToken} /> : <p>Sign in to see your team across Nalu apps.</p>}
        </div>
      </section>
    </div>}
  </div>
}

function TeamContent({ token, apiBase = '', readToken }: Props & { token: string }) {
  const [members, setMembers] = useState<Member[]>([])
  const [number, setNumber] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [responsibilities, setResponsibilities] = useState('')
  const mounted = useRef(true)
  const generation = useRef(0)
  const sending = useRef(false)
  const requestId = useRef({ signature: '', id: '' })
  const controllers = useRef(new Set<AbortController>())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; for (const c of controllers.current) c.abort() } }, [])
  const current = useCallback(() => mounted.current && readToken() === token, [readToken, token])
  const request = useCallback(async (body: Record<string, unknown>) => {
    const controller = new AbortController(); controllers.current.add(controller)
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`${apiBase}/api/team`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal })
      const data = await response.json().catch(() => null)
      if (!response.ok || data?.error || !data) throw new Error(data?.error || 'Your team is unavailable. Please try again.')
      return data
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The request timed out. Retry the same role to check whether it was saved.')
      throw error
    } finally { clearTimeout(timer); controllers.current.delete(controller) }
  }, [apiBase, token])
  const refresh = useCallback(async () => {
    const id = ++generation.current
    setLoading(true); setError('')
    try {
      const data = await request({ action: 'list' })
      if (!Array.isArray(data.members)) throw new Error('The team response was incomplete. Please refresh.')
      if (current() && id === generation.current) { setMembers(data.members); setNumber(data.number || '') }
    } catch (e) { if (current() && id === generation.current) setError(e instanceof Error ? e.message : 'Could not load your team.') }
    finally { if (current() && id === generation.current) setLoading(false) }
  }, [request, current])
  useEffect(() => { void refresh() }, [refresh])
  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!current() || sending.current || !name.trim() || !role.trim() || !responsibilities.trim()) return
    const signature = JSON.stringify([name.trim(), role.trim(), responsibilities.trim()])
    if (requestId.current.signature !== signature) requestId.current = { signature, id: `role_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}` }
    sending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const data = await request({ action: 'create', name: name.trim(), role: role.trim(), responsibilities: responsibilities.trim(), workspace: 'auto', requestId: requestId.current.id })
      if (!data.member?.id || !Number.isInteger(data.member.extension)) throw new Error('The role could not be confirmed. Retry to check its status.')
      if (current()) {
        setNotice(`${data.member.name} joined your team at extension ${data.member.extension}.`)
        setName(''); setRole(''); setResponsibilities(''); requestId.current = { signature: '', id: '' }
        await refresh()
      }
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : 'Could not add this role.') }
    finally { sending.current = false; if (current()) setBusy(false) }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-sm text-white/65">AI colleagues shared across your Nalu apps.</p>
        {number && <p className="mt-2 text-lg text-[#ddc497]">{number}</p>}
        <p className="mt-1 text-xs text-white/60">On a call, say a name or enter an extension followed by #.</p></div>
      <button type="button" onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-white/15 px-3 py-2 text-xs disabled:opacity-50">{loading ? 'Loading…' : 'Refresh team'}</button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-emerald-400/10 p-3 text-sm text-emerald-200">{notice}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {members.filter(m => m.active).map(member => <article key={member.id} className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
        <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{member.name}</h3><span className="rounded-md bg-[#ddc497]/10 px-2 py-1 text-xs tabular-nums text-[#ddc497]">Ext. {member.extension}</span></div>
        <p className="mt-2 text-sm">{member.role}</p><p className="mt-1 text-xs leading-relaxed text-white/65">{member.responsibilities}</p>
        <p className="mt-3 text-xs text-white/50">Voice: {member.voice.replace('Polly.', '').replace('-Neural', '')}</p>
      </article>)}
    </div>
    <form onSubmit={e => void add(e)} className="space-y-3 border-t border-white/10 pt-5">
      <h3 className="font-semibold">Add a role</h3><p className="text-xs text-white/65">An extension and a distinct available voice are assigned automatically.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs"><span>Name</span><input required value={name} onChange={e => setName(e.target.value)} maxLength={60} className="block w-full rounded-lg border border-white/15 bg-black/20 p-2.5 text-sm" /></label>
        <label className="space-y-1 text-xs"><span>Company role</span><input required value={role} onChange={e => setRole(e.target.value)} maxLength={80} className="block w-full rounded-lg border border-white/15 bg-black/20 p-2.5 text-sm" /></label>
      </div>
      <label className="block space-y-1 text-xs"><span>Responsibilities</span><textarea required value={responsibilities} onChange={e => setResponsibilities(e.target.value)} maxLength={1200} rows={3} className="block w-full rounded-lg border border-white/15 bg-black/20 p-2.5 text-sm" /></label>
      <button type="submit" disabled={busy || !name.trim() || !role.trim() || !responsibilities.trim()} className="rounded-lg bg-[#ddc497] px-4 py-2.5 text-sm font-semibold text-[#16181d] disabled:opacity-40">{busy ? 'Adding…' : 'Add team member'}</button>
    </form>
  </div>
}
