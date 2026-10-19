#!/usr/bin/env python3
"""Experimental completion-masked DRO training on independently reviewed tasks.

The loss uses the quadratic DRO objective with group-relative advantages.
The supported custom-loss API slices out prompt positions before BOTH terms,
so prompt tokens receive no gradient. References come from the sampler and
must match every completion token; no synthetic zero padding is permitted.

Training and held-out evaluation require separate, reviewed JSON task files.
The built-in grader compares complete JSON answers with explicit ground truth;
it does not reward style, length, source words, or invented browsing. Results
only establish accuracy on those tasks, not general intelligence or expertise.

Official contracts verified October 2026:
https://tinker-docs.thinkingmachines.ai/tinker/losses/dro/
https://tinker-docs.thinkingmachines.ai/tinker/losses/custom/
The custom loss adds a forward pass relative to built-in DRO. Pin and qualify
SDK/model versions before any paid run. No model is automatically deployed.
"""

from __future__ import annotations

import asyncio
import json
import hashlib
import inspect
import math
import os
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

import numpy as np

import tinker  # pip install tinker torch
import torch


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

    max_generated_tokens: int = int(os.environ.get("CATALINA_MAX_GENERATED_TOKENS", "1000000"))

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
def load_tasks(path: str, split: str) -> list[dict]:
    if not path:
        raise ValueError(f"CATALINA_{'PROMPTS' if split == 'train' else 'EVAL'}_FILE is required; no proxy-reward defaults")
    tasks = []
    for i, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line.strip():
            continue
        task = json.loads(line)
        if (not isinstance(task, dict) or not task.get("id") or not isinstance(task.get("prompt"), str)
            or not task["prompt"].strip() or task.get("split") != split or task.get("grader") != "json-exact"
            or "expected" not in task or not task.get("provenance", {}).get("source")
            or not task.get("provenance", {}).get("reviewedBy")):
            raise ValueError(f"Invalid independently reviewed {split} task at row {i}")
        tasks.append(task)
    if not tasks:
        raise ValueError(f"Empty {split} task set")
    return tasks


def task_fingerprint(task):
    return " ".join(task["prompt"].casefold().split())


def validate_disjoint_tasks(train, evaluation):
    prompts, ids = set(), set()
    for task in train + evaluation:
        prompt = task_fingerprint(task)
        if prompt in prompts or task["id"] in ids:
            raise ValueError("Repeated task ID or prompt in train/evaluation sets")
        prompts.add(prompt)
        ids.add(task["id"])


def reward_fn(task: dict, completion_text: str) -> float:
    """Ground-truth correctness only: prose scaffolding/URLs/length earn nothing.

    The reviewed prompt must specify the JSON answer contract. This restricted
    grader supports deterministic tasks, not unverified medical/web claims.
    """
    text = completion_text.strip()
    if text.startswith("```json\n") and text.endswith("\n```"):
        text = text[8:-4]
    try:
        value = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
    except (ValueError, TypeError):
        return 0.0
    def equal(actual, expected):
        if isinstance(expected, bool) or expected is None or isinstance(expected, str):
            return type(actual) is type(expected) and actual == expected
        if isinstance(expected, (int, float)):
            return type(actual) in (int, float) and math.isfinite(actual) and math.isclose(actual, expected, rel_tol=0, abs_tol=1e-9)
        if isinstance(expected, list):
            return isinstance(actual, list) and len(actual) == len(expected) and all(equal(a, b) for a, b in zip(actual, expected))
        if isinstance(expected, dict):
            return isinstance(actual, dict) and actual.keys() == expected.keys() and all(equal(actual[k], v) for k, v in expected.items())
        return False
    return float(equal(value, task["expected"]))


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


@dataclass
class MaskedRollout:
    datum: Any
    completion_start: int
    reference_logprobs: list[float]
    advantage: float


def _make_datum(prompt_tokens: list[int], completion_tokens: list[int],
                completion_logprobs: list[float], advantage: float) -> MaskedRollout:
    if not prompt_tokens or not completion_tokens:
        raise ValueError("DRO requires nonempty prompt and completion token sequences")
    if len(completion_logprobs) != len(completion_tokens):
        raise ValueError("Sampling logprobs must align exactly with completion tokens")
    if not math.isfinite(advantage) or any(not isinstance(lp, (int, float)) or not math.isfinite(lp) or lp > 0 for lp in completion_logprobs):
        raise ValueError("DRO requires finite advantages and real nonpositive sampling logprobs")
    full = prompt_tokens + completion_tokens
    types = getattr(tinker, "types", tinker)
    datum = types.Datum(model_input=types.ModelInput.from_ints(tokens=full[:-1]),
                        loss_fn_inputs={"target_tokens": _tensor(full[1:], "int")})
    return MaskedRollout(datum, len(prompt_tokens) - 1, list(completion_logprobs), advantage)


def masked_dro_loss(rollouts, logprobs, beta):
    if len(rollouts) != len(logprobs) or not rollouts or not math.isfinite(beta) or beta < 0:
        raise ValueError("Invalid DRO batch or beta")
    losses = []
    for rollout, target in zip(rollouts, logprobs):
        # Slicing removes prompt tokens from BOTH the advantage and penalty.
        # Zero advantages alone do not mask the quadratic DRO regularizer.
        completion = target[rollout.completion_start:]
        if completion.ndim != 1 or len(completion) != len(rollout.reference_logprobs):
            raise ValueError("Model logprob output does not match sampled completion")
        reference = torch.as_tensor(rollout.reference_logprobs, dtype=target.dtype, device=target.device)
        losses.append(-(completion * rollout.advantage - 0.5 * beta * (completion - reference).square()).sum())
    loss = torch.stack(losses).sum()
    return loss, {"loss:sum": float(loss.detach()), "completion_tokens": sum(len(r.reference_logprobs) for r in rollouts)}


async def _resolve(value):
    # SDK async methods can return an APIFuture; resolve both levels.
    while True:
        if hasattr(value, "result_async"):
            value = await value.result_async()
        elif inspect.isawaitable(value):
            value = await value
        elif hasattr(value, "result"):
            value = value.result()
        else:
            return value


# ==============================================================================
# SAMPLING
# ==============================================================================
async def refresh_sampling_client(training_client, service_client, name: str):
    """Snapshot current LoRA weights -> a sampling client for them.

    ASSUMPTION: save_weights_and_get_sampling_client(name=...) is the helper.
    Fallback: save_weights_for_sampler_async -> create_sampling_client.
    """
    if hasattr(training_client, "save_weights_and_get_sampling_client_async"):
        return await _resolve(training_client.save_weights_and_get_sampling_client_async(name=name))
    saved = await _resolve(training_client.save_weights_for_sampler_async(name=name))
    return await _resolve(service_client.create_sampling_client_async(model_path=saved.path))


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
        if not toks or len(lps) != len(toks) or any(not isinstance(lp, (int, float)) or not math.isfinite(lp) or lp > 0 for lp in lps):
            raise ValueError("Sampler omitted or misaligned its token logprobs")
        out.append((toks, lps))
    if len(out) != cfg.group_size:
        raise ValueError("Sampler returned an incomplete rollout group")
    return out


# ==============================================================================
# TRAINING STEP
# ==============================================================================
async def forward_backward(training_client, data: list[Any], cfg: Config):
    # Built-in DRO has no documented per-token mask input. The supported custom
    # loss API computes exact autograd gradients of the completion-only loss.
    # https://tinker-docs.thinkingmachines.ai/tinker/losses/custom/
    return await _resolve(training_client.forward_backward_custom_async(
        data=[r.datum for r in data],
        loss_fn=lambda _data, logprobs: masked_dro_loss(data, logprobs, cfg.beta)))


async def optim_step(training_client, cfg: Config):
    types = getattr(tinker, "types", tinker)
    adam = types.AdamParams(learning_rate=cfg.lr, max_grad_norm=cfg.max_grad_norm)
    return await _resolve(training_client.optim_step_async(adam))


# ==============================================================================
# TOKENIZER / EVAL / CHECKPOINT
# ==============================================================================
SYSTEM = "You are Nalu Catalina. Solve the task accurately and follow its requested JSON output contract. Do not invent tool use or evidence."


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


async def evaluate(sampling_client, tokenizer, tasks: list[dict], cfg: Config) -> float:
    types = getattr(tinker, "types", tinker)
    rewards = []
    for task in tasks:
        ptoks = encode_prompt(tokenizer, task["prompt"])
        sp = types.SamplingParams(max_tokens=cfg.max_tokens, temperature=0.2, top_p=0.95)
        res = await _resolve(sampling_client.sample_async(
            prompt=types.ModelInput.from_ints(tokens=ptoks),
            sampling_params=sp, num_samples=1))
        rewards.append(reward_fn(task, tokenizer.decode(list(res.sequences[0].tokens))))
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

    tasks = load_tasks(os.environ.get("CATALINA_PROMPTS_FILE"), "train")
    eval_tasks = load_tasks(os.environ.get("CATALINA_EVAL_FILE"), "test")
    validate_disjoint_tasks(tasks, eval_tasks)
    for value in (cfg.group_size, cfg.prompts_per_batch, cfg.inner_steps, cfg.grad_accum, cfg.num_iterations, cfg.save_every, cfg.eval_every):
        if value < 1:
            raise ValueError("Loop and evaluation counts must be positive")
    if cfg.group_size < 2 or not math.isfinite(cfg.beta) or cfg.beta < 0:
        raise ValueError("Need group size >=2 and finite nonnegative beta")
    generated_token_bound = (cfg.num_iterations * min(cfg.prompts_per_batch, len(tasks)) * cfg.group_size
                             + (1 + cfg.num_iterations // cfg.eval_every) * len(eval_tasks)) * cfg.max_tokens
    if cfg.max_generated_tokens < 1 or generated_token_bound > cfg.max_generated_tokens:
        raise ValueError("Configured worst-case generated tokens exceed CATALINA_MAX_GENERATED_TOKENS; reduce the run or explicitly budget more")
    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"trainSha256": hashlib.sha256(Path(os.environ["CATALINA_PROMPTS_FILE"]).read_bytes()).hexdigest(),
                "testSha256": hashlib.sha256(Path(os.environ["CATALINA_EVAL_FILE"]).read_bytes()).hexdigest(),
                "trainTasks": len(tasks), "testTasks": len(eval_tasks), "grader": "reviewed-json-exact", "base": cfg.base_model,
                "generatedTokenUpperBound": generated_token_bound, "scope": "Deterministic held-out task accuracy, not general intelligence or web-grounding quality"}
    (cfg.out_dir / "dataset-manifest.json").write_text(json.dumps(manifest, indent=2))
    if os.environ.get("CATALINA_VALIDATE_ONLY") == "1":
        print(json.dumps(manifest))
        return
    service_client = make_service_client()
    # ASSUMPTION: create_lora_training_client(base_model=, rank=). One client,
    # reused for the whole run.
    training_client = await _resolve(service_client.create_lora_training_client_async(
        base_model=cfg.base_model, rank=cfg.lora_rank))
    tokenizer = training_client.get_tokenizer()

    resume = os.environ.get("CATALINA_RESUME_PATH")
    if resume and hasattr(training_client, "load_state_async"):
        await _resolve(training_client.load_state_async(path=resume))
        print(f"[catalina-dro] resumed from {resume}")

    cfg.out_dir.mkdir(parents=True, exist_ok=True)
    metrics_log = cfg.out_dir / "metrics.jsonl"
    rng = np.random.default_rng(0)
    baseline = await refresh_sampling_client(training_client, service_client, name=f"{cfg.run_name}-baseline")
    baseline_accuracy = await evaluate(baseline, tokenizer, eval_tasks, cfg)
    with metrics_log.open("a") as f:
        f.write(json.dumps({"iter": 0, "heldout_exact_accuracy": baseline_accuracy, "tasks": len(eval_tasks), "dataset": manifest["testSha256"]}) + "\n")

    for it in range(1, cfg.num_iterations + 1):
        t0 = time.time()

        # 1) Snapshot policy -> sampling client (this is the q(x) we freeze).
        sampling_client = await refresh_sampling_client(
            training_client, service_client, name=f"{cfg.run_name}-s{it:06d}")

        # 2) Pick prompts, sample groups, score, build reusable Datums.
        idx = rng.choice(len(tasks),
                         size=min(cfg.prompts_per_batch, len(tasks)), replace=False)
        rollout_data: list[Any] = []
        batch_rewards: list[float] = []
        for task in (tasks[i] for i in idx):
            ptoks = encode_prompt(tokenizer, task["prompt"])
            group = await sample_group(sampling_client, ptoks, cfg)
            rewards = [reward_fn(task, tokenizer.decode(toks)) for toks, _ in group]
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
            eval_r = await evaluate(ev, tokenizer, eval_tasks, cfg)
            print(f"[catalina-dro][{it}] HELDOUT exact_accuracy={eval_r:.3f}")
            with metrics_log.open("a") as f:
                f.write(json.dumps({"iter": it, "heldout_exact_accuracy": eval_r, "tasks": len(eval_tasks), "dataset": manifest["testSha256"]}) + "\n")

        # 6) Checkpoint.
        if it % cfg.save_every == 0:
            print(f"[catalina-dro][{it}] saved -> "
                  f"{await save_checkpoint(training_client, cfg, it)}")

    print(f"[catalina-dro] DONE. final -> "
          f"{await save_checkpoint(training_client, cfg, cfg.num_iterations)}")


if __name__ == "__main__":
    asyncio.run(main())
