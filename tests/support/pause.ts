import { randomUUID } from "node:crypto";
import { createServer, Socket } from "node:net";
import { Clock } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import { outputOf } from "./process.js";

/**
 * A server of the stop tests' own (agbossjs/agboss#923): a container started for the test file,
 * capped (`--cpus 0.5`, or `AGBOSS_PAUSE_CPUS`; a memory limit), paused with `docker pause` (the server stops answering, its
 * sockets stay open — a hung network, a frozen server) and removed after. Without Docker the
 * tests are skipped. Nothing else shares it, so pausing it disturbs no other test.
 */
const docker = async (...args: string[]): Promise<string> =>
  (await outputOf("docker", args)).trim();

export const HAS_DOCKER = await docker("info").then(
  () => true,
  () => false,
);

/** A free TCP port of the host. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => {
        resolve(port);
      });
    });
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `probe` until it passes (a server booting), up to `tries` seconds. */
export async function untilReady(probe: () => Promise<unknown>, tries = 60): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await probe();
      return;
    } catch (error) {
      if (attempt >= tries) throw error;
      await sleep(1000);
    }
  }
}

/** The container a test file pauses. */
export interface PausableServer {
  readonly url: string;
  pause(): Promise<void>;
  unpause(): Promise<void>;
  remove(): Promise<void>;
}

export function serverOf(name: string, url: string): PausableServer {
  return {
    url,
    pause: async () => {
      await docker("pause", name);
    },
    unpause: async () => {
      // not paused: nothing to undo
      await docker("unpause", name).catch(() => undefined);
    },
    remove: async () => {
      // already gone: nothing to remove
      await docker("rm", "-f", name).catch(() => undefined);
    },
  };
}

/**
 * `docker run`, on a shared machine (`AGBOSS_DOCKER_BUDGET_DIR`) only when its Docker budget has
 * room, checked and started under the budget's lock; no room yet: asked again for ten minutes.
 */
async function startContainer(run: readonly string[], cpus: string): Promise<void> {
  const budget = process.env.AGBOSS_DOCKER_BUDGET_DIR;
  if (budget === undefined) {
    await docker(...run);
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await outputOf("lockf", [
        `${budget}/docker-budget.lock`,
        ...["sh", "-c", `sh "$0/docker-cpu-budget.sh" ${cpus} 640 && docker "$@"`, budget],
        ...run,
      ]);
      return;
    } catch (error) {
      if (attempt >= 40) throw error;
      await sleep(15_000);
    }
  }
}

/** A single-node replica set in its own container, ready. */
export async function startMongo(): Promise<PausableServer> {
  // unique: Stryker runs every test file in one process
  const name = `agboss-923-mongo-${randomUUID()}`;
  const port = await freePort();
  const host = `127.0.0.1:${String(port)}`;
  const cpus = process.env.AGBOSS_PAUSE_CPUS ?? "0.5";
  const run = [
    ...["run", "-d", "--name", name, "--cpus", cpus, "--memory", "640m"],
    ...["-p", `${host}:${String(port)}`, "mongo:7"],
    ...["mongod", "--replSet", "rs0", "--port", String(port), "--bind_ip_all"],
    // the cache sizes itself to the host, not the container: bounded, the member is not OOM-killed
    ...["--wiredTigerCacheSizeGB", "0.25"],
    ...["--setParameter", "maxIndexBuildMemoryUsageMegabytes=50"],
  ];
  await startContainer(run, cpus);
  const shell = (script: string): Promise<string> =>
    docker("exec", name, "mongosh", "--port", String(port), "--quiet", "--eval", script);
  await untilReady(() => shell("db.runCommand({ ping: 1 }).ok"));
  await shell(`rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "${host}" }] })`);
  await untilReady(async () => {
    if ((await shell("db.hello().isWritablePrimary")) !== "true") throw new Error("no primary yet");
  });
  return serverOf(name, `mongodb://${host}/?replicaSet=rs0`);
}

/** `"returned"` when `work` ended first, `"hung"` when `limit` ms passed (a race of events, not a duration). */
export async function endsWithin(
  work: Promise<unknown>,
  limit: number,
): Promise<"returned" | "hung"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => {
      resolve("hung");
    }, limit);
  });
  try {
    return await Promise.race([work.then(() => "returned" as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Unhandled rejections seen from now on (the late failure of an abandoned call must not be one). */
export function watchUnhandled(): { readonly seen: unknown[]; stop(): void } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

/** The system's time, as the application's clock is in production (the core's own is not exported). */
export class RealClock extends Clock {
  now(): Date {
    return new Date();
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/**
 * The sockets this process opens to `port` from now on (patching `net.Socket.prototype.connect`):
 * how many are still open, counted by the socket's `destroyed` — not by a client's own `isOpen`,
 * which is false while a client is closing, its socket still up (agbossjs/agboss#954).
 */
export function trackSockets(port: number): {
  open(): number;
  /** Open sockets that have heard from the server (a finished handshake, a pooled connection). */
  established(): number;
  stop(): void;
} {
  const sockets: Socket[] = [];
  const original: unknown = Reflect.get(Socket.prototype, "connect");
  if (typeof original !== "function") throw new Error("net.Socket has no connect");
  const patched = function (this: Socket, ...args: unknown[]): Socket {
    // a client passes the port itself or its options, alone or in an array
    const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const target =
      typeof first === "object" && first !== null ? (first as { port?: number }).port : first;
    if (target === port) sockets.push(this);
    Reflect.apply(original, this, args);
    return this;
  };
  Reflect.set(Socket.prototype, "connect", patched);
  return {
    open: () => sockets.filter((socket) => !socket.destroyed).length,
    established: () => sockets.filter((socket) => !socket.destroyed && socket.bytesRead > 0).length,
    stop: () => {
      Reflect.set(Socket.prototype, "connect", original);
    },
  };
}
