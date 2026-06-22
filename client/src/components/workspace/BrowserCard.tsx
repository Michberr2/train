import { useState } from 'react'
import { MonitorPlay, ChevronLeft, ChevronRight, ListChecks } from 'lucide-react'

export type BrowserResult = {
  result?: string
  steps?: string[]
  screenshots?: string[]
  url?: string
  live_url?: string
  task_id?: string
  status?: string
}

// Inline "Nalu Browser" screen — shows what the self-hosted browser agent did:
// the live screenshots of the real browser, the steps it took, and the result.
export default function BrowserCard({ data }: { data: BrowserResult }) {
  const shots = data.screenshots || []
  const [idx, setIdx] = useState(Math.max(0, shots.length - 1))
  const [showSteps, setShowSteps] = useState(false)
  const i = Math.min(idx, Math.max(0, shots.length - 1))

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-white/[0.16] bg-white/[0.04]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.12] px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
          <MonitorPlay size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[#ededed]">Nalu Browser</div>
          <div className="truncate text-xs text-[#8e8e8e]">{data.url || 'Screen executor'}</div>
        </div>
        {(data.steps || []).length > 0 && (
          <button
            onClick={() => setShowSteps((s) => !s)}
            className="flex items-center gap-1.5 rounded-lg bg-white/[0.07] px-2.5 py-1.5 text-xs text-[#ededed] hover:bg-white/[0.12]"
          >
            <ListChecks size={13} /> {(data.steps || []).length} steps
          </button>
        )}
      </div>

      {data.live_url ? (
        <div className="bg-[#0c0e14] p-2">
          <iframe
            src={data.live_url}
            title="Nalu Browser — live"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            allow="clipboard-read; clipboard-write"
            className="h-[34rem] w-full rounded-lg border border-white/[0.12] bg-white"
          />
          <div className="px-1 pt-2 text-xs text-[#8e8e8e]">
            Live — Nalu is working in this browser. You can take over (type a password / clear 2FA) right in the frame.
          </div>
        </div>
      ) : shots.length > 0 ? (
        <div className="bg-[#0c0e14] p-3">
          <img src={shots[i]} alt="browser" className="mx-auto max-h-[26rem] w-auto max-w-full rounded-lg border border-white/[0.1]" />
          {shots.length > 1 && (
            <div className="mt-2 flex items-center justify-center gap-3">
              <button
                onClick={() => setIdx(Math.max(0, i - 1))}
                disabled={i === 0}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.07] text-[#ededed] hover:bg-white/[0.12] disabled:opacity-40"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="text-xs tabular-nums text-[#8e8e8e]">
                {i + 1} / {shots.length}
              </span>
              <button
                onClick={() => setIdx(Math.min(shots.length - 1, i + 1))}
                disabled={i >= shots.length - 1}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.07] text-[#ededed] hover:bg-white/[0.12] disabled:opacity-40"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      ) : null}

      {data.result && (
        <div className="border-t border-white/[0.1] px-4 py-3 text-[15px] leading-relaxed text-[#ededed] whitespace-pre-wrap break-words">
          {data.result}
        </div>
      )}

      {showSteps && (data.steps || []).length > 0 && (
        <ol className="max-h-56 list-decimal space-y-1 overflow-auto border-t border-white/[0.1] bg-black/20 px-7 py-3 text-xs text-[#bcd]">
          {(data.steps || []).map((s, k) => (
            <li key={k} className="break-words">
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
