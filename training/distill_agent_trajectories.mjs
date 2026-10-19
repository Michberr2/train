export const meta = {
  name: 'nalu-agent-trajectories',
  description: 'Generate agentic tool-use trajectories for the Nalu CLI model: teacher agents do REAL tasks in real mini-repos and log every tool call',
  phases: [
    { title: 'Trajectories', detail: 'one teacher agent per task archetype, real execution' },
    { title: 'Validate', detail: 'mechanical format checks' },
  ],
}

// args: { count?: number, workDir: string }
// workDir: an existing scratch directory the teacher agents may create files in.
const CFG = typeof args === 'string' ? JSON.parse(args) : args || {}
const WORK = CFG.workDir
if (!WORK) throw new Error('args.workDir required (scratch directory for mini-repos)')

// The system prompt the TRAINED model will run under. Kept intentionally close
// to api/chat.ts cliPromptBlock semantics, condensed. If cliPromptBlock changes
// materially, regenerate data with this updated to match.
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

// Task archetypes. Each teacher builds a DIFFERENT real mini-project and does
// the task for real. `web: true` archetypes may use real web search.
const ARCHETYPES = [
  { id: 'fix-logic-bug', brief: 'a small Node.js utility project (2-4 files) with ONE subtle logic bug (off-by-one, wrong operator, bad regex, mutation bug). Task: "X is broken / prints wrong output — find the bug, fix it, and prove the fix by running it".' },
  { id: 'fix-failing-test', brief: 'a Node project with a tiny test file (plain node asserts, no framework) where one test FAILS because the implementation is wrong. Task: "npm test fails — make it pass". Verify by running the test before (fail) is not needed in the log, but after (pass) is.' },
  { id: 'add-feature', brief: 'a small CLI script or module. Task: "add <specific small feature>" (a new flag, a new function, handle an edge case). Verify by running it.' },
  { id: 'scan-document', brief: 'a small multi-file project. Task: "scan this repo and write a SUMMARY.md (or ARCHITECTURE.md) describing it". Verify by reading the created file back.' },
  { id: 'refactor-rename', brief: 'a project where a poorly-named function/variable is used across 2-3 files. Task: "rename X to Y everywhere". Use grep to find usages, edit_file per site, verify by grep (0 old-name hits) + running the code.' },
  { id: 'input-validation', brief: 'a module with a function that crashes on bad input. Task: "make parseX robust to bad input, return null instead of throwing". Verify by running with bad inputs.' },
  { id: 'write-tests', brief: 'a small module with no tests. Task: "write a test file covering the main function including edge cases, plain node asserts, and run it". Verify by running the tests.' },
  { id: 'config-change', brief: 'a project with package.json. Task: "add an npm script / change a config value / add a .gitignore appropriate to the project". Verify by reading back or running.' },
  { id: 'code-question', brief: 'a project with a few files. Task: a QUESTION about the code ("where is X handled? what does this function return for Y?") — answer via read-only tools (grep/read_file), NO mutations, end with a clear direct answer.' },
  { id: 'plan-then-execute', brief: 'a small project needing a MULTI-STEP change (e.g. extract a module + update imports + add validation). The agent must FIRST write a checkbox plan to .nalu/plans/2026-07-11-<slug>.md, then execute each step, then verify. This trajectory teaches plan-first behavior.' },
  { id: 'debug-stacktrace', brief: 'a project where running the entry file throws (TypeError/undefined). The task pastes the error output and asks "fix this crash". Explore, fix, verify by running clean.' },
  { id: 'shell-task', brief: 'a plain task done mostly with bash: e.g. "initialize git here with a sensible .gitignore and make the first commit" or "find the 3 largest files and report". Verify with bash output.' },
  { id: 'web-research-apply', brief: 'a project with an outdated constant/version/URL in a config or README. Task: "check the current <fact> online and update the file". Use your REAL web search to find the fact, cite what you found in the final answer.', web: true },
  { id: 'direct-answer', brief: 'NO project needed. The user pastes a short code snippet IN the question and asks what it does / why it is wrong / how to improve it. The correct behavior is to answer DIRECTLY with zero tool calls (tools would add nothing).', direct: true },

  // ── fleet-wide: the teacher teaches ALL the models ─────────────────────────
  // Every Nalu specialist gets routed CLI traffic, so every lane needs the same
  // tool discipline exercised in ITS OWN domain. Rows are tagged with `domain`
  // (matching api/_specialists.ts kinds) so each nalu-<domain> model trains on
  // the general set + its domain slice.
  { id: 'finance-csv-report', domain: 'finance', brief: 'a folder with trades.csv (15-25 realistic rows: ticker, side, qty, price, date). Task: "compute realized P&L per ticker and overall, and write pnl-report.md". Compute via a small node one-liner or script (bash) so numbers are REAL, verify totals, write the report.' },
  { id: 'crypto-holdings', domain: 'crypto', brief: 'a folder with holdings.csv (coin, amount). Task: "value my portfolio at CURRENT prices and write portfolio.md". Use REAL web_search for current approximate prices, compute with bash/node, cite the price source in the final answer.', web: true },
  { id: 'realestate-underwrite', domain: 'realestate', brief: 'a folder with rent-roll.csv (units, monthly rent) and assumptions.md (expense ratio, price). Task: "underwrite this: NOI, cap rate, and check today\'s 30-yr mortgage rate online — write underwriting.md". Compute for real (bash/node), web_search the current rate, cite it.', web: true },
  { id: 'legal-contract-review', domain: 'legal', brief: 'a folder with contract.txt (a short 40-60 line service agreement with 3 seeded risky clauses: unlimited liability, auto-renewal, one-sided termination). Task: "review this contract and write risks.md flagging problem clauses with the exact text quoted". Find clauses via grep/read_file, quote them exactly, one general not-legal-advice line at the end.' },
  { id: 'medical-evidence-brief', domain: 'medical', brief: 'NO project files needed beyond an empty dir. Task: a clinical-evidence question ("current first-line treatment guidance for X — write evidence-brief.md with sources"). Use REAL web_search (1-2 searches), write the brief citing the sources found, one educational-not-medical-advice line.', web: true },
  { id: 'marketing-copy-variants', domain: 'marketing', brief: 'a folder with product.md (a niche B2B product description). Task: "read the product notes, check one competitor angle online, and write campaign.md with 3 positioning angles + subject lines". read_file, one REAL web_search, write_file, verify by reading back.', web: true },
  { id: 'data-clean-analyze', domain: 'data', brief: 'a folder with survey.csv (20-30 rows with a few dirty values: blanks, dupes, a bad date). Task: "clean this and report response stats — write findings.md". Write and RUN a small node script (bash) to clean/compute so the stats are real, then write findings.md.' },
  { id: 'hr-policy-update', domain: 'hr', brief: 'a folder with handbook.txt (a short employee handbook with an outdated PTO section). Task: "our PTO policy changed to X — find every place the handbook mentions the old policy and update it, then summarize what changed". grep for mentions, edit_file each, verify by grep.' },
  { id: 'construction-estimate', domain: 'construction', brief: 'a folder with specs.txt (a small deck/patio spec: dimensions, materials). Task: "do the materials takeoff and write estimate.md with quantities and rough costs". Compute quantities for REAL via bash/node math, state assumptions, write the estimate.' },
  { id: 'notes-to-actions', domain: 'general', brief: 'a folder with meeting-notes.txt (a messy 30-line brainstorm/meeting dump). Task: "turn this into structured notes with an action-items section — write actions.md". read_file, write_file, verify by reading back. Keep only what the notes actually say (no invented owners/dates).' },
]

const TRAJ_SCHEMA = {
  type: 'object',
  required: ['task', 'turns', 'final', 'verified', 'verify_evidence'],
  properties: {
    task: { type: 'string', description: "the user's message, written naturally (may include pasted code/error output)" },
    turns: {
      type: 'array',
      description: 'one entry per tool call, in order; empty array for a direct answer',
      items: {
        type: 'object',
        required: ['tool_name', 'tool_args', 'tool_output'],
        properties: {
          lead: { type: 'string', description: 'ONE short sentence to say before this call, or "" for none. Never announce future actions beyond this call.' },
          tool_name: { type: 'string', description: 'bash | read_file | write_file | edit_file | list_dir | grep | web_search | fetch_url' },
          tool_args: { type: 'string', description: 'the arguments as a compact JSON object string, e.g. {"command":"node test.js"}' },
          tool_output: { type: 'string', description: 'the REAL output you observed, truncated to ~1500 chars' },
        },
      },
    },
    final: { type: 'string', description: 'the final answer to the user: 1-3 sentence summary of what changed / the direct answer. No tool calls, no "let me…" endings.' },
    verified: { type: 'boolean', description: 'true only if you PROVED the task outcome with a real tool result' },
    verify_evidence: { type: 'string', description: 'which turn proves it (e.g. "turn 5: node test.js exit 0, all asserts pass")' },
  },
}

function teacherPrompt(arch, i) {
  const domainNote = arch.domain && arch.domain !== 'code'
    ? `\nThis trajectory trains the ${arch.domain.toUpperCase()} specialist lane: the task, files, and final answer must live in that domain, while the TOOL DISCIPLINE stays identical.`
    : ''
  return `You are generating ONE gold-standard training trajectory that teaches a smaller model how to operate the Nalu CLI (a terminal agent). You will DO a real task with your real tools and log every step faithfully.${domainNote}

SETUP (do this first, for real):
- Create a fresh mini-project directory: ${WORK}/traj-${i}-${arch.id}/ ${arch.direct ? '— SKIP project creation for this archetype; no files needed.' : `— build: ${arch.brief}`}
- Make the project realistic: real code, real names (not foo/bar), plausible for a small real-world repo. Keep files small (10-60 lines each).

THEN perform the task exactly as the Nalu CLI agent should, obeying this policy (this is the system prompt the student model will be trained under):
---
${NALU_CLI_SYSTEM}
---
Execute each step FOR REAL with your own tools inside that directory (your Bash/Read/Write/Grep tools stand in for the Nalu tools; translate each action into the corresponding Nalu tool call). Rules for the LOG you return:
- Each logged turn = one Nalu tool call: tool_name ∈ {bash, read_file, write_file, edit_file, list_dir, grep, web_search, fetch_url}; tool_args is the JSON arguments object AS A STRING; tool_output is the REAL observed output (for read_file: include line numbers like "    1  <code>"; for bash: "exit code: N" then output; for write_file: "wrote N bytes to <path>"; for edit_file: "edited <path> (1 replacement)"; for list_dir: the entries).
- All paths in tool_args must be RELATIVE to the project directory (the student sees a project-rooted world; never leak ${WORK}).
- 2-8 turns for tool tasks (${arch.direct ? '0 turns for this one — direct answer' : 'explore → act → VERIFY with a real run'}). lead sentences: short, varied, or empty — never formulaic, never announcing beyond the current call.
- The final message: 1-3 sentences, plain, states what changed and how it was verified${arch.web ? ', citing the fact you found online' : ''}. It must NOT end with a colon or an announcement.
- verified=true ONLY if a logged tool_output actually proves success (e.g. tests pass, file content read back, clean run).${arch.web ? '\n- Use your REAL WebSearch for the online fact; log it as a web_search turn with the real result summary as tool_output.' : ''}

Make this trajectory DIFFERENT from generic examples: pick an unusual-but-realistic mini-domain (a invoice parser, a cron helper, a color-conversion lib, a feed deduper, …). Return ONLY the structured object.`
}

phase('Trajectories')
const results = await parallel(
  ARCHETYPES.map((arch, i) => () =>
    agent(teacherPrompt(arch, i), { label: `traj:${arch.id}`, phase: 'Trajectories', schema: TRAJ_SCHEMA }),
  ),
)

phase('Validate')
// Mechanical validation + composition into trainer-ready multi-turn rows.
// Row shape: { system, turns: [{user, assistant}...], task, archetype }
// - assistant tool-call turns are COMPOSED HERE (lead + canonical JSON line) so
//   the format is 100% deterministic — that formatting IS the training target.
// - tool results are rendered as the next user turn: "[tool result: <name>]\n…"
const ANNOUNCE_END = /(?::\s*$)|\b(?:let me|i'?ll|i will|going to)\b[^.!?]{0,90}$/i
const rows = []
const rejected = []
for (let i = 0; i < results.length; i++) {
  const t = results[i]
  const arch = ARCHETYPES[i]
  const reject = (why) => rejected.push({ archetype: arch.id, why })
  if (!t || typeof t !== 'object') { reject('no result'); continue }
  if (!t.task || !t.final) { reject('missing task/final'); continue }
  if (!t.verified && !arch.direct) { reject('not verified'); continue }
  if (arch.direct && (t.turns || []).length > 0) { reject('direct archetype used tools'); continue }
  if (!arch.direct && (!Array.isArray(t.turns) || t.turns.length < 2 || t.turns.length > 10)) { reject(`bad turn count ${(t.turns || []).length}`); continue }
  const finalText = String(t.final).trim()
  if (ANNOUNCE_END.test(finalText.split('\n').filter(Boolean).pop() || '')) { reject('final ends with announcement'); continue }
  if (/\{\s*"name"\s*:/.test(finalText)) { reject('final contains a tool call'); continue }

  let ok = true
  const turns = []
  let userText = String(t.task).trim()
  for (const s of t.turns || []) {
    if (!TOOL_NAMES.has(s.tool_name)) { reject(`unknown tool ${s.tool_name}`); ok = false; break }
    let argsObj
    try {
      argsObj = JSON.parse(s.tool_args)
    } catch {
      reject(`unparseable args for ${s.tool_name}`)
      ok = false
      break
    }
    if (!argsObj || typeof argsObj !== 'object' || Array.isArray(argsObj)) { reject(`non-object args for ${s.tool_name}`); ok = false; break }
    // canonicalize arg names — training data must use the exact schema keys
    const ALIASES = { file_path: 'path', filepath: 'path', filename: 'path', file: 'path', cmd: 'command', old: 'old_string', new: 'new_string', old_str: 'old_string', new_str: 'new_string', text: 'content', q: 'query' }
    for (const [from, to] of Object.entries(ALIASES)) {
      if (argsObj[from] !== undefined && argsObj[to] === undefined) {
        argsObj[to] = argsObj[from]
        delete argsObj[from]
      }
    }
    const workLeak = JSON.stringify(argsObj).includes(WORK)
    if (workLeak) { reject(`absolute scratch path leaked in ${s.tool_name} args`); ok = false; break }
    const lead = String(s.lead || '').trim()
    const call = JSON.stringify({ name: s.tool_name, arguments: argsObj })
    turns.push({ user: userText, assistant: (lead ? lead + '\n' : '') + call })
    userText = `[tool result: ${s.tool_name}]\n${String(s.tool_output || '(no output)').slice(0, 1500)}`
  }
  if (!ok) continue
  turns.push({ user: userText, assistant: finalText })
  const domain = arch.domain || 'code'
  // domain rows carry the routed-specialist note the production prompt implies,
  // so each fleet model trains under a system prompt shaped like its own.
  const system = domain === 'code' ? NALU_CLI_SYSTEM : `${NALU_CLI_SYSTEM}\nYou are routed as the Nalu ${domain} specialist — answer with that domain's expertise.`
  // A teacher's verified flag is only a claim. The dataset policy requires a
  // separate hash-bound runner/human review before any of these rows train.
  rows.push({ system, turns, task: t.task, archetype: arch.id, domain,
    verification: {status: 'pending-independent-review', teacherClaimedSuccess: t.verified === true,
      reason: 'Teacher-returned tool_output strings are not authenticated runner events'} })
}

log(`${rows.length}/${ARCHETYPES.length} trajectories passed structural validation (not execution verification) (${rejected.length} rejected)`)
return { rows, rejected }
