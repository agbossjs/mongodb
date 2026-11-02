#!/usr/bin/env bash
# CI (agbossjs/agboss#527): waits for the four mongod of the job, initiates the replica set rs0 of
# the three on 27017-27019 (27017 preferred as the primary) and waits for its primary.
set -euo pipefail

for port in 27017 27018 27019 27020; do
  for attempt in $(seq 1 60); do
    docker exec "mongo-27017" mongosh --quiet --port "$port" --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1 && break
    [ "$attempt" = 60 ] && { echo "mongod on $port does not answer after 60 s"; exit 1; }
    sleep 1
  done
done

docker exec mongo-27017 mongosh --quiet --port 27017 --eval 'rs.initiate({ _id: "rs0", members: [
  { _id: 0, host: "localhost:27017", priority: 2 },
  { _id: 1, host: "localhost:27018" },
  { _id: 2, host: "localhost:27019" } ] })'

for attempt in $(seq 1 90); do
  [ "$(docker exec mongo-27017 mongosh --quiet --port 27017 --eval 'db.hello().isWritablePrimary')" = "true" ] && exit 0
  sleep 1
done
echo "the replica set has no primary after 90 s"
exit 1
