#!/usr/bin/env python3
"""
train_nalu_sft.py — LoRA distillation fine-tuning of a per-domain Nalu model on
Thinking Machines **Tinker**. VERIFIED against tinker SDK 0.22.7 (trained + served
nalu-cre-v1 end-to-end). Supports TWO base families with the correct chat format:

  • Qwen bases (Qwen3.x) → hand-rolled ChatML (<|im_start|>…)
  • thinkingmachines/Inkling → the OFFICIAL tml-renderers pipeline (o200k_base_chat
    tokenizer + Renderer.render_for_sft), which is REQUIRED — Inkling is not ChatML.
    `pip install tml-renderers` (already in this venv). Rendering validated offline.

  pip install tinker tml-renderers jinja2 numpy
  export TINKER_API_KEY=...          # or it is read from ../.env.local
  # Inkling (the new baseline):
  python train_nalu_sft.py --domain cre --data data/nalu-cre.jsonl \
      --base thinkingmachines/Inkling --epochs 3 --out nalu-cre-inkling-v1
  # (base defaults to $NALU_BASE_MODEL, else thinkingmachines/Inkling)

Prints the served model path to wire into NALU_<DOMAIN>_MODEL (Tinker's OpenAI
endpoint serves it directly — no proxy). Data JSONL rows: {system,user,assistant}
or agentic {system, turns:[{user,assistant},…]}.
"""
import argparse, hashlib, importlib.metadata, json, math, os, random, subprocess
from pathlib import Path
import numpy as np, tinker, tinker.types as T

DEFAULT_BASE = os.environ.get("NALU_BASE_MODEL", "thinkingmachines/Inkling")


def load_key():
    if os.environ.get("TINKER_API_KEY"):
        return
    for p in (".env.local", "../.env.local"):
        if os.path.exists(p):
            for line in open(p):
                if line.startswith("TINKER_API_KEY="):
                    v = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if v:
                        os.environ["TINKER_API_KEY"] = v
                        return


# ── Qwen ChatML path (unchanged; still used for Qwen bases) ───────────────────
def chatml(tok, system, user, assistant, maxlen):
    p = f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
    full = tok.encode(p + assistant + "<|im_end|>")
    prompt = tok.encode(p)
    mask = [0] * min(len(prompt), len(full)) + [1] * max(0, len(full) - len(prompt))
    return full, mask[:len(full)]


def chatml_turns(tok, system, turns, maxlen):
    ids, mask = [], []

    def add(text, w):
        t = tok.encode(text)
        ids.extend(t)
        mask.extend([w] * len(t))

    add(f"<|im_start|>system\n{system}<|im_end|>\n", 0)
    for t in turns:
        add(f"<|im_start|>user\n{t['user']}<|im_end|>\n<|im_start|>assistant\n", 0)
        add(t["assistant"] + "<|im_end|>", 1)
        add("\n", 0)
    return ids, mask


def _datum(full, mask):
    """Build a Tinker cross-entropy Datum from a token list + per-token loss mask
    (teacher-forcing shift: predict token i+1 from tokens[:i])."""
    return T.Datum(
        model_input=T.ModelInput.from_ints(full[:-1]),
        loss_fn_inputs={
            "target_tokens": T.TensorData.from_numpy(np.array(full[1:], dtype=np.int64)),
            "weights": T.TensorData.from_numpy(np.array(mask[1:], dtype=np.float32)),
        })


def encode_chatml(rows, tok, maxlen):
    data = []
    for r in rows:
        if r.get("turns"):
            full, mask = chatml_turns(tok, r.get("system", ""), r["turns"], maxlen)
        elif r.get("user") and r.get("assistant"):
            full, mask = chatml(tok, r.get("system", ""), r["user"], r["assistant"], maxlen)
        else:
            continue
        if len(full) > maxlen or sum(mask) == 0 or len(full) < 4:
            continue
        data.append(_datum(full, mask))
    return data


# ── Inkling path (official tml-renderers; REQUIRED for correct Inkling format) ─
def encode_inkling(rows, maxlen):
    from tml_renderers.v0 import Renderer
    from tml_renderers import chat, tokenizers, tinker as Rtinker
    A = chat.AuthorKind
    tok = tokenizers.o200k_base_chat()
    r = Renderer(tok)

    def msg(kind, text):
        return chat.Message(content=chat.Text(str(text)), author=chat.Author(kind=kind))

    data = []
    for row in rows:
        sys = row.get("system", "")
        # Normalize single-turn QA and agentic multi-turn into a message list.
        if row.get("turns"):
            turns = row["turns"]
        elif row.get("user") and row.get("assistant"):
            turns = [{"user": row["user"], "assistant": row["assistant"]}]
        else:
            continue
        msgs = [msg(A.System, sys)] if sys else []
        for t in turns:
            msgs.append(msg(A.User, t.get("user", "")))
            msgs.append(msg(A.Model, t.get("assistant", "")))
        # render_for_sft returns ONE example per assistant turn (context → response,
        # loss on the response) — each becomes its own training Datum.
        for ex in r.render_for_sft(msgs):
            mi, w = Rtinker.training_example_to_tinker_model_input_and_weights(ex)
            full = list(mi.to_ints())
            weights = list(w)
            # A token tail can discard the question or break message boundaries.
            # Keep complete rendered examples only; report skipped examples.
            if len(full) > maxlen:
                continue
            if len(full) < 4 or sum(weights[1:]) == 0:
                continue
            data.append(_datum(full, weights))
    return data


def validate_dataset(path):
    policy = Path(__file__).with_name("dataset-policy.mjs")
    result = subprocess.run(["node", str(policy), "--export", str(Path(path).resolve())], capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "Dataset review rejected rows")
    return json.loads(result.stdout)


def token_count(data):
    return sum(sum(d.loss_fn_inputs["weights"].data) for d in data)


def measured_loss(result, tokens):
    value = (getattr(result, "metrics", None) or {}).get("loss:sum")
    if value is None or not math.isfinite(float(value)) or tokens <= 0:
        raise RuntimeError("Training API returned no finite loss measurement")
    return float(value) / tokens


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--renderer", choices=["auto", "chatml", "inkling"], default="auto")
    ap.add_argument("--out", default=None)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--maxlen", type=int, default=8192)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-train-tokens", type=int, default=2000000)
    ap.add_argument("--resume", default=None)
    ap.add_argument("--receipts-dir", default="checkpoints")
    a = ap.parse_args()
    if min(a.epochs, a.rank, a.maxlen, a.batch, a.max_train_tokens) <= 0 or not math.isfinite(a.lr) or a.lr <= 0:
        raise ValueError("Training limits must be positive")
    out = a.out or f"nalu-{a.domain}-v1"
    if not out or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in out):
        raise ValueError("Invalid output name")
    # Fail before creating a paid remote training client. Legacy files are kept
    # intact, but need a hash-bound review manifest before they can be uploaded.
    dataset = validate_dataset(a.data)
    rows = dataset["accepted"]
    surface = "terminal" if a.domain == "agent" else "web"
    if any(r["training"]["surface"] != surface or (a.domain != "agent" and r["training"]["domain"] != a.domain) for r in rows):
        raise ValueError("Dataset surface/domain does not match the training lane")
    train_rows = [r for r in rows if r["training"]["split"] == "train"]
    validation_rows = [r for r in rows if r["training"]["split"] == "validation"]
    if not train_rows or not validation_rows:
        raise ValueError("Reviewed, disjoint train and validation rows are required")
    renderer = a.renderer
    if renderer == "auto":
        renderer = "inkling" if "inkling" in a.base.lower() else "chatml"
    if ("inkling" in a.base.lower()) != (renderer == "inkling"):
        raise ValueError("Base model and renderer do not match")
    if renderer == "inkling":
        encode = lambda values: encode_inkling(values, a.maxlen)
    else:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(a.base, trust_remote_code=False)
        encode = lambda values: encode_chatml(values, tok, a.maxlen)
    data, validation = encode(train_rows), encode(validation_rows)
    if not data or not validation:
        raise ValueError("No complete train/validation examples fit maxlen; increase maxlen or curate shorter conversations")
    # Bound all forward/backward positions, not only answer tokens. This is a
    # token-work budget, not a price guarantee (pricing depends on the provider).
    training_tokens = sum(len(d.loss_fn_inputs["target_tokens"].data) for d in data) * a.epochs
    evaluation_tokens = sum(len(d.loss_fn_inputs["target_tokens"].data) for d in validation) * (a.epochs + 1)
    if training_tokens + evaluation_tokens > a.max_train_tokens:
        raise ValueError("Configured train + validation token-work budget exceeded")
    receipt_dir = Path(a.receipts_dir) / out
    receipt_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"schemaVersion": 1, "datasetSha256": dataset["datasetSha256"], "base": a.base, "renderer": renderer,
                "seed": a.seed, "config": vars(a), "trainExamples": len(data), "validationExamples": len(validation),
                "testRowsNotUsed": sum(r["training"]["split"] == "test" for r in rows),
                "trainingTokens": training_tokens, "evaluationTokens": evaluation_tokens,
                "libraries": {name: importlib.metadata.version(name) for name in ("tinker", "numpy")}}
    (receipt_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    load_key()
    sc = tinker.ServiceClient()
    tc = sc.create_lora_training_client(base_model=a.base, rank=a.rank)
    if a.resume:
        tc.load_state(a.resume).result()
    adam = T.AdamParams(learning_rate=a.lr)
    rng = random.Random(a.seed)
    metrics_file = receipt_dir / "metrics.jsonl"
    def record(value):
        with metrics_file.open("a") as f:
            f.write(json.dumps(value) + "\n")
    def evaluate(epoch):
        total, weights = 0., 0.
        for i in range(0, len(validation), a.batch):
            batch = validation[i:i + a.batch]
            n = token_count(batch)
            total += measured_loss(tc.forward(batch, loss_fn="cross_entropy").result(), n) * n
            weights += n
        result = {"epoch": epoch, "validationTokenLoss": total / weights, "scope": "held-out teacher-token loss; not task correctness"}
        record(result)
        return result
    evaluate(0)
    step = 0
    for ep in range(a.epochs):
        rng.shuffle(data)
        for i in range(0, len(data), a.batch):
            batch = data[i:i + a.batch]
            loss = measured_loss(tc.forward_backward(batch, loss_fn="cross_entropy").result(), token_count(batch))
            tc.optim_step(adam).result()
            step += 1
            record({"epoch": ep + 1, "step": step, "trainTokenLoss": loss})
        heldout = evaluate(ep + 1)
        state_path = tc.save_state(name=f"{out}-epoch{ep + 1}").result().path
        record({"epoch": ep + 1, "statePath": state_path})
        print(f"[nalu-sft] epoch {ep + 1}/{a.epochs} done ({step} steps)")
    model_path = tc.save_weights_for_sampler(name=out).result().path
    if not str(model_path).startswith("tinker://"):
        raise RuntimeError("Sampler save did not return a Tinker checkpoint path")
    result = {"schemaVersion": 1, "success": True, "saved": True, "modelPath": str(model_path),
              "datasetSha256": dataset["datasetSha256"], "validation": {"completed": True, **heldout}}
    (receipt_dir / "result.json").write_text(json.dumps(result, indent=2))
    print(f"[nalu-sft] DONE. Served model path:\n{model_path}")
    print("NALU_TRAINING_RESULT " + json.dumps(result))


if __name__ == "__main__":
    main()
