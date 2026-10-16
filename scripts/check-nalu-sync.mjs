#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const names = ['nalumobile', 'naludesktop', 'train']
const parent = process.env.NALU_REPOS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const roots = Object.fromEntries(names.map(name => [name, path.join(parent, name)]))
const read = (repo, file) => fs.readFileSync(path.join(roots[repo], file), 'utf8')
const hash = text => createHash('sha256').update(text).digest('hex')

export function check() {
  const errors = []
  const verify = (description, fn) => {
    try { if (!fn()) throw new Error('mismatch'); console.log(`PASS ${description}`) }
    catch (e) { errors.push(description); console.error(`FAIL ${description}: ${e.message}`) }
  }
  for (const name of names) verify(`${name} checkout available`, () => fs.existsSync(path.join(roots[name], '.git')))
  for (const file of ['nalu.mjs', 'install.sh']) verify(`published CLI ${file} matches desktop source`, () => hash(read('naludesktop', `cli/${file}`)) === hash(read('train', `client/public/${file}`)))
  verify('mobile and desktop use the same production API', () => {
    const base = (repo, file) => read(repo, file).match(/export const API_BASE\s*=\s*['"]([^'"]+)/)?.[1]
    return base('nalumobile', 'src/api.ts') === 'https://n4lu.ai' && base('naludesktop', 'src/lib/naluApi.ts') === 'https://n4lu.ai'
  })
  for (const route of ['auth', 'chat', 'data', 'team', 'task-attachments']) verify(`shared backend /api/${route} exists`, () => fs.existsSync(path.join(roots.train, `api/${route}.ts`)))
  for (const file of ['AGENTS.md', 'scripts/check-nalu-sync.mjs']) verify(`${file} agrees across all three repos`, () => new Set(names.map(name => hash(read(name, file)))).size === 1)
  console.log(errors.length ? `${errors.length} sync checks failed. No files were changed.` : 'All cross-repo consistency checks passed. This does not verify GitHub or running deployments.')
  return errors.length === 0
}

if (process.argv.includes('--watch')) {
  check()
  // Read-only monitoring. Never copy active source files or overwrite conflicts.
  setInterval(check, 30000)
} else process.exitCode = check() ? 0 : 1
