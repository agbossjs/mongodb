// A copy of agbossjs/agboss scripts/packed/npm-before.mjs (#523): keep the two alike.
// The minimum release age of an install that resolves ranges (#523). A lockfile install (`npm ci`)
// takes the versions somebody reviewed; an install that must resolve ranges — the tarballs'
// dependencies in a probe project — takes none younger than MINIMUM_RELEASE_AGE_DAYS:
// `npm install --before=<now − 3 days>`. A release minutes old is what a registry mirror may not
// have yet (a flaky 404) and what nobody has reviewed yet (the window in which malicious releases
// are caught). `AGBOSS_NPM_BEFORE=<ISO date>` overrides the date — at release time only, by the
// maintainer, locally (agbossjs/agboss RELEASE_CHECKLIST.md → Dependency installs). `@agboss/*` tarballs installed by path are exempt:
// `--before` filters registry versions, never a file.

/** How old, in days, the youngest release an install may take is. */
export const MINIMUM_RELEASE_AGE_DAYS = 3;

/** The variable that overrides the date: an ISO 8601 moment. */
export const NPM_BEFORE_VARIABLE = "AGBOSS_NPM_BEFORE";

const DAY = 24 * 60 * 60 * 1000;

/** An `AGBOSS_NPM_BEFORE` that is not a date. */
export class NpmBeforeError extends Error {}

/** The `--before` moment, ISO 8601: `AGBOSS_NPM_BEFORE` when set, else `now` − 3 days. */
export function npmBeforeOf(env = process.env, now = new Date()) {
  const override = env[NPM_BEFORE_VARIABLE];
  if (override === undefined || override.trim() === "")
    return new Date(now.getTime() - MINIMUM_RELEASE_AGE_DAYS * DAY).toISOString();
  const moment = Date.parse(override);
  if (Number.isNaN(moment))
    throw new NpmBeforeError(
      `${NPM_BEFORE_VARIABLE}=${override} is not a date (ISO 8601, e.g. 2026-10-31T12:00:00Z)`,
    );
  return new Date(moment).toISOString();
}

/** `npm install --before=<date> <…rest>`: the arguments of an install that resolves ranges. */
export function rangeInstallArguments(rest = [], env = process.env, now = new Date()) {
  return ["install", `--before=${npmBeforeOf(env, now)}`, ...rest];
}
