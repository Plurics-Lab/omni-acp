import { OmniError, type EventStore, type ResolvedEventLogConfig } from "@omni-acp/protocol";

/**
 * The `EventStore` over `node:sqlite`'s `DatabaseSync` — SYNCHRONOUS, for exactly the reason
 * `EventLog.append` is (§8.1): an async `put` reintroduces the interleave that a non-monotonic
 * `seq` is. WAL + `synchronous=NORMAL`: a daemon crash loses nothing; only power loss can.
 *
 * `headOf` returns `max(seq)` EVER assigned, including rows retention has already evicted — the
 * §14.4 bug that eats a whole class of logs lives in the difference between that and
 * `max(seq) currently present`.
 *
 * Owned by M1-WP-A.
 */
export function createSqliteEventStore(_db: unknown, _config: ResolvedEventLogConfig): EventStore {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
