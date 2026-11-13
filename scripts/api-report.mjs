#!/usr/bin/env node
/**
 * The public API report (as agbossjs/agboss scripts/api-report.mjs): one `api-extractor` report of
 * the package's entry, committed in `api/mongodb.api.md` — a change of the public surface is a
 * diff of that file in review.
 *   node scripts/api-report.mjs          → check (`npm run check`): fails when the report is stale
 *   node scripts/api-report.mjs --write  → rewrite it after an intended API change
 * Runs on the built declarations: `npm run build` first.
 */
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `--package <dir>`: another package folder (the test plants a hole in a small one)
const packageAt = process.argv.indexOf("--package");
const ROOT =
  packageAt === -1
    ? fileURLToPath(new URL("..", import.meta.url))
    : resolve(process.argv[packageAt + 1] ?? "");
const REPORTS = join(ROOT, "api");
const write = process.argv.includes("--write");
const entry = join(ROOT, "dist", "index.d.ts");
if (!existsSync(entry)) {
  console.error(`${entry} is missing — run npm run build first`);
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "agboss-mongodb-api-"));
mkdirSync(REPORTS, { recursive: true });
const config = ExtractorConfig.prepare({
  configObject: {
    projectFolder: ROOT,
    mainEntryPointFilePath: entry,
    compiler: { tsconfigFilePath: join(ROOT, "tsconfig.build.json") },
    apiReport: {
      enabled: true,
      reportFileName: "mongodb",
      reportFolder: REPORTS,
      reportTempFolder: temp,
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    newlineKind: "lf",
    messages: {
      // findings are notes in the report, not errors; an unexported type of a signature is the
      // exception: `ae-forgotten-export` is collected below and fails the check (#895) — the
      // package has one entry, so a type its entry does not export is one no user can name
      extractorMessageReporting: {
        default: { logLevel: "none", addToApiReportFile: true },
        "ae-forgotten-export": { logLevel: "none", addToApiReportFile: false },
        "ae-missing-release-tag": { logLevel: "none", addToApiReportFile: false },
        "ae-wrong-input-file-type": { logLevel: "none", addToApiReportFile: false },
      },
      tsdocMessageReporting: { default: { logLevel: "none" } },
      compilerMessageReporting: { default: { logLevel: "warning" } },
    },
  },
  configObjectFullPath: undefined,
  packageJsonFullPath: join(ROOT, "package.json"),
});

const forgotten = [];
const result = Extractor.invoke(config, {
  localBuild: write,
  showVerboseMessages: false,
  messageCallback: (message) => {
    if (message.messageId !== "ae-forgotten-export") return;
    forgotten.push(/"([^"]+)"/.exec(message.text)?.[1] ?? message.text);
    message.handled = true;
  },
});
rmSync(temp, { recursive: true, force: true });
if (forgotten.length > 0) {
  console.error(
    `Types of the public API that the entry does not export (#895): ${[...new Set(forgotten)].join(", ")}.\n` +
      "Export each, or narrow the signature so it is not named.",
  );
  process.exit(1);
}
if (!result.succeeded || (!write && result.apiReportChanged)) {
  console.error(
    "api/mongodb.api.md is stale: the public API changed — review it, then npm run api:update",
  );
  process.exit(1);
}
console.log(write ? "api/mongodb.api.md written" : "api/mongodb.api.md is current");
