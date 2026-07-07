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
    <div className="flex h-full flex-col bg-glass/[0.09] backdrop-blur-2xl font-sans text-ink">
      <header className="flex items-center gap-3 border-b border-glass/[0.18] px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-glass/5 text-emerald-300">
          <Blocks size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-ink">Plugins</h1>
          <p className="truncate text-sm text-dim">
            Extend Nalu with integrations
          </p>
        </div>
        <span className="ml-auto rounded-full bg-glass/5 px-3 py-1 text-xs text-dim">
          {installedCount} installed
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Featured: Nalu for Chrome (the browser-agent extension). */}
        <div className="mb-5 rounded-2xl border border-accent/30 bg-accent/[0.08] p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-glass/10">
              <img src="/wolf-icon.png" alt="" className="h-6 w-6 brightness-0 dark:brightness-0 dark:invert" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold text-ink">Nalu for Chrome</h2>
                <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">New</span>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-dim">
                Nalu in your browser — give it a goal and it reads the current page and acts for you (clicks, types, navigates), asking before anything consequential. Vision-grounded, multi-tab, with saved &amp; scheduled tasks.
              </p>
              <ol className="mt-3 space-y-1 text-[12.5px] text-dim">
                <li>1. Download the extension and unzip it.</li>
                <li>2. Open <span className="font-mono text-ink">chrome://extensions</span> → turn on <span className="text-ink">Developer mode</span>.</li>
                <li>3. Click <span className="text-ink">Load unpacked</span> and select the unzipped <span className="font-mono text-ink">nalu-for-chrome</span> folder.</li>
                <li>4. Pin it and click the wolf to open the side panel on any page.</li>
              </ol>
              <a
                href="/nalu-for-chrome.zip"
                download
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-[#0a1018] transition-opacity hover:opacity-90"
              >
                <Download size={15} /> Download Nalu for Chrome
              </a>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {plugins.map((plugin) => {
            return (
              <div
                key={plugin.id}
                className="flex flex-col rounded-2xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl p-4 transition-colors hover:bg-glass/5"
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
                    <h2 className="text-sm font-medium text-ink">
                      {plugin.name}
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-dim">
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
                      : 'bg-glass/5 text-ink hover:bg-glass/10'
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
