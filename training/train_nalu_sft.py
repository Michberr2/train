#!/usr/bin/env python3
"""
train_nalu_sft.py — LoRA distillation fine-tuning of a per-domain Nalu model on
Thinking Machines **Tinker**. VERIFIED against tinker SDK 0.22.7 (trained + served
nalu-cre-v1 end-to-end).

  pip install tinker jinja2 numpy
  export TINKER_API_KEY=...          # or it is read from ../.env.local
  python train_nalu_sft.py --domain cre --data data/nalu-cre.jsonl \
      --base "Qwen/Qwen3.5-9B" --epochs 4 --out nalu-cre-v1

Prints the served model path to wire into NALU_<DOMAIN>_MODEL (Tinker's OpenAI
endpoint serves it directly — no proxy). Data JSONL rows: {system,user,assistant}.
"""
import argparse, json, os, numpy as np, tinker, tinker.types as T


def load_key():
    if os.environ.get("TINKER_API_KEY"):
        return
    for p in (".env.local", "../.env.local"):
        if os.path.exists(p):
            for line in open(p):
                if line.startswith("TINKER_API_KEY="):
                    os.environ["TINKER_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
                    return


def chatml(tok, system, user, assistant, maxlen):
    p = f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
    full = tok.encode(p + assistant + "<|im_end|>")[:maxlen]
    prompt = tok.encode(p)
    mask = [0] * min(len(prompt), len(full)) + [1] * max(0, len(full) - len(prompt))
    return full, mask[:len(full)]


def chatml_turns(tok, system, turns, maxlen):
    """Multi-turn ChatML for agentic trajectories (rows: {system, turns:[{user,assistant}...]}).
    Loss on EVERY assistant span (the tool-call lines and the final answer) —
    that formatting is exactly what the agent model must learn to emit."""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--base", default="Qwen/Qwen3.5-9B")
    ap.add_argument("--out", default=None)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--maxlen", type=int, default=4096)
    ap.add_argument("--batch", type=int, default=2)
    a = ap.parse_args()
    out = a.out or f"nalu-{a.domain}-v1"
    load_key()

    sc = tinker.ServiceClient()
    tc = sc.create_lora_training_client(base_model=a.base, rank=a.rank)
    tok = tc.get_tokenizer()

    rows = [json.loads(l) for l in open(a.data) if l.strip()]
    data = []
    for r in rows:
        # agentic multi-turn rows ({system, turns}) and single-turn QA rows
        # ({system, user, assistant}) can be mixed in one JSONL file.
        if r.get("turns"):
            full, mask = chatml_turns(tok, r.get("system", ""), r["turns"], a.maxlen)
        elif r.get("user") and r.get("assistant"):
            full, mask = chatml(tok, r.get("system", ""), r["user"], r["assistant"], a.maxlen)
        else:
            continue
        if sum(mask) == 0 or len(full) < 4:
            continue
        data.append(T.Datum(
            model_input=T.ModelInput.from_ints(full[:-1]),
            loss_fn_inputs={
                "target_tokens": T.TensorData.from_numpy(np.array(full[1:], dtype=np.int64)),
                "weights": T.TensorData.from_numpy(np.array(mask[1:], dtype=np.float32)),
            }))
    print(f"[nalu-sft] {a.domain}: {len(data)} examples · base={a.base} · {a.epochs} epochs")

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
