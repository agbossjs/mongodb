/**
 * agbossjs/agboss#1321f on MongoDB: `MongoDriver` and the settings it resolves — the URL a
 * `secret(…)` (revealed once, never printed), the durations in `Milliseconds`, an option this
 * driver has no meaning for refused (never silently ignored).
 */
import { SchemaSetup, StorageRole } from "@agboss/core/stores";
import { ms, sec } from "@agboss/core/units";
import { describe, expect, it } from "vitest";
import { MongoSettingsError } from "../../src/errors.js";
import { MongoTransactionReadConcern } from "../../src/connection/concerns.js";
import { settingsOfResolved, timeoutSettingsOf } from "../../src/connection/driver-settings.js";
import { MongoDriver } from "../../src/index.js";
import { revealing } from "../support/application-context.js";

const resolved = (extra: Record<string, unknown> = {}) => ({
  kind: "mongodb",
  url: revealing("mongodb://h1,h2/agboss?replicaSet=rs0"),
  ...extra,
});

describe("settingsOfResolved", () => {
  it("reveals the URL and takes only what the driver was given", () => {
    expect(settingsOfResolved(resolved())).toEqual({
      url: "mongodb://h1,h2/agboss?replicaSet=rs0",
    });
  });

  it("the database, the read concern and the schema setup are kept; the liveness in seconds", () => {
    expect(
      settingsOfResolved(
        resolved({
          database: "orders",
          transactionReadConcern: MongoTransactionReadConcern.Majority,
          schemaSetup: SchemaSetup.MigrateOnStart,
          watchLiveness: sec(20),
        }),
      ),
    ).toEqual({
      url: "mongodb://h1,h2/agboss?replicaSet=rs0",
      database: "orders",
      transactionReadConcern: MongoTransactionReadConcern.Majority,
      schemaSetup: SchemaSetup.MigrateOnStart,
      watchLivenessSeconds: 20,
    });
  });

  it.each([
    ["another driver's settings", { kind: "postgres" }],
    ["a URL that is no secret", { url: "mongodb://plain" }],
    ["an empty database name", { database: "" }],
    ["a schema setup this package does not know", { schemaSetup: "eventually" }],
  ])("%s is a MongoSettingsError", (_what, extra) => {
    expect(() => settingsOfResolved({ ...resolved(), ...extra })).toThrow(MongoSettingsError);
  });

  it("an empty URL is refused, without printing it", () => {
    expect(() => settingsOfResolved({ ...resolved(), url: revealing("") })).toThrow(
      /the driver's url is empty/,
    );
  });

  it.each(["commandTimeout", "idleInTransactionTimeout"])(
    "%s is PostgreSQL's: refused, never silently ignored",
    (option) => {
      expect(() => settingsOfResolved(resolved({ [option]: ms(500) }))).toThrow(MongoSettingsError);
    },
  );
});

describe("timeoutSettingsOf", () => {
  it("keeps the options given and nothing else", () => {
    expect(timeoutSettingsOf(undefined)).toEqual({});
    expect(timeoutSettingsOf({ watchLiveness: sec(5) })).toEqual({ watchLiveness: 5000 });
  });
});

describe("MongoDriver", () => {
  it("is the database role on the mongodb backend, with the lease store and the coordination stores named", () => {
    const driver = MongoDriver({
      url: revealing("mongodb://h1/agboss") as never,
      database: "orders",
    });

    expect(driver).toMatchObject({
      role: StorageRole.Database,
      backend: "mongodb",
      describes: "mongodb (database orders)",
      settings: { kind: "mongodb", database: "orders" },
    });
    expect(driver.coordinationStores).toHaveLength(3);
    expect(driver.leaseStore?.name).toBe("MongoExecutionLeaseRepository");
    expect(driver.migrate).toBeTypeOf("function");
  });
});
