#!/usr/bin/env node
// The Nalu training flywheel — "train in real time, deploy when it can".
//
//   collect (reviewed)     Explicitly approved terminal rows may come from
//                          ~/.nalu/data/sessions.jsonl; the trajectory
//                          generators produce drafts requiring independent review
//   train   (this script)  when a lane has enough NEW rows since its last run,
//                          SFT a fresh LoRA on Tinker (train_nalu_sft.py)
//   gate    (this script)  response-format comparison plus real full-stack
//                          CLI execution qualification for the agent lane
//   deploy  (this script)  only if the candidate WINS by a margin: set the
//                          Vercel env for that lane and redeploy the site
//
// Lanes: 'agent' (reviewed terminal rows → NALU_CLI_MODEL, CLI surface only) and each
// fleet domain with enough data (→ NALU_<KIND>_MODEL).
//
// Run:      node training/flywheel.mjs [--dry-run] [--force-train agent]
// Schedule: training/install-flywheel.sh installs a launchd job (every 6h).
// State:    training/.flywheel-state.json · Log: training/flywheel.log

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { evaluateExecutionGate } from './execution-gate.mjs'
import { loadTrainingEnv } from './training-env.mjs'
import { loadReviewedDataset, contentHash } from './dataset-policy.mjs'
import { resolveIncumbent, laneEnvName, validateDomainBattery, evaluateDomainGate, deployWithRollback } from './promotion-gate.mjs'
import { samplerFromTrainingResult } from './training-result.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TRAIN_REPO = path.dirname(HERE)
// Configuration must be loaded before any FLYWHEEL_* constants are derived.
loadTrainingEnv(HERE)
const STATE_PATH = path.join(HERE, '.flywheel-state.json')
const LOG_PATH = path.join(HERE, 'flywheel.log')
const BATTERY_PATH = path.join(HERE, 'eval', 'agent-battery.json')
const SESSIONS = path.join(os.homedir(), '.nalu', 'data', 'sessions.jsonl')
const GOLD = path.join(HERE, 'data', 'nalu-agent.jsonl')
const VENV_PY = path.join(HERE, '.venv', 'bin', 'python')
// Baseline for the per-domain LoRA fine-tunes. Inkling (Thinking Machines' open
// 975B MoE, Apache-2.0) is the new baseline; train_nalu_sft.py auto-selects the
// Inkling renderer (tml-renderers) when the base is Inkling. Override with
// FLYWHEEL_BASE=Qwen/Qwen3.5-9B for cheap dev iterations.
const BASE_MODEL = process.env.FLYWHEEL_BASE || 'thinkingmachines/Inkling'
const MIN_NEW = { agent: Number(process.env.FLYWHEEL_MIN_NEW || 60), domain: Number(process.env.FLYWHEEL_MIN_DOMAIN || 40) }
const WIN_MARGIN = Number(process.env.FLYWHEEL_MARGIN || 5) // points out of 100
const TINKER_BASE = process.env.TINKER_BASE_URL || 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const FORCE = args.includes('--force-train') ? args[args.indexOf('--force-train') + 1] || 'agent' : null

// mirrors the generator's system prompt — the contract the models train under
const NALU_CLI_SYSTEM = `You are Nalu, a coding agent running in the user's terminal (the Nalu CLI).
Your tools run on the user's real machine: bash, read_file, write_file, edit_file, list_dir, grep, web_search, fetch_url.
HOW TO ACT: to do anything, emit ONE tool call as a single bare JSON object on its own line, then STOP and wait for the result:
{"name":"bash","arguments":{"command":"ls -la"}}
Rules:
- DO the work with tools instead of telling the user what to do. Explore first (list_dir/read_file/grep), then change (edit_file/write_file), then VERIFY (bash: run the code/tests).
- Never invent file contents or tool output — read before editing; nothing has happened until a real tool result arrives.
- At most one short sentence before a tool call. Never end a reply announcing what you will do — either emit the call or give the final answer.
- For complex multi-step tasks, first save a checkbox plan to .nalu/plans/<date>-<slug>.md, then execute it.
- web_search/fetch_url give you live internet access — use them for current or unfamiliar information; never claim you cannot browse.
- Final answer: concise plain Markdown, 1-3 sentence summary of what changed. No emojis, no charts, no HTML.`

const TOOL_NAMES = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'web_search', 'fetch_url'])
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`
  console.log(line)
  try {
    fs.appendFileSync(LOG_PATH, line + '\n')
  } catch {}
}

function loadEnvLocal() {
  loadTrainingEnv(HERE)
}

/** Sample one completion from a served model via Tinker's OpenAI endpoint. */
async function sample(backend, system, user, maxTokens = 700) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 90000)
  try {
    const r = await fetch(`${backend.provider}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: backend.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, max_tokens: maxTokens, temperature: 0 }),
      signal: ac.signal,
    })
    if (!r.ok) return null
    const d = await r.json().catch(() => null)
    return d?.choices?.[0]?.finish_reason === 'stop' ? d.choices[0].message?.content ?? null : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** Score a model on the battery: % of cases handled in the trained format. */
async function scoreModel(model, battery) {
  let points = 0
  const per = []
  for (const item of battery) {
    const reply = await sample(model, NALU_CLI_SYSTEM, item.prompt)
    if (!reply) throw new Error('Incomplete format evaluation; provider failed')
    let ok = false
    const callLines = reply.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{"name"'))
    const parsed = callLines
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((c) => c && TOOL_NAMES.has(c.name) && c.arguments && typeof c.arguments === 'object')
    if (item.expect === 'tool_call') {
      ok = parsed.length >= 1 && (!item.tool || parsed.some((c) => c.name === item.tool))
    } else {
      // direct answer: no tool-call JSON, no announce-and-stop ending
      const t = reply.trim()
      const lastLine = t.split('\n').filter(Boolean).pop() || ''
      const announces = /:\s*$/.test(t) || /\b(let me|i'?ll|i will|going to)\b[^.!?]{0,90}$/i.test(lastLine)
      ok = t.length > 40 && parsed.length === 0 && !announces
    }
    per.push({ id: item.id, ok })
    if (ok) points++
  }
  return { score: Math.round((100 * points) / battery.length), per }
}

function trainLane(lane, rows) {
  const tmp = path.join(HERE, 'data', `.lane-${lane}.jsonl`)
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const ver = Date.now().toString(36)
  const outName = `nalu-${lane}-fw-${ver}`
  log(`training ${outName} on ${rows.length} rows (base ${BASE_MODEL})`)
  if (DRY) return { path: `(dry-run) ${outName}`, ok: true }
  const res = spawnSync(VENV_PY, [path.join(HERE, 'train_nalu_sft.py'), '--domain', lane, '--data', tmp, '--base', BASE_MODEL, '--epochs', '3', '--maxlen', '8192', '--out', outName, '--max-train-tokens', String(process.env.FLYWHEEL_MAX_TRAIN_TOKENS || 2000000)], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 1000 * 60 * 55,
    env: process.env,
  })
  const modelPath = samplerFromTrainingResult(res)
  if (!modelPath) {
    log(`training FAILED for ${lane} (exit ${res.status})`)
    return { ok: false }
  }
  return { path: modelPath, ok: true }
}

function productionEnv() {
  // Fresh directory avoids env-pull merge semantics. Never log credentials.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nalu-model-env-'))
  fs.chmodSync(dir, 0o700)
  const file = path.join(dir, 'production.env')
  try {
    const result = spawnSync('vercel', ['env', 'pull', file, '--environment=production', '--yes'], {cwd: TRAIN_REPO, encoding: 'utf8', timeout: 120000})
    if (result.status !== 0) throw new Error('Cannot inspect production model configuration')
    fs.chmodSync(file, 0o600)
    return parseEnv(fs.readFileSync(file, 'utf8'))
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
}

async function deployLane(lane, modelPath, snapshot) {
  const key = laneEnvName(lane)
  return deployWithRollback({key, candidate: modelPath, expected: snapshot[key],
    read: name => productionEnv()[name],
    write: (name, value) => {
      const args = value === undefined ? ['env', 'rm', name, 'production', '--yes'] : ['env', 'add', name, 'production', '--force']
      const result = spawnSync('vercel', args, {cwd: TRAIN_REPO, input: value, encoding: 'utf8', timeout: 120000})
      if (result.status !== 0) throw new Error('Production model environment update failed')
    },
    deploy: () => spawnSync('bash', [path.join(TRAIN_REPO, 'deploy.sh')], {cwd: TRAIN_REPO, encoding: 'utf8', timeout: 1000 * 60 * 20}).status === 0,
  })
}

function reviewedRows(file) {
  if (!fs.existsSync(file)) return []
  const {accepted, rejected} = loadReviewedDataset(file, {strict: false})
  if (rejected.length) log(`${path.basename(file)}: excluded ${rejected.length} unreviewed/ineligible rows`)
  return accepted
}

export function collectLanes() {
  // Terminal traces never become web specialist data, even if their topic matches.
  const terminal = [...reviewedRows(GOLD), ...reviewedRows(SESSIONS)].filter(row => row.training.surface === 'terminal')
  const unique = new Map(terminal.map(row => [contentHash(row), row]))
  const lanes = {agent: [...unique.values()]}
  for (const file of fs.readdirSync(path.join(HERE, 'data')).filter(name => /^nalu-[a-z0-9_-]+\.jsonl$/.test(name) && name !== 'nalu-agent.jsonl')) {
    const lane = file.slice(5, -6)
    lanes[lane] = reviewedRows(path.join(HERE, 'data', file)).filter(row => row.training.surface === 'web' && row.training.domain === lane)
  }
  return lanes
}

export async function runCycle(deps = {}) {
  const {getLanes = collectLanes, getProductionEnv = productionEnv, train = trainLane, score = scoreModel,
    execute = evaluateExecutionGate, domainGate = evaluateDomainGate, deploy = deployLane,
    candidateBackend = {provider: TINKER_BASE, apiKey: process.env.TINKER_API_KEY},
    save = state => {const tmp = `${STATE_PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state, null, 2), {mode: 0o600}); fs.renameSync(tmp, STATE_PATH)},
    load = () => fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {trainedAt: {}, rowCounts: {}, deployed: {}, history: []},
    dry = DRY, force = FORCE, readBattery = lane => JSON.parse(fs.readFileSync(lane === 'agent' ? BATTERY_PATH : path.join(HERE, 'eval', `${lane}-battery.json`), 'utf8'))} = deps
  const state = load(), lanes = getLanes()
  let failures = 0, trainedCount = 0
  const maxLanes = Number(process.env.FLYWHEEL_MAX_LANES || 1)
  if (!Number.isInteger(maxLanes) || maxLanes < 1 || maxLanes > 36) throw new Error('Invalid FLYWHEEL_MAX_LANES')
  for (const [lane, rows] of Object.entries(lanes)) {
    const trainRows = rows.filter(row => row.training.split === 'train')
    const minNew = lane === 'agent' ? MIN_NEW.agent : MIN_NEW.domain
    const fresh = trainRows.length - (state.rowCounts[lane] || 0)
    if (force !== lane && (trainRows.length < minNew || fresh < Math.ceil(minNew / 2))) continue
    if (!trainRows.length || !rows.some(row => row.training.split === 'validation')) { log(`${lane}: missing reviewed train/validation split`); failures++; continue }
    if (trainedCount >= maxLanes) break
    let entry
    try {
      const battery = readBattery(lane)
      if (lane !== 'agent') validateDomainBattery(battery, lane, rows)
      if (dry) { log(`(dry-run) ${lane}: ${trainRows.length} train rows; production comparison and gates required`); continue }
      const snapshot = getProductionEnv(), incumbent = resolveIncumbent(lane, snapshot)
      const trained = train(lane, rows)
      trainedCount++
      if (!trained.ok) throw new Error('Training did not produce a successful sampler receipt')
      state.rowCounts[lane] = trainRows.length
      state.trainedAt[lane] = new Date().toISOString()
      const candidate = {model: trained.path, ...candidateBackend}
      let cand, inc, execution = null, domain = null, verdict = false
      if (lane === 'agent') {
        ;[cand, inc] = [await score(candidate, battery), await score(incumbent, battery)]
        if (cand.score >= 90 && cand.score >= inc.score + WIN_MARGIN) {
          // The fullstack runner currently accepts one provider for both models.
          if (candidate.provider !== incumbent.provider || candidate.apiKey !== incumbent.apiKey) throw new Error('Agent execution evaluator cannot compare different providers')
          execution = await execute({candidate: candidate.model, incumbent: incumbent.model, provider: candidate.provider, apiKey: candidate.apiKey})
          verdict = execution?.qualified === true
        }
      } else {
        domain = await domainGate({lane, candidate, incumbent, battery, trainingRows: rows, sample, margin: WIN_MARGIN})
        cand = domain.candidate; inc = domain.incumbent; verdict = domain.qualified === true
      }
      entry = {at: new Date().toISOString(), lane, model: trained.path, incumbentModel: incumbent.model, candidate: cand.score, incumbent: inc.score, gatePassed: verdict, deployed: false,
        ...(execution ? {execution: {qualified: execution.qualified, candidateRun: execution.candidate?.runDir, incumbentRun: execution.incumbent?.runDir, incumbentQualified: execution.incumbentQualified}} : {}),
        ...(domain ? {domain} : {})}
      state.history.push(entry)
      save(state)
      if (!verdict) { log(`${lane}: required quality gates did not pass; incumbent retained`); continue }
      if (await deploy(lane, trained.path, snapshot) !== true) throw new Error('Release failed')
      entry.deployed = true
      state.deployed[lane] = {model: trained.path, at: new Date().toISOString(), score: cand.score}
      log(`${lane}: candidate release verified`)
    } catch (error) {
      failures++
      if (entry) entry.failure = error.message
      else state.history.push({at: new Date().toISOString(), lane, gatePassed: false, deployed: false, failure: error.message})
      log(`${lane}: ${error.message}`)
    } finally { if (!dry) save(state) }
  }
  if (failures) throw new Error(`${failures} training/promotion lanes failed; see recorded history`)
  return state
}

export function acquireRunLock(file = path.join(HERE, '.flywheel.lock')) {
  // Never infer a dead process from age alone. Stale locks require inspection.
  const fd = fs.openSync(file, 'wx', 0o600)
  fs.writeFileSync(fd, JSON.stringify({pid: process.pid, at: new Date().toISOString()}))
  return () => {fs.closeSync(fd); fs.unlinkSync(file)}
}

async function main() {
  loadEnvLocal()
  if (!DRY && !process.env.TINKER_API_KEY) throw new Error('TINKER_API_KEY is required')
  const release = acquireRunLock()
  try { await runCycle() } finally { release() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  log(`flywheel error: ${error.message}`)
  process.exitCode = 1
})
