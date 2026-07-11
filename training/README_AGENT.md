# Nalu agent model — training the CLI's tool-use into the weights

The Nalu CLI's biggest weakness is the base model's tool-calling: served via the
current provider it emits **0% native tool calls** — it narrates ("Let me look at
the files.") or writes calls as loose text, and the CLI papers over it with
recovery heuristics and nudges (`recoverToolCalls` / `announcesIntent` in
`~/naludesktop/cli/nalu.mjs`). This pipeline fixes the behavior **at the source**:
fine-tune a model on gold agentic trajectories so it reliably *acts*.

This is also the honest scope of "beat Fable 5 / GPT-5.6": not in general — on
**Nalu-CLI tasks, in the Nalu harness**, where format discipline and plan-first
behavior dominate felt quality.

## The canonical call format (why text, not native tool_calls)

The serving stack does not reliably parse native tool-call fields, so the
training target is the ONE text format the CLI recovers with 100% reliability:

```
<optional single short sentence>
{"name":"bash","arguments":{"command":"node test.js"}}
```

- one bare JSON object on its own line, then STOP
- tool results come back as the next user turn: `[tool result: <name>]\n<output>`
- final turn: plain 1-3 sentence answer, never ending in an announcement

`distill_agent_trajectories.mjs` COMPOSES the JSON lines deterministically
(teachers supply name/args/output; the script formats) — so the format in the
data is exact, always.

## Pipeline

```
(1) GENERATE   training/distill_agent_trajectories.mjs   (a Workflow script)
      teacher agents build REAL mini-repos and do REAL tasks with real tools,
      logging every step; 14 archetypes (fix-bug, failing-test, scan-document,
      refactor, plan-then-execute, web-research, direct-answer, …)
      → validated rows {system, turns:[{user,assistant}…]}
      → append to data/nalu-agent.jsonl

(2) TRAIN      python train_nalu_sft.py --domain code-agent \
                 --data data/nalu-agent.jsonl --base "Qwen/Qwen3.5-9B" \
                 --epochs 3 --maxlen 8192 --out nalu-code-agent-v1
      (`--turns` rows are handled automatically; loss on every assistant span —
       the tool-call lines and the final answer)

(3) WIRE       NALU_CODE_MODEL=<served path printed by the trainer>
      (Vercel env; api/chat.ts routes code-kind CLI traffic to it, no code change)

(4) PROVE      replay a held-out task battery through the REAL CLI:
      - tool-call validity % (native/canonical vs narrated)
      - task completion % (file actually written, tests actually pass)
      - steps-to-done and nudges-fired (both should drop toward 0)
      compare: base model vs nalu-code-agent-v1 vs a frontier model dropped in cold.
```

### The teacher teaches ALL the models

Trajectories span the fleet, not just code: 14 agent-craft archetypes (fix-bug,
failing-test, scan-document, refactor, plan-then-execute, web-research,
direct-answer, …) plus 10 domain archetypes (finance, crypto, realestate, legal,
medical, marketing, data, hr, construction, general), each tagged with `domain`
matching `api/_specialists.ts` kinds. Same 8 tools, same call discipline —
exercised in each specialist's own world (P&L from a real CSV, contract clause
review, live-rate underwriting, evidence briefs with real searches, …).

Training loop across the fleet:

```
# 1) one shared agent base first (all domains' rows) — wire it as the default:
python train_nalu_sft.py --domain agent --data data/nalu-agent.jsonl \
    --base "Qwen/Qwen3.5-9B" --epochs 3 --maxlen 8192 --out nalu-agent-v1
# → NALU_DEFAULT_MODEL=<served path>

# 2) as data grows, specialize per lane (general rows + that lane's rows):
jq -c 'select(.domain=="finance" or .domain=="code")' data/nalu-agent.jsonl > data/agent-finance.jsonl
python train_nalu_sft.py --domain finance --data data/agent-finance.jsonl ... --out nalu-finance-agent-v1
# → NALU_FINANCE_MODEL=<served path>   (repeat per kind; router does the rest)
```

### Run the generator

From a Nalu/ultracode session:

```
Workflow({ scriptPath: "training/distill_agent_trajectories.mjs",
           args: { workDir: "<scratch dir for mini-repos>" } })
# returns { rows, rejected } — append rows to data/nalu-agent.jsonl:
#   rows.map(r => JSON.stringify(r)).join('\n')
```

Each invocation yields up to 24 trajectories (one per archetype — 14 agent-craft
+ 10 domain lanes — different random mini-domains each run). **Scale by
re-running** — 20-40 runs ≈ 400-1000 trajectories, a real SFT set. Vary nothing;
the diversity is prompted in.

### Quality gates already enforced by the script

- `verified=true` required — a logged tool result must PROVE success
- tool names ∈ the CLI's 8-tool schema; arguments must parse as JSON objects
- no absolute scratch paths leaked into args
- final answer: no tool call, no announcement ending (the exact failure the CLI
  had to nudge around)
- direct-answer archetype must use ZERO tools (teaches when *not* to act)

### Keeping data and production in sync

`NALU_CLI_SYSTEM` in the generator mirrors `cliPromptBlock` in `api/chat.ts`
(condensed). If the production prompt changes materially, update the constant and
regenerate — training against a stale system prompt dilutes the behavior.

## Files

- `distill_agent_trajectories.mjs` — the generator (Workflow script)
- `train_nalu_sft.py` — SFT trainer; multi-turn `turns` rows + single-turn QA rows
- `data/nalu-agent.jsonl` — the trajectory set (seed batch checked in)
- `train_catalina_dro.py` — optional RL polish afterwards (reward: task success +
  well-formed calls) — not yet adapted for the agent lane
