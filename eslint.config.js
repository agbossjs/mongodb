import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { agbossPlugin } from "@agboss/core/eslint";

/**
 * The core's standards (agbossjs/agboss eslint.config.js): strict type-checked rules, 200 lines per
 * file, 50 per function, complexity 10, no console; the AGBoss rules from `@agboss/core/eslint` —
 * no state in a component, time only from the `Clock`. Suppressions are counted by
 * `scripts/check-suppressions.mjs`, whose budget is zero.
 */
export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules", ".packed", ".agboss-source", ".agboss", "temp"] },
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
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: { agboss: agbossPlugin },
    rules: { "agboss/no-component-state": "error", "agboss/no-direct-time": "error" },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off", "@typescript-eslint/explicit-module-boundary-types": "off" },
  },
);
