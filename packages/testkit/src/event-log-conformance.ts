import { OmniError, type EventLog } from "@omni-acp/protocol";

/**
 * The suite M1's SQLite driver must pass verbatim. Call inside a describe block.
 *
 * It exists in M0 so that swapping the event-log driver in M1 is a one-file change with a
 * pre-existing proof obligation, not a re-derivation of what the log guarantees
 * (CONTRACTS.md §8.1).
 */
export function runEventLogConformance(name: string, make: () => EventLog): void {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.runEventLogConformance)");
}
