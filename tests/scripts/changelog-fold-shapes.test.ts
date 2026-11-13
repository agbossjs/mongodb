/**
 * agbossjs/agboss#981 (second fix-forward): D1b — a fragment goes under the last custom heading of its kind ("Fixed —
 * other"), never into a second plain "Fixed" (the real 0.1.1 section's shape); M4 — with no fragments the
 * heading of an unreleased section is still dated, and nothing else changes.
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
/** The shape of core's 0.1.1 section: custom headings, not in the canonical order. */
const section = (head: string): string =>
  at(
    [
      head,
      "",
      "The release in one line.",
      "",
      "### Changed — breaking",
      "",
      "- **Narrowed** (#895)",
      "",
      "### Changed — breaking for stores outside the core",
      "",
      "- **Stores** (#890)",
      "",
      "### Deprecated",
      "",
      "- **Old name** (#12)",
      "",
      "### Security",
      "",
      "- **Audit** (#791)",
      "",
      "### Fixed — guarantees and safety",
      "",
      "- **Fence** (#900)",
      "",
      "### Added",
      "",
      "- **Skills** (#305)",
      "",
      "- **Mesh** (#306)",
      "",
      "### Fixed — other",
      "",
      "- **Other** (#901)",
      "",
      "- **More** (#903)",
      "",
      "### Docs",
      "",
      "- **Guide** (#902)",
    ].join("\n") + "\n",
  );

let dir: string;
let changelog: string;
const frag = (name: string, sectionName: string, issue: string, entry: string): void => {
  fs.writeFileSync(
    join(dir, "changes", name),
    `---\nsection: ${sectionName}\nissue: ${issue}\n---\n\n${at(entry)}\n`,
  );
};
const run = (...args: string[]) =>
  runProcess(process.execPath, [
    script,
    ...args,
    "--dir",
    join(dir, "changes"),
    "--changelog",
    changelog,
  ]);
const text = (): string => fs.readFileSync(changelog, "utf8");

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "changelog-shapes-"));
  fs.mkdirSync(join(dir, "changes"));
  changelog = join(dir, "CHANGELOG.md");
  fs.writeFileSync(join(dir, "changes", "config.json"), config);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("D1b: the real 0.1.1 section's shape", () => {
  it("Fixed goes under the last 'Fixed —', Changed gets one heading before Deprecated, Added joins its own", async () => {
    const head = "## [0.1.1] — unreleased";
    fs.writeFileSync(changelog, `# Changelog\n\n${section(head)}\n${OLD}`);
    frag("981-tooling.md", "Changed", "981", "**Fragments** (#981)");
    frag("939-resend.md", "Fixed", "939", "**Resend** (#939)");
    frag("980-scenario.md", "Fixed", "980", "**Scenario** (#980)");
    frag("983-agents.md", "Added", "983", "**Agents** (#983)");
    const result = await run("0.1.1", "--date", "2026-11-20");
    expect(result.status, result.stderr).toBe(0);
    const expected = section("## [0.1.1] — 2026-11-20")
      .replace("### Deprecated", at("### Changed\n\n- **Fragments** (#981)\n\n### Deprecated"))
      .replace(at("- **Mesh** (#306)\n"), at("- **Mesh** (#306)\n\n- **Agents** (#983)\n"))
      .replace(
        at("- **More** (#903)\n"),
        at("- **More** (#903)\n\n- **Resend** (#939)\n\n- **Scenario** (#980)\n"),
      );
    expect(text()).toBe(`# Changelog\n\n${expected}\n${OLD}`);
    expect(text().match(/^### Fixed/gm)).toHaveLength(2);
  });

  it("with no kin heading at all, the canonical one is created in order", async () => {
    fs.writeFileSync(
      changelog,
      at(
        `# Changelog\n\n## [0.1.1] — unreleased\n\n### Added\n\n- **A** (#1)\n\n### Docs\n\n- **D** (#2)\n`,
      ),
    );
    frag("7-bug.md", "Fixed", "7", "**Bug** (#7)");
    expect((await run("0.1.1", "--date", "2026-11-20")).status).toBe(0);
    expect(text()).toBe(
      at(
        "# Changelog\n\n## [0.1.1] — 2026-11-20\n\n### Added\n\n- **A** (#1)\n\n### Fixed\n\n- **Bug** (#7)\n\n### Docs\n\n- **D** (#2)\n",
      ),
    );
  });
});

describe("M4: no fragments", () => {
  it.each([
    ["core", "## [0.1.1] — unreleased"],
    ["satellite", "## [Unreleased] — 0.1.1 (draft: the first release)"],
  ])("%s: an unreleased heading is dated, the rest is byte-identical", async (_name, head) => {
    fs.writeFileSync(changelog, `# Changelog\n\n${section(head)}\n${OLD}`);
    const result = await run("0.1.1", "--date", "2026-11-20");
    expect(result.status, result.stderr).toBe(0);
    expect(text()).toBe(`# Changelog\n\n${section("## [0.1.1] — 2026-11-20")}\n${OLD}`);
    const again = await run("0.1.1", "--date", "2026-11-21");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("nothing to assemble");
    expect(text()).toContain("## [0.1.1] — 2026-11-20");
  });

  it("an absent version writes nothing, and no file is created", async () => {
    const result = await run("0.1.1", "--date", "2026-11-20");
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(changelog)).toBe(false);
    fs.writeFileSync(changelog, `# Changelog\n\n${OLD}`);
    expect((await run("0.1.1", "--date", "2026-11-20")).status).toBe(0);
    expect(text()).toBe(`# Changelog\n\n${OLD}`);
  });

  it("a released version stays as it is", async () => {
    fs.writeFileSync(changelog, `# Changelog\n\n${OLD}`);
    expect((await run("0.1.0", "--date", "2026-11-20")).status).toBe(0);
    expect(text()).toBe(`# Changelog\n\n${OLD}`);
  });
});
