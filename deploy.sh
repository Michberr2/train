#!/usr/bin/env bash
# Production publication verifies tests, source, deployment ID and all domains.
# Domain assignment failures cannot be hidden by a successful trailing command.
set -euo pipefail
cd -- "$(dirname -- "$0")"
exec node scripts/deploy-release.mjs "$@"
