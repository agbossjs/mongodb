// api-extractor prints each warning with its source position, e.g.
//   // src/app/lease-lost.ts:214:3 - (ae-undocumented) Missing documentation for "code".
// Any edit above that line moved it and made `check:api` fail with no change of the API or of its
// documentation (#1040). api-extractor has no option to leave the position out, so the committed
// report is the raw one with `:<line>:<col>` removed: file and message stay, the warning is still
// there, the order is the extractor's (nothing is sorted here).
const POSITION = /^(\s*\/\/ \S+?):\d+:\d+( - \(ae-[\w-]+\))/gm;

/** The report text without the `:line:col` of its `// <file>:<l>:<c> - (ae-…)` warning lines. */
export function normalizePositions(report) {
  return report.replace(POSITION, "$1$2");
}
