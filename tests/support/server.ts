import { randomUUID } from "node:crypto";

/**
 * The real servers of the integration tests. `AGBOSS_MONGODB_TEST_URL` names a replica set (CI:
 * `mongo:7 --replSet rs0`, one node); `AGBOSS_MONGODB_STANDALONE_TEST_URL` a standalone `mongod`
 * (CI: a second `mongo:7`, no `--replSet`) — the start check must refuse it. Unset, the
 * integration tests are skipped locally (the global setup says so) and fail in CI.
 */
export const REPLICA_SET_URL = process.env.AGBOSS_MONGODB_TEST_URL ?? "";
export const STANDALONE_URL = process.env.AGBOSS_MONGODB_STANDALONE_TEST_URL ?? "";

/** The variables and how to get a server, as a skipped test's title and the setup's notice say. */
export const HOW_TO = `start a single-node replica set and export its URL, e.g.
  docker run -d --name agboss-mongodb -p 27017:27017 mongo:7 --replSet rs0 --bind_ip_all
  docker exec agboss-mongodb mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
  export AGBOSS_MONGODB_TEST_URL='mongodb://localhost:27017/?replicaSet=rs0'
and for the standalone refusal, a mongod without --replSet:
  docker run -d --name agboss-mongodb-standalone -p 27018:27017 mongo:7
  export AGBOSS_MONGODB_STANDALONE_TEST_URL='mongodb://localhost:27018/?directConnection=true'`;

/** A database of its own for one test file: `t_<uuid>`, dropped by the test after. */
export const freshDatabaseName = (): string => `t_${randomUUID().replaceAll("-", "")}`;
