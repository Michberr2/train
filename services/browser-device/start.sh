#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -f browser-device/Dockerfile -t nalu-browser-device:local .
exec docker run --rm --init --name nalu-browser-device \
  --publish 127.0.0.1:8877:8877 --cpus 2 --memory 2g --pids-limit 512 --shm-size 256m \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt "seccomp=$(pwd)/browser-host/seccomp_profile.json" \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --tmpfs /home/pwuser:rw,nosuid,nodev,size=64m \
  --mount type=volume,source=nalu-browser-device-data,target=/data nalu-browser-device:local
