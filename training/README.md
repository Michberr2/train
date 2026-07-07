# Nalu Catalina — DRO RL training (Tinker)

Off-policy reinforcement-learning fine-tuning for **Nalu Catalina** using **DRO
(Distributionally Robust Optimization)** on the Thinking Machines **Tinker**
platform, with LoRA for peak efficiency.

Entry point: [`train_catalina_dro.py`](./train_catalina_dro.py)

> Docs: https://tinker-docs.thinkingmachines.ai/tinker/losses/dro/

---

## What DRO is, and why it fits Catalina

DRO is a general off-policy / offline RL method. Instead of clipping the policy
ratio (PPO) or relying on pairwise preferences (DPO), it adds a **quadratic
trust-region penalty** that keeps the updated policy close to the policy that
produced the samples:

```
L_DRO(theta) = E_x~q [ logp_theta(x) * A(x)  -  0.5 * beta * ( log( p_theta(x) / q(x) ) )^2 ]
```

Tinker computes this server-side under `loss_fn="dro"`:

```python
quadratic_term = (target_logprobs - sampling_logprobs) ** 2
dro_objective  = target_logprobs * advantages - 0.5 * beta * quadratic_term
loss           = -dro_objective.sum()
```

- `target_logprobs` — current-policy log-prob of the token (Tinker computes it).
- `sampling_logprobs` — `q(x)`, the log-prob recorded **when we sampled** (frozen).
- `advantages` — `A(x)`, the group-relative advantage.
- `beta` — penalty strength.

Why it fits Catalina specifically:

1. **Off-policy efficiency.** The penalty is anchored to the *stored* sampling
   logprobs `q(x)`, so a batch of rollouts stays valid after the policy moves.
   You can take **several optimizer steps on the same rollouts** (`INNER_STEPS`)
   before sampling again. On a 397B-A17B MoE, sampling is by far the most
   expensive op, so reuse is the dominant cost win.
2. **Stability vs PPO.** PPO-clip gives *zero* gradient outside the clip window
   and is only trustworthy very near the sampling policy. DRO's smooth quadratic
   penalty **degrades gracefully** as the policy drifts — exactly what you want
   when reusing rollouts and learning sparse "deep-think + web" behaviours.
3. **Offline-compatible.** The same loss works on logged data (past good
   Catalina transcripts, accepted answers, tool-use traces), so "continue to
   learn" can include replaying curated history, not just fresh online rollouts.

---

## Choosing `beta`

`beta` trades advantage-maximization against policy stability.

| Symptom | Action | Range |
| --- | --- | --- |
| Default starting point | start here | **0.05** |
| Policy drifts / reward collapses / outputs degenerate / KL blows up | **raise** beta (tighter leash) | 0.1 → 0.2 |
| Learning too slow; advantages barely move the logprobs | **lower** beta (looser leash) | 0.02 → 0.01 |

Watch `mean_reward` / `eval_reward` in `checkpoints/metrics.jsonl`. If reward
spikes then crashes, or samples get repetitive/off-distribution, raise beta. If
reward is flat for many iterations, lower beta (and/or nudge `lr` up). The more
off-policy you go (higher `INNER_STEPS`), the higher beta you generally want.

---

## Base model: cheap iteration vs final quality

Catalina serves in prod as `Qwen/Qwen3.5-397B-A17B`. Do **not** LoRA-train the
397B for every experiment — too slow and expensive.

| Goal | `CATALINA_BASE_MODEL` | Why |
| --- | --- | --- |
| **Cheap iteration** (reward shaping, beta sweep, debugging) | `Qwen/Qwen3.5-35B-A3B` (or 9B) | Fast sample+train loop; iterate for cents. |
| **Final quality** (ship to Catalina) | `Qwen/Qwen3.5-397B-A17B` | Same family as prod; re-run the *tuned* recipe. |

Keep the recipe (reward, beta, group size, lr) identical between dev and final
runs; only the base model changes.

> The 14 old `nalu-*` checkpoints were trained on Llama-3.3-70B and **cannot be
> sampled** on current Tinker — always target a current, samplable base
> (Qwen3.5 family). LoRA adapters are base-specific; pick the base first.

---

## Reward design for a web-using, deep-thinking assistant

The `reward_fn` in the script is a **deterministic proxy** — replace it with real
graders. Guidance:

- **Reward verifiable behaviour, not vibes:** explicit reasoning/plan before the
  answer (deep think), citing sources/URLs and attributing claims (web
  grounding), staying on task, and avoiding empty or runaway/repetitive output.
- **Prefer programmatic / tool-checkable signals** (did it call the web tool? do
  cited URLs resolve? does retrieved text support the claim? does a unit test
  pass?) — cheaper and far less hackable than an LLM judge.
- **Cap any LLM-judge weight** so it can't dominate and get reward-hacked.
- **Bounded, roughly zero-centred rewards.** GRPO subtracts the group mean, so
  the *relative ranking within a prompt's group* matters more than absolute
  scale. Keep components bounded so none swamps the rest.
- **Guard against reward hacking:** if the model learns to spam "source" or fake
  URLs, tighten that component (verify URLs resolve / support the claim).

Advantages use the **GRPO group-relative baseline**: per prompt, subtract the
group mean and divide by the group std — a strong, free variance reduction.

---

## Peak-efficiency choices baked in

- **LoRA, not full fine-tuning** — `create_lora_training_client(rank=32)`. Rank
  32 is a good default; raise to 64 if under-fitting, drop to 16 to save cost.
- **One reused `ServiceClient`** for the whole run (connection reuse).
- **Off-policy rollout reuse** (`INNER_STEPS`): multiple optim steps per sampled
  batch. **The main DRO win** — amortize the expensive sampling pass over
  several cheaper gradient steps. Start at 2; raise beta if you push it higher.
- **Group-relative advantage normalization** (subtract mean, divide by std) to
  cut gradient variance.
- **Async `forward_backward`** so batches submit/await without blocking setup.
- **Gradient accumulation** (`GRAD_ACCUM`): split a large rollout batch into
  micro-batches, one `forward_backward` each, then a single `optim_step` — big
  effective batches without large peak memory.
- **KV / length note:** sampling cost scales with `max_tokens` and `group_size`,
  and the KV cache grows with sequence length. For deeper thinking you want
  longer completions, so trade `group_size` down as you raise `max_tokens` to
  keep cost flat; reuse (`INNER_STEPS`) keeps the long-sample cost amortized.

---

## Run

```bash
# 0) install + auth
pip install tinker numpy
export TINKER_API_KEY="tml-..."        # or TML_API_KEY / GLM_API_KEY

# 1) cheap dev run (small base; iterate on reward/beta)
CATALINA_BASE_MODEL="Qwen/Qwen3.5-35B-A3B" \
CATALINA_BETA=0.05 CATALINA_LORA_RANK=32 \
CATALINA_GROUP_SIZE=8 CATALINA_INNER_STEPS=2 CATALINA_ITERS=50 \
python training/train_catalina_dro.py

# 2) final run (prod base, tuned recipe) — only the base model changes
CATALINA_BASE_MODEL="Qwen/Qwen3.5-397B-A17B" \
CATALINA_BETA=0.05 CATALINA_LORA_RANK=32 CATALINA_ITERS=200 \
python training/train_catalina_dro.py
```

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `TINKER_API_KEY` / `TML_API_KEY` / `GLM_API_KEY` | — | Tinker `tml-` key (checked in that order) |
| `CATALINA_BASE_MODEL` | `Qwen/Qwen3.5-35B-A3B` | base model to LoRA-train |
| `CATALINA_LORA_RANK` | `32` | LoRA rank |
| `CATALINA_BETA` | `0.05` | DRO penalty strength |
| `CATALINA_GROUP_SIZE` | `8` | rollouts per prompt (GRPO baseline) |
| `CATALINA_PROMPTS` | `16` | prompts per outer iteration |
| `CATALINA_INNER_STEPS` | `2` | off-policy optim steps per sampled batch |
| `CATALINA_GRAD_ACCUM` | `1` | micro-batches per optim step |
| `CATALINA_ITERS` | `200` | outer iterations |
| `CATALINA_LR` | `1e-5` | Adam learning rate |
| `CATALINA_MAX_TOKENS` | `1024` | max completion tokens |
| `CATALINA_TEMP` / `CATALINA_TOP_P` | `1.0` / `1.0` | sampling temperature / nucleus |
| `CATALINA_SAVE_EVERY` / `CATALINA_EVAL_EVERY` | `20` / `10` | checkpoint / eval interval (iters) |
| `CATALINA_RUN_NAME` | `nalu-catalina-dro` | checkpoint name prefix |
| `CATALINA_OUT_DIR` | `training/checkpoints` | logs + checkpoint manifest |
| `CATALINA_PROMPTS_FILE` | — | optional JSONL (`{"prompt": ...}`) or TXT dataset |
| `CATALINA_RESUME_PATH` | — | optional Tinker state path to resume from |

Outputs (`metrics.jsonl`, `checkpoints.jsonl`) land in `CATALINA_OUT_DIR`.

Once you have a final adapter, point Catalina at it by setting
`NALU_GENERAL_MODEL` (and `NALU_GENERAL_BASE_URL` / `NALU_GENERAL_API_KEY` if the
adapter is served elsewhere) in Vercel prod — no code change needed.

---

## SDK-surface caveats

The script targets the public Tinker SDK shape (`tinker.ServiceClient`,
`create_lora_training_client`, `forward_backward_async(loss_fn="dro",
loss_fn_config={"beta": ...})`, `optim_step_async`, `sample_async`,
`save_state_async`). The DRO call and per-datum
`target_tokens`/`logprobs`/`advantages` inputs match the docs exactly. A few
method names that vary across SDK versions are isolated in thin wrappers
(`_resolve`, `refresh_sampling_client`, `_make_datum`, `optim_step`) and flagged
`# ASSUMPTION:` with defensive fallbacks, so a version mismatch fails loudly
rather than silently. Pin your `tinker` version and adjust only those wrappers.
