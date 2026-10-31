import { z } from "zod";
import { MongoReplicaSetRequiredError } from "../errors.js";

/** The kind of deployment a `hello` reply describes. */
export enum MongoTopology {
  /** A replica set member (`setName` in the reply): majority writes and transactions. */
  ReplicaSet = "replica-set",
  /** A `mongos` router (`msg: "isdbgrid"`): every shard is a replica set; transactions work. */
  Sharded = "sharded",
  /** A standalone `mongod`: no majority, no transactions — refused. */
  Standalone = "standalone",
}

/** The fields of a `hello` reply the check reads; the rest is ignored. */
const HelloReply = z.object({
  setName: z.string().optional(),
  msg: z.string().optional(),
});

/** The deployment `hello` (the server's reply to `{ hello: 1 }`) describes. */
export function topologyOf(hello: unknown): MongoTopology {
  const reply = HelloReply.safeParse(hello);
  if (!reply.success) return MongoTopology.Standalone;
  if (reply.data.setName !== undefined && reply.data.setName !== "")
    return MongoTopology.ReplicaSet;
  if (reply.data.msg === "isdbgrid") return MongoTopology.Sharded;
  return MongoTopology.Standalone;
}

/**
 * The deployment `hello` describes when the stores can run on it: a replica set or a sharded
 * cluster. A standalone `mongod` fails with `MongoReplicaSetRequiredError`.
 */
export function requireTransactionalDeployment(hello: unknown): MongoTopology {
  const topology = topologyOf(hello);
  if (topology === MongoTopology.Standalone) throw new MongoReplicaSetRequiredError();
  return topology;
}
