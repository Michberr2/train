import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Loader2,
  Link2,
  X,
  CheckCircle2,
  AlertCircle,
  Download,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { setPairing, ping, type NaluPairing } from '../lib/nalu-client'

interface Props {
  onPaired: (p: NaluPairing) => void
  onClose: () => void
}

export default function NaluPairingDialog({ onPaired, onClose }: Props) {
  const [payload, setPayload] = useState('')
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('7000')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [showInstall, setShowInstall] = useState(false)

  function parsePayload(raw: string) {
    setError(null)
    try {
      const p = JSON.parse(raw)
      if (p?.host) setHost(String(p.host))
      if (p?.port) setPort(String(p.port))
      if (p?.token) setToken(String(p.token))
    } catch {
      setError('Could not parse JSON payload')
    }
  }

  async function handlePair() {
    setBusy(true)
    setError(null)
    setOkMsg(null)
    try {
      const candidate: NaluPairing = {
        host: host.trim() || 'localhost',
        port: Number(port) || 7000,
        token: token.trim(),
        pairedAt: Date.now(),
      }
      if (!candidate.token) {
        setError('Token is required')
        setBusy(false)
        return
      }
      const r = await ping(candidate)
      if (!r.ok) {
        setError(
          r.error
            ? `Could not reach Nalu: ${r.error}. Is it running at https://${candidate.host}:${candidate.port}?`
            : 'Pairing rejected (token invalid or expired).',
        )
        setBusy(false)
        return
      }
      setPairing(candidate)
      setOkMsg(`Paired with Nalu ${r.version ?? ''}`.trim())
      setTimeout(() => onPaired(candidate), 500)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
        className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-card/95 backdrop-blur-xl p-6 shadow-2xl"
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-foreground/60 hover:text-foreground"
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-2 text-foreground">
          <Link2 size={18} />
          <h2 className="text-lg font-semibold">Pair with your Nalu</h2>
        </div>
        <p className="mt-1 text-sm text-foreground/70">
          Open the Nalu app on this Mac, visit{' '}
          <code className="rounded bg-black/30 px-1.5 py-0.5 text-xs">
            https://localhost:7000/api/companion/pair
          </code>
          , click <em>Generate pairing code</em>, then paste the JSON payload below.
        </p>

        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-foreground/60">
          Paste pairing payload (JSON)
        </label>
        <textarea
          value={payload}
          onChange={(e) => {
            setPayload(e.target.value)
            parsePayload(e.target.value)
          }}
          rows={4}
          spellCheck={false}
          placeholder='{"v":1,"host":"127.0.0.1","port":7000,"token":"ody_..."}'
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 p-2 font-mono text-xs text-foreground placeholder:text-foreground/30 focus:border-accent focus:outline-none"
        />

        <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div>
            <label className="text-xs text-foreground/60">Host</label>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-foreground"
            />
          </div>
          <div>
            <label className="text-xs text-foreground/60">Port</label>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-foreground"
            />
          </div>
          <div className="col-span-3">
            <label className="text-xs text-foreground/60">Token</label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ody_..."
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs text-foreground"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {okMsg && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-sm text-emerald-300">
            <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" />
            <span>{okMsg}</span>
          </div>
        )}

        <div className="mt-4 border-t border-white/5 pt-3">
          <button
            onClick={() => setShowInstall((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-foreground/60 hover:text-foreground"
          >
            {showInstall ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Don&apos;t have Nalu installed yet?
          </button>
          {showInstall && (
            <div className="mt-2 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-foreground/80">
              <div className="mb-2 flex items-center gap-1.5 text-foreground/90">
                <Download size={13} />
                <strong>Install Nalu on this Mac</strong>
              </div>
              <p className="mb-2 text-foreground/70">
                Until signed installers ship, clone &amp; launch the source:
              </p>
              <pre className="overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-foreground/90">
{`git clone https://github.com/Michberr2/n4lu.git ~/n4lu
cd ~/n4lu
./start-macos.sh
# First run: grant Screen Recording in System Settings,
# then visit https://localhost:7000/api/companion/pair
# to generate a pairing payload, paste it above.`}
              </pre>
              <p className="mt-2 text-foreground/50">
                A signed <code>.dmg</code> auto-installer is coming — see{' '}
                <a
                  href="https://github.com/Michberr2/n4lu/releases"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground/80"
                >
                  Releases
                </a>
                .
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-foreground/70 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={handlePair}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Pair
          </button>
        </div>
      </motion.div>
    </div>
  )
}
