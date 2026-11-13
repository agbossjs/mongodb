/**
 * #906 AC1 (completing #890, G8): every error `@agboss/mongodb` exports is made from one options
 * object whose keys are its own properties, with a `cause` that is kept — the core's convention. The
 * test walks the entry's exports (every `Error` class, not only an `AGBossError`): a new error class without a fixture here fails it.
 */
import { AGBossError } from "@agboss/core";
import { describe, expect, it } from "vitest";
import * as entry from "../../src/index.js";

const FIXTURES: Readonly<Record<string, object>> = {
  MongoCollationNotSimpleError: { collections: ["agboss_threads"] },
  MongoDeploymentError: {},
  MongoDurabilityError: { problems: ["w: 1 is not majority"] },
  MongoLedgerMarkMissingError: { malformed: true, recreatedAt: new Date(0) },
  MongoSchemaMissingError: { applied: 1, expected: 4, collections: ["agboss_threads"] },
  MongoSchemaTooNewError: { applied: 5, expected: 4 },
  MongoSettingsError: { message: "mongodbUrl is empty" },
};

type ErrorClass = abstract new (options: never) => Error;

const classes = Object.entries(entry).flatMap(([name, value]): [string, ErrorClass][] =>
  typeof value === "function" && value.prototype instanceof Error
    ? [[name, value as ErrorClass]]
    : [],
);

/** `new ErrorClass(options)`, however its options are typed. */
const made = (ErrorClass: ErrorClass, options: object): Error => {
  const error: unknown = Reflect.construct(ErrorClass, [options]);
  if (!(error instanceof Error)) throw new TypeError("not an Error");
  return error;
};

describe("#906 AC1: every error takes one options bag with a cause", () => {
  it("AC1: each exported error has a fixture", () => {
    expect(classes.map(([name]) => name).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it.each(classes)(
    "AC1: %s — keys are own properties, the cause is kept, the code literal",
    (name, ErrorClass) => {
      const options = FIXTURES[name] ?? {};
      const cause = new Error(`the cause of ${name}`);

      const error = made(ErrorClass, { ...options, cause });

      expect(error.cause).toBe(cause);
      expect(Object.keys(options).filter((key) => !Object.hasOwn(error, key))).toEqual([]);
      expect(Reflect.get(error, "code")).toBe(Reflect.get(ErrorClass, "code"));
      expect(made(ErrorClass, options)).toBeInstanceOf(AGBossError);
    },
  );
});
