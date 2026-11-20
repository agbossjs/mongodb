/**
 * agbossjs/agboss#81: the version document of the schema says when the database was migrated (the
 * server's time) as well as to which version — an operator's look at an `agboss_schema` that was
 * migrated a year ago.
 */
import { describe, expect, it } from "vitest";
import { Collections } from "../../src/index.js";
import { SCHEMA_DOCUMENT_ID, SCHEMA_VERSION } from "../../src/connection/schema-version.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

const database = testDatabase();

describe("agbossjs/agboss#81: the version document", () => {
  it("holds the version and the time of the migration that made the database", async () => {
    const documents = await connectionTo(database.url())
      .db.collection<{ _id: string; version: number; migratedAt: Date }>(Collections.SchemaVersion)
      .find()
      .toArray();

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ _id: SCHEMA_DOCUMENT_ID, version: SCHEMA_VERSION });
    expect(documents[0]?.migratedAt).toBeInstanceOf(Date);
    expect(documents[0]?.migratedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
