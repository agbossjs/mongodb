/**
 * agbossjs/agboss#824 AC1: on MongoDB the A2A tasks are shared by the instances. Two application
 * instances — each its own `MongoClient`, its own container and memory, as two pods — serve A2A on
 * one replica set. One message (one `messageId`) sent to both at the same moment, a client's retry
 * landing on another pod, starts exactly one execution: both answers name one task, and either
 * instance reads the task the other may have accepted. On each instance's own in-memory task
 * store both would accept it and run it twice.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type App } from "@agboss/core";
import { a2aHttpListener } from "@agboss/core/a2a";
import { afterEach, describe, expect, it } from "vitest";
import { testDatabase } from "../support/database.js";
import { AliceCallerResolver, EchoA2AExpose, EchoApplication, started } from "./a2a.application.js";

const database = testDatabase();
const opened: { readonly app: App; readonly server: Server }[] = [];

afterEach(async () => {
  for (const { app, server } of opened.splice(0)) {
    server.close();
    await app.close();
  }
  started.length = 0;
});

/** An instance of the application on the test's database, serving A2A; resolves with its URL. */
async function instance(): Promise<string> {
  process.env.AGBOSS_A2A_TEST_MONGODB_URL = database.url();
  const app = await createApp(EchoApplication, { env: "instances" });
  const served: { listener?: ReturnType<typeof a2aHttpListener> } = {};
  const server = createServer((request, response) => served.listener?.(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  served.listener = a2aHttpListener(app, {
    expose: EchoA2AExpose,
    callerResolver: AliceCallerResolver,
    publicUrl: url,
  });
  opened.push({ app, server });
  return url;
}

async function rpc(url: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The message `messageId`, answered once its task is over (a blocking SendMessage). */
const echo = (messageId: string) => ({
  message: { messageId, role: "ROLE_USER", parts: [{ text: "once", mediaType: "text/plain" }] },
});

const taskOf = (result: unknown) =>
  (result as { task: { id: string; status: { state: string } } }).task;

describe("agbossjs/agboss#824 AC1: one A2A message on two instances", () => {
  it("the same messageId sent to two instances at once: one task, one execution", async () => {
    const [first, second] = await Promise.all([instance(), instance()]);

    const answers = await Promise.all([
      rpc(first, "SendMessage", echo("m-1")),
      rpc(second, "SendMessage", echo("m-1")),
    ]);

    const [id] = answers.map((answer) => taskOf(answer).id);
    expect(answers.map((answer) => taskOf(answer).id)).toEqual([id, id]);
    expect(started).toEqual([id]);
    for (const url of [first, second]) {
      const task = (await rpc(url, "GetTask", { id })) as { status: { state: string } };
      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    }
    // a resend later, to either instance, is the same task and starts nothing
    expect(taskOf(await rpc(second, "SendMessage", echo("m-1"))).id).toBe(id);
    expect(started).toEqual([id]);
    const listed = (await rpc(first, "ListTasks", {})) as { tasks: unknown[]; totalSize: number };
    expect([listed.tasks.length, listed.totalSize]).toEqual([1, 1]);
  }, 60_000);
});
