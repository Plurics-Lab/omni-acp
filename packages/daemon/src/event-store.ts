import {
  OmniError,
  type Clock,
  type Logger,
  type PersistenceHandle,
  type ResolvedDaemonConfig,
} from "@omni-acp/protocol";

/**
 * The daemon's side of persistence: open it once, take the data-dir lock, migrate, arm the
 * retention timer, and close it AFTER `closeAll` so the closing envelopes reach disk
 * (CONTRACTS.md §14, M1-PLAN WP-E acceptance 5).
 *
 * Returns `null` for `eventLog.driver: "memory"`, which is still the default (ruling M1-R17):
 * `createDaemon()` must keep a zero-file, zero-experimental-module footprint so `OmniACP.local()`
 * in a user's script does not leave a database behind. `omni-acp start` is what writes
 * `"sqlite"` into the config it builds.
 *
 * Owned by M1-WP-E (the wiring) over M1-WP-A's `openPersistence`.
 */
export function openDaemonPersistence(_o: {
  config: ResolvedDaemonConfig;
  clock: Clock;
  logger: Logger;
}): Promise<PersistenceHandle | null> {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
