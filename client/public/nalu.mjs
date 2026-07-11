#!/usr/bin/env node
// Nalu CLI — Nalu in your terminal.
//
// A Claude Code-style terminal agent powered by Nalu (n4lu.com). One model
// option — "auto" — and the Nalu router picks the right Nalu model for every
// request (code, reasoning, finance, vision, …) on its own.
//
// Single file, zero dependencies, Node 18+.
//   install : curl -fsSL https://n4lu.com/install.sh | sh
//   run     : nalu                 (interactive)
//             nalu -p "prompt"     (print answer and exit)
//             nalu update          (self-update)
//
// The agent loop runs locally: the model calls tools (bash, read_file,
// write_file, edit_file, list_dir, grep, web_search, fetch_url); this CLI
// executes them on your machine — with permission prompts for anything that
// mutates — and feeds results back until the task is done.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as readline from 'node:readline'
import { spawn, execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const VERSION = '1.3.1'
const DEFAULT_API = 'https://n4lu.com'
const MAX_STEPS = 40 // max model↔tool round-trips per user message
const MAX_TOOL_OUT = 30000 // chars of tool output sent back to the model
const HISTORY_CHAR_BUDGET = 160000

// ── terminal styling ─────────────────────────────────────────────────────────
const TTY = process.stdout.isTTY && !process.env.NO_COLOR
const esc = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : s)
const bold = esc('1')
const dim = esc('2')
const italic = esc('3')
const red = esc('31')
const green = esc('32')
const cyan = esc('36')
const gold = esc('38;5;179')
const goldDim = esc('2;38;5;179')
const gray = esc('38;5;245')

function out(s) {
  process.stdout.write(s)
}
// progress/UI lines: stderr in print mode so stdout stays answer-only for pipes
let PRINT_MODE = false
function ui(s) {
  if (PRINT_MODE) process.stderr.write(s)
  else process.stdout.write(s)
}

// ── the wolf ─────────────────────────────────────────────────────────────────
// Nalu's mark is the wolf. The CLI speaks wolf while it works: a combinatorial
// phrase engine — verbs × objects × tails — yields 12,000+ unique loading lines
// (see wolfismCount) plus sign-offs for finished answers.
const WOLF_VERBS = [
  'sniffing', 'stalking', 'tracking', 'circling', 'hunting', 'shadowing', 'pawing at', 'howling at',
  'growling at', 'gnawing on', 'nosing through', 'prowling', 'padding through', 'loping across',
  'digging into', 'flushing out', 'cornering', 'herding', 'trailing', 'scenting', 'pouncing on',
  'ambushing', 'patrolling', 'ranging over', 'rooting through', 'ears pricked at', 'baring teeth at',
  'closing in on', 'running down', 'keeping watch over',
]
const WOLF_OBJECTS = [
  'the trail', 'your codebase', 'the bug', 'the stack trace', 'fresh commits', 'the dependency thicket',
  'loose semicolons', 'the moonlit repo', 'stray pointers', 'the call stack', 'wild regexes',
  'the config den', 'runaway processes', 'the git log', 'tangled imports', 'the night build',
  'silent errors', 'the memory woods', 'lost packets', 'the type forest', 'sleeping daemons',
  'the branch line', 'scattered TODOs', 'the async underbrush', 'cold caches', 'the linter warnings',
  'upstream waters', 'the test burrow', 'dark corners of main', 'the release ridge', 'orphan branches',
  'the merge clearing', 'half-buried bugs', 'the prod perimeter',
]
const WOLF_TAILS = [
  '', ' under a full moon', ' on soft paws', ' with the pack', ' ears up', ' nose to the ground',
  ' against the wind', ' at first light', ' through fresh snow', ' along the ridge',
  ' in the tall grass', ' by scent alone',
]
const WOLF_FINISHERS = [
  'the pack has spoken', "trail's end", 'the hunt is done', 'howl delivered', 'prey secured',
  'back to the den', 'tracks covered', 'the ridge is quiet', 'scent confirmed', 'territory marked',
  'the moon approves', 'pack business concluded', 'fangs sheathed', 'one more tale for the den',
  'the forest is calm again', 'nothing left to chase', 'the alpha nods', 'ears down, job done',
  'moonlight on a clear trail', 'the howl echoes back', 'den warm, work done', 'no scent left behind',
  'the watch continues', 'good hunt',
]
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const wolfism = () => `${pick(WOLF_VERBS)} ${pick(WOLF_OBJECTS)}${pick(WOLF_TAILS)}…`
const wolfFinisher = () => `${pick(WOLF_FINISHERS)}${pick(WOLF_TAILS)}`
const wolfismCount = () =>
  WOLF_VERBS.length * WOLF_OBJECTS.length * WOLF_TAILS.length + WOLF_FINISHERS.length * WOLF_TAILS.length

// The wolf head — rendered from the real brand mark (client/public/wolf-icon.png)
// as half-block pixels, so the banner IS the logo. Regenerate with a resize if
// the mark ever changes.
const WOLF_HEAD = [
  '                ▄        ▄',
  '               ██      ▄██',
  '             ▄███     ▄███',
  '            █████    █████',
  '           ██████   ██████',
  '         ▄███████  ███████',
  '        ▄████████▄████████',
  '      ▄████████████████████▄',
  '    ▄█████████████████████████▄▄',
  '  ▄███████████████████████████████▄▄',
  '  ▀▀▀████████████████████████████████▄▄',
  '   ▄████████████████████████████████████',
  ' ▄████████████████████████████████████▀',
  '▀▀▀▀██████████████████████████████▀▀',
  '   ▄███████████████████████████▀',
  '▄███████████████████████████▀',
  '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
]

// ── config / args ────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.nalu', 'config.json')
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function parseArgs(argv) {
  const a = { prompt: '', print: false, yolo: false, api: '', help: false, version: false, update: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    if (v === '-h' || v === '--help') a.help = true
    else if (v === '-v' || v === '--version') a.version = true
    else if (v === '-p' || v === '--print') {
      a.print = true
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) a.prompt = argv[++i]
    } else if (v === '--yolo' || v === '--dangerously-skip-permissions') a.yolo = true
    else if (v === '--api') a.api = argv[++i] || ''
    else if (v === '--model') {
      const m = argv[++i] || ''
      if (m && m !== 'auto') {
        ui(gold('Nalu has exactly one model: "auto"') + ' — every request is routed to the best Nalu model automatically. Continuing with auto.\n')
      }
    } else rest.push(v)
  }
  // `nalu update` (the bare subcommand, nothing else) self-updates; anything
  // more ("nalu update the readme") is a chat prompt
  if (rest.length === 1 && rest[0] === 'update' && !a.prompt) a.update = true
  else if (!a.prompt && rest.length) a.prompt = rest.join(' ')
  return a
}

const HELP = `${bold('Nalu CLI')} v${VERSION} — Nalu in your terminal

${bold('Usage')}
  nalu                  Start an interactive session
  nalu "prompt"         Start a session with a first prompt
  nalu -p "prompt"      Non-interactive: print the answer and exit
  nalu update           Update to the latest version

${bold('Options')}
  -p, --print           Print the response and exit (good for scripts and pipes)
  --yolo                Auto-approve all shell commands and file edits
  --api <url>           Override the API base (default ${DEFAULT_API})
  --model <name>        Model selection — Nalu has exactly one: "auto"
  -v, --version         Show version
  -h, --help            Show this help

${bold('Model')}
  Nalu has a single model option: ${gold('auto')}. Every request is routed to the
  best Nalu model for the job (code, reasoning, finance, vision, …)
  automatically — there is nothing to pick or configure.

${bold('Project memory & plans')}
  Drop docs, notes, or specs into a ${gold('.nalu/')} folder in your project (and/or a
  NALU.md at the repo root) — Nalu loads them every turn and treats them as
  project documentation. Great for proprietary frameworks and niche domains.
  Plans live in ${gold('.nalu/plans/')} — Nalu writes them there (no permission
  prompt needed inside .nalu/) and keeps them updated as it executes.

${bold('In-session commands')}
  /plan <task>      Explore the code and write a step-by-step plan to .nalu/plans/
  /search <query>   Search the live web and show results right here
  /help  /model  /status  /clear  /exit
  End a line with \\ to continue typing on the next line.
  Ctrl+C interrupts a running response.
`

// ── tools ────────────────────────────────────────────────────────────────────
const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        "Run a shell command in the user's project directory and return stdout+stderr and the exit code. State (cwd, env vars) does NOT persist between calls — chain steps with && or use absolute paths. Use for running tests/builds, git, package managers, and anything a developer does in a terminal.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000, max 600000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file and return its content with line numbers. Always read a file before editing it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute, or relative to the project directory)' },
          offset: { type: 'number', description: '1-based first line to read (optional)' },
          limit: { type: 'number', description: 'Max lines to return (optional, default 2000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content (parent directories are created automatically). For small changes to an existing file prefer edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Surgical edit: replace old_string with new_string in a file. old_string must match the file EXACTLY (whitespace included) and be unique unless replace_all is true. Read the file first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries of a directory (name, type, size).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory (optional, defaults to the project root)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents with a regular expression across the project (skips .git, node_modules, build output, binaries). Returns file:line: matched text.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex (falls back to literal text if invalid)' },
          path: { type: 'string', description: 'Subdirectory to search (optional)' },
          glob: { type: 'string', description: 'Filename filter like *.ts (optional)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web. Returns titles, URLs, and snippets. Use for current information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch one web page and return its readable text.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to fetch' } },
        required: ['url'],
      },
    },
  },
]
const TOOL_NAMES = new Set(TOOL_SPECS.map((t) => t.function.name))
const SAFE_TOOLS = new Set(['read_file', 'list_dir', 'grep', 'web_search', 'fetch_url'])

const truncate = (s, n = MAX_TOOL_OUT) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s)
const resolvePath = (p) => path.resolve(process.cwd(), String(p || ''))

// ── project memory: the .nalu folder ─────────────────────────────────────────
// Docs, notes, and plans the user (or Nalu itself) drops into <project>/.nalu
// — plus NALU.md at the repo root — are loaded EVERY turn as project context.
// This is how users give Nalu proprietary/niche-domain documentation.
function gatherProjectContext() {
  const root = process.cwd()
  const parts = []
  const files = []
  let count = 0
  const addFile = (rel, cap) => {
    if (count >= 25) return
    try {
      const p = path.join(root, rel)
      const st = fs.statSync(p)
      if (!st.isFile()) return
      if (st.size > 200000) {
        files.push(`${rel} (${Math.round(st.size / 1024)} KB — large, read with read_file)`)
        return
      }
      let src = fs.readFileSync(p, 'utf8')
      if (src.includes('\u0000')) return
      count++
      files.push(rel)
      if (src.length > cap) src = src.slice(0, cap) + `\n…[truncated — read_file ${rel} for the rest]`
      parts.push(`--- ${rel} ---\n${src}`)
    } catch {}
  }
  if (fs.existsSync(path.join(root, 'NALU.md'))) addFile('NALU.md', 8000)
  const walk = (d, relBase, depth) => {
    if (depth > 2 || count >= 25) return
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = path.join(relBase, e.name)
      if (e.isDirectory()) walk(path.join(d, e.name), rel, depth + 1)
      else if (/\.(md|txt)$/i.test(e.name)) addFile(rel, 6000)
    }
  }
  walk(path.join(root, '.nalu'), '.nalu', 0)
  if (!files.length) return { doc: '', files: [] }
  let doc = parts.join('\n\n')
  if (doc.length > 24000) doc = doc.slice(0, 24000) + '\n…[project context truncated — use read_file for full files]'
  return { doc: `FILES: ${files.join(' · ')}\n\n${doc}`, files }
}

function killTree(child, sig) {
  // detached:true puts the command in its own process group — kill the group so
  // pipelines and grandchildren die too, not just /bin/bash
  try {
    process.kill(-child.pid, sig)
  } catch {
    try {
      child.kill(sig)
    } catch {}
  }
}
function runBash(command, timeoutMs, state) {
  const ms = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('/bin/bash', ['-c', command], { cwd: process.cwd(), env: process.env, detached: true })
    } catch (e) {
      resolve(`spawn error: ${e.message}`)
      return
    }
    if (state) state.currentChild = child
    let outBuf = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const cap = (d) => {
      if (outBuf.length < MAX_TOOL_OUT * 2) outBuf += d
    }
    child.stdout.on('data', cap)
    child.stderr.on('data', cap)
    let killed = false
    let done = false
    let graceT = null
    const finish = (head, code) => {
      if (done) return
      done = true
      clearTimeout(t)
      clearTimeout(graceT)
      if (state && state.currentChild === child) state.currentChild = null
      resolve(truncate(`${head}exit code: ${code}\n${outBuf.trim() ? outBuf : '(no output)'}`))
    }
    const t = setTimeout(() => {
      killed = true
      killTree(child, 'SIGKILL')
    }, ms)
    child.on('error', (e) => {
      if (!done) {
        done = true
        clearTimeout(t)
        clearTimeout(graceT)
        if (state && state.currentChild === child) state.currentChild = null
        resolve(`spawn error: ${e.message}`)
      }
    })
    const headFor = (signal) =>
      killed ? `[timed out after ${ms}ms — process group killed]\n` : signal ? `[terminated by ${signal}]\n` : ''
    // 'close' waits for stdio pipes — which a backgrounded grandchild (npm run
    // dev &) can hold open FOREVER. 'exit' fires when bash itself ends: give
    // output 1.5s to drain, then resolve regardless.
    child.on('exit', (code, signal) => {
      graceT = setTimeout(() => finish(headFor(signal), code ?? (signal ? 1 : 0)), 1500)
    })
    child.on('close', (code) => finish(headFor(null), code ?? 0))
  })
}

function toolReadFile(args) {
  const p = resolvePath(args.path)
  let src
  try {
    const st = fs.statSync(p)
    if (st.isDirectory()) return `error: ${p} is a directory — use list_dir.`
    if (st.size > 2_000_000) return `error: file is ${st.size} bytes — too large; use grep or bash (head/tail) to read parts.`
    src = fs.readFileSync(p, 'utf8')
  } catch (e) {
    return `error: cannot read ${p}: ${e.message}`
  }
  if (src.includes('\u0000')) return `error: ${p} looks binary.`
  const lines = src.split('\n')
  const offset = Math.max(1, Number(args.offset) || 1)
  const limit = Math.min(Math.max(1, Number(args.limit) || 2000), 5000)
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const body = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l}`).join('\n')
  const more = offset - 1 + limit < lines.length ? `\n…[${lines.length - (offset - 1 + limit)} more lines — use offset to continue]` : ''
  return truncate(body + more)
}

function toolWriteFile(args) {
  const p = resolvePath(args.path)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, String(args.content ?? ''))
    return `wrote ${Buffer.byteLength(String(args.content ?? ''))} bytes to ${p}`
  } catch (e) {
    return `error: cannot write ${p}: ${e.message}`
  }
}

function toolEditFile(args) {
  const p = resolvePath(args.path)
  const oldS = String(args.old_string ?? '')
  const newS = String(args.new_string ?? '')
  if (!oldS) return 'error: old_string is empty.'
  let src
  try {
    src = fs.readFileSync(p, 'utf8')
  } catch (e) {
    return `error: cannot read ${p}: ${e.message}`
  }
  const count = src.split(oldS).length - 1
  if (count === 0) return `error: old_string not found in ${p}. Read the file and copy the exact text — whitespace matters.`
  if (count > 1 && !args.replace_all)
    return `error: old_string appears ${count} times in ${p}. Add more surrounding context to make it unique, or set replace_all: true.`
  const next = args.replace_all ? src.split(oldS).join(newS) : src.replace(oldS, () => newS)
  try {
    fs.writeFileSync(p, next)
  } catch (e) {
    return `error: cannot write ${p}: ${e.message}`
  }
  return `edited ${p} (${args.replace_all ? count : 1} replacement${(args.replace_all ? count : 1) === 1 ? '' : 's'})`
}

function toolListDir(args) {
  const p = resolvePath(args.path || '.')
  let entries
  try {
    entries = fs.readdirSync(p, { withFileTypes: true })
  } catch (e) {
    return `error: cannot list ${p}: ${e.message}`
  }
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
  const lines = entries.slice(0, 500).map((e) => {
    if (e.isDirectory()) return `${e.name}/`
    let size = ''
    try {
      const st = fs.statSync(path.join(p, e.name))
      size = st.size > 1024 ? ` (${(st.size / 1024).toFixed(1)} KB)` : ` (${st.size} B)`
    } catch {}
    return `${e.name}${size}`
  })
  if (entries.length > 500) lines.push(`…[${entries.length - 500} more entries]`)
  return lines.join('\n') || '(empty directory)'
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage', 'target', 'vendor', '.venv', '__pycache__', '.turbo', 'out'])
function globToRegex(glob) {
  const re = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
  return new RegExp(`^${re}$`)
}
function toolGrep(args) {
  let re
  try {
    re = new RegExp(args.pattern)
  } catch {
    re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
  const nameFilter = args.glob ? globToRegex(args.glob) : null
  const root = resolvePath(args.path || '.')
  const matches = []
  let filesSeen = 0
  const walk = (dir, depth) => {
    if (depth > 12 || matches.length >= 200 || filesSeen > 8000) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (matches.length >= 200) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      if (nameFilter && !nameFilter.test(e.name)) continue
      filesSeen++
      let src
      try {
        if (fs.statSync(full).size > 1_500_000) continue
        src = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (src.includes('\u0000')) continue
      const lines = src.split('\n')
      for (let i = 0; i < lines.length && matches.length < 200; i++) {
        if (re.test(lines[i])) matches.push(`${path.relative(process.cwd(), full)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
      }
    }
  }
  try {
    if (fs.statSync(root).isFile()) {
      const src = fs.readFileSync(root, 'utf8')
      src.split('\n').forEach((l, i) => {
        if (matches.length < 200 && re.test(l)) matches.push(`${path.relative(process.cwd(), root)}:${i + 1}: ${l.trim().slice(0, 300)}`)
      })
    } else walk(root, 0)
  } catch (e) {
    return `error: ${e.message}`
  }
  if (!matches.length) return `no matches for /${args.pattern}/${args.glob ? ` (glob ${args.glob})` : ''}`
  return truncate(matches.join('\n') + (matches.length >= 200 ? '\n…[capped at 200 matches — narrow the pattern]' : ''))
}

async function toolWeb(apiBase, payload) {
  try {
    const r = await fetch(`${apiBase}/api/web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `nalu-cli/${VERSION}` },
      body: JSON.stringify(payload),
    })
    if (!r.ok) return `web error: HTTP ${r.status}`
    const d = await r.json().catch(() => null)
    if (!d) return 'web error: bad response'
    let text = typeof d.text === 'string' ? d.text : ''
    if (Array.isArray(d.results) && d.results.length) {
      text +=
        '\n\n' +
        d.results
          .slice(0, 8)
          .map((x) => `- ${x.title || x.url}\n  ${x.url}${x.snippet ? `\n  ${x.snippet}` : ''}`)
          .join('\n')
    }
    return truncate(text.trim() || 'no results')
  } catch (e) {
    return `web error: ${e.message}`
  }
}

/** One-line human summary of a tool call, for display. */
function toolLabel(name, args) {
  const a = args || {}
  const arg =
    name === 'bash' ? a.command : name === 'grep' ? a.pattern : name === 'web_search' ? a.query : name === 'fetch_url' ? a.url : a.path || ''
  const s = String(arg || '').replace(/\s+/g, ' ')
  return `${name}(${s.length > 80 ? s.slice(0, 77) + '…' : s})`
}

// ── recovery of tool calls the model emitted as plain text ───────────────────
// Some backing models occasionally write the call as JSON or <tag> text instead
// of the structured tool_calls field. Recover those (only for our tool names,
// so a normal JSON answer is never mistaken for a call).
function findJsonObjects(text) {
  const found = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0,
        inStr = false,
        escd = false,
        j = i
      for (; j < text.length; j++) {
        const ch = text[j]
        if (inStr) {
          if (escd) escd = false
          else if (ch === '\\') escd = true
          else if (ch === '"') inStr = false
        } else if (ch === '"') inStr = true
        else if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            found.push(text.slice(i, j + 1))
            break
          }
        }
      }
      i = j + 1
    } else i++
  }
  return found
}
function asToolCall(o, i) {
  if (!o || typeof o !== 'object') return null
  // standard OpenAI shape: {type:"function", function:{name, arguments}}
  if (o.function && typeof o.function === 'object') return asToolCall(o.function, i)
  const name = o.name ?? o.function ?? o.tool ?? o.tool_name ?? o.action
  if (typeof name !== 'string') return null
  const clean = name.replace(/^functions[.:]/, '').trim()
  if (!TOOL_NAMES.has(clean)) return null
  const args = o.arguments ?? o.params ?? o.parameters ?? o.args ?? o.input
  const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  return { id: `txt_${i}_${clean}`, type: 'function', function: { name: clean, arguments: argStr } }
}
function primaryOf(name) {
  const spec = TOOL_SPECS.find((t) => t.function.name === name)
  if (!spec) return 'query'
  return (spec.function.parameters.required || [])[0] || Object.keys(spec.function.parameters.properties || {})[0] || 'query'
}
// Parse a recovered call's payload into an args map: JSON {…}, one quoted
// positional string, or key="value" kwargs.
function parseToolArgs(inside, primary) {
  const args = {}
  const s = inside.trim()
  if (!s) return args
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s)
      // keep primitives as-is (replace_all:false must STAY false); only
      // stringify nested objects/arrays
      for (const [k, v] of Object.entries(o)) args[k] = v === null || ['string', 'boolean', 'number'].includes(typeof v) ? v : JSON.stringify(v)
      return args
    } catch {
      /* fall through */
    }
  }
  if (/^(["'])[\s\S]*\1$/.test(s)) {
    args[primary] = s.slice(1, -1).replace(/\\(["'\\])/g, '$1')
    return args
  }
  const kw = [...s.matchAll(/(\w+)\s*[=:]\s*["']([^"']*)["']/g)]
  if (kw.length) {
    for (const k of kw) args[k[1]] = k[2]
    return args
  }
  args[primary] = s.replace(/^["']|["']$/g, '')
  return args
}
function recoverToolCalls(text) {
  const calls = []
  if (!text) return { calls, cleaned: text }
  // fast-path bail only when NONE of the recoverable forms can be present:
  // JSON/paren/tag ({ < ( " '), a fenced block (`), or a bare shell label line.
  if (!/[{<("'`]/.test(text) && !/(^|\n)[ \t]*(?:bash|sh|shell|zsh|\$)[ \t]*\n/i.test(text)) return { calls, cleaned: text }
  let cleaned = text
  // <tool_name>…</tool_name> — the closing tag is REQUIRED: an unterminated
  // tag usually means a truncated stream or a prose mention, and executing a
  // half-received command (e.g. "<bash>rm -rf /…" cut mid-path) is catastrophic
  for (const name of TOOL_NAMES) {
    const re = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i')
    const m = re.exec(cleaned)
    if (m && m[1].trim()) {
      const inner = m[1].trim()
      const argStr = inner.startsWith('{') ? inner : JSON.stringify({ [primaryOf(name)]: inner })
      calls.push({ id: `txt_${calls.length}_${name}`, type: 'function', function: { name, arguments: argStr } })
      cleaned = cleaned.replace(m[0], '').trim()
    }
  }
  // fenced ```json blocks, then bare {...} objects anywhere
  const blocks = []
  const fence = /```(?:json|tool_call|tool|function)?\s*([\s\S]*?)```/gi
  let fm
  while ((fm = fence.exec(cleaned))) blocks.push({ raw: fm[0], body: fm[1].trim() })
  for (const raw of findJsonObjects(cleaned)) blocks.push({ raw, body: raw })
  for (const blk of blocks) {
    let parsed
    try {
      parsed = JSON.parse(blk.body)
    } catch {
      continue
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    let any = false
    for (const o of arr) {
      const tc = asToolCall(o, calls.length)
      if (tc) {
        calls.push(tc)
        any = true
      }
    }
    if (any) cleaned = cleaned.split(blk.raw).join(' ').trim()
  }
  // name-prefixed calls in whatever bracketing the model invents:
  // bash("npm test") | edit_file({...}) | grep{"pattern":"x"} | fetch_url "https://…"
  // (this is how the backing model most often writes calls — inside a code fence)
  for (const name of TOOL_NAMES) {
    const primary = primaryOf(name)
    const nameRe = new RegExp(`\\b${name}\\b`, 'g')
    let nm
    while ((nm = nameRe.exec(cleaned))) {
      // inside a JSON string ("name":"bash") — not a name-prefixed call; the
      // JSON pass owns that form (and if its JSON was malformed, skipping here
      // is what lets the no-call nudge ask the model to retry cleanly)
      const prev = cleaned[nm.index - 1]
      if (prev === '"' || prev === "'") continue
      // the opener must come IMMEDIATELY after the name, code-style —
      // list_dir("/tmp") is a call, but prose like `use bash (see docs)` or
      // `run grep "TODO" yourself` must never execute
      const k = nm.index + name.length
      const opener = cleaned[k]
      let end = -1
      let inside = ''
      if (opener === '(' || opener === '{') {
        const close = opener === '(' ? ')' : '}'
        let depth = 0,
          inStr = false,
          escd = false,
          j = k
        for (; j < cleaned.length; j++) {
          const ch = cleaned[j]
          if (inStr) {
            if (escd) escd = false
            else if (ch === '\\') escd = true
            else if (ch === inStr) inStr = false
          } else if (ch === '"' || ch === "'") inStr = ch
          else if (ch === opener) depth++
          else if (ch === close) {
            depth--
            if (depth === 0) {
              j++
              break
            }
          }
        }
        if (depth !== 0) continue // unbalanced — still streaming or not a call
        end = j
        inside = opener === '{' ? cleaned.slice(k, end) : cleaned.slice(k + 1, end - 1)
      } else continue // no ( or { directly after the name — prose, not a call
      // (a bare-quote form like `bash "npm test"` is deliberately NOT
      // recovered: it matches warnings and suggestions in prose far too often)
      const args = parseToolArgs(inside, primary)
      if (!Object.keys(args).length) continue
      let start = nm.index
      const pre = cleaned.slice(Math.max(0, start - 16), start)
      const km = pre.match(/(?:tool_call|function_call|invoke)[\s:]*$/i)
      if (km) start -= km[0].length
      calls.push({ id: `txt_${calls.length}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
      cleaned = (cleaned.slice(0, start) + ' ' + cleaned.slice(end)).replace(/[ \t]{2,}/g, ' ')
      nameRe.lastIndex = start
    }
  }
  // 5) SHELL form: the model very often writes a bash command NOT as a call but
  //    as a fenced ```bash block or a bare "bash" label line followed by the raw
  //    command. This is the #1 real-world stall. Recover it — but ONLY when no
  //    structured call was found above (proper calls always win) AND the reply
  //    shows action intent, so an illustrative block in a prose answer isn't run.
  //    bash stays permission-gated, so a non-yolo user still confirms it.
  if (!calls.length) {
    let cmd = null
    let raw = null
    const fence = /```(?:bash|sh|shell|console|zsh|shell-script)[ \t]*\n([\s\S]*?)```/i.exec(cleaned)
    if (fence && fence[1].trim()) {
      cmd = fence[1].trim()
      raw = fence[0]
    } else {
      // bare label: a line that is exactly bash/sh/shell/$, then command line(s)
      const bare = /(^|\n)[ \t]*(?:bash|sh|shell|zsh|\$)[ \t]*\n((?:[ \t]*\$?[^\n`]+\n?){1,20})/i.exec(cleaned)
      if (bare && bare[2].trim()) {
        cmd = bare[2].trim()
        raw = bare[0]
      }
    }
    if (cmd) {
      // strip a leading "$ " shell prompt from each line
      cmd = cmd
        .split('\n')
        .map((l) => l.replace(/^[ \t]*\$[ \t]+/, ''))
        .join('\n')
        .trim()
      const before = raw ? cleaned.slice(0, cleaned.indexOf(raw)) : cleaned
      const short = cleaned.replace(/```[\s\S]*?```/g, '').trim().length < 500
      if (cmd && (short || announcesIntent(before.trim()))) {
        calls.push({ id: `txt_${calls.length}_bash`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) } })
        cleaned = cleaned.replace(raw, ' ').trim()
      }
    }
  }
  cleaned = cleaned.replace(/```(?:python|py|json|tool|bash|sh)?\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim()
  // when calls were recovered, also drop stray fence-language label lines the
  // model left behind ("json"/"bash" on its own line before the call payload)
  if (calls.length) cleaned = cleaned.replace(/^[ \t]*(?:json|python|py|tool|tool_call|function|bash|sh|shell)[ \t]*$/gim, '').replace(/\n{3,}/g, '\n\n').trim()
  return { calls, cleaned }
}

// ── lightweight streaming Markdown → ANSI renderer ───────────────────────────
function renderInline(line) {
  if (!TTY) return line
  let s = line
  s = s.replace(/`([^`]+)`/g, (_, c) => cyan(c))
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => bold(c))
  s = s.replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|[.,;:!?)]|$)/g, (_, pre, c) => pre + italic(c))
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${t} ${dim(`(${u})`)}`)
  if (/^#{1,6}\s/.test(s)) s = bold(s.replace(/^#{1,6}\s*/, ''))
  else if (/^\s*[-*]\s/.test(s)) s = s.replace(/^(\s*)[-*]\s/, `$1${gold('·')} `)
  else if (/^\s*\d+\.\s/.test(s)) s = s.replace(/^(\s*)(\d+)\.\s/, (_, sp, n) => `${sp}${gold(n + '.')} `)
  return s
}
// Fence languages the backing model wraps TOOL CALLS in — hold these blocks
// until they close, and only render them if they turn out NOT to be tool calls
// (otherwise the raw call JSON would stream into the answer before every
// "● tool(…)" line). Real code fences (js, ts, bash, …) still stream live.
const HOLD_LANGS = /^(json|tool|tool_call|function|python|py)\s*$/i
function makeRenderer(write) {
  let buf = ''
  let inCode = false
  let holding = false
  let held = ''
  const renderCodeLine = (l) => write(gray('  ' + l) + '\n')
  const releaseHeld = () => {
    // fence turned out to be real content — render it now, block-style
    const lines = held.replace(/\n$/, '').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 || (i === lines.length - 1 && /^\s*```/.test(lines[i]))) write(dim(lines[i]) + '\n')
      else renderCodeLine(lines[i])
    }
    holding = false
    held = ''
  }
  let pendingLabel = null // a bare "json"/"python" label line — the model often
  // writes its fence language WITHOUT backticks right before a bare JSON call
  // Holding a MULTI-LINE bare JSON object (pretty-printed tool calls stream as
  // many lines, so the single-line suppressor below misses them).
  let jsonHold = null
  let jsonDepth = 0
  const netBraces = (s) => {
    let d = 0
    let inStr = false
    let escd = false
    for (const ch of s) {
      if (inStr) {
        if (escd) escd = false
        else if (ch === '\\') escd = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === '{') d++
      else if (ch === '}') d--
    }
    return d
  }
  const flushJson = () => {
    const held = jsonHold
    jsonHold = null
    jsonDepth = 0
    if (recoverToolCalls(held).calls.length) return // it was a tool call → the "● tool(…)" line shows instead
    for (const hl of held.replace(/\n$/, '').split('\n')) write(renderInline(hl) + '\n')
  }
  const line = (l) => {
    if (jsonHold !== null) {
      jsonHold += l + '\n'
      jsonDepth += netBraces(l)
      if (jsonDepth <= 0 || jsonHold.length > 16000 || jsonHold.split('\n').length > 80) flushJson()
      return
    }
    if (pendingLabel !== null) {
      const lbl = pendingLabel
      pendingLabel = null
      if (/^\s*\{[\s\S]*\}\s*$/.test(l) && recoverToolCalls(l).calls.length) return // label + call → drop both
      if (!inCode && /^\s*\{\s*$/.test(l)) { jsonHold = l + '\n'; jsonDepth = netBraces(l); return } // label + start of multi-line call
      write(renderInline(lbl) + '\n') // was a real content line after all
    }
    if (!inCode && /^[ \t]*(?:json|python|py|tool|tool_call|function)[ \t]*$/i.test(l)) {
      pendingLabel = l
      return
    }
    if (/^\s*```/.test(l)) {
      if (!inCode) {
        inCode = true
        const lang = (l.match(/^\s*```(.*)$/) || [])[1] || ''
        if (HOLD_LANGS.test(lang.trim())) {
          holding = true
          held = l + '\n'
          return
        }
        write(dim(l) + '\n')
      } else {
        inCode = false
        if (holding) {
          held += l + '\n'
          if (recoverToolCalls(held).calls.length) {
            holding = false
            held = '' // it's a tool call — the "● tool(…)" line will show instead
          } else releaseHeld()
          return
        }
        write(dim(l) + '\n')
      }
      return
    }
    if (inCode) {
      if (holding) {
        held += l + '\n'
        return
      }
      renderCodeLine(l)
      return
    }
    // a complete bare JSON tool call on one line (the instructed fallback
    // format) — suppress it the same way
    if (/^\s*\{[\s\S]*\}\s*$/.test(l) && recoverToolCalls(l).calls.length) return
    // start of a MULTI-LINE bare JSON object → hold it (likely a pretty-printed
    // tool call; flushed as real content if it turns out not to be one)
    if (/^\s*\{\s*$/.test(l) || (/^\s*\{/.test(l) && netBraces(l) > 0)) {
      jsonHold = l + '\n'
      jsonDepth = netBraces(l)
      return
    }
    write(renderInline(l) + '\n')
  }
  return {
    feed(t) {
      buf += t
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        line(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    },
    flush() {
      if (buf) {
        line(buf)
        buf = ''
      }
      if (jsonHold !== null) flushJson() // never swallow a held object at EOF
      if (pendingLabel !== null) {
        // stream ended right at the label — if a call follows in the unstreamed
        // tail it was already handled; a lone trailing label is call syntax noise
        pendingLabel = null
      }
      if (holding && held) {
        if (!recoverToolCalls(held).calls.length) releaseHeld()
        holding = false
        held = ''
      }
      inCode = false
    },
  }
}

function makeSpinner(text) {
  // no text → wolf mode: a fresh wolfism every couple of seconds while loading
  if (!TTY || PRINT_MODE) return { stop() {} }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  let phrase = text || wolfism()
  let phraseAt = Date.now()
  const t = setInterval(() => {
    if (!text && Date.now() - phraseAt > 2200) {
      phrase = wolfism()
      phraseAt = Date.now()
    }
    process.stdout.write('\r\x1b[2K' + dim(frames[i++ % frames.length]) + ' ' + goldDim(phrase))
  }, 80)
  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(t)
      process.stdout.write('\r\x1b[2K')
    },
  }
}

// ── one streamed model turn ──────────────────────────────────────────────────
async function streamOnce(state, renderer) {
  const body = {
    messages: state.messages,
    tools: TOOL_SPECS,
    cli: true,
    cwd: process.cwd(),
    repo: path.basename(process.cwd()),
    ...(state.branch ? { branch: state.branch } : {}),
    ...(state.projectDoc ? { projectDoc: state.projectDoc } : {}),
  }
  const ac = new AbortController()
  state.abort = ac
  let idleTimer = null
  const bumpIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      try {
        ac.abort()
      } catch {}
    }, 180000)
  }
  const spinner = makeSpinner() // wolf mode — rotating wolfisms while loading
  let spinning = true
  const stopSpin = () => {
    if (spinning) {
      spinning = false
      spinner.stop()
    }
  }
  let res
  try {
    bumpIdle()
    res = await fetch(`${state.api}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `nalu-cli/${VERSION}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(idleTimer)
    stopSpin()
    state.abort = null
    return { text: '', toolCalls: [], error: ac.signal.aborted ? 'interrupted' : `network error: ${e.message}` }
  }
  if (!res.ok || !res.body) {
    clearTimeout(idleTimer)
    stopSpin()
    state.abort = null
    return { text: '', toolCalls: [], error: `server error: HTTP ${res.status}` }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let event = ''
  let text = ''
  let errMsg = ''
  let finished = '' // finish_reason if the stream completed cleanly
  const calls = {}
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bumpIdle()
      buf += decoder.decode(chunk.value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const lineRaw = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (lineRaw.startsWith('event:')) {
          event = lineRaw.slice(6).trim()
          continue
        }
        if (!lineRaw.startsWith('data:')) continue
        let data = {}
        try {
          data = JSON.parse(lineRaw.slice(5).trim())
        } catch {
          continue
        }
        if (event === 'route' && typeof data.name === 'string') {
          if (data.name !== state.lastRoute) {
            state.lastRoute = data.name
            stopSpin()
            ui(dim(`◆ ${data.name}\n`))
          }
        } else if (event === 'delta' && typeof data.text === 'string') {
          stopSpin()
          text += data.text
          renderer.feed(data.text)
        } else if (event === 'tool_call_delta') {
          const i = data.index ?? 0
          if (!calls[i]) calls[i] = { id: data.id || `call_${i}`, type: 'function', function: { name: '', arguments: '' } }
          if (data.id) calls[i].id = data.id
          if (data.name) calls[i].function.name += data.name
          if (data.arguments) calls[i].function.arguments += data.arguments
        } else if (event === 'finish' && typeof data.reason === 'string') {
          finished = data.reason
        } else if (event === 'error' && typeof data.message === 'string') {
          errMsg = data.message
        }
      }
    }
  } catch {
    /* aborted or stream error — return what we have */
  } finally {
    clearTimeout(idleTimer)
    stopSpin()
    state.abort = null
  }
  renderer.flush()
  const toolCalls = Object.values(calls).filter((c) => c.function.name)
  return { text, toolCalls, error: errMsg, finished }
}

// ── permissions ──────────────────────────────────────────────────────────────
/** Ask one line on the shared readline, abortable via state.permAbort (Ctrl+C
 *  while a permission prompt is pending resolves as "n"). */
function askLine(state, query) {
  return new Promise((resolve) => {
    const ac = new AbortController()
    state.permAbort = ac
    ac.signal.addEventListener('abort', () => resolve('n'), { once: true })
    state.rl.question(query, { signal: ac.signal }, (ans) => {
      state.permAbort = null
      resolve(ans)
    })
  })
}

/** The FULL operation, shown before the y/n prompt — the one-line label is
 *  truncated, and nobody should approve a command they can't see. */
function permissionDetails(name, args) {
  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + `\n  …[${String(s).length - n} more chars]` : String(s))
  if (name === 'bash') {
    const cmd = String(args.command || '')
    if (cmd.length <= 64 && !cmd.includes('\n')) return '' // the label already shows it all
    return clip(cmd, 2000)
  }
  if (name === 'write_file') {
    const content = String(args.content ?? '')
    const head = content.split('\n').slice(0, 8).join('\n')
    return `${args.path} ← ${Buffer.byteLength(content)} bytes:\n${clip(head, 800)}`
  }
  if (name === 'edit_file') {
    const oldS = String(args.old_string ?? '')
    const newS = String(args.new_string ?? '')
    return `${args.path}${args.replace_all ? ' (replace ALL)' : ''}\n- ${clip(oldS.split('\n').slice(0, 6).join('\n- '), 600)}\n+ ${clip(newS.split('\n').slice(0, 6).join('\n+ '), 600)}`
  }
  return ''
}

async function askPermission(state, name, label, args) {
  if (state.yolo) return true
  if (PRINT_MODE) return false // non-interactive: mutating tools need --yolo
  const details = permissionDetails(name, args)
  if (details) ui(dim(details.split('\n').map((l) => `    ${l}`).join('\n')) + '\n')
  for (;;) {
    const a = (await askLine(state, `  ${gold('└')} allow ${bold(label)}? ${dim(`[y]es · [a]lways allow ${name} this session · [n]o`)} `))
      .trim()
      .toLowerCase()
    if (state.interrupted) return false
    if (a === 'y' || a === 'yes' || a === '') return true
    if (a === 'a' || a === 'always') {
      state.sessionAllow.add(name)
      ui(dim(`    (auto-approving ${name} for the rest of this session)`) + '\n')
      return true
    }
    if (a === 'n' || a === 'no') return false
  }
}

async function execTool(state, call) {
  const name = call.function.name
  if (!TOOL_NAMES.has(name))
    return `Unknown tool "${name}". The ONLY available tools are: ${[...TOOL_NAMES].join(', ')}. Use one of those.`

  // Normalize arguments — and NEVER execute malformed/truncated JSON: a stream
  // that died mid-arguments must not become a literal bash command.
  const rawArgs = call.function.arguments || ''
  let args = {}
  try {
    const parsed = JSON.parse(rawArgs || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    else if (typeof parsed === 'string' && parsed.trim()) args = { [primaryOf(name)]: parsed }
    else {
      ui(`${cyan('●')} ${name}(${dim('invalid arguments')})\n`)
      return `error: ${name} arguments must be a JSON object like {"name":"${name}","arguments":{…}} — got ${Array.isArray(parsed) ? 'an array' : typeof parsed}. Re-issue the call correctly. It was NOT executed.`
    }
  } catch {
    const t = rawArgs.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      ui(`${cyan('●')} ${name}(${dim('malformed/truncated arguments')})\n`)
      return `error: the ${name} arguments were malformed or truncated JSON and the call was NOT executed. Re-issue the complete call.`
    }
    if (t) args = { [primaryOf(name)]: t } // a plain bare-string argument
  }

  // Models frequently invent argument aliases (file_path, cmd, q…) — map them
  // onto the canonical names instead of failing the call.
  const ALIASES = {
    file_path: 'path', filepath: 'path', filename: 'path', file: 'path', directory: 'path', dir: 'path',
    text: 'content', contents: 'content', body: 'content', data: 'content',
    cmd: 'command', script: 'command', shell_command: 'command',
    q: 'query', search: 'query', search_query: 'query',
    link: 'url', regex: 'pattern', search_pattern: 'pattern',
    old_str: 'old_string', new_str: 'new_string', old_text: 'old_string', new_text: 'new_string', old: 'old_string', new: 'new_string',
  }
  for (const [from, to] of Object.entries(ALIASES))
    if (args[from] !== undefined && args[to] === undefined) {
      args[to] = args[from]
      delete args[from]
    }
  // Missing required args → tell the model exactly what to fix (a permission
  // denial here would just confuse it into giving up).
  const spec = TOOL_SPECS.find((t) => t.function.name === name)
  const required = spec.function.parameters.required || []
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '')
  if (missing.length) {
    ui(`${cyan('●')} ${name}(${dim(`missing ${missing.join(', ')}`)})\n`)
    return `error: ${name} requires {${required.join(', ')}} but the call was missing ${missing.join(', ')} (received keys: ${JSON.stringify(Object.keys(args))}). Re-issue the call with every required argument. It was NOT executed.`
  }

  const label = toolLabel(name, args)
  ui(`${cyan('●')} ${label}\n`)

  // writes inside the project's .nalu/ folder (plans, notes Nalu keeps) are
  // auto-approved — that's Nalu's own scratch space, and gating it would make
  // every /plan round-trip nag the user
  const naluDir = path.join(process.cwd(), '.nalu') + path.sep
  const inNaluDir = (name === 'write_file' || name === 'edit_file') && resolvePath(args.path || '').startsWith(naluDir)
  if (!SAFE_TOOLS.has(name) && !state.sessionAllow.has(name) && !inNaluDir) {
    const ok = await askPermission(state, name, label, args)
    if (!ok) {
      ui(dim('  └ denied\n'))
      return PRINT_MODE
        ? 'The user is running in non-interactive mode and this action was not pre-approved (needs --yolo). Do not retry it — finish with what you can do read-only, or tell the user what to run.'
        : 'The user declined this action. Do not retry it — ask what they would like instead, or take a different approach.'
    }
  }

  let result
  if (name === 'bash') {
    const cmd = String(args.command || '').trim()
    result = cmd ? await runBash(cmd, args.timeout_ms, state) : 'error: bash was called with an empty command — provide {"command":"…"}.'
  }
  else if (name === 'read_file') result = toolReadFile(args)
  else if (name === 'write_file') result = toolWriteFile(args)
  else if (name === 'edit_file') result = toolEditFile(args)
  else if (name === 'list_dir') result = toolListDir(args)
  else if (name === 'grep') result = toolGrep(args)
  else if (name === 'web_search') result = await toolWeb(state.api, { action: 'search', query: String(args.query || '') })
  else if (name === 'fetch_url') result = await toolWeb(state.api, { action: 'fetch', url: String(args.url || '') })
  else result = 'tool not implemented'

  // short dim preview so the user can follow along
  const preview = String(result).split('\n').slice(0, 4)
  const extra = String(result).split('\n').length - preview.length
  ui(dim(preview.map((l) => `  ${l.slice(0, 160)}`).join('\n') + (extra > 0 ? `\n  … +${extra} lines` : '') + '\n'))
  return String(result)
}

// ── history management ───────────────────────────────────────────────────────
function msgSize(m) {
  return (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)
}
function trimHistory(msgs) {
  let total = msgs.reduce((a, m) => a + msgSize(m), 0)
  if (total <= HISTORY_CHAR_BUDGET) return
  // 1) Compact OLD tool outputs first (they are the bulk of an agent session),
  //    sparing the 4 most recent so the model keeps its working context. This
  //    preserves the message structure — no orphaned tool_call pairs.
  const toolIdxs = []
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === 'tool') toolIdxs.push(i)
  for (const i of toolIdxs.slice(0, Math.max(0, toolIdxs.length - 4))) {
    if (total <= HISTORY_CHAR_BUDGET) return
    if (typeof msgs[i].content === 'string' && msgs[i].content.length > 80) {
      total -= msgs[i].content.length - 42
      msgs[i] = { ...msgs[i], content: '[old tool output trimmed to save context]' }
    }
  }
  if (total <= HISTORY_CHAR_BUDGET) return
  // 2) Drop whole leading TURNS (from the head up to the next user message) —
  //    never the turn containing the last user message, and never a partial
  //    turn: history must always start at a user message.
  let lastUser = 0
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i].role === 'user') {
      lastUser = i
      break
    }
  while (total > HISTORY_CHAR_BUDGET) {
    let next = -1
    for (let i = 1; i <= lastUser; i++)
      if (msgs[i].role === 'user') {
        next = i
        break
      }
    if (next === -1) break // only the current turn remains — keep it whole
    for (let i = 0; i < next; i++) total -= msgSize(msgs[i])
    msgs.splice(0, next)
    lastUser -= next
  }
}

// True when a no-tool-call reply is really a stalled ANNOUNCEMENT of an action
// (intent to explore/edit/run) rather than a finished answer. Robust to the
// sentence ending in any punctuation — the original bug was requiring the intent
// phrase to sit at the very end with no trailing '.'/'!'/'?'.
function announcesIntent(t) {
  if (!t) return true // empty reply mid-task → definitely nudge
  if (t.length > 1500) return false // long structured replies are real answers
  // a completed, substantive code block or a saved-file confirmation is a deliverable
  if (/```[\s\S]*\n[\s\S]*```/.test(t)) return false
  // ends with a colon → classic "Let me explore:" stall
  if (/[:：]\s*$/.test(t)) return true
  // look at the LAST sentence/line for forward-looking intent
  const tail = (t.split(/\n/).filter((l) => l.trim()).pop() || '').trim()
  const intent =
    /\b(let me|lets|let's|i['’]?ll|i will|i['’]?m going to|i am going to|i['’]?d|going to|i need to|i should|first[, ]|next[, ]|now (?:i|let|i['’]?ll)|start(?:ing)? by|begin(?:ning)? by|let me (?:start|begin|first)|i['’]?ll go ahead|here['’]?s (?:my|the) plan|let me know what|to (?:do|get|start|begin) (?:this|that)|proceed(?:ing)? to)\b/i
  if (!intent.test(tail)) return false
  // "let me know if you have questions" is a closer, not a stall
  if (/\blet me know\b/i.test(tail) && !/\blet me know what (?:files|to|you)/i.test(tail)) return false
  return true
}

// ── drag-and-drop file paths ─────────────────────────────────────────────────
// Dragging a file into the terminal pastes its absolute path — quoted, or with
// backslash-escaped spaces (Terminal.app/iTerm style). Detect real paths in the
// message and attach their contents so the model can work off them immediately.
function extractDroppedPaths(input) {
  const candidates = []
  for (const m of input.matchAll(/'((?:\/|~\/)[^']+)'|"((?:\/|~\/)[^"]+)"/g)) candidates.push(m[1] || m[2])
  for (const m of input.matchAll(/(?:^|\s)((?:\/|~\/)(?:\\[ ()&']|[^\s'"“”])+)/g)) candidates.push(m[1].replace(/\\([ ()&'])/g, '$1'))
  const found = []
  const seen = new Set()
  for (let p of candidates) {
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
    p = p.replace(/[.,;:!?]+$/, '') // trailing sentence punctuation isn't part of a path
    if (seen.has(p)) continue
    try {
      const st = fs.statSync(p)
      seen.add(p)
      found.push({ p, dir: st.isDirectory(), size: st.size })
    } catch {}
    if (found.length >= 6) break
  }
  return found
}

function attachDroppedFiles(userText) {
  const dropped = extractDroppedPaths(userText)
  if (!dropped.length) return userText
  let block = ''
  let budget = 48000
  for (const f of dropped) {
    if (f.dir) {
      ui(dim(`◆ attached folder: ${f.p}\n`))
      block += `\n\n[attached folder: ${f.p}]\n${toolListDir({ path: f.p }).slice(0, 2000)}`
      continue
    }
    let note = ''
    let body = ''
    if (f.size > 400000) note = `(${Math.round(f.size / 1024)} KB — too large to inline; read parts with read_file/grep)`
    else {
      try {
        const src = fs.readFileSync(f.p, 'utf8')
        if (src.includes('\u0000')) note = '(binary file — not inlined)'
        else {
          body = src.slice(0, Math.min(20000, Math.max(0, budget)))
          budget -= body.length
          if (body.length < src.length) note = `(first ${body.length} chars of ${src.length} — use read_file for the rest)`
        }
      } catch (e) {
        note = `(could not read: ${e.message})`
      }
    }
    ui(dim(`◆ attached: ${f.p} (${f.size > 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`})\n`))
    block += `\n\n[attached file: ${f.p} ${note}]${body ? `\n\`\`\`\n${body}\n\`\`\`` : ''}`
  }
  return userText + block
}

// ── the agent loop for one user input ────────────────────────────────────────
async function runTurn(state, userText) {
  // refresh project memory each turn so docs/plans written mid-session (or by
  // the user in another window) are visible on the very next message
  state.projectDoc = gatherProjectContext().doc
  userText = attachDroppedFiles(userText) // dragged-in paths → inline the file
  state.messages.push({ role: 'user', content: userText })
  state.interrupted = false
  state.hadError = false
  state.nudges = 0
  state.busy = true
  try {
    await runTurnInner(state)
  } finally {
    state.busy = false
  }
}
async function runTurnInner(state) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const renderer = makeRenderer(out)
    const r = await streamOnce(state, renderer)
    if (state.interrupted || r.error === 'interrupted') {
      ui(dim('\n(interrupted)\n'))
      if (r.text) state.messages.push({ role: 'assistant', content: r.text })
      return
    }
    if (r.error && !r.text && !r.toolCalls.length) {
      ui(red(`\n${r.error}\n`))
      state.hadError = true
      // keep history consistent: record that the turn failed
      state.messages.push({ role: 'assistant', content: `(error: ${r.error})` })
      return
    }
    // an error event AFTER partial output means the reply may be incomplete —
    // say so instead of silently presenting it as finished
    if (r.error) ui(dim(`\n(server note: ${r.error} — the reply above may be incomplete)\n`))
    let calls = r.toolCalls
    let text = r.text
    if (!calls.length && text) {
      const rec = recoverToolCalls(text)
      if (rec.calls.length) {
        calls = rec.calls
        text = rec.cleaned
      }
    }
    if (!calls.length) {
      // The model sometimes ANNOUNCES an action ("Let me start by exploring the
      // files.") and stops without calling anything — DeepSeek narrates instead
      // of emitting a tool call. Detect that and nudge it to actually act. We
      // allow a few nudges per turn (a stubborn model may need more than one),
      // capped so a model with genuinely nothing to do can't loop forever.
      const t = (text || '').trim()
      if (announcesIntent(t) && (state.nudges || 0) < 3) {
        state.nudges = (state.nudges || 0) + 1
        state.messages.push({ role: 'assistant', content: t || '(no response)' })
        state.messages.push({
          role: 'user',
          content:
            '(system note: you described what you were going to do but did not actually call a tool, so nothing happened. Make the next tool call NOW to carry it out — do not describe it, call it. If the task is genuinely complete, give the final answer with no "let me…"/"I\'ll…" phrasing.)',
        })
        continue
      }
      state.messages.push({ role: 'assistant', content: text || '(no response)' })
      trimHistory(state.messages)
      return
    }
    state.messages.push({ role: 'assistant', content: text || null, tool_calls: calls })
    for (const c of calls) {
      if (state.interrupted) {
        state.messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: 'interrupted by the user before this tool ran' })
        continue
      }
      const result = await execTool(state, c)
      state.messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: result })
    }
    if (state.interrupted) {
      ui(dim('\n(interrupted)\n'))
      return
    }
    trimHistory(state.messages)
  }
  ui(dim(`\nreached the ${MAX_STEPS}-step limit for one request — ask me to continue if there is more to do.\n`))
}

// ── self-update ──────────────────────────────────────────────────────────────
async function selfUpdate(apiBase) {
  const self = fs.realpathSync(process.argv[1])
  process.stderr.write(`Updating Nalu CLI from ${apiBase}/nalu.mjs …\n`)
  const r = await fetch(`${apiBase}/nalu.mjs`, { headers: { 'User-Agent': `nalu-cli/${VERSION}` } })
  if (!r.ok) {
    process.stderr.write(`update failed: HTTP ${r.status}\n`)
    process.exit(1)
  }
  const code = await r.text()
  if (!code.startsWith('#!/usr/bin/env node') || !code.includes('Nalu CLI')) {
    process.stderr.write('update failed: downloaded file does not look like the Nalu CLI.\n')
    process.exit(1)
  }
  const m = code.match(/const VERSION = '([^']+)'/)
  const next = m ? m[1] : '?'
  // atomic swap — a failed write must never brick the live install
  const tmp = `${self}.tmp-${process.pid}`
  fs.writeFileSync(tmp, code)
  fs.renameSync(tmp, self)
  process.stderr.write(`Nalu CLI ${VERSION} → ${next} (${self})\n`)
  process.exit(0)
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.version) {
    console.log(`nalu ${VERSION}`)
    return
  }
  if (args.help) {
    console.log(HELP)
    return
  }
  const config = loadConfig()
  const api = (args.api || process.env.NALU_API_URL || config.api || DEFAULT_API).replace(/\/+$/, '')
  if (args.update) {
    await selfUpdate(api)
    return
  }
  PRINT_MODE = args.print

  let branch = ''
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {}

  const state = {
    api,
    messages: [],
    branch,
    yolo: args.yolo,
    sessionAllow: new Set(),
    lastRoute: '',
    abort: null,
    currentChild: null,
    permAbort: null,
    busy: false,
    interrupted: false,
    hadError: false,
    rl: null,
  }

  // Ctrl+C while working: stop the stream, kill any running tool child (and
  // its process group), cancel a pending permission prompt — but keep the
  // session alive. Only exit when idle at the prompt.
  const interruptNow = () => {
    state.interrupted = true
    if (state.abort) {
      try {
        state.abort.abort()
      } catch {}
    }
    if (state.currentChild) killTree(state.currentChild, 'SIGTERM')
    if (state.permAbort) {
      try {
        state.permAbort.abort()
      } catch {}
    }
  }
  const onSigint = () => {
    if (state.busy || state.abort || state.currentChild) {
      interruptNow()
    } else if (PRINT_MODE) {
      process.exit(130)
    }
  }
  process.on('SIGINT', onSigint)

  // ── print mode: one turn, answer to stdout, exit ──
  if (PRINT_MODE) {
    let prompt = args.prompt
    if (!process.stdin.isTTY) {
      // Read piped input — but NEVER hang on a non-TTY stdin that stays open
      // without sending anything (some shells/CI leave it that way): if no
      // bytes arrive within 300ms, proceed without stdin.
      const piped = await new Promise((resolve) => {
        let s = ''
        let got = false
        const timer = setTimeout(() => {
          if (!got) {
            process.stdin.pause()
            resolve('')
          }
        }, 300)
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (d) => {
          got = true
          s += d
        })
        process.stdin.on('end', () => {
          clearTimeout(timer)
          resolve(s)
        })
        process.stdin.on('error', () => {
          clearTimeout(timer)
          resolve(s)
        })
      })
      if (piped.trim()) prompt = `${prompt ? prompt + '\n\n' : ''}Input:\n\`\`\`\n${piped.slice(0, 100000)}\n\`\`\``
    }
    if (!prompt.trim()) {
      console.error('nothing to do: nalu -p "your prompt"')
      process.exit(1)
    }
    await runTurn(state, prompt)
    out('\n')
    if (state.interrupted) process.exitCode = 130
    else if (state.hadError) process.exitCode = 1 // scripts must see failures
    return
  }

  // ── interactive session ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  state.rl = rl
  rl.on('SIGINT', () => {
    if (state.busy || state.abort || state.currentChild) {
      interruptNow()
      out('\n')
    } else {
      out('\n' + dim('bye') + '\n')
      process.exit(0)
    }
  })

  const cwdShort = process.cwd().replace(os.homedir(), '~')
  const projFiles = gatherProjectContext().files
  if (TTY) out('\n' + WOLF_HEAD.map((l) => gold('   ' + l)).join('\n') + '\n')
  out('\n' + gold(bold(`◆ Nalu`)) + dim(` CLI v${VERSION}`) + dim(' · model: ') + gold('auto') + dim(' (routes itself)') + '\n')
  out(dim(`  ${cwdShort}${branch ? ` · ${branch}` : ''}${projFiles.length ? ` · ${projFiles.length} doc${projFiles.length === 1 ? '' : 's'} from .nalu` : ''}`) + '\n')
  out(dim('  /help commands · /plan to plan · /search the web · Ctrl+C interrupts') + '\n')
  out(goldDim(`  ${wolfism().replace(/…$/, '')} — ready.`) + '\n\n')

  const question = () =>
    new Promise((resolve) => rl.question(gold('❯ '), resolve))

  let pending = args.prompt || ''
  for (;;) {
    let input = pending || (await question())
    pending = ''
    // backslash continuation for multi-line input
    while (input.endsWith('\\')) {
      input = input.slice(0, -1) + '\n' + (await new Promise((resolve) => rl.question(dim('… '), resolve)))
    }
    const line = input.trim()
    if (!line) continue
    if (line === '/exit' || line === '/quit' || line === 'exit') {
      out(dim('bye') + '\n')
      break
    }
    if (line === '/help') {
      out(HELP + '\n')
      continue
    }
    if (line === '/clear') {
      state.messages = []
      state.lastRoute = ''
      out(dim('history cleared') + '\n')
      continue
    }
    if (line === '/plan' || line.startsWith('/plan ')) {
      const task = line.slice(5).trim()
      if (!task) {
        out(dim('usage: /plan <what to plan>  — e.g. /plan add dark mode to the settings page') + '\n')
        continue
      }
      out('\n')
      await runTurn(
        state,
        `Create an implementation plan for the task below. Explore the codebase with your read-only tools (read_file, grep, list_dir) as much as you need, and use web_search for anything unfamiliar — but make NO changes yet except saving the plan itself. Write the plan to .nalu/plans/<yyyy-mm-dd>-<short-slug>.md with write_file, structured as: goal, ordered steps as markdown checkboxes, files to touch, risks, and how to verify. Then summarize the plan here and STOP for my review — do not start executing until I say so.\n\nTASK: ${task}`,
      )
      out('\n')
      continue
    }
    if (line === '/search' || line.startsWith('/search ')) {
      const q = line.slice(7).trim()
      if (!q) {
        out(dim('usage: /search <query>') + '\n')
        continue
      }
      const sp = makeSpinner()
      const res = await toolWeb(state.api, { action: 'search', query: q })
      sp.stop()
      out('\n' + res + '\n\n')
      continue
    }
    if (line === '/model' || line.startsWith('/model ')) {
      out(
        `model: ${gold('auto')} — Nalu routes every request to the best Nalu model for the job (code, reasoning, finance, vision, …) automatically. There is exactly one model option, so there is nothing to switch.\n`,
      )
      continue
    }
    if (line === '/status') {
      const pf = gatherProjectContext().files
      out(`nalu ${VERSION}\napi: ${state.api}\nmodel: auto\ncwd: ${process.cwd()}${state.branch ? `\nbranch: ${state.branch}` : ''}\nproject memory: ${pf.length ? pf.join(', ') : 'none (create a .nalu/ folder or NALU.md to add docs)'}\nhistory: ${state.messages.length} messages\npermissions: ${state.yolo ? 'yolo (all auto-approved)' : state.sessionAllow.size ? `always-allow: ${[...state.sessionAllow].join(', ')}` : 'ask for shell/file changes (.nalu/ writes auto-approved)'}\nwolfisms: ${wolfismCount().toLocaleString()} unique phrases\n`)
      continue
    }
    if (line.startsWith('/')) {
      out(dim(`unknown command ${line.split(' ')[0]} — try /help`) + '\n')
      continue
    }
    out('\n')
    await runTurn(state, input)
    if (!state.interrupted && !state.hadError) out(goldDim(`  — ${wolfFinisher()}`) + '\n')
    out('\n')
  }
  rl.close()
}

// Exported for tests; main() only runs when executed directly (not imported).
export { recoverToolCalls, parseToolArgs, findJsonObjects, trimHistory, toolEditFile, toolGrep, globToRegex, execTool, runBash, announcesIntent, extractDroppedPaths, attachDroppedFiles }

const runDirectly = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()
if (runDirectly) {
  main().catch((e) => {
    console.error(red(`nalu: ${e && e.message ? e.message : e}`))
    process.exit(1)
  })
}
