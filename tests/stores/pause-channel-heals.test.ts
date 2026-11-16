/**
 * agbossjs/agboss#1104 on MongoDB: an instance of the previous version that still runs after the
 * migration writes pauses with no `channel`, and no later migration would fix them. A channel-
 * filtered page gives such a pause its `channel` from its record before it reads, so it is on the
 * page whoever wrote it — the tenant's own pauses only, once, and a page with no channel filter
 * touches nothing.
 */
import { PauseStatus } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Collections, MongoPausedExecutionRepository } from "../../src/index.js";
import { pageOf, tenantFilter } from "../../src/stores/paused/pause-scans.js";
import { emptyAll, testDatabase } from "../support/database.js";
import { pauseOf } from "../support/pauses.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();
const PENDING = { statuses: [PauseStatus.Pending], channel: "refund-approval-channel" };

beforeEach(() => emptyAll(database.url()));

/** A store on a connection of its own. */
const storeOn = () =>
  new MongoPausedExecutionRepository(connectionTo(database.url()), new VirtualClock());

/** The pause as an instance of the previous version wrote it: no `channel` field. */
async function writtenByOldInstance(
  store: MongoPausedExecutionRepository,
  pauseId: string,
  tenantId = "default",
): Promise<void> {
  await store.findOrCreateByStepKey({ ...pauseOf(pauseId), tenantId });
  await connectionTo(database.url())
    .db.collection(Collections.Pauses)
    .updateOne({ pauseId, tenantId }, { $unset: { channel: "" } });
}

const channelOf = async (pauseId: string, tenantId = "default"): Promise<unknown> =>
  (
    await connectionTo(database.url())
      .db.collection(Collections.Pauses)
      .findOne({ pauseId, tenantId }, { projection: { channel: 1 } })
  )?.channel;

describe("agbossjs/agboss#1104: a pause with no channel heals itself", () => {
  it("a channel-filtered page lists a pause an old instance wrote after the migration, and its channel is set", async () => {
    const store = storeOn();
    await store.findOrCreateByStepKey(pauseOf("new"));
    await writtenByOldInstance(store, "old");

    const page = await store.findPageByTenantId("default", PENDING, 10);

    expect(page.pauses.map((pause) => pause.pauseId)).toEqual(["new", "old"]);
    expect(await channelOf("old")).toBe("refund-approval-channel");
  });

  it("only the page's tenant is read; a page without a channel filter changes nothing", async () => {
    const store = storeOn();
    await writtenByOldInstance(store, "mine");
    await writtenByOldInstance(store, "theirs", "other-tenant");

    await store.findPageByTenantId("default", { statuses: [PauseStatus.Pending] }, 10);
    expect(await channelOf("mine")).toBeUndefined();

    await store.findPageByTenantId("default", PENDING, 10);
    expect(await channelOf("mine")).toBe("refund-approval-channel");
    expect(await channelOf("theirs", "other-tenant")).toBeUndefined();
  });

  it("a second page changes nothing more; two pages at once end the same", async () => {
    const store = storeOn();
    await writtenByOldInstance(store, "old");

    const pages = await Promise.all(
      [1, 2, 3].map(() => store.findPageByTenantId("default", PENDING, 10)),
    );

    expect(pages.map((page) => page.pauses.map((pause) => pause.pauseId))).toEqual([
      ["old"],
      ["old"],
      ["old"],
    ]);
    expect(await channelOf("old")).toBe("refund-approval-channel");
  });

  it("sabotage: a page that scans without giving the channel misses the old instance's pause", async () => {
    const store = storeOn();
    await writtenByOldInstance(store, "old");

    const scanned = await pageOf(
      connectionTo(database.url()).db,
      tenantFilter("default", PENDING),
      10,
      undefined,
    );

    expect(scanned.pauses).toEqual([]);
  });
});
