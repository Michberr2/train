import { useEffect, useState } from 'react'
import { projectDeletedIds } from '../../../../shared/projectMerge'
import { FolderGit2, Github, Trash2, Plus, X } from 'lucide-react'

type Project = {
  id: string
  name: string
  repo?: string
  createdAt: number
  _projectSync?: { conflictOf?: string }
}

const STORAGE_KEY = 'nalu-projects'

const DELETED_KEY = 'nalu-deleted-workspace-projects'

function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Project[]
    if (!Array.isArray(parsed)) return []
    const deleted = new Set(projectDeletedIds(localStorage.getItem(DELETED_KEY) || '[]'))
    return parsed.filter(project => !deleted.has(project.id))
  } catch {
    return []
  }
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return ''
  }
}

export default function ProjectsPanel() {
  const [projects, setProjects] = useState<Project[]>(() => loadProjects())
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')

  useEffect(() => {
    const reload = () => setProjects(loadProjects())
    const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === DELETED_KEY || event.key === null) reload() }
    window.addEventListener('nalu-hydrated', reload)
    window.addEventListener('nalu-session-cleared', reload)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener('nalu-hydrated', reload)
      window.removeEventListener('nalu-session-cleared', reload)
      window.removeEventListener('storage', storage)
    }
  }, [])

  function saveProjects(next: Project[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setProjects(loadProjects())
  }

  function resetForm() {
    setName('')
    setRepo('')
    setShowForm(false)
  }

  function createProject() {
    const trimmedName = name.trim()
    if (!trimmedName) return
    const trimmedRepo = repo.trim()
    const next: Project = {
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: trimmedName,
      repo: trimmedRepo ? trimmedRepo : undefined,
      createdAt: Date.now(),
    }
    saveProjects([next, ...loadProjects()])
    resetForm()
  }

  function deleteProject(id: string) {
    const deleted = projectDeletedIds(localStorage.getItem(DELETED_KEY) || '[]')
    localStorage.setItem(DELETED_KEY, JSON.stringify([...new Set([...deleted, id])]))
    saveProjects(loadProjects().filter(project => project.id !== id))
  }

  return (
    <div className="ws-projects flex flex-1 min-h-0 flex-col bg-glass/[0.09] backdrop-blur-2xl font-sans text-ink">
      <header className="ws-projects-header flex items-start justify-between gap-4 border-b border-glass/[0.18] px-6 py-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-glass/[0.11] backdrop-blur-2xl">
            <FolderGit2 className="h-5 w-5 text-ink" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-ink">Projects</h1>
            <p className="text-sm text-dim">
              Connect a GitHub repo or create a workspace
            </p>
          </div>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black transition hover:bg-white/80"
          >
            <Plus className="h-4 w-4" />
            New project
          </button>
        )}
      </header>

      <div className="ws-projects-content min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {showForm && (
          <div className="mb-5 rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium text-ink">
                New project
              </span>
              <button
                type="button"
                onClick={resetForm}
                className="rounded-md p-1 text-dim transition hover:bg-glass/5 hover:text-ink"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createProject()
                  if (e.key === 'Escape') resetForm()
                }}
                placeholder="Project name"
                className="w-full rounded-lg border border-glass/[0.18] bg-glass/[0.09] backdrop-blur-2xl px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-glass/20 focus:outline-none"
              />
              <input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createProject()
                  if (e.key === 'Escape') resetForm()
                }}
                placeholder="owner/repo (optional)"
                className="w-full rounded-lg border border-glass/[0.18] bg-glass/[0.09] backdrop-blur-2xl px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-glass/20 focus:outline-none"
              />
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="rounded-lg bg-glass/5 px-3 py-1.5 text-sm text-ink transition hover:bg-glass/10"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={createProject}
                disabled={!name.trim()}
                className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-black transition hover:bg-white/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>
        )}

        {projects.length === 0 ? (
          <div className="ws-projects-empty flex h-full min-h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-glass/[0.18] text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-glass/[0.11] backdrop-blur-2xl">
              <FolderGit2 className="h-6 w-6 text-dim" />
            </div>
            <p className="text-sm font-medium text-ink">No projects yet</p>
            <p className="mt-1 max-w-xs text-sm text-dim">
              Create a workspace or connect a GitHub repo to get started.
            </p>
            {!showForm && (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-glass/5 px-3 py-1.5 text-sm text-ink transition hover:bg-glass/10"
              >
                <Plus className="h-4 w-4" />
                New project
              </button>
            )}
          </div>
        ) : (
          <div className="ws-projects-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <div
                key={project.id}
                className="group relative rounded-xl border border-glass/[0.18] bg-glass/[0.11] backdrop-blur-2xl p-4 transition hover:bg-glass/5"
              >
                <button
                  type="button"
                  onClick={() => deleteProject(project.id)}
                  className="absolute right-2 top-2 rounded-md p-1.5 text-dim opacity-0 transition hover:bg-glass/10 hover:text-red-300 group-hover:opacity-100"
                  aria-label={`Delete ${project.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-2 pr-7">
                  {project.repo && (
                    <Github className="h-4 w-4 shrink-0 text-dim" />
                  )}
                  <h2 className="truncate text-sm font-semibold text-ink">
                    {project.name}
                  </h2>
                </div>
                {project.repo && (
                  <p className="mt-1 truncate text-xs text-dim">
                    {project.repo}
                  </p>
                )}
                <p className="mt-3 text-xs text-dim">
                  Created {formatDate(project.createdAt)}
                </p>
                {project._projectSync?.conflictOf && <p className="mt-2 text-xs text-ink">
                  Another device edited this project. Both versions were kept; delete the version you don’t need.
                </p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
