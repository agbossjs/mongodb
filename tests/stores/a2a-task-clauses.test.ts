import {
  A2ATaskSaveStatus,
  A2ATaskState,
  InvalidA2APageTokenError,
  type NewA2ATask,
} from "@agboss/core/stores";
import { StoredNamesUnreadableError } from "@agboss/core/stores";
import { ClientSession, Collection, FindCursor } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collections, MongoA2ATaskRepository } from "../../src/index.js";
import {
  messageDocumentOf,
  taskDocumentOf,
} from "../../src/stores/a2a-tasks/a2a-task-documents.js";
import { sweptOrphanMessagesBefore } from "../../src/stores/a2a-tasks/a2a-task-sweep.js";
import { testDatabase } from "../support/database.js";
import { connectionTo } from "../support/stores.js";

/**
 * agbossjs/mongodb#105: the A2A task store's clauses past the contract and the races — what a save hands back, the
 * transaction every read and write of a save runs in, the accept that is read again after a duplicate key (three
 * times at most), the rows a status and a reply are read back from, the page's filters and order, the bound of a
 * sweep's batch, and the store's descriptor and ping.
 */
const database = testDatabase();

const NINE = new Date("2026-01-05T09:00:00.000Z");
const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);
const HASH = `sha256:${"cd".repeat(32)}`;

const connection = () => connectionTo(database.url());
const tasksOn = () => new MongoA2ATaskRepository(connection());
const collection = (name: string) => connection().db.collection(name);

const newTask = (taskId: string, extra: Partial<NewA2ATask> = {}): NewA2ATask => ({
  endpoint: "orders",
  tenantId: "acme",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "charge-workflow-start",
  status: { state: A2ATaskState.Submitted, pendingPauses: [] },
  acceptedAt: NINE,
  messageId: `m-${taskId}`,
  requestHash: "h-1",
  ...extra,
});

/** The name of the collection a spied method ran on. */
const collectionOf = (context: unknown): string | undefined =>
  context instanceof Collection ? context.collectionName : undefined;

const keyOf = (taskId: string) => ({ tenantId: "acme", taskId });
const messageKeyOf = (taskId: string) => ({
  endpoint: "orders",
  tenantId: "acme",
  ownerId: "alice",
  messageId: `m-${taskId}`,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agbossjs/mongodb#105: a save hands back what it saved", () => {
  it("the task has the caller's peer and body hash only when it had them", async () => {
    const tasks = tasksOn();

    const plain = await tasks.saveIfAbsent(newTask("plain"));
    const trusted = await tasks.saveIfAbsent(
      newTask("trusted", { callerPeer: "orders-application", meshBodyHash: HASH }),
    );

    expect(plain).not.toHaveProperty("task.callerPeer");
    expect(plain).not.toHaveProperty("task.meshBodyHash");
    expect(trusted).toMatchObject({
      status: A2ATaskSaveStatus.Saved,
      task: { callerPeer: "orders-application", meshBodyHash: HASH },
    });
    expect(await tasks.findById(keyOf("plain"))).not.toHaveProperty("callerPeer");
    expect(await tasks.findById(keyOf("plain"))).not.toHaveProperty("meshBodyHash");
    expect(await tasks.findById(keyOf("trusted"))).toMatchObject({
      callerPeer: "orders-application",
    });
  });

  it("the document of a task without them has neither field", () => {
    const record = {
      ...newTask("doc"),
      status: newTask("doc").status,
      version: 1,
      statusAt: NINE,
    };

    const bare = taskDocumentOf(record);
    const trusted = taskDocumentOf({ ...record, callerPeer: "peer", meshBodyHash: HASH });

    expect(bare).not.toHaveProperty("callerPeer");
    expect(bare).not.toHaveProperty("meshBodyHash");
    expect(trusted).toMatchObject({ callerPeer: "peer", meshBodyHash: HASH });
    expect(
      messageDocumentOf({ ...messageKeyOf("doc"), requestHash: "h", taskId: "doc", savedAt: NINE }),
    ).not.toHaveProperty("reply");
  });

  it("a message resent finds its own task, a new message beside a saved one is saved", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("t-1"));

    const second = await tasks.saveIfAbsent(newTask("t-2"));
    const resent = await tasks.saveIfAbsent(newTask("t-3", { messageId: "m-t-2" }));

    expect(second.status).toBe(A2ATaskSaveStatus.Saved);
    expect(resent).toMatchObject({
      status: A2ATaskSaveStatus.MessageTaken,
      task: { taskId: "t-2" },
      message: { taskId: "t-2" },
    });
    expect((await tasks.saveIfAbsent(newTask("t-1", { messageId: "m-other" }))).status).toBe(
      A2ATaskSaveStatus.TaskIdTaken,
    );
  });
});

describe("agbossjs/mongodb#105: a save runs in one transaction", () => {
  it("every read and write of an accept carries the transaction's session", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("warm"));
    const spies = (["findOne", "countDocuments", "insertOne"] as const).map((method) =>
      vi.spyOn(Collection.prototype, method),
    );

    await tasks.saveIfAbsent(newTask("fresh"));
    await tasks.saveIfAbsent(newTask("again", { messageId: "m-fresh" }));

    const sessions = spies.flatMap((spy) =>
      spy.mock.calls.flatMap((call, index) =>
        collectionOf(spy.mock.contexts[index])?.startsWith("agboss_a2a")
          ? [(call.at(-1) as { session?: unknown } | undefined)?.session]
          : [],
      ),
    );
    // a fresh accept: read the message, count the task id, insert both (4); a resend: read the message and its task (2)
    expect(sessions).toHaveLength(4 + 2);
    for (const session of sessions) expect(session).toBeInstanceOf(ClientSession);
  });
});

describe("agbossjs/mongodb#105: an accept that lost an insert race to a commit is read again", () => {
  const duplicate = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

  it("a duplicate key once: the accept is read again and answers", async () => {
    const connected = connection();
    const tasks = new MongoA2ATaskRepository(connected);
    const run = vi.spyOn(connected, "inTransaction");
    run.mockRejectedValueOnce(duplicate);

    const saved = await tasks.saveIfAbsent(newTask("retried"));

    expect(saved.status).toBe(A2ATaskSaveStatus.Saved);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a duplicate key every time: the third attempt's error is thrown, never a fourth attempt", async () => {
    const connected = connection();
    const tasks = new MongoA2ATaskRepository(connected);
    const run = vi.spyOn(connected, "inTransaction").mockRejectedValue(duplicate);

    await expect(tasks.saveIfAbsent(newTask("never"))).rejects.toBe(duplicate);

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("any other error is thrown at once", async () => {
    const connected = connection();
    const tasks = new MongoA2ATaskRepository(connected);
    const broken = new Error("the transaction broke");
    const run = vi.spyOn(connected, "inTransaction").mockRejectedValue(broken);

    await expect(tasks.saveIfAbsent(newTask("broken"))).rejects.toBe(broken);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("agbossjs/mongodb#105: a reply and a stored task read back", () => {
  it("a reply of nothing is kept as JSON null, told apart from no reply", async () => {
    const tasks = tasksOn();
    const message = { ...messageKeyOf("r"), requestHash: "h", taskId: "r", savedAt: NINE };
    await tasks.saveMessageIfAbsent(message);

    expect(await tasks.findByMessage(message)).not.toHaveProperty("reply");
    expect(await tasks.saveReplyIfAbsent(message, undefined)).toBe(true);
    expect(await tasks.saveReplyIfAbsent(message, "second")).toBe(false);

    expect(await tasks.findByMessage(message)).toHaveProperty("reply", null);
  });

  it("a row whose state column and status disagree is refused, naming the task", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("split"));
    await collection(Collections.A2ATasks).updateOne(
      { taskId: "split" },
      { $set: { state: A2ATaskState.Working } },
    );

    await expect(tasks.findById(keyOf("split"))).rejects.toThrow(
      "agboss_a2a_tasks split: its state and its status disagree",
    );
  });

  it("a status and a reply that are no JSON are refused, naming what and which row", async () => {
    const tasks = tasksOn();
    await tasks.saveIfAbsent(newTask("damaged"));
    await collection(Collections.A2ATasks).updateOne(
      { taskId: "damaged" },
      { $set: { status: "{not json" } },
    );
    await collection(Collections.A2AMessages).updateOne(
      { messageId: "m-damaged" },
      { $set: { reply: "{not json" } },
    );

    const status = await tasks.findById(keyOf("damaged")).catch((error: unknown) => error);
    const reply = await tasks
      .findByMessage(messageKeyOf("damaged"))
      .catch((error: unknown) => error);

    expect(status).toBeInstanceOf(StoredNamesUnreadableError);
    expect(status).toHaveProperty("message", expect.stringContaining("a2a task status"));
    expect(status).toHaveProperty("message", expect.stringContaining("damaged"));
    expect(reply).toBeInstanceOf(StoredNamesUnreadableError);
    expect(reply).toHaveProperty("message", expect.stringContaining("a2a message reply"));
    expect(reply).toHaveProperty("message", expect.stringContaining("m-damaged"));
  });
});

describe("agbossjs/mongodb#105: the store's descriptor and its ping", () => {
  it("the store is a MongoDB one", () => {
    expect(MongoA2ATaskRepository.store).toEqual({ backend: "mongodb" });
  });

  it("ping is the connection's own ping", async () => {
    const connected = connection();
    const ping = vi.spyOn(connected, "ping").mockResolvedValue();

    await new MongoA2ATaskRepository(connected).ping();

    expect(ping).toHaveBeenCalledOnce();
  });
});

describe("agbossjs/mongodb#105: the page of list", () => {
  /** Three tasks of `acme`, accepted at 9:00 (b), 10:00 (a) and 9:00 (c): newest first, ties by task id descending. */
  async function threeTasks(tasks: MongoA2ATaskRepository): Promise<void> {
    await tasks.saveIfAbsent(newTask("t-b", { tenantId: "paged", contextId: "ctx-1" }));
    await tasks.saveIfAbsent(
      newTask("t-a", { tenantId: "paged", contextId: "ctx-2", acceptedAt: at(60) }),
    );
    await tasks.saveIfAbsent(newTask("t-c", { tenantId: "paged", contextId: "ctx-1" }));
    await tasks.compareAndSetStatus(
      { tenantId: "paged", taskId: "t-c" },
      1,
      { state: A2ATaskState.Working, pendingPauses: [] },
      NINE,
    );
  }
  const query = { endpoint: "orders", tenantId: "paged", ownerId: "alice" } as const;

  it("lists newest first, ties by task id descending, page after page", async () => {
    const tasks = tasksOn();
    await threeTasks(tasks);

    const first = await tasks.list({ ...query, pageSize: 2 });
    const second = await tasks.list({ ...query, pageSize: 2, pageToken: first.nextPageToken });

    expect(first.tasks.map((task) => task.taskId)).toEqual(["t-a", "t-c"]);
    expect(first.nextPageToken).not.toBe("");
    expect(second.tasks.map((task) => task.taskId)).toEqual(["t-b"]);
    expect(second.nextPageToken).toBe("");
    expect([first.totalSize, second.totalSize]).toEqual([3, 3]);
  });

  it("filters by context, by state and by status time, and counts what the filters match", async () => {
    const tasks = tasksOn();
    await threeTasks(tasks);

    const context = await tasks.list({ ...query, pageSize: 10, contextId: "ctx-1" });
    const state = await tasks.list({ ...query, pageSize: 10, state: A2ATaskState.Working });
    const recent = await tasks.list({ ...query, pageSize: 10, statusAtAfter: at(30) });

    expect(context.tasks.map((task) => task.taskId)).toEqual(["t-c", "t-b"]);
    expect(context.totalSize).toBe(2);
    expect(state.tasks.map((task) => task.taskId)).toEqual(["t-c"]);
    expect(state.totalSize).toBe(1);
    expect(recent.tasks.map((task) => task.taskId)).toEqual(["t-a"]);
  });

  it("the page asks for its order and its bound; an index is not assumed", async () => {
    const tasks = tasksOn();
    await threeTasks(tasks);
    const sort = vi.spyOn(FindCursor.prototype, "sort");
    const limit = vi.spyOn(FindCursor.prototype, "limit");

    await tasks.list({ ...query, pageSize: 2 });

    expect(sort).toHaveBeenCalledWith({ statusAt: -1, taskId: -1 });
    expect(limit).toHaveBeenCalledWith(3);
  });

  it.each([
    ["a kind no pause has", { pauseId: "p-1", kind: "bogus", ask: {} }],
    ["no kind", { pauseId: "p-1", ask: {} }],
    ["a pause id that is no text", { pauseId: 7, kind: "approval", ask: {} }],
  ])("a status with a pending pause of %s is refused", async (_name, pause) => {
    const tasks = tasksOn();
    const taskId = `t-pause-${String(_name.length)}`;
    await tasks.saveIfAbsent(newTask(taskId));
    await collection(Collections.A2ATasks).updateOne(
      { taskId },
      {
        $set: {
          state: A2ATaskState.InputRequired,
          status: JSON.stringify({ state: A2ATaskState.InputRequired, pendingPauses: [pause] }),
        },
      },
    );

    await expect(tasks.findById(keyOf(taskId))).rejects.toThrow();
  });

  it("a page of no tasks has no next token, however many tasks match; a token no list gave is refused", async () => {
    const tasks = tasksOn();
    await threeTasks(tasks);

    expect(await tasks.list({ ...query, pageSize: 0 })).toEqual({
      tasks: [],
      nextPageToken: "",
      totalSize: 3,
    });
    for (const token of ["!", Buffer.from("not json").toString("base64url")])
      await expect(tasks.list({ ...query, pageSize: 1, pageToken: token })).rejects.toBeInstanceOf(
        InvalidA2APageTokenError,
      );
  });
});

describe("agbossjs/mongodb#105: the orphan sweep reads in bounded batches, by _id", () => {
  it("every read is limited to the batch and ordered by _id", async () => {
    const connected = connection();
    const tasks = new MongoA2ATaskRepository(connected);
    await collection(Collections.A2AMessages).deleteMany({});
    for (let n = 1; n <= 5; n += 1)
      await tasks.saveMessageIfAbsent({
        endpoint: "orders",
        tenantId: "acme",
        ownerId: "alice",
        messageId: `m-${String(n)}`,
        requestHash: "h",
        taskId: "t-gone",
        savedAt: at(5),
      });
    const find = vi.spyOn(Collection.prototype, "find");

    const removed = await sweptOrphanMessagesBefore(connected.db, "orders", at(20), 2);

    expect(removed).toBe(5);
    const reads = find.mock.calls.filter(
      (_call, index) => collectionOf(find.mock.contexts[index]) === Collections.A2AMessages,
    );
    expect(reads).toHaveLength(4);
    for (const [, options] of reads) expect(options).toMatchObject({ limit: 2, sort: { _id: 1 } });
  });
});
