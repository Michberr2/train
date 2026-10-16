# Nalu cross-repository coordination

The user requires `nalumobile`, `naludesktop`, and `train` to stay synchronized.
They are separate platform implementations, not interchangeable copies.

- Before changes, inspect the affected sibling repositories and their uncommitted work. Preserve concurrent edits.
- `train/api` owns shared account, task, team, voice, and attachment behavior. For API changes, inspect both native clients and the browser/CLI callers, update affected consumers, and test compatibility.
- `naludesktop/cli` owns the CLI and installer. `train/client/public/nalu.mjs` and `install.sh` are published copies. Run the CLI tests, then `sh cli/publish.sh` from naludesktop after CLI changes. Do not independently develop the release copies.
- Mobile iOS files are generated and ignored by Git. Native changes must also live in Expo plugins so clean builds preserve them.
- Run `node scripts/check-nalu-sync.mjs` from any of the three repos before declaring cross-repo work complete. Optional `--watch` monitors local consistency without changing files. Missing sibling checkouts are incomplete verification, not a pass.
- The checker covers published CLI bytes, production API origins, shared route presence, and these coordination files. It does not prove feature parity or account-data behavior; run the relevant integration tests for the changed behavior too.
- After deployments, verify the actual public domains point at the intended release. After native changes, distinguish source, built artifacts, installed apps, and verified runtime behavior.
- Do not automatically commit/push unrelated work, force-push, reset branches, copy entire repos, or replicate credentials. Source consistency does not authorize destructive Git operations.
- Keep this file and `scripts/check-nalu-sync.mjs` identical across all three repos when updating the coordination workflow.

The user also explicitly authorized automatic GitHub synchronization. The installed `ai.n4lu.repo-sync` service syncs committed changes every 60 seconds on configured branches, using the Michberr2 account. It preserves uncommitted files, stops on divergence/branch changes, and never force-pushes. See nalumobile/docs/REPO_SYNC.md and the latest `~/Library/Application Support/Nalu/RepoSync/status.json`. This does not authorize automatically staging or committing unrelated files.
