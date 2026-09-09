import type {
  Clock,
  EventStore,
  Logger,
  PersistenceHandle,
  ResolvedEventLogConfig,
  RetentionInput,
  RetentionReport,
  WorkerId,
  WorkerState,
  WorkerStore,
} from "@omni-acp/protocol";
import { planRetention, runRetention } from "../event-log/retention.js";
import type { DeliveryStoreV2 } from "./delivery-store.js";
import type { RunStoreV2 } from "./run-store.js";

/**
 * The M2 half of a durable handle: the two v2 stores, and ONE transaction across them.
 *
 * It is a SEPARATE interface rather than three more members on `PersistenceHandle` because
 * `PersistenceHandle` is frozen in `@omni-acp/protocol` (§5.8.8) and adding to it would be a
 * cross-owner edit for three fields that only the run subsystem ever reads. `openPersistence`
 * returns the intersection, so an M1 caller typed to `PersistenceHandle` is unaffected and
 * `daemon/src/runs.ts` narrows structurally.
 */
export interface RunPersistence {
  readonly runs: RunStoreV2;
  readonly deliveries: DeliveryStoreV2;
  /** §24.4 rule 1: a run's state change and its delivery's enqueue are one write or neither. */
  transaction<T>(fn: () => T): T;
}

/** What `openPersistence` actually returns from M2 on. */
export type DurablePersistenceHandle = PersistenceHandle & RunPersistence;

/**
 * How many freed pages one sweep hands back to the OS.
 *
 * `pragma incremental_vacuum` with no argument moves the WHOLE freelist, which on a data dir
 * that has just aged out a month of logs is an unbounded stall inside a periodic timer. A bound
 * makes the sweep's cost proportional to its own deletions; the remainder goes back on the next
 * pass, which is the pass that would otherwise have nothing to do.
 */
const VACUUM_PAGES_PER_SWEEP = 4_096;

export interface CreatePersistenceHandleOptions {
  readonly events: EventStore;
  readonly workers: WorkerStore;
  /** M2 (§24.2). The two v2 stores and the transaction that spans them. */
  readonly runs: RunStoreV2;
  readonly deliveries: DeliveryStoreV2;
  readonly transaction: <T>(fn: () => T) => T;
  /**
   * `run.retentionDays` and `webhooks.retentionDays`, in days.
   *
   * They arrive here rather than being read off `ResolvedEventLogConfig`, because they are not
   * event-log settings — but they are swept by the SAME timer (§24.5), so the handle has to know
   * them. Absent ⇒ the event log's own `retentionDays`, which is the only number available and
   * is the one an operator who has not thought about runs would expect.
   */
  readonly runRetentionDays?: number;
  readonly deliveryRetentionDays?: number;
  readonly bootId: string;
  readonly config: ResolvedEventLogConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Releases the §14.10 data-dir lock. Best effort; a stale lock is broken by the next start. */
  readonly release: () => Promise<void>;
  /** Bounded `pragma incremental_vacuum`, so freed pages actually return to the OS (§14.5). */
  readonly vacuum: (pages: number) => void;
  readonly closeDb: () => void;
}

/**
 * The `PersistenceHandle` `createDaemon()` opens once and hands to the registry: the two stores,
 * this boot's id, one bounded `sweep()`, and `close()`.
 *
 * `bootId` is this daemon INSTANCE's id, not the stable `daemonId` — the difference is what lets
 * boot adoption recognise a row a PREVIOUS boot owned (§15.7).
 *
 * Owned by M1-WP-A.
 */
export function createPersistenceHandle(
  o: CreatePersistenceHandleOptions,
): DurablePersistenceHandle {
  const { events, workers, config, logger } = o;
  let closed = false;
  const DAY_MS = 86_400_000;

  /**
   * The sweep's input, and the one subtlety in building it: a worker can have EVENTS without a
   * `workers` row — the registry's row is debounced and a crash between the first append and the
   * first upsert is ordinary. Such a worker must still be row-capped, so it is included with the
   * only honest description available (`closedAtMs: null`), which by construction makes the age
   * bound skip it: we will not delete a history whose owner we cannot identify.
   */
  const rows = (): RetentionInput["rows"] => {
    const out: {
      workerId: WorkerId;
      state: WorkerState;
      closedAtMs: number | null;
      head: number;
      tail: number;
    }[] = [];
    const seen = new Set<WorkerId>();

    for (const row of workers.list()) {
      const id = row.snapshot.workerId;
      seen.add(id);
      out.push({
        workerId: id,
        state: row.snapshot.state,
        closedAtMs: row.closedAtMs,
        head: events.headOf(id),
        tail: events.tailOf(id),
      });
    }
    for (const id of events.workersWithEvents()) {
      if (seen.has(id)) continue;
      out.push({
        workerId: id,
        state: "closed",
        closedAtMs: null,
        head: events.headOf(id),
        tail: events.tailOf(id),
      });
    }
    return out;
  };

  /**
   * §24.5: `retentionDays` sweeps runs and their deliveries TOGETHER, on M1's existing timer.
   *
   * TOGETHER is the load-bearing word and the order is what makes it true: deliveries go first,
   * over the SAME cutoff, so a sweep that dies between the two leaves deliveries whose runs are
   * still there rather than deliveries pointing at runs that are gone. `RetentionReport` is frozen
   * and has no seat for these two counts, so they are logged.
   */
  const sweepRuns = (nowMs: number): void => {
    const runDays = o.runRetentionDays ?? config.retentionDays;
    const deliveryDays = o.deliveryRetentionDays ?? config.retentionDays;
    if (runDays <= 0 && deliveryDays <= 0) return;
    try {
      const deliveries =
        deliveryDays <= 0 ? 0 : o.deliveries.sweep({ olderThanMs: nowMs - deliveryDays * DAY_MS });
      const runs = runDays <= 0 ? 0 : o.runs.sweep({ olderThanMs: nowMs - runDays * DAY_MS });
      if (runs > 0 || deliveries > 0) logger.info("run retention sweep", { runs, deliveries });
    } catch (e) {
      // The event-log sweep is the one that keeps the disk bounded; a run sweep that failed must
      // not take it with it.
      logger.warn("run retention sweep failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handle: DurablePersistenceHandle = {
    events,
    workers,
    runs: o.runs,
    deliveries: o.deliveries,
    bootId: o.bootId,

    transaction<T>(fn: () => T): T {
      return o.transaction(fn);
    },

    sweep(nowMs: number): RetentionReport {
      const plan = planRetention({
        nowMs,
        retentionDays: config.retentionDays,
        maxPersistedEventsPerWorker: config.maxPersistedEventsPerWorker,
        rows: rows(),
      });
      const report = runRetention(handle, plan);
      sweepRuns(nowMs);
      if (report.eventsDeleted > 0 || report.workersDropped > 0) {
        // AFTER the deletes, and bounded: pages only return to the OS when something asks, and
        // `auto_vacuum = INCREMENTAL` is set before the first table exists precisely so that
        // asking is possible at all.
        try {
          o.vacuum(VACUUM_PAGES_PER_SWEEP);
        } catch (e) {
          logger.warn("incremental vacuum failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        logger.info("retention sweep", { ...report });
      }
      return report;
    },

    close(): void {
      if (closed) return;
      closed = true;
      // §14.4's debounced `head_seq` is the only thing that can be pending; settling it here is
      // what makes "close the store → reopen ⇒ head is unchanged" true even when the last 255
      // appends never triggered a flush.
      flushIfPossible(events);
      o.closeDb();
      // Not awaited: `PersistenceHandle.close()` is synchronous by contract, and an unlink that
      // loses the race with process exit leaves a lock naming a pid that is provably gone — the
      // exact case `acquireDataDirLock` breaks on the next start.
      void o.release().catch((e: unknown) => {
        logger.warn("releasing the data-dir lock failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    },
  };

  return handle;
}

function flushIfPossible(events: EventStore): void {
  const maybe = events as EventStore & { flush?: () => void };
  if (typeof maybe.flush === "function") maybe.flush();
}
