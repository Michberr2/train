// One locked driver for sequential and parallel training. Checkpoint creation is
// not promotion: held-out domain/execution gates still run in the flywheel.
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {samplerFromTrainingResult} from './training-result.mjs'
import {loadTrainingEnv} from './training-env.mjs'
import {loadReviewedDataset} from './dataset-policy.mjs'
const dir = path.dirname(fileURLToPath(import.meta.url))

export async function trainDomain(kind, {spawnChild = spawn, timeout = 30 * 60 * 1000} = {}) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) throw new Error('Invalid domain name')
  const dataset = path.join(dir, 'data', `nalu-${kind}.jsonl`)
  const reviewed = loadReviewedDataset(dataset)
  if (reviewed.accepted.filter(r => r.training.split === 'train').length < 40) throw new Error(`${kind}: fewer than 40 reviewed training rows`)
  return new Promise((resolve, reject) => {
    const child = spawnChild(path.join(dir, '.venv/bin/python'), ['-u', path.join(dir, 'train_nalu_sft.py'), '--domain', kind, '--data', dataset, '--base', process.env.NALU_BASE_MODEL || 'thinkingmachines/Inkling', '--epochs', '1', '--batch', '8', '--maxlen', '4096', '--out', `nalu-${kind}-${Date.now().toString(36)}`, '--max-train-tokens', process.env.FLYWHEEL_MAX_TRAIN_TOKENS || '2000000'], {cwd: dir})
    let stdout = '', timedOut = false, settled = false
    const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL')}, timeout)
    child.stdout.on('data', d => {stdout = (stdout + d).slice(-1024 * 1024)})
    // Drain stderr, but never interpret provider errors as a checkpoint save.
    child.stderr.on('data', () => {})
    child.once('error', error => {settled = true; clearTimeout(timer); reject(error)})
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      if (settled) return
      const modelPath = !timedOut && samplerFromTrainingResult({status, signal, stdout})
      if (!modelPath) return reject(new Error(`${kind}: training failed (exit ${status}, signal ${signal || 'none'}, timeout ${timedOut})`))
      resolve(modelPath)
    })
  })
}

async function main() {
  loadTrainingEnv(dir)
  const domains = process.argv.includes('--all') ? fs.readdirSync(path.join(dir, 'data')).filter(f => /^nalu-[a-z0-9_-]+\.jsonl$/.test(f) && f !== 'nalu-agent.jsonl').map(f => f.slice(5, -6)) : process.argv.slice(2)
  if (!domains.length || new Set(domains).size !== domains.length) throw new Error('Supply unique domain names or --all')
  const concurrency = Number(process.env.CONC || 2)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('CONC must be an integer from 1 through 4')
  const registry = path.join(dir, 'fleet_models.env'), lock = `${registry}.lock`
  const fd = fs.openSync(lock, 'wx', 0o600)
  fs.writeFileSync(fd, JSON.stringify({pid: process.pid, at: new Date().toISOString()}))
  let cursor = 0, failures = 0
  try {
    async function worker() {
      while (cursor < domains.length) {
        const kind = domains[cursor++]
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) {failures++; continue}
        const key = `NALU_${kind.toUpperCase()}_MODEL`
        const existing = fs.existsSync(registry) ? fs.readFileSync(registry, 'utf8') : ''
        if (existing.split('\n').some(line => line.startsWith(`${key}=`))) {console.log(`${kind}: existing registry entry retained; no claim of current model qualification`); continue}
        try {
          const modelPath = await trainDomain(kind)
          fs.appendFileSync(registry, `${key}=${modelPath}\n`, {mode: 0o600})
          console.log(`${kind}: sampler saved with held-out token-loss receipt; not promoted`)
        } catch (error) {failures++; console.error(error.message)}
      }
    }
    await Promise.all(Array.from({length: concurrency}, worker))
  } finally {fs.closeSync(fd); fs.unlinkSync(lock)}
  if (failures) throw new Error(`${failures} domain training runs failed`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error.message); process.exitCode = 1})
