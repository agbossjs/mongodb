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

  it("a new ### heading follows the file's style: blank lines between entries when the others have them, tight when they do not", async () => {
    for (const [loose, sep] of [
      [true, "\n\n"],
      [false, "\n"],
    ] as const) {
      const bullets = ["- **A** (#1)", "- **B** (#2)"].join(sep);
      fs.writeFileSync(
        changelog,
        at(
          `# Changelog\n\n## [0.1.1] — unreleased\n\n### Added\n\n${bullets}\n\n### Deprecated\n\n- **D** (#3)\n`,
        ),
      );
      for (const n of ["5", "4"]) frag(`${n}-c.md`, "Changed", n, `**C${n}** (#${n})`);
      expect((await run("0.1.1", "--date", "2026-11-20")).status).toBe(0);
      expect(text()).toContain(
        at(`### Changed\n\n- **C4** (#4)${loose ? "\n\n" : "\n"}- **C5** (#5)\n\n###`),
      );
      for (const n of ["5", "4"]) fs.rmSync(join(dir, "changes", `${n}-c.md`), { force: true });
    }
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

/** #1087: a CRLF CHANGELOG.md folds like an LF one, keeps its line endings, and never grows a second section. */
describe("#1087: CRLF CHANGELOG.md", () => {
  const crlf = (lf: string): string => lf.replace(/\n/g, "\r\n");
  const lone = (value: string): boolean => /(^|[^\r])\n/.test(value);
  const unreleased =
    at("# Changelog\n\n## [0.1.1] — unreleased\n\n### Fixed\n\n- **A** (#3)\n\n") + OLD;
  const headings = (): number =>
    text()
      .split(/\r?\n/)
      .filter((l) => l.startsWith("## [0.1.1]")).length;

  it("AC1: folds into the existing unreleased section: one heading, dated, CRLF throughout, fragments gone", async () => {
    fs.writeFileSync(changelog, crlf(unreleased));
    frag("12-fix.md", "Fixed", "12", "**B** (#12)");
    const result = await run("0.1.1", "--date", "2026-11-14");
    expect(result.status, result.stderr).toBe(0);
    expect(text()).toBe(
      crlf(
        at(
          "# Changelog\n\n## [0.1.1] — 2026-11-14\n\n### Fixed\n\n- **A** (#3)\n- **B** (#12)\n\n",
        ) + OLD,
      ),
    );
    expect(lone(text())).toBe(false);
    expect(headings()).toBe(1);
    expect(fs.existsSync(join(dir, "changes", "12-fix.md"))).toBe(false);
  });

  it("AC1: idempotent on rerun, and a fragment already in the section is not written a second time", async () => {
    fs.writeFileSync(changelog, crlf(unreleased));
    frag("3-again.md", "Fixed", "3", "**A** (#3)");
    expect((await run("0.1.1", "--date", "2026-11-14")).status).toBe(0);
    const once = text();
    expect(once.match(/\*\*A\*\*/g)).toHaveLength(1);
    frag("3-again.md", "Fixed", "3", "**A** (#3)");
    expect((await run("0.1.1", "--date", "2026-11-14")).status).toBe(0);
    expect(text()).toBe(once);
    expect(headings()).toBe(1);
  });

  it("AC1: no fragments — the unreleased heading is dated and the line endings stay", async () => {
    fs.writeFileSync(changelog, crlf(unreleased));
    expect((await run("0.1.1", "--date", "2026-11-14")).status).toBe(0);
    expect(text()).toBe(crlf(unreleased.replace("— unreleased", "— 2026-11-14")));
  });

  it("AC1: an absent version gets a new section in CRLF", async () => {
    fs.writeFileSync(changelog, crlf(at(`# Changelog\n\n${OLD}`)));
    frag("12-fix.md", "Fixed", "12", "**B** (#12)");
    expect((await run("0.1.1", "--date", "2026-11-14")).status).toBe(0);
    expect(lone(text())).toBe(false);
    expect(headings()).toBe(1);
    expect(text()).toContain("## [0.1.1] — 2026-11-14\r\n");
  });

  it("AC1: mixed line endings fail before anything is written or deleted", async () => {
    const mixed = unreleased.replace("# Changelog\n", "# Changelog\r\n");
    fs.writeFileSync(changelog, mixed);
    frag("12-fix.md", "Fixed", "12", "**B** (#12)");
    const result = await run("0.1.1", "--date", "2026-11-14");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("line endings");
    expect(text()).toBe(mixed);
    expect(fs.existsSync(join(dir, "changes", "12-fix.md"))).toBe(true);
  });
});

describe("#1087: the fragments are deleted only after the written file is verified", () => {
  interface Assemble {
    verifyFolded: (
      changelog: string,
      version: string,
      fragments: { file: string; section: string; issue: number; entry: string }[],
    ) => void;
  }
  const load = async (): Promise<Assemble> =>
    (await import(join(repo, "scripts/changelog-fold.mjs"))) as Assemble;
  const fragment = { file: "12-fix.md", section: "Fixed", issue: 12, entry: at("**B** (#12)") };

  it("a file with the entry once and one heading verifies, in LF and in CRLF", async () => {
    const { verifyFolded } = await load();
    const good = at("# Changelog\n\n## [0.1.1] — 2026-11-14\n\n### Fixed\n\n- **B** (#12)\n");
    expect(() => {
      verifyFolded(good, "0.1.1", [fragment]);
    }).not.toThrow();
    const crlf = good.replace(/\n/g, "\r\n");
    expect(() => {
      verifyFolded(crlf, "0.1.1", [fragment]);
    }).not.toThrow();
  });

  it("two sections for the version, a missing entry, an undated heading each throw", async () => {
    const { verifyFolded } = await load();
    const two = at(
      "# Changelog\n\n## [0.1.1] — 2026-11-14\n\n### Fixed\n\n- **B** (#12)\n\n## [0.1.1] — unreleased\n\n- x\n",
    );
    expect(() => {
      verifyFolded(two, "0.1.1", [fragment]);
    }).toThrow(/not folded/);
    const missing = "# Changelog\n\n## [0.1.1] — 2026-11-14\n\n### Fixed\n\n- other\n";
    expect(() => {
      verifyFolded(missing, "0.1.1", [fragment]);
    }).toThrow(/not folded/);
    const undated = at("# Changelog\n\n## [0.1.1] — unreleased\n\n### Fixed\n\n- **B** (#12)\n");
    expect(() => {
      verifyFolded(undated, "0.1.1", [fragment]);
    }).toThrow(/not folded/);
  });
});
