import type { CommandStartedEvent, Document, MongoClient, MongoClientOptions } from "mongodb";
import type * as Driver from "mongodb";

/**
 * The commands a connection's client sent (agbossjs/agboss#1213): which of them were in a
 * transaction (`autocommit: false`) — an operation of a transaction's work that does not pass its
 * session is a command outside it, never undone by an abort and blind to the transaction's writes.
 */

/** A data command the client sent. */
export interface Sent {
  readonly name: string;
  readonly collection: string;
  readonly inTransaction: boolean;
  readonly command: Document;
}

const DATA = new Set(["find", "insert", "update", "delete", "findAndModify", "aggregate"]);

/**
 * `mongodb` whose clients report their commands: the factory of a test file's
 * `vi.mock("mongodb", …)`, made before the file's modules load the driver.
 */
export function reportingCommands(actual: typeof Driver): typeof Driver {
  class Reporting extends actual.MongoClient {
    constructor(url: string, options?: MongoClientOptions) {
      super(url, { ...options, monitorCommands: true });
    }
  }
  return { ...actual, MongoClient: Reporting };
}

/** The data commands `connection` (a `MongoConnection`, or any holder of a client) sends from now on, in the order sent. */
export function commandsOf(connection: { readonly client: MongoClient }): Sent[] {
  const log: Sent[] = [];
  connection.client.on("commandStarted", (event: CommandStartedEvent) => {
    if (!DATA.has(event.commandName)) return;
    const target: unknown = event.command[event.commandName];
    log.push({
      name: event.commandName,
      collection: typeof target === "string" ? target : "",
      inTransaction: event.command.autocommit === false,
      command: event.command,
    });
  });
  return log;
}

/** `find agboss_pauses`, … */
export const nameOf = (sent: Sent): string => `${sent.name} ${sent.collection}`;
