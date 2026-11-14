/**
 * #1040 — `scripts/api-positions.mjs`: the committed API report carries no `:line:col` of the
 * api-extractor warnings, so an edit that only moves lines does not make `check:api` fail.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../", import.meta.url).pathname;
interface ApiPositions {
  readonly normalizePositions: (report: string) => string;
}
const { normalizePositions } = (await import(
  join(repo, "scripts/api-positions.mjs")
)) as ApiPositions;

describe("normalizePositions (#1040)", () => {
  it("strips line and column, keeps file and message", () => {
    expect(
      normalizePositions(
        '// src/app/lease-lost.ts:214:3 - (ae-undocumented) Missing documentation for "code".',
      ),
    ).toBe('// src/app/lease-lost.ts - (ae-undocumented) Missing documentation for "code".');
  });

  it("keeps every warning and its order: two in one file stay as they were", () => {
    const at = (a: string, b: string): string =>
      `// src/a.ts:${a}:3 - (ae-undocumented) Missing documentation for "x".\n` +
      `// src/a.ts:${b}:12 - (ae-undocumented) Missing documentation for "y".\n`;

    expect(normalizePositions(at("10", "11"))).toBe(normalizePositions(at("11", "300")));
    expect(normalizePositions(at("10", "11")).split("\n")).toEqual([
      '// src/a.ts - (ae-undocumented) Missing documentation for "x".',
      '// src/a.ts - (ae-undocumented) Missing documentation for "y".',
      "",
    ]);
  });

  it("handles an indented warning and a path with a colon-free subfolder", () => {
    expect(normalizePositions('  // src/a/b-c.ts:1:1 - (ae-forgotten-export) The "T".')).toBe(
      '  // src/a/b-c.ts - (ae-forgotten-export) The "T".',
    );
  });

  it("leaves everything else alone: code, ordinary comments, numbers in messages", () => {
    const text = [
      "export const a: number;",
      "// Warning: nothing at 1:2 here",
      "// @public (undocumented)",
      "// src/a.ts - (ae-undocumented) already normalized, 3:4 in the text",
      "export function f(): void; // trailing src/x.ts:1:2 - (ae-undocumented) not a line start",
    ].join("\n");

    expect(normalizePositions(text)).toBe(text);
  });

  it("is idempotent", () => {
    const once = normalizePositions("// src/a.ts:5:6 - (ae-undocumented) m");

    expect(normalizePositions(once)).toBe(once);
  });
});
