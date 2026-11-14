/**
 * agbossjs/agboss#981 (fix-forward): the assemble script folds fragments into an existing unreleased section of its
 * version (D1), in either heading shape, and survives a crash between the write and the deletes (M2).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runProcess = (command: string, args: readonly string[]) =>
  Promise.resolve(spawnSync(command, [...args], { encoding: "utf8" }));
const repo = new URL("../../", import.meta.url).pathname;
const script = join(repo, "scripts/changelog-assemble.mjs");
const config = fs.readFileSync(join(repo, "changes/config.json"), "utf8");
const prefix: string = JSON.parse(config).issuePrefix;
const at = (text: string): string => text.replace(/#(?=\d)/g, prefix);

const OLD = at("## [0.1.0] — 2026-10-26\n\n### Added\n\n- **Old** (#1)\n");
const TAIL = `\n${OLD}`;
const CORE_HEAD = "## [0.2.0] — unreleased";
const SAT_HEAD = "## [Unreleased] — 0.2.0 (draft: the first release)";
const body = (loose: boolean): string =>
  at(
    [
      "The release in one line.",
      "",
      "### Changed — breaking for stores outside the core",
      "",
      "- **Custom** (#2)",
      "",
      "### Fixed — other",
      "",
      "- **Other one** (#3)",
      ...(loose ? ["", "- **Other two** (#4)"] : ["- **Other two** (#4)"]),
      "",
      "### Docs",
      "",
      "- **Doc** (#6)",
      "",
    ].join("\n"),
  );

let dir: string;
let changelog: string;
const frag = (name: string, section: string, issue: string, entry: string): void => {
  fs.writeFileSync(
    join(dir, "changes", name),
    `---\nsection: ${section}\nissue: ${issue}\n---\n\n${at(entry)}\n`,
  );
};

const paths = (): string[] => ["--dir", join(dir, "changes"), "--changelog", changelog];
const run = (...args: string[]) => runProcess(process.execPath, [script, ...args, ...paths()]);
const text = (): string => fs.readFileSync(changelog, "utf8");
const fragments = (): string[] =>
  fs.readdirSync(join(dir, "changes")).filter((name) => /^\d/.test(name));
const addFragments = (): void => {
  frag("20-store.md", "Breaking", "20", "**Store** (#20)");
  frag("30-late.md", "Added", "30", "**Late** (#30)");
  frag("5-early.md", "Added", "5", "**Early** (#5)");
  frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
};

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "changelog-fold-"));
  fs.mkdirSync(join(dir, "changes"));
  changelog = join(dir, "CHANGELOG.md");
  fs.writeFileSync(join(dir, "changes", "config.json"), config);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const GOLDEN = (loose: boolean): string =>
  at(`## [0.2.0] — 2026-12-01

The release in one line.

### Changed — breaking for stores outside the core

- **Custom** (#2)
- **Store** (#20)

### Added

- **Early** (#5)
- **Late** (#30)

### Fixed — other

- **Other one** (#3)
${loose ? "\n" : ""}- **Other two** (#4)
${loose ? "\n" : ""}- **Bug** (#7)

### Docs

- **Doc** (#6)
`);

describe("D1: folding into an unreleased section", async () => {
  it.each([
    ["core shape", CORE_HEAD, false],
    ["satellite shape", SAT_HEAD, true],
  ])(
    "%s: appends under the subheadings, in order, dates the heading",
    async (_name, head, loose) => {
      fs.writeFileSync(changelog, `# Changelog\n\nIntro.\n\n${head}\n\n${body(loose)}${TAIL}`);
      addFragments();
      const result = await run("0.2.0", "--date", "2026-12-01");
      expect(result.status, result.stderr).toBe(0);
      expect(text()).toBe(`# Changelog\n\nIntro.\n\n${GOLDEN(loose)}${TAIL}`);
      expect(fragments()).toEqual([]);
    },
  );

  it("appends to an existing canonical subheading, matching its bullet spacing", async () => {
    fs.writeFileSync(
      changelog,
      at(
        `# Changelog\n\n${CORE_HEAD}\n\n### Added\n\n- **First** (#1)\n\n- **Second** (#2)\n${TAIL}`,
      ),
    );
    frag("5-early.md", "Added", "5", "**Early** (#5)");
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(0);
    expect(text()).toBe(
      at(
        `# Changelog\n\n## [0.2.0] — 2026-12-01\n\n### Added\n\n- **First** (#1)\n\n- **Second** (#2)\n\n- **Early** (#5)\n${TAIL}`,
      ),
    );
  });

  it("no section for the version: writes a new one above the newest release (0.2.1 is not 0.2.10)", async () => {
    fs.writeFileSync(
      changelog,
      at(`# Changelog\n\n## [0.2.10] — unreleased\n\n### Fixed\n\n- **X** (#9)\n`),
    );
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    expect((await run("0.2.1", "--date", "2026-12-01")).status).toBe(0);
    expect(text()).toBe(
      at(
        "# Changelog\n\n## [0.2.1] — 2026-12-01\n\n### Fixed\n\n- **Bug** (#7)\n\n## [0.2.10] — unreleased\n\n### Fixed\n\n- **X** (#9)\n",
      ),
    );
  });

  it("a released section for the version still fails and changes nothing", async () => {
    fs.writeFileSync(changelog, `# Changelog\n\n${OLD}`);
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    const result = await run("0.1.0", "--date", "2026-12-01");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has a section for 0.1.0");
    expect(text()).toBe(`# Changelog\n\n${OLD}`);
    expect(fragments()).toEqual(["7-bug.md"]);
  });
});

describe("M2: a crash between the write and the deletes", async () => {
  it("a rerun deletes the fragments already in the section and inserts nothing twice", async () => {
    fs.writeFileSync(changelog, `# Changelog\n\n${CORE_HEAD}\n\n${body(false)}${TAIL}`);
    addFragments();
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(0);
    const done = text();
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    frag("5-early.md", "Added", "5", "**Early** (#5)");
    const rerun = await run("0.2.0", "--date", "2026-12-02");
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(text()).toBe(done);
    expect(fragments()).toEqual([]);
  });

  it("a rerun with one fragment missing from the dated section fails and keeps everything", async () => {
    fs.writeFileSync(changelog, `# Changelog\n\n${CORE_HEAD}\n\n${body(false)}${TAIL}`);
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(0);
    const done = text();
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    frag("8-new.md", "Fixed", "8", "**New** (#8)");
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(1);
    expect(text()).toBe(done);
    expect(fragments()).toEqual(["7-bug.md", "8-new.md"]);
  });

  it("leaves no temp file behind, and a read-only CHANGELOG.md is refused untouched", async () => {
    fs.writeFileSync(changelog, `# Changelog\n\n${CORE_HEAD}\n\n${body(false)}${TAIL}`);
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    fs.chmodSync(changelog, 0o444);
    const before = text();
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(1);
    expect(text()).toBe(before);
    expect(fragments()).toEqual(["7-bug.md"]);
    fs.chmodSync(changelog, 0o644);
    expect((await run("0.2.0", "--date", "2026-12-01")).status).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(["CHANGELOG.md", "changes"]);
  });
});
