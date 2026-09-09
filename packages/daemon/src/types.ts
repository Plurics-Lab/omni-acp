/**
 * The daemon's public interfaces.
 *
 * They are DECLARED in `@omni-acp/protocol/contracts` and re-exported here, which is the import
 * path every consumer uses. The declaration has to live in `protocol` for the same reason
 * `Supervisor` does: `@omni-acp/testkit` must be able to produce a `Daemon` (`stubDaemon()`) for
 * this package's own HTTP tests, and `testkit -> daemon -> testkit` is not a DAG
 * (CONTRACTS.md §4). Nothing is reshaped on the way through.
 */
export type {
  AuthContext,
  Catalog,
  Daemon,
  DaemonDeps,
  DaemonEvent,
  WorkerRegistry,
  // ── M1 (CONTRACTS.md §5.1 contracts.ts) ───────────────────────────────────
  EventStore,
  PersistenceHandle,
  RetentionReport,
  SessionStrategy,
  WorkerRow,
  WorkerStore,
  // ── M2 (CONTRACTS.md §5.8.8) ──────────────────────────────────────────────
  DeliveryStore,
  DiffProvider,
  InteractionStrategy,
  PolicyEngine,
  RunRegistry,
  RunStore,
  Watchdog,
  WebhookDispatcher,
} from "@omni-acp/protocol";
