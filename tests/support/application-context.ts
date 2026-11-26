import { ApplicationContext, type HostContext } from "@agboss/core";

/** An application context as the framework gives a store (`deps: [ApplicationContext]`). */
export class TestApplicationContext extends ApplicationContext {
  readonly name = "mongodb-test-application";
  readonly version = "1.0.0";
  readonly instanceId: string;
  readonly startedAt = new Date("2026-01-05T09:00:00.000Z");
  readonly profiles: ApplicationContext["profiles"] = ["test"];
  readonly host: HostContext = {
    hostname: "test-host",
    pid: 1,
    platform: "linux",
    runtimeVersion: "v22.13.0",
  };

  constructor(instanceId = "instance-1") {
    super();
    this.instanceId = instanceId;
  }
}

/** What `secret("…")` resolves to in the driver's settings: `reveal()` gives the value, printed as ***. */
export const revealing = (value: string): { reveal(): string; toString(): string } => ({
  reveal: () => value,
  toString: () => "***",
});
