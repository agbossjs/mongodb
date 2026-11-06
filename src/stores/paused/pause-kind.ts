import { ComponentKind, PauseKind } from "@agboss/core";

/**
 * agbossjs/agboss#801: a pause record stores its `kind` and names its `step`. A record written
 * before kept `agent` and no `kind`; the collections have no versioned schema (each instance makes
 * them at its start), so such a record is read by the rule it was written under — a question
 * role's component is a question, every other pause an approval (one from before components,
 * agbossjs/agboss#268 S93, too) — and `agent` read as `step`. A record that has a `kind` is read as
 * written, never inferred.
 */
export function pauseFieldsOfVersion(
  created: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if ("kind" in created || typeof created.agent !== "string") return created;
  const { agent, ...current } = created;
  const component: unknown = created.component;
  const isQuestion =
    typeof component === "object" &&
    component !== null &&
    Reflect.get(component, "kind") === ComponentKind.Question;
  return { ...current, step: agent, kind: isQuestion ? PauseKind.Question : PauseKind.Approval };
}
