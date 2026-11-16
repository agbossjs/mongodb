import { execFileSync } from "node:child_process";
import { createServer, Socket } from "node:net";
import { Clock } from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";

/**
 * A server of the stop tests' own (agbossjs/agboss#923): a container started for the test file,
 * capped (`--cpus 0.5`, a memory limit), paused with `docker pause` (the server stops answering, its
 * sockets stay open — a hung network, a frozen server) and removed after. Without Docker the
 * tests are skipped. Nothing else shares it, so pausing it disturbs no other test.
 */
const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export const HAS_DOCKER = ((): boolean => {
  try {
    docker("info");
    return true;
  } catch {
    return false;
  }
})();

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
export async function untilReady(probe: () => void, tries = 60): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      probe();
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
  pause(): void;
  unpause(): void;
  remove(): void;
}

export function serverOf(name: string, url: string): PausableServer {
  return {
    url,
    pause: () => {
      docker("pause", name);
    },
    unpause: () => {
      try {
        docker("unpause", name);
      } catch {
        // not paused
      }
    },
    remove: () => {
      try {
        docker("rm", "-f", name);
      } catch {
        // already gone
      }
    },
  };
}

/** A single-node replica set in its own container, ready. */
export async function startMongo(): Promise<PausableServer> {
  const name = `agboss-923-mongo-${String(process.pid)}`;
  const port = await freePort();
  const host = `127.0.0.1:${String(port)}`;
  const run = [
    ...["run", "-d", "--name", name, "--cpus", "0.5", "--memory", "640m"],
    ...["-p", `${host}:${String(port)}`, "mongo:7"],
    ...["mongod", "--replSet", "rs0", "--port", String(port), "--bind_ip_all"],
    ...[
      "--wiredTigerCacheSizeGB",
      "0.25",
      "--setParameter",
      "maxIndexBuildMemoryUsageMegabytes=50",
    ],
  ];
  const budget = process.env.AGBOSS_DOCKER_BUDGET_DIR; // a shared machine checks its room first
  if (budget === undefined) docker(...run);
  else {
    // no room yet on the shared machine: asks again for up to ten minutes
    for (let attempt = 0; ; attempt += 1) {
      try {
        execFileSync("lockf", [
          `${budget}/docker-budget.lock`,
          "sh",
          "-c",
          'sh "$0/docker-cpu-budget.sh" 0.5 640 && docker "$@"',
          budget,
          ...run,
        ]);
        break;
      } catch (error) {
        if (attempt >= 40) throw error;
        await sleep(15_000);
      }
    }
  }
  const shell = (script: string): string =>
    docker("exec", name, "mongosh", "--port", String(port), "--quiet", "--eval", script);
  await untilReady(() => shell("db.runCommand({ ping: 1 }).ok"));
  shell(`rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "${host}" }] })`);
  await untilReady(() => {
    if (shell("db.hello().isWritablePrimary") !== "true") throw new Error("no primary yet");
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
