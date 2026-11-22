import { IdGenerator, ThreadIdsExhaustedError } from "@agboss/core";
import { VirtualClock } from "@agboss/core/testing";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { recordsOn } from "../support/stores.js";

/**
 * agbossjs/mongodb#105 (agbossjs/agboss#550, #613): a minted thread id the tenant already has is never handed out;
 * the next one is minted, at most 100 times, then `ThreadIdsExhaustedError` naming the generator.
 */
const database = testDatabase();

/** Repeats one thread id for ever, counting what it was asked. */
class StuckIdGenerator extends IdGenerator {
  asked = 0;
  newThreadId(): string {
    this.asked += 1;
    return "stuck-thread";
  }
  newExecutionId(): string {
    return "execution-1";
  }
}

/** Counts, and repeats the first id only `repeats` times before it mints fresh ones. */
class RepeatingIdGenerator extends IdGenerator {
  asked = 0;
  constructor(private readonly repeats: number) {
    super();
  }
  newThreadId(): string {
    this.asked += 1;
    return this.asked <= this.repeats ? "taken-thread" : `fresh-${String(this.asked)}`;
  }
  newExecutionId(): string {
    return "execution-1";
  }
}

/** Mints `shared` first (every instance's generator does), then ids of its own. */
class SharedFirstIdGenerator extends IdGenerator {
  #asked = 0;
  constructor(
    private readonly shared: string,
    private readonly own: string,
  ) {
    super();
  }
  newThreadId(): string {
    this.#asked += 1;
    return this.#asked === 1 ? this.shared : `${this.own}-${String(this.#asked)}`;
  }
  newExecutionId(): string {
    return "execution-1";
  }
}

describe("agbossjs/mongodb#105: a thread id minted twice", () => {
  it("one minted id on several instances at once is handed out once: the others mint another", async () => {
    for (let round = 0; round < 8; round += 1) {
      const shared = `shared-${String(round)}`;
      const stores = Array.from({ length: 4 }, (_, index) =>
        recordsOn(
          database.url(),
          new VirtualClock(),
          new SharedFirstIdGenerator(shared, `own-${String(round)}-${String(index)}`),
        ),
      );
      await Promise.all(stores.map((store) => store.ping()));
      let release: () => void = () => undefined;
      const go = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = stores.map(async (store) => {
        await go;
        return store.createThread({ workflow: "desk-workflow", tenantId: "default" });
      });
      release();

      const made = await Promise.all(running);

      expect(new Set(made).size).toBe(4);
      expect(made.filter((id) => id === shared)).toHaveLength(1);
    }
  });

  it("a taken minted id is skipped: the next one is handed out", async () => {
    const ids = new RepeatingIdGenerator(1);
    const records = recordsOn(database.url(), new VirtualClock(), ids);
    await records.createThread({
      workflow: "desk-workflow",
      tenantId: "default",
      threadId: "taken-thread",
    });

    const made = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });

    expect(made).toBe("fresh-2");
    expect(ids.asked).toBe(2);
  });

  it("a generator that only repeats a taken id is asked for exactly 100 ids, then refused by name", async () => {
    const ids = new StuckIdGenerator();
    const records = recordsOn(database.url(), new VirtualClock(), ids);
    await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
    ids.asked = 0;

    const refused = await records
      .createThread({ workflow: "desk-workflow", tenantId: "default" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ThreadIdsExhaustedError);
    expect(refused).toHaveProperty("message", expect.stringContaining("StuckIdGenerator"));
    expect(ids.asked).toBe(100);
  });
});
