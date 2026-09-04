import {
  OmniError,
  type Clock,
  type EventLog,
  type Logger,
  type PersistenceHandle,
  type ResolvedDaemonConfig,
  type Supervisor,
  type WorkerId,
} from "@omni-acp/protocol";

/**
 * Runs ONCE inside `createDaemon()` before `start()` returns (CONTRACTS.md §15.7, H21).
 *
 * Three obligations, in this order, and the first is the one that matters:
 *
 *  1. RECORD every orphan a previous boot left behind. A process we cannot reap is still a
 *     process an operator needs to see — `GET /v1/info.orphansAtStart` says `{found, reaped,
 *     skipped}` and `skipped: n` is the honest Windows answer, not silence.
 *  2. Reap ONLY a matching fingerprint. A null or mismatched token is never signalled, because
 *     pid reuse makes that a coin flip on somebody else's process.
 *  3. Converge every abandoned row on `hibernated` or `closed`, appending the in-band
 *     `omni.error`, the `daemon_restart` / `orphaned` state envelope, and the
 *     `omni.lease{expired, how:"daemon_restart"}` that makes a restart's lease transfer AUDITED
 *     rather than silent (ruling M1-R8).
 *
 * It is a NO-OP on a second run.
 *
 * Owned by M1-WP-E.
 */
export function recoverFromPreviousBoot(_o: {
  persistence: PersistenceHandle;
  supervisor: Supervisor;
  config: ResolvedDaemonConfig;
  clock: Clock;
  logger: Logger;
  logFor: (id: WorkerId) => EventLog;
}): Promise<{ found: number; reaped: number; skipped: number }> {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
