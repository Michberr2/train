// Minimal GitHub API client for the Nalu web agent. Uses a personal access
// token (stored client-side under 'nalu-github-pat'). Loads a repo's file tree
// + lets the agent read file contents and commit changes — all from the browser.

export const PAT_KEY = 'nalu-github-pat'
export const ACTIVE_REPO_KEY = 'nalu-active-repo'

export interface ActiveRepo {
  owner: string
  repo: string
  branch: string
  paths: string[] // file paths in the repo (blobs only)
}

export function getToken(): string {
  return localStorage.getItem(PAT_KEY) || ''
}
export function setToken(t: string): void {
  if (t) localStorage.setItem(PAT_KEY, t)
  else localStorage.removeItem(PAT_KEY)
}
export function getActiveRepo(): ActiveRepo | null {
  try {
    const raw = localStorage.getItem(ACTIVE_REPO_KEY)
    return raw ? (JSON.parse(raw) as ActiveRepo) : null
  } catch {
    return null
  }
}
export function setActiveRepo(r: ActiveRepo | null): void {
  if (r) localStorage.setItem(ACTIVE_REPO_KEY, JSON.stringify(r))
  else localStorage.removeItem(ACTIVE_REPO_KEY)
}

async function gh(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

/** Load a repo's default branch + full file path list. */
export async function loadRepo(token: string, owner: string, repo: string): Promise<ActiveRepo> {
  const info = (await gh(token, `/repos/${owner}/${repo}`)) as { default_branch: string }
  const branch = info.default_branch || 'main'
  const ref = (await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`)) as {
    object: { sha: string }
  }
  const commit = (await gh(token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`)) as {
    tree: { sha: string }
  }
  const tree = (await gh(
    token,
    `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
  )) as { tree: { path: string; type: string }[] }
  const paths = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path)
  return { owner, repo, branch, paths }
}

/** Read a single file's text content. */
export async function readFile(
  token: string,
  r: ActiveRepo,
  path: string,
): Promise<string> {
  const data = (await gh(
    token,
    `/repos/${r.owner}/${r.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${r.branch}`,
  )) as { content?: string; encoding?: string }
  if (data.content && data.encoding === 'base64') {
    return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))
  }
  throw new Error('file not readable (binary or too large)')
}

/** Commit a set of file changes ({path: newContent}) to the repo's branch. */
export async function commitFiles(
  token: string,
  r: ActiveRepo,
  changes: Record<string, string>,
  message: string,
): Promise<string> {
  const ref = (await gh(token, `/repos/${r.owner}/${r.repo}/git/ref/heads/${r.branch}`)) as {
    object: { sha: string }
  }
  const parentSha = ref.object.sha
  const parentCommit = (await gh(
    token,
    `/repos/${r.owner}/${r.repo}/git/commits/${parentSha}`,
  )) as { tree: { sha: string } }
  const treeItems = await Promise.all(
    Object.entries(changes).map(async ([path, content]) => {
      const blob = (await gh(token, `/repos/${r.owner}/${r.repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'utf-8' }),
      })) as { sha: string }
      return { path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha }
    }),
  )
  const newTree = (await gh(token, `/repos/${r.owner}/${r.repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeItems }),
  })) as { sha: string }
  const newCommit = (await gh(token, `/repos/${r.owner}/${r.repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] }),
  })) as { sha: string }
  await gh(token, `/repos/${r.owner}/${r.repo}/git/refs/heads/${r.branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  })
  return newCommit.sha
}
