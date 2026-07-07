import { useState } from 'react'
import { MonitorPlay, X } from 'lucide-react'

// Nalu Browser (web). A REAL Chromium runs on your machine (scripts/serve-browser.py,
// headless — NO separate window) and serves its OWN full UI over TRUSTED HTTPS at
// https://localhost:8701 (cert via mkcert). We embed that as an <iframe> right here
// inside n4lu.ai. Because it's https→https with a browser-trusted cert, it loads inline
// in EVERY browser including Safari (no mixed-content wall). The iframe's calls are
// same-origin to localhost, so screenshot/click/type/run all work in-page. The brain is
// n4lu.ai/api/web — NO API key — and keystrokes go only to your machine.

const SVC = 'https://localhost:8701'

export default function NaluBrowserPanel({
  onClose,
  initialTask,
}: {
  onClose: () => void
  initialTask?: string
}) {
  const task = (initialTask || '').trim()
  // The localhost page reads ?task= and auto-runs it.
  const src = task ? `${SVC}/?task=${encodeURIComponent(task)}` : SVC
  const [showSetup, setShowSetup] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas">
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-glass/10 px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
          <MonitorPlay size={15} />
        </span>
        <span className="text-sm font-semibold text-ink">Nalu Browser</span>
        <span className="hidden text-[11px] text-dim sm:inline">runs on your machine · no key</span>
        <button
          onClick={() => setShowSetup((s) => !s)}
          className="ml-auto rounded-lg bg-glass/10 px-3 py-1.5 text-xs text-ink hover:bg-glass/20"
        >
          {showSetup ? 'Hide setup' : 'Blank / not working?'}
        </button>
        <button onClick={onClose} className="rounded-lg bg-glass/10 px-3 py-1.5 text-sm text-ink hover:bg-glass/20">
          <X size={15} />
        </button>
      </div>

      {showSetup && (
        <div className="border-b border-glass/10 bg-black/30 px-4 py-3 text-xs text-ink">
          <p className="mb-2 text-dim">
            If the screen below is blank, start the local browser once (no API key, no separate window). In a terminal, from
            the project folder:
          </p>
          <pre className="overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] text-[#9fd0ff]">
            {`pip install -U playwright fastapi "uvicorn[standard]" httpx
python -m playwright install chromium

# one time — lets your browser trust the local page (so it embeds inline, incl. Safari):
brew install mkcert nss && mkcert -install

python scripts/serve-browser.py`}
          </pre>
          <p className="mt-2 text-dim">
            The browser then appears right here. Type a task and watch it work — or click &amp; type on the screen yourself for
            a password / 2FA. (Your keystrokes go only to your machine.)
          </p>
        </div>
      )}

      {/* The browser, embedded right here inside Nalu — no separate window, no tab. */}
      <iframe
        title="Nalu Browser"
        src={src}
        className="w-full flex-1 border-0 bg-canvas"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
