import type { A2ATaskPage, A2ATaskQuery } from "@agboss/core";
import type { Collection, Filter } from "mongodb";
import {
  ownerColumnOf,
  pagePositionOf,
  pageTokenOf,
  taskOf,
  type A2ATaskDocument,
} from "./a2a-task-documents.js";

/**
 * `list` of `MongoA2ATaskRepository` (agbossjs/agboss#824): a caller's tasks newest status first
 * (ties by task id, descending, byte-wise — the simple collation), filtered by context, state and
 * status time, a page after the token's position, and how many the filters match before paging.
 */

/** The filters of `query`. */
function filterOf(query: A2ATaskQuery): Filter<A2ATaskDocument> {
  return {
    tenantId: query.tenantId,
    ownerId: ownerColumnOf(query.ownerId),
    ...(query.contextId === undefined ? {} : { contextId: query.contextId }),
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.statusAtAfter === undefined ? {} : { statusAt: { $gt: query.statusAtAfter } }),
  };
}

/** The page `query` asks for; `InvalidA2APageTokenError` for a token no list gave. */
export async function pageOf(
  tasks: Collection<A2ATaskDocument>,
  query: A2ATaskQuery,
): Promise<A2ATaskPage> {
  const token = query.pageToken ?? "";
  const position = token === "" ? undefined : pagePositionOf(token);
  const matching = filterOf(query);
  const after: Filter<A2ATaskDocument> =
    position === undefined
      ? matching
      : {
          $and: [
            matching,
            {
              $or: [
                { statusAt: { $lt: position.statusAt } },
                { statusAt: position.statusAt, taskId: { $lt: position.taskId } },
              ],
            },
          ],
        };
  const found = await tasks
    .find(after)
    .sort({ statusAt: -1, taskId: -1 })
    .limit(query.pageSize + 1)
    .toArray();
  const totalSize = await tasks.countDocuments(matching);
  const page = found.slice(0, query.pageSize).map(taskOf);
  const last = page.at(-1);
  return {
    tasks: page,
    nextPageToken: found.length > query.pageSize && last !== undefined ? pageTokenOf(last) : "",
    totalSize,
  };
}
