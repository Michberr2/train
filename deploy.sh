#!/usr/bin/env bash
# Deploy train to Vercel prod and re-point n4lu.ai + n4lu.com (and www) at it.
set -e
cd "$(dirname "$0")"
OUT=$(npx -y vercel@latest --prod --yes 2>&1)
DEP=$(echo "$OUT" | grep -oE 'https://nalu-[a-z0-9]+-mberry-hillpointecs-projects.vercel.app' | head -1)
if [ -z "$DEP" ]; then
  echo "!! DEPLOY FAILED — Vercel output below:"
  echo "$OUT" | tail -20
  exit 1
fi
echo "deployed: $DEP"
for D in n4lu.ai www.n4lu.ai n4lu.com www.n4lu.com; do
  npx -y vercel@latest alias set "$DEP" "$D" | tail -1
done
echo "live: https://n4lu.ai  https://n4lu.com (+ www)"
