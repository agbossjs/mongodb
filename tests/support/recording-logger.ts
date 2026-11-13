import { Logger, type LogEntry } from "@agboss/core";

/** A `Logger` that keeps its entries: a test reads what the framework (or a store) warned. */
export class RecordingLogger extends Logger {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}
