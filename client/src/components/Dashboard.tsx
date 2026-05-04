import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Search,
  Puzzle,
  Workflow,
  Settings,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommit,
  Mic,
  ArrowUp,
  Lock,
  Sliders,
  Folder,
  FolderOpen,
  FileJson,
  FileText,
  Sun,
  Moon,
  LogOut,
  Sparkles,
  GitPullRequest,
  Gauge,
  Box,
  Database,
  Code as CodeIcon,
  Loader2,
  User,
  Menu,
  X,
  FolderGit2,
  FolderTree,
  FolderUp,
  PanelRightClose,
  PanelRightOpen,
  KeyRound,
  Github,
  Check,
  AlertCircle,
  Trash2,
  Pencil,
  Play,
  MessageSquare,
  PanelBottom,
  AlignCenter,
  Download,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  type LucideIcon,
} from 'lucide-react'
import { useTheme } from './ThemeProvider'

type FileNode =
  | { type: 'file'; name: string; path: string; size: number }
  | { type: 'folder'; name: string; path: string; children: FileNode[] }

interface GitOrigin {
  owner: string
  repo: string
}

interface RepoSnapshot {
  name: string
  branch: string | null
  origin: GitOrigin | null
  fileCount: number
  totalSize: number
  tree: FileNode[]
  files: Map<string, File>
  dirHandle: FileSystemDirectoryHandle | null
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const SUGGESTIONS: { icon: typeof Sparkles; label: string }[] = [
  { icon: Sparkles, label: 'Think of a starter task, implement it, and walk me through the solution' },
  { icon: GitPullRequest, label: 'Explain this project to me' },
  { icon: GitBranch, label: 'Summarize my repo structure' },
  { icon: CodeIcon, label: 'What should I work on next?' },
]

const PAT_KEY = 'nalu-github-pat'
const PLUGINS_KEY = 'nalu-plugins'
const AUTOMATIONS_KEY = 'nalu-automations'
const CHAT_KEY_PREFIX = 'nalu-chat-'
const SESSIONS_KEY_PREFIX = 'nalu-chats-'
const ACTIVE_CHAT_KEY_PREFIX = 'nalu-chat-active-'

interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

function newSessionId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function deriveTitle(msgs: ChatMessage[]): string {
  const firstUser = msgs.find((m) => m.role === 'user')?.content?.trim()
  if (!firstUser) return 'New chat'
  const oneLine = firstUser.replace(/\s+/g, ' ').slice(0, 60)
  return oneLine.length < firstUser.length ? `${oneLine}…` : oneLine
}

type PluginId =
  | 'repo-context'
  | 'github-status'
  | 'package-info'
  | 'readme-context'
  | 'recent-commits'
  | 'open-prs'
  | 'llm-builder'

interface PluginDef {
  id: PluginId
  name: string
  description: string
  icon: LucideIcon
  iconBg: string
  iconColor: string
  defaultEnabled: boolean
  featured?: boolean
  requires?: 'github-pat' | 'origin-remote'
}

const PLUGIN_DEFS: PluginDef[] = [
  {
    id: 'repo-context',
    name: 'Repo Context',
    description: 'Share folder structure with the model',
    icon: FolderTree,
    iconBg: 'bg-blue-500/15',
    iconColor: 'text-blue-400',
    defaultEnabled: true,
    featured: true,
  },
  {
    id: 'github-status',
    name: 'GitHub Status',
    description: 'Latest origin commit injected as context',
    icon: Github,
    iconBg: 'bg-zinc-700/40',
    iconColor: 'text-zinc-100',
    defaultEnabled: false,
    featured: true,
    requires: 'github-pat',
  },
  {
    id: 'package-info',
    name: 'Package Info',
    description: 'package.json scripts and dependencies',
    icon: Box,
    iconBg: 'bg-amber-500/15',
    iconColor: 'text-amber-400',
    defaultEnabled: false,
    featured: true,
  },
  {
    id: 'readme-context',
    name: 'README Preview',
    description: 'First page of your README in context',
    icon: FileText,
    iconBg: 'bg-sky-500/15',
    iconColor: 'text-sky-400',
    defaultEnabled: false,
  },
  {
    id: 'recent-commits',
    name: 'Recent Commits',
    description: 'Last 5 commits on origin',
    icon: GitCommit,
    iconBg: 'bg-violet-500/15',
    iconColor: 'text-violet-400',
    defaultEnabled: false,
    requires: 'github-pat',
  },
  {
    id: 'open-prs',
    name: 'Open PRs',
    description: 'Currently open pull requests on origin',
    icon: GitPullRequest,
    iconBg: 'bg-emerald-500/15',
    iconColor: 'text-emerald-400',
    defaultEnabled: false,
    requires: 'github-pat',
  },
  {
    id: 'llm-builder',
    name: 'LLM Builder',
    description: 'Detect AI SDKs in your project and surface them',
    icon: Sparkles,
    iconBg: 'bg-fuchsia-500/15',
    iconColor: 'text-fuchsia-400',
    defaultEnabled: false,
    featured: true,
  },
]

interface AutomationItem {
  id: string
  name: string
  prompt: string
  createdAt: number
}

const STARTER_AUTOMATIONS: AutomationItem[] = [
  {
    id: 'starter-explain',
    name: 'Explain this project',
    prompt: 'Walk me through this project — what it does, the main entry points, and how the pieces fit together.',
    createdAt: 0,
  },
  {
    id: 'starter-next',
    name: 'What should I work on next?',
    prompt: 'Based on the repo structure and recent activity, suggest 3 concrete things I could work on next, ordered by impact.',
    createdAt: 0,
  },
  {
    id: 'starter-review',
    name: 'Review my recent changes',
    prompt: 'Look at my uncommitted changes and recent commits. Flag bugs, regressions, or things that look off. Be direct.',
    createdAt: 0,
  },
]

function loadPlugins(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const p of PLUGIN_DEFS) out[p.id] = p.defaultEnabled
  if (typeof window === 'undefined') return out
  try {
    const raw = localStorage.getItem(PLUGINS_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, unknown>
      for (const key of Object.keys(stored)) {
        out[key] = !!stored[key]
      }
    }
  } catch {
    // ignore
  }
  return out
}

function loadAutomations(): AutomationItem[] {
  if (typeof window === 'undefined') return STARTER_AUTOMATIONS
  try {
    const raw = localStorage.getItem(AUTOMATIONS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AutomationItem[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    // ignore
  }
  return STARTER_AUTOMATIONS
}

function summarizeTree(tree: FileNode[], maxLines = 60): string {
  const lines: string[] = []
  const walk = (nodes: FileNode[], depth: number) => {
    for (const node of nodes) {
      if (lines.length >= maxLines) {
        lines.push(`${'  '.repeat(depth)}…`)
        return
      }
      const pad = '  '.repeat(depth)
      if (node.type === 'folder') {
        lines.push(`${pad}${node.name}/`)
        walk(node.children, depth + 1)
      } else {
        lines.push(`${pad}${node.name}`)
      }
    }
  }
  walk(tree, 0)
  return lines.slice(0, maxLines).join('\n')
}

const IGNORED_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', '.cache', '.turbo', '.parcel-cache',
  '.vite', '.svelte-kit', '.nuxt', '.output', 'out', 'coverage', '.venv', 'venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'target', '.gradle',
  '.idea', '.DS_Store',
])

interface Props {
  onLogout: () => void
}

export default function Dashboard({ onLogout }: Props) {
  const { isDark, toggleTheme } = useTheme()
  const [repo, setRepo] = useState<RepoSnapshot | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const isNarrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  const [showSummary, setShowSummary] = useState(!isNarrow)
  const [showFiles, setShowFiles] = useState(!isNarrow)
  const [showLeftRail, setShowLeftRail] = useState(!isNarrow)
  const [mobileTab, setMobileTab] = useState<'chat' | 'files' | 'summary'>('chat')
  const [composerPinned, setComposerPinned] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('nalu-composer-pinned') === '1'
  })
  useEffect(() => {
    try {
      localStorage.setItem('nalu-composer-pinned', composerPinned ? '1' : '0')
    } catch {
      // ignore
    }
  }, [composerPinned])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)

  useEffect(() => {
    if (!repo) {
      setSessions([])
      setActiveChatId(null)
      return
    }
    try {
      const raw = localStorage.getItem(SESSIONS_KEY_PREFIX + repo.name)
      let stored: ChatSession[] = []
      if (raw) {
        const parsed = JSON.parse(raw) as ChatSession[]
        if (Array.isArray(parsed)) stored = parsed
      }
      // migrate legacy single-chat key
      if (stored.length === 0) {
        const legacyRaw = localStorage.getItem(CHAT_KEY_PREFIX + repo.name)
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as ChatMessage[]
          if (Array.isArray(legacy) && legacy.length > 0) {
            const id = newSessionId()
            stored.push({
              id,
              title: deriveTitle(legacy),
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: legacy,
            })
          }
          localStorage.removeItem(CHAT_KEY_PREFIX + repo.name)
        }
      }
      // ensure there is always at least one session
      if (stored.length === 0) {
        stored.push({
          id: newSessionId(),
          title: 'New chat',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        })
      }
      setSessions(stored)
      const savedActive = localStorage.getItem(ACTIVE_CHAT_KEY_PREFIX + repo.name)
      const validActive = savedActive && stored.some((s) => s.id === savedActive)
      setActiveChatId(validActive ? savedActive : stored[0].id)
    } catch {
      const id = newSessionId()
      setSessions([{ id, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }])
      setActiveChatId(id)
    }
  }, [repo])

  useEffect(() => {
    if (!repo) return
    if (streaming) return
    try {
      localStorage.setItem(SESSIONS_KEY_PREFIX + repo.name, JSON.stringify(sessions))
      if (activeChatId) {
        localStorage.setItem(ACTIVE_CHAT_KEY_PREFIX + repo.name, activeChatId)
      }
    } catch {
      // storage full / disabled — ignore
    }
  }, [sessions, activeChatId, streaming, repo])

  const messages = useMemo<ChatMessage[]>(
    () => sessions.find((s) => s.id === activeChatId)?.messages ?? [],
    [sessions, activeChatId],
  )

  const setMessages = useCallback(
    (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeChatId) return s
          const next = typeof updater === 'function' ? updater(s.messages) : updater
          return {
            ...s,
            messages: next,
            title: next.length === 0 ? 'New chat' : deriveTitle(next),
            updatedAt: Date.now(),
          }
        }),
      )
    },
    [activeChatId],
  )
  const [showSettings, setShowSettings] = useState(false)
  const [showCommit, setShowCommit] = useState(false)
  const [showConnectGithub, setShowConnectGithub] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [showAutomations, setShowAutomations] = useState(false)
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  const [editedContents, setEditedContents] = useState<Map<string, string>>(new Map())
  const [openFileContent, setOpenFileContent] = useState<string | null>(null)
  const [openFileLoading, setOpenFileLoading] = useState(false)
  const [openFileError, setOpenFileError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null)
  const [fileFullscreen, setFileFullscreen] = useState(false)
  const [toasts, setToasts] = useState<{ id: string; message: string; variant: 'success' | 'error' }[]>([])

  const pushToast = useCallback((message: string, variant: 'success' | 'error' = 'success') => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => [...prev.slice(-2), { id, message, variant }])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 2400)
  }, [])
  const editsSaveTimer = useRef<number | null>(null)
  const saveSeqRef = useRef(0)

  useEffect(() => {
    if (!repo) {
      setEditedContents(new Map())
      return
    }
    try {
      const raw = localStorage.getItem(`nalu-edits-${repo.name}`)
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>
        setEditedContents(new Map(Object.entries(obj)))
        return
      }
    } catch {
      // fall through
    }
    setEditedContents(new Map())
  }, [repo])

  const performSave = useCallback(
    async (savingPath: string, savingContent: string) => {
      if (!repo) return
      const seq = ++saveSeqRef.current
      setSaveStatus('saving')
      setSaveErrorMsg(null)
      try {
        if (repo.dirHandle) {
          await writeFileViaHandle(repo.dirHandle, savingPath, savingContent)
          if (seq !== saveSeqRef.current) return
          setSavedAt(Date.now())
          setSaveStatus('saved')
          pushToast(`Saved ${savingPath}`)
          return
        }
        const res = await fetch('/api/git/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: repo.name, path: savingPath, content: savingContent }),
        })
        if (seq !== saveSeqRef.current) return
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const msg = data?.error || `Save failed (${res.status})`
          setSaveStatus('error')
          setSaveErrorMsg(msg)
          pushToast(`Save failed: ${msg}`, 'error')
          return
        }
        setSavedAt(typeof data?.savedAt === 'number' ? data.savedAt : Date.now())
        setSaveStatus('saved')
        pushToast(`Saved ${savingPath}`)
      } catch (err) {
        if (seq !== saveSeqRef.current) return
        const msg = err instanceof Error ? err.message : 'Save failed'
        setSaveStatus('error')
        setSaveErrorMsg(msg)
        pushToast(`Save failed: ${msg}`, 'error')
      }
    },
    [repo, pushToast],
  )

  const persistEdits = useCallback(
    (next: Map<string, string>, savingPath: string, savingContent: string) => {
      if (!repo) return
      try {
        const obj = Object.fromEntries(next.entries())
        localStorage.setItem(`nalu-edits-${repo.name}`, JSON.stringify(obj))
      } catch {
        // quota or serialization — keep going, disk is source of truth
      }
      if (editsSaveTimer.current) window.clearTimeout(editsSaveTimer.current)
      setSaveStatus('saving')
      setSaveErrorMsg(null)
      editsSaveTimer.current = window.setTimeout(() => {
        editsSaveTimer.current = null
        void performSave(savingPath, savingContent)
      }, 500)
    },
    [repo, performSave],
  )

  const flushSave = useCallback(() => {
    if (!openFilePath) return
    const content = editedContents.get(openFilePath)
    if (content === undefined) return
    if (editsSaveTimer.current) {
      window.clearTimeout(editsSaveTimer.current)
      editsSaveTimer.current = null
    }
    void performSave(openFilePath, content)
  }, [openFilePath, editedContents, performSave])

  const openFile = useCallback(
    (path: string) => {
      if (!repo) return
      const file = repo.files.get(path)
      if (!file) return
      setOpenFilePath(path)
      setOpenFileError(null)
      setSaveStatus('idle')
      setSaveErrorMsg(null)
      const cached = editedContents.get(path)
      if (cached !== undefined) {
        setOpenFileContent(cached)
        setOpenFileLoading(false)
        return
      }
      const ext = getFileExtension(file.name || path)
      const looksText = TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')
      if (!looksText) {
        setOpenFileContent(null)
        setOpenFileLoading(false)
        return
      }
      if (file.size > MAX_TEXT_PREVIEW) {
        setOpenFileContent(null)
        setOpenFileError(`File too large to edit (${formatBytes(file.size)})`)
        setOpenFileLoading(false)
        return
      }
      setOpenFileLoading(true)
      file
        .text()
        .then((content) => {
          setOpenFileContent(content)
          setOpenFileLoading(false)
        })
        .catch((err) => {
          setOpenFileError(err instanceof Error ? err.message : 'Failed to read file')
          setOpenFileLoading(false)
        })
    },
    [repo, editedContents],
  )

  const closeFile = useCallback(() => {
    setOpenFilePath(null)
    setOpenFileContent(null)
    setOpenFileError(null)
    setOpenFileLoading(false)
    setFileFullscreen(false)
  }, [])

  const toggleFileFullscreen = useCallback(() => {
    setFileFullscreen((v) => !v)
  }, [])

  const updateOpenFileContent = useCallback(
    (content: string) => {
      if (!openFilePath) return
      setOpenFileContent(content)
      setEditedContents((prev) => {
        const next = new Map(prev)
        next.set(openFilePath, content)
        persistEdits(next, openFilePath, content)
        return next
      })
    },
    [openFilePath, persistEdits],
  )
  const [searchQuery, setSearchQuery] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<Record<string, boolean>>(() => loadPlugins())
  const [automations, setAutomations] = useState<AutomationItem[]>(() => loadAutomations())

  const savePlugins = useCallback((next: Record<string, boolean>) => {
    setPlugins(next)
    localStorage.setItem(PLUGINS_KEY, JSON.stringify(next))
  }, [])

  const saveAutomations = useCallback((next: AutomationItem[]) => {
    setAutomations(next)
    localStorage.setItem(AUTOMATIONS_KEY, JSON.stringify(next))
  }, [])
  const [githubToken, setGithubToken] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(PAT_KEY)
  })
  const abortRef = useRef<AbortController | null>(null)

  const saveGithubToken = useCallback((token: string | null) => {
    if (token) localStorage.setItem(PAT_KEY, token)
    else localStorage.removeItem(PAT_KEY)
    setGithubToken(token)
  }, [])

  const openCommit = useCallback(() => {
    if (!githubToken) {
      setShowConnectGithub(true)
      return
    }
    setShowCommit(true)
  }, [githubToken])

  const handleGithubConnected = useCallback((token: string) => {
    saveGithubToken(token)
    setShowConnectGithub(false)
    setShowCommit(true)
  }, [saveGithubToken])

  const closeRepo = useCallback(() => {
    abortRef.current?.abort()
    setRepo(null)
    setSessions([])
    setActiveChatId(null)
    setPrompt('')
    setScanError(null)
  }, [])

  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setScanError(null)
    setScanning(true)
    try {
      const { tree, name, branch, origin, files } = await buildTreeFromFiles(fileList)
      const stats = treeStats(tree)
      setRepo({
        name,
        branch,
        origin,
        fileCount: stats.files,
        totalSize: stats.size,
        tree,
        files,
        dirHandle: null,
      })
    } catch (err) {
      setScanError((err as Error).message)
    } finally {
      setScanning(false)
    }
  }, [])

  const handleDirectoryPick = useCallback(async () => {
    setScanError(null)
    let handle: FileSystemDirectoryHandle | null = null
    try {
      handle = await pickDirectoryHandle()
    } catch (err) {
      setScanError((err as Error).message)
      return false
    }
    if (!handle) return false
    setScanning(true)
    try {
      const granted = await ensureWritePermission(handle)
      if (!granted) {
        setScanError('Write permission denied — saves will not persist to disk.')
      }
      const { tree, name, branch, origin, files } = await buildTreeFromHandle(handle)
      const stats = treeStats(tree)
      setRepo({
        name,
        branch,
        origin,
        fileCount: stats.files,
        totalSize: stats.size,
        tree,
        files,
        dirHandle: handle,
      })
      return true
    } catch (err) {
      setScanError((err as Error).message)
      return true
    } finally {
      setScanning(false)
    }
  }, [])

  const sendPrompt = useCallback(async () => {
    const text = prompt.trim()
    if (!text || streaming || !repo) return

    const next: ChatMessage[] = [
      ...messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]
    setMessages(next)
    setPrompt('')
    setStreaming(true)

    let firstUserContent = text
    const isFirstUserMessage = messages.length === 0
    if (isFirstUserMessage) {
      const ctxBlocks: string[] = []
      if (plugins['repo-context']) {
        ctxBlocks.push(
          `Folder structure for \`${repo.name}\`:\n\`\`\`\n${summarizeTree(repo.tree)}\n\`\`\``,
        )
      }
      if (plugins['github-status'] && githubToken && repo.origin) {
        try {
          const r = await fetch(
            `https://api.github.com/repos/${repo.origin.owner}/${repo.origin.repo}/commits?per_page=1`,
            {
              headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
              },
            },
          )
          if (r.ok) {
            const arr = (await r.json()) as Array<{
              sha: string
              commit: { message: string; author: { name: string; date: string } }
            }>
            const c = arr[0]
            if (c) {
              ctxBlocks.push(
                `Latest commit on \`${repo.origin.owner}/${repo.origin.repo}\`: ${c.sha.slice(0, 7)} — ${c.commit.message.split('\n')[0]} (${c.commit.author.name}, ${c.commit.author.date})`,
              )
            }
          }
        } catch {
          // best-effort
        }
      }
      if (plugins['package-info']) {
        const pkgFile = repo.files.get('package.json')
        if (pkgFile) {
          try {
            const json = JSON.parse(await pkgFile.text()) as {
              name?: string
              version?: string
              scripts?: Record<string, string>
              dependencies?: Record<string, string>
              devDependencies?: Record<string, string>
            }
            const scripts = json.scripts ? Object.keys(json.scripts).join(', ') : 'none'
            const deps = Object.keys(json.dependencies ?? {}).slice(0, 12).join(', ') || 'none'
            const devDeps = Object.keys(json.devDependencies ?? {}).slice(0, 12).join(', ') || 'none'
            ctxBlocks.push(
              `package.json: ${json.name ?? '(unnamed)'}@${json.version ?? '?'}\n  scripts: ${scripts}\n  deps: ${deps}\n  devDeps: ${devDeps}`,
            )
          } catch {
            // ignore malformed package.json
          }
        }
      }
      if (plugins['readme-context']) {
        const readmeKey = Array.from(repo.files.keys()).find((k) =>
          /^readme(\.[^/]+)?$/i.test(k),
        )
        if (readmeKey) {
          try {
            const raw = await repo.files.get(readmeKey)!.text()
            ctxBlocks.push(`README preview (\`${readmeKey}\`):\n\`\`\`\n${raw.slice(0, 1500)}\n\`\`\``)
          } catch {
            // ignore
          }
        }
      }
      if (plugins['recent-commits'] && githubToken && repo.origin) {
        try {
          const r = await fetch(
            `https://api.github.com/repos/${repo.origin.owner}/${repo.origin.repo}/commits?per_page=5`,
            {
              headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
              },
            },
          )
          if (r.ok) {
            const arr = (await r.json()) as Array<{
              sha: string
              commit: { message: string; author: { name: string } }
            }>
            const lines = arr.map(
              (c) =>
                `  ${c.sha.slice(0, 7)} — ${c.commit.message.split('\n')[0]} (${c.commit.author.name})`,
            )
            if (lines.length > 0) {
              ctxBlocks.push(
                `Last ${lines.length} commits on \`${repo.origin.owner}/${repo.origin.repo}\`:\n${lines.join('\n')}`,
              )
            }
          }
        } catch {
          // best-effort
        }
      }
      if (plugins['llm-builder']) {
        const detected: string[] = []
        const pkg = repo.files.get('package.json')
        if (pkg) {
          try {
            const json = JSON.parse(await pkg.text()) as {
              dependencies?: Record<string, string>
              devDependencies?: Record<string, string>
            }
            const all = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) }
            const NPM_LLM: Array<[RegExp, string]> = [
              [/^@anthropic-ai\/sdk$/, 'Anthropic SDK'],
              [/^@anthropic-ai\/claude-code$/, 'Claude Agent SDK'],
              [/^openai$/, 'OpenAI SDK'],
              [/^ai$/, 'Vercel AI SDK'],
              [/^@ai-sdk\//, 'Vercel AI SDK provider'],
              [/^langchain$/, 'LangChain'],
              [/^@langchain\//, 'LangChain module'],
              [/^llamaindex$/, 'LlamaIndex'],
              [/^@google\/generative-ai$/, 'Google Generative AI'],
              [/^@aws-sdk\/client-bedrock-runtime$/, 'AWS Bedrock'],
              [/^cohere-ai$/, 'Cohere'],
              [/^replicate$/, 'Replicate'],
              [/^together-ai$/, 'Together AI'],
              [/^groq-sdk$/, 'Groq'],
              [/^@mistralai\//, 'Mistral'],
              [/^ollama$/, 'Ollama'],
              [/^@modelcontextprotocol\/sdk$/, 'MCP SDK'],
            ]
            for (const [name, version] of Object.entries(all)) {
              for (const [re, label] of NPM_LLM) {
                if (re.test(name)) detected.push(`${label} (\`${name}@${version}\`)`)
              }
            }
          } catch {
            // ignore malformed package.json
          }
        }
        const PY_LLM = [
          'anthropic',
          'openai',
          'langchain',
          'llama-index',
          'cohere',
          'replicate',
          'transformers',
          'huggingface_hub',
          'litellm',
          'instructor',
          'mistralai',
          'google-generativeai',
          'boto3',
          'ollama',
        ]
        const reqs = repo.files.get('requirements.txt')
        if (reqs) {
          try {
            const text = await reqs.text()
            for (const line of text.split('\n')) {
              const name = line.split(/[<>=~!#\s]/)[0].trim().toLowerCase()
              if (!name) continue
              for (const p of PY_LLM) {
                if (name === p || name.startsWith(`${p}[`)) {
                  detected.push(`Python: \`${name}\``)
                }
              }
            }
          } catch {
            // ignore
          }
        }
        const pyproj = repo.files.get('pyproject.toml')
        if (pyproj) {
          try {
            const text = await pyproj.text()
            for (const p of PY_LLM) {
              const re = new RegExp(`["']${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`)
              if (re.test(text)) detected.push(`Python (pyproject): \`${p}\``)
            }
          } catch {
            // ignore
          }
        }

        if (detected.length > 0) {
          ctxBlocks.push(`LLM stack detected in this repo:\n${detected.map((d) => `  - ${d}`).join('\n')}`)
        } else {
          ctxBlocks.push(
            `LLM Builder enabled — no AI SDKs detected. If the user is building an LLM app, recommend the Anthropic SDK (\`@anthropic-ai/sdk\` for Node, \`anthropic\` for Python) and Claude models: \`claude-opus-4-7\` (complex), \`claude-sonnet-4-6\` (general), \`claude-haiku-4-5\` (fast).`,
          )
        }
      }
      if (plugins['open-prs'] && githubToken && repo.origin) {
        try {
          const r = await fetch(
            `https://api.github.com/repos/${repo.origin.owner}/${repo.origin.repo}/pulls?state=open&per_page=10`,
            {
              headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
              },
            },
          )
          if (r.ok) {
            const arr = (await r.json()) as Array<{
              number: number
              title: string
              user: { login: string } | null
            }>
            if (arr.length > 0) {
              const lines = arr.map(
                (p) => `  #${p.number} — ${p.title} (@${p.user?.login ?? 'unknown'})`,
              )
              ctxBlocks.push(
                `Open PRs on \`${repo.origin.owner}/${repo.origin.repo}\`:\n${lines.join('\n')}`,
              )
            } else {
              ctxBlocks.push(`No open PRs on \`${repo.origin.owner}/${repo.origin.repo}\`.`)
            }
          }
        } catch {
          // best-effort
        }
      }
      if (ctxBlocks.length > 0) {
        firstUserContent = `${ctxBlocks.join('\n\n')}\n\n---\n\n${text}`
      }
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const apiMessages = next
        .filter((m) => m.role === 'user' || m.content)
        .map((m) => ({ role: m.role, content: m.content }))
      if (isFirstUserMessage && apiMessages[0]?.role === 'user') {
        apiMessages[0] = { ...apiMessages[0], content: firstUserContent }
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          repo: repo.name,
          messages: apiMessages,
          githubConnected: !!githubToken,
          origin: repo.origin ?? null,
          branch: repo.branch ?? null,
        }),
      })
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '')
        setMessages((prev) => {
          const out = [...prev]
          out[out.length - 1] = { role: 'assistant', content: `Error: ${res.status} ${errText.slice(0, 200)}` }
          return out
        })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sepIdx
        while ((sepIdx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, sepIdx)
          buf = buf.slice(sepIdx + 2)
          const eventMatch = block.match(/^event:\s*(\S+)/m)
          const dataMatch = block.match(/^data:\s*(.+)$/m)
          if (!eventMatch || !dataMatch) continue
          const eventName = eventMatch[1]
          let payload: { text?: string; message?: string } = {}
          try { payload = JSON.parse(dataMatch[1]) } catch { continue }
          if (eventName === 'delta' && payload.text) {
            setMessages((prev) => {
              const out = [...prev]
              const last = out[out.length - 1]
              if (last && last.role === 'assistant') {
                out[out.length - 1] = { ...last, content: last.content + payload.text }
              }
              return out
            })
          } else if (eventName === 'error') {
            setMessages((prev) => {
              const out = [...prev]
              out[out.length - 1] = { role: 'assistant', content: `Error: ${payload.message ?? 'unknown'}` }
              return out
            })
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) => {
          const out = [...prev]
          const last = out[out.length - 1]
          if (last && last.role === 'assistant' && !last.content) {
            out[out.length - 1] = { role: 'assistant', content: `Error: ${(err as Error).message}` }
          }
          return out
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [prompt, streaming, messages, repo, plugins, githubToken])

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    setPrompt('')
    const id = newSessionId()
    const fresh: ChatSession = {
      id,
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    setSessions((prev) => {
      const trimmed = prev.filter((s) => s.messages.length > 0)
      return [fresh, ...trimmed]
    })
    setActiveChatId(id)
  }, [])

  const selectChat = useCallback((id: string) => {
    abortRef.current?.abort()
    setActiveChatId(id)
    setPrompt('')
  }, [])

  const deleteChat = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id)
        if (remaining.length === 0) {
          const fresh: ChatSession = {
            id: newSessionId(),
            title: 'New chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
          }
          setActiveChatId(fresh.id)
          return [fresh]
        }
        if (id === activeChatId) {
          setActiveChatId(remaining[0].id)
        }
        return remaining
      })
    },
    [activeChatId],
  )

  const visibleMessages = useMemo(() => {
    if (!searchQuery || !searchQuery.trim()) return messages
    const q = searchQuery.toLowerCase()
    return messages.filter((m) => m.content.toLowerCase().includes(q))
  }, [messages, searchQuery])

  if (!repo) {
    return (
      <RepoPicker
        isDark={isDark}
        toggleTheme={toggleTheme}
        onFiles={handleFiles}
        onPickDirectory={handleDirectoryPick}
        scanning={scanning}
        error={scanError}
        onLogout={onLogout}
      />
    )
  }

  return (
    <div className="h-[100dvh] w-screen flex flex-col bg-background text-primary overflow-hidden">
      <TopBar
        isDark={isDark}
        toggleTheme={toggleTheme}
        onLogout={onLogout}
        repo={repo}
        onSwitchRepo={closeRepo}
        showSummary={showSummary}
        toggleSummary={() => setShowSummary((v) => !v)}
        showFiles={showFiles}
        toggleFiles={() => setShowFiles((v) => !v)}
        showLeftRail={showLeftRail}
        toggleLeftRail={() => setShowLeftRail((v) => !v)}
        onCommit={openCommit}
        githubConnected={!!githubToken}
      />

      {searchQuery !== null && (
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          onClose={() => setSearchQuery(null)}
          resultCount={visibleMessages.length}
          totalCount={messages.length}
        />
      )}

      <div className="hidden md:flex flex-1 min-h-0 relative">
        {showLeftRail && !fileFullscreen && (
          <LeftRail
            onNewChat={newChat}
            repo={repo}
            onSwitchRepo={closeRepo}
            onSearch={() => setSearchQuery('')}
            onSettings={() => setShowSettings(true)}
            onPlugins={() => setShowPlugins(true)}
            onAutomations={() => setShowAutomations(true)}
            chats={sessions}
            activeChatId={activeChatId}
            onSelectChat={selectChat}
            onDeleteChat={deleteChat}
          />
        )}
        <CenterPane
          prompt={prompt}
          setPrompt={setPrompt}
          messages={visibleMessages}
          streaming={streaming}
          onSend={sendPrompt}
          repo={repo}
          composerPinned={composerPinned}
          onToggleComposerPinned={() => setComposerPinned((v) => !v)}
          openFilePath={openFilePath}
          openFileContent={openFileContent}
          openFileLoading={openFileLoading}
          openFileError={openFileError}
          savedAt={savedAt}
          saveStatus={saveStatus}
          saveErrorMsg={saveErrorMsg}
          onChangeFileContent={updateOpenFileContent}
          onCloseFile={closeFile}
          onFlushSave={flushSave}
          fileFullscreen={fileFullscreen}
          onToggleFileFullscreen={toggleFileFullscreen}
        />
        {showSummary && !fileFullscreen && (
          <SummaryPane
            repo={repo}
            streaming={streaming}
            hasMessages={messages.length > 0}
            githubConnected={!!githubToken}
            onClose={() => setShowSummary(false)}
          />
        )}
        {showFiles && !fileFullscreen && (
          <FilesPane tree={repo.tree} onClose={() => setShowFiles(false)} onOpenFile={openFile} />
        )}
        {!fileFullscreen && (
          <CollapsedEdgeRail
            showSummary={showSummary}
            showFiles={showFiles}
            onShowSummary={() => setShowSummary(true)}
            onShowFiles={() => setShowFiles(true)}
          />
        )}
      </div>

      <div className="flex md:hidden flex-1 min-h-0 flex-col relative">
        <div className="flex-1 min-h-0 overflow-hidden">
          {mobileTab === 'chat' && (
            <CenterPane
              prompt={prompt}
              setPrompt={setPrompt}
              messages={visibleMessages}
              streaming={streaming}
              onSend={sendPrompt}
              repo={repo}
              composerPinned={composerPinned}
              onToggleComposerPinned={() => setComposerPinned((v) => !v)}
              openFilePath={openFilePath}
              openFileContent={openFileContent}
              openFileLoading={openFileLoading}
              openFileError={openFileError}
              savedAt={savedAt}
              saveStatus={saveStatus}
              saveErrorMsg={saveErrorMsg}
              onChangeFileContent={updateOpenFileContent}
              onCloseFile={closeFile}
              onFlushSave={flushSave}
              fileFullscreen={fileFullscreen}
              onToggleFileFullscreen={toggleFileFullscreen}
            />
          )}
          {mobileTab === 'files' && (
            <FilesPane
              tree={repo.tree}
              onClose={() => setMobileTab('chat')}
              onOpenFile={(p) => {
                openFile(p)
                setMobileTab('chat')
              }}
            />
          )}
          {mobileTab === 'summary' && (
            <SummaryPane
              repo={repo}
              streaming={streaming}
              hasMessages={messages.length > 0}
              githubConnected={!!githubToken}
              onClose={() => setMobileTab('chat')}
            />
          )}
        </div>
        <MobileBottomNav active={mobileTab} onChange={setMobileTab} dirtyCount={messages.length} />
      </div>

      {showLeftRail && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <LeftRail
            onNewChat={() => { newChat(); setShowLeftRail(false); setMobileTab('chat') }}
            repo={repo}
            onSwitchRepo={() => { setShowLeftRail(false); closeRepo() }}
            onSearch={() => { setShowLeftRail(false); setSearchQuery('') }}
            onSettings={() => { setShowLeftRail(false); setShowSettings(true) }}
            onPlugins={() => { setShowLeftRail(false); setShowPlugins(true) }}
            onAutomations={() => { setShowLeftRail(false); setShowAutomations(true) }}
            chats={sessions}
            activeChatId={activeChatId}
            onSelectChat={(id) => { selectChat(id); setShowLeftRail(false); setMobileTab('chat') }}
            onDeleteChat={deleteChat}
          />
          <button
            aria-label="Close menu"
            onClick={() => setShowLeftRail(false)}
            className="flex-1 bg-black/40 backdrop-blur-sm"
          />
        </div>
      )}

      {showSettings && (
        <SettingsModal
          isDark={isDark}
          toggleTheme={toggleTheme}
          githubToken={githubToken}
          onSaveToken={saveGithubToken}
          onClose={() => setShowSettings(false)}
          onLogout={onLogout}
        />
      )}

      {showConnectGithub && (
        <ConnectGitHubModal
          onSaveToken={handleGithubConnected}
          onClose={() => setShowConnectGithub(false)}
        />
      )}

      {showCommit && githubToken && (
        <CommitModal
          repo={repo}
          token={githubToken}
          onClose={() => setShowCommit(false)}
        />
      )}

      {showPlugins && (
        <PluginsModal
          plugins={plugins}
          onChange={savePlugins}
          githubConnected={!!githubToken}
          hasOrigin={!!repo.origin}
          onClose={() => setShowPlugins(false)}
          onOpenSettings={() => { setShowPlugins(false); setShowSettings(true) }}
        />
      )}

      {showAutomations && (
        <AutomationsModal
          items={automations}
          onChange={saveAutomations}
          onRun={(prompt) => {
            setShowAutomations(false)
            setMobileTab('chat')
            setPrompt(prompt)
          }}
          onClose={() => setShowAutomations(false)}
        />
      )}

      <ToastStack toasts={toasts} />

    </div>
  )
}

function ToastStack({ toasts }: { toasts: { id: string; message: string; variant: 'success' | 'error' }[] }) {
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center pointer-events-none"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} message={t.message} variant={t.variant} />
      ))}
    </div>
  )
}

function ToastItem({ message, variant }: { message: string; variant: 'success' | 'error' }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const enter = window.requestAnimationFrame(() => setShow(true))
    const leave = window.setTimeout(() => setShow(false), 2100)
    return () => {
      window.cancelAnimationFrame(enter)
      window.clearTimeout(leave)
    }
  }, [])
  const Icon = variant === 'success' ? Check : AlertCircle
  const accent = variant === 'success' ? 'text-green-500' : 'text-red-500'
  return (
    <div
      className={`pointer-events-auto inline-flex items-center gap-2 px-3.5 py-2 rounded-full bg-surface border border-border-gray shadow-lg text-xs text-primary transition-all duration-200 ${
        show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <Icon size={13} strokeWidth={2} className={accent} />
      <span className="font-medium truncate max-w-[60vw]">{message}</span>
    </div>
  )
}

function MobileBottomNav({
  active,
  onChange,
  dirtyCount,
}: {
  active: 'chat' | 'files' | 'summary'
  onChange: (t: 'chat' | 'files' | 'summary') => void
  dirtyCount: number
}) {
  const Item = ({
    id,
    icon: Icon,
    label,
    badge,
  }: {
    id: 'chat' | 'files' | 'summary'
    icon: typeof Sparkles
    label: string
    badge?: number
  }) => {
    const selected = active === id
    return (
      <button
        onClick={() => onChange(id)}
        aria-label={label}
        aria-current={selected ? 'page' : undefined}
        className={`flex-1 h-full flex flex-col items-center justify-center gap-0.5 transition-colors ${
          selected ? 'text-primary' : 'text-tertiary'
        }`}
      >
        <div className="relative">
          <Icon size={20} strokeWidth={selected ? 2 : 1.6} />
          {badge !== undefined && badge > 0 && (
            <span className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-accent-blue text-[9px] text-white font-medium flex items-center justify-center">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </div>
        <span className="text-[10px] font-medium">{label}</span>
      </button>
    )
  }

  return (
    <nav
      className="h-14 flex-shrink-0 border-t border-border-gray bg-surface flex items-stretch"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <Item id="chat" icon={Sparkles} label="Chat" badge={dirtyCount} />
      <Item id="files" icon={FolderTree} label="Files" />
      <Item id="summary" icon={Sliders} label="Summary" />
    </nav>
  )
}

interface FileWithPath extends File {
  webkitRelativePath: string
}

function parseGitOrigin(configText: string): GitOrigin | null {
  const lines = configText.split(/\r?\n/)
  let inOrigin = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[remote\s+"origin"\]/.test(trimmed)) {
      inOrigin = true
      continue
    }
    if (trimmed.startsWith('[')) {
      inOrigin = false
      continue
    }
    if (inOrigin) {
      const m = trimmed.match(/^url\s*=\s*(.+)$/)
      if (!m) continue
      const url = m[1].trim()
      const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(\.git)?$/)
      if (ssh) return { owner: ssh[1], repo: ssh[2] }
      const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(\.git)?$/)
      if (https) return { owner: https[1], repo: https[2] }
    }
  }
  return null
}

function pickDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }
  if (!w.showDirectoryPicker) return Promise.resolve(null)
  return w
    .showDirectoryPicker({ mode: 'readwrite' })
    .catch((err: unknown) => {
      if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError') {
        return null
      }
      throw err
    })
}

async function ensureWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  }
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) === 'granted') return true
  return false
}

async function buildTreeFromHandle(rootHandle: FileSystemDirectoryHandle): Promise<{
  tree: FileNode[]
  name: string
  branch: string | null
  origin: GitOrigin | null
  files: Map<string, File>
}> {
  const files = new Map<string, File>()
  const root: FileNode = { type: 'folder', name: rootHandle.name, path: '', children: [] }

  type Frame = { handle: FileSystemDirectoryHandle; node: FileNode; basePath: string }
  const stack: Frame[] = [{ handle: rootHandle, node: root, basePath: '' }]

  while (stack.length) {
    const { handle, node, basePath } = stack.pop()!
    const entries = (handle as unknown as {
      entries: () => AsyncIterable<[string, FileSystemHandle]>
    }).entries()
    for await (const [name, entry] of entries) {
      if (name === '.git') continue
      if (IGNORED_DIRS.has(name)) continue
      const path = basePath ? `${basePath}/${name}` : name
      if (entry.kind === 'file') {
        try {
          const file = await (entry as FileSystemFileHandle).getFile()
          files.set(path, file)
          if (node.type === 'folder') {
            node.children.push({ type: 'file', name, path, size: file.size })
          }
        } catch {
          // skip unreadable
        }
      } else if (entry.kind === 'directory') {
        const folder: FileNode = { type: 'folder', name, path, children: [] }
        if (node.type === 'folder') node.children.push(folder)
        stack.push({ handle: entry as FileSystemDirectoryHandle, node: folder, basePath: path })
      }
    }
  }

  let branch: string | null = null
  let origin: GitOrigin | null = null
  try {
    const gitDir = await rootHandle.getDirectoryHandle('.git')
    try {
      const headFh = await gitDir.getFileHandle('HEAD')
      const text = await (await headFh.getFile()).text()
      const m = text.match(/ref:\s+refs\/heads\/(.+)/)
      if (m) branch = m[1].trim()
      else if (text.trim().length === 40) branch = text.trim().slice(0, 7)
    } catch {
      // ignore
    }
    try {
      const cfgFh = await gitDir.getFileHandle('config')
      origin = parseGitOrigin(await (await cfgFh.getFile()).text())
    } catch {
      // ignore
    }
  } catch {
    // not a git repo or no permission
  }

  const sortNode = (n: FileNode) => {
    if (n.type !== 'folder') return
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    n.children.forEach(sortNode)
  }
  sortNode(root)

  return {
    tree: root.type === 'folder' ? root.children : [],
    name: rootHandle.name,
    branch,
    origin,
    files,
  }
}

async function writeFileViaHandle(
  rootHandle: FileSystemDirectoryHandle,
  filePath: string,
  content: string,
): Promise<number> {
  const parts = filePath.split('/').filter(Boolean)
  if (parts.length === 0) throw new Error('empty path')
  const fileName = parts.pop()!
  let dir = rootHandle
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment, { create: true })
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true })
  const writable = await (fileHandle as unknown as {
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>
  }).createWritable()
  await writable.write(content)
  await writable.close()
  const file = await fileHandle.getFile()
  return file.size
}

async function buildTreeFromFiles(
  fileList: FileList,
): Promise<{
  tree: FileNode[]
  name: string
  branch: string | null
  origin: GitOrigin | null
  files: Map<string, File>
}> {
  const files = Array.from(fileList) as FileWithPath[]
  if (files.length === 0) {
    return { tree: [], name: 'folder', branch: null, origin: null, files: new Map() }
  }

  const firstPath = files[0].webkitRelativePath || files[0].name
  const rootName = firstPath.split('/')[0] || 'folder'

  let branch: string | null = null
  let origin: GitOrigin | null = null
  for (const f of files) {
    const rel = f.webkitRelativePath
    if (!rel) continue
    if (rel.endsWith('/.git/HEAD') && !branch) {
      try {
        const text = await f.text()
        const match = text.match(/ref:\s+refs\/heads\/(.+)/)
        if (match) {
          branch = match[1].trim()
        } else {
          const trimmed = text.trim()
          if (trimmed.length === 40) branch = trimmed.slice(0, 7)
        }
      } catch {
        // ignore
      }
    }
    if (rel.endsWith('/.git/config') && !origin) {
      try {
        origin = parseGitOrigin(await f.text())
      } catch {
        // ignore
      }
    }
    if (branch && origin) break
  }

  const fileMap = new Map<string, File>()
  const root: FileNode = { type: 'folder', name: rootName, path: '', children: [] }
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name
    const parts = rel.split('/').slice(1)
    if (parts.length === 0) continue
    if (parts[0] === '.git') continue
    if (parts.some((p) => IGNORED_DIRS.has(p))) continue

    const relPath = parts.join('/')
    fileMap.set(relPath, f)

    let node = root
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      acc = acc ? `${acc}/${part}` : part
      const isFile = i === parts.length - 1
      const children = node.children!
      let next = children.find((c) => c.name === part)
      if (!next) {
        next = isFile
          ? { type: 'file', name: part, path: acc, size: f.size }
          : { type: 'folder', name: part, path: acc, children: [] }
        children.push(next)
      }
      if (next.type === 'folder') node = next
    }
  }

  const sortNode = (n: FileNode) => {
    if (n.type !== 'folder') return
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    n.children.forEach(sortNode)
  }
  sortNode(root)

  return {
    tree: root.type === 'folder' ? root.children : [],
    name: rootName,
    branch,
    origin,
    files: fileMap,
  }
}

function treeStats(tree: FileNode[]): { files: number; size: number } {
  let files = 0
  let size = 0
  for (const node of tree) {
    if (node.type === 'file') {
      files += 1
      size += node.size
    } else {
      const s = treeStats(node.children)
      files += s.files
      size += s.size
    }
  }
  return { files, size }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function ConnectGitHubModal({
  onSaveToken,
  onClose,
}: {
  onSaveToken: (token: string) => void
  onClose: () => void
}) {
  const [token, setToken] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    const t = token.trim()
    if (!t) return
    setVerifying(true)
    setError(null)
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json' },
      })
      if (!r.ok) {
        setError(`GitHub rejected the token (${r.status}). Needs at least \`repo\` scope.`)
        return
      }
      onSaveToken(t)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <ModalShell title="Connect GitHub" icon={Github} onClose={onClose}>
      <div className="p-4 sm:p-5 space-y-4">
        <p className="text-sm text-tertiary leading-relaxed">
          Connect a Personal Access Token to commit changes back to GitHub. Token stays in this browser only.
        </p>
        <div className="text-[11px] text-tertiary leading-relaxed">
          Create one at{' '}
          <a
            href="https://github.com/settings/tokens?type=beta"
            target="_blank"
            rel="noreferrer"
            className="text-accent-blue hover:underline"
          >
            github.com/settings/tokens
          </a>{' '}
          with <span className="text-primary">Contents: Read &amp; write</span> and{' '}
          <span className="text-primary">Metadata: Read</span>.
        </div>
        <div className="relative">
          <KeyRound size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') connect() }}
            placeholder="ghp_… or github_pat_…"
            className="w-full h-11 pl-8 pr-3 rounded-lg bg-background border border-border-gray text-sm text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue"
          />
        </div>
        {error && (
          <p className="text-[11px] text-red-500 flex items-start gap-1">
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" /> {error}
          </p>
        )}
        <button
          onClick={connect}
          disabled={verifying || !token.trim()}
          className="w-full h-11 rounded-lg bg-primary text-surface text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2"
        >
          {verifying ? (
            <>
              <Loader2 size={15} className="animate-spin" /> Verifying…
            </>
          ) : (
            <>
              <Github size={15} /> Connect &amp; continue
            </>
          )}
        </button>
      </div>
    </ModalShell>
  )
}

function RepoPicker({
  isDark,
  toggleTheme,
  onFiles,
  onPickDirectory,
  scanning,
  error,
  onLogout,
}: {
  isDark: boolean
  toggleTheme: (e?: React.MouseEvent) => void
  onFiles: (files: FileList | null) => void
  onPickDirectory: () => Promise<boolean>
  scanning: boolean
  error: string | null
  onLogout: () => void
}) {
  const supportsDirectoryPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const handleChooseClick = async () => {
    if (supportsDirectoryPicker) {
      const handled = await onPickDirectory()
      if (handled) return
    }
    inputRef.current?.click()
  }

  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const items = e.dataTransfer.items
    if (!items || items.length === 0) return
    const collected: File[] = []
    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file: File = await new Promise((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        )
        Object.defineProperty(file, 'webkitRelativePath', {
          value: prefix ? `${prefix}/${entry.name}` : entry.name,
          writable: false,
        })
        collected.push(file)
      } else if (entry.isDirectory) {
        const dirReader = (entry as FileSystemDirectoryEntry).createReader()
        const readBatch = (): Promise<FileSystemEntry[]> =>
          new Promise((resolve, reject) => dirReader.readEntries(resolve, reject))
        let entries = await readBatch()
        while (entries.length > 0) {
          for (const child of entries) {
            await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name)
          }
          entries = await readBatch()
        }
      }
    }
    const roots: FileSystemEntry[] = []
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.()
      if (entry) roots.push(entry)
    }
    for (const entry of roots) await walk(entry, '')

    const dt = new DataTransfer()
    for (const f of collected) dt.items.add(f)
    onFiles(dt.files)
  }, [onFiles])

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-primary">
      <div className="h-11 flex items-center justify-between px-3 border-b border-border-gray bg-surface flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-secondary">
          <FolderGit2 size={14} />
          <span>Open a folder</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => toggleTheme(e)}
            aria-label={isDark ? 'Light mode' : 'Dark mode'}
            className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            onClick={onLogout}
            aria-label="Sign out"
            className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-10 flex items-center justify-center">
        <div className="max-w-md w-full text-center">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`rounded-2xl border-2 border-dashed transition-colors px-4 py-8 mb-4 ${
              dragOver ? 'border-accent-blue bg-accent-blue/5' : 'border-border-gray bg-surface'
            }`}
          >
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-background border border-border-gray flex items-center justify-center">
              <FolderUp size={22} className="text-primary" strokeWidth={1.6} />
            </div>
            <h1 className="text-xl sm:text-2xl font-light text-primary mb-2 leading-tight">
              Choose a folder to work in
            </h1>
            <p className="text-sm text-tertiary mb-5">
              Pick any project folder. Nalu reads it locally — files only leave your browser when you ask Nalu about them.
            </p>

            <input
              ref={inputRef}
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(e) => onFiles(e.target.files)}
              className="hidden"
            />

            <button
              onClick={handleChooseClick}
              disabled={scanning}
              className="w-full h-12 rounded-xl bg-primary text-surface text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2"
            >
              {scanning ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Scanning…
                </>
              ) : (
                <>
                  <FolderUp size={15} /> Choose folder…
                </>
              )}
            </button>
            <p className="mt-3 text-[11px] text-tertiary">…or drop a folder here</p>
          </div>

          {error && (
            <div className="mt-4 text-left p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500">
              {error}
            </div>
          )}

          <p className="mt-8 text-[11px] text-tertiary">
            We never send your files anywhere unless you ask Nalu about them.
          </p>
        </div>
      </div>
    </div>
  )
}

function TopBar({
  isDark,
  toggleTheme,
  onLogout,
  repo,
  onSwitchRepo,
  showSummary,
  toggleSummary,
  showFiles,
  toggleFiles,
  showLeftRail,
  toggleLeftRail,
  onCommit,
  githubConnected,
}: {
  isDark: boolean
  toggleTheme: (e?: React.MouseEvent) => void
  onLogout: () => void
  repo: RepoSnapshot
  onSwitchRepo: () => void
  showSummary: boolean
  toggleSummary: () => void
  showFiles: boolean
  toggleFiles: () => void
  showLeftRail: boolean
  toggleLeftRail: () => void
  onCommit: () => void
  githubConnected: boolean
}) {
  return (
    <div
      className="h-12 md:h-11 flex items-center justify-between px-2 sm:px-3 border-b border-border-gray bg-surface flex-shrink-0 gap-2"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={toggleLeftRail}
          aria-label={showLeftRail ? 'Hide menu' : 'Show menu'}
          className="md:hidden w-10 h-10 -ml-1 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary flex-shrink-0"
        >
          {showLeftRail ? <X size={18} /> : <Menu size={18} />}
        </button>
        <button
          onClick={onSwitchRepo}
          className="flex items-center gap-1.5 h-9 md:h-7 px-2 rounded-md hover:bg-border-gray/50 text-sm md:text-xs text-primary min-w-0"
          title="Switch folder"
        >
          <FolderGit2 size={14} className="text-tertiary flex-shrink-0" />
          <span className="truncate max-w-[160px] sm:max-w-[200px] font-medium md:font-normal">{repo.name}</span>
          <ChevronDown size={11} className="text-tertiary flex-shrink-0" />
        </button>
      </div>
      <div className="flex items-center gap-1 sm:gap-2 text-xs text-secondary">
        <button
          onClick={onCommit}
          title={githubConnected ? 'Commit to GitHub' : 'Connect GitHub to commit'}
          className="hidden md:flex px-2 sm:px-3 h-7 rounded-md bg-border-gray/50 hover:bg-border-gray text-primary text-xs font-medium items-center gap-1.5 transition-colors"
        >
          {githubConnected ? <GitCommit size={12} /> : <Github size={12} />}
          <span className="hidden md:inline">{githubConnected ? 'Commit' : 'Connect GitHub'}</span>
        </button>
        <span className="hidden lg:inline text-[11px] tabular-nums whitespace-nowrap text-tertiary">
          {repo.fileCount.toLocaleString()} files · {formatSize(repo.totalSize)}
        </span>
        <button
          onClick={toggleSummary}
          aria-label={showSummary ? 'Hide summary' : 'Show summary'}
          title="Summary panel"
          className={`hidden md:flex w-7 h-7 rounded-md hover:bg-border-gray/50 items-center justify-center transition-colors ${showSummary ? 'text-primary bg-border-gray/40' : 'text-secondary'}`}
        >
          <Sliders size={13} />
        </button>
        <button
          onClick={toggleFiles}
          aria-label={showFiles ? 'Hide files' : 'Show files'}
          title="Files panel"
          className={`hidden md:flex w-7 h-7 rounded-md hover:bg-border-gray/50 items-center justify-center transition-colors ${showFiles ? 'text-primary bg-border-gray/40' : 'text-secondary'}`}
        >
          <FolderTree size={13} />
        </button>
        <button
          onClick={(e) => toggleTheme(e)}
          aria-label={isDark ? 'Light mode' : 'Dark mode'}
          className="w-10 h-10 md:w-7 md:h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          onClick={onLogout}
          aria-label="Sign out"
          className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
        >
          <LogOut size={14} />
        </button>
      </div>
    </div>
  )
}

function LeftRail({
  onNewChat,
  repo,
  onSwitchRepo,
  onSearch,
  onSettings,
  onPlugins,
  onAutomations,
  chats,
  activeChatId,
  onSelectChat,
  onDeleteChat,
}: {
  onNewChat: () => void
  repo: RepoSnapshot
  onSwitchRepo: () => void
  onSearch: () => void
  onSettings: () => void
  onPlugins: () => void
  onAutomations: () => void
  chats: ChatSession[]
  activeChatId: string | null
  onSelectChat: (id: string) => void
  onDeleteChat: (id: string) => void
}) {
  const sortedChats = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
  return (
    <aside
      className="w-64 md:w-48 lg:w-56 h-full flex-shrink-0 border-r border-border-gray bg-surface flex flex-col"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      <nav className="p-2 space-y-0.5">
        <RailItem icon={Plus} label="New chat" onClick={onNewChat} />
        <RailItem icon={Search} label="Search" onClick={onSearch} />
        <RailItem icon={Puzzle} label="Plugins" onClick={onPlugins} />
        <RailItem icon={Workflow} label="Automations" onClick={onAutomations} />
      </nav>

      <RailHeader label="Project" />
      <div className="px-2">
        <button
          onClick={onSwitchRepo}
          title="Switch folder"
          className="w-full flex items-center gap-2 px-2 h-8 rounded-md text-xs hover:bg-border-gray/40 text-primary"
        >
          <Box size={13} className="text-secondary flex-shrink-0" />
          <span className="truncate">{repo.name}</span>
        </button>
        {repo.branch && (
          <p className="px-2 pt-1 pb-2 text-[11px] text-tertiary truncate">on {repo.branch}</p>
        )}
      </div>

      <RailHeader label="Chats" actionOnClick={onNewChat} />
      <div className="flex-1 overflow-y-auto px-2 scrollbar-hide space-y-0.5">
        {sortedChats.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-tertiary">No chats yet</p>
        ) : (
          sortedChats.map((chat) => {
            const isActive = chat.id === activeChatId
            return (
              <div
                key={chat.id}
                className={`group flex items-center gap-1 rounded-md transition-colors ${
                  isActive
                    ? 'bg-border-gray/40 text-primary'
                    : 'text-secondary hover:bg-border-gray/30 hover:text-primary'
                }`}
              >
                <button
                  onClick={() => onSelectChat(chat.id)}
                  title={chat.title}
                  className="flex-1 min-w-0 flex items-center gap-2 px-2 h-8 text-left"
                >
                  <MessageSquare size={12} className="flex-shrink-0 opacity-70" />
                  <span className="truncate text-xs">{chat.title}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteChat(chat.id)
                  }}
                  aria-label="Delete chat"
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 w-6 h-6 mr-1 rounded flex items-center justify-center text-tertiary hover:text-red-400 transition-opacity"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )
          })
        )}
      </div>

      <div className="p-2 border-t border-border-gray">
        <RailItem icon={Settings} label="Settings" onClick={onSettings} />
      </div>
    </aside>
  )
}

function RailHeader({ label, actionOnClick }: { label: string; actionOnClick?: () => void }) {
  return (
    <div className="px-4 pt-4 pb-1 flex items-center justify-between">
      <span className="text-[10px] uppercase tracking-wider text-tertiary font-medium">{label}</span>
      {actionOnClick && (
        <button
          onClick={actionOnClick}
          aria-label={`New ${label.toLowerCase()}`}
          className="w-5 h-5 rounded hover:bg-border-gray/40 flex items-center justify-center text-tertiary hover:text-primary transition-colors"
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  )
}

function RailItem({ icon: Icon, label, onClick }: { icon: typeof Plus; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2 h-10 md:h-8 rounded-md text-sm md:text-xs text-secondary hover:bg-border-gray/40 hover:text-primary transition-colors"
    >
      <Icon size={14} strokeWidth={1.6} />
      {label}
    </button>
  )
}

function CenterPane({
  prompt,
  setPrompt,
  messages,
  streaming,
  onSend,
  repo,
  composerPinned,
  onToggleComposerPinned,
  openFilePath,
  openFileContent,
  openFileLoading,
  openFileError,
  savedAt,
  saveStatus,
  saveErrorMsg,
  onChangeFileContent,
  onCloseFile,
  onFlushSave,
  fileFullscreen,
  onToggleFileFullscreen,
}: {
  prompt: string
  setPrompt: (v: string) => void
  messages: ChatMessage[]
  streaming: boolean
  onSend: () => void
  repo: RepoSnapshot
  composerPinned: boolean
  onToggleComposerPinned: () => void
  openFilePath: string | null
  openFileContent: string | null
  openFileLoading: boolean
  openFileError: string | null
  savedAt: number | null
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  saveErrorMsg: string | null
  onChangeFileContent: (content: string) => void
  onCloseFile: () => void
  onFlushSave: () => void
  fileFullscreen: boolean
  onToggleFileFullscreen: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  const isEmpty = messages.length === 0
  const fileIsOpen = openFilePath !== null
  const useBottomLayout = !isEmpty || composerPinned || fileIsOpen

  return (
    <main className="flex-1 min-w-0 flex flex-col relative">
      {!useBottomLayout ? (
        <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-8 py-8 sm:py-12 overflow-y-auto">
          <div className="w-full max-w-2xl">
            <h1 className="text-xl sm:text-[28px] font-light text-primary text-center mb-6 sm:mb-8 leading-tight">
              What should we build in {repo.name}?
            </h1>
            <PromptComposer
              prompt={prompt}
              setPrompt={setPrompt}
              onSend={onSend}
              streaming={streaming}
              repo={repo}
              composerPinned={composerPinned}
              onToggleComposerPinned={onToggleComposerPinned}
            />
            <ul className="mt-6 space-y-1.5">
              {SUGGESTIONS.map(({ icon: Icon, label }) => (
                <li key={label}>
                  <button
                    onClick={() => setPrompt(label)}
                    className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-xs text-secondary hover:bg-surface hover:text-primary transition-colors text-left"
                  >
                    <Icon size={14} strokeWidth={1.6} className="text-tertiary flex-shrink-0 mt-0.5" />
                    <span className="md:truncate">{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <>
          {fileIsOpen ? (
            <FileEditorPane
              path={openFilePath!}
              file={repo.files.get(openFilePath!) ?? null}
              content={openFileContent}
              loading={openFileLoading}
              error={openFileError}
              savedAt={savedAt}
              saveStatus={saveStatus}
              saveErrorMsg={saveErrorMsg}
              onChange={onChangeFileContent}
              onClose={onCloseFile}
              onFlushSave={onFlushSave}
              fullscreen={fileFullscreen}
              onToggleFullscreen={onToggleFileFullscreen}
            />
          ) : (
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 sm:py-10 scrollbar-hide">
              <div className="max-w-2xl mx-auto">
                {isEmpty ? (
                  <div className="text-center pt-10 sm:pt-16">
                    <h1 className="text-xl sm:text-[28px] font-light text-primary leading-tight">
                      What should we build in {repo.name}?
                    </h1>
                    <ul className="mt-6 space-y-1.5 text-left">
                      {SUGGESTIONS.map(({ icon: Icon, label }) => (
                        <li key={label}>
                          <button
                            onClick={() => setPrompt(label)}
                            className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-xs text-secondary hover:bg-surface hover:text-primary transition-colors text-left"
                          >
                            <Icon
                              size={14}
                              strokeWidth={1.6}
                              className="text-tertiary flex-shrink-0 mt-0.5"
                            />
                            <span className="md:truncate">{label}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {messages.map((m, i) => (
                      <ChatBubble
                        key={i}
                        message={m}
                        streaming={
                          streaming && i === messages.length - 1 && m.role === 'assistant'
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="px-4 sm:px-8 pb-4 sm:pb-6 pt-2 border-t border-border-gray bg-background">
            <div className="max-w-2xl mx-auto">
              <PromptComposer
                prompt={prompt}
                setPrompt={setPrompt}
                onSend={onSend}
                streaming={streaming}
                repo={repo}
                composerPinned={composerPinned}
                onToggleComposerPinned={onToggleComposerPinned}
              />
            </div>
          </div>
        </>
      )}
    </main>
  )
}

function ChatBubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const isUser = message.role === 'user'
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-surface border border-border-gray flex items-center justify-center text-tertiary">
        {isUser ? <User size={13} strokeWidth={1.6} /> : <Sparkles size={13} strokeWidth={1.6} />}
      </div>
      <div className="flex-1 min-w-0 pt-1">
        <div className="text-[11px] uppercase tracking-wider text-tertiary mb-1 font-medium">
          {isUser ? 'You' : 'Nalu'}
        </div>
        <div className="text-sm text-primary whitespace-pre-wrap leading-relaxed font-light">
          {message.content}
          {streaming && <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary/60 align-middle animate-pulse" />}
        </div>
      </div>
    </div>
  )
}

function PromptComposer({
  prompt,
  setPrompt,
  onSend,
  streaming,
  repo,
  composerPinned,
  onToggleComposerPinned,
}: {
  prompt: string
  setPrompt: (v: string) => void
  onSend: () => void
  streaming: boolean
  repo: RepoSnapshot
  composerPinned: boolean
  onToggleComposerPinned: () => void
}) {
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }
  const ToggleIcon = composerPinned ? AlignCenter : PanelBottom
  const toggleLabel = composerPinned ? 'Center composer' : 'Pin composer to bottom'
  return (
    <div className="rounded-2xl bg-surface border border-border-gray p-3 shadow-sm">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKey}
        placeholder={`Ask Nalu about ${repo.name}…`}
        rows={2}
        disabled={streaming}
        className="w-full resize-none bg-transparent text-sm text-primary placeholder-tertiary focus:outline-none px-2 py-1 disabled:opacity-60"
      />
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border-gray gap-2">
        <div className="hidden md:flex items-center gap-1 text-[11px] text-secondary min-w-0 overflow-x-auto scrollbar-hide">
          <ComposerChip icon={Plus} />
          <ComposerChip icon={Lock} label="Default" hasChevron />
          <ComposerChip label="haiku-4-5" hasChevron />
          <ComposerChip icon={Mic} />
        </div>
        <div className="flex md:hidden items-center gap-1 text-[11px] text-tertiary min-w-0">
          <Box size={11} className="flex-shrink-0" />
          <span className="truncate">{repo.branch ? `${repo.name} · ${repo.branch}` : repo.name}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={onToggleComposerPinned}
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-pressed={composerPinned}
            className={`w-8 h-8 md:w-7 md:h-7 rounded-md border flex items-center justify-center transition-colors ${
              composerPinned
                ? 'bg-accent-blue/15 border-accent-blue text-accent-blue'
                : 'bg-transparent border-border-gray text-tertiary hover:text-primary hover:border-primary/40'
            }`}
          >
            <ToggleIcon size={14} strokeWidth={1.6} />
          </button>
          <button
            onClick={onSend}
            disabled={streaming || !prompt.trim()}
            aria-label="Send"
            className="w-9 h-9 md:w-8 md:h-8 rounded-full bg-primary text-surface hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-opacity"
          >
            {streaming ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.2} />}
          </button>
        </div>
      </div>
      <div className="hidden md:flex items-center gap-1 mt-2 overflow-x-auto scrollbar-hide">
        <ComposerChip icon={Box} label={repo.name} hasChevron />
        <ComposerChip icon={CodeIcon} label="Local" hasChevron />
        {repo.branch && <ComposerChip icon={GitBranch} label={repo.branch} hasChevron />}
      </div>
    </div>
  )
}

function ComposerChip({
  icon: Icon,
  label,
  hasChevron,
}: {
  icon?: typeof Plus
  label?: string
  hasChevron?: boolean
}) {
  return (
    <button className="h-7 px-2 rounded-md hover:bg-border-gray/50 flex items-center gap-1.5 text-secondary hover:text-primary transition-colors flex-shrink-0">
      {Icon && <Icon size={12} strokeWidth={1.6} />}
      {label && <span className="text-[11px] whitespace-nowrap">{label}</span>}
      {hasChevron && <ChevronDown size={10} className="text-tertiary" />}
    </button>
  )
}

function PaneHeader({
  title,
  count,
  onClose,
}: {
  title: string
  count?: string | number
  onClose: () => void
}) {
  return (
    <div className="h-10 flex items-center justify-between px-3 border-b border-border-gray flex-shrink-0">
      <span className="text-xs font-medium text-primary flex items-center gap-1.5">
        <ChevronDown size={12} className="text-tertiary" />
        {title}
        {count !== undefined && <span className="text-tertiary font-normal">{count}</span>}
      </span>
      <button
        onClick={onClose}
        aria-label={`Collapse ${title}`}
        title={`Collapse ${title}`}
        className="h-7 w-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary hover:text-primary transition-colors"
      >
        <PanelRightClose size={14} strokeWidth={1.6} />
      </button>
    </div>
  )
}

function CollapsedEdgeRail({
  showSummary,
  showFiles,
  onShowSummary,
  onShowFiles,
}: {
  showSummary: boolean
  showFiles: boolean
  onShowSummary: () => void
  onShowFiles: () => void
}) {
  if (showSummary && showFiles) return null
  return (
    <div className="hidden md:flex flex-col items-center gap-1 border-l border-border-gray bg-surface w-9 flex-shrink-0 py-2">
      {!showSummary && (
        <button
          onClick={onShowSummary}
          aria-label="Show summary"
          title="Show summary"
          className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary hover:text-primary transition-colors"
        >
          <Sliders size={14} strokeWidth={1.6} />
        </button>
      )}
      {!showFiles && (
        <button
          onClick={onShowFiles}
          aria-label="Show files"
          title="Show files"
          className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary hover:text-primary transition-colors"
        >
          <FolderTree size={14} strokeWidth={1.6} />
        </button>
      )}
      <button
        onClick={() => {
          if (!showSummary) onShowSummary()
          if (!showFiles) onShowFiles()
        }}
        aria-label="Show all panels"
        title="Show all panels"
        className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-tertiary hover:text-primary transition-colors"
      >
        <PanelRightOpen size={14} strokeWidth={1.6} />
      </button>
    </div>
  )
}

function SummaryPane({
  repo,
  streaming,
  hasMessages,
  githubConnected,
  onClose,
}: {
  repo: RepoSnapshot
  streaming: boolean
  hasMessages: boolean
  githubConnected: boolean
  onClose: () => void
}) {
  return (
    <aside className="w-full md:w-56 lg:w-72 h-full flex-shrink-0 border-l border-border-gray bg-background flex flex-col">
      <PaneHeader title="Summary" onClose={onClose} />
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs scrollbar-hide">
        <SummarySection icon={Gauge} title="Progress">
          <p className="text-[11px] text-tertiary leading-relaxed">
            {streaming ? 'Streaming response…' : hasMessages ? 'Idle' : 'Progress displayed for longer responses'}
          </p>
        </SummarySection>

        <SummarySection icon={GitBranch} title="Folder details">
          <SummaryRow label="Folder" value={repo.name} />
          {repo.branch && <SummaryRow label="Branch" value={repo.branch} />}
          <SummaryRow label="Files" value={repo.fileCount.toLocaleString()} />
          <SummaryRow label="Size" value={formatSize(repo.totalSize)} />
        </SummarySection>

        <SummarySection icon={Github} title="GitHub">
          {repo.origin ? (
            <SummaryRow label="Remote" value={`${repo.origin.owner}/${repo.origin.repo}`} />
          ) : (
            <p className="text-[11px] text-tertiary">No origin remote detected</p>
          )}
          <SummaryRow label="Auth" value={githubConnected ? 'Connected' : 'Not connected'} />
        </SummarySection>

        <SummarySection icon={Database} title="Sources">
          <p className="text-[11px] text-tertiary">Track sources used</p>
        </SummarySection>
      </div>
    </aside>
  )
}

function SummarySection({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Gauge
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={12} className="text-tertiary" strokeWidth={1.6} />
        <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium">{title}</span>
      </div>
      <div className="space-y-1 pl-4">{children}</div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="text-[11px] flex justify-between gap-3">
      <span className="text-secondary">{label}</span>
      {value && <span className="text-primary text-right truncate max-w-[160px]">{value}</span>}
    </div>
  )
}

function FilesPane({
  tree,
  onClose,
  onOpenFile,
}: {
  tree: FileNode[]
  onClose: () => void
  onOpenFile: (path: string) => void
}) {
  const [filter, setFilter] = useState('')
  const total = useMemo(() => treeStats(tree).files, [tree])

  const filteredTree = useMemo(() => {
    if (!filter.trim()) return tree
    const q = filter.toLowerCase()
    const filterNode = (node: FileNode): FileNode | null => {
      if (node.type === 'file') return node.name.toLowerCase().includes(q) ? node : null
      const kids = node.children.map(filterNode).filter(Boolean) as FileNode[]
      if (kids.length === 0 && !node.name.toLowerCase().includes(q)) return null
      return { ...node, children: kids }
    }
    return tree.map(filterNode).filter(Boolean) as FileNode[]
  }, [tree, filter])

  return (
    <aside className="w-full md:w-64 lg:w-80 h-full flex-shrink-0 border-l border-border-gray bg-surface flex flex-col">
      <PaneHeader title="Files" count={total} onClose={onClose} />

      <div className="px-3 py-2 border-b border-border-gray flex-shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-tertiary" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="w-full h-7 pl-7 pr-2 rounded-md bg-background border border-border-gray text-[11px] text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1 scrollbar-hide">
        {filteredTree.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-tertiary">No files</p>
        ) : (
          filteredTree.map((node) => (
            <FileTreeNode key={node.path} node={node} depth={0} onOpenFile={onOpenFile} />
          ))
        )}
      </div>
    </aside>
  )
}

function FileTreeNode({
  node,
  depth,
  onOpenFile,
}: {
  node: FileNode
  depth: number
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 1)
  const pad = { paddingLeft: 8 + depth * 12 }

  if (node.type === 'file') {
    const isJson = node.name.endsWith('.json') || node.name.endsWith('.jsonl')
    return (
      <button
        style={pad}
        onClick={() => onOpenFile(node.path)}
        className="w-full flex items-center gap-1.5 h-6 pr-2 hover:bg-border-gray/40 text-[11px] text-secondary hover:text-primary transition-colors text-left"
      >
        {isJson ? (
          <FileJson size={11} className="text-tertiary flex-shrink-0" strokeWidth={1.6} />
        ) : (
          <FileText size={11} className="text-tertiary flex-shrink-0" strokeWidth={1.6} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  return (
    <>
      <button
        style={pad}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 h-6 pr-2 hover:bg-border-gray/40 text-[11px] text-secondary hover:text-primary transition-colors text-left"
      >
        {open ? (
          <ChevronDown size={11} className="text-tertiary flex-shrink-0" />
        ) : (
          <ChevronRight size={11} className="text-tertiary flex-shrink-0" />
        )}
        {open ? (
          <FolderOpen size={11} className="text-tertiary flex-shrink-0" strokeWidth={1.6} />
        ) : (
          <Folder size={11} className="text-tertiary flex-shrink-0" strokeWidth={1.6} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {open &&
        node.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  )
}

function SearchBar({
  value,
  onChange,
  onClose,
  resultCount,
  totalCount,
}: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
  resultCount: number
  totalCount: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  return (
    <div className="h-12 sm:h-10 flex-shrink-0 flex items-center gap-2 px-3 border-b border-border-gray bg-surface">
      <Search size={13} className="text-tertiary flex-shrink-0" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
        placeholder="Search this conversation…"
        className="flex-1 bg-transparent text-sm text-primary placeholder-tertiary focus:outline-none min-w-0"
      />
      {value.trim() && (
        <span className="text-[11px] text-tertiary tabular-nums whitespace-nowrap">
          {resultCount} / {totalCount}
        </span>
      )}
      <button
        onClick={onClose}
        aria-label="Close search"
        className="w-9 h-9 sm:w-7 sm:h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
      >
        <X size={16} />
      </button>
    </div>
  )
}

function ModalShell({
  title,
  icon: Icon,
  onClose,
  children,
}: {
  title: string
  icon: typeof Settings
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-2xl sm:rounded-2xl bg-surface border-t sm:border border-border-gray shadow-2xl overflow-hidden flex flex-col max-h-[92dvh] sm:max-h-[90vh]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div
          className="h-12 sm:h-11 flex items-center justify-between px-4 border-b border-border-gray flex-shrink-0"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          <div className="flex items-center gap-2 text-sm text-primary">
            <Icon size={14} className="text-tertiary" strokeWidth={1.6} />
            <span className="font-medium">{title}</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-9 h-9 sm:w-7 sm:h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  )
}

function SettingsModal({
  isDark,
  toggleTheme,
  githubToken,
  onSaveToken,
  onClose,
  onLogout,
}: {
  isDark: boolean
  toggleTheme: (e?: React.MouseEvent) => void
  githubToken: string | null
  onSaveToken: (token: string | null) => void
  onClose: () => void
  onLogout: () => void
}) {
  const [tokenInput, setTokenInput] = useState(githubToken ?? '')
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifiedAs, setVerifiedAs] = useState<string | null>(null)

  useEffect(() => {
    if (!githubToken) {
      setVerifiedAs(null)
      return
    }
    let cancelled = false
    fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.login) setVerifiedAs(data.login)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [githubToken])

  const verifyAndSave = async () => {
    const token = tokenInput.trim()
    if (!token) {
      onSaveToken(null)
      setVerifiedAs(null)
      setVerifyError(null)
      return
    }
    setVerifying(true)
    setVerifyError(null)
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      if (!r.ok) {
        setVerifyError(`GitHub rejected the token (${r.status}). Check scopes: needs at least \`repo\`.`)
        return
      }
      const data = await r.json()
      onSaveToken(token)
      setVerifiedAs(data.login)
    } catch (err) {
      setVerifyError((err as Error).message)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <ModalShell title="Settings" icon={Settings} onClose={onClose}>
      <div className="p-4 sm:p-5 space-y-6">
        <section>
          <h3 className="text-[11px] uppercase tracking-wider text-tertiary font-medium mb-2">Appearance</h3>
          <button
            onClick={(e) => toggleTheme(e)}
            className="w-full flex items-center justify-between px-3 h-10 rounded-lg bg-background border border-border-gray hover:bg-border-gray/30 transition-colors text-sm text-primary"
          >
            <span className="flex items-center gap-2">
              {isDark ? <Moon size={14} className="text-tertiary" /> : <Sun size={14} className="text-tertiary" />}
              {isDark ? 'Dark mode' : 'Light mode'}
            </span>
            <span className="text-[11px] text-tertiary">click to toggle</span>
          </button>
        </section>

        <section>
          <h3 className="text-[11px] uppercase tracking-wider text-tertiary font-medium mb-2 flex items-center gap-1.5">
            <Github size={11} /> GitHub
          </h3>
          <p className="text-[11px] text-tertiary mb-2 leading-relaxed">
            Paste a Personal Access Token to enable Commit. Create one at{' '}
            <a
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noreferrer"
              className="text-accent-blue hover:underline"
            >
              github.com/settings/tokens
            </a>{' '}
            with <span className="text-primary">Contents: Read &amp; write</span> permission for the repo you want to commit to.
          </p>
          <div className="relative">
            <KeyRound size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary" />
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="ghp_… or github_pat_…"
              className="w-full h-10 pl-8 pr-3 rounded-lg bg-background border border-border-gray text-sm text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue"
            />
          </div>
          {verifiedAs && (
            <p className="mt-2 text-[11px] text-green-500 flex items-center gap-1">
              <Check size={11} /> Connected as {verifiedAs}
            </p>
          )}
          {verifyError && (
            <p className="mt-2 text-[11px] text-red-500 flex items-start gap-1">
              <AlertCircle size={11} className="mt-0.5 flex-shrink-0" /> {verifyError}
            </p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              onClick={verifyAndSave}
              disabled={verifying || tokenInput.trim() === (githubToken ?? '')}
              className="flex-1 h-9 rounded-lg bg-primary text-surface text-xs font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 transition-opacity"
            >
              {verifying ? <Loader2 size={12} className="animate-spin" /> : null}
              {githubToken ? 'Update token' : 'Save & verify'}
            </button>
            {githubToken && (
              <button
                onClick={() => { setTokenInput(''); onSaveToken(null); setVerifiedAs(null); setVerifyError(null) }}
                className="h-9 px-3 rounded-lg border border-border-gray text-xs text-secondary hover:text-primary hover:bg-border-gray/30 transition-colors"
              >
                Disconnect
              </button>
            )}
          </div>
        </section>

        <section>
          <h3 className="text-[11px] uppercase tracking-wider text-tertiary font-medium mb-2">Account</h3>
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-between px-3 h-10 rounded-lg bg-background border border-border-gray hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-500 transition-colors text-sm text-secondary"
          >
            <span className="flex items-center gap-2">
              <LogOut size={14} />
              Sign out
            </span>
          </button>
        </section>
      </div>
    </ModalShell>
  )
}

interface CommitChange {
  path: string
  file: File
  op: 'add' | 'modify'
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

async function ghFetch(token: string, path: string, init?: RequestInit) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers ?? {}),
    },
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`GitHub ${r.status}: ${text.slice(0, 200) || r.statusText}`)
  }
  return r.json()
}

function CommitModal({
  repo,
  token,
  onClose,
}: {
  repo: RepoSnapshot
  token: string
  onClose: () => void
}) {
  const [message, setMessage] = useState('')
  const [branch, setBranch] = useState(repo.branch ?? 'main')
  const [phase, setPhase] = useState<'idle' | 'scanning' | 'review' | 'committing' | 'done' | 'error'>('idle')
  const [changes, setChanges] = useState<CommitChange[]>([])
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [commitUrl, setCommitUrl] = useState<string | null>(null)

  const origin = repo.origin

  const scan = useCallback(async () => {
    if (!origin) return
    setPhase('scanning')
    setError(null)
    try {
      const ref = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/ref/heads/${branch}`)
      const commit = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/commits/${ref.object.sha}`)
      const tree = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/trees/${commit.tree.sha}?recursive=1`)
      const remote = new Map<string, string>()
      for (const node of tree.tree as Array<{ path: string; type: string; sha: string }>) {
        if (node.type === 'blob') remote.set(node.path, node.sha)
      }
      const localShas = await Promise.all(
        Array.from(repo.files.entries()).map(async ([path, file]) => {
          const sha = await blobSha(file)
          return { path, file, sha }
        }),
      )
      const result: CommitChange[] = []
      for (const { path, file, sha } of localShas) {
        const remoteSha = remote.get(path)
        if (!remoteSha) result.push({ path, file, op: 'add' })
        else if (remoteSha !== sha) result.push({ path, file, op: 'modify' })
      }
      result.sort((a, b) => a.path.localeCompare(b.path))
      setChanges(result)
      setPhase('review')
    } catch (err) {
      setError((err as Error).message)
      setPhase('error')
    }
  }, [origin, token, branch, repo.files])

  const commit = useCallback(async () => {
    if (!origin || changes.length === 0 || !message.trim()) return
    setPhase('committing')
    setError(null)
    setProgress({ done: 0, total: changes.length + 3 })
    try {
      const ref = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/ref/heads/${branch}`)
      const parentSha = ref.object.sha
      const parentCommit = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/commits/${parentSha}`)

      let done = 1
      setProgress({ done, total: changes.length + 3 })

      const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = []
      for (const change of changes) {
        const content = await fileToBase64(change.file)
        const blob = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content, encoding: 'base64' }),
        })
        treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
        done += 1
        setProgress({ done, total: changes.length + 3 })
      }

      const newTree = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeEntries }),
      })
      done += 1
      setProgress({ done, total: changes.length + 3 })

      const newCommit = await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: message.trim(), tree: newTree.sha, parents: [parentSha] }),
      })
      done += 1
      setProgress({ done, total: changes.length + 3 })

      await ghFetch(token, `/repos/${origin.owner}/${origin.repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha }),
      })

      setCommitUrl(`https://github.com/${origin.owner}/${origin.repo}/commit/${newCommit.sha}`)
      setPhase('done')
    } catch (err) {
      setError((err as Error).message)
      setPhase('error')
    }
  }, [origin, token, branch, changes, message])

  if (!origin) {
    return (
      <ModalShell title="Commit" icon={GitCommit} onClose={onClose}>
        <div className="p-5">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span>
              No <code>origin</code> remote found in <code>.git/config</code>. Open a folder that has a GitHub origin remote configured.
            </span>
          </div>
        </div>
      </ModalShell>
    )
  }

  return (
    <ModalShell title="Commit to GitHub" icon={GitCommit} onClose={onClose}>
      <div className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px] text-tertiary">
          <span className="flex items-center gap-1.5 min-w-0">
            <Github size={11} className="flex-shrink-0" />
            <span className="text-primary font-medium truncate">{origin.owner}/{origin.repo}</span>
          </span>
          <span className="hidden sm:inline">·</span>
          <label className="flex items-center gap-1.5">
            <GitBranch size={11} className="flex-shrink-0" />
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              aria-label="Branch"
              className="bg-background border border-border-gray rounded-md focus:outline-none focus:border-accent-blue text-primary text-xs px-2 h-8 sm:h-7 w-32"
            />
          </label>
        </div>

        <div>
          <label className="text-[11px] uppercase tracking-wider text-tertiary font-medium block mb-1.5">
            Commit message
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Describe what you changed…"
            className="w-full resize-none rounded-lg bg-background border border-border-gray text-sm text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue px-3 py-2"
          />
        </div>

        {phase === 'idle' && (
          <button
            onClick={scan}
            className="w-full h-10 rounded-lg bg-primary text-surface text-sm font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
          >
            <Search size={13} /> Scan for changes
          </button>
        )}

        {phase === 'scanning' && (
          <div className="flex items-center justify-center gap-2 text-xs text-tertiary py-4">
            <Loader2 size={13} className="animate-spin" /> Comparing snapshot to {origin.owner}/{origin.repo}@{branch}…
          </div>
        )}

        {phase === 'review' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium">
                Changes ({changes.length})
              </span>
              <button
                onClick={scan}
                className="text-[11px] text-secondary hover:text-primary"
              >
                Rescan
              </button>
            </div>
            {changes.length === 0 ? (
              <p className="text-[11px] text-tertiary py-2">No changes vs {branch}.</p>
            ) : (
              <ul className="max-h-48 overflow-y-auto rounded-lg border border-border-gray divide-y divide-border-gray">
                {changes.map((c) => (
                  <li key={c.path} className="px-3 py-1.5 flex items-center gap-2 text-[11px]">
                    <span
                      className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-medium flex-shrink-0 ${
                        c.op === 'add' ? 'bg-green-500/15 text-green-500' : 'bg-amber-500/15 text-amber-500'
                      }`}
                    >
                      {c.op === 'add' ? 'A' : 'M'}
                    </span>
                    <span className="text-primary truncate">{c.path}</span>
                    <span className="text-tertiary tabular-nums ml-auto">{formatSize(c.file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={commit}
              disabled={changes.length === 0 || !message.trim()}
              className="mt-3 w-full h-10 rounded-lg bg-primary text-surface text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center justify-center gap-2"
            >
              <GitCommit size={13} /> Commit {changes.length} file{changes.length === 1 ? '' : 's'}
            </button>
          </div>
        )}

        {phase === 'committing' && progress && (
          <div className="py-4 space-y-2">
            <div className="flex items-center gap-2 text-xs text-tertiary">
              <Loader2 size={13} className="animate-spin" />
              <span>Pushing to GitHub… ({progress.done}/{progress.total})</span>
            </div>
            <div className="h-1 rounded bg-border-gray overflow-hidden">
              <div
                className="h-full bg-accent-blue transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {phase === 'done' && commitUrl && (
          <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-xs text-green-600 dark:text-green-400 flex items-start gap-2">
            <Check size={13} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium mb-1">Commit pushed</p>
              <a href={commitUrl} target="_blank" rel="noreferrer" className="underline break-all">
                {commitUrl}
              </a>
            </div>
          </div>
        )}

        {phase === 'error' && error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500 flex items-start gap-2">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1 min-w-0 break-all">{error}</span>
          </div>
        )}
      </div>
    </ModalShell>
  )
}

async function blobSha(file: File): Promise<string> {
  const header = `blob ${file.size}\0`
  const headerBytes = new TextEncoder().encode(header)
  const fileBuf = new Uint8Array(await file.arrayBuffer())
  const combined = new Uint8Array(headerBytes.length + fileBuf.length)
  combined.set(headerBytes, 0)
  combined.set(fileBuf, headerBytes.length)
  const digest = await crypto.subtle.digest('SHA-1', combined)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function PluginsModal({
  plugins,
  onChange,
  githubConnected,
  hasOrigin,
  onClose,
  onOpenSettings,
}: {
  plugins: Record<string, boolean>
  onChange: (next: Record<string, boolean>) => void
  githubConnected: boolean
  hasOrigin: boolean
  onClose: () => void
  onOpenSettings: () => void
}) {
  const [query, setQuery] = useState('')

  const toggle = (id: string) => {
    onChange({ ...plugins, [id]: !plugins[id] })
  }

  const filtered = PLUGIN_DEFS.filter((def) => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return def.name.toLowerCase().includes(q) || def.description.toLowerCase().includes(q)
  })
  const featured = filtered.filter((d) => d.featured)
  const more = filtered.filter((d) => !d.featured)

  const warnFor = (def: PluginDef): string | null => {
    if (def.requires === 'github-pat' && !githubConnected) {
      return 'Connect GitHub'
    }
    if (def.id === 'github-status' && !hasOrigin) {
      return 'No origin remote'
    }
    return null
  }

  const renderCard = (def: PluginDef) => {
    const enabled = !!plugins[def.id]
    const warn = warnFor(def)
    const Icon = def.icon
    return (
      <div
        key={def.id}
        className="rounded-xl border border-border-gray bg-background hover:bg-border-gray/20 transition-colors p-3 flex items-center gap-3"
      >
        <div
          className={`w-10 h-10 rounded-lg ${def.iconBg} flex items-center justify-center flex-shrink-0`}
        >
          <Icon size={18} className={def.iconColor} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-primary truncate">{def.name}</div>
          <p className="text-[11px] text-tertiary truncate">{def.description}</p>
          {warn && (
            <button
              onClick={onOpenSettings}
              className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-amber-500 hover:underline"
            >
              <AlertCircle size={10} /> {warn}
            </button>
          )}
        </div>
        <button
          onClick={() => toggle(def.id)}
          aria-label={enabled ? `Disable ${def.name}` : `Enable ${def.name}`}
          className={`w-7 h-7 rounded-md border flex items-center justify-center transition-colors flex-shrink-0 ${
            enabled
              ? 'bg-accent-blue/15 border-accent-blue text-accent-blue'
              : 'bg-transparent border-border-gray text-tertiary hover:text-primary hover:border-primary/40'
          }`}
        >
          {enabled ? <Check size={14} /> : <Plus size={14} />}
        </button>
      </div>
    )
  }

  return (
    <ModalShell title="Plugins" icon={Puzzle} onClose={onClose}>
      <div className="p-4 sm:p-5 space-y-5">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border-gray text-sm text-primary placeholder:text-tertiary focus:border-accent-blue focus:outline-none"
          />
        </div>

        {featured.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-2">
              Featured
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{featured.map(renderCard)}</div>
          </section>
        )}

        {more.length > 0 && (
          <section>
            <h3 className="text-[11px] font-semibold text-tertiary uppercase tracking-wider mb-2">
              All plugins
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{more.map(renderCard)}</div>
          </section>
        )}

        {filtered.length === 0 && (
          <div className="text-center py-10 text-sm text-tertiary">
            No plugins match &ldquo;{query}&rdquo;
          </div>
        )}
      </div>
    </ModalShell>
  )
}

function AutomationsModal({
  items,
  onChange,
  onRun,
  onClose,
}: {
  items: AutomationItem[]
  onChange: (next: AutomationItem[]) => void
  onRun: (prompt: string) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<AutomationItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')

  const startCreate = () => {
    setCreating(true)
    setEditing(null)
    setDraftName('')
    setDraftPrompt('')
  }

  const startEdit = (item: AutomationItem) => {
    setCreating(false)
    setEditing(item)
    setDraftName(item.name)
    setDraftPrompt(item.prompt)
  }

  const cancel = () => {
    setCreating(false)
    setEditing(null)
    setDraftName('')
    setDraftPrompt('')
  }

  const save = () => {
    const name = draftName.trim()
    const prompt = draftPrompt.trim()
    if (!name || !prompt) return
    if (editing) {
      onChange(items.map((it) => (it.id === editing.id ? { ...it, name, prompt } : it)))
    } else {
      const id = `automation-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      onChange([...items, { id, name, prompt, createdAt: Date.now() }])
    }
    cancel()
  }

  const remove = (id: string) => {
    onChange(items.filter((it) => it.id !== id))
  }

  const showForm = creating || editing !== null

  return (
    <ModalShell title="Automations" icon={Workflow} onClose={onClose}>
      <div className="p-4 sm:p-5 space-y-3">
        {!showForm && (
          <>
            <p className="text-[11px] text-tertiary leading-relaxed">
              Saved prompt templates. Click Run to load one into the composer. All saved locally.
            </p>
            {items.length === 0 ? (
              <p className="text-[11px] text-tertiary py-4 text-center">No automations yet.</p>
            ) : (
              <ul className="space-y-2">
                {items.map((it) => (
                  <li
                    key={it.id}
                    className="rounded-lg border border-border-gray bg-background p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-primary truncate">{it.name}</div>
                        <p className="text-[11px] text-tertiary leading-relaxed mt-0.5 line-clamp-2">
                          {it.prompt}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
                        <button
                          onClick={() => onRun(it.prompt)}
                          aria-label={`Run ${it.name}`}
                          title="Run"
                          className="w-9 h-9 sm:w-7 sm:h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary hover:text-primary"
                        >
                          <Play size={14} className="sm:!w-3 sm:!h-3" />
                        </button>
                        <button
                          onClick={() => startEdit(it)}
                          aria-label={`Edit ${it.name}`}
                          title="Edit"
                          className="w-9 h-9 sm:w-7 sm:h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary hover:text-primary"
                        >
                          <Pencil size={14} className="sm:!w-3 sm:!h-3" />
                        </button>
                        <button
                          onClick={() => remove(it.id)}
                          aria-label={`Delete ${it.name}`}
                          title="Delete"
                          className="w-9 h-9 sm:w-7 sm:h-7 rounded-md hover:bg-red-500/10 flex items-center justify-center text-secondary hover:text-red-500"
                        >
                          <Trash2 size={14} className="sm:!w-3 sm:!h-3" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={startCreate}
              className="w-full h-10 rounded-lg border border-dashed border-border-gray hover:border-accent-blue hover:bg-accent-blue/5 text-sm text-secondary hover:text-primary transition-colors flex items-center justify-center gap-2"
            >
              <Plus size={13} /> New automation
            </button>
          </>
        )}

        {showForm && (
          <div className="space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-tertiary font-medium block mb-1.5">
                Name
              </label>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="e.g., Summarize today's commits"
                className="w-full h-10 rounded-lg bg-background border border-border-gray text-sm text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue px-3"
              />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-tertiary font-medium block mb-1.5">
                Prompt
              </label>
              <textarea
                value={draftPrompt}
                onChange={(e) => setDraftPrompt(e.target.value)}
                rows={5}
                placeholder="What should Nalu do when you run this?"
                className="w-full resize-none rounded-lg bg-background border border-border-gray text-sm text-primary placeholder-tertiary focus:outline-none focus:border-accent-blue px-3 py-2"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={!draftName.trim() || !draftPrompt.trim()}
                className="flex-1 h-10 rounded-lg bg-primary text-surface text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {editing ? 'Save changes' : 'Create automation'}
              </button>
              <button
                onClick={cancel}
                className="h-10 px-4 rounded-lg border border-border-gray text-sm text-secondary hover:text-primary hover:bg-border-gray/30 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  )
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'mdx', 'markdown', 'rst',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'json', 'jsonc', 'json5',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'svg',
  'sql', 'graphql', 'gql', 'proto',
  'csv', 'tsv', 'log',
  'gitignore', 'dockerignore', 'editorconfig', 'prettierrc', 'eslintrc',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])

function getFileExtension(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return lower
  return lower.slice(dot + 1)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

const MAX_TEXT_PREVIEW = 2 * 1024 * 1024 // 2 MB

function FileEditorPane({
  path,
  file,
  content,
  loading,
  error,
  savedAt,
  saveStatus,
  saveErrorMsg,
  onChange,
  onClose,
  onFlushSave,
  fullscreen,
  onToggleFullscreen,
}: {
  path: string
  file: File | null
  content: string | null
  loading: boolean
  error: string | null
  savedAt: number | null
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  saveErrorMsg: string | null
  onChange: (content: string) => void
  onClose: () => void
  onFlushSave: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  const ext = getFileExtension((file?.name || path) ?? '')
  const isImage = !!file && (IMAGE_EXTENSIONS.has(ext) || file.type.startsWith('image/'))
  const isPdf = !!file && (ext === 'pdf' || file.type === 'application/pdf')
  const isText = !isImage && !isPdf && (!!file && (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')))
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [savedTick, setSavedTick] = useState(0)

  useEffect(() => {
    if (!file || (!isImage && !isPdf)) return
    const url = URL.createObjectURL(file)
    setObjectUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file, isImage, isPdf])

  useEffect(() => {
    if (savedAt === null) return
    setSavedTick((t) => t + 1)
  }, [savedAt])

  const download = () => {
    if (!file) return
    const blob = isText && content !== null ? new Blob([content], { type: file.type || 'text/plain' }) : file
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name || path.split('/').pop() || 'file'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const HeaderIcon = isImage ? ImageIcon : isPdf ? FileText : CodeIcon
  const savedLabel = savedAt
    ? new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-background">
      <div className="h-11 flex items-center justify-between px-4 sm:px-6 border-b border-border-gray flex-shrink-0 gap-3">
        <div className="flex items-center gap-2 text-sm text-primary min-w-0">
          <HeaderIcon size={14} className="text-tertiary flex-shrink-0" strokeWidth={1.6} />
          <span className="font-medium truncate" title={path}>{path}</span>
          {file && <span className="text-xs text-tertiary flex-shrink-0">{formatBytes(file.size)}</span>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isText && saveStatus === 'saving' && (
            <span className="text-[11px] text-tertiary inline-flex items-center gap-1">
              <Loader2 size={11} className="animate-spin" />
              Saving…
            </span>
          )}
          {isText && saveStatus === 'saved' && savedLabel && (
            <span
              key={savedTick}
              className="text-[11px] text-tertiary inline-flex items-center gap-1"
              title={`Saved to disk at ${savedLabel}`}
            >
              <Check size={11} strokeWidth={2} className="text-green-500" />
              Saved {savedLabel}
            </span>
          )}
          {isText && saveStatus === 'error' && (
            <span
              className="text-[11px] text-red-500 inline-flex items-center gap-1 max-w-[16rem] truncate"
              title={saveErrorMsg ?? 'Save failed'}
            >
              <AlertCircle size={11} strokeWidth={2} />
              {saveErrorMsg ?? 'Save failed'}
            </span>
          )}
          {file && (
            <button
              onClick={download}
              aria-label="Download"
              title="Download"
              className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
            >
              <Download size={14} strokeWidth={1.6} />
            </button>
          )}
          <button
            onClick={onToggleFullscreen}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-pressed={fullscreen}
            title={fullscreen ? 'Exit full screen' : 'Full screen'}
            className="hidden md:flex w-7 h-7 rounded-md hover:bg-border-gray/50 items-center justify-center text-secondary"
          >
            {fullscreen ? <Minimize2 size={14} strokeWidth={1.6} /> : <Maximize2 size={14} strokeWidth={1.6} />}
          </button>
          <button
            onClick={onClose}
            aria-label="Close file"
            title="Close file"
            className="w-7 h-7 rounded-md hover:bg-border-gray/50 flex items-center justify-center text-secondary"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!file && (
          <div className="p-6 text-sm text-tertiary">File not found in workspace.</div>
        )}
        {file && isImage && objectUrl && (
          <div className="flex items-center justify-center p-4 min-h-full">
            <img src={objectUrl} alt={path} className="max-w-full max-h-[80dvh] object-contain" />
          </div>
        )}
        {file && isPdf && objectUrl && (
          <iframe src={objectUrl} title={path} className="w-full h-full min-h-[60dvh] border-0 bg-white" />
        )}
        {file && isText && (
          <>
            {loading && (
              <div className="p-4 flex items-center gap-2 text-sm text-tertiary">
                <Loader2 size={14} className="animate-spin" />
                Loading…
              </div>
            )}
            {error && (
              <div className="p-4 flex items-start gap-2 text-sm text-red-500">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {!loading && !error && content !== null && (
              <textarea
                value={content}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    onFlushSave()
                  }
                }}
                spellCheck={false}
                className="w-full h-full min-h-[60dvh] resize-none bg-background text-primary font-mono text-xs leading-relaxed px-4 sm:px-6 py-4 focus:outline-none whitespace-pre"
                style={{ tabSize: 2 }}
              />
            )}
          </>
        )}
        {file && !isImage && !isPdf && !isText && (
          <div className="p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[40dvh]">
            <div className="w-12 h-12 rounded-full bg-border-gray/40 flex items-center justify-center">
              <FileText size={20} className="text-tertiary" strokeWidth={1.6} />
            </div>
            <div>
              <div className="text-sm font-medium text-primary">Cannot edit this file</div>
              <div className="text-xs text-tertiary mt-1">
                {ext ? `.${ext}` : 'Unknown'} · {formatBytes(file.size)}
              </div>
            </div>
            <button
              onClick={download}
              className="mt-2 inline-flex items-center gap-2 h-9 px-3 rounded-md border border-border-gray text-xs text-secondary hover:text-primary hover:bg-border-gray/30 transition-colors"
            >
              <Download size={12} strokeWidth={1.8} />
              Download
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
