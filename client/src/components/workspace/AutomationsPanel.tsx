import { useEffect, useState } from 'react'
import { Zap, Clock, Plus, Trash2, X, Power } from 'lucide-react'

// ---- model ---------------------------------------------------------------

interface Automation {
  id: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
}

const STORAGE_KEY = 'nalu-automations'

const SCHEDULES = [
  'Daily 9:00',
  'Daily 18:00',
  'Weekly Mon',
  'Weekly Fri',
  'Hourly',
  'Manual',
] as const

const DEFAULTS: Automation[] = [
  {
    id: 'a-standup',
    name: 'Morning standup digest',
    prompt:
      'Summarize yesterday’s commits and open PRs, then draft three priorities for today.',
    schedule: 'Daily 9:00',
    enabled: true,
  },
  {
    id: 'a-deps',
    name: 'Dependency audit',
    prompt:
      'Scan package.json for outdated or vulnerable dependencies and list safe upgrades.',
    schedule: 'Weekly Mon',
    enabled: true,
  },
  {
    id: 'a-changelog',
    name: 'Release notes draft',
    prompt:
      'Turn this week’s merged PRs into a human-friendly changelog grouped by feature, fix, and chore.',
    schedule: 'Weekly Fri',
    enabled: false,
  },
]

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function load(): Automation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? (arr as Automation[]) : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

// ---- component -----------------------------------------------------------

export default function AutomationsPanel() {
  const [items, setItems] = useState<Automation[]>(() => load())
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState<string>(SCHEDULES[0])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    } catch {
      // ignore write failures (private mode / quota)
    }
  }, [items])

  function resetForm(): void {
    setName('')
    setPrompt('')
    setSchedule(SCHEDULES[0])
    setAdding(false)
  }

  function addAutomation(): void {
    const trimmedName = name.trim()
    const trimmedPrompt = prompt.trim()
    if (!trimmedName || !trimmedPrompt) return
    const next: Automation = {
      id: uid(),
      name: trimmedName,
      prompt: trimmedPrompt,
      schedule,
      enabled: true,
    }
    setItems((prev) => [next, ...prev])
    resetForm()
  }

  function toggle(id: string): void {
    setItems((prev) =>
      prev.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    )
  }

  function remove(id: string): void {
    setItems((prev) => prev.filter((a) => a.id !== id))
  }

  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0

  return (
    <div className="flex h-full flex-col bg-glass/[0.09] backdrop-blur-2xl font-sans text-ink">
      {/* header */}
      <div className="flex items-start justify-between gap-4 border-b border-glass/[0.18] px-6 py-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-ink">Automations</h1>
            <p className="text-sm text-dim">
              Schedule recurring tasks for Nalu
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New automation
        </button>
      </div>

      {/* body */}
      <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
        {adding && (
          <div className="rounded-2xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium text-ink">
                New automation
              </span>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-lg p-1 text-dim transition hover:bg-glass/5 hover:text-ink"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Automation name"
              className="mb-2 w-full rounded-lg border border-glass/[0.18] bg-glass/[0.08] backdrop-blur-2xl px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-glass/20 focus:outline-none"
            />
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should Nalu do each time this runs?"
              rows={3}
              className="mb-2 w-full resize-none rounded-lg border border-glass/[0.18] bg-glass/[0.08] backdrop-blur-2xl px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-glass/20 focus:outline-none"
            />
            <div className="flex items-center justify-between gap-3">
              <select
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="rounded-lg border border-glass/[0.18] bg-glass/[0.08] backdrop-blur-2xl px-3 py-2 text-sm text-ink focus:border-glass/20 focus:outline-none"
              >
                {SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={addAutomation}
                disabled={!canSubmit}
                className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add automation
              </button>
            </div>
          </div>
        )}

        {items.length === 0 && !adding ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass/[0.18] px-6 py-16 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-glass/5 text-dim">
              <Clock className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-ink">
              No automations yet
            </p>
            <p className="mt-1 max-w-xs text-sm text-dim">
              Create a recurring task and Nalu will run it on your schedule.
            </p>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="mt-4 flex items-center gap-1.5 rounded-lg bg-glass/5 px-3 py-1.5 text-sm text-ink transition hover:bg-glass/10"
            >
              <Plus className="h-4 w-4" />
              New automation
            </button>
          </div>
        ) : (
          items.map((a) => (
            <div
              key={a.id}
              className="group rounded-2xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl p-4 transition hover:bg-glass/5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {a.name}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                        a.enabled
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-glass/5 text-dim'
                      }`}
                    >
                      <Clock className="h-3 w-3" />
                      {a.schedule}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-sm text-dim">
                    {a.prompt}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggle(a.id)}
                    aria-pressed={a.enabled}
                    title={a.enabled ? 'Disable' : 'Enable'}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
                      a.enabled
                        ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                        : 'bg-glass/5 text-dim hover:bg-glass/10'
                    }`}
                  >
                    <Power className="h-3.5 w-3.5" />
                    {a.enabled ? 'On' : 'Off'}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    aria-label="Delete automation"
                    className="rounded-lg p-1.5 text-dim opacity-0 transition hover:bg-glass/5 hover:text-red-300 group-hover:opacity-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
