import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { agbossPlugin } from "@agboss/core/eslint";
import { testRules } from "./eslint.tests.js";

/** The core's internals are never a store's (CLAUDE.md → Rules: public entries only). */
const INTERNAL = {
  regex: "^@agboss/(core|cli)/(internal|dist|src)(/|$)",
  message:
    "Import only @agboss/core's public entries; when a seam is missing, report it on the issue.",
};
/** The published code never loads the core's test kit (a user's install has no vitest). */
const TESTING = {
  regex: "^@agboss/core/testing(/|$)",
  message: "src/ is the published package: the core's testing entries are for tests/ only.",
};

/**
 * The core's standards (agbossjs/agboss eslint.config.js): strict type-checked rules, 200 lines per
 * file, 50 per function, complexity 10, no console; the AGBoss rules from `@agboss/core/eslint` —
 * no state in a component, time only from the `Clock`; the tests' rules of eslint.tests.js. Not the
 * core's `lazyLoad` rule (#646): no module here imports dynamically, and `lazyLoad` is no public
 * entry. Imports: public `@agboss/core` entries only, never its testing kit from src. Suppressions are counted by
 * `scripts/check-suppressions.mjs`, whose budget is zero.
 */
export default tseslint.config(
  {
    ignores: [
      "dist",
      "coverage",
      "node_modules",
      ".packed",
      ".agboss-source",
      ".agboss",
      "temp",
      // a Stryker sandbox (a copy of the package) left behind by an interrupted mutation run
      ".stryker-tmp*",
      "reports",
      // the process fixtures are written in the 0.1.0 DSL: out of the typecheck until the DSL port
      "tests/fixtures",
      "tests/processes",
      "tests/integration/close-quiet-app.integration.test.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/require-await": "off",
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 10],
      "no-console": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
      // typescript-eslint 8.73 added it to strictTypeChecked (agbossjs/agboss#1330, #1340): an object
      // literal where the driver types a class (a WriteConcern, a BulkWriteResult) or a DTO class is
      // the parameter type is the documented call shape, as the core's template has it off
      "@typescript-eslint/no-unsafe-class-instance-assignment": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: { agboss: agbossPlugin },
    rules: {
      "agboss/no-component-state": "error",
      "agboss/no-direct-time": "error",
      "no-restricted-imports": ["error", { patterns: [INTERNAL, TESTING] }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [INTERNAL] }] },
  },
  ...testRules,
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs", "bin/**/*.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off", "@typescript-eslint/explicit-module-boundary-types": "off" },
  },
);
