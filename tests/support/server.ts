import { randomUUID } from "node:crypto";

/**
 * The real servers of the integration tests. `AGBOSS_MONGODB_TEST_URL` names a replica set (CI:
 * `mongo:7 --replSet rs0`, one node); `AGBOSS_MONGODB_STANDALONE_TEST_URL` a standalone `mongod`
 * (CI: a second `mongo:7`, no `--replSet`) — the start check must refuse it. Unset, the run
 * fails (the global setup says so).
 */
export const REPLICA_SET_URL = process.env.AGBOSS_MONGODB_TEST_URL ?? "";
export const STANDALONE_URL = process.env.AGBOSS_MONGODB_STANDALONE_TEST_URL ?? "";

/** The variables and how to get a server, as a skipped test's title and the setup's notice say. */
export const HOW_TO = `start a replica set of three members with --setParameter enableTestCommands=1
(README.md → Tests) and export its URL, e.g.
  export AGBOSS_MONGODB_TEST_URL='mongodb://localhost:57017,localhost:57018,localhost:57019/?replicaSet=rs0'
and for the standalone refusal, a mongod without --replSet:
  docker run -d --name agboss-mongodb-standalone -p 27018:27017 mongo:7
  export AGBOSS_MONGODB_STANDALONE_TEST_URL='mongodb://localhost:27018/?directConnection=true'`;

/** A database of its own for one test file: `t_<uuid>`, dropped by the test after. */
export const freshDatabaseName = (): string => `t_${randomUUID().replaceAll("-", "")}`;
