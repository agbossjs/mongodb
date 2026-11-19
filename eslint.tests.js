// Lint rules for the tests: agbossjs/agboss eslint.tests.js, kept alike (split from eslint.config.js
// as there).
const FAKE_INTERRUPT = [
  "AssignmentExpression[left.object.type!='ThisExpression'][left.property.name='name'][right.value=/Interrupt$/]",
  "Property[key.name='name'][value.value=/Interrupt$/]",
].map((selector) => ({
  selector,
  message: "Do not fake a LangGraph interrupt — pause the run for real (testWith).",
}));

// agbossjs/agboss#630: a synchronous child process holds the vitest fork's event loop; held 60 s,
// its pending `onTaskUpdate` times out and the fork's run rejects. The core forbids it only in the
// package that runs two projects on one pool; here every test, stricter than the core
// (agbossjs/agboss#1213): a hung `docker pause` must fail its test, not the run.
const BLOCKING = "/^(spawnSync|execFileSync|execSync)$/";
const BLOCKING_CHILD_PROCESS = [
  `ImportDeclaration[source.value=/^(node:)?child_process$/] ImportSpecifier[imported.name=${BLOCKING}]`,
  `MemberExpression[property.name=${BLOCKING}]`,
].map((selector) => ({
  selector,
  message:
    "No synchronous child process in a test (agbossjs/agboss#630): await one with tests/support/process.ts.",
}));

export const testRules = [
  {
    files: ["tests/**/*.ts"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      // the core also turns off no-explicit-any and no-unused-vars in its tests; kept on here
      // a test must not imitate the framework's failures: the real path has to produce them
      // (agbossjs/agboss#180)
      "no-restricted-syntax": ["error", ...FAKE_INTERRUPT, ...BLOCKING_CHILD_PROCESS],
    },
  },
];
