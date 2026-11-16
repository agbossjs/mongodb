import { start as typedStart, type Class } from "@agboss/core";

/**
 * The flow builder without its compile-time checks (the generated `.agboss/types.d.ts` types the
 * layout application only): the same path as the typed builder builds, for the stop tests' workflows.
 */
export interface UntypedPath {
  /** What a `flow` entry's own members are, for the compiler (the runtime object has them). */
  readonly source: never;
  readonly steps: never;
  returns(...dto: unknown[]): UntypedPath;
  toAction(action: Class): UntypedPath;
  toFinish(finish: Class): UntypedPath;
  toParallelWorkflows(workflow: Class, options: unknown): UntypedPath;
  join(): UntypedPath;
}

/** The runtime object of the typed builder is a path: it has every member `UntypedPath` names. */
const isPath = (built: unknown): built is UntypedPath =>
  typeof built === "object" && built !== null;

export const start = (source: Class): UntypedPath => {
  const built: unknown = Reflect.apply(typedStart, undefined, [source]);
  if (!isPath(built)) throw new Error("the flow builder did not build a path");
  return built;
};
