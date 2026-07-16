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
import argparse, json, os, numpy as np, tinker, tinker.types as T

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
    full = tok.encode(p + assistant + "<|im_end|>")[:maxlen]
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
    return ids[:maxlen], mask[:maxlen]


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
        if sum(mask) == 0 or len(full) < 4:
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
            if len(full) > maxlen:  # keep the TAIL so the assistant span survives
                full, weights = full[-maxlen:], weights[-maxlen:]
            if len(full) < 4 or sum(weights[1:]) == 0:
                continue
            data.append(_datum(full, weights))
    return data


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
    a = ap.parse_args()
    out = a.out or f"nalu-{a.domain}-v1"
    load_key()

    renderer = a.renderer
    if renderer == "auto":
        renderer = "inkling" if "inkling" in a.base.lower() else "chatml"

    sc = tinker.ServiceClient()
    tc = sc.create_lora_training_client(base_model=a.base, rank=a.rank)

    rows = [json.loads(l) for l in open(a.data) if l.strip()]
    if renderer == "inkling":
        data = encode_inkling(rows, a.maxlen)
    else:
        data = encode_chatml(rows, tc.get_tokenizer(), a.maxlen)
    print(f"[nalu-sft] {a.domain}: {len(data)} examples · base={a.base} · renderer={renderer} · {a.epochs} epochs")
    if not data:
        raise SystemExit("[nalu-sft] no training examples after encoding — check the data file.")

    adam = T.AdamParams(learning_rate=a.lr)
    step = 0
    for ep in range(a.epochs):
        for i in range(0, len(data), a.batch):
            tc.forward_backward(data[i:i + a.batch], loss_fn="cross_entropy").result()
            tc.optim_step(adam).result()
            step += 1
        print(f"[nalu-sft] epoch {ep + 1}/{a.epochs} done ({step} steps)")

    path = str(getattr(tc.save_weights_for_sampler(name=out).result(), "path", out))
    print(f"[nalu-sft] DONE. Served model path:\n{path}")
    print(f"[nalu-sft] Wire it:  NALU_{a.domain.upper()}_MODEL={path}")
    print(f"[nalu-sft]           NALU_{a.domain.upper()}_BASE_URL=<Tinker OpenAI endpoint>  (defaults to Tinker)")


if __name__ == "__main__":
    main()
