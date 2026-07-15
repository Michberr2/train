# CI workflows (staged)

GitHub blocks pushing files under `.github/workflows/` unless the pushing token
carries the `workflow` OAuth scope. To keep this branch pushable from any token,
the studio smoke-test workflow lives here instead. It is **inert** at this path —
GitHub only runs workflows found under `.github/workflows/`.

## Activate it (one-time, needs a token with `workflow` scope)

```bash
gh auth refresh -h github.com -s workflow      # grant the scope (opens a browser)
mkdir -p .github/workflows
git mv ci/studio.yml .github/workflows/studio.yml
git commit -m "Enable studio CI workflow"
git push
```

## The AutoPilot scheduler moved off GitHub Actions

The old `.github/workflows/autopilot-cron.yml` (a 15-minute `curl` ping) is gone —
its job is now done by the **Vercel cron** in `vercel.json`
(`/api/cron`, `*/15 * * * *`), which needs no GitHub scope and runs on the same
infrastructure as the app. Nothing to re-enable.
