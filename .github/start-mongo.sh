#!/usr/bin/env bash
# CI (agbossjs/mongodb#92): starts the four mongod of a job — the replica set rs0 on 27017-27019 and
# a standalone on 27020 — the one way for every job of ci.yml and mutation-nightly.yml, so they
# cannot drift. Each container is capped (`--memory` and `--memory-swap` alike: a mongod that grows
# is killed by its cgroup at once, with its logs, never the runner's whole VM) and its mongod sized
# for the cap, as the local gate does (agbossjs/agboss#1260, #1236, #1345): the default cache sizes
# itself to the host's memory, not the container's, and the hundreds of short-lived databases of a
# run keep ~16k WiredTiger data handles open unless idle ones are closed.
# enableTestCommands (the members): the retry and failover tests force errors with the server's own
# fail points.
set -euo pipefail

CAP=1200m
SIZING=(
  --wiredTigerCacheSizeGB 0.25
  --setParameter maxIndexBuildMemoryUsageMegabytes=50
  --wiredTigerEngineConfigString "file_manager=(close_idle_time=15,close_scan_interval=5)"
)

for port in 27017 27018 27019; do
  docker run -d --name "mongo-$port" --network host --memory="$CAP" --memory-swap="$CAP" mongo:7 \
    mongod --replSet rs0 --port "$port" --bind_ip_all --setParameter enableTestCommands=1 "${SIZING[@]}"
done
docker run -d --name mongo-standalone --network host --memory="$CAP" --memory-swap="$CAP" mongo:7 \
  mongod --port 27020 --bind_ip_all "${SIZING[@]}"
