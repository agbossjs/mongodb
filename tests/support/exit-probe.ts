import { fork, type ChildProcess } from "node:child_process";
import { endsWithin } from "./pause.js";

/** One child process of an exit probe, and what it has told (agbossjs/agboss#1027). */
export class ExitProbe {
  readonly #told: string[] = [];
  readonly #exited: Promise<void>;

  private constructor(readonly child: ChildProcess) {
    child.on("message", (message: { type: string }) => {
      this.#told.push(message.type);
    });
    this.#exited = new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
  }

  /** Starts `exit-probe-child.ts` on `url` with a liveness bound of `livenessSeconds`. */
  static start(url: string, livenessSeconds: number): ExitProbe {
    const child = fork(
      new URL("./exit-probe-child.ts", import.meta.url).pathname,
      [url, String(livenessSeconds)],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] },
    );
    return new ExitProbe(child);
  }

  /** Resolves when the child has told `type` `times` times (rejects with the test's own timeout). */
  async told(type: string, times = 1): Promise<void> {
    while (this.#told.filter((told) => told === type).length < times)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Asks the child to close; `"returned"` when the process exited within `limitMs`, else `"hung"`. */
  async closeAndExit(limitMs: number): Promise<"returned" | "hung"> {
    this.child.send({ type: "close" });
    return endsWithin(this.#exited, limitMs);
  }

  /** Ends the child whatever it does (a probe that hung). */
  kill(): void {
    this.child.kill("SIGKILL");
  }
}
