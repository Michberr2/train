import { Router, Request, Response } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || os.homedir())

function resolveRepo(repoParam: unknown): string {
  if (typeof repoParam !== 'string' || !repoParam) {
    throw new Error('repo query parameter required')
  }
  const candidate = path.resolve(WORKSPACE_ROOT, repoParam)
  const rel = path.relative(WORKSPACE_ROOT, candidate)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('repo path outside workspace root')
  }
  return candidate
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

const router = Router()

router.get('/repos', async (_req: Request, res: Response) => {
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true })
    const repos: { name: string; path: string }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const full = path.join(WORKSPACE_ROOT, entry.name)
      try {
        const stat = await fs.stat(path.join(full, '.git'))
        if (stat.isDirectory() || stat.isFile()) {
          repos.push({ name: entry.name, path: entry.name })
        }
      } catch {
        // not a git repo
      }
    }
    repos.sort((a, b) => a.name.localeCompare(b.name))
    res.json({ root: WORKSPACE_ROOT, repos })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/status', async (req: Request, res: Response) => {
  try {
    const cwd = resolveRepo(req.query.repo)
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    let ahead = 0
    let behind = 0
    try {
      const counts = (await git(cwd, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]))
        .trim()
        .split(/\s+/)
      behind = Number(counts[0] ?? 0)
      ahead = Number(counts[1] ?? 0)
    } catch {
      // No upstream — leave at 0
    }

    const porcelain = (await git(cwd, ['status', '--porcelain=v1', '-uall'])).trim()
    const lines = porcelain ? porcelain.split('\n') : []
    const unstaged: string[] = []
    const untracked: string[] = []
    const staged: string[] = []
    for (const line of lines) {
      const code = line.slice(0, 2)
      if (code === '??') untracked.push(line.slice(3))
      else {
        if (code[0] !== ' ' && code[0] !== '?') staged.push(line.slice(3))
        if (code[1] !== ' ' && code[1] !== '?') unstaged.push(line.slice(3))
      }
    }

    let totalAdded = 0
    let totalRemoved = 0
    try {
      const numstat = (await git(cwd, ['diff', '--numstat', 'HEAD'])).trim()
      for (const row of numstat ? numstat.split('\n') : []) {
        const [a, r] = row.split('\t')
        const ai = parseInt(a, 10)
        const ri = parseInt(r, 10)
        if (Number.isFinite(ai)) totalAdded += ai
        if (Number.isFinite(ri)) totalRemoved += ri
      }
    } catch {
      // ignore
    }

    res.json({
      branch,
      ahead,
      behind,
      added: totalAdded,
      removed: totalRemoved,
      counts: {
        staged: staged.length,
        unstaged: unstaged.length,
        untracked: untracked.length,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

interface NumstatEntry {
  path: string
  added: number
  removed: number
  status: 'modified' | 'added' | 'deleted' | 'renamed'
}

router.get('/diff', async (req: Request, res: Response) => {
  try {
    const cwd = resolveRepo(req.query.repo)
    const tracked = (await git(cwd, ['diff', '--numstat', 'HEAD'])).trim()
    const untrackedList = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).trim()
    const entries: NumstatEntry[] = []

    for (const row of tracked ? tracked.split('\n') : []) {
      const [a, r, p] = row.split('\t')
      if (!p) continue
      entries.push({
        path: p,
        added: parseInt(a, 10) || 0,
        removed: parseInt(r, 10) || 0,
        status: 'modified',
      })
    }
    for (const p of untrackedList ? untrackedList.split('\n') : []) {
      if (!p) continue
      entries.push({ path: p, added: 0, removed: 0, status: 'added' })
    }

    res.json({ files: entries })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

interface TreeNode {
  type: 'file' | 'folder'
  name: string
  path: string
  children?: TreeNode[]
}

router.get('/tree', async (req: Request, res: Response) => {
  try {
    const cwd = resolveRepo(req.query.repo)
    const tracked = (await git(cwd, ['ls-files'])).trim()
    const untrackedList = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).trim()
    const all = new Set<string>()
    for (const p of tracked.split('\n')) if (p) all.add(p)
    for (const p of untrackedList.split('\n')) if (p) all.add(p)

    const root: TreeNode = { type: 'folder', name: '', path: '', children: [] }
    for (const p of all) {
      const parts = p.split('/')
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
            ? { type: 'file', name: part, path: acc }
            : { type: 'folder', name: part, path: acc, children: [] }
          children.push(next)
        }
        node = next
      }
    }

    const sortNode = (n: TreeNode) => {
      if (!n.children) return
      n.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      n.children.forEach(sortNode)
    }
    sortNode(root)

    res.json({ tree: root.children })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

router.get('/file', async (req: Request, res: Response) => {
  try {
    const cwd = resolveRepo(req.query.repo)
    const filePath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!filePath) throw new Error('path query parameter required')
    const candidate = path.resolve(cwd, filePath)
    const rel = path.relative(cwd, candidate)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('file path outside repo')
    }
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) throw new Error('not a file')
    if (stat.size > 2 * 1024 * 1024) {
      res.json({ path: filePath, size: stat.size, content: null, truncated: true })
      return
    }
    const content = await fs.readFile(candidate, 'utf-8')
    res.json({ path: filePath, size: stat.size, content, truncated: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

export default router
