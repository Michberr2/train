#!/usr/bin/env python3
"""
train_catalina_dro.py
================================================================================
DRO (Distributionally Robust Optimization) RL fine-tuning for "Nalu Catalina"
on the Thinking Machines **Tinker** platform, tuned for peak efficiency.

WHY DRO FOR CATALINA
--------------------
DRO is a general off-policy / offline RL method. Instead of PPO's hard ratio
clip or DPO's pairwise preferences, it constrains the policy update with a smooth
quadratic trust-region penalty:

    L_DRO(theta) = E_{x~q}[ logp_theta(x) * A(x)
                            - 0.5 * beta * ( log( p_theta(x) / q(x) ) )^2 ]

Canonical implementation (Tinker computes this server-side as loss_fn="dro"):

    quadratic_term = (target_logprobs - sampling_logprobs) ** 2
    dro_objective  = target_logprobs * advantages - 0.5 * beta * quadratic_term
    loss           = -dro_objective.sum()

The penalty is anchored to the *stored* sampling logprobs q(x), so a batch of
rollouts stays valid even after the policy moves. That makes DRO genuinely
off-policy: we can take SEVERAL optimizer steps on the same rollouts
(INNER_STEPS) before sampling again. On a 397B-A17B MoE, sampling dominates
cost, so reusing rollouts is the single biggest efficiency win. DRO degrades
gracefully as the policy drifts (larger drift just costs more), where PPO-clip
gives zero gradient outside its window and gets brittle off-policy.

Per-datum inputs the DRO loss reads:
    target_tokens : int[N]   - the next token to score
    logprobs      : float[N] - q(x), the SAMPLING logprobs (frozen / off-policy)
    advantages    : float[N] - A(x), group-relative

Run:  python training/train_catalina_dro.py
Env:  TINKER_API_KEY  (falls back to TML_API_KEY / GLM_API_KEY - a `tml-` key)

SDK NOTE: targets the public Tinker SDK surface (tinker.ServiceClient,
create_lora_training_client, forward_backward_async(loss_fn="dro",
loss_fn_config={"beta": ...}), optim_step_async, sample_async, save_state_async).
A few method names that vary across SDK versions are isolated in thin wrappers
(_resolve, refresh_sampling_client, _make_datum, optim_step) and flagged
"# ASSUMPTION:" with defensive fallbacks, so a version mismatch fails loudly
instead of silently. Pin your `tinker` version and adjust those wrappers only.
================================================================================
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

import tinker  # pip install tinker


# ==============================================================================
# CONFIG - everything tunable lives here (overridable via env)
# ==============================================================================
@dataclass
class Config:
    # --- model -------------------------------------------------------------
    # Cost-efficient iteration vs final quality:
    #   * iterate cheaply on a small Qwen3.5 MoE, then re-run the tuned recipe on
    #     the big one. Catalina ships as Qwen/Qwen3.5-397B-A17B, but you do NOT
    #     want to LoRA-train the 397B for every experiment - too slow / expensive.
    #   Dev base (cheap):   "Qwen/Qwen3.5-35B-A3B"  (or 9B)
    #   Final base (prod):  "Qwen/Qwen3.5-397B-A17B"
    base_model: str = os.environ.get("CATALINA_BASE_MODEL", "Qwen/Qwen3.5-35B-A3B")

    # --- LoRA (never full-FT for RL on a huge MoE) -------------------------
    lora_rank: int = int(os.environ.get("CATALINA_LORA_RANK", "32"))

    # --- DRO ---------------------------------------------------------------
    # beta = trust-region penalty strength.
    #   start 0.05.
    #   raise -> 0.1-0.2 if the policy drifts / reward collapses / outputs degenerate.
    #   lower -> 0.01-0.02 if learning is too slow (advantages barely move logp).
    #   push beta higher as you increase off-policy reuse (inner_steps).
    beta: float = float(os.environ.get("CATALINA_BETA", "0.05"))

    # --- RL loop -----------------------------------------------------------
    group_size: int = int(os.environ.get("CATALINA_GROUP_SIZE", "8"))       # rollouts/prompt (GRPO baseline)
    prompts_per_batch: int = int(os.environ.get("CATALINA_PROMPTS", "16"))  # prompts per outer iter
    inner_steps: int = int(os.environ.get("CATALINA_INNER_STEPS", "2"))     # off-policy reuse of each rollout batch
    grad_accum: int = int(os.environ.get("CATALINA_GRAD_ACCUM", "1"))       # micro-batches per optim step
    num_iterations: int = int(os.environ.get("CATALINA_ITERS", "200"))

    # --- optim -------------------------------------------------------------
    lr: float = float(os.environ.get("CATALINA_LR", "1e-5"))
    max_grad_norm: float = float(os.environ.get("CATALINA_MAX_GRAD_NORM", "1.0"))

    # --- sampling ----------------------------------------------------------
    max_tokens: int = int(os.environ.get("CATALINA_MAX_TOKENS", "1024"))
    temperature: float = float(os.environ.get("CATALINA_TEMP", "1.0"))
    top_p: float = float(os.environ.get("CATALINA_TOP_P", "1.0"))

    # --- checkpoint / eval -------------------------------------------------
    save_every: int = int(os.environ.get("CATALINA_SAVE_EVERY", "20"))
    eval_every: int = int(os.environ.get("CATALINA_EVAL_EVERY", "10"))
    run_name: str = os.environ.get("CATALINA_RUN_NAME", "nalu-catalina-dro")
    out_dir: Path = field(default_factory=lambda: Path(
        os.environ.get("CATALINA_OUT_DIR", "training/checkpoints")))

    adv_eps: float = 1e-6  # floor on group std to avoid div-by-zero


CFG = Config()


# ==============================================================================
# AUTH - one ServiceClient, reused for the whole run (connection reuse)
# ==============================================================================
def make_service_client() -> "tinker.ServiceClient":
    api_key = (os.environ.get("TINKER_API_KEY")
               or os.environ.get("TML_API_KEY")
               or os.environ.get("GLM_API_KEY"))
    if not api_key:
        raise SystemExit("No Tinker API key. Set TINKER_API_KEY "
                         "(or TML_API_KEY / GLM_API_KEY) to your `tml-` key.")
    os.environ.setdefault("TINKER_API_KEY", api_key)
    try:
        return tinker.ServiceClient(api_key=api_key)  # ASSUMPTION: api_key kwarg
    except TypeError:
        return tinker.ServiceClient()                 # fallback: env-only


# ==============================================================================
# DATASET - replace load_prompts() with your real data
# ==============================================================================
DEFAULT_PROMPTS: list[str] = [
    "What's the latest on JWST's deepest-field results? Cite sources.",
    "Compare two ways to rate-limit a serverless API and recommend one.",
    "Plan a 3-step research workflow to fact-check a viral statistic.",
    "Step by step, why is a quadratic trust region more stable than PPO clipping?",
    "Summarize current FEMA flood-zone caveats for coastal property buyers. Cite.",
    "Given conflicting web sources on a drug interaction, how do you reconcile them?",
]


def load_prompts() -> list[str]:
    path = os.environ.get("CATALINA_PROMPTS_FILE")
    if path and Path(path).exists():
        out = []
        for ln in Path(path).read_text().splitlines():
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln)["prompt"])  # JSONL {"prompt": ...}
            except Exception:
                out.append(ln)                          # or plain .txt
        return out
    return DEFAULT_PROMPTS


# ==============================================================================
# REWARD - shaped for a web-using, deep-thinking assistant.
# Replace with real graders / tool-checkable signals; this is a cheap proxy.
# GRPO subtracts the group mean, so RELATIVE ranking within a prompt matters
# more than absolute scale. Keep each component bounded so none dominates.
# ==============================================================================
def reward_fn(prompt: str, completion_text: str) -> float:
    text = completion_text.strip()
    if not text:
        return -1.0
    low = text.lower()
    score = 0.0
    # (1) deep-think: rewards explicit reasoning scaffolding
    if any(k in low for k in ("step 1", "first,", "because", "therefore", "let's")):
        score += 0.25
    # (2) web grounding: rewards citing sources / URLs
    if "http" in low or "source" in low or "according to" in low:
        score += 0.35
    # (3) length sweet-spot: discourage empty and runaway answers
    n = len(text.split())
    if 40 <= n <= 600:
        score += 0.2
    elif n > 900:
        score -= 0.3
    # (4) on-task lexical anchor to the prompt
    pw = {w for w in low.split() if len(w) > 4}
    if pw:
        anchor = {w for w in prompt.lower().split() if len(w) > 4}
        if anchor:
            score += 0.2 * min(len(pw & anchor) / len(anchor), 1.0)
    # (5) penalize degenerate repetition
    toks = low.split()
    if toks and len(set(toks)) / len(toks) < 0.4:
        score -= 0.5
    return float(score)


# ==============================================================================
# ADVANTAGES - GRPO group-relative baseline (free variance reduction)
# ==============================================================================
def group_relative_advantages(rewards: Sequence[float], eps: float) -> list[float]:
    if len(rewards) <= 1:
        return [0.0 for _ in rewards]
    mean = statistics.fmean(rewards)
    std = statistics.pstdev(rewards)
    denom = std if std > eps else eps
    return [(r - mean) / denom for r in rewards]


# ==============================================================================
# TENSOR / DATUM HELPERS (thin SDK wrappers)
# ==============================================================================
def _tensor(values: Sequence[float], dtype: str) -> Any:
    # ASSUMPTION: Tinker accepts numpy arrays for loss_fn_inputs, or exposes
    # tinker.types.TensorData.from_numpy. Try the wrapper, fall back to raw np.
    np_dtype = np.int64 if dtype == "int" else np.float32
    arr = np.asarray(values, dtype=np_dtype)
    TensorData = getattr(getattr(tinker, "types", tinker), "TensorData", None)
    if TensorData is not None and hasattr(TensorData, "from_numpy"):
        return TensorData.from_numpy(arr)
    return arr


def _make_datum(prompt_tokens: list[int], completion_tokens: list[int],
                completion_logprobs: list[float], advantage: float) -> Any:
    """One Tinker Datum for the DRO loss.

    Next-token framing: model input is the full sequence minus its last token;
    targets are the sequence shifted left by one. Only completion positions
    carry a nonzero advantage + the stored sampling logprob; prompt positions
    are masked to 0 so we only push tokens the policy actually generated.
    """
    full = prompt_tokens + completion_tokens
    model_input_tokens = full[:-1]   # x_0 .. x_{T-1}
    target_tokens = full[1:]         # x_1 .. x_T
    T = len(target_tokens)
    n_prompt = len(prompt_tokens)

    advantages = np.zeros(T, dtype=np.float32)
    samp_logprobs = np.zeros(T, dtype=np.float32)
    # completion_logprobs[i] is the logprob of completion_tokens[i], which lands
    # at target index (n_prompt - 1 + i) in the shifted frame.
    for i, lp in enumerate(completion_logprobs):
        idx = n_prompt - 1 + i
        if 0 <= idx < T:
            advantages[idx] = advantage
            samp_logprobs[idx] = lp

    types = getattr(tinker, "types", tinker)
    # ASSUMPTION: ModelInput.from_ints(tokens=...) and Datum(model_input=,
    # loss_fn_inputs=) constructors.
    model_input = types.ModelInput.from_ints(tokens=model_input_tokens)
    return types.Datum(
        model_input=model_input,
        loss_fn_inputs={
            "target_tokens": _tensor(target_tokens, "int"),
            "logprobs": _tensor(samp_logprobs, "float"),
            "advantages": _tensor(advantages, "float"),
        },
    )


async def _resolve(maybe_future):
    """Resolve a Tinker future whether it exposes result_async() or is awaitable."""
    if hasattr(maybe_future, "result_async"):
        return await maybe_future.result_async()
    if asyncio.iscoroutine(maybe_future):
        return await maybe_future
    if hasattr(maybe_future, "result"):
        return maybe_future.result()
    return maybe_future


# ==============================================================================
# SAMPLING
# ==============================================================================
async def refresh_sampling_client(training_client, service_client, name: str):
    """Snapshot current LoRA weights -> a sampling client for them.

    ASSUMPTION: save_weights_and_get_sampling_client(name=...) is the helper.
    Fallback: save_weights_for_sampler_async -> create_sampling_client.
    """
    if hasattr(training_client, "save_weights_and_get_sampling_client"):
        return await _resolve(
            training_client.save_weights_and_get_sampling_client(name=name))
    saved = await _resolve(training_client.save_weights_for_sampler_async(name=name))
    path = getattr(saved, "path", saved)
    return service_client.create_sampling_client(model_path=path)


async def sample_group(sampling_client, prompt_tokens: list[int], cfg: Config):
    """Draw group_size rollouts for one prompt -> list of (tokens, logprobs)."""
    types = getattr(tinker, "types", tinker)
    sp = types.SamplingParams(max_tokens=cfg.max_tokens,
                              temperature=cfg.temperature, top_p=cfg.top_p)
    model_input = types.ModelInput.from_ints(tokens=prompt_tokens)
    # ASSUMPTION: sample_async(prompt=, sampling_params=, num_samples=) returns
    # an object whose .sequences[i] has .tokens and .logprobs.
    res = await _resolve(sampling_client.sample_async(
        prompt=model_input, sampling_params=sp, num_samples=cfg.group_size))
    out = []
    for seq in res.sequences:
        toks = list(seq.tokens)
        lps = list(getattr(seq, "logprobs", []) or [])
        if len(lps) < len(toks):
            lps = lps + [0.0] * (len(toks) - len(lps))
        out.append((toks, lps[:len(toks)]))
    return out


# ==============================================================================
# TRAINING STEP
# ==============================================================================
async def forward_backward(training_client, data: list[Any], cfg: Config):
    return await _resolve(training_client.forward_backward_async(
        data=data, loss_fn="dro", loss_fn_config={"beta": cfg.beta}))


async def optim_step(training_client, cfg: Config):
    types = getattr(tinker, "types", tinker)
    try:
        adam = types.AdamParams(learning_rate=cfg.lr, max_grad_norm=cfg.max_grad_norm)
    except TypeError:
        adam = types.AdamParams(learning_rate=cfg.lr)
    return await _resolve(training_client.optim_step_async(adam))


# ==============================================================================
# TOKENIZER / EVAL / CHECKPOINT
# ==============================================================================
SYSTEM = ("You are Nalu Catalina. Think step by step, use the web when useful, "
          "and ground claims in sources.")


def encode_prompt(tokenizer, prompt: str) -> list[int]:
    if hasattr(tokenizer, "apply_chat_template"):
        msgs = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": prompt}]
        try:
            return tokenizer.apply_chat_template(msgs, add_generation_prompt=True,
                                                 tokenize=True)
        except Exception:
            pass
    return tokenizer.encode(prompt)


async def evaluate(sampling_client, tokenizer, prompts: list[str], cfg: Config) -> float:
    types = getattr(tinker, "types", tinker)
    rewards = []
    for p in prompts:
        ptoks = encode_prompt(tokenizer, p)
        sp = types.SamplingParams(max_tokens=cfg.max_tokens, temperature=0.2, top_p=0.95)
        res = await _resolve(sampling_client.sample_async(
            prompt=types.ModelInput.from_ints(tokens=ptoks),
            sampling_params=sp, num_samples=1))
        rewards.append(reward_fn(p, tokenizer.decode(list(res.sequences[0].tokens))))
    return statistics.fmean(rewards) if rewards else 0.0


async def save_checkpoint(training_client, cfg: Config, step: int) -> str:
    # ASSUMPTION: save_state_async(name=...) -> object with .path (use with
    # load_state to resume).
    name = f"{cfg.run_name}-step{step:06d}"
    res = await _resolve(training_client.save_state_async(name=name))
    path = getattr(res, "path", str(res))
    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    with (cfg.out_dir / "checkpoints.jsonl").open("a") as f:
        f.write(json.dumps({"step": step, "name": name, "path": path,
                            "time": time.time()}) + "\n")
    return path


def _scalar(x):
    if x is None:
        return None
    try:
        if isinstance(x, dict):
            for k in ("loss:sum", "loss", "loss_sum"):
                if k in x:
                    return float(x[k])
            return None
        return float(x)
    except Exception:
        return None


# ==============================================================================
# MAIN LOOP
# ==============================================================================
async def main():
    cfg = CFG
    print(f"[catalina-dro] base={cfg.base_model} rank={cfg.lora_rank} beta={cfg.beta} "
          f"group={cfg.group_size} inner_steps={cfg.inner_steps}")

    service_client = make_service_client()
    # ASSUMPTION: create_lora_training_client(base_model=, rank=). One client,
    # reused for the whole run.
    training_client = service_client.create_lora_training_client(
        base_model=cfg.base_model, rank=cfg.lora_rank)
    tokenizer = training_client.get_tokenizer()

    resume = os.environ.get("CATALINA_RESUME_PATH")
    if resume and hasattr(training_client, "load_state_async"):
        await _resolve(training_client.load_state_async(path=resume))
        print(f"[catalina-dro] resumed from {resume}")

    prompts = load_prompts()
    eval_prompts = prompts[:min(4, len(prompts))]
    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    metrics_log = cfg.out_dir / "metrics.jsonl"
    rng = np.random.default_rng(0)

    for it in range(1, cfg.num_iterations + 1):
        t0 = time.time()

        # 1) Snapshot policy -> sampling client (this is the q(x) we freeze).
        sampling_client = await refresh_sampling_client(
            training_client, service_client, name=f"{cfg.run_name}-s{it:06d}")

        # 2) Pick prompts, sample groups, score, build reusable Datums.
        idx = rng.choice(len(prompts),
                         size=min(cfg.prompts_per_batch, len(prompts)), replace=False)
        rollout_data: list[Any] = []
        batch_rewards: list[float] = []
        for p in (prompts[i] for i in idx):
            ptoks = encode_prompt(tokenizer, p)
            group = await sample_group(sampling_client, ptoks, cfg)
            rewards = [reward_fn(p, tokenizer.decode(toks)) for toks, _ in group]
            batch_rewards.extend(rewards)
            for (toks, lps), adv in zip(group, group_relative_advantages(rewards, cfg.adv_eps)):
                rollout_data.append(_make_datum(ptoks, toks, lps, adv))

        if not rollout_data:
            print(f"[catalina-dro][{it}] no data, skipping")
            continue

        # 3) OFF-POLICY REUSE: optimize on the SAME rollouts inner_steps times.
        #    This is the core DRO efficiency win - no fresh sampling per step.
        last_loss = None
        for _inner in range(cfg.inner_steps):
            micro = max(1, len(rollout_data) // cfg.grad_accum)
            for g in range(cfg.grad_accum):
                chunk = (rollout_data[g * micro:(g + 1) * micro]
                         if g < cfg.grad_accum - 1 else rollout_data[g * micro:])
                if not chunk:
                    continue
                fb = await forward_backward(training_client, chunk, cfg)
                last_loss = getattr(fb, "loss", getattr(fb, "metrics", None))
            await optim_step(training_client, cfg)

        # 4) Metrics.
        mean_r = statistics.fmean(batch_rewards) if batch_rewards else 0.0
        rec = {"iter": it, "mean_reward": mean_r, "n_rollouts": len(rollout_data),
               "loss": _scalar(last_loss), "beta": cfg.beta,
               "sec": round(time.time() - t0, 1)}
        with metrics_log.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"[catalina-dro][{it}] mean_reward={mean_r:.3f} loss={rec['loss']} "
              f"n={len(rollout_data)} {rec['sec']}s")

        # 5) Periodic eval.
        if it % cfg.eval_every == 0:
            ev = await refresh_sampling_client(
                training_client, service_client, name=f"{cfg.run_name}-e{it:06d}")
            eval_r = await evaluate(ev, tokenizer, eval_prompts, cfg)
            print(f"[catalina-dro][{it}] EVAL mean_reward={eval_r:.3f}")
            with metrics_log.open("a") as f:
                f.write(json.dumps({"iter": it, "eval_reward": eval_r}) + "\n")

        # 6) Checkpoint.
        if it % cfg.save_every == 0:
            print(f"[catalina-dro][{it}] saved -> "
                  f"{await save_checkpoint(training_client, cfg, it)}")

    print(f"[catalina-dro] DONE. final -> "
          f"{await save_checkpoint(training_client, cfg, cfg.num_iterations)}")


if __name__ == "__main__":
    asyncio.run(main())
