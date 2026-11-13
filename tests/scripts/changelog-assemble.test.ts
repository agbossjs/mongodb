/**
 * agbossjs/agboss#981: changelog fragments (scripts/changelog-assemble.mjs, vendored from the core). AC2 — the assemble script produces the section hand-written entries
 * would (golden), is idempotent, and a fragment with an unknown section fails it. The repo's own
 * `changes/` always validates.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runNode = (args: readonly string[]) =>
  Promise.resolve(spawnSync(process.execPath, [...args], { encoding: "utf8" }));
const repo = new URL("../../", import.meta.url).pathname;
const script = join(repo, "scripts/changelog-assemble.mjs");
const config = readFileSync(join(repo, "changes/config.json"), "utf8");
const prefix: string = JSON.parse(config).issuePrefix;
/** An issue mention in this repository's form: `#7`, or `agbossjs/agboss#7` in a satellite (M1). */
const at = (text: string): string => text.replace(/#(?=\d)/g, prefix);

const OLD = at("## [0.1.0] — 2026-10-26\n\n### Added\n\n- **Old** (#1)\n");
const CHANGELOG = `# Changelog\n\nIntro.\n\n${OLD}`;

const GOLDEN = at(`## [0.2.0] — 2026-12-01

### Changed — breaking

- **Store entry** (#20): first line
  - nested item
  second line

### Added

- **Early** (#5)
- **Late** (#30)

### Fixed

- **Bug** (#7)

`);

let dir: string;
let changelog: string;
const write = (name: string, section: string, issue: string, entry: string): void => {
  writeFileSync(
    join(dir, "changes", name),
    `---\nsection: ${section}\nissue: ${issue}\n---\n\n${at(entry)}\n`,
  );
};
const run = (...args: string[]) =>
  runNode([script, ...args, "--dir", join(dir, "changes"), "--changelog", changelog]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "changelog-"));
  mkdirSync(join(dir, "changes"));
  changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, CHANGELOG);
  writeFileSync(join(dir, "changes", "config.json"), config);
  writeFileSync(join(dir, "changes", "README.md"), "# not a fragment\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AC2: changelog-assemble", () => {
  it("AC2: folds fragments into the golden section, above the older release, and deletes them", async () => {
    write("30-late.md", "Added", "30", "**Late** (#30)");
    write("5-early.md", "Added", "5", "**Early** (#5)");
    write("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    write(
      "20-store.md",
      "Breaking",
      "20",
      "**Store entry** (#20): first line\n- nested item\nsecond line",
    );
    const result = await run("0.2.0", "--date", "2026-12-01");
    expect(result.status).toBe(0);
    expect(readFileSync(changelog, "utf8")).toBe(`# Changelog\n\nIntro.\n\n${GOLDEN}${OLD}`);
    expect(readdirSync(join(dir, "changes")).sort()).toEqual(["README.md", "config.json"]);
  });

  it("AC2: is idempotent — a second run changes nothing", async () => {
    write("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(0);
    const once = readFileSync(changelog, "utf8");
    const again = await run("0.2.0", "--date", "2026-12-01");
    expect(again.status).toBe(0);
    expect(readFileSync(changelog, "utf8")).toBe(once);
  });

  it("AC2: a fragment with an unknown section fails and changes nothing", async () => {
    write("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    write("8-odd.md", "Improved", "8", "**Odd** (#8)");
    const result = await run("0.2.0", "--date", "2026-12-01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('8-odd.md: unknown section "Improved"');
    expect(readFileSync(changelog, "utf8")).toBe(CHANGELOG);
    expect(readdirSync(join(dir, "changes")).sort()).toEqual([
      "7-bug.md",
      "8-odd.md",
      "README.md",
      "config.json",
    ]);
  });

  it("AC2: refuses an issue that disagrees with the name, an entry without its issue, an existing version", async () => {
    write("9-x.md", "Fixed", "10", "**X** (#10)");
    expect((await run("--check")).stderr).toContain("must equal the file name");
    write("9-x.md", "Fixed", "9", "**X** with no reference");
    expect((await run("--check")).stderr).toContain(`must mention ${prefix}9`);
    write("9-x.md", "Fixed", "9", "**X** (#9)");
    const result = await run("0.1.0", "--date", "2026-12-01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has a section for 0.1.0");
  });

  it("creates CHANGELOG.md when a repository has none", async () => {
    rmSync(changelog);
    write("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    expect((await run("0.1.0", "--date", "2026-12-01")).status).toBe(0);
    expect(readFileSync(changelog, "utf8")).toBe(
      at("# Changelog\n\n## [0.1.0] — 2026-12-01\n\n### Fixed\n\n- **Bug** (#7)\n"),
    );
  });

  it("M1: an entry must mention its issue in the repository's form", async () => {
    const entry = (text: string): void => {
      writeFileSync(
        join(dir, "changes", "9-x.md"),
        `---\nsection: Fixed\nissue: 9\n---\n\n**X** (${text})\n`,
      );
    };
    entry("#9");
    expect((await run("--check")).status).toBe(prefix === "#" ? 0 : 1);
    entry("agbossjs/postgres#9");
    expect((await run("--check")).status).toBe(prefix === "#" ? 0 : 1);
    entry(`${prefix}9`);
    expect((await run("--check")).status).toBe(0);
  });

  it("a changes/ directory without config.json fails: the issue form is never guessed", async () => {
    rmSync(join(dir, "changes", "config.json"));
    write("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    const result = await run("--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("config.json is missing");
  });

  it("the fragments in this repository's changes/ are valid", async () => {
    const result = await runNode([script, "--check", "--dir", join(repo, "changes")]);
    expect(result.status).toBe(0);
  });
});
