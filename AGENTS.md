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

## Approved Nalu design — always preserve

The user explicitly requires the new Nalu look for all future work and releases. This is the standing visual baseline, including when a task only changes AI or backend behavior.

- The approved web baseline is commit `df537af68f21a17cefb35627215a2cf306314d0c` on `release/workspace-ai-2026-10-18` in `Michberr2/train`. Integrate later fixes into this design; never replace it with an older checkout's UI. Fetch the release branch and inspect later commits before choosing a release source.
- Preserve the redesigned public landing/sign-in/create-account pages and the Nalu loading screen on every visit. The workspace redesign starts only after authentication.
- Preserve the carousel as the first authenticated screen, the approved white desktop frame and dock spacing, natural pastel scene backgrounds without the blue wash, desktop app icons, stacked circular dog agents, and pop-out/full-screen chat.
- Keep real Studio, Map, Memory, Autopilot and Swarm behavior, account isolation, saved work, and private/group chat context intact. Never substitute sample controllers or preview-only behavior for live functionality. Production must not display the local-preview banner or sample-work wording.
- All production updates must combine the current approved UI with the required AI/backend commits. Use the checked `deploy.sh` release workflow. If it refuses a stale source or concurrent deployment, reconcile the source and coordinate one publisher; do not bypass the refusal with a direct production deploy or alias command.
- Before declaring a release live, verify both `n4lu.com` and `n4lu.ai` (including www aliases) point at the intended combined release and inspect the relevant UI. Git history inclusion alone does not prove the approved design or functionality survived.
- This is the web visual baseline; native implementations remain platform-specific and preserve their existing behavior while staying compatible with the shared API.
