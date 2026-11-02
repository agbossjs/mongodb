import { describe, expect, it } from "vitest";
import { MongoConcernTooWeakError, TransactionReadConcern } from "../../src/index.js";
import {
  concernProblemsOf,
  enforcementProblemsOf,
  ENFORCED_CLIENT_OPTIONS,
  requireConcerns,
  transactionOptionsOf,
  type ClientConcerns,
} from "../../src/connection/concerns.js";

/** Fakes of a client's resolved concerns, as the driver exposes them. */
const DURABLE: ClientConcerns = {
  writeConcern: { w: "majority", journal: true },
  readConcern: { level: "majority" },
  readPreference: { mode: "primary" },
};

describe("concernProblemsOf: what the URL asks for", () => {
  it("nothing set is fine: the connection sets the concerns itself", () => {
    expect(concernProblemsOf({})).toEqual([]);
    expect(concernProblemsOf({ writeConcern: {}, readConcern: {}, readPreference: {} })).toEqual(
      [],
    );
  });

  it("majority, journal, majority reads from the primary are fine", () => {
    expect(concernProblemsOf(DURABLE)).toEqual([]);
  });

  it.each(["snapshot", "linearizable", "majority"])("read concern %s is durable", (level) => {
    expect(concernProblemsOf({ readConcern: { level } })).toEqual([]);
  });

  it.each([0, 1, 2, "custom-tag"])(
    "write concern w=%s fails: only majority survives failover",
    (w) => {
      const [problem, ...rest] = concernProblemsOf({ writeConcern: { w } });

      expect(rest).toEqual([]);
      expect(problem).toMatch(
        new RegExp(`^write concern w=${String(w)}: .*rolled back on failover`),
      );
    },
  );

  it("journal=false fails: an unjournaled write is lost on a crash", () => {
    expect(concernProblemsOf({ writeConcern: { journal: false } })).toEqual([
      expect.stringMatching(/^journal=false: .*lost on a crash/),
    ]);
  });

  it("journal=true, or journal left out, is fine", () => {
    expect(concernProblemsOf({ writeConcern: { journal: true } })).toEqual([]);
    expect(concernProblemsOf({ writeConcern: { w: "majority" } })).toEqual([]);
  });

  it.each(["local", "available"])(
    "read concern %s fails: it can see a rolled-back write",
    (level) => {
      expect(concernProblemsOf({ readConcern: { level } })).toEqual([
        expect.stringMatching(new RegExp(`^read concern ${level}: .*failover rolls back`)),
      ]);
    },
  );

  it.each(["primaryPreferred", "secondary", "secondaryPreferred", "nearest"])(
    "read preference %s fails: a secondary can be stale",
    (mode) => {
      expect(concernProblemsOf({ readPreference: { mode } })).toEqual([
        expect.stringMatching(new RegExp(`^read preference ${mode}: .*stale`)),
      ]);
    },
  );

  it("every weak setting is listed, in order", () => {
    const problems = concernProblemsOf({
      writeConcern: { w: 1, journal: false },
      readConcern: { level: "local" },
      readPreference: { mode: "secondary" },
    });

    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "write concern w=1",
      "journal=false",
      "read concern local",
      "read preference secondary",
    ]);
  });
});

describe("enforcementProblemsOf: what the built client carries", () => {
  it("a client with the enforced options has no problem", () => {
    expect(enforcementProblemsOf(DURABLE)).toEqual([]);
  });

  it("a client without concerns lacks all three", () => {
    expect(enforcementProblemsOf({})).toEqual([
      "the client's write concern is not w=majority",
      "the client's write concern does not wait for the journal",
      "the client's read concern is not majority",
    ]);
  });

  it("a snapshot client-level read concern is not the enforced one", () => {
    expect(enforcementProblemsOf({ ...DURABLE, readConcern: { level: "snapshot" } })).toEqual([
      "the client's read concern is not majority",
    ]);
  });

  it("the enforced options are w=majority on the journal, majority reads from the primary, retried writes", () => {
    expect(ENFORCED_CLIENT_OPTIONS).toEqual({
      writeConcern: { w: "majority", journal: true },
      readConcern: { level: "majority" },
      readPreference: "primary",
      retryWrites: true,
      retryReads: true,
    });
  });
});

describe("requireConcerns", () => {
  it("no problem: nothing thrown", () => {
    expect(() => {
      requireConcerns([]);
    }).not.toThrow();
  });

  it("problems: MongoConcernTooWeakError naming each, with its stable code", () => {
    let thrown: unknown;
    try {
      requireConcerns(["first", "second"]);
    } catch (error) {
      thrown = error;
    }

    if (!(thrown instanceof MongoConcernTooWeakError)) throw new Error("expected the named error");
    const error = thrown;
    expect(error.problems).toEqual(["first", "second"]);
    expect(error.message).toMatch(/too weak for the stores' guarantees — first; second$/);
    expect(error.code).toBe("mongodb.concern-too-weak");
    expect(error.name).toBe("MongoConcernTooWeakError");
  });
});

describe("transactionOptionsOf", () => {
  it.each([TransactionReadConcern.Snapshot, TransactionReadConcern.Majority])(
    "reads at %s, commits with w=majority on the journal, on the primary",
    (level) => {
      expect(transactionOptionsOf(level)).toEqual({
        readConcern: { level },
        writeConcern: { w: "majority", journal: true },
        readPreference: "primary",
      });
    },
  );
});

describe("retryWrites: a write whose reply was lost is retried exactly once", () => {
  it("retryWrites=false fails: its outcome would be unknown", () => {
    expect(concernProblemsOf({ options: { retryWrites: false } })).toEqual([
      expect.stringMatching(/^retryWrites=false: .*not retried exactly once/),
    ]);
  });

  it("retryWrites on, or left out, is fine; the connection sets it", () => {
    expect(concernProblemsOf({ options: { retryWrites: true } })).toEqual([]);
    expect(concernProblemsOf({ options: {} })).toEqual([]);
    expect(ENFORCED_CLIENT_OPTIONS.retryWrites).toBe(true);
  });
});
