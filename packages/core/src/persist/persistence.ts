import {
  OmniError,
  type Clock,
  type EventStore,
  type PersistenceHandle,
  type ResolvedEventLogConfig,
  type WorkerStore,
} from "@omni-acp/protocol";

/**
 * The `PersistenceHandle` `createDaemon()` opens once and hands to the registry: the two stores,
 * this boot's id, one bounded `sweep()`, and `close()`.
 *
 * `bootId` is this daemon INSTANCE's id, not the stable `daemonId` — the difference is what lets
 * boot adoption recognise a row a PREVIOUS boot owned (§15.7).
 *
 * Owned by M1-WP-A.
 */
export function createPersistenceHandle(_o: {
  events: EventStore;
  workers: WorkerStore;
  bootId: string;
  config: ResolvedEventLogConfig;
  clock: Clock;
  release: () => Promise<void>;
}): PersistenceHandle {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
