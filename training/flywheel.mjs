#!/usr/bin/env node
// The Nalu training flywheel — "train in real time, deploy when it can".
//
//   collect (continuous)   Nalu CLI appends every clean session turn to
//                          ~/.nalu/data/sessions.jsonl; the trajectory
//                          generator adds gold rows to data/nalu-agent.jsonl
//   train   (this script)  when a lane has enough NEW rows since its last run,
//                          SFT a fresh LoRA on Tinker (train_nalu_sft.py)
//   gate    (this script)  candidate vs incumbent on a fixed agentic battery —
//                          mechanical scoring, no vibes
//   deploy  (this script)  only if the candidate WINS by a margin: set the
//                          Vercel env for that lane and redeploy the site
//
// Lanes: 'agent' (all rows → NALU_CLI_MODEL, CLI surface only) and each
// fleet domain with enough data (→ NALU_<KIND>_MODEL).
//
// Run:      node training/flywheel.mjs [--dry-run] [--force-train agent]
// Schedule: training/install-flywheel.sh installs a launchd job (every 6h).
// State:    training/.flywheel-state.json · Log: training/flywheel.log

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TRAIN_REPO = path.dirname(HERE)
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
  try {
    for (const l of fs.readFileSync(path.join(TRAIN_REPO, '.env.local'), 'utf8').split('\n')) {
      const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?$/)
      if (m && m[2]) process.env[m[1]] ??= m[2]
    }
  } catch {}
}

function readJsonl(p) {
  try {
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Mechanical row validation — every assistant tool-call line must parse and
 *  use a real tool; roles must alternate sanely. Garbage never trains. */
function validRow(row) {
  if (!Array.isArray(row.turns) || !row.turns.length || row.turns.length > 14) return false
  for (const t of row.turns) {
    if (typeof t.user !== 'string' || typeof t.assistant !== 'string' || !t.assistant.trim()) return false
    for (const line of t.assistant.split('\n')) {
      if (!line.trim().startsWith('{"name"')) continue
      try {
        const call = JSON.parse(line.trim())
        if (!TOOL_NAMES.has(call.name)) return false
        if (!call.arguments || typeof call.arguments !== 'object') return false
      } catch {
        return false
      }
    }
  }
  return true
}

const ROUTE_TO_DOMAIN = { code: 'code', financial: 'finance', crypto: 'crypto', legal: 'legal', medical: 'medical', health: 'health', 'real estate': 'realestate', marketing: 'marketing', math: 'math', science: 'science', reasoning: 'reasoning', hr: 'hr', construction: 'construction' }
function domainOf(row) {
  if (row.domain) return row.domain
  const r = String(row.route || '').toLowerCase()
  for (const [k, v] of Object.entries(ROUTE_TO_DOMAIN)) if (r.includes(k)) return v
  return 'code'
}

/** Sample one completion from a served model via Tinker's OpenAI endpoint. */
async function sample(model, system, user, maxTokens = 700) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 90000)
  try {
    const r = await fetch(`${TINKER_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TINKER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, max_tokens: maxTokens, temperature: 0 }),
      signal: ac.signal,
    })
    if (!r.ok) return null
    const d = await r.json().catch(() => null)
    return d?.choices?.[0]?.message?.content ?? null
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
    const reply = (await sample(model, NALU_CLI_SYSTEM, item.prompt)) || ''
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
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify({ system: r.system || NALU_CLI_SYSTEM, turns: r.turns })).join('\n') + '\n')
  const ver = Date.now().toString(36)
  const outName = `nalu-${lane}-fw-${ver}`
  log(`training ${outName} on ${rows.length} rows (base ${BASE_MODEL})`)
  if (DRY) return { path: `(dry-run) ${outName}`, ok: true }
  const res = spawnSync(VENV_PY, [path.join(HERE, 'train_nalu_sft.py'), '--domain', lane, '--data', tmp, '--base', BASE_MODEL, '--epochs', '3', '--maxlen', '8192', '--out', outName], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 1000 * 60 * 55,
    env: process.env,
  })
  const outText = `${res.stdout || ''}\n${res.stderr || ''}`
  fs.appendFileSync(LOG_PATH, outText.slice(-4000) + '\n')
  const m = outText.match(/Served model path:\s*\n?\s*(\S+)/)
  if (res.status !== 0 || !m) {
    log(`training FAILED for ${lane} (exit ${res.status})`)
    return { ok: false }
  }
  return { path: m[1], ok: true }
}

function deployLane(lane, modelPath) {
  const envName = lane === 'agent' ? 'NALU_CLI_MODEL' : `NALU_${lane.toUpperCase()}_MODEL`
  log(`deploying ${modelPath} → ${envName}`)
  if (DRY) return true
  const rm = spawnSync('npx', ['-y', 'vercel@latest', 'env', 'rm', envName, 'production', '--yes'], { cwd: TRAIN_REPO, encoding: 'utf8', timeout: 120000 })
  void rm // ok if it didn't exist
  const add = spawnSync('npx', ['-y', 'vercel@latest', 'env', 'add', envName, 'production'], { cwd: TRAIN_REPO, input: modelPath, encoding: 'utf8', timeout: 120000 })
  if (add.status !== 0) {
    log(`env add failed: ${(add.stderr || '').slice(0, 300)}`)
    return false
  }
  const dep = spawnSync('bash', [path.join(TRAIN_REPO, 'deploy.sh')], { cwd: TRAIN_REPO, encoding: 'utf8', timeout: 1000 * 60 * 10 })
  if (dep.status !== 0) {
    log(`redeploy failed: ${(dep.stderr || '').slice(0, 300)}`)
    return false
  }
  return true
}

async function main() {
  loadEnvLocal()
  if (!process.env.TINKER_API_KEY) {
    log('no TINKER_API_KEY — nothing to do')
    return
  }
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { trainedAt: {}, rowCounts: {}, deployed: {}, history: [] }

  // ── harvest ──
  const gold = readJsonl(GOLD).filter(validRow)
  const live = readJsonl(SESSIONS).filter(validRow)
  const all = [...gold, ...live]
  const lanes = { agent: all }
  for (const row of all) {
    const d = domainOf(row)
    if (d && d !== 'code') (lanes[d] ??= []).push(row)
  }
  log(`harvest: ${gold.length} gold + ${live.length} live session rows → lanes: ${Object.entries(lanes).map(([k, v]) => `${k}:${v.length}`).join(' ')}`)

  // ── per-lane: train → gate → deploy ──
  for (const [lane, rows] of Object.entries(lanes)) {
    const minNew = lane === 'agent' ? MIN_NEW.agent : MIN_NEW.domain
    const seen = state.rowCounts[lane] || 0
    const fresh = rows.length - seen
    const due = FORCE === lane || (rows.length >= minNew && fresh >= Math.ceil(minNew / 2))
    if (!due) {
      log(`${lane}: ${rows.length} rows (${fresh} new) — below threshold, skipping`)
      continue
    }
    const trained = trainLane(lane, rows)
    if (!trained.ok) continue
    state.rowCounts[lane] = rows.length
    state.trainedAt[lane] = new Date().toISOString()

    // ── the gate: candidate vs incumbent, mechanical scoring ──
    const battery = JSON.parse(fs.readFileSync(BATTERY_PATH, 'utf8'))
    const incumbentModel = state.deployed[lane]?.model || process.env.NALU_DEFAULT_MODEL || 'deepseek-ai/DeepSeek-V3.1'
    if (DRY) {
      log(`(dry-run) would gate ${trained.path} vs ${incumbentModel} on ${battery.length} cases`)
      continue
    }
    const [cand, inc] = [await scoreModel(trained.path, battery), await scoreModel(incumbentModel, battery)]
    log(`${lane}: candidate ${cand.score} vs incumbent ${inc.score} (need +${WIN_MARGIN})`)
    const verdict = cand.score >= inc.score + WIN_MARGIN
    state.history.push({ at: new Date().toISOString(), lane, model: trained.path, candidate: cand.score, incumbent: inc.score, deployed: verdict })
    if (!verdict) {
      log(`${lane}: candidate did NOT clear the gate — keeping incumbent (this is the gate doing its job)`)
      continue
    }
    if (deployLane(lane, trained.path)) {
      state.deployed[lane] = { model: trained.path, at: new Date().toISOString(), score: cand.score }
      log(`${lane}: DEPLOYED ${trained.path} (score ${cand.score} > ${inc.score})`)
    }
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  log('flywheel cycle complete')
}

main().catch((e) => {
  log(`flywheel error: ${e.message}`)
  process.exit(0) // fail-open: a broken cycle must never block the next one
})
