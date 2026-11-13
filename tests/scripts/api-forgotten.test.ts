/**
 * agbossjs/agboss#895 AC2 — `scripts/api-report.mjs` fails on a public signature that names a type
 * the entry does not export (`ae-forgotten-export`), and the committed report holds none (AC1).
 * Run on a declaration-only package, so the real report stays as it is.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function fixture(entry: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agboss-forgotten-"));
  made.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@fixture/pkg", version: "1.0.0", type: "module" }),
  );
  writeFileSync(
    join(dir, "tsconfig.build.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", strict: true }, include: ["dist"] }),
  );
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist/index.d.ts"), entry);
  return dir;
}

const check = (dir: string) =>
  spawnSync("node", [join(repo, "scripts/api-report.mjs"), "--package", dir, "--write"], {
    cwd: repo,
    encoding: "utf8",
  });

describe("forgotten exports (#895)", () => {
  it("AC1: the committed report holds no ae-forgotten-export", () => {
    expect(readFileSync(join(repo, "api/mongodb.api.md"), "utf8")).not.toContain(
      "ae-forgotten-export",
    );
  });

  it("AC2: a signature naming a type the entry does not export fails the check", () => {
    const run = check(
      fixture(
        "interface Hidden { readonly a: string }\nexport declare function use(h: Hidden): void;\nexport {};\n",
      ),
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not export (#895): Hidden");
  }, 60_000);

  it("a type the entry exports passes", () => {
    const run = check(
      fixture(
        "export interface Shown { readonly a: string }\nexport declare function use(h: Shown): void;\n",
      ),
    );

    expect(run.status).toBe(0);
  }, 60_000);
});
