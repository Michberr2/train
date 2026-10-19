#!/usr/bin/env bash
# Same receipt/locking/error handling as the parallel runner, one lane at a time.
set -euo pipefail
cd "$(dirname "$0")"
CONC=1 exec node train_par.mjs --all
