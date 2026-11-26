/**
 * agbossjs/agboss#1307: the pure parts of the pause store's listings and writes — the filter of a
 * page (`channel`, `assignee`, `externalRef`, cross-tenant), the filter of a deadline change, and what
 * a change writes beside the record (the listing fields set, or unset when the pause has none).
 */
import { PauseStatus, type PauseRecord } from "@agboss/core";
import { describe, expect, it } from "vitest";
import { changeableAt } from "../../src/stores/paused/pause-guards.js";
import { listingFieldsOf, writtenFieldsOf } from "../../src/stores/paused/pause-documents.js";
import {
  assertPauseFilter,
  listingFilter,
  tenantFilter,
} from "../../src/stores/paused/pause-scans.js";
import { pauseOf } from "../support/pauses.js";

const AT = new Date("2026-01-05T10:00:00.000Z");
const PENDING = [PauseStatus.Pending];

describe("a page's filter", () => {
  it("names only what the filter names; the tenant's page adds its tenant, the cross-tenant one none", () => {
    expect(listingFilter({ statuses: PENDING })).toStrictEqual({ status: { $in: PENDING } });
    expect(tenantFilter("acme", { statuses: PENDING })).toStrictEqual({
      tenantId: "acme",
      status: { $in: PENDING },
    });
  });

  it("the channel, the assignee (an element of the stored pool) and the reference (with $exists, for its partial index)", () => {
    expect(
      listingFilter({
        statuses: PENDING,
        target: "t",
        expiresBefore: AT,
        channel: "jira",
        assignee: "bob",
        externalRef: "JIRA-1",
      }),
    ).toStrictEqual({
      status: { $in: PENDING },
      target: "t",
      expiresAt: { $lt: AT },
      channel: "jira",
      assignees: "bob",
      externalRef: { $eq: "JIRA-1", $exists: true },
    });
  });

  it("no status is a TypeError, and a text that is no text (an operator document) is refused, never run", () => {
    expect(() => {
      assertPauseFilter({ statuses: [] });
    }).toThrow(TypeError);
    for (const field of ["target", "channel", "assignee", "externalRef"])
      expect(() => {
        assertPauseFilter({ statuses: PENDING, [field]: { $ne: "x" } });
      }).toThrow(new TypeError(`a pause filter's ${field} is a text`));
    expect(() => {
      assertPauseFilter({ statuses: PENDING, assignee: "bob" });
    }).not.toThrow();
  });
});

describe("the filter of a deadline change", () => {
  it("over none: the stored deadline is missing or null; over one read: still that date and after `at`", () => {
    expect(changeableAt(AT, undefined)).toStrictEqual({
      status: PauseStatus.Pending,
      expiresAt: null,
    });
    const read = new Date("2026-01-05T11:00:00.000Z");
    expect(changeableAt(AT, read)).toStrictEqual({
      status: PauseStatus.Pending,
      $and: [{ expiresAt: { $eq: read } }, { expiresAt: { $gt: AT } }],
    });
  });
});

describe("what a change writes beside the record", () => {
  const held = { ...pauseOf("p"), assignees: ["ann"], externalRef: "JIRA-1" };
  const without = (pause: PauseRecord, key: string): PauseRecord =>
    Object.fromEntries(Object.entries(pause).filter(([name]) => name !== key)) as PauseRecord;

  it("a pause's listing fields are those it has, the pool copied", () => {
    expect(listingFieldsOf(held)).toStrictEqual({
      assignees: ["ann"],
      externalRef: "JIRA-1",
      channel: "refund-approval-channel",
    });
    expect(listingFieldsOf({ ...held, channel: undefined })).not.toHaveProperty("channel");
  });

  it("a change that leaves the trail, the pool and the reference as they were writes the status fields only", () => {
    const written = writtenFieldsOf(held, { ...held, isSent: true });

    expect(written).not.toHaveProperty("$unset");
    expect(written.$set).not.toHaveProperty("record");
    expect(written.$set).not.toHaveProperty("assignees");
  });

  it("a changed pool is set with the record; a released one, and a missing reference, are unset — never null", () => {
    const moved = writtenFieldsOf(held, {
      ...held,
      assignees: ["bob", "cy"],
      trail: [...held.trail],
    });
    expect(moved.$set).toMatchObject({ assignees: ["bob", "cy"], externalRef: "JIRA-1" });
    expect(moved).not.toHaveProperty("$unset");

    const released = writtenFieldsOf(held, {
      ...without(held, "assignees"),
      trail: [...held.trail],
    });
    expect(released.$unset).toStrictEqual({ assignees: "" });
    expect(released.$set).not.toHaveProperty("assignees");

    const unreferenced = writtenFieldsOf(held, {
      ...without(held, "externalRef"),
      trail: [...held.trail],
    });
    expect(unreferenced.$unset).toStrictEqual({ externalRef: "" });
  });
});
