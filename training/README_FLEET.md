# Nalu specialist model candidates

Nalu has separate specialist prompts and optional model overrides. Training an
adapter creates a candidate; it does not establish expert-level ability or that
the fleet beats a frontier generalist. Existing dataset sizes and checkpoint IDs
are not model-quality evidence. The current routing code can use a shared model
unless `NALU_USE_SPECIALIST_LORAS=1` enables domain adapters.

Read [the training workflow](README.md) for required consent, provenance,
independent grading, train/validation separation, budgets, and promotion gates.

The maintained workflow is:

1. Generate or collect draft examples. Preserve the teacher/source/version.
2. Independently check correctness, sensitive content, rights/consent and task
   outcomes. For tool trajectories, use runner events or fresh sandbox replay,
   not the teacher's returned `tool_output` strings or its `verified` boolean.
3. Create hash-bound review records and split task families into training,
   validation, and held-out test tasks. Audit with `dataset-policy.mjs`.
4. Train with `train_nalu_sft.py`; retain manifests, validation losses and sampler
   receipts. Never mix terminal tool-call training with web answer training.
5. Compare each candidate with the configured lane incumbent on independently
   reviewed domain tasks and regressions. The flywheel fails closed when its
   required lane-specific battery is absent or contaminated.
6. Publish only through the guarded release path, then verify actual serving
   identity, routing and account behavior on the deployed application.

`verify_fleet.mjs` is a sampled live check. It requires explicit expected on-topic
and off-topic kinds and checks both responses. Independent reference answers and
rubrics are required for the optional answer judge; it grades full responses and
appropriate uncertainty. Missing evidence or wrong routing fails the check.
Two judged answers per domain are not a statistical quality benchmark.

The previously described fleet-versus-frontier benchmark has not been established
by a checked artifact. A defensible comparison needs disjoint representative
tasks, repeated independent generations, blind grading, actual serving model and
prompt/version bindings, cost/latency, per-domain outcomes and uncertainty. Do not
call a candidate better based on correlated checks or replaying one artifact.
