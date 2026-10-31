/**
 * `@agboss/mongodb` (agbossjs/agboss#527): AGBoss's stores on a MongoDB replica set — scaffold.
 * The connection is here: one `MongoClient` per application instance, `w=majority` on the journal,
 * majority reads from the primary, snapshot transactions, a standalone `mongod` refused. The
 * stores follow the core's store conformance (agbossjs/agboss#526) and fault suite (#484).
 */
export { MongoConnection } from "./connection/mongodb-connection.js";
export { DEFAULT_DATABASE, type MongoConnectionSettings } from "./connection/settings.js";
export { TransactionReadConcern } from "./connection/concerns.js";
export { MongoTopology } from "./connection/deployment.js";
export {
  MongoConcernTooWeakError,
  MongoReplicaSetRequiredError,
  MongoSettingsError,
} from "./errors.js";
