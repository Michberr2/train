import { useEffect, useMemo, useState } from 'react'
import { Blocks, Check, Download } from 'lucide-react'

type Plugin = {
  id: string
  name: string
  description: string
  installed: boolean
}

// Full-color brand logos via the open Iconify API.
const PLUGIN_LOGOS: Record<string, string> = {
  browser: 'logos:chrome',
  github: 'logos:github-icon',
  linear: 'logos:linear-icon',
  slack: 'logos:slack-icon',
  postgres: 'logos:postgresql',
  vercel: 'logos:vercel-icon',
  notion: 'logos:notion-icon',
  figma: 'logos:figma',
}

const DEFAULT_PLUGINS: Plugin[] = [
  {
    id: 'browser',
    name: 'Browser',
    description: 'Let Nalu browse the web, read pages, and run research tasks.',
    installed: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Open PRs, review diffs, and manage issues from your repos.',
    installed: true,
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Create, update, and triage issues across your Linear teams.',
    installed: false,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send messages, summarize threads, and ping channels.',
    installed: false,
  },
  {
    id: 'postgres',
    name: 'Postgres',
    description: 'Query databases, inspect schemas, and run safe migrations.',
    installed: true,
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Trigger deploys, read build logs, and manage environments.',
    installed: false,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write pages, databases, and docs in your workspace.',
    installed: false,
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Pull frames, inspect components, and export design specs.',
    installed: false,
  },
]

const STORAGE_KEY = 'nalu-plugins'

function loadInstalled(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      // Stored as a set of installed ids.
      return parsed.reduce<Record<string, boolean>>((acc, id) => {
        if (typeof id === 'string') acc[id] = true
        return acc
      }, {})
    }
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, boolean>
    }
    return {}
  } catch {
    return {}
  }
}

export default function PluginsPanel() {
  const [plugins, setPlugins] = useState<Plugin[]>(() => {
    const installed = loadInstalled()
    const hasSaved = Object.keys(installed).length > 0
    return DEFAULT_PLUGINS.map((p) => ({
      ...p,
      installed: hasSaved ? Boolean(installed[p.id]) : p.installed,
    }))
  })

  useEffect(() => {
    try {
      const installedIds = plugins.filter((p) => p.installed).map((p) => p.id)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(installedIds))
    } catch {
      // Ignore persistence failures (private mode, quota, etc.).
    }
  }, [plugins])

  const installedCount = useMemo(
    () => plugins.filter((p) => p.installed).length,
    [plugins],
  )

  const toggle = (id: string) => {
    setPlugins((prev) =>
      prev.map((p) => (p.id === id ? { ...p, installed: !p.installed } : p)),
    )
  }

  return (
    <div className="flex h-full flex-col bg-white/[0.09] backdrop-blur-2xl font-sans text-[#ededed]">
      <header className="flex items-center gap-3 border-b border-white/[0.18] px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 text-emerald-300">
          <Blocks size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-[#ededed]">Plugins</h1>
          <p className="truncate text-sm text-[#8e8e8e]">
            Extend Nalu with integrations
          </p>
        </div>
        <span className="ml-auto rounded-full bg-white/5 px-3 py-1 text-xs text-[#afafaf]">
          {installedCount} installed
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {plugins.map((plugin) => {
            return (
              <div
                key={plugin.id}
                className="flex flex-col rounded-2xl border border-white/[0.18] bg-white/[0.11] backdrop-blur-2xl p-4 transition-colors hover:bg-white/5"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/90">
                    <img
                      src={`https://api.iconify.design/${PLUGIN_LOGOS[plugin.id] ?? 'flat-color-icons:puzzle'}.svg`}
                      alt=""
                      className="h-[22px] w-[22px]"
                      loading="lazy"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium text-[#ededed]">
                      {plugin.name}
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-[#8e8e8e]">
                      {plugin.description}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(plugin.id)}
                  className={`mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    plugin.installed
                      ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
                      : 'bg-white/5 text-[#ededed] hover:bg-white/10'
                  }`}
                >
                  {plugin.installed ? (
                    <>
                      <Check size={14} />
                      Installed
                    </>
                  ) : (
                    <>
                      <Download size={14} />
                      Install
                    </>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
