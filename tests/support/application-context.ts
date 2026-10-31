import { ApplicationContext, type HostContext } from "@agboss/core";

/**
 * An application context as the framework gives a store (`deps: [ApplicationContext]`), with the
 * environment a test names — its `mongodbUrl` a secret-like value: only `reveal()` gives the URL.
 */
export class TestApplicationContext extends ApplicationContext {
  readonly name = "mongodb-test-application";
  readonly version = "1.0.0";
  readonly instanceId: string;
  readonly startedAt = new Date("2026-01-05T09:00:00.000Z");
  readonly environmentName = "test";
  readonly environment: ApplicationContext["environment"];
  readonly host: HostContext = {
    hostname: "test-host",
    pid: 1,
    platform: "linux",
    runtimeVersion: "v22.13.0",
  };

  constructor(environment: object, instanceId = "instance-1") {
    super();
    this.environment = environment;
    this.instanceId = instanceId;
  }
}

/** What `secret("…")` resolves to in an environment: `reveal()` gives the value, printed as ***. */
export const revealing = (value: string): { reveal(): string; toString(): string } => ({
  reveal: () => value,
  toString: () => "***",
});
