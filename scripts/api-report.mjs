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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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
      // findings (a public type using an unexported one) are notes in the report, not errors
      extractorMessageReporting: {
        default: { logLevel: "none", addToApiReportFile: true },
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

const result = Extractor.invoke(config, { localBuild: write, showVerboseMessages: false });
rmSync(temp, { recursive: true, force: true });
if (!result.succeeded || (!write && result.apiReportChanged)) {
  console.error(
    "api/mongodb.api.md is stale: the public API changed — review it, then npm run api:update",
  );
  process.exit(1);
}
console.log(write ? "api/mongodb.api.md written" : "api/mongodb.api.md is current");
