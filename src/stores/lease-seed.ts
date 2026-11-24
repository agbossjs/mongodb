import type { Document } from "mongodb";
import { STORED_TOKEN, DROP_OLD_NAMES } from "./lease-documents.js";
import { literal } from "./store-time.js";

/**
 * The seed document of a tree's lease (agbossjs/agboss#1117): what a mark written before the tree's
 * first `acquire` makes — token 0, released, empty holder, expired at the epoch, never held — so
 * that acquire is token 1 with no takeover. Stages of an update pipeline: they make a document where
 * there is none and change nothing of one that is there.
 */

/** The tree's tenant and root: the key of the lease document that carries its marks. */
export interface Tree {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}

/** A field of the seed: kept when the document has it, else the seed's value (an update pipeline's `$setOnInsert`). */
export const orSeed = (field: string, seed: unknown): Document => ({
  $ifNull: [`$${field}`, seed],
});

/**
 * The stage that makes a document of the tree where there is none — token 0, released, empty
 * holder, expired at the epoch — and changes nothing of one that is there (its token, holder,
 * flags stay; a 0.1.0 document's `leaseEpoch` is read as its token and renamed, as every write does).
 */
export function seedStages(tree: Tree): Document[] {
  return [
    {
      $set: {
        tenantId: orSeed("tenantId", literal(tree.tenantId)),
        rootExecutionId: orSeed("rootExecutionId", literal(tree.rootExecutionId)),
        holderInstanceId: orSeed("holderInstanceId", literal("")),
        token: { $ifNull: [STORED_TOKEN, 0] },
        expiresAt: orSeed("expiresAt", new Date(0)),
        released: orSeed("released", true),
        yielded: orSeed("yielded", false),
        superseded: orSeed("superseded", false),
        finished: orSeed("finished", false),
      },
    },
    DROP_OLD_NAMES,
  ];
}
