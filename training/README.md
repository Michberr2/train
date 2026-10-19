# Nalu training and evaluation

Training outputs are candidates. A saved checkpoint, lower loss, or correctly
formatted response does not establish task accuracy or superiority over another
model. The scripts do not automatically manufacture quality/consent evidence for
existing datasets.

## Reviewed datasets

Before SFT or flywheel inclusion, each row needs a `training` review record, or an
entry in `<dataset>.review.json` tied to the exact dataset and row hashes. Run:

```sh
node training/dataset-policy.mjs --audit training/data/nalu-math.jsonl
node --test training/training-env.test.mjs training/execution-gate.test.mjs training/training-safety.test.mjs
training/.venv/bin/python -m unittest discover -s training -p test_training_correctness.py
```

The audit prints hashes/rejection reasons rather than conversation text. It does
not grant consent or approval. Legacy data is retained and excluded until reviewed.
A row's `training` record has this schema:

```json
{
  "schemaVersion": 1,
  "contentSha256": "SHA256 computed by contentHash(row) in dataset-policy.mjs",
  "source": {"kind": "synthetic", "id": "source-record", "version": "1", "teacher": "actual-model-version"},
  "consent": {"remoteTraining": true, "recordId": "actual-authorization-record"},
  "review": {"redaction": "passed", "quality": "passed", "reviewer": "independent-reviewer", "evidence": "actual-check-receipt"},
  "surface": "web",
  "domain": "math",
  "split": "train"
}
```

These are attestations that must correspond to real evidence. A generator's own
`verified: true` is insufficient. Sources may be `synthetic`, `licensed`, or
`user-session`; synthetic sources also identify their teacher. Sessions require
specific remote-training consent in addition to capture consent. Set `deleted:
true` or `consent.revoked: true` to exclude a row. The secret screen catches some
common token formats; independent redaction review remains necessary.

For a sidecar, use `{schemaVersion:1,datasetSha256:"...",rows:{"ROW_HASH":REVIEW}}`.
Changing any dataset byte invalidates the sidecar. Normalized prompt duplicates,
including overlap across splits, fail validation. Use distinct `train`,
`validation`, and optional `test` tasks. Split task families, not paraphrases of
one task, when curating data; the code cannot establish semantic independence.

## Supervised fine-tuning

`train_nalu_sft.py` validates provenance, surface/domain and train/validation
separation, then tokenizes before creating a paid training client. It uses the
Inkling renderer for Inkling; Qwen uses its local tokenizer. Overlong examples
are omitted whole, never cut into token tails without their instructions.

```sh
training/.venv/bin/python training/train_nalu_sft.py --domain math \
  --data training/data/nalu-math.jsonl --base thinkingmachines/Inkling \
  --out math-reviewed-v1 --epochs 2 --max-train-tokens 2000000
```

A seeded shuffle, dataset/config/library manifest, batch losses, held-out token
loss, epoch state checkpoints, and final sampler receipt are saved in
`checkpoints/<out>/`. `--resume` restores an explicitly selected training state
for the configured additional epochs. Held-out teacher-token loss measures
imitation, not independent answer correctness. Task-quality gates run separately.
The token-work limit bounds train and validation positions, not a dollar bill.

The sequential and parallel drivers share one registry lock. They require exit
0 and a structured final sampler-save receipt with held-out validation before
registering a model. Existing registry entries remain preserved and are not
relabelled as qualified. Use `CONC=1 node training/train_par.mjs --all` or the
`train_fleet.sh` wrapper; no domain is hardcoded as already trained.

## Flywheel promotion

`flywheel.mjs --dry-run` audits eligibility without inference, training, env changes,
or deployment. Live runs load training-specific config before deriving settings,
use an exclusive process lock, persist failed states, and exit nonzero on errors.
`FLYWHEEL_MAX_LANES` defaults to 1; `FLYWHEEL_MAX_TRAIN_TOKENS` defaults to 2,000,000
per lane. There is no dollar-cost guarantee; configure the provider's spend cap.

Terminal rows only train the CLI lane. Web specialists only use reviewed web
rows from their own domain files. The CLI lane retains its format threshold and
real fullstack execution gate. A passed gate is an absolute qualification, not
proof of improved execution success across a task distribution.

Web lanes require `training/eval/<lane>-battery.json`, with at least 20 distinct
held-out tasks in three categories, independent provenance, explicit JSON ground
truth, at least 90% candidate accuracy, the configured win margin, no category
regression, and no critical failures. No production domain batteries have been
fabricated or approved by these changes. A legitimate battery has schemaVersion
1, lane, surface `web`, split `test`, provenance `{reviewer,source,version}`, and
cases `{id,prompt,system,category,critical,grader:{type:"json-exact",expected}}`.
This deterministic gate needs broader domain rubrics before making expert claims.

The incumbent comes from a fresh production environment snapshot, including its
lane-specific model/provider. Disabled specialist adapters cannot be promoted.
This configuration snapshot is not a server-side attestation of the serving
model; deployment bindings and live routing still need independent verification.
Environment writes preserve the old value and restore it if writing, publication,
or verification fails. Concurrent model changes cause rejection. The existing
release wrapper performs deployment/domain checks. A process kill or service
outage can prevent rollback; inspect the saved history and production environment
before retrying. No rollback failure is converted into success.

## Completion-masked DRO

`train_catalina_dro.py` is experimental. It uses the documented Tinker custom-loss
API to exclude prompt tokens from both the advantage and quadratic penalty.
Sampling logprobs must be finite, nonpositive and align exactly with completion
tokens. Async SDK futures are resolved fully. PyTorch gradient tests verify zero
prompt gradients and the expected completion gradients.

Both `CATALINA_PROMPTS_FILE` and `CATALINA_EVAL_FILE` are required. JSONL tasks have
`{id,prompt,split,grader:"json-exact",expected,provenance:{source,reviewedBy}}`;
split is `train` or `test` respectively. The prompt must request the actual JSON
answer contract. Duplicate IDs or normalized prompts across either set fail.
The grader compares the entire answer against reviewed ground truth, with no
reward for source words, length or reasoning scaffolding. Baseline and periodic
held-out exact accuracy are recorded with dataset hashes. No browsing/execution
capability or broad improvement is implied by that metric.

```sh
CATALINA_PROMPTS_FILE=/path/to/reviewed-train.jsonl \
CATALINA_EVAL_FILE=/path/to/reviewed-test.jsonl \
CATALINA_ITERS=2 CATALINA_VALIDATE_ONLY=1 \
training/.venv/bin/python training/train_catalina_dro.py
```

Remove `CATALINA_VALIDATE_ONLY=1` only for an intended paid run. The worst-case
number of generated tokens must fit `CATALINA_MAX_GENERATED_TOKENS` (default
1,000,000). Context/training cost is additional; use a provider spend cap.

Official loss contracts: [DRO](https://tinker-docs.thinkingmachines.ai/tinker/losses/dro/)
and [custom losses](https://tinker-docs.thinkingmachines.ai/tinker/losses/custom/).
Custom losses require an additional forward pass. The chosen group-relative
advantage normalization is an experimental design choice, not a reproduction or
proof of superiority of a published training recipe.
